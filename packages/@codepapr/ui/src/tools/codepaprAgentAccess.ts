/**
 * Agent 工具（list/read/write/bash）对 `.CodePapr` 的访问闸门。
 *
 * 配置（AGENTS.md / skills / agents / commands）和内部状态由 runtime / UI
 * 经 Tauri invoke 直读，不走这层。Agent 只能碰运行时划的草稿区；
 * App 模式额外放行 `.CodePapr/apps/`。`skill_load` 不经过本闸门。
 */

export type CodePaprAgentOp = 'read' | 'write' | 'list' | 'execute';

const CODEPAPR_SEGMENT = '.codepapr';
const SCRATCH_PREFIXES = new Set([
  'tmp',
  'tool-output',
  'downloads',
  'screenshots',
  'images',
  'assets',
  'fixtures',
]);

function splitPath(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.');
}

/** 路径若落在 `.CodePapr` 下，返回其后的相对后缀（根目录本身为 `''`）。 */
export function codePaprSuffix(path: string | undefined): string | null {
  if (!path || !path.trim()) {
    return null;
  }
  const parts = splitPath(path);
  const index = parts.findIndex((part) => part.toLowerCase() === CODEPAPR_SEGMENT);
  if (index < 0) {
    return null;
  }
  return parts.slice(index + 1).join('/');
}

function isAllowedCodePaprSuffix(suffix: string, op: CodePaprAgentOp, mode: string): boolean {
  if (!suffix) {
    return false;
  }
  const first = suffix.split('/')[0]?.toLowerCase() ?? '';
  if (SCRATCH_PREFIXES.has(first)) {
    return true;
  }
  // Skill 包内 references/scripts：skill_load 之后 Agent 需要 read/list/执行，但不能写配置。
  if (first === 'skills' && op !== 'write') {
    return true;
  }
  if (first === 'apps' && mode === 'app') {
    return true;
  }
  return false;
}

export function agentCodePaprDeniedMessage(path: string): string {
  return `无法访问「${path}」：.CodePapr 由 CodePapr 运行时管理。Agent 请使用 skill / 项目配置界面；草稿可用 .CodePapr/tmp、tool-output、downloads、screenshots、images、assets、fixtures。`;
}

export function assertAgentCodePaprAccess(
  path: string | undefined,
  op: CodePaprAgentOp,
  mode: string = 'agent'
): void {
  const suffix = codePaprSuffix(path);
  if (suffix === null) {
    return;
  }
  if (isAllowedCodePaprSuffix(suffix, op, mode)) {
    return;
  }
  throw new Error(agentCodePaprDeniedMessage(path?.trim() || '.CodePapr'));
}

/** 从 shell 命令里抽出像路径的 token，拦住 `ls .CodePapr` 这类显式探测。 */
export function assertShellCodePaprAccess(
  command: string,
  mode: string = 'agent',
  workdir?: string
): void {
  assertAgentCodePaprAccess(workdir, 'execute', mode);
  const tokens = command
    .split(/[\s"'`=<>|;&()]+/)
    .map((token) => token.replace(/[,.;]+$/g, ''))
    .filter(Boolean);
  for (const token of tokens) {
    if (codePaprSuffix(token) === null) {
      continue;
    }
    assertAgentCodePaprAccess(token, 'execute', mode);
  }
}

function allowsCodePaprApps(
  mode: string | undefined,
  appAccess?: { allowCodepaprApps?: boolean } | null
): boolean {
  return mode === 'app' || appAccess?.allowCodepaprApps === true;
}

export function agentSandboxArgs(
  mode: string,
  appAccess?: { network: boolean; workspaceWrite: boolean; allowCodepaprApps?: boolean }
): { network: boolean; workspaceWrite: boolean; allowBind: boolean; allowCodepaprApps: boolean } {
  const allowCodepaprApps = allowsCodePaprApps(mode, appAccess);
  if (appAccess) {
    return {
      network: appAccess.network,
      workspaceWrite: appAccess.workspaceWrite,
      allowBind: false,
      allowCodepaprApps,
    };
  }
  return {
    network: true,
    workspaceWrite: true,
    allowBind: false,
    allowCodepaprApps,
  };
}

/** 文件闸门用的有效 mode：App 会话，或 in-app agent 带了 allowCodepaprApps。 */
export function effectiveCodePaprMode(
  mode: string | undefined,
  appAccess?: { allowCodepaprApps?: boolean }
): string {
  return allowsCodePaprApps(mode, appAccess) ? 'app' : (mode ?? 'agent');
}
