import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  getDefaultAgentsTemplate,
  DEFAULT_SEARCH_SKILL_NAME,
  DEFAULT_SEARCH_SKILL_TEMPLATE,
  parseSkillMarkdown,
} from '@codepapr/core';
import { useAgentStore } from '../store/agentStore';
import { MonacoTextEditor } from './MonacoTextEditor';
import { getTranslation, type Lang } from '../utils/i18n';
import { loadProjectState, saveProjectState } from '../utils/projectStorage';

interface ProjectConfigModalProps {
  workspacePath: string;
  lang?: Lang;
  onClose: () => void;
  onOpenSkillMarket?: () => void;
}

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
}

interface ListFilesEntry {
  path: string;
  name?: string;
  kind?: string;
  isDir?: boolean;
}

interface ListFilesResult {
  root: string;
  entries: ListFilesEntry[];
  truncated: boolean;
}

interface SkillEntryRefBase {
  id: string;
  displayName: string;
  rootPath: string;
  relativePath: string;
}

interface SkillEntryRef extends SkillEntryRefBase {
  skillName: string;
  description: string;
  enabled: boolean;
}

interface SkillMetadata {
  name: string;
  description: string;
}

type ConfigTab = 'rules' | 'agents' | 'skills';

const AGENTS_DIR = '.CodePapr/agents';
const SKILLS_DIR = '.CodePapr/skills';
const PROJECT_AGENTS_FILE = '.CodePapr/AGENTS.md';

function createAgentTemplate(name: string): string {
  const safeName = name.trim() || 'helper';
  return [
    '---',
    `description: ${safeName} 负责审查当前改动、定位风险并给出最小修复建议`,
    'mode: subagent',
    'model: ',
    'temperature: 0.2',
    'tools:',
    '  workspace_read_file: true',
    '  workspace_search_text: true',
    '  workspace_project_diagnostics: true',
    '  workspace_git_status: true',
    '  workspace_git_diff: true',
    '  workspace_write_file: false',
    '  workspace_run_command: false',
    '---',
    '',
    `你是 ${safeName}，一个只读代码审查子代理。`,
    '',
    '职责：',
    '- 阅读主代理委派的目标、相关文件和当前 diff。',
    '- 优先找真实 bug、行为回归、边界条件遗漏和缺失验证。',
    '- 给出最小修复建议，指出应修改的文件和验证命令。',
    '',
    '边界：',
    '- 默认不直接改文件；如果确实需要写入权限，先把 workspace_write_file 改为 true。',
    '- 不重复总结无关代码风格，只报告会影响正确性、可靠性或可维护性的发现。',
    '',
    '输出格式：',
    '1. Findings：按严重程度列出问题；没有问题就明确说未发现阻塞项。',
    '2. Suggested Fix：给出最小修改方向。',
    '3. Verification：列出建议运行的验证命令。',
  ].join('\n');
}

function createSkillTemplate(name: string): string {
  if (name === DEFAULT_SEARCH_SKILL_NAME) {
    return DEFAULT_SEARCH_SKILL_TEMPLATE;
  }
  return [
    '---',
    `name: ${name}`,
    `description: ${name} 可复用工作方法`,
    '---',
    `# ${name} Skill`,
    '',
    '写清这个 Skill 的适用场景、优先资料源、操作步骤和验证标准。',
  ].join('\n');
}

function defaultSkillDescription(name: string): string {
  return `项目 Skill ${name}`;
}

function skillLeafName(skillId: string): string {
  return skillId.split('/').filter(Boolean).pop() ?? skillId;
}

function readSkillMetadata(skillId: string, content: string): SkillMetadata {
  const fallbackName = skillLeafName(skillId);
  const parsed = parseSkillMarkdown(fallbackName, content);
  const resolvedName = parsed.name.trim() || fallbackName;
  return {
    name: resolvedName,
    description: parsed.description.trim() || defaultSkillDescription(resolvedName),
  };
}

function normalizeSkillEnabledById(value: Record<string, boolean> | undefined): Record<string, boolean> {
  if (!value) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[0] === 'string' && typeof entry[1] === 'boolean'
    )
  );
}

function resolveSkillEnabled(skillId: string, skillEnabledById: Record<string, boolean>): boolean {
  return skillEnabledById[skillId] !== false;
}

