import { errorMessage } from '@codepapr/common';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { loadSkillsLock, pruneSkillFromLock, saveSkillsLock } from '../utils/skillsLock';
import { collectSkillEntryRefs } from '../utils/projectConfigLoader';

interface ProjectConfigModalProps {
  workspacePath: string;
  lang?: Lang;
  onClose: () => void;
  onOpenSkillMarket?: () => void;
  skillMarketOpen?: boolean;
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

type ConfigTab = 'rules' | 'agents' | 'skills' | 'commands';

const AGENTS_DIR = '.CodePapr/agents';
const SKILLS_DIR = '.CodePapr/skills';
const SKILL_METADATA_MAX_BYTES = 8_192;
const COMMANDS_DIR = '.CodePapr/commands';
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

function createCommandTemplate(name: string): string {
  const safeName = name.trim() || 'ship';
  return [
    '---',
    `description: ${safeName} 项目命令`,
    '---',
    '',
    `请处理：$ARGUMENTS`,
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
const normalizeCommandName = normalizeAgentName;

function fileNameFromEntry(entry: ListFilesEntry): string {
  const segments = entry.path.split(/[\\/]/);
  return entry.name ?? segments[segments.length - 1] ?? '';
}

export function unusedSkillDraftName(existingIds: readonly string[]): string {
  const taken = new Set(existingIds);
  for (const candidate of [DEFAULT_SEARCH_SKILL_NAME, 'docs', 'workflow', 'notes']) {
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  let index = 2;
  while (taken.has(`skill-${index}`)) {
    index += 1;
  }
  return `skill-${index}`;
}

function confirmUnsaved(lang?: Lang): boolean {
  const text =
    lang === 'en'
      ? 'You have unsaved changes. Discard them and continue?'
      : lang === 'zh-TW'
        ? '有未儲存的修改。放棄後繼續？'
        : '有未保存的修改。丢弃后继续？';
  return typeof window !== 'undefined' && window.confirm(text);
}

function confirmDeleteItem(lang: Lang | undefined, name: string): boolean {
  const text =
    lang === 'en'
      ? `Delete "${name}"? This cannot be undone.`
      : lang === 'zh-TW'
        ? `確定刪除「${name}」？此操作無法撤銷。`
        : `确定删除「${name}」？此操作无法撤销。`;
  return typeof window !== 'undefined' && window.confirm(text);
}

function confirmOverwriteItem(lang: Lang | undefined, name: string): boolean {
  const text =
    lang === 'en'
      ? `"${name}" already exists. Overwriting will replace the current file. Continue?`
      : lang === 'zh-TW'
        ? `「${name}」已存在。覆蓋將取代現有內容。繼續？`
        : `「${name}」已存在。覆盖将替换现有内容。继续？`;
  return typeof window !== 'undefined' && window.confirm(text);
}

function truncatedSkillsListHint(lang?: Lang): string {
  if (lang === 'en') {
    return 'The Skill list was truncated. Some skills may be missing.';
  }
  if (lang === 'zh-TW') {
    return 'Skill 列表被截斷，部分 Skill 可能未顯示。';
  }
  return 'Skill 列表被截断，部分 Skill 可能未显示。';
}

export function ProjectConfigModal({
  workspacePath,
  lang,
  onClose,
  onOpenSkillMarket,
  skillMarketOpen = false,
}: ProjectConfigModalProps) {
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
  const [commandNames, setCommandNames] = useState<string[]>([]);
  const [selectedCommandName, setSelectedCommandName] = useState<string | null>(null);
  const [commandContent, setCommandContent] = useState('');
  const [newCommandName, setNewCommandName] = useState('ship');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [savedRules, setSavedRules] = useState('');
  const [savedAgentContent, setSavedAgentContent] = useState('');
  const [savedSkillContent, setSavedSkillContent] = useState('');
  const [savedCommandContent, setSavedCommandContent] = useState('');
  const [skillsListTruncated, setSkillsListTruncated] = useState(false);
  const wasSkillMarketOpen = useRef(false);

  const selectedAgentPath = useMemo(
    () => (selectedAgentName ? `${AGENTS_DIR}/${selectedAgentName}.md` : null),
    [selectedAgentName]
  );
  const selectedSkillEntry = useMemo(
    () => skillEntries.find((entry) => entry.id === selectedSkillName) ?? null,
    [selectedSkillName, skillEntries]
  );
  const selectedSkillPath = selectedSkillEntry?.relativePath ?? null;
  const selectedCommandPath = useMemo(
    () => (selectedCommandName ? `${COMMANDS_DIR}/${selectedCommandName}.md` : null),
    [selectedCommandName]
  );

  const loadRules = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const result = await invoke<ReadFileResult>('read_text_file', {
        workspacePath,
        relativePath: PROJECT_AGENTS_FILE,
        maxBytes: 300_000,
      });
      setRulesContent(result.content);
      setSavedRules(result.content);
    } catch {
      const fallback = getDefaultAgentsTemplate(settings.lang);
      setRulesContent(fallback);
      setSavedRules(fallback);
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
      setSavedAgentContent('');
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

  const loadCommandNames = useCallback(async () => {
    if (!workspacePath) return;
    let result: ListFilesResult;
    try {
      result = await invoke<ListFilesResult>('list_workspace_files', {
        workspacePath,
        relativePath: COMMANDS_DIR,
        maxDepth: 1,
      });
    } catch {
      setCommandNames([]);
      setSelectedCommandName(null);
      setCommandContent('');
      setSavedCommandContent('');
      return;
    }

    const names = result.entries
      .filter((entry) => entry.kind !== 'dir' && entry.isDir !== true)
      .map(fileNameFromEntry)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((name) => name.replace(/\.md$/i, ''))
      .sort((a, b) => a.localeCompare(b));

    setCommandNames(names);
    setSelectedCommandName((current) => (current && names.includes(current) ? current : names[0] ?? null));
    if (names.length === 0) {
      setCommandContent('');
      setSavedCommandContent('');
    }
  }, [workspacePath]);

  const loadSkillNames = useCallback(async () => {
    if (!workspacePath) return;
    let result: ListFilesResult;
    try {
      result = await invoke<ListFilesResult>('list_workspace_files', {
        workspacePath,
        relativePath: SKILLS_DIR,
        maxDepth: 10,
      });
      setSkillsListTruncated(Boolean(result.truncated));
      const enabledById = normalizeSkillEnabledById(useAgentStore.getState().skillEnabledById);
      const refs = collectSkillEntryRefs(result.entries);
      const entries = await Promise.all(
        refs.map(async (entry) => {
          try {
            const file = await invoke<ReadFileResult>('read_text_file', {
              workspacePath,
              relativePath: entry.relativePath,
              maxBytes: SKILL_METADATA_MAX_BYTES,
            });
            const metadata = readSkillMetadata(entry.id, file.content);
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
      setNewSkillName((current) => {
        if (current !== DEFAULT_SEARCH_SKILL_NAME) {
          return current;
        }
        return unusedSkillDraftName(names);
      });
      if (entries.length === 0) {
        setSkillContent('');
        setSavedSkillContent('');
      }
    } catch {
      setSkillEntries([]);
      setSelectedSkillName(null);
      setSkillContent('');
      setSavedSkillContent('');
      setSkillsListTruncated(false);
    }
  }, [workspacePath]);

  const loadSelectedAgent = useCallback(async () => {
    if (!workspacePath || !selectedAgentPath) {
      setAgentContent('');
      setSavedAgentContent('');
      return;
    }

    try {
      const result = await invoke<ReadFileResult>('read_text_file', {
        workspacePath,
        relativePath: selectedAgentPath,
        maxBytes: 300_000,
      });
      setAgentContent(result.content);
      setSavedAgentContent(result.content);
    } catch (err) {
      setAgentContent('');
      setSavedAgentContent('');
      setError(errorMessage(err));
    }
  }, [selectedAgentPath, workspacePath]);

  const loadSelectedSkill = useCallback(async () => {
    if (!workspacePath || !selectedSkillPath) {
      setSkillContent('');
      setSavedSkillContent('');
      return;
    }

    try {
      const result = await invoke<ReadFileResult>('read_text_file', {
        workspacePath,
        relativePath: selectedSkillPath,
        maxBytes: 300_000,
      });
      setSkillContent(result.content);
      setSavedSkillContent(result.content);
    } catch (err) {
      setSkillContent('');
      setSavedSkillContent('');
      setError(errorMessage(err));
    }
  }, [selectedSkillPath, workspacePath]);

  const loadSelectedCommand = useCallback(async () => {
    if (!workspacePath || !selectedCommandPath) {
      setCommandContent('');
      setSavedCommandContent('');
      return;
    }

    try {
      const result = await invoke<ReadFileResult>('read_text_file', {
        workspacePath,
        relativePath: selectedCommandPath,
        maxBytes: 300_000,
      });
      setCommandContent(result.content);
      setSavedCommandContent(result.content);
    } catch (err) {
      setCommandContent('');
      setSavedCommandContent('');
      setError(errorMessage(err));
    }
  }, [selectedCommandPath, workspacePath]);

  const reloadAll = useCallback(async () => {
    setIsLoading(true);
    setError('');
    setStatus('');
    try {
      await Promise.all([loadRules(), loadAgentNames(), loadSkillNames(), loadCommandNames()]);
    } finally {
      setIsLoading(false);
    }
  }, [loadAgentNames, loadCommandNames, loadRules, loadSkillNames]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    void loadSelectedAgent();
  }, [loadSelectedAgent]);

  useEffect(() => {
    void loadSelectedSkill();
  }, [loadSelectedSkill]);

  useEffect(() => {
    void loadSelectedCommand();
  }, [loadSelectedCommand]);

  useEffect(() => {
    if (wasSkillMarketOpen.current && !skillMarketOpen) {
      void loadSkillNames();
    }
    wasSkillMarketOpen.current = skillMarketOpen;
  }, [skillMarketOpen, loadSkillNames]);

  const currentEditorDirty =
    (activeTab === 'rules' && rulesContent !== savedRules) ||
    (activeTab === 'agents' && Boolean(selectedAgentName) && agentContent !== savedAgentContent) ||
    (activeTab === 'skills' && Boolean(selectedSkillName) && skillContent !== savedSkillContent) ||
    (activeTab === 'commands' && Boolean(selectedCommandName) && commandContent !== savedCommandContent);

  const revertCurrentEditor = () => {
    if (activeTab === 'rules') setRulesContent(savedRules);
    if (activeTab === 'agents') setAgentContent(savedAgentContent);
    if (activeTab === 'skills') setSkillContent(savedSkillContent);
    if (activeTab === 'commands') setCommandContent(savedCommandContent);
  };

  const requestLeaveCurrentEditor = (): boolean => {
    if (!currentEditorDirty) {
      return true;
    }
    if (!confirmUnsaved(lang ?? settings.lang)) {
      return false;
    }
    revertCurrentEditor();
    return true;
  };

  const selectConfigTab = (tab: ConfigTab) => {
    if (tab === activeTab) {
      return;
    }
    if (!requestLeaveCurrentEditor()) {
      return;
    }
    setActiveTab(tab);
  };

  const requestClose = () => {
    if (!requestLeaveCurrentEditor()) {
      return;
    }
    onClose();
  };

  const afterProjectConfigChanged = async (paths: string[]) => {
    noteWorkspaceMutation(paths);
    await reloadProjectConfig(workspacePath);
  };

  const persistSkillEnabled = useCallback(
    async (skillId: string, enabled: boolean | null) => {
      setSkillEnabledState(skillId, enabled);
    },
    [setSkillEnabledState]
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
      setSavedRules(rulesContent);
      setStatus(t.projectConfigSaved);
    } catch (err) {
      setError(errorMessage(err));
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
    if (agentNames.includes(name) && !confirmOverwriteItem(lang ?? settings.lang, name)) {
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
      setError(errorMessage(err));
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
      setSavedAgentContent(agentContent);
      setStatus(t.projectConfigSaved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteAgent = async () => {
    if (!selectedAgentPath || !selectedAgentName) return;
    if (!confirmDeleteItem(lang ?? settings.lang, selectedAgentName)) {
      return;
    }
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
      setError(errorMessage(err));
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
    if (skillEntries.some((entry) => entry.id === name) && !confirmOverwriteItem(lang ?? settings.lang, name)) {
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
      setError(errorMessage(err));
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
      setSavedSkillContent(skillContent);
      setStatus(t.projectConfigSaved);
    } catch (err) {
      setError(errorMessage(err));
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
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteSkill = async () => {
    const selectedSkill = skillEntries.find((entry) => entry.id === selectedSkillName);
    if (!selectedSkill) return;
    if (!confirmDeleteItem(lang ?? settings.lang, selectedSkill.id)) {
      return;
    }
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
      const currentLock = await loadSkillsLock(invoke, workspacePath);
      const nextLock = pruneSkillFromLock(currentLock, selectedSkill.id);
      if (nextLock !== currentLock) {
        await saveSkillsLock(invoke, workspacePath, nextLock);
      }
      await persistSkillEnabled(selectedSkill.id, null);
      await afterProjectConfigChanged([deletePath]);
      setStatus(t.projectConfigSkillDeleted);
      await loadSkillNames();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const createCommand = async () => {
    const name = normalizeCommandName(newCommandName);
    if (!name) {
      setError(t.projectConfigInvalidCommandName);
      return;
    }
    if (commandNames.includes(name) && !confirmOverwriteItem(lang ?? settings.lang, name)) {
      return;
    }
    const relativePath = `${COMMANDS_DIR}/${name}.md`;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('write_text_file', {
        workspacePath,
        relativePath,
        content: createCommandTemplate(name),
      });
      await afterProjectConfigChanged([relativePath]);
      await loadCommandNames();
      setSelectedCommandName(name);
      setNewCommandName('ship');
      setStatus(t.projectConfigCommandCreated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const saveCommand = async () => {
    if (!selectedCommandPath) return;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('write_text_file', {
        workspacePath,
        relativePath: selectedCommandPath,
        content: commandContent,
      });
      await afterProjectConfigChanged([selectedCommandPath]);
      setSavedCommandContent(commandContent);
      setStatus(t.projectConfigSaved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteCommand = async () => {
    if (!selectedCommandPath || !selectedCommandName) return;
    if (!confirmDeleteItem(lang ?? settings.lang, `/${selectedCommandName}`)) {
      return;
    }
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      await invoke('delete_workspace_file', {
        workspacePath,
        relativePath: selectedCommandPath,
      });
      await afterProjectConfigChanged([selectedCommandPath]);
      setStatus(t.projectConfigCommandDeleted);
      await loadCommandNames();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-fg">{t.projectConfigTitle}</h2>
            <p className="mt-1 truncate text-xs text-fg-muted">{workspacePath}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="text-lg leading-none text-fg-muted transition-colors hover:text-fg"
          >
            x
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <button
            type="button"
            onClick={() => selectConfigTab('rules')}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              activeTab === 'rules'
                ? 'border-accent-soft bg-accent-soft text-accent-text'
                : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
            }`}
          >
            {t.projectConfigRulesTab}
          </button>
          <button
            type="button"
            onClick={() => selectConfigTab('agents')}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              activeTab === 'agents'
                ? 'border-accent-soft bg-accent-soft text-accent-text'
                : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
            }`}
          >
            {t.projectConfigAgentsTab}
          </button>
          <button
            type="button"
            onClick={() => selectConfigTab('skills')}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              activeTab === 'skills'
                ? 'border-accent-soft bg-accent-soft text-accent-text'
                : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
            }`}
          >
            {t.projectConfigSkillsTab}
          </button>
          <button
            type="button"
            onClick={() => selectConfigTab('commands')}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              activeTab === 'commands'
                ? 'border-accent-soft bg-accent-soft text-accent-text'
                : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
            }`}
          >
            {t.projectConfigCommandsTab}
          </button>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {isLoading && <span className="text-fg-muted">{t.loadingProject}</span>}
            {status && <span className="text-ok">{status}</span>}
            {error && <span className="max-w-[360px] truncate text-danger">{error}</span>}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {activeTab === 'rules' ? (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-fg-muted">{t.projectConfigRulesDesc}</div>
                <button
                  type="button"
                  onClick={saveRules}
                  disabled={isSaving || !workspacePath}
                  className="rounded-lg border border-accent-soft px-3 py-1.5 text-xs font-medium text-accent-text transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? t.projectConfigSaving : t.projectConfigSaveRules}
                </button>
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
              <div className="flex min-h-0 flex-col rounded-xl border border-line bg-base">
                <div className="border-b border-line p-3">
                  <div className="text-xs font-semibold text-fg">{t.projectConfigAgentsTab}</div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={newAgentName}
                      onChange={(event) => setNewAgentName(event.target.value)}
                      placeholder="reviewer"
                      className="min-w-0 flex-1 rounded-lg border border-line bg-base px-2 py-1.5 text-xs text-fg outline-none focus:border-accent-soft"
                    />
                    <button
                      type="button"
                      onClick={createAgent}
                      disabled={isSaving || !workspacePath}
                      className="rounded-lg border border-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent-text transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t.projectConfigCreateAgent}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {agentNames.length === 0 && (
                    <div className="px-2 py-6 text-center text-xs text-fg-dim">
                      {t.projectConfigNoAgents}
                    </div>
                  )}
                  {agentNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        if (name === selectedAgentName) return;
                        if (!requestLeaveCurrentEditor()) return;
                        setSelectedAgentName(name);
                      }}
                      title={`${AGENTS_DIR}/${name}.md`}
                      className={`mb-1 w-full truncate rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                        selectedAgentName === name
                          ? 'bg-accent-soft text-accent-text ring-1 ring-accent-soft ring-inset'
                          : 'text-fg-muted hover:bg-base hover:text-fg'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs leading-relaxed text-fg-muted">
                    {selectedAgentPath ?? t.projectConfigAgentDesc}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={saveAgent}
                      disabled={isSaving || !selectedAgentPath}
                      className="rounded-lg border border-accent-soft px-3 py-1.5 text-xs font-medium text-accent-text transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSaving ? t.projectConfigSaving : t.projectConfigSaveAgent}
                    </button>
                    <button
                      type="button"
                      onClick={deleteAgent}
                      disabled={isSaving || !selectedAgentPath}
                      className="rounded-lg border border-danger-bg px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
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
          ) : activeTab === 'commands' ? (
            <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] gap-4">
              <div className="flex min-h-0 flex-col rounded-xl border border-line bg-base">
                <div className="border-b border-line p-3">
                  <div className="text-xs font-semibold text-fg">{t.projectConfigCommandsTab}</div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={newCommandName}
                      onChange={(event) => setNewCommandName(event.target.value)}
                      placeholder="ship"
                      className="min-w-0 flex-1 rounded-lg border border-line bg-base px-2 py-1.5 text-xs text-fg outline-none focus:border-accent-soft"
                    />
                    <button
                      type="button"
                      onClick={createCommand}
                      disabled={isSaving || !workspacePath}
                      className="rounded-lg border border-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent-text transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t.projectConfigCreateCommand}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {commandNames.length === 0 && (
                    <div className="px-2 py-6 text-center text-xs text-fg-dim">
                      {t.projectConfigNoCommands}
                    </div>
                  )}
                  {commandNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        if (name === selectedCommandName) return;
                        if (!requestLeaveCurrentEditor()) return;
                        setSelectedCommandName(name);
                      }}
                      title={`${COMMANDS_DIR}/${name}.md`}
                      className={`mb-1 w-full truncate rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                        selectedCommandName === name
                          ? 'bg-accent-soft text-accent-text ring-1 ring-accent-soft ring-inset'
                          : 'text-fg-muted hover:bg-base hover:text-fg'
                      }`}
                    >
                      {`/${name}`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs leading-relaxed text-fg-muted">
                    {selectedCommandPath ?? t.projectConfigCommandDesc}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={saveCommand}
                      disabled={isSaving || !selectedCommandPath}
                      className="rounded-lg border border-accent-soft px-3 py-1.5 text-xs font-medium text-accent-text transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSaving ? t.projectConfigSaving : t.projectConfigSaveCommand}
                    </button>
                    <button
                      type="button"
                      onClick={deleteCommand}
                      disabled={isSaving || !selectedCommandPath}
                      className="rounded-lg border border-danger-bg px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t.projectConfigDeleteCommand}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  <MonacoTextEditor
                    value={commandContent}
                    onChange={setCommandContent}
                    language="markdown"
                    minHeight={300}
                    readOnly={!selectedCommandPath}
                    ariaLabel={t.projectConfigCommandsTab}
                    modelPath={selectedCommandPath ?? '.CodePapr/commands/new.md'}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] gap-4">
              <div className="flex min-h-0 flex-col rounded-xl border border-line bg-base">
                <div className="border-b border-line p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-fg">{t.projectConfigSkillsTab}</div>
                    {onOpenSkillMarket && (
                      <button
                        type="button"
                        onClick={() => {
                          if (!requestLeaveCurrentEditor()) return;
                          onOpenSkillMarket();
                        }}
                        className="rounded-lg border border-ok-bg px-2 py-1 text-[10px] font-medium text-ok transition-colors hover:bg-ok-bg"
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
                      className="min-w-0 flex-1 rounded-lg border border-line bg-base px-2 py-1.5 text-xs text-fg outline-none focus:border-accent-soft"
                    />
                    <button
                      type="button"
                      onClick={createSkill}
                      disabled={isSaving || !workspacePath}
                      className="rounded-lg border border-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent-text transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t.projectConfigCreateSkill}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {skillsListTruncated && (
                    <div className="mb-2 rounded-lg border border-warn-bg bg-warn-bg px-2 py-1.5 text-[10px] leading-relaxed text-warn">
                      {truncatedSkillsListHint(lang ?? settings.lang)}
                    </div>
                  )}
                  {skillEntries.length === 0 && (
                    <div className="px-2 py-6 text-center text-xs text-fg-dim">
                      {t.projectConfigNoSkills}
                    </div>
                  )}
                  {skillEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        if (entry.id === selectedSkillName) return;
                        if (!requestLeaveCurrentEditor()) return;
                        setSelectedSkillName(entry.id);
                      }}
                      title={entry.relativePath}
                      className={`mb-1 w-full overflow-hidden rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                        selectedSkillName === entry.id
                          ? 'bg-accent-soft text-accent-text ring-1 ring-accent-soft ring-inset'
                          : 'text-fg-muted hover:bg-base hover:text-fg'
                      }`}
                    >
                      <div className="truncate font-medium">{entry.skillName}</div>
                      <div className="mt-1 flex items-center gap-2 text-[10px]">
                        <span className={entry.enabled ? 'text-ok' : 'text-fg-dim'}>
                          {entry.enabled ? t.projectConfigSkillEnabled : t.projectConfigSkillDisabled}
                        </span>
                        {entry.skillName !== entry.id && (
                          <span className="truncate text-fg-muted">{entry.id}</span>
                        )}
                      </div>
                      <div className="mt-1 truncate text-[10px] text-fg-muted">{entry.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {selectedSkillEntry && (
                      <label className="flex shrink-0 items-center gap-2 text-xs text-fg-soft">
                        <input
                          type="checkbox"
                          aria-label={`${t.projectConfigSkillEnabled}: ${selectedSkillEntry.id}`}
                          checked={selectedSkillEntry.enabled}
                          disabled={isSaving || !selectedSkillPath}
                          onChange={(event) => void toggleSkillEnabled(selectedSkillEntry.id, event.target.checked)}
                          className="h-3.5 w-3.5 rounded border border-line-strong bg-base"
                        />
                        <span>{t.projectConfigSkillEnabled}</span>
                      </label>
                    )}
                    <div className="min-w-0 truncate text-xs text-fg-muted">
                      {selectedSkillPath ?? t.projectConfigSkillDesc}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={saveSkill}
                      disabled={isSaving || !selectedSkillPath}
                      className="rounded-lg border border-accent-soft px-3 py-1.5 text-xs font-medium text-accent-text transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSaving ? t.projectConfigSaving : t.projectConfigSaveSkill}
                    </button>
                    <button
                      type="button"
                      onClick={deleteSkill}
                      disabled={isSaving || !selectedSkillPath}
                      className="rounded-lg border border-danger-bg px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
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
