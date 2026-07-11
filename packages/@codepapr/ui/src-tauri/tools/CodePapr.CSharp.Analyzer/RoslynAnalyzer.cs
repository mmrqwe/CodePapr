using System.Collections.Concurrent;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodePapr.CSharp.Analyzer;

internal sealed class RoslynAnalyzer
{
    private const int MaxDocuments = 256;
    private readonly ConcurrentDictionary<string, AnalyzerDocument> _documents = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentQueue<string> _insertionOrder = new();
    private readonly MetadataReference[] _metadataReferences = LoadMetadataReferences();

    // 缓存按路径解析出的程序集引用，避免重复读取磁盘。
    private static readonly ConcurrentDictionary<string, MetadataReference?> _referenceCache = new(StringComparer.OrdinalIgnoreCase);

    // 缓存项目的引用/全局 using 扫描结果（递归扫描 bin/obj 代价较高）。
    private static readonly ConcurrentDictionary<string, CachedProjectAssets> _assetsCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan AssetsCacheTtl = TimeSpan.FromSeconds(15);

    // 项目编译产物目录候选（含 Godot 的 .godot/mono/temp 重定向布局）。
    private static readonly string[] OutputRootCandidates =
    {
        "bin",
        Path.Combine(".godot", "mono", "temp", "bin"),
        Path.Combine(".mono", "temp", "bin"),
    };

    // 项目中间产物目录候选（用于查找编译器生成的 GlobalUsings.g.cs）。
    private static readonly string[] IntermediateRootCandidates =
    {
        "obj",
        Path.Combine(".godot", "mono", "temp", "obj"),
        Path.Combine(".mono", "temp", "obj"),
    };

    public void OpenOrUpdate(string uri, string text)
    {
        var path = NormalizePath(UriToPath(uri));
        _documents[path] = new AnalyzerDocument(uri, path, text);
        _insertionOrder.Enqueue(path);

        while (_documents.Count > MaxDocuments && _insertionOrder.TryDequeue(out var oldest))
        {
            _documents.TryRemove(oldest, out _);
        }
    }

    public void Close(string uri)
    {
        _documents.TryRemove(NormalizePath(UriToPath(uri)), out _);
    }

    public IReadOnlyList<LspDiagnostic> GetDiagnostics(string uri)
    {
        var context = CreateContext(uri);
        return context is null
            ? []
            : context.Compilation
                .GetDiagnostics(context.CancellationToken)
                .Where(diagnostic => diagnostic.Location.IsInSource && diagnostic.Location.SourceTree == context.SyntaxTree)
                .Select(ToDiagnostic)
                .ToArray();
    }

    public LspHoverResult? GetHover(string uri, int line, int character)
    {
        var context = CreateContext(uri);
        if (context is null)
        {
            return null;
        }

        var symbol = FindSymbol(context, line, character);
        if (symbol is null)
        {
            return null;
        }

        var display = symbol.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        var containing = symbol.ContainingType?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        var kind = symbol.Kind.ToString();
        var location = symbol.Locations.FirstOrDefault(location => location.IsInSource && location.SourceTree == context.SyntaxTree)
            ?? FindNodeLocation(context, line, character);

        return new LspHoverResult(
            new LspMarkupContent("plaintext", containing is null ? $"{kind}\n{display}" : $"{kind}\n{display}\n{containing}"),
            location is null ? null : ToRange(location.GetLineSpan()));
    }

    public IReadOnlyList<LspLocation> GetDefinition(string uri, int line, int character)
    {
        var context = CreateContext(uri);
        if (context is null)
        {
            return [];
        }

        var symbol = FindSymbol(context, line, character);
        if (symbol is null)
        {
            return [];
        }

        return symbol.Locations
            .Where(location => location.IsInSource && location.SourceTree is not null)
            .Select(location => new LspLocation(ToUri(location.SourceTree!.FilePath, uri), ToRange(location.GetLineSpan())))
            .DistinctBy(location => (location.Uri, location.Range.Start.Line, location.Range.Start.Character))
            .ToArray();
    }

    public IReadOnlyList<LspDocumentSymbol> GetDocumentSymbols(string uri)
    {
        var context = CreateContext(uri);
        if (context is null)
        {
            return [];
        }

        return BuildSymbols(context.Root.Members, context.SemanticModel).ToArray();
    }

