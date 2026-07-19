import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MonacoDiffEditor } from './MonacoDiffEditor';
import { useAgentStore } from '../store/agentStore';
import type { ReviewScope } from '../utils/codeReview';
import { languageFromPath } from '../utils/editorLanguage';

interface CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface FileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

function parseDiffFileList(stdout: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([ADM])\t(.+)$/.exec(trimmed) || /^R\d*\t(.+?)\t(.+)$/.exec(trimmed);
    if (match) {
      if (match[1] === 'A') entries.push({ path: match[2], status: 'added' });
      else if (match[1] === 'D') entries.push({ path: match[2], status: 'deleted' });
      else if (match[1] === 'M') entries.push({ path: match[2], status: 'modified' });
      else if (match[2] && match[3]) entries.push({ path: match[3], status: 'renamed' });
    }
  }
  return entries;
}

async function loadFileContent(workspacePath: string, ref: string, filePath: string): Promise<string> {
  if (ref === 'WORKTREE') {
    const result = await invoke<{ content: string }>('read_text_file', {
      workspacePath,
      relativePath: filePath,
      maxBytes: 5_000_000,
    });
    return result.content ?? '';
  }
  const result = await invoke<CommandResult>('run_workspace_command', {
    workspacePath,
    command: 'git',
    args: ['show', `${ref}:${filePath}`],
    timeoutSeconds: 15,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || `git show ${ref}:${filePath} failed`
    );
  }
  return result.stdout ?? '';
}

/**
 * 列出 base..head 之间的改动文件列表。
 * 当 head === 'WORKTREE' 时，比较的是 base 与当前工作区（包含未暂存改动），
 * 改用单参数形式：`git diff --name-status <base>`。
 */
async function loadFileList(workspacePath: string, base: string, head: string): Promise<FileEntry[]> {
  const args =
    head === 'WORKTREE'
      ? ['diff', '--name-status', '--no-renames', base]
      : ['diff', '--name-status', '--no-renames', `${base}..${head}`];
  const result = await invoke<CommandResult>('run_workspace_command', {
    workspacePath,
    command: 'git',
    args,
    timeoutSeconds: 15,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || 'git diff failed'
    );
  }
  return parseDiffFileList(result.stdout ?? '');
}

const STATUS_COLORS: Record<FileEntry['status'], string> = {
  added: 'text-emerald-400',
  modified: 'text-amber-400',
  deleted: 'text-rose-400',
  renamed: 'text-sky-400',
};

interface CodeReviewPanelProps {
  scope: ReviewScope;
  onClose: () => void;
}

function shortRef(ref: string, lang: 'zh-CN' | 'zh-TW' | 'en'): string {
  if (ref === 'WORKTREE') {
    return lang === 'en' ? 'Working Tree' : lang === 'zh-TW' ? '工作區' : '当前工作区';
  }
  // 显示前 7 位（commit short hash 风格），其他 ref 名（HEAD/HEAD~1/branch）原样保留。
  if (/^[0-9a-f]{8,40}$/i.test(ref)) {
    return ref.slice(0, 7);
  }
  return ref;
}

export function CodeReviewPanel({ scope, onClose }: CodeReviewPanelProps) {
  const { workspacePath, settings } = useAgentStore();
  const lang = settings.lang ?? 'zh-CN';

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState('');
  const [modifiedContent, setModifiedContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // scope 切换时重置激活文件，避免上一次审查的状态污染。
  useEffect(() => {
    setActiveFilePath(null);
  }, [scope.baseRef, scope.headRef]);

  useEffect(() => {
    if (!workspacePath) return;
    setIsLoading(true);
    setError(null);
    loadFileList(workspacePath, scope.baseRef, scope.headRef)
      .then((entries) => {
        setFiles(entries);
        setActiveFilePath((current) => current ?? entries[0]?.path ?? null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setIsLoading(false));
  }, [workspacePath, scope.baseRef, scope.headRef]);

  useEffect(() => {
    if (!workspacePath || !activeFilePath) return;
    setIsLoading(true);
    setError(null);
    Promise.all([
      loadFileContent(workspacePath, scope.baseRef, activeFilePath).catch(() => ''),
      loadFileContent(workspacePath, scope.headRef, activeFilePath).catch(() => ''),
    ])
      .then(([original, modified]) => {
        setOriginalContent(original);
        setModifiedContent(modified);
      })
      .finally(() => setIsLoading(false));
  }, [workspacePath, activeFilePath, scope.baseRef, scope.headRef]);

  const fileLanguage = activeFilePath ? languageFromPath(activeFilePath) : 'markdown';
  const baseLabel = shortRef(scope.baseRef, lang);
  const headLabel = shortRef(scope.headRef, lang);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex h-[88vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#0f1117] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2a2d3a] px-5 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-200">
              {lang === 'en' ? 'Code Comparison' : lang === 'zh-TW' ? '程式碼對比' : '代码对比'}
            </h2>
            <span className="rounded-full border border-[#2a2d3a] bg-[#1a1d27] px-2.5 py-0.5 font-mono text-[10px] text-slate-400">
              {baseLabel} → {headLabel}
            </span>
            {files.length > 0 && (
              <span className="text-[11px] text-slate-500">
                {files.length} {lang === 'en' ? (files.length === 1 ? 'file' : 'files') : '个文件'}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-slate-500 transition-colors hover:text-slate-200"
          >
            ×
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* File list sidebar */}
          <div className="w-56 shrink-0 overflow-y-auto border-r border-[#2a2d3a] bg-[#10131b]">
            {files.length === 0 && !isLoading && !error && (
              <div className="p-4 text-xs text-slate-500">
                {lang === 'en' ? 'No file changes in this range.' : '此范围内没有文件改动。'}
              </div>
            )}
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setActiveFilePath(file.path)}
                className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left text-xs transition-colors ${
                  activeFilePath === file.path
                    ? 'border-indigo-500 bg-indigo-500/10 text-slate-100'
                    : 'border-transparent text-slate-400 hover:bg-slate-700/30'
                }`}
              >
                <span className={`shrink-0 font-mono text-[10px] ${STATUS_COLORS[file.status]}`}>
                  {file.status[0].toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
              </button>
            ))}
          </div>

          {/* Diff viewer */}
          <div className="flex min-w-0 flex-1 flex-col">
            {error && (
              <div className="border-b border-rose-500/20 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
                {error}
              </div>
            )}
            {activeFilePath && (
              <>
                <div className="flex items-center gap-2 border-b border-[#2a2d3a] px-4 py-2">
                  <span className="font-mono text-xs text-slate-300">{activeFilePath}</span>
                </div>
                <div className="min-h-0 flex-1">
                  <MonacoDiffEditor
                    originalValue={originalContent}
                    modifiedValue={modifiedContent}
                    language={fileLanguage}
                    minHeight={300}
                  />
                </div>
              </>
            )}
            {!activeFilePath && !isLoading && !error && (
              <div className="flex h-full items-center justify-center text-xs text-slate-500">
                {lang === 'en' ? 'Select a file to view its diff.' : '选择左侧文件查看差异。'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
