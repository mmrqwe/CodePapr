/**
 * 从仓库根文件识别可用的验证命令，并填进 AGENTS.md 里空着的测试 / Lint / 构建行。
 * 只填空位，不覆盖用户已经写好的命令。
 */

export interface ProjectVerifyCommands {
  test?: string;
  lint?: string;
  build?: string;
}

export interface DetectProjectVerifyCommandsInput {
  rootFileNames: readonly string[];
  packageJsonText?: string | null;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const TEST_LABELS = new Set(['测试', '測試', 'test']);
const LINT_LABELS = new Set(['lint']);
const BUILD_LABELS = new Set(['构建', '建構', 'build']);

function detectPackageManager(rootNames: ReadonlySet<string>): PackageManager {
  if (rootNames.has('pnpm-lock.yaml')) return 'pnpm';
  if (rootNames.has('yarn.lock')) return 'yarn';
  if (rootNames.has('bun.lock') || rootNames.has('bun.lockb')) return 'bun';
  return 'npm';
}

function runScript(manager: PackageManager, scriptName: string): string {
  if (manager === 'yarn') {
    return `yarn ${scriptName}`;
  }
  if (manager === 'pnpm') {
    return scriptName === 'test' ? 'pnpm test' : `pnpm run ${scriptName}`;
  }
  if (manager === 'bun') {
    return `bun run ${scriptName}`;
  }
  return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
}

function parsePackageScripts(packageJsonText: string | null | undefined): Record<string, string> {
  if (!packageJsonText?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(packageJsonText) as { scripts?: unknown };
    if (!parsed || typeof parsed.scripts !== 'object' || parsed.scripts === null) {
      return {};
    }
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) {
        scripts[name] = value;
      }
    }
    return scripts;
  } catch {
    return {};
  }
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined && value !== null);
}

/** 根据根目录文件和 package.json scripts 推断验证命令；拿不准的不填。 */
export function detectProjectVerifyCommands(
  input: DetectProjectVerifyCommandsInput
): ProjectVerifyCommands {
  const rootNames = new Set(input.rootFileNames.map((name) => name.replace(/\\/g, '/')));
  const result: ProjectVerifyCommands = {};

  const scripts = parsePackageScripts(input.packageJsonText);
  if (rootNames.has('package.json') && Object.keys(scripts).length > 0) {
    const manager = detectPackageManager(rootNames);
    if (typeof scripts.test === 'string') {
      result.test = runScript(manager, 'test');
    }
    if (typeof scripts.lint === 'string') {
      result.lint = runScript(manager, 'lint');
    }
    if (typeof scripts.build === 'string') {
      result.build = runScript(manager, 'build');
    }
  }

  if (rootNames.has('Cargo.toml')) {
    result.test = firstDefined(result.test, 'cargo test');
    result.build = firstDefined(result.build, 'cargo check');
  }

  if (rootNames.has('go.mod')) {
    result.test = firstDefined(result.test, 'go test ./...');
    result.lint = firstDefined(result.lint, 'go vet ./...');
    result.build = firstDefined(result.build, 'go build ./...');
  }

  if (
    rootNames.has('pytest.ini') ||
    rootNames.has('conftest.py') ||
    [...rootNames].some((name) => name === 'tox.ini')
  ) {
    result.test = firstDefined(result.test, 'pytest');
  }

  if ([...rootNames].some((name) => name.endsWith('.sln') || name.endsWith('.csproj'))) {
    result.test = firstDefined(result.test, 'dotnet test');
    result.build = firstDefined(result.build, 'dotnet build');
  }

  if (rootNames.has('pom.xml')) {
    result.test = firstDefined(result.test, 'mvn test');
    result.build = firstDefined(result.build, 'mvn -q -DskipTests compile');
  }

  const hasGradle =
    rootNames.has('build.gradle') ||
    rootNames.has('build.gradle.kts') ||
    rootNames.has('gradlew');
  if (hasGradle) {
    const gradle = rootNames.has('gradlew') ? './gradlew' : 'gradle';
    result.test = firstDefined(result.test, `${gradle} test`);
    result.build = firstDefined(result.build, `${gradle} classes`);
  }

  return result;
}

function slotForLabel(label: string): keyof ProjectVerifyCommands | null {
  const key = label.trim();
  if (TEST_LABELS.has(key) || TEST_LABELS.has(key.toLowerCase())) return 'test';
  if (LINT_LABELS.has(key) || LINT_LABELS.has(key.toLowerCase())) return 'lint';
  if (BUILD_LABELS.has(key) || BUILD_LABELS.has(key.toLowerCase())) return 'build';
  return null;
}

/** 只填空着的 `- 测试：` / `- Lint：` / `- 构建：` 行，已有内容不动。 */
export function fillAgentsVerifyCommands(
  markdown: string,
  commands: ProjectVerifyCommands
): string {
  if (!commands.test && !commands.lint && !commands.build) {
    return markdown;
  }
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  return lines
    .map((line) => {
      const match = /^(\s*[-*]\s+)([^:：]+)([:：]\s*)(.*)$/.exec(line);
      if (!match) {
        return line;
      }
      const [, prefix, label, separator, value] = match;
      if (value.trim()) {
        return line;
      }
      const slot = slotForLabel(label ?? '');
      if (!slot) {
        return line;
      }
      const command = commands[slot];
      if (!command) {
        return line;
      }
      return `${prefix}${label}${separator}${command}`;
    })
    .join(newline);
}