    private AnalyzerContext? CreateContext(string uri)
    {
        var filePath = NormalizePath(UriToPath(uri));
        var project = DiscoverProject(filePath);
        var sourceFiles = project?.SourceFiles ?? [filePath];

        var syntaxTrees = new List<SyntaxTree>();
        AnalyzerDocument? currentDocument = null;
        SyntaxTree? currentSyntaxTree = null;
        foreach (var sourceFile in sourceFiles)
        {
            if (!TryGetDocument(sourceFile, out var document))
            {
                continue;
            }

            var syntaxTree = CSharpSyntaxTree.ParseText(SourceText.From(document.Text), path: document.Path);
            syntaxTrees.Add(syntaxTree);
            if (PathEquals(document.Path, filePath))
            {
                currentDocument = document;
                currentSyntaxTree = syntaxTree;
            }
        }

        if (currentDocument is null || currentSyntaxTree is null)
        {
            return null;
        }

        // 在运行时基础引用之外，追加目标项目真实解析出的程序集引用
        // （如 GodotSharp.dll、NuGet 包），并合并项目的全局/隐式 using。
        var projectAssets = project is null ? CachedProjectAssets.Empty : GetProjectAssets(project);
        var references = projectAssets.References.Count == 0
            ? _metadataReferences
            : _metadataReferences.Concat(projectAssets.References).ToArray();

        var compilation = CSharpCompilation.Create(
            assemblyName: project?.AssemblyName ?? Path.GetFileNameWithoutExtension(filePath) ?? "CodePapr.CSharp.Analyzer",
            syntaxTrees: syntaxTrees,
            references: references,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                usings: projectAssets.Usings));
        var semanticModel = compilation.GetSemanticModel(currentSyntaxTree, ignoreAccessibility: true);
        return new AnalyzerContext(
            currentDocument,
            project,
            currentSyntaxTree,
            currentSyntaxTree.GetCompilationUnitRoot(),
            compilation,
            semanticModel,
            CancellationToken.None);
    }

    private bool TryGetDocument(string path, out AnalyzerDocument document)
    {
        var normalizedPath = NormalizePath(path);
        if (_documents.TryGetValue(normalizedPath, out document!))
        {
            return true;
        }

        if (!File.Exists(normalizedPath))
        {
            document = default!;
            return false;
        }

        document = new AnalyzerDocument(ToUri(normalizedPath, normalizedPath), normalizedPath, File.ReadAllText(normalizedPath));
        return true;
    }

    private static ProjectDescriptor? DiscoverProject(string filePath)
    {
        var projectFile = FindNearestProjectFile(filePath);
        if (projectFile is null)
        {
            return null;
        }

        var sourceFiles = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var visitedProjects = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CollectProjectFiles(projectFile, visitedProjects, sourceFiles);
        return new ProjectDescriptor(
            projectFile,
            Path.GetDirectoryName(projectFile) ?? Path.GetDirectoryName(filePath) ?? Environment.CurrentDirectory,
            Path.GetFileNameWithoutExtension(projectFile),
            sourceFiles.ToArray());
    }

    private static void CollectProjectFiles(string projectFile, ISet<string> visitedProjects, ISet<string> sourceFiles)
    {
        var normalizedProject = NormalizePath(projectFile);
        if (!visitedProjects.Add(normalizedProject))
        {
            return;
        }

        var projectDirectory = Path.GetDirectoryName(normalizedProject);
        if (!string.IsNullOrWhiteSpace(projectDirectory))
        {
            foreach (var sourceFile in EnumerateProjectSourceFiles(projectDirectory))
            {
                sourceFiles.Add(sourceFile);
            }
        }

        foreach (var referencedProject in ParseProjectReferences(normalizedProject))
        {
            CollectProjectFiles(referencedProject, visitedProjects, sourceFiles);
        }
    }

    private static string? FindNearestProjectFile(string filePath)
    {
        var currentDirectory = Directory.Exists(filePath)
            ? NormalizePath(filePath)
            : Path.GetDirectoryName(filePath);
        while (!string.IsNullOrWhiteSpace(currentDirectory))
        {
            try
            {
                var projectFile = Directory
                    .EnumerateFiles(currentDirectory, "*.csproj", SearchOption.TopDirectoryOnly)
                    .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(projectFile))
                {
                    return NormalizePath(projectFile);
                }
            }
            catch
            {
                return null;
            }

            currentDirectory = Path.GetDirectoryName(currentDirectory);
        }

        return null;
    }

    private static IEnumerable<string> EnumerateProjectSourceFiles(string projectDirectory)
    {
        var pending = new Stack<string>();
        pending.Push(projectDirectory);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            if (ShouldSkipDirectory(directory))
            {
                continue;
            }

            IEnumerable<string> childDirectories;
            try
            {
                childDirectories = Directory.EnumerateDirectories(directory);
            }
            catch
            {
                continue;
            }

            foreach (var childDirectory in childDirectories)
            {
                pending.Push(childDirectory);
            }

            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(directory, "*.cs", SearchOption.TopDirectoryOnly);
            }
            catch
            {
                continue;
            }

            foreach (var file in files)
            {
                yield return NormalizePath(file);
            }
        }
    }

    private static bool ShouldSkipDirectory(string directory)
    {
        var name = Path.GetFileName(directory);
        return name.Equals("bin", StringComparison.OrdinalIgnoreCase)
            || name.Equals("obj", StringComparison.OrdinalIgnoreCase)
            || name.Equals(".git", StringComparison.OrdinalIgnoreCase)
            || name.Equals(".CodePapr", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<string> ParseProjectReferences(string projectFile)
    {
        XDocument document;
        try
        {
            document = XDocument.Load(projectFile);
        }
        catch
        {
            yield break;
        }

        var projectDirectory = Path.GetDirectoryName(projectFile) ?? Environment.CurrentDirectory;
        foreach (var include in document
            .Descendants()
            .Where(element => element.Name.LocalName == "ProjectReference")
            .Select(element => element.Attribute("Include")?.Value)
            .Where(value => !string.IsNullOrWhiteSpace(value)))
        {
            string referencedProject;
            try
            {
                referencedProject = NormalizePath(Path.GetFullPath(Path.Combine(projectDirectory, include!)));
            }
            catch
            {
                continue;
            }

            if (File.Exists(referencedProject))
            {
                yield return referencedProject;
            }
        }
    }

    private static ISymbol? FindSymbol(AnalyzerContext context, int line, int character)
    {
        var position = ToPosition(context.SyntaxTree, line, character);
        var root = context.Root;
        var token = root.FindToken(position);
        foreach (var node in token.Parent?.AncestorsAndSelf() ?? Enumerable.Empty<SyntaxNode>())
        {
            var symbol = context.SemanticModel.GetDeclaredSymbol(node, context.CancellationToken)
                ?? context.SemanticModel.GetSymbolInfo(node, context.CancellationToken).Symbol
                ?? context.SemanticModel.GetTypeInfo(node, context.CancellationToken).Type;
            if (symbol is not null)
            {
                return symbol;
            }
        }

        return null;
    }

    private static Location? FindNodeLocation(AnalyzerContext context, int line, int character)
    {
        var position = ToPosition(context.SyntaxTree, line, character);
        var token = context.Root.FindToken(position);
        return token.Parent?.GetLocation();
    }

    private static int ToPosition(SyntaxTree syntaxTree, int line, int character)
    {
        var text = syntaxTree.GetText();
        var safeLine = Math.Clamp(line, 0, Math.Max(text.Lines.Count - 1, 0));
        var textLine = text.Lines[safeLine];
        return Math.Clamp(textLine.Start + character, textLine.Start, textLine.End);
    }

    private static IEnumerable<LspDocumentSymbol> BuildSymbols(SyntaxList<MemberDeclarationSyntax> members, SemanticModel semanticModel)
    {
        foreach (var member in members)
        {
            switch (member)
            {
                case NamespaceDeclarationSyntax namespaceDeclaration:
                    yield return CreateSymbol(namespaceDeclaration.Name.ToString(), "namespace", 3, namespaceDeclaration, semanticModel, BuildSymbols(namespaceDeclaration.Members, semanticModel));
                    break;
                case FileScopedNamespaceDeclarationSyntax fileScopedNamespace:
                    yield return CreateSymbol(fileScopedNamespace.Name.ToString(), "namespace", 3, fileScopedNamespace, semanticModel, BuildSymbols(fileScopedNamespace.Members, semanticModel));
                    break;
                case BaseTypeDeclarationSyntax typeDeclaration:
                    yield return CreateTypeSymbol(typeDeclaration, semanticModel);
                    break;
                case DelegateDeclarationSyntax delegateDeclaration:
                    yield return CreateSymbol(delegateDeclaration.Identifier.ValueText, "delegate", 12, delegateDeclaration, semanticModel, []);
                    break;
                case GlobalStatementSyntax:
                    break;
            }
        }
    }

    private static LspDocumentSymbol CreateTypeSymbol(BaseTypeDeclarationSyntax typeDeclaration, SemanticModel semanticModel)
    {
        var children = typeDeclaration switch
        {
            TypeDeclarationSyntax declaration => BuildTypeChildren(declaration.Members, semanticModel).ToArray(),
            EnumDeclarationSyntax enumDeclaration => enumDeclaration.Members
                .Select(member => CreateSymbol(member.Identifier.ValueText, "enum member", 22, member, semanticModel, []))
                .ToArray(),
            _ => []
        };

        var kind = typeDeclaration switch
        {
            ClassDeclarationSyntax => 5,
            StructDeclarationSyntax => 23,
            InterfaceDeclarationSyntax => 11,
            EnumDeclarationSyntax => 10,
            RecordDeclarationSyntax => 5,
            _ => 5,
        };
        return CreateSymbol(typeDeclaration.Identifier.ValueText, typeDeclaration.Kind().ToString(), kind, typeDeclaration, semanticModel, children);
    }

    private static IEnumerable<LspDocumentSymbol> BuildTypeChildren(SyntaxList<MemberDeclarationSyntax> members, SemanticModel semanticModel)
    {
        foreach (var member in members)
        {
            switch (member)
            {
                case MethodDeclarationSyntax method:
                    yield return CreateSymbol(method.Identifier.ValueText, "method", 6, method, semanticModel, []);
                    break;
                case ConstructorDeclarationSyntax constructor:
                    yield return CreateSymbol(constructor.Identifier.ValueText, "constructor", 9, constructor, semanticModel, []);
                    break;
                case PropertyDeclarationSyntax property:
                    yield return CreateSymbol(property.Identifier.ValueText, "property", 7, property, semanticModel, []);
                    break;
                case FieldDeclarationSyntax field:
                    foreach (var variable in field.Declaration.Variables)
                    {
                        yield return CreateSymbol(variable.Identifier.ValueText, "field", 8, variable, semanticModel, []);
                    }
                    break;
                case EventFieldDeclarationSyntax eventField:
                    foreach (var variable in eventField.Declaration.Variables)
                    {
                        yield return CreateSymbol(variable.Identifier.ValueText, "event", 24, variable, semanticModel, []);
                    }
                    break;
                case BaseTypeDeclarationSyntax nestedType:
                    yield return CreateTypeSymbol(nestedType, semanticModel);
                    break;
            }
        }
    }

    private static LspDocumentSymbol CreateSymbol(string name, string detail, int kind, SyntaxNode node, SemanticModel semanticModel, IEnumerable<LspDocumentSymbol> children)
    {
        var selectionLocation = node switch
        {
            BaseTypeDeclarationSyntax baseType => baseType.Identifier.GetLocation(),
            MethodDeclarationSyntax method => method.Identifier.GetLocation(),
            ConstructorDeclarationSyntax constructor => constructor.Identifier.GetLocation(),
            PropertyDeclarationSyntax property => property.Identifier.GetLocation(),
            VariableDeclaratorSyntax variable => variable.Identifier.GetLocation(),
            DelegateDeclarationSyntax @delegate => @delegate.Identifier.GetLocation(),
            EnumMemberDeclarationSyntax enumMember => enumMember.Identifier.GetLocation(),
            _ => node.GetLocation(),
        };

        return new LspDocumentSymbol(
            name,
            detail,
            kind,
            ToRange(node.GetLocation().GetLineSpan()),
            ToRange(selectionLocation.GetLineSpan()),
            children.ToArray());
    }

    private static LspDiagnostic ToDiagnostic(Diagnostic diagnostic)
    {
        var severity = diagnostic.Severity switch
        {
            DiagnosticSeverity.Error => 1,
            DiagnosticSeverity.Warning => 2,
            DiagnosticSeverity.Info => 3,
            _ => 4,
        };
        return new LspDiagnostic(ToRange(diagnostic.Location.GetLineSpan()), severity, diagnostic.GetMessage(), diagnostic.Id);
    }

    private static LspRange ToRange(FileLinePositionSpan span)
        => new(new LspPosition(span.StartLinePosition.Line, span.StartLinePosition.Character), new LspPosition(span.EndLinePosition.Line, span.EndLinePosition.Character));

    private static MetadataReference[] LoadMetadataReferences()
    {
        var trustedPlatformAssemblies = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return trustedPlatformAssemblies
            .Select(path => MetadataReference.CreateFromFile(path))
            .ToArray();
    }

    // 默认注入的隐式 using（相当于 .NET 的 ImplicitUsings，加上 System.IO/Net.Http）。
    private static readonly string[] DefaultUsings =
    {
        "System",
        "System.Collections.Generic",
        "System.IO",
        "System.Linq",
        "System.Net.Http",
        "System.Threading",
        "System.Threading.Tasks",
    };

    // 解析目标项目的真实程序集引用与全局 using，带 TTL 缓存。
    private static CachedProjectAssets GetProjectAssets(ProjectDescriptor project)
    {
        var key = NormalizePath(project.ProjectFile);
        var now = DateTime.UtcNow;
        if (_assetsCache.TryGetValue(key, out var cached) && now - cached.CreatedUtc < AssetsCacheTtl)
        {
            return cached;
        }

        var assets = BuildProjectAssets(project);
        _assetsCache[key] = assets;
        return assets;
    }

    private static CachedProjectAssets BuildProjectAssets(ProjectDescriptor project)
    {
        var references = ResolveProjectReferences(project.ProjectDirectory);
        var usings = ResolveProjectUsings(project.ProjectDirectory);
        return new CachedProjectAssets(references, usings, DateTime.UtcNow);
    }

    // 从项目的编译输出目录（bin 及 Godot 的 .godot/mono/temp/bin 重定向布局）
    // 收集所有 DLL 作为 metadata 引用。这样 GodotSharp、NuGet 包等都能被解析。
    private static IReadOnlyList<MetadataReference> ResolveProjectReferences(string projectDirectory)
    {
        var dllPaths = new List<string>();
        var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var relativeRoot in OutputRootCandidates)
        {
            var outputRoot = Path.Combine(projectDirectory, relativeRoot);
            if (!Directory.Exists(outputRoot))
            {
                continue;
            }

            IEnumerable<string> dlls;
            try
            {
                dlls = Directory.EnumerateFiles(outputRoot, "*.dll", SearchOption.AllDirectories);
            }
            catch
            {
                continue;
            }

            foreach (var dll in dlls)
            {
                // 按文件名去重，优先保留先找到的（bin 优先于其他候选）。
                var name = Path.GetFileName(dll);
                if (seenNames.Add(name))
                {
                    dllPaths.Add(dll);
                }
            }
        }

        var references = new List<MetadataReference>(dllPaths.Count);
        foreach (var dll in dllPaths)
        {
            var reference = LoadReference(dll);
            if (reference is not null)
            {
                references.Add(reference);
            }
        }

        return references;
    }

    private static MetadataReference? LoadReference(string path)
    {
        var normalized = NormalizePath(path);
        return _referenceCache.GetOrAdd(normalized, static key =>
        {
            try
            {
                return MetadataReference.CreateFromFile(key);
            }
            catch
            {
                return null;
            }
        });
    }

    // 合并默认 using 与项目的全局/隐式 using。
    // 来源：1) 编译器生成的 obj/**/*.GlobalUsings.g.cs；2) csproj 中的 <Using Include="..." />。
    private static string[] ResolveProjectUsings(string projectDirectory)
    {
        var usings = new List<string>(DefaultUsings);
        var seen = new HashSet<string>(DefaultUsings, StringComparer.Ordinal);

        void Add(string? ns)
        {
            if (!string.IsNullOrWhiteSpace(ns) && seen.Add(ns))
            {
                usings.Add(ns);
            }
        }

        foreach (var ns in ReadGeneratedGlobalUsings(projectDirectory))
        {
            Add(ns);
        }

        foreach (var ns in ReadCsprojUsings(projectDirectory))
        {
            Add(ns);
        }

        return usings.ToArray();
    }

    private static IEnumerable<string> ReadGeneratedGlobalUsings(string projectDirectory)
    {
        foreach (var relativeRoot in IntermediateRootCandidates)
        {
            var intermediateRoot = Path.Combine(projectDirectory, relativeRoot);
            if (!Directory.Exists(intermediateRoot))
            {
                continue;
            }

            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(intermediateRoot, "*.GlobalUsings.g.cs", SearchOption.AllDirectories);
            }
            catch
            {
                continue;
            }

            foreach (var file in files)
            {
                string[] lines;
                try
                {
                    lines = File.ReadAllLines(file);
                }
                catch
                {
                    continue;
                }

                foreach (var line in lines)
                {
                    var ns = ParseGlobalUsingLine(line);
                    if (ns is not null)
                    {
                        yield return ns;
                    }
                }
            }
        }
    }

    // 解析形如 "global using global::Godot;" 或 "global using System.Text;" 的行。
    private static string? ParseGlobalUsingLine(string line)
    {
        var trimmed = line.Trim();
        const string prefix = "global using";
        if (!trimmed.StartsWith(prefix, StringComparison.Ordinal))
        {
            return null;
        }

        var rest = trimmed[prefix.Length..].Trim().TrimEnd(';').Trim();
        // 跳过 using 别名 (global using Foo = Bar;) 和 static using，语义 using 指令无法表达它们。
        if (rest.StartsWith("static ", StringComparison.Ordinal) || rest.Contains('='))
        {
            return null;
        }

        if (rest.StartsWith("global::", StringComparison.Ordinal))
        {
            rest = rest["global::".Length..];
        }

        return string.IsNullOrWhiteSpace(rest) ? null : rest;
    }

    private static IEnumerable<string> ReadCsprojUsings(string projectDirectory)
    {
        string? projectFile;
        try
        {
            projectFile = Directory
                .EnumerateFiles(projectDirectory, "*.csproj", SearchOption.TopDirectoryOnly)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }
        catch
        {
            yield break;
        }

        if (string.IsNullOrWhiteSpace(projectFile))
        {
            yield break;
        }

        XDocument document;
        try
        {
            document = XDocument.Load(projectFile);
        }
        catch
        {
            yield break;
        }

        foreach (var element in document.Descendants().Where(e => e.Name.LocalName == "Using"))
        {
            // <Using Include="Foo" /> 加入；<Using Remove="..." /> 或 Static/Alias 跳过。
            var include = element.Attribute("Include")?.Value;
            if (string.IsNullOrWhiteSpace(include))
            {
                continue;
            }

            var isStatic = element.Attribute("Static")?.Value;
            var alias = element.Attribute("Alias")?.Value;
            if (!string.IsNullOrWhiteSpace(alias) ||
                string.Equals(isStatic, "true", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            yield return include.Trim();
        }
    }

    private static string UriToPath(string uri)
    {
        if (Uri.TryCreate(uri, UriKind.Absolute, out var parsed) && parsed.IsFile)
        {
            return parsed.LocalPath;
        }

        if (uri.StartsWith("file:///", StringComparison.OrdinalIgnoreCase))
        {
            return uri["file:///".Length..];
        }

        if (uri.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
        {
            return uri["file://".Length..];
        }

        return uri;
    }

    private static string NormalizePath(string path)
        => Path.GetFullPath(path);

    private static bool PathEquals(string left, string right)
        => string.Equals(NormalizePath(left), NormalizePath(right), StringComparison.OrdinalIgnoreCase);

    private static string ToUri(string? path, string fallbackUri)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return fallbackUri;
        }

        return new Uri(path).AbsoluteUri;
    }

    private sealed record AnalyzerDocument(string Uri, string Path, string Text);

    private sealed record CachedProjectAssets(
        IReadOnlyList<MetadataReference> References,
        string[] Usings,
        DateTime CreatedUtc)
    {
        public static readonly CachedProjectAssets Empty = new(
            Array.Empty<MetadataReference>(),
            new[]
            {
                "System",
                "System.Collections.Generic",
                "System.IO",
                "System.Linq",
                "System.Net.Http",
                "System.Threading",
                "System.Threading.Tasks",
            },
            DateTime.MinValue);
    }

    private sealed record ProjectDescriptor(
        string ProjectFile,
        string ProjectDirectory,
        string AssemblyName,
        IReadOnlyList<string> SourceFiles);

    private sealed record AnalyzerContext(
        AnalyzerDocument Document,
        ProjectDescriptor? Project,
        SyntaxTree SyntaxTree,
        CompilationUnitSyntax Root,
        CSharpCompilation Compilation,
        SemanticModel SemanticModel,
        CancellationToken CancellationToken);
}

internal sealed record LspPosition(int Line, int Character);
internal sealed record LspRange(LspPosition Start, LspPosition End);
internal sealed record LspLocation(string Uri, LspRange Range);
internal sealed record LspMarkupContent(string Kind, string Value);
internal sealed record LspHoverResult(LspMarkupContent Contents, LspRange? Range);
internal sealed record LspDiagnostic(LspRange Range, int Severity, string Message, string Source);
internal sealed record LspDocumentSymbol(string Name, string Detail, int Kind, LspRange Range, LspRange SelectionRange, IReadOnlyList<LspDocumentSymbol> Children);