import { errorMessage } from '@codepapr/common';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { toast } from '../store/toastStore';
import { useAgentStore } from '../store/agentStore';
import { useCharactersStore } from '../store/charactersStore';
import { runCachedModelRequest } from '../utils/cachedModelRequest';
import { buildProviderInstance } from '../store/internals/providerFactory';
import { resolveProviderName } from '../store/internals/settingsNormalizer';
import {
  type CharacterProfile,
  type VoiceConfig,
  createEmptyCharacter,
} from '../utils/characterTypes';
import {
  buildCharacterCardSpec,
  importCharacterCardFromFile,
} from '../utils/characterCard';
import { getTranslation } from '../utils/i18n';

interface CharacterModalProps {
  onClose: () => void;
}

type LangCode = 'all_zh' | 'all_yue' | 'en' | 'all_ja' | 'all_ko' | 'zh' | 'ja' | 'auto';
const LANG_CONFIG: Record<LangCode, { name: string; instruction: string }> = {
  all_zh:  { name: '中文',   instruction: '生成中文独白或对话文本，每句以。！？结尾。' },
  all_yue: { name: '粤语',   instruction: '用粤语（广东话）生成独白或对话文本，使用口语化粤语表达。每句以。！？结尾。' },
  en:      { name: '英语',   instruction: 'Generate monologue or dialogue text in English. Use ". ! ?" as sentence endings.' },
  all_ja:  { name: '日语',   instruction: '日本語で会話または独白のテキストを生成してください。句読点は「。」「！」「？」を使用すること。' },
  all_ko:  { name: '韩语',   instruction: '한국어로 대사 또는 독백 텍스트를 생성해 주세요. 문장 부호는 "." "!" "?" 를 사용하세요.' },
  zh:      { name: '中英混合', instruction: '生成中英文混合的独白或对话文本，自然穿插中文和英文。' },
  ja:      { name: '日英混合', instruction: '日本語と英語を自然に混ぜた会話または独白のテキストを生成してください。' },
  auto:    { name: '多语种混合', instruction: '生成多语种自然混合的文本，可以包含中文、英文、日语等多种语言的自然转换。' },
};

