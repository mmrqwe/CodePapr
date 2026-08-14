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
    | 'dotnet-build'
    | 'cargo-check'
    | 'go-build'
    | 'go-vet'
    | 'maven-compile'
    | 'gradle-classes';
  /** 检查语义分类（替代以 TS lint/typecheck 为中心的两段式隐式模型）：
   *  lint=代码风格检查，typecheck=类型检查，syntax=语法检查，
   *  compile=编译检查，static-analysis=静态分析。 */
  category?: 'lint' | 'typecheck' | 'syntax' | 'compile' | 'static-analysis';
}

export interface ProjectDiagnosticStageResult extends ProjectDiagnosticStagePlan {
  success: boolean;
  status: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  excerpt: string;
  /** 失败原因：spawn=工具链缺失/无法启动（环境问题，不是代码问题），
   *  exit=命令跑完但退出码非 0（代码问题），timeout=超时；成功为 null。
   *  旧报告可能没有该字段（undefined），消费方按可修复处理。 */
  failureReason?: 'spawn' | 'exit' | 'timeout' | null;
}

export type ProjectDiagnosticsProjectType =
  | 'node'
  | 'python'
  | 'dotnet'
  | 'rust'
  | 'go'
  | 'maven'
  | 'gradle';

export interface ProjectDiagnosticsReport {
  available: boolean;
  /** 检测到的项目类型（多技术栈可共存，如 node + rust）。 */
  projectTypes: ProjectDiagnosticsProjectType[];
  /** 主项目类型：拥有最多诊断阶段的类型；无任何阶段时为 null。 */
  primaryProjectType: ProjectDiagnosticsProjectType | null;
  /** 仅 Node 系项目有值；非 Node 项目为 null（不再默认 'npm'，避免误导 Agent）。 */
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  /** 仅 Node 系项目有值；非 Node 项目为 null。 */
  packageJsonPath: string | null;
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
        category: 'lint',
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
        category: 'typecheck',
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

/** stage kind → 项目类型映射：用于统计主项目类型。 */
const PROJECT_TYPE_BY_KIND: Record<string, ProjectDiagnosticsProjectType> = {
  'package-script': 'node',
  'python-static': 'python',
  'dotnet-build': 'dotnet',
  'cargo-check': 'rust',
  'go-build': 'go',
  'go-vet': 'go',
  'maven-compile': 'maven',
  'gradle-classes': 'gradle',
};

function computePrimaryProjectType(
  projectTypes: readonly ProjectDiagnosticsProjectType[],
  stages: readonly Pick<ProjectDiagnosticStagePlan, 'kind'>[]
): ProjectDiagnosticsProjectType | null {
  const counts = new Map<ProjectDiagnosticsProjectType, number>();
  for (const stage of stages) {
    const type = stage.kind ? PROJECT_TYPE_BY_KIND[stage.kind] : undefined;
    if (type) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return null;
  }
  let primary: ProjectDiagnosticsProjectType | null = null;
  let max = 0;
  for (const [type, count] of counts) {
    if (count > max) {
      primary = type;
      max = count;
    }
  }
  return primary;
}

export function createProjectDiagnosticsPlan(params: {
  entries: readonly ProjectDiagnosticsListEntry[];
  packageJsonContent?: string;
  changedPaths?: readonly string[];
}): {
  available: boolean;
  packageManager: ProjectDiagnosticsReport['packageManager'];
  packageJsonPath: string | null;
  projectTypes: ProjectDiagnosticsProjectType[];
  primaryProjectType: ProjectDiagnosticsProjectType | null;
  stages: ProjectDiagnosticStagePlan[];
  message?: string;
} {
  const packageJsonFiles = findProjectFiles(
    params.entries,
    (_entry, path) => path.endsWith('package.json')
  );
  const hasNodeProject = packageJsonFiles.length > 0;
  const packageManager: ProjectDiagnosticsReport['packageManager'] = hasNodeProject
    ? detectPackageManager(params.entries)
    : null;
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
      category: 'syntax',
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
      category: 'compile',
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
      category: 'compile',
    });
  }

  const goModFiles = findProjectFiles(params.entries, (_entry, path) => path.endsWith('go.mod'));
  const preferredGoMod = chooseProjectFileForChangedPaths(goModFiles, changedPaths) ?? goModFiles[0] ?? null;
  if (preferredGoMod && shouldIncludeNestedProject(preferredGoMod, changedPaths)) {
    const goModDir = entryDir(preferredGoMod);
    // go 没有 --manifest-path 之类的标志：嵌套 go.mod 必须在其模块目录内
    // 执行，旧实现从 workspace 根运行会测错模块或直接失败。
    // 诊断语义：go build 做编译检查、go vet 做静态分析；不再用 go test
    //（测试失败 ≠ 代码有编译/静态问题，且会误触发后台自动修复）。
    stages.push({
      id: 'go-build',
      scriptName: 'go-build',
      label: goModDir ? `go build ./...（${goModDir}）` : 'go build ./...',
      command: 'go',
      args: ['build', './...'],
      fallback: false,
      ...(goModDir ? { workdir: goModDir } : {}),
      kind: 'go-build',
      category: 'compile',
    });
    stages.push({
      id: 'go-vet',
      scriptName: 'go-vet',
      label: goModDir ? `go vet ./...（${goModDir}）` : 'go vet ./...',
      command: 'go',
      args: ['vet', './...'],
      fallback: false,
      ...(goModDir ? { workdir: goModDir } : {}),
      kind: 'go-vet',
      category: 'static-analysis',
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
      category: 'compile',
    });
  }

  const gradleFiles = findProjectFiles(params.entries, (_entry, path) =>
    /(^|\/)(build\.gradle|build\.gradle\.kts)$/.test(path)
  );
  const preferredGradle = chooseProjectFileForChangedPaths(gradleFiles, changedPaths) ?? gradleFiles[0] ?? null;
  const hasGradleWrapper = params.entries.some((entry) => !entry.isDir && normalizeEntryPath(entry) === 'gradlew');
  if (preferredGradle && shouldIncludeNestedProject(preferredGradle, changedPaths)) {
    stages.push({
      id: 'gradle-classes',
      scriptName: 'gradle-classes',
      label: 'gradle classes',
      // classes 编译主源集（Java/Kotlin/Groovy 通用），不跑测试：
      // 旧实现用 `gradle check` 会把测试失败混进诊断并误触发自动修复。
      command: hasGradleWrapper ? './gradlew' : 'gradle',
      args: ['classes'],
      fallback: false,
      kind: 'gradle-classes',
      category: 'compile',
    });
  }

  const projectTypes: ProjectDiagnosticsProjectType[] = [];
  if (hasNodeProject) projectTypes.push('node');
  if (isPythonWorkspace) projectTypes.push('python');
  if (solutionFiles.length + csprojFiles.length > 0) projectTypes.push('dotnet');
  if (cargoFiles.length > 0) projectTypes.push('rust');
  if (goModFiles.length > 0) projectTypes.push('go');
  if (pomFiles.length > 0) projectTypes.push('maven');
  if (gradleFiles.length > 0) projectTypes.push('gradle');
  const primaryProjectType = computePrimaryProjectType(projectTypes, stages);

  if (stages.length === 0) {
    return {
      available: false,
      packageManager,
      packageJsonPath: hasNodeProject ? 'package.json' : null,
      projectTypes,
      primaryProjectType,
      stages: [],
      message: '未检测到可用的项目诊断阶段（lint/typecheck/build/compile 等脚本或工具链配置）',
    };
  }

  return {
    available: true,
    packageManager,
    packageJsonPath: hasNodeProject ? 'package.json' : null,
    projectTypes,
    primaryProjectType,
    stages,
  };
}

