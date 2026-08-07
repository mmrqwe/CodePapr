import type { WorkspaceHost, WorkspaceHostCommandResult, WorkspaceHostListEntry } from './host';

export interface ProjectDiagnosticsListEntry {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

export interface ProjectDiagnosticsCommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProjectDiagnosticStagePlan {
  id: string;
  scriptName: string;
  label: string;
  command: string;
  args: string[];
  fallback: boolean;
  /** 相对 workspace 的执行目录：嵌套项目（如子目录里的 go.mod）必须在自己
   *  的模块目录内执行，否则会跑错模块或直接失败。 */
  workdir?: string;
  kind?:
    | 'package-script'
    | 'python-static'
    | 'python-syntax'
    | 'dotnet-build'
    | 'cargo-check'
    | 'go-test'
    | 'maven-compile'
    | 'gradle-check';
}

export interface ProjectDiagnosticStageResult extends ProjectDiagnosticStagePlan {
  success: boolean;
  status: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  excerpt: string;
}

export interface ProjectDiagnosticsReport {
  available: boolean;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  packageJsonPath: string;
  stages: ProjectDiagnosticStageResult[];
  ranAt: number;
  overallStatus: 'passed' | 'failed' | 'unavailable';
  message?: string;
}

interface PackageJsonLike {
  scripts?: Record<string, string>;
}

const PYTHON_STATIC_CHECK_SCRIPT = [
  'from pathlib import Path',
  'import py_compile, shutil, subprocess, sys',
  '',
  'root = Path.cwd()',
  "skip_parts = {'__pycache__', 'node_modules', '.git', '.venv', 'venv', '.mypy_cache', '.pytest_cache'}",
  'checked = 0',
  'failed = False',
  '',
  'for path in sorted(root.rglob("*.py")):',
  '    relative = path.relative_to(root)',
  '    if any(part in skip_parts for part in relative.parts):',
  '        continue',
  '    checked += 1',
  '    try:',
  '        py_compile.compile(str(path), doraise=True)',
  '    except py_compile.PyCompileError as exc:',
  '        failed = True',
  '        inner = exc.exc_value',
  '        if isinstance(inner, SyntaxError):',
  '            line = getattr(inner, "lineno", 1) or 1',
  '            column = getattr(inner, "offset", 1) or 1',
  '            message = getattr(inner, "msg", str(exc)) or str(exc)',
  '            print(f"{relative.as_posix()}:{line}:{column}: error {message}")',
  '        else:',
  '            print(f"{relative.as_posix()}:1:1: error {exc.msg}")',
  '',
  'pyright = shutil.which("pyright")',
  'if pyright:',
  '    result = subprocess.run([pyright], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)',
  '    if result.stdout:',
  '        print(result.stdout, end="")',
  '    if result.stderr:',
  '        print(result.stderr, end="", file=sys.stderr)',
  '    if result.returncode != 0:',
  '        failed = True',
  'else:',
  '    print("Pyright unavailable; Python syntax check completed")',
  '',
  'if failed:',
  '    sys.exit(1)',
  '',
  'print(f"Python static checks OK ({checked} files syntax-checked)")',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePackageJson(raw: string): PackageJsonLike {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as PackageJsonLike) : {};
  } catch {
    return {};
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeEntryPath(entry: ProjectDiagnosticsListEntry): string {
  return normalizeSlashes(entry.path || entry.name).replace(/^\.\//, '');
}

function normalizeChangedPath(path: string): string {
  return normalizeSlashes(path.trim()).replace(/^\.\//, '');
}

function isRootEntry(entry: ProjectDiagnosticsListEntry): boolean {
  return !normalizeEntryPath(entry).includes('/');
}

function entryDir(path: string): string {
  const normalized = normalizeSlashes(path);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
}

function pathDepth(path: string): number {
  const normalized = normalizeSlashes(path).replace(/^\/+|\/+$/g, '');
  return normalized ? normalized.split('/').length : 0;
}

function projectContainsPath(projectFile: string, changedPath: string): boolean {
  const dir = entryDir(projectFile);
  return !dir || changedPath === dir || changedPath.startsWith(`${dir}/`);
}

function findProjectFiles(
  entries: readonly ProjectDiagnosticsListEntry[],
  predicate: (entry: ProjectDiagnosticsListEntry, path: string) => boolean
): string[] {
  return entries
    .filter((entry) => !entry.isDir)
    .map((entry) => ({ entry, path: normalizeEntryPath(entry) }))
    .filter(({ entry, path }) => predicate(entry, path))
    .map(({ path }) => path)
    .sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right));
}

/** monorepo：根 package.json 没有 lint/typecheck 脚本时，找最匹配的子包 package.json。 */
function findNestedPackageJson(
  entries: readonly ProjectDiagnosticsListEntry[],
  changedPaths: readonly string[]
): string | null {
  const candidates = findProjectFiles(
    entries,
    (_entry, path) => path.endsWith('package.json') && path !== 'package.json'
  );
  return chooseProjectFileForChangedPaths(candidates, changedPaths) ?? candidates[0] ?? null;
}

function chooseProjectFileForChangedPaths(
  candidates: readonly string[],
  changedPaths: readonly string[]
): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const normalizedChangedPaths = changedPaths.map(normalizeChangedPath).filter(Boolean);
  if (normalizedChangedPaths.length === 0) {
    return candidates.find((candidate) => !candidate.includes('/')) ?? candidates[0] ?? null;
  }

  const matches = candidates
    .map((candidate) => ({
      candidate,
      score: Math.max(
        ...normalizedChangedPaths.map((changedPath) =>
          projectContainsPath(candidate, changedPath) ? pathDepth(entryDir(candidate)) + 1 : 0
        )
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate));

  return matches[0]?.candidate ?? null;
}

function shouldIncludeNestedProject(projectFile: string, changedPaths: readonly string[]): boolean {
  if (!projectFile.includes('/')) {
    return true;
  }
  return changedPaths.map(normalizeChangedPath).some((changedPath) => projectContainsPath(projectFile, changedPath));
}

function detectPackageManager(
  entries: readonly ProjectDiagnosticsListEntry[]
): ProjectDiagnosticsReport['packageManager'] {
  const names = new Set(entries.filter(isRootEntry).map((entry) => entry.name));
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun';
  return 'npm';
}

function buildRunArgs(
  packageManager: ProjectDiagnosticsReport['packageManager'],
  scriptName: string
): { command: string; args: string[] } {
  switch (packageManager) {
    case 'yarn':
      return { command: 'yarn', args: [scriptName] };
    case 'pnpm':
      return { command: 'pnpm', args: ['run', scriptName] };
    case 'bun':
      return { command: 'bun', args: ['run', scriptName] };
    default:
      return { command: 'npm', args: ['run', scriptName] };
  }
}

/** 从 package.json scripts 构建 lint/typecheck 阶段（monorepo 根与子包共用）。 */
function buildPackageScriptStages(
  scripts: Record<string, string>,
  packageManager: ProjectDiagnosticsReport['packageManager'],
  workdir?: string
): ProjectDiagnosticStagePlan[] {
  const stages: ProjectDiagnosticStagePlan[] = [];
  const withWorkdir = <T extends ProjectDiagnosticStagePlan>(stage: T): T =>
    workdir ? { ...stage, workdir } : stage;

  if (scripts.lint) {
    const runner = buildRunArgs(packageManager, 'lint');
    stages.push(
      withWorkdir({
        id: 'lint',
        scriptName: 'lint',
        label: 'lint',
        command: runner.command,
        args: runner.args,
        fallback: false,
        kind: 'package-script',
      })
    );
  }

  const typecheck = resolveTypecheckScript(scripts);
  if (typecheck) {
    const runner = buildRunArgs(packageManager, typecheck.scriptName);
    stages.push(
      withWorkdir({
        id: 'typecheck',
        scriptName: typecheck.scriptName,
        label: typecheck.fallback ? 'typecheck(build fallback)' : 'typecheck',
        command: runner.command,
        args: runner.args,
        fallback: typecheck.fallback,
        kind: 'package-script',
      })
    );
  }

  return stages;
}

function looksLikePythonWorkspace(entries: readonly ProjectDiagnosticsListEntry[]): boolean {
  return entries.some((entry) => {
    if (entry.isDir) {
      return false;
    }

    const name = entry.name.toLowerCase();
    return (
      name === 'requirements.txt' ||
      name.startsWith('requirements.') ||
      name === 'pyproject.toml' ||
      name === 'setup.py' ||
      name === 'setup.cfg' ||
      name === 'tox.ini' ||
      name === 'main.py' ||
      name.endsWith('.py')
    );
  });
}

function detectPythonCommand(scripts: Record<string, string>): 'python' | 'python3' {
  const values = Object.values(scripts);
  if (values.some((value) => /(^|\s)python3(\s|$)/.test(value))) {
    return 'python3';
  }

  if (values.some((value) => /(^|\s)python(\s|$)/.test(value))) {
    return 'python';
  }

  return 'python3';
}

function resolveTypecheckScript(
  scripts: Record<string, string>
): { scriptName: string; fallback: boolean } | null {
  const directCandidates = ['typecheck', 'check:types', 'check:type', 'tsc'];
  for (const candidate of directCandidates) {
    if (typeof scripts[candidate] === 'string') {
      return {
        scriptName: candidate,
        fallback: false,
      };
    }
  }

  if (typeof scripts.build === 'string') {
    return {
      scriptName: 'build',
      fallback: true,
    };
  }

  return null;
}

function asProjectDiagnosticsEntries(entries: readonly WorkspaceHostListEntry[]): ProjectDiagnosticsListEntry[] {
  return entries.map((entry) => ({
    path: entry.path,
    name: entry.name,
    isDir: entry.isDir,
    bytes: entry.bytes,
  }));
}

function asProjectDiagnosticsCommandResult(result: WorkspaceHostCommandResult): ProjectDiagnosticsCommandResult {
  return {
    command: result.command,
    args: result.args,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

export function createProjectDiagnosticsPlan(params: {
  entries: readonly ProjectDiagnosticsListEntry[];
  packageJsonContent?: string;
  changedPaths?: readonly string[];
}): {
  available: boolean;
  packageManager: ProjectDiagnosticsReport['packageManager'];
  packageJsonPath: string;
  stages: ProjectDiagnosticStagePlan[];
  message?: string;
} {
  const packageManager = detectPackageManager(params.entries);
  const pkg = normalizePackageJson(params.packageJsonContent ?? '');
  const changedPaths = params.changedPaths ?? [];
  const scripts = isRecord(pkg.scripts)
    ? Object.fromEntries(
        Object.entries(pkg.scripts).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {};

  const stages: ProjectDiagnosticStagePlan[] = [];
  const isPythonWorkspace = looksLikePythonWorkspace(params.entries);
  for (const stage of buildPackageScriptStages(scripts, packageManager)) {
    // Python 项目里拿 build 当 typecheck 兜底没有意义，跳过
    if (stage.id === 'typecheck' && stage.fallback && isPythonWorkspace) {
      continue;
    }
    stages.push(stage);
  }
  if (isPythonWorkspace && !stages.some((stage) => stage.id === 'typecheck')) {
    stages.push({
      id: 'typecheck',
      scriptName: 'python-static',
      label: 'python static',
      command: detectPythonCommand(scripts),
      args: ['-c', PYTHON_STATIC_CHECK_SCRIPT],
      fallback: false,
      kind: 'python-static',
    });
  }

  const solutionFiles = findProjectFiles(params.entries, (_entry, path) => path.endsWith('.sln'));
  const csprojFiles = findProjectFiles(params.entries, (_entry, path) => path.endsWith('.csproj'));
  const preferredDotnetTarget =
    chooseProjectFileForChangedPaths(csprojFiles, changedPaths) ??
    chooseProjectFileForChangedPaths(solutionFiles, changedPaths) ??
    solutionFiles[0] ??
    csprojFiles[0] ??
    null;
  if (preferredDotnetTarget && shouldIncludeNestedProject(preferredDotnetTarget, changedPaths)) {
    stages.push({
      id: 'dotnet-build',
      scriptName: 'dotnet-build',
      label: `dotnet build ${preferredDotnetTarget}`,
      command: 'dotnet',
      args: ['build', preferredDotnetTarget, '--nologo'],
      fallback: false,
      kind: 'dotnet-build',
    });
  }

  const cargoFiles = findProjectFiles(params.entries, (_entry, path) => path.endsWith('Cargo.toml'));
  const preferredCargoTarget = chooseProjectFileForChangedPaths(cargoFiles, changedPaths) ?? cargoFiles[0] ?? null;
  if (preferredCargoTarget && shouldIncludeNestedProject(preferredCargoTarget, changedPaths)) {
    stages.push({
      id: 'cargo-check',
      scriptName: 'cargo-check',
      label: 'cargo check',
      command: 'cargo',
      args: preferredCargoTarget.includes('/')
        ? ['check', '--manifest-path', preferredCargoTarget, '--all-targets']
        : ['check', '--workspace', '--all-targets'],
      fallback: false,
      kind: 'cargo-check',
    });
  }

  const goModFiles = findProjectFiles(params.entries, (_entry, path) => path.endsWith('go.mod'));
  const preferredGoMod = chooseProjectFileForChangedPaths(goModFiles, changedPaths) ?? goModFiles[0] ?? null;
  if (preferredGoMod && shouldIncludeNestedProject(preferredGoMod, changedPaths)) {
    const goModDir = entryDir(preferredGoMod);
    stages.push({
      id: 'go-test',
      scriptName: 'go-test',
      label: goModDir ? `go test ./...（${goModDir}）` : 'go test ./...',
      command: 'go',
      args: ['test', './...'],
      fallback: false,
      // go 没有 --manifest-path 之类的标志：嵌套 go.mod 必须在其模块目录内
      // 执行，旧实现从 workspace 根运行会测错模块或直接失败。
      ...(goModDir ? { workdir: goModDir } : {}),
      kind: 'go-test',
    });
  }

  const pomFiles = findProjectFiles(params.entries, (_entry, path) => path.endsWith('pom.xml'));
  const preferredPom = chooseProjectFileForChangedPaths(pomFiles, changedPaths) ?? pomFiles[0] ?? null;
  if (preferredPom && shouldIncludeNestedProject(preferredPom, changedPaths)) {
    stages.push({
      id: 'maven-compile',
      scriptName: 'maven-compile',
      label: 'maven compile',
      command: 'mvn',
      args: preferredPom.includes('/')
        ? ['-q', '-f', preferredPom, '-DskipTests', 'compile']
        : ['-q', '-DskipTests', 'compile'],
      fallback: false,
      kind: 'maven-compile',
    });
  }

  const gradleFiles = findProjectFiles(params.entries, (_entry, path) =>
    /(^|\/)(build\.gradle|build\.gradle\.kts)$/.test(path)
  );
  const preferredGradle = chooseProjectFileForChangedPaths(gradleFiles, changedPaths) ?? gradleFiles[0] ?? null;
  const hasGradleWrapper = params.entries.some((entry) => !entry.isDir && normalizeEntryPath(entry) === 'gradlew');
  if (preferredGradle && shouldIncludeNestedProject(preferredGradle, changedPaths)) {
    stages.push({
      id: 'gradle-check',
      scriptName: 'gradle-check',
      label: 'gradle check',
      command: hasGradleWrapper ? './gradlew' : 'gradle',
      args: ['check'],
      fallback: false,
      kind: 'gradle-check',
    });
  }

  if (stages.length === 0) {
    return {
      available: false,
      packageManager,
      packageJsonPath: 'package.json',
      stages: [],
      message: 'package.json 中没有可用的 lint 或 typecheck/build 脚本',
    };
  }

  return {
    available: true,
    packageManager,
    packageJsonPath: 'package.json',
    stages,
  };
}

function buildExcerpt(stdout: string, stderr: string, maxLines: number = 12): string {
  const source = `${stderr || ''}\n${stdout || ''}`.trim();
  if (!source) {
    return '';
  }

  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (lines.length <= maxLines) {
    return lines.join('\n');
  }

  return lines.slice(-maxLines).join('\n');
}

export async function runProjectDiagnostics(
  host: Pick<WorkspaceHost, 'workspacePath' | 'listFiles' | 'readTextFile' | 'runCommand'>,
  options: { changedPaths?: readonly string[] } = {}
): Promise<ProjectDiagnosticsReport> {
  const listResult = await host.listFiles({ maxDepth: 4 });
  let packageJsonContent = '';
  try {
    const packageJsonResult = await host.readTextFile({
      relativePath: 'package.json',
      maxBytes: 300_000,
    });
    packageJsonContent = packageJsonResult.content;
  } catch {
    packageJsonContent = '';
  }

  const entries = asProjectDiagnosticsEntries(listResult.entries);
  let plan = createProjectDiagnosticsPlan({
    entries,
    packageJsonContent,
    changedPaths: options.changedPaths,
  });

  // monorepo：根 package.json 没有 lint/typecheck 脚本时，选最匹配的子包
  // package.json（优先覆盖本次改动路径），在其目录内执行脚本阶段。
  if (!plan.stages.some((stage) => stage.kind === 'package-script')) {
    const nestedPath = findNestedPackageJson(entries, options.changedPaths ?? []);
    if (nestedPath) {
      try {
        const nestedResult = await host.readTextFile({
          relativePath: nestedPath,
          maxBytes: 300_000,
        });
        const nestedPkg = normalizePackageJson(nestedResult.content);
        const nestedScripts = isRecord(nestedPkg.scripts)
          ? Object.fromEntries(
              Object.entries(nestedPkg.scripts).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string'
              )
            )
          : {};
        const nestedStages = buildPackageScriptStages(
          nestedScripts,
          plan.packageManager,
          entryDir(nestedPath)
        );
        if (nestedStages.length > 0) {
          plan = {
            ...plan,
            available: true,
            packageJsonPath: nestedPath,
            stages: [...nestedStages, ...plan.stages],
            message: undefined,
          };
        }
      } catch {
        // 子包 package.json 读取失败时保持原计划
      }
    }
  }

  if (!plan.available) {
    return {
      available: false,
      packageManager: plan.packageManager,
      packageJsonPath: plan.packageJsonPath,
      stages: [],
      ranAt: Date.now(),
      overallStatus: 'unavailable',
      message: plan.message,
    };
  }

  const stages: ProjectDiagnosticStageResult[] = [];
  for (const stage of plan.stages) {
    try {
      const result = asProjectDiagnosticsCommandResult(
        await host.runCommand({
          command: stage.command,
          args: stage.args,
          timeoutSeconds: 270,
          workdir: stage.workdir,
        })
      );
      stages.push({
        ...stage,
        success: !result.timedOut && (result.status ?? 1) === 0,
        status: result.status,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        excerpt: buildExcerpt(result.stdout, result.stderr),
      });
    } catch (error) {
      // 单个阶段（如缺少 dotnet/cargo/go 等工具链）spawn 失败时，记录为失败阶段并继续后续阶段，
      // 而不是让整个诊断流程中断、丢失其余阶段的结果。
      const message = error instanceof Error ? error.message : String(error);
      stages.push({
        ...stage,
        success: false,
        status: null,
        timedOut: false,
        stdout: '',
        stderr: message,
        excerpt: buildExcerpt('', message),
      });
    }
  }

  return {
    available: true,
    packageManager: plan.packageManager,
    packageJsonPath: plan.packageJsonPath,
    stages,
    ranAt: Date.now(),
    overallStatus: stages.every((stage) => stage.success) ? 'passed' : 'failed',
  };
}