export function CharacterModal({ onClose }: CharacterModalProps) {
  const { settings } = useAgentStore();
  const t = getTranslation(settings.lang);
  const {
    characters,
    activeCharacterId,
    loaded,
    loadCharacters,
    upsertCharacter,
    deleteCharacter,
    setActiveCharacter,
  } = useCharactersStore();
  const [editing, setEditing] = useState<CharacterProfile | null>(null);
  const [importError, setImportError] = useState<string>('');
  const [voiceTab, setVoiceTab] = useState<'basic' | 'voice'>('basic');
  const [voicePreviewUrl, setVoicePreviewUrl] = useState<string | null>(null);
  const [testVoiceError, setTestVoiceError] = useState<string | null>(null);
  const [testVoicePlaying, setTestVoicePlaying] = useState(false);
  const [warmupRunning, setWarmupRunning] = useState(false);
  const [warmupResult, setWarmupResult] = useState<'idle' | 'success' | 'error'>('idle');
  const [warmupError, setWarmupError] = useState<string | null>(null);
  const [finetuneProgress, setFinetuneProgress] = useState(0);
  const [finetuneLog, setFinetuneLog] = useState('');
  const [finetuneRunning, setFinetuneRunning] = useState(false);
  const [finetuneDone, setFinetuneDone] = useState(false);
  const [finetuneStep, setFinetuneStep] = useState('');

  const [generateRunning, setGenerateRunning] = useState(false);
  const [generateDone, setGenerateDone] = useState(false);
  const [generateCurrent, setGenerateCurrent] = useState(0);
  const [generateTotal, setGenerateTotal] = useState(0);
  const [generateFailedCount, setGenerateFailedCount] = useState(0);
  const [generateSentence, setGenerateSentence] = useState('');
  const [generatedTrainDir, setGeneratedTrainDir] = useState('');
  const [scriptGenerating, setScriptGenerating] = useState(false);
  const [trainingDataExists, setTrainingDataExists] = useState(false);
  const [generateError, setGenerateError] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const voiceSampleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadCharacters();
  }, [loadCharacters]);

  useEffect(() => {
    if (!loaded) return;
    if (!editing && characters.length > 0) {
      setEditing(characters[0]!);
    }
  }, [loaded, characters, editing]);

  // Reload voice preview when switching to a character with an existing reference file.
  useEffect(() => {
    const path = editing?.voice?.referenceSamplePath;
    if (!path) {
      setVoicePreviewUrl(null);
      return;
    }
    let cancelled = false;
    invoke<string>('tts_read_voice_file', { filePath: path })
      .then((url) => { if (!cancelled) setVoicePreviewUrl(url); })
      .catch(() => { if (!cancelled) setVoicePreviewUrl(null); });
    return () => { cancelled = true; };
  }, [editing?.id, editing?.voice?.referenceSamplePath]);

  const sortedCharacters = useMemo(() => {
    return characters.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [characters]);

  const handleNew = () => {
    const fresh = createEmptyCharacter();
    setEditing(fresh);
  };

  const handlePickFile = () => {
    fileInputRef.current?.click();
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportError('');
    try {
      const character = await importCharacterCardFromFile(file);
      await upsertCharacter(character);
      setEditing(character);
    } catch (err) {
      setImportError(`${t.characterImportFailed}: ${errorMessage(err)}`);
    }
  };

  const handleAvatarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !editing) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null;
      setEditing((current) => (current ? { ...current, avatarDataUrl: dataUrl } : current));
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) return;
    const next: CharacterProfile = {
      ...editing,
      name: editing.name.trim(),
      tags: editing.tags
        .map((tag) => tag.trim())
        .filter((tag, idx, arr) => tag && arr.indexOf(tag) === idx),
      updatedAt: new Date().toISOString(),
    };
    await upsertCharacter(next);
    setEditing(next);
    onClose();
  };

  const handleDelete = async (id: string) => {
    if (typeof window !== 'undefined' && !window.confirm(t.characterDeleteConfirm)) return;
    await deleteCharacter(id);
    if (editing?.id === id) {
      setEditing(null);
    }
  };

  const handleEnable = async (id: string) => {
    await setActiveCharacter(activeCharacterId === id ? null : id);
  };

  const handleExport = async () => {
    if (!editing) return;
    try {
      const safeName = editing.name.replace(/[^A-Za-z0-9_-]/g, '_') || 'character';
      const filePath = await save({
        title: t.characterExport,
        defaultPath: `${safeName}.png`,
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      });
      if (!filePath) return;
      const spec = buildCharacterCardSpec(editing);
      const json = JSON.stringify(spec);
      await invoke('export_character_card', {
        jsonSpec: json,
        avatarDataUrl: editing.avatarDataUrl,
        savePath: filePath,
      });
      toast.success(t.characterExportSuccess);
    } catch (e) {
      toast.error(`${t.characterExportError}: ${e}`);
    }
  };

  const updateField = (patch: Partial<CharacterProfile>) => {
    setEditing((current) => (current ? { ...current, ...patch } : current));
  };

  const updateVoiceField = useCallback((patch: Partial<VoiceConfig>) => {
    setEditing((current) =>
      current
        ? { ...current, voice: { ...current.voice ?? { enabled: false, engine: 'gpt-sovits', speed: 1.0 }, ...patch } }
        : current
    );
  }, []);

  const editingRef = useRef(editing);
  editingRef.current = editing;

  useEffect(() => {
    const charId = editing?.id;
    if (!charId) return;
    const unlistens: Array<() => void> = [];
    listen<{ character_id: string; step: string; percent: number; log_line: string }>(
      'tts-finetune-progress',
      (event) => {
        if (event.payload.character_id === charId) {
          setFinetuneProgress(event.payload.percent);
          setFinetuneLog(event.payload.log_line);
          setFinetuneStep(event.payload.step);
        }
      },
    ).then((fn) => unlistens.push(fn));
    listen<{ character_id: string; model_path: string }>(
      'tts-finetune-done',
      (event) => {
        if (event.payload.character_id === charId) {
          setFinetuneRunning(false);
          setFinetuneDone(true);
          setFinetuneProgress(100);
          setFinetuneLog('Done');
          updateVoiceField({
            fineTunedModelPath: event.payload.model_path,
            sampleSteps: 4,
          });
        }
      },
    ).then((fn) => unlistens.push(fn));
    listen<{ character_id: string; error: string }>(
      'tts-finetune-error',
      (event) => {
        if (event.payload.character_id === charId) {
          setFinetuneRunning(false);
          setFinetuneLog(event.payload.error);
        }
      },
    ).then((fn) => unlistens.push(fn));
    listen<{ character_id: string; current: number; total: number; sentence: string }>(
      'tts-generate-progress',
      (event) => {
        if (event.payload.character_id === charId) {
          setGenerateCurrent(event.payload.current);
          setGenerateTotal(event.payload.total);
          setGenerateSentence(event.payload.sentence);
        }
      },
    ).then((fn) => unlistens.push(fn));
    listen<{ character_id: string; train_dir: string; count: number; reused?: boolean; error?: string; failed_count?: number }>(
      'tts-generate-done',
      (event) => {
        if (event.payload.character_id === charId) {
          setGenerateRunning(false);
          if (event.payload.error) {
            setGenerateError(event.payload.error);
            return;
          }
          setTrainingDataExists(true);
          setGeneratedTrainDir(event.payload.train_dir);
          setGenerateFailedCount(event.payload.failed_count || 0);
          if (event.payload.reused) {
            setGenerateTotal(event.payload.count);
            return;
          }
          setGenerateDone(true);
          setGenerateCurrent(event.payload.count);
          setGenerateTotal(event.payload.count);
        }
      },
    ).then((fn) => unlistens.push(fn));
    listen<{ index: number; error: string }>(
      'tts-sentence-failed',
      (event) => {
        toast.warning(`第 ${event.payload.index + 1} 句合成失败，已跳过`);
      },
    ).then((fn) => unlistens.push(fn));
    return () => {
      unlistens.forEach((fn) => fn());
    };
  }, [editing?.id, updateVoiceField]);

  // Check if training data already exists for this character
  useEffect(() => {
    if (!editing?.id) return;
    // Sync finetuneDone from persisted voice config
    if (editing.voice?.fineTunedModelPath) {
      setFinetuneDone(true);
    } else {
      setFinetuneDone(false);
    }
    // Check training data existence synchronously
    invoke<boolean>('tts_check_training_data_exists', { characterId: editing.id })
      .then((exists) => {
        setTrainingDataExists(exists);
        if (exists) {
          // Estimate train dir path
          setGeneratedTrainDir('');
        }
      })
      .catch(() => setTrainingDataExists(false));
  }, [editing?.id, editing?.voice?.fineTunedModelPath]);

  // Generate a character-specific training script via LLM
  const generateTrainingScript = useCallback(async (language: string): Promise<string> => {
    const { settings } = useAgentStore.getState();
    const provider = buildProviderInstance(settings);
    const providerName = resolveProviderName(settings);

    const character = editing;
    const name = character?.name || (language.startsWith('ja') || language === 'all_ja' ? 'キャラクター' : language.startsWith('ko') || language === 'all_ko' ? '캐릭터' : '角色');
    const personality = character?.personality || '';
    const description = character?.description || '';
    const scenario = character?.scenario || '';

    const langEntry = LANG_CONFIG[language as LangCode] ?? LANG_CONFIG.all_zh;
    const langName = langEntry.name;
    const langInstruction = langEntry.instruction;

    const isCJK = language.startsWith('all_zh') || language === 'zh'
      || language.startsWith('all_yue') || language === 'yue'
      || language.startsWith('all_ja') || language === 'ja'
      || language.startsWith('all_ko') || language === 'ko';

    const systemPrompt = isCJK
      ? `你是一个剧本写手。根据角色的设定生成一段训练语音用的文本（约500字）。`
      : `You are a scriptwriter. Generate a training script (~500 characters) for voice synthesis based on the character's profile.`;

    const userPrompt = isCJK
      ? `角色名称：${name}
性格：${personality}
描述：${description}
场景：${scenario}

请用该角色的口吻和风格，生成一段约500字的${langName}独白或对话文本，用于语音合成训练。
要求：
- 完全贴合角色性格和说话风格
- 覆盖丰富的音素和语调变化
- 包含陈述句、疑问句、感叹句
- ${langInstruction}
- 大约20句话
- 只输出文本，不要任何解释`
      : `Character name: ${name}
Personality: ${personality}
Description: ${description}
Scenario: ${scenario}

Generate a ~500-character ${langName} monologue or dialogue in the character's voice and style for voice synthesis training.
Requirements:
- Fully match the character's personality and speaking style
- Cover a wide range of phonemes and intonation
- Include declarative, interrogative, and exclamatory sentences
- ${langInstruction}
- About 20 sentences
- Output text only, no explanations`;

    const result = await runCachedModelRequest({
      provider,
      providerName,
      model: settings.model,
      systemPrompt,
      userPrompt,
      temperature: 0.8,
      maxTokens: 2048,
      thinking: { type: 'disabled' },
    });

    return result.response.choices[0]?.message.content || '';
  }, [editing]);

  const handleVoiceSampleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : undefined;
      if (!dataUrl || !editing) return;
      setVoicePreviewUrl(dataUrl);
      const ext = file.name.split('.').pop() || 'mp3';
      try {
        const path = await invoke<string>('tts_save_voice_file', {
          characterId: editing.id,
          base64Data: dataUrl,
          extension: ext,
        });
        updateVoiceField({ referenceSamplePath: path });
      } catch (e) {
        console.error('Failed to save voice file:', e);
      }
    };
    reader.readAsDataURL(file);
  };

  const getTestTextForLang = (lang: string): string => {
    switch (lang) {
      case 'en': return 'Hello, this is my voice.';
      case 'all_ja': return 'こんにちは、これが私の声です。';
      case 'all_ko': return '안녕하세요, 제 목소리입니다.';
      case 'all_yue': return '你好，呢個係我嘅聲音。';
      default: return '你好，这是我的声音。';
    }
  };
  const handleTestVoice = async () => {
    if (!editing?.voice?.referenceSamplePath) return;
    setTestVoiceError(null);
    setTestVoicePlaying(true);
    try {
      const refLang = editing.voice.referenceTextLanguage || 'zh';
      const testText = editing.voice.referenceText || getTestTextForLang(refLang);
      await invoke('tts_synthesize_and_play', {
        text: testText,
        refAudioPath: editing.voice.referenceSamplePath,
        promptText: editing.voice.referenceText || '',
        promptLanguage: refLang,
      });
    } catch (e) {
      setTestVoiceError(String(e));
    } finally {
      setTestVoicePlaying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex select-none items-center justify-center bg-overlay backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[94vh] h-[94vh] w-[min(96vw,1480px)] flex-col overflow-hidden rounded-3xl border border-line bg-raised shadow-2xl">
        <div className="flex items-start justify-between border-b border-line px-7 py-5">
          <div>
            <h2 className="text-lg font-semibold text-fg">{t.charactersTitle}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t.charactersDesc}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleNew}
              className="rounded-xl border border-accent-soft px-3 py-2 text-xs font-medium text-accent-text transition-colors hover:border-accent hover:bg-accent-soft"
            >
              {t.characterNew}
            </button>
            <button
              type="button"
              onClick={handlePickFile}
              className="rounded-xl border border-line px-3 py-2 text-xs font-medium text-fg transition-colors hover:border-accent hover:text-fg"
            >
              {t.characterImport}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,application/json,.png,.json"
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={onClose}
              title={t.cancel}
              className="ml-2 text-2xl leading-none text-fg-muted hover:text-fg-soft"
            >
              ×
            </button>
          </div>
        </div>

        {importError && (
          <div className="border-b border-danger-bg bg-danger-bg px-7 py-3 text-xs text-danger">
            {importError}
          </div>
        )}

        <div className="flex flex-1 min-h-0">
          <aside className="w-72 shrink-0 overflow-y-auto border-r border-line bg-base scrollbar-thin">
            {sortedCharacters.length === 0 ? (
              <div className="px-5 py-6 text-xs leading-relaxed text-fg-muted">
                {t.characterEmpty}
              </div>
            ) : (
              <ul className="space-y-1 p-3">
                {sortedCharacters.map((c) => {
                  const isActive = activeCharacterId === c.id;
                  const isEditing = editing?.id === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setEditing(c)}
                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
                          isEditing
                            ? 'border-accent-soft bg-accent-soft'
                            : 'border-transparent hover:border-line hover:bg-raised'
                        }`}
                      >
                        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-line bg-base">
                          {c.avatarDataUrl ? (
                            <img
                              src={c.avatarDataUrl}
                              alt={c.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-xs text-fg-dim">
                              {c.name.slice(0, 1) || '?'}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-fg">
                              {c.name || '—'}
                            </span>
                            {isActive && (
                              <span className="shrink-0 rounded-full border border-ok-bg bg-ok-bg px-1.5 py-0.5 text-[10px] font-semibold text-ok">
                                {t.characterEnabled}
                              </span>
                            )}
                          </div>
                          {c.tags.length > 0 && (
                            <div className="truncate text-[11px] text-fg-muted">
                              {c.tags.join(', ')}
                            </div>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <div className="flex-1 overflow-y-auto px-7 py-6 scrollbar-thin">
            {!editing ? (
              <div className="flex h-full items-center justify-center text-sm text-fg-muted">
                {t.characterEmpty}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-4 rounded-2xl border border-line bg-base px-5 py-4">
                  <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-line bg-base">
                    {editing.avatarDataUrl ? (
                      <img
                        src={editing.avatarDataUrl}
                        alt={editing.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-2xl text-fg-dim">
                        {editing.name.slice(0, 1) || '?'}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => avatarInputRef.current?.click()}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-accent hover:text-fg"
                    >
                      {t.characterAvatarChoose}
                    </button>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleAvatarChange}
                      className="hidden"
                    />
                    {editing.avatarDataUrl && (
                      <button
                        type="button"
                        onClick={() => updateField({ avatarDataUrl: null })}
                        className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-danger hover:text-danger"
                      >
                        {t.characterAvatarRemove}
                      </button>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      {characters.some((c) => c.id === editing.id) && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleEnable(editing.id)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                              activeCharacterId === editing.id
                                ? 'border-ok-bg bg-ok-bg text-ok hover:bg-ok-bg'
                                : 'border-line text-fg-soft hover:border-accent hover:text-fg'
                            }`}
                          >
                            {activeCharacterId === editing.id ? t.characterDisable : t.characterEnable}
                          </button>
                          <button
                            type="button"
                            onClick={handleExport}
                            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-accent hover:text-fg"
                          >
                            {t.characterExport}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(editing.id)}
                            className="rounded-lg border border-danger-bg px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:border-danger hover:bg-danger-bg"
                          >
                            {t.characterDelete}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {editing.avatarDataUrl && (
                  <div className="flex items-center justify-between rounded-xl border border-line bg-base px-4 py-3">
                    <span className="text-xs font-medium text-fg-soft">{t.characterShowAvatar}</span>
                    <button
                      type="button"
                      onClick={() => updateField({ showAvatar: !(editing.showAvatar ?? true) })}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                        (editing.showAvatar ?? true) ? 'bg-accent' : 'bg-slate-700'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform ring-0 transition duration-200 ${
                          (editing.showAvatar ?? true) ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-1 rounded-xl border border-line bg-base p-1">
                  {(['basic', 'voice'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setVoiceTab(tab)}
                      className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        voiceTab === tab
                          ? 'bg-accent-soft text-accent-text'
                          : 'text-fg-muted hover:text-fg-soft'
                      }`}
                    >
                      {tab === 'basic' ? t.voiceTabBasic : t.voiceTabVoice}
                    </button>
                  ))}
                </div>

                {voiceTab === 'basic' ? (
                  <div className="space-y-4">
                <FieldRow label={t.characterName}>
                  <input
                    value={editing.name}
                    onChange={(e) => updateField({ name: e.target.value })}
                    placeholder={t.characterNamePlaceholder}
                    className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                  />
                </FieldRow>

                <div className="grid gap-4 xl:grid-cols-2">
                  <FieldRow label={t.characterCreator}>
                    <input
                      value={editing.creator}
                      onChange={(e) => updateField({ creator: e.target.value })}
                      className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
                    />
                  </FieldRow>
                  <FieldRow label={t.characterVersion}>
                    <input
                      value={editing.characterVersion}
                      onChange={(e) => updateField({ characterVersion: e.target.value })}
                      className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
                    />
                  </FieldRow>
                </div>

                <FieldRow label={t.characterTags}>
                  <input
                    value={editing.tags.join(', ')}
                    onChange={(e) =>
                      updateField({
                        tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
                  />
                </FieldRow>

                <FieldRow label={t.characterDescription}>
                  <textarea
                    value={editing.description}
                    onChange={(e) => updateField({ description: e.target.value })}
                    placeholder={t.characterDescriptionPlaceholder}
                    rows={4}
                    className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm leading-relaxed text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                  />
                </FieldRow>

                <FieldRow label={t.characterPersonality}>
                  <textarea
                    value={editing.personality}
                    onChange={(e) => updateField({ personality: e.target.value })}
                    placeholder={t.characterPersonalityPlaceholder}
                    rows={3}
                    className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm leading-relaxed text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                  />
                </FieldRow>

                <FieldRow label={t.characterScenario}>
                  <textarea
                    value={editing.scenario}
                    onChange={(e) => updateField({ scenario: e.target.value })}
                    placeholder={t.characterScenarioPlaceholder}
                    rows={3}
                    className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm leading-relaxed text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                  />
                </FieldRow>

                <FieldRow label={t.characterFirstMessage}>
                  <textarea
                    value={editing.firstMessage}
                    onChange={(e) => updateField({ firstMessage: e.target.value })}
                    placeholder={t.characterFirstMessagePlaceholder}
                    rows={3}
                    className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm leading-relaxed text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                  />
                </FieldRow>

                <FieldRow label={t.characterExampleMessages}>
                  <textarea
                    value={editing.exampleMessages}
                    onChange={(e) => updateField({ exampleMessages: e.target.value })}
                    placeholder={t.characterExampleMessagesPlaceholder}
                    rows={4}
                    className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm leading-relaxed text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                  />
                </FieldRow>

                <FieldRow label={t.characterSystemPrompt}>
                  <textarea
                    value={editing.systemPrompt}
                    onChange={(e) => updateField({ systemPrompt: e.target.value })}
                    placeholder={t.characterSystemPromptPlaceholder}
                    rows={3}
                    className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm leading-relaxed text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                  />
                </FieldRow>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Hero info card explaining how voice cloning works */}
                <div className="rounded-2xl border border-accent-soft bg-accent-soft px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div className="text-accent-text text-xl leading-none">{'\u{1F50A}'}</div>
                    <div className="text-xs leading-relaxed text-fg-soft space-y-1.5">
                      <p className="text-sm font-medium text-fg">{t.voiceHowItWorks}</p>
                      <p>{t.voiceUsageStep1}</p>
                      <p>{t.voiceUsageStep2}</p>
                      <p>{t.voiceUsageStep3}</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-2xl border border-line bg-base px-5 py-3">
                  <div>
                    <div className="text-sm font-medium text-fg">{t.voiceEnabled}</div>
                    <div className="mt-0.5 text-xs text-fg-muted">{t.voiceEnabledDesc}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateVoiceField({ enabled: !editing?.voice?.enabled })}
                    className={`relative inline-flex h-6 w-10 items-center rounded-full transition-colors ${
                      editing?.voice?.enabled ? 'bg-accent' : 'bg-slate-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                        editing?.voice?.enabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>

                <FieldRow label={t.voiceEngine}>
                  <div className="flex gap-2">
                    {(['gpt-sovits'] as const).map((engine) => (
                      <button
                        key={engine}
                        type="button"
                        onClick={() => updateVoiceField({ engine })}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          (editing?.voice?.engine ?? 'gpt-sovits') === engine
                            ? 'border-accent-soft bg-accent-soft text-accent-text'
                            : 'border-line text-fg-muted hover:text-fg'
                        }`}
                      >
                        {engine === 'gpt-sovits' ? t.voiceEngineGptSovits : engine}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-fg-muted">
                    {t.voiceEngineGptSovitsHint}
                  </p>
                </FieldRow>

                {(editing?.voice?.engine ?? 'gpt-sovits') === 'gpt-sovits' && (
                  <FieldRow label={t.voiceSampleSteps}>
                    <div className="flex items-center gap-2">
                      {[4, 8, 16].map((steps) => {
                        const current = editing?.voice?.sampleSteps ?? 8;
                        const active = current === steps;
                        const labels: Record<number, string> = {
                          4: t.voiceSampleStepsFastest,
                          8: t.voiceSampleStepsBalanced,
                          16: t.voiceSampleStepsHighest,
                        };
                        return (
                          <button
                            key={steps}
                            type="button"
                            onClick={() => updateVoiceField({ sampleSteps: steps })}
                            className={`flex-1 rounded-lg border px-2 py-1.5 text-center text-xs transition-colors ${
                              active
                                ? 'border-accent-soft bg-accent-soft text-accent-text'
                                : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                            }`}
                          >
                            <div>{steps}</div>
                            <div className="text-[10px] opacity-70">{labels[steps]}</div>
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[11px] text-fg-muted">{t.voiceSampleStepsHint}</p>
                  </FieldRow>
                )}

                {(editing?.voice?.engine ?? 'gpt-sovits') === 'gpt-sovits' && (
                  <FieldRow label={t.voiceChunkSize}>
                    <div className="flex items-center gap-2">
                      {[1, 2, 3, 4, 5].map((n) => {
                        const current = editing?.voice?.sentencesPerChunk ?? 3;
                        const active = current === n;
                        return (
                          <button
                            key={n}
                            type="button"
                            onClick={() => updateVoiceField({ sentencesPerChunk: n })}
                            className={`flex-1 rounded-lg border px-2 py-1.5 text-center text-xs transition-colors ${
                              active
                                ? 'border-accent-soft bg-accent-soft text-accent-text'
                                : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                            }`}
                          >
                            {n}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[11px] text-fg-muted">{t.voiceChunkSizeHint}</p>
                  </FieldRow>
                )}

                <FieldRow label={t.voiceSpeed}>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="50"
                      max="200"
                      value={((editing?.voice?.speed ?? 1) * 100) | 0}
                      onChange={(e) => updateVoiceField({ speed: Number(e.target.value) / 100 })}
                      className="flex-1 accent-accent"
                    />
                    <span className="w-12 text-right text-xs font-medium text-fg-soft">
                      {((editing?.voice?.speed ?? 1) * 100) | 0}%
                    </span>
                  </div>
                </FieldRow>

                {(editing?.voice?.engine ?? 'gpt-sovits') === 'gpt-sovits' && (
                  <div className="rounded-2xl border border-line bg-base px-5 py-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-fg">{t.voiceWarmupTitle}</div>
                        <div className="mt-0.5 text-xs text-fg-muted">{t.voiceWarmupHint}</div>
                        {warmupResult !== 'idle' && (
                          <div className={`mt-1 text-[11px] ${warmupResult === 'success' ? 'text-ok' : 'text-danger'}`}>
                            {warmupResult === 'success' ? t.voiceWarmupSuccess : (warmupError || t.voiceWarmupFailed)}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={warmupRunning}
                        onClick={async () => {
                          setWarmupRunning(true);
                          setWarmupResult('idle');
                          setWarmupError(null);
                          try {
                            const running = await invoke<boolean>('tts_server_status').catch(() => false);
                            if (!running) {
                              throw new Error(t.voiceWarmupServerNotRunning);
                            }
                            const refPath = editing?.voice?.referenceSamplePath;
                            if (!refPath) {
                              throw new Error(t.voiceWarmupNoRefAudio);
                            }
                            const wmPromptLang = editing?.voice?.referenceTextLanguage || 'zh';
                            await invoke('tts_warmup_gpu', {
                              refAudioPath: refPath,
                              promptText: editing?.voice?.referenceText ?? '',
                              promptLanguage: wmPromptLang,
                            });
                            setWarmupResult('success');
                          } catch (e) {
                            setWarmupResult('error');
                            setWarmupError(String(e));
                          } finally {
                            setWarmupRunning(false);
                          }
                        }}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          warmupRunning
                            ? 'border-slate-500/30 bg-slate-500/10 text-fg-muted cursor-not-allowed'
                            : 'border-warn-bg bg-warn-bg text-warn hover:bg-warn-bg'
                        }`}
                      >
                        {warmupRunning ? '\u23F3 ' + t.voiceWarmupRunning : t.voiceWarmupButton}
                      </button>
                    </div>
                  </div>
                )}

                {(editing?.voice?.engine ?? 'gpt-sovits') === 'gpt-sovits' && (
                  <div className="rounded-2xl border border-line bg-base px-5 py-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="text-sm font-medium text-fg">{t.voiceFinetuneTitle}</div>
                        <div className="mt-0.5 text-xs text-fg-muted">{t.voiceFinetuneGenerateHint}</div>
                      </div>
                    </div>

                    {finetuneDone ? (
                      <div className="space-y-2">
                        <div className="text-xs text-ok font-medium">{t.voiceFinetuneDone}</div>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <button
                            type="button"
                            onClick={() => updateVoiceField({ useFineTuned: !(editing?.voice?.useFineTuned ?? true) })}
                            className={`relative w-8 h-4 rounded-full transition-colors ${
                              (editing?.voice?.useFineTuned ?? true) ? 'bg-ok' : 'bg-slate-600'
                            }`}
                          >
                            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                              (editing?.voice?.useFineTuned ?? true) ? 'translate-x-4.5' : 'translate-x-0.5'
                            }`} />
                          </button>
                          <span className="text-[10px] text-fg-muted">{t.voiceFinetuneUseModel}</span>
                        </label>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => { setFinetuneDone(false); setGenerateDone(false); setGenerateError(''); }}
                            className="rounded-lg border border-warn-bg bg-warn-bg px-2.5 py-1 text-[10px] text-warn hover:bg-warn-bg transition-colors"
                          >
                            {t.voiceFinetuneRetrain}
                          </button>
                        </div>
                      </div>
                    ) : finetuneRunning ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                          <span className="text-xs text-accent-text font-medium">
                            {finetuneStep === 'preprocess' ? t.voiceFinetunePreprocessStatus : finetuneStep === 'train' ? t.voiceFinetuneTrainStatus : t.voiceFinetunePreparingStatus}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-base overflow-hidden">
                            <div
                              className="h-full rounded-full bg-accent transition-all duration-500"
                              style={{ width: `${Math.max(finetuneProgress, 2)}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-fg-muted tabular-nums">{finetuneProgress}%</span>
                        </div>
                        {finetuneLog && (
                          <p className="text-[10px] text-fg-muted leading-tight truncate">{finetuneLog}</p>
                        )}
                        <p className="text-[10px] text-fg-muted">{t.voiceFinetuneTrainingHint}</p>
                        <button
                          type="button"
                          onClick={async () => {
                            await invoke('tts_finetune_cancel');
                            setFinetuneRunning(false);
                          }}
                          className="rounded-lg border border-danger-bg bg-danger-bg px-2.5 py-1 text-[10px] text-danger hover:bg-danger-bg transition-colors"
                        >
                          {t.voiceFinetuneCancel}
                        </button>
                      </div>
                    ) : generateRunning ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                          <span className="text-xs text-fg-soft">{t.voiceFinetuneGenerating}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-base overflow-hidden">
                            <div
                              className="h-full rounded-full bg-accent transition-all duration-300"
                              style={{ width: `${generateTotal > 0 ? (generateCurrent / generateTotal) * 100 : 4}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-fg-muted tabular-nums whitespace-nowrap">
                            {generateCurrent}/{generateTotal}
                          </span>
                        </div>
                        {generateSentence && (
                          <p className="text-[10px] text-fg-muted leading-tight truncate">{generateSentence}</p>
                        )}
                      </div>
                    ) : generateDone ? (
                      <div className="space-y-2">
                        <p className="text-[10px] text-ok">{t.voiceFinetuneGenerateDone}</p>
                        <p className="text-[10px] text-fg-muted">{t.voiceFinetuneGeneratedCount.replace('{{count}}', String(generateTotal))}</p>
                        {generateFailedCount > 0 && (
                          <p className="text-[10px] text-warn">失败 {generateFailedCount} 句（共 {generateTotal + generateFailedCount} 句，成功 {generateTotal} 句）</p>
                        )}
                        <button
                          type="button"
                          onClick={async () => {
                            if (!editing) return;
                            setFinetuneRunning(true);
                            setFinetuneProgress(0);
                            setFinetuneLog('');
                            setFinetuneStep('');
                            setGenerateDone(false);
                            try {
                              await invoke('tts_finetune_start', {
                                characterId: editing.id,
                                trainAudioDir: generatedTrainDir || `voices/${editing.id}/train`,
                              });
                            } catch (e) {
                              setFinetuneRunning(false);
                              setFinetuneLog(String(e));
                            }
                          }}
                          className="rounded-lg border border-ok-bg bg-ok-bg px-3 py-1.5 text-xs text-ok hover:bg-ok-bg transition-colors"
                        >
                          {t.voiceFinetuneStartTraining}
                        </button>
                      </div>
                    ) : scriptGenerating ? (
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-warn animate-pulse" />
                        <span className="text-xs text-warn">{t.voiceFinetuneScriptGenerating}</span>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {generateError && (
                          <p className="text-[10px] text-danger">{generateError}</p>
                        )}
                        {trainingDataExists && (
                          <p className="text-[10px] text-fg-muted">{t.voiceFinetuneDataExistsHint}</p>
                        )}
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-fg-muted whitespace-nowrap">{t.voiceFinetuneTrainingLanguage}</label>
                          <select
                            value={editing?.voice?.trainingLanguage || 'all_zh'}
                            onChange={(e) => updateVoiceField({ trainingLanguage: e.target.value })}
                            className="text-[10px] bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-fg-soft"
                          >
                            <option value="all_zh">简体中文</option>
                            <option value="all_yue">粤语（广东话）</option>
                            <option value="en">English</option>
                            <option value="all_ja">日本語</option>
                            <option value="all_ko">한국어</option>
                            <option value="zh">中英混合</option>
                            <option value="ja">日英混合</option>
                            <option value="auto">多语种混合</option>
                          </select>
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={async () => {
                              if (!editing?.voice?.referenceSamplePath) return;
                              if (!editing?.voice?.referenceText?.trim()) {
                                setGenerateError('请先配置参考音频对应的文本');
                                return;
                              }
                              const textLang = editing?.voice?.trainingLanguage || 'all_zh';
                              const promptLang = editing?.voice?.referenceTextLanguage || 'zh';
                              setScriptGenerating(true);
                              try {
                                const script = await generateTrainingScript(textLang);
                                if (!script?.trim() || script.trim().length < 50) throw new Error('Script generation returned empty or too short');
                                setScriptGenerating(false);
                                setGenerateRunning(true);
                                setGenerateDone(false);
                                setGenerateCurrent(0);
                                setGenerateTotal(0);
                                setGenerateSentence('');
                                setGeneratedTrainDir('');
                                setGenerateError('');
                                try {
                                  await invoke('tts_generate_training_data', {
                                    characterId: editing.id,
                                    refAudioPath: editing.voice.referenceSamplePath,
                                    promptText: editing.voice.referenceText ?? '',
                                    promptLanguage: promptLang,
                                    trainingLanguage: textLang,
                                    customScript: script,
                                    force: true,
                                  });
                                } catch (e) {
                                  setGenerateRunning(false);
                                  setGenerateError(String(e));
                                }
                              } catch (e) {
                                setScriptGenerating(false);
                                setGenerateError(String(e));
                                console.error('Script generation failed:', e);
                              }
                            }}
                            disabled={scriptGenerating}
                            className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                              scriptGenerating
                                ? 'border-slate-500/30 bg-slate-500/10 text-fg-muted cursor-not-allowed'
                                : 'border-accent-soft bg-accent-soft text-accent-text hover:bg-accent-soft'
                            }`}
                          >
                            {trainingDataExists ? t.voiceFinetuneRegenerate : t.voiceFinetuneGenerate}
                          </button>
                          {trainingDataExists && (
                            <button
                              type="button"
                              onClick={async () => {
                                if (!editing) return;
                                setFinetuneRunning(true);
                                setFinetuneProgress(0);
                                setFinetuneLog('');
                                setFinetuneStep('');
                                try {
                              await invoke('tts_finetune_start', {
                                characterId: editing.id,
                                trainAudioDir: generatedTrainDir || `voices/${editing.id}/train`,
                                  });
                                } catch (e) {
                                  setFinetuneRunning(false);
                                  setFinetuneLog(String(e));
                                }
                              }}
                              className="rounded-lg border border-ok-bg bg-ok-bg px-3 py-1.5 text-xs text-ok hover:bg-ok-bg transition-colors"
                            >
                              {t.voiceFinetuneStartTraining}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {(editing?.voice?.engine ?? 'gpt-sovits') === 'gpt-sovits' && (
                  <>
                    <FieldRow label={t.voiceSampleRef}>
                      <div className="rounded-xl border border-line bg-base p-4 space-y-3">
                        <ul className="text-[11px] leading-relaxed text-fg-muted space-y-1 list-disc pl-4">
                          <li>{t.voiceSampleSpec1}</li>
                          <li>{t.voiceSampleSpec2}</li>
                          <li>{t.voiceSampleSpec3}</li>
                          <li>{t.voiceSampleSpec4}</li>
                        </ul>

                        {editing?.voice?.referenceSamplePath && (
                          <div className="space-y-2 rounded-lg border border-ok-bg bg-ok-bg p-3">
                            <div className="flex items-center gap-2 text-[11px] text-ok">
                              <span>{'\u2713'}</span>
                              <span className="font-medium">{t.voiceSampleLoaded}</span>
                            </div>
                            {voicePreviewUrl && (
                              <audio controls src={voicePreviewUrl} onError={() => {}} className="w-full h-8" />
                            )}
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => updateVoiceField({ referenceSamplePath: undefined, referenceText: '' })}
                                className="rounded-lg border border-danger-bg px-2.5 py-1 text-[11px] font-medium text-danger hover:border-danger"
                              >
                                {t.voiceSampleRemove}
                              </button>
                              <button
                                type="button"
                                onClick={() => { void handleTestVoice(); }}
                                disabled={testVoicePlaying}
                                className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                  testVoicePlaying
                                    ? 'border-slate-500/30 bg-slate-500/10 text-fg-muted cursor-not-allowed'
                                    : 'border-accent-soft bg-accent-soft text-accent-text hover:bg-accent-soft'
                                }`}
                              >
                                {testVoicePlaying ? (settings.lang === 'en' ? 'Playing...' : '播放中...') : t.voiceTest}
                              </button>
                              {testVoiceError && (
                                <button
                                  type="button"
                                  onClick={() => setTestVoiceError(null)}
                                  className="text-[10px] text-danger hover:text-danger max-w-[200px] truncate"
                                  title={testVoiceError}
                                >
                                  {testVoiceError.length > 40 ? testVoiceError.slice(0, 40) + '...' : testVoiceError}
                                </button>
                              )}
                            </div>
                          </div>
                        )}

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => voiceSampleInputRef.current?.click()}
                            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-accent hover:text-fg"
                          >
                            {editing?.voice?.referenceSamplePath ? t.voiceSampleReplace : t.voiceSampleUpload}
                          </button>
                          <input
                            ref={voiceSampleInputRef}
                            type="file"
                            accept="audio/wav,audio/mpeg,audio/mp3,audio/x-wav,audio/aac,audio/x-m4a"
                            onChange={handleVoiceSampleChange}
                            className="hidden"
                          />
                        </div>
                      </div>
                    </FieldRow>

                    {editing?.voice?.referenceSamplePath && (
                      <FieldRow label={t.voiceReferenceText}>
                        <textarea
                          value={editing?.voice?.referenceText ?? ''}
                          onChange={(e) => updateVoiceField({ referenceText: e.target.value })}
                          placeholder={t.voiceReferenceTextPlaceholder}
                          rows={2}
                          className="w-full rounded-xl border border-line bg-base px-4 py-3 text-sm leading-relaxed text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                        />
                        <p className="mt-1 text-[11px] text-fg-muted">{t.voiceReferenceTextHint}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <label className="text-[10px] text-fg-muted whitespace-nowrap">参考音频语言</label>
                          <select
                            value={editing?.voice?.referenceTextLanguage || 'zh'}
                            onChange={(e) => {
                              const newRefLang = e.target.value;
                              const oldRefLang = editing?.voice?.referenceTextLanguage || 'zh';
                              const currentTextLang = editing?.voice?.textLanguage;
                              // Auto-sync textLanguage IFF it was following the old reference language
                              // (i.e. user never explicitly set a different textLanguage).
                              if (!currentTextLang || currentTextLang === oldRefLang) {
                                updateVoiceField({ referenceTextLanguage: newRefLang, textLanguage: newRefLang });
                              } else {
                                updateVoiceField({ referenceTextLanguage: newRefLang });
                              }
                            }}
                            className="text-[10px] bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-fg-soft"
                          >
                            <option value="all_zh">中文</option>
                            <option value="all_yue">粤语</option>
                            <option value="en">English</option>
                            <option value="all_ja">日本語</option>
                            <option value="all_ko">한국어</option>
                          </select>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <label className="text-[10px] text-fg-muted whitespace-nowrap">说话语言</label>
                          <select
                            value={editing?.voice?.textLanguage || editing?.voice?.referenceTextLanguage || 'zh'}
                            onChange={(e) => updateVoiceField({ textLanguage: e.target.value })}
                            className="text-[10px] bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-fg-soft"
                          >
                            <option value="all_zh">中文</option>
                            <option value="all_yue">粤语</option>
                            <option value="en">English</option>
                            <option value="all_ja">日本語</option>
                            <option value="all_ko">한국어</option>
                            <option value="zh">中英混合</option>
                            <option value="ja">日英混合</option>
                            <option value="auto">多语种自动</option>
                          </select>
                        </div>
                      </FieldRow>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-line px-7 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-line px-4 py-2 text-sm font-medium text-fg-soft transition-colors hover:border-line-strong hover:text-fg"
          >
            {t.characterCancel}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!editing || !editing.name.trim()}
            className="rounded-xl border border-accent-soft bg-accent-soft px-4 py-2 text-sm font-medium text-accent-text transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t.characterSave}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