function normalizeAgentName(input: string): string {
  return input
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const normalizeSkillName = normalizeAgentName;

function fileNameFromEntry(entry: ListFilesEntry): string {
  const segments = entry.path.split(/[\\/]/);
  return entry.name ?? segments[segments.length - 1] ?? '';
}

function listSkillEntryRefs(result: ListFilesResult): SkillEntryRefBase[] {
  const refs = new Map<string, SkillEntryRefBase>();

  for (const entry of result.entries) {
    if (entry.kind === 'dir' || entry.isDir === true) {
      continue;
    }

    const normalizedPath = entry.path.replace(/\\/g, '/');
    const prefix = `${SKILLS_DIR}/`;
    if (!normalizedPath.startsWith(prefix)) {
      continue;
    }

    const rest = normalizedPath.slice(prefix.length);
    const nestedSkillMatch = rest.match(/^(.+)\/SKILL\.md$/i);
    if (nestedSkillMatch) {
      const skillId = nestedSkillMatch[1]!;
      const segments = skillId.split('/').filter(Boolean);
      refs.set(skillId, {
        id: skillId,
        displayName: segments[segments.length - 1] ?? skillId,
        rootPath: `${SKILLS_DIR}/${skillId}`,
        relativePath: normalizedPath,
      });
      continue;
    }

    if (!rest.includes('/') && rest.toLowerCase().endsWith('.md')) {
      const skillId = rest.replace(/\.md$/i, '');
      if (!refs.has(skillId)) {
        refs.set(skillId, {
          id: skillId,
          displayName: skillId,
          rootPath: `${SKILLS_DIR}/${skillId}`,
          relativePath: normalizedPath,
        });
      }
    }
  }

  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function ProjectConfigModal({ workspacePath, lang, onClose, onOpenSkillMarket }: ProjectConfigModalProps) {
  const settings = useAgentStore((state) => state.settings);
  const noteWorkspaceMutation = useAgentStore((state) => state.noteWorkspaceMutation);
  const reloadProjectConfig = useAgentStore((state) => state._loadProjectConfig);
  const setSkillEnabledState = useAgentStore((state) => state.setSkillEnabledState);
  const t = getTranslation(lang ?? settings.lang);
  const [activeTab, setActiveTab] = useState<ConfigTab>('rules');
  const [rulesContent, setRulesContent] = useState('');
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [agentContent, setAgentContent] = useState('');
  const [newAgentName, setNewAgentName] = useState('reviewer');
  const [skillEntries, setSkillEntries] = useState<SkillEntryRef[]>([]);
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState('');
  const [newSkillName, setNewSkillName] = useState(DEFAULT_SEARCH_SKILL_NAME);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const selectedAgentPath = useMemo(
    () => (selectedAgentName ? `${AGENTS_DIR}/${selectedAgentName}.md` : null),
    [selectedAgentName]
  );
  const selectedSkillEntry = useMemo(
    () => skillEntries.find((entry) => entry.id === selectedSkillName) ?? null,
    [selectedSkillName, skillEntries]
  );
  const selectedSkillPath = selectedSkillEntry?.relativePath ?? null;

  const loadRules = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const result = await invoke<ReadFileResult>('read_text_file', {
        workspacePath,
        relativePath: PROJECT_AGENTS_FILE,
        maxBytes: 300_000,
      });
      setRulesContent(result.content);
    } catch {
      setRulesContent(getDefaultAgentsTemplate(settings.lang));
    }
  }, [workspacePath]);

  const loadAgentNames = useCallback(async () => {
    if (!workspacePath) return;
    let result: ListFilesResult;
    try {
      result = await invoke<ListFilesResult>('list_workspace_files', {
        workspacePath,
        relativePath: AGENTS_DIR,
        maxDepth: 1,
      });
    } catch {
      setAgentNames([]);
      setSelectedAgentName(null);
      setAgentContent('');
      return;
    }

    const names = result.entries
      .filter((entry) => entry.kind !== 'dir' && entry.isDir !== true)
      .map(fileNameFromEntry)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((name) => name.replace(/\.md$/i, ''))
      .sort((a, b) => a.localeCompare(b));

    setAgentNames(names);
    setSelectedAgentName((current) => (current && names.includes(current) ? current : names[0] ?? null));
    if (names.length === 0) {
      setAgentContent('');
    }
  }, [workspacePath]);

  const loadSkillNames = useCallback(async () => {
    if (!workspacePath) return;
    let result: ListFilesResult;
    try {
      const [listResult, snapshot] = await Promise.all([
        invoke<ListFilesResult>('list_workspace_files', {
          workspacePath,
          relativePath: SKILLS_DIR,
          maxDepth: 10,
        }),
        loadProjectState(workspacePath),
      ]);
      result = listResult;
      const enabledById = normalizeSkillEnabledById(snapshot.skillEnabledById);
      const refs = listSkillEntryRefs(result);
      const entries = await Promise.all(
        refs.map(async (entry) => {
          try {
            const result = await invoke<ReadFileResult>('read_text_file', {
              workspacePath,
              relativePath: entry.relativePath,
              maxBytes: 300_000,
            });
            const metadata = readSkillMetadata(entry.id, result.content);
            return {
              ...entry,
              skillName: metadata.name,
              description: metadata.description,
              enabled: resolveSkillEnabled(entry.id, enabledById),
            };
          } catch {
            return {
              ...entry,
              skillName: entry.displayName,
              description: defaultSkillDescription(entry.displayName),
              enabled: resolveSkillEnabled(entry.id, enabledById),
            };
          }
        })
      );
      const names = entries.map((entry) => entry.id);

      setSkillEntries(entries);
      setSelectedSkillName((current) => (current && names.includes(current) ? current : names[0] ?? null));
      if (entries.length === 0) {
        setSkillContent('');
      }
    } catch {
      setSkillEntries([]);
      setSelectedSkillName(null);
      setSkillContent('');
    }
  }, [workspacePath]);

  const loadSelectedAgent = useCallback(async () => {
    if (!workspacePath || !selectedAgentPath) {
      setAgentContent('');
      return;
    }

    try {
      const result = await invoke<ReadFileResult>('read_text_file', {
        workspacePath,
        relativePath: selectedAgentPath,
        maxBytes: 300_000,
      });
      setAgentContent(result.content);
    } catch (err) {
      setAgentContent('');
      setError((err as Error).message);
    }
  }, [selectedAgentPath, workspacePath]);

  const loadSelectedSkill = useCallback(async () => {
    if (!workspacePath || !selectedSkillPath) {
      setSkillContent('');
      return;
    }

    try {
      const result = await invoke<ReadFileResult>('read_text_file', {
        workspacePath,
        relativePath: selectedSkillPath,
        maxBytes: 300_000,
      });
      setSkillContent(result.content);
    } catch (err) {
      setSkillContent('');
      setError((err as Error).message);
    }
  }, [selectedSkillPath, workspacePath]);

  const reloadAll = useCallback(async () => {
    setIsLoading(true);
    setError('');
    setStatus('');
    try {
      await Promise.all([loadRules(), loadAgentNames(), loadSkillNames()]);
    } finally {
      setIsLoading(false);
    }
  }, [loadAgentNames, loadRules, loadSkillNames]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    void loadSelectedAgent();
  }, [loadSelectedAgent]);

  useEffect(() => {
    void loadSelectedSkill();
  }, [loadSelectedSkill]);

  const afterProjectConfigChanged = async (paths: string[]) => {
    noteWorkspaceMutation(paths);
    await reloadProjectConfig(workspacePath);
  };

  const persistSkillEnabled = useCallback(
    async (skillId: string, enabled: boolean | null) => {
      const snapshot = await loadProjectState(workspacePath);
      const nextSkillEnabledById = normalizeSkillEnabledById(snapshot.skillEnabledById);
      if (enabled === null || enabled) {
        delete nextSkillEnabledById[skillId];
      } else {
        nextSkillEnabledById[skillId] = false;
      }

      await saveProjectState(workspacePath, {
        ...snapshot,
        skillEnabledById: nextSkillEnabledById,
      });
      setSkillEnabledState(skillId, enabled);
      return nextSkillEnabledById;
    },
    [setSkillEnabledState, workspacePath]
  );

  const saveRules = async () => {
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('write_text_file', {
        workspacePath,
        relativePath: PROJECT_AGENTS_FILE,
        content: rulesContent,
      });
      await afterProjectConfigChanged([PROJECT_AGENTS_FILE]);
      setStatus(t.projectConfigSaved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const createAgent = async () => {
    const name = normalizeAgentName(newAgentName);
    if (!name) {
      setError(t.projectConfigInvalidAgentName);
      return;
    }
    const relativePath = `${AGENTS_DIR}/${name}.md`;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('write_text_file', {
        workspacePath,
        relativePath,
        content: createAgentTemplate(name),
      });
      await afterProjectConfigChanged([relativePath]);
      await loadAgentNames();
      setSelectedAgentName(name);
      setNewAgentName('helper');
      setStatus(t.projectConfigAgentCreated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const saveAgent = async () => {
    if (!selectedAgentPath) return;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('write_text_file', {
        workspacePath,
        relativePath: selectedAgentPath,
        content: agentContent,
      });
      await afterProjectConfigChanged([selectedAgentPath]);
      setStatus(t.projectConfigSaved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteAgent = async () => {
    if (!selectedAgentPath || !selectedAgentName) return;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('delete_workspace_file', {
        workspacePath,
        relativePath: selectedAgentPath,
      });
      await afterProjectConfigChanged([selectedAgentPath]);
      setStatus(t.projectConfigAgentDeleted);
      await loadAgentNames();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const createSkill = async () => {
    const name = normalizeSkillName(newSkillName);
    if (!name) {
      setError(t.projectConfigInvalidSkillName);
      return;
    }
    const relativePath = `${SKILLS_DIR}/${name}/SKILL.md`;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('write_text_file', {
        workspacePath,
        relativePath,
        content: createSkillTemplate(name),
      });
      await persistSkillEnabled(name, true);
      await afterProjectConfigChanged([relativePath]);
      await loadSkillNames();
      setSelectedSkillName(name);
      setNewSkillName('docs');
      setStatus(t.projectConfigSkillCreated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const saveSkill = async () => {
    if (!selectedSkillPath || !selectedSkillEntry) return;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('write_text_file', {
        workspacePath,
        relativePath: selectedSkillPath,
        content: skillContent,
      });
      await afterProjectConfigChanged([selectedSkillPath]);
      await loadSkillNames();
      setStatus(t.projectConfigSaved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleSkillEnabled = async (skillId: string, enabled: boolean) => {
    const skillEntry = skillEntries.find((entry) => entry.id === skillId);
    if (!skillEntry) {
      return;
    }

    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await persistSkillEnabled(skillId, enabled);
      setSkillEntries((current) =>
        current.map((entry) => (entry.id === skillId ? { ...entry, enabled } : entry))
      );
      setStatus(t.projectConfigSaved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteSkill = async () => {
    const selectedSkill = skillEntries.find((entry) => entry.id === selectedSkillName);
    if (!selectedSkill) return;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      const deleteCommand = selectedSkill.relativePath.toLowerCase().endsWith('/skill.md')
        ? 'delete_workspace_dir'
        : 'delete_workspace_file';
      const deletePath =
        deleteCommand === 'delete_workspace_dir' ? selectedSkill.rootPath : selectedSkill.relativePath;
      await invoke(deleteCommand, {
        workspacePath,
        relativePath: deletePath,
      });
      await persistSkillEnabled(selectedSkill.id, null);
      await afterProjectConfigChanged([deletePath]);
      setStatus(t.projectConfigSkillDeleted);
      await loadSkillNames();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#2a2d3a] bg-[#161922] shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-[#2a2d3a] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-200">{t.projectConfigTitle}</h2>
            <p className="mt-1 truncate text-xs text-slate-500">{workspacePath}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-slate-500 transition-colors hover:text-slate-200"
          >
            x
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-[#2a2d3a] px-5 py-3">
          <button
            type="button"
            onClick={() => setActiveTab('rules')}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              activeTab === 'rules'
                ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/40 hover:text-slate-200'
            }`}
          >
            {t.projectConfigRulesTab}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('agents')}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              activeTab === 'agents'
                ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/40 hover:text-slate-200'
            }`}
          >
            {t.projectConfigAgentsTab}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('skills')}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              activeTab === 'skills'
                ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100'
                : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/40 hover:text-slate-200'
            }`}
          >
            {t.projectConfigSkillsTab}
          </button>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {isLoading && <span className="text-slate-500">{t.loadingProject}</span>}
            {status && <span className="text-emerald-300">{status}</span>}
            {error && <span className="max-w-[360px] truncate text-red-300">{error}</span>}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {activeTab === 'rules' ? (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs leading-relaxed text-slate-400">{t.projectConfigRulesDesc}</div>
                <button
                  type="button"
                  onClick={saveRules}
                  disabled={isSaving || !workspacePath}
                  className="rounded-lg border border-indigo-500/50 px-3 py-1.5 text-xs font-medium text-indigo-100 transition-colors hover:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? t.projectConfigSaving : t.projectConfigSaveRules}
                </button>
              </div>
              <div className="grid gap-2 text-xs leading-relaxed text-slate-400 md:grid-cols-2">
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-3">
                  <div className="mb-1 font-semibold text-slate-200">{t.projectConfigRulesTab}</div>
                  {t.projectConfigRulesRole}
                </div>
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-3">
                  <div className="mb-1 font-semibold text-slate-200">{t.projectConfigAgentsTab}</div>
                  {t.projectConfigAgentRole}
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <MonacoTextEditor
                  value={rulesContent}
                  onChange={setRulesContent}
                  language="markdown"
                  minHeight={300}
                  ariaLabel={t.projectConfigRulesTab}
                  modelPath={PROJECT_AGENTS_FILE}
                />
              </div>
            </div>
          ) : activeTab === 'agents' ? (
            <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] gap-4">
              <div className="flex min-h-0 flex-col rounded-xl border border-[#2a2d3a] bg-[#10141d]">
                <div className="border-b border-[#2a2d3a] p-3">
                  <div className="text-xs font-semibold text-slate-200">{t.projectConfigAgentsTab}</div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={newAgentName}
                      onChange={(event) => setNewAgentName(event.target.value)}
                      placeholder="reviewer"
                      className="min-w-0 flex-1 rounded-lg border border-[#2a2d3a] bg-[#0f1117] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500/70"
                    />
                    <button
                      type="button"
                      onClick={createAgent}
                      disabled={isSaving || !workspacePath}
                      className="rounded-lg border border-indigo-500/50 px-2.5 py-1.5 text-xs font-medium text-indigo-100 transition-colors hover:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t.projectConfigCreateAgent}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {agentNames.length === 0 && (
                    <div className="px-2 py-6 text-center text-xs text-slate-600">
                      {t.projectConfigNoAgents}
                    </div>
                  )}
                  {agentNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setSelectedAgentName(name)}
                      title={`${AGENTS_DIR}/${name}.md`}
                      className={`mb-1 w-full truncate rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                        selectedAgentName === name
                          ? 'bg-indigo-500/15 text-indigo-100 ring-1 ring-indigo-500/40 ring-inset'
                          : 'text-slate-400 hover:bg-[#171c29] hover:text-slate-100'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-col gap-3">
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-3 text-xs leading-relaxed text-slate-400">
                  <div className="mb-1 font-semibold text-slate-200">{t.projectConfigDifferenceTitle}</div>
                  <div>{t.projectConfigAgentRole}</div>
                  <div className="mt-2 text-slate-500">{t.projectConfigAgentExampleHint}</div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs leading-relaxed text-slate-400">
                    {selectedAgentPath ?? t.projectConfigAgentDesc}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={saveAgent}
                      disabled={isSaving || !selectedAgentPath}
                      className="rounded-lg border border-indigo-500/50 px-3 py-1.5 text-xs font-medium text-indigo-100 transition-colors hover:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSaving ? t.projectConfigSaving : t.projectConfigSaveAgent}
                    </button>
                    <button
                      type="button"
                      onClick={deleteAgent}
                      disabled={isSaving || !selectedAgentPath}
                      className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t.projectConfigDeleteAgent}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  <MonacoTextEditor
                    value={agentContent}
                    onChange={setAgentContent}
                    language="markdown"
                    minHeight={300}
                    readOnly={!selectedAgentPath}
                    ariaLabel={t.projectConfigAgentsTab}
                    modelPath={selectedAgentPath ?? '.CodePapr/agents/new.md'}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] gap-4">
              <div className="flex min-h-0 flex-col rounded-xl border border-[#2a2d3a] bg-[#10141d]">
                <div className="border-b border-[#2a2d3a] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-200">{t.projectConfigSkillsTab}</div>
                    {onOpenSkillMarket && (
                      <button
                        type="button"
                        onClick={() => { onClose(); onOpenSkillMarket(); }}
                        className="rounded-lg border border-emerald-500/30 px-2 py-1 text-[10px] font-medium text-emerald-200 transition-colors hover:bg-emerald-500/10"
                      >
                        {lang === 'en' ? 'Browse Market' : lang === 'zh-TW' ? '瀏覽市場' : '浏览市场'}
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={newSkillName}
                      onChange={(event) => setNewSkillName(event.target.value)}
                      placeholder={DEFAULT_SEARCH_SKILL_NAME}
                      className="min-w-0 flex-1 rounded-lg border border-[#2a2d3a] bg-[#0f1117] px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500/70"
                    />
                    <button
                      type="button"
                      onClick={createSkill}
                      disabled={isSaving || !workspacePath}
                      className="rounded-lg border border-indigo-500/50 px-2.5 py-1.5 text-xs font-medium text-indigo-100 transition-colors hover:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t.projectConfigCreateSkill}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {skillEntries.length === 0 && (
                    <div className="px-2 py-6 text-center text-xs text-slate-600">
                      {t.projectConfigNoSkills}
                    </div>
                  )}
                  {skillEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedSkillName(entry.id)}
                      title={entry.relativePath}
                      className={`mb-1 w-full overflow-hidden rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                        selectedSkillName === entry.id
                          ? 'bg-indigo-500/15 text-indigo-100 ring-1 ring-indigo-500/40 ring-inset'
                          : 'text-slate-400 hover:bg-[#171c29] hover:text-slate-100'
                      }`}
                    >
                      <div className="truncate font-medium">{entry.skillName}</div>
                      <div className="mt-1 flex items-center gap-2 text-[10px]">
                        <span className={entry.enabled ? 'text-emerald-300' : 'text-slate-600'}>
                          {entry.enabled ? t.projectConfigSkillEnabled : t.projectConfigSkillDisabled}
                        </span>
                        {entry.skillName !== entry.id && (
                          <span className="truncate text-slate-500">{entry.id}</span>
                        )}
                      </div>
                      <div className="mt-1 truncate text-[10px] text-slate-500">{entry.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-col gap-3">
                <div className="rounded-xl border border-[#2a2d3a] bg-[#10141d] p-3 text-xs leading-relaxed text-slate-400">
                  <div className="mb-1 font-semibold text-slate-200">{t.projectConfigSkillRoleTitle}</div>
                  <div>{t.projectConfigSkillRole}</div>
                  <div className="mt-2 text-slate-500">{t.projectConfigSkillExampleHint}</div>
                  {selectedSkillEntry && (
                    <label className="mt-3 flex items-start gap-2 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        aria-label={`${t.projectConfigSkillEnabled}: ${selectedSkillEntry.id}`}
                        checked={selectedSkillEntry.enabled}
                        disabled={isSaving || !selectedSkillPath}
                        onChange={(event) => void toggleSkillEnabled(selectedSkillEntry.id, event.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 rounded border border-[#46506b] bg-[#0f1117]"
                      />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span>{t.projectConfigSkillEnabled}</span>
                        <span className="text-slate-500">{t.projectConfigSkillToggleHint}</span>
                      </span>
                    </label>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs leading-relaxed text-slate-400">
                    {selectedSkillPath ?? t.projectConfigSkillDesc}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={saveSkill}
                      disabled={isSaving || !selectedSkillPath}
                      className="rounded-lg border border-indigo-500/50 px-3 py-1.5 text-xs font-medium text-indigo-100 transition-colors hover:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSaving ? t.projectConfigSaving : t.projectConfigSaveSkill}
                    </button>
                    <button
                      type="button"
                      onClick={deleteSkill}
                      disabled={isSaving || !selectedSkillPath}
                      className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t.projectConfigDeleteSkill}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  <MonacoTextEditor
                    value={skillContent}
                    onChange={setSkillContent}
                    language="markdown"
                    minHeight={300}
                    readOnly={!selectedSkillPath}
                    ariaLabel={t.projectConfigSkillsTab}
                    modelPath={selectedSkillPath ?? '.CodePapr/skills/search/SKILL.md'}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
