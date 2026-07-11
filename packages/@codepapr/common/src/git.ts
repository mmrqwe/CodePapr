export interface GitCommandResultLike {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface GitHistoryEntry {
  hash: string;
  shortHash: string;
  committedAt: string;
  authorName: string;
  refNames: string[];
  subject: string;
  isHead: boolean;
}

export interface GitHistorySummary {
  available: boolean;
  isRepo: boolean;
  entries: GitHistoryEntry[];
  raw: string;
  message?: string;
}

export interface GitLatestStashEntry {
  ref: string;
  message: string;
}

function combineCommandOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim();
}

function isNotGitRepositoryMessage(message: string): boolean {
  return /not a git repository/i.test(message);
}

function hasGitControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function formatTimestamp(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  const hour = String(value.getUTCHours()).padStart(2, '0');
  const minute = String(value.getUTCMinutes()).padStart(2, '0');
  const second = String(value.getUTCSeconds()).padStart(2, '0');
  const millis = String(value.getUTCMilliseconds()).padStart(3, '0');
  return `${year}${month}${day}-${hour}${minute}${second}-${millis}`;
}

function appendPathspecs(args: string[], pathspecs: readonly string[]): string[] {
  return pathspecs.length > 0 ? [...args, '--', ...pathspecs] : args;
}

export function normalizeGitPathspecs(pathspecs?: readonly string[]): string[] {
  if (!pathspecs) {
    return [];
  }

  const normalized: string[] = [];
  for (const pathspec of pathspecs) {
    const trimmed = pathspec.trim();
    if (!trimmed) {
      continue;
    }
    normalized.push(trimmed);
  }

  return normalized;
}

export function assertValidGitBranchName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('branchName 必须是非空字符串');
  }
  if (
    trimmed === '@' ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('.lock') ||
    trimmed.includes('..') ||
    trimmed.includes('//') ||
    trimmed.includes('@{') ||
    trimmed.includes('[') ||
    /[\s~^:?*\\]/.test(trimmed) ||
    hasGitControlCharacters(trimmed)
  ) {
    throw new Error(`非法分支名: ${name}`);
  }
  return trimmed;
}