/** 等待 promise，signal abort 时立即以 AbortError 拒绝（底层命令继续受其
 *  自身超时约束，但调用方不再等待）。 */
async function raceAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new DOMException('Diagnostics was cancelled', 'AbortError');
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('Diagnostics was cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
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
  options: { changedPaths?: readonly string[]; signal?: AbortSignal } = {}
): Promise<ProjectDiagnosticsReport> {
  const signal = options.signal;
  // 取消通道：诊断最多串行跑约 8 个阶段、每个阶段自身超时 270s（总计可远超
  // 30 分钟）。Agent 工具超时/用户取消后若不响应，剩余阶段会继续在后台跑完。
  const ensureNotAborted = (): void => {
    if (signal?.aborted) {
      throw new DOMException('Diagnostics was cancelled', 'AbortError');
    }
  };
  ensureNotAborted();

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
          const mergedStages = [...nestedStages, ...plan.stages];
          plan = {
            ...plan,
            available: true,
            packageJsonPath: nestedPath,
            stages: mergedStages,
            primaryProjectType: computePrimaryProjectType(plan.projectTypes, mergedStages),
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
      projectTypes: plan.projectTypes,
      primaryProjectType: plan.primaryProjectType,
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
    // 每个阶段启动前检查取消：已取消则不再启动后续阶段（当前阶段若已在跑，
    // 由其自身 270s 超时兜底，但调用方立即得到 AbortError，不再串行等待）。
    ensureNotAborted();
    try {
      const commandPromise = host.runCommand({
        command: stage.command,
        args: stage.args,
        timeoutSeconds: 270,
        workdir: stage.workdir,
      });
      const result = asProjectDiagnosticsCommandResult(
        signal ? await raceAbortable(commandPromise, signal) : await commandPromise
      );
      const success = !result.timedOut && (result.status ?? 1) === 0;
      stages.push({
        ...stage,
        success,
        status: result.status,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        excerpt: buildExcerpt(result.stdout, result.stderr),
        failureReason: result.timedOut ? 'timeout' : success ? null : 'exit',
      });
    } catch (error) {
      // 取消必须原样向上传播，不得被当作阶段失败吞掉后继续跑后续阶段。
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
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
        failureReason: 'spawn',
      });
    }
  }

  return {
    available: true,
    projectTypes: plan.projectTypes,
    primaryProjectType: computePrimaryProjectType(plan.projectTypes, plan.stages),
    packageManager: plan.packageManager,
    packageJsonPath: plan.packageJsonPath,
    stages,
    ranAt: Date.now(),
    overallStatus: stages.every((stage) => stage.success) ? 'passed' : 'failed',
  };
}
