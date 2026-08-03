import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalBoolean,
  asOptionalPositiveInteger,
  asOptionalStringArray,
} from '@codepapr/core';
import { type GitHistorySummary, assertValidGitReference } from '@codepapr/common';
import { toolByName } from './workspaceToolDefinitions';
import { buildGitUnavailableDiff, type GitDiffSummary } from './workspaceToolUtils';
import { type WorkspaceToolContext } from './workspaceToolContext';

export function registerWorkspaceGitTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
    readGitStatus,
  } = ctx;

  registry.register(toolByName('workspace_git_status'), async () => {
    return await readGitStatus();
  });

  registry.register(toolByName('workspace_git_history'), async (args: Record<string, unknown>) => {
    const limit = Math.min(asOptionalPositiveInteger(args.limit, 'limit') ?? 20, 100);

    const status = await readGitStatus();
    if (!status.available || !status.isRepo) {
      return {
        available: status.available,
        isRepo: status.isRepo,
        entries: [],
        raw: status.raw,
        ...(status.message ? { message: status.message } : {}),
      } satisfies GitHistorySummary;
    }

    const entries = await invoke<import('../utils/snapshot').GitLogEntry[]>('git_log', {
      workspacePath: workspace(),
      limit,
    });
    return {
      available: true,
      isRepo: true,
      entries: entries.map((e) => ({
        hash: e.sha,
        shortHash: e.shortHash,
        committedAt: new Date(e.timestamp * 1000).toISOString(),
        authorName: e.author,
        refNames: e.refs,
        subject: e.message,
        isHead: e.isHead,
      })),
      raw: '',
    } satisfies GitHistorySummary;
  });

  registry.register(toolByName('workspace_git_diff'), async (args: Record<string, unknown>) => {
    const staged = asOptionalBoolean(args.staged, 'staged') === true;
    const pathspecs = asOptionalStringArray(args.pathspecs) ?? [];

    try {
      const result = await invoke<import('../utils/snapshot').GitDiffResult>('git_diff', {
        workspacePath: workspace(),
        staged: staged ? true : false,
        pathspecs: pathspecs.length > 0 ? pathspecs : undefined,
      });
      return {
        available: result.available,
        isRepo: true,
        staged,
        pathspecs,
        stat: result.stat,
        diff: result.diff,
        truncated: result.truncated,
        ...(result.message ? { message: result.message } : {}),
      } satisfies GitDiffSummary;
    } catch (error) {
      return buildGitUnavailableDiff((error as Error).message, staged, pathspecs) satisfies GitDiffSummary;
    }
  });

  registry.register(toolByName('workspace_git_branch_checkout'), async (args: Record<string, unknown>) => {
    const branchName = asString(args.branchName, 'branchName');
    const create = asOptionalBoolean(args.create, 'create');
    const createIfMissing = asOptionalBoolean(args.createIfMissing, 'createIfMissing');
    const startPoint = asOptionalString(args.startPoint);

    try {
      assertValidGitReference(branchName, 'branchName');
      if (startPoint) {
        assertValidGitReference(startPoint, 'startPoint');
      }
      const result = await invoke<import('../utils/snapshot').GitOperationResult>('git_branch_checkout', {
        workspacePath: workspace(),
        branchName,
        create: create ?? undefined,
        createIfMissing: createIfMissing ?? undefined,
        startPoint: startPoint ?? undefined,
      });
      return { available: true, isRepo: true, ok: result.ok, raw: result.message ?? '', action: 'branch_checkout', message: result.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isRepo: false, ok: false, raw: msg, action: 'branch_checkout', message: `切换分支失败: ${msg}` };
    }
  });

  registry.register(toolByName('workspace_git_stage'), async (args: Record<string, unknown>) => {
    const all = asOptionalBoolean(args.all, 'all');
    const pathspecs = asOptionalStringArray(args.pathspecs);

    try {
      const result = await invoke<import('../utils/snapshot').GitOperationResult>('git_stage', {
        workspacePath: workspace(),
        all: all ?? undefined,
        pathspecs: pathspecs ?? undefined,
      });
      return { available: true, isRepo: true, ok: result.ok, raw: result.message ?? '', action: 'stage', message: result.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isRepo: false, ok: false, raw: msg, action: 'stage', message: `暂存失败: ${msg}` };
    }
  });

  registry.register(toolByName('workspace_git_commit'), async (args: Record<string, unknown>) => {
    const message = asString(args.message, 'message');
    const stageAll = asOptionalBoolean(args.stageAll, 'stageAll');
    const pathspecs = asOptionalStringArray(args.pathspecs);
    const allowEmpty = asOptionalBoolean(args.allowEmpty, 'allowEmpty');

    try {
      const result = await invoke<import('../utils/snapshot').GitOperationResult>('git_commit', {
        workspacePath: workspace(),
        message,
        stageAll: stageAll ?? undefined,
        pathspecs: pathspecs ?? undefined,
        allowEmpty: allowEmpty ?? undefined,
      });
      return { available: true, isRepo: true, ok: result.ok, raw: result.message ?? '', action: 'commit', message: result.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isRepo: false, ok: false, raw: msg, action: 'commit', message: `提交失败: ${msg}` };
    }
  });

  registry.register(toolByName('workspace_git_restore'), async (args: Record<string, unknown>) => {
    const pathspecs = asOptionalStringArray(args.pathspecs);
    const source = asOptionalString(args.source);
    const snapshot = asOptionalBoolean(args.snapshot, 'snapshot') ?? true;
    const includeUntracked = asOptionalBoolean(args.includeUntracked, 'includeUntracked');

    try {
      if (source) {
        assertValidGitReference(source, 'source');
      }

      let backupRef: string | undefined;
      if (snapshot) {
        const snap = await invoke<import('../utils/snapshot').SnapshotInfo | null>('snapshot_create', {
          workspacePath: workspace(),
          label: `CodePapr safety snapshot | restore | ${source ?? 'HEAD'} | ${Date.now()}`,
        });
        backupRef = snap?.shortHash;
      }

      const result = await invoke<import('../utils/snapshot').GitOperationResult>('git_restore_files', {
        workspacePath: workspace(),
        pathspecs: pathspecs ?? undefined,
        source: source ?? undefined,
        includeUntracked: includeUntracked ?? false,
      });
      return {
        available: true,
        isRepo: true,
        ok: result.ok,
        raw: result.message ?? '',
        action: 'restore' as const,
        message: result.ok && backupRef
          ? `${result.message}（安全快照 ${backupRef}）`
          : result.message,
        ...(backupRef ? { backupBranch: backupRef } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isRepo: false, ok: false, raw: msg, action: 'restore' as const, message: `恢复失败: ${msg}` };
    }
  });

  registry.register(toolByName('workspace_git_reset'), async (args: Record<string, unknown>) => {
    const target = asString(args.target, 'target');
    try {
      assertValidGitReference(target, 'target');
      const result = await invoke<{ ok: boolean; filesRestored: number; filesDeleted: number; backupRef: string | null; error: string | null }>(
        'restore_execute',
        { workspacePath: workspace(), targetSha: target }
      );

      if (result.ok) {
        return {
          available: true, isRepo: true, ok: true, action: 'reset', raw: '',
          message: `已回退到 ${target}，备份引用 ${result.backupRef ?? 'N/A'}，恢复 ${result.filesRestored} 个文件。`,
          backupBranch: result.backupRef ?? undefined,
          target,
        };
      }
      return {
        available: true, isRepo: true, ok: false, action: 'reset', raw: '',
        message: result.error ?? '回退失败。',
        backupBranch: result.backupRef ?? undefined,
        target,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        available: true, isRepo: true, ok: false, action: 'reset', raw: '',
        message: `回退失败: ${msg}`,
        target,
      };
    }
  });

  registry.register(toolByName('workspace_restore_undo'), async (_args: Record<string, unknown>) => {
    try {
      await invoke<void>('restore_undo', { workspacePath: workspace() });
      return {
        available: true, isRepo: true, ok: true, action: 'undo', raw: '',
        message: '已撤销上一次恢复操作。',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        available: true, isRepo: true, ok: false, action: 'undo', raw: '',
        message: `撤销失败: ${msg}`,
      };
    }
  });

}