export function assertValidGitReference(value: string, fieldName: string = 'ref'): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} 必须是非空字符串`);
  }
  if (trimmed.startsWith('-') || hasGitControlCharacters(trimmed) || /\s/.test(trimmed)) {
    throw new Error(`非法 ${fieldName}: ${value}`);
  }
  return trimmed;
}

export function buildGitHistoryCommandArgs(limit: number = 20): string[] {
  const safeLimit = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.trunc(limit))) : 20;
  return [
    'log',
    `-n${safeLimit}`,
    '--date=iso-strict',
    '--decorate=short',
    '--pretty=format:%H%x1f%h%x1f%cI%x1f%an%x1f%D%x1f%s%x1e',
  ];
}

export function parseGitHistoryCommandResult(result: GitCommandResultLike): GitHistorySummary {
  const raw = combineCommandOutput(result.stdout, result.stderr);
  if ((result.status ?? 1) !== 0) {
    if (isNotGitRepositoryMessage(raw)) {
      return {
        available: true,
        isRepo: false,
        entries: [],
        raw,
        message: '当前工作区不是 Git 仓库。',
      };
    }

    return {
      available: true,
      isRepo: false,
      entries: [],
      raw,
      message: raw || 'Git 历史读取失败。',
    };
  }

  const entries = result.stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, committedAt, authorName, refsText, subject] = record.split('\x1f');
      const refNames = (refsText ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      return {
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        committedAt: committedAt ?? '',
        authorName: authorName ?? '',
        refNames,
        subject: subject ?? '',
        isHead: refNames.some((value) => value === 'HEAD' || value.startsWith('HEAD -> ')),
      } satisfies GitHistoryEntry;
    })
    .filter((entry) => entry.hash && entry.shortHash);

  return {
    available: true,
    isRepo: true,
    entries,
    raw,
    ...(entries.length > 0 ? {} : { message: '当前仓库还没有提交历史。' }),
  };
}

export function buildGitBranchCheckoutPlans(params: {
  branchName: string;
  create?: boolean;
  createIfMissing?: boolean;
  startPoint?: string;
}): string[][] {
  const branchName = assertValidGitBranchName(params.branchName);
  const startPoint = params.startPoint ? assertValidGitReference(params.startPoint, 'startPoint') : undefined;
  const createArgsSwitch = ['switch', '-c', branchName, ...(startPoint ? [startPoint] : [])];
  const createArgsCheckout = ['checkout', '-b', branchName, ...(startPoint ? [startPoint] : [])];

  if (params.create === true) {
    return [createArgsSwitch, createArgsCheckout];
  }

  const plans: string[][] = [
    ['switch', branchName],
    ['checkout', branchName],
  ];

  if (params.createIfMissing !== false) {
    plans.push(createArgsSwitch, createArgsCheckout);
  }

  return plans;
}

export function buildGitStageCommandArgs(params?: {
  all?: boolean;
  pathspecs?: readonly string[];
}): string[] {
  const pathspecs = normalizeGitPathspecs(params?.pathspecs);
  if (params?.all === true || pathspecs.length === 0) {
    return ['add', '-A', '--', '.'];
  }
  return ['add', '-A', '--', ...pathspecs];
}

export function buildGitCommitCommandArgs(
  message: string,
  options?: { allowEmpty?: boolean }
): string[] {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error('commit message 不能为空');
  }
  return options?.allowEmpty
    ? ['commit', '--allow-empty', '-m', trimmedMessage]
    : ['commit', '-m', trimmedMessage];
}

export function buildGitStashPushArgs(
  message: string,
  options?: {
    includeUntracked?: boolean;
    pathspecs?: readonly string[];
  }
): string[] {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error('stash message 不能为空');
  }

  const args = ['stash', 'push'];
  if (options?.includeUntracked !== false) {
    args.push('--include-untracked');
  }
  args.push('-m', trimmedMessage);

  const pathspecs = normalizeGitPathspecs(options?.pathspecs);
  return appendPathspecs(args, pathspecs);
}

export function buildGitLatestStashCommandArgs(): string[] {
  return ['stash', 'list', '-1', '--format=%gd%x1f%s'];
}

export function parseGitLatestStashCommandResult(
  result: GitCommandResultLike
): GitLatestStashEntry | null {
  if ((result.status ?? 1) !== 0) {
    return null;
  }

  const line = result.stdout.trim();
  if (!line) {
    return null;
  }

  const [ref, message] = line.split('\x1f');
  if (!ref?.trim()) {
    return null;
  }

  return {
    ref: ref.trim(),
    message: message?.trim() ?? '',
  };
}

export function buildGitRestoreCommandPlans(params?: {
  pathspecs?: readonly string[];
  source?: string;
}): string[][] {
  const source = assertValidGitReference(params?.source ?? 'HEAD', 'source');
  const pathspecs = normalizeGitPathspecs(params?.pathspecs);

  if (pathspecs.length === 0) {
    return [
      ['restore', '--source', source, '--staged', '--worktree', '--', '.'],
      ['reset', '--hard', source],
    ];
  }

  return [
    ['restore', '--source', source, '--staged', '--worktree', '--', ...pathspecs],
    ['reset', source, '--', ...pathspecs],
    ['checkout', source, '--', ...pathspecs],
  ];
}

export function buildGitResetCommandArgs(target: string): string[] {
  return ['reset', '--hard', assertValidGitReference(target, 'target')];
}

export function buildGitBackupBranchName(prefix: string = 'codepapr/backup', now: Date = new Date()): string {
  const sanitizedPrefix = prefix
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\/+/g, '/');
  return assertValidGitBranchName(`${sanitizedPrefix || 'codepapr/backup'}/${formatTimestamp(now)}`);
}

export function buildGitSafetyStashMessage(
  action: string,
  target?: string,
  now: Date = new Date()
): string {
  const normalizedAction = action.trim() || 'git-action';
  const parts = ['CodePapr safety snapshot', normalizedAction];
  if (target?.trim()) {
    parts.push(target.trim());
  }
  parts.push(formatTimestamp(now));
  return parts.join(' | ');
}