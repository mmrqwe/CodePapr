import {
  memo,
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
  KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type ChangeEvent,
} from 'react';
import {
  getSettingsError,
  useAgentStore,
  type ImagePreview,
  type SessionInputState,
  type TextFileAttachment,
} from '../store/agentStore';
import { GoalBanner } from './GoalBanner';
import type { IImageContent } from '@codepapr/types';
import { isLocalSlashCommand, parseSlashInput } from '@codepapr/core';
import { type WorkMode } from '../utils/agentPrompts';
import { getTranslation } from '../utils/i18n';
import { useTtsPlayer } from '../hooks/useTtsPlayer';
import { TtsStatusBadge } from './TtsPanel';
import { TtsInstaller } from './TtsInstaller';
import { useCharactersStore } from '../store/charactersStore';
import { maybeInsertActiveCharacterGreeting } from '../utils/characterGreeting';
import { resolveCharacterInteractionMode } from '../utils/characterTypes';
import {
  isScrollContainerNearBottom,
  scrollContainerToBottom,
} from '../utils/chatScroll';
import {
  clampWindow,
  computeInitialWindow,
  computeRoundStartIndices,
  computeWindowForJump,
  computeWindowForViewport,
  estimateMessageHeight,
  findMessageIndexAtOffset,
  findRoundIndexAtMessageIndex,
  slideWindowDown,
  slideWindowUp,
  windowMessageBounds,
  type RoundWindow,
} from '../utils/messageWindow';
import SlashCommandDropdown, {
  type SlashCommandDropdownHandle,
} from './SlashCommandDropdown';
import AtMentionDropdown, {
  type AtMentionDropdownHandle,
  type MentionItem,
  buildMentionItems,
} from './AtMentionDropdown';
import { useShallow } from 'zustand/react/shallow';
import { subscribeSubagentProgress, getSubagentRunsForSession, toggleSubagentCollapse } from '../utils/subagentProgress';
import { ConversationRoundsIndicator } from './ConversationRoundsIndicator';
import { toast } from '../store/toastStore';
import type { PlanFollowUpAction } from '../utils/planMode';
import { buildTailExecutionProcessGroup } from './chat/ExecutionProcessPanel';
import { MessageList } from './chat/MessageList';
import { ModeSelector } from './chat/ModeSelector';
import { ChatInputTextarea } from './chat/ChatInputTextarea';
import {
  buildUserPromptWithFiles,
  collectDataTransferFiles,
  formatBytesAsMbLabel,
  looksLikeBinaryText,
  partitionIncomingFiles,
  resolveComposerFilters,
  DEFAULT_SESSION_INPUT,
  MAX_IMAGE_BYTES,
  MAX_PENDING_FILES,
  MAX_PENDING_IMAGES,
  MAX_TEXT_FILE_BYTES,
  NO_PENDING_FILES,
  NO_PENDING_IMAGES,
  readFileAsImagePreview,
} from './chat/utils';

function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

interface ChatPanelProps {
  onOpenWorkspacePath?: (path: string) => void;
  onOpenProjectSwitcher?: () => void;
  onOpenProjectConfig?: () => void;
  /** 为 true 时暂缓渲染对话内容（如 ProjectGraph 初始化全屏遮罩期间），
   *  待界面稳定后再渲染并定位，避免加载期布局未定导致滚动错位。 */
  deferMessages?: boolean;
}
export const ChatPanel = memo(function ChatPanel({ onOpenWorkspacePath, onOpenProjectSwitcher, onOpenProjectConfig, deferMessages = false }: ChatPanelProps) {
  const {
    messages,
    isLoading,
    loadingSessionId,
    sendMessage,
    cancelMessage,
    activeSessionId,
    settings,
    setShowSettings,
    workspacePath,
    refreshProjectDiagnostics,
    _taskChecklists,
    resetToMessage,
    messageCheckpoints,
    gitReady,
    gitReadyError,
    checkpointError,
    persistenceError,
    _agentDefinitions,
    _skillDefinitions,
    mentorEnabled,
    sessionMessagesLoading,
    messageLoadFailedSessions,
    retryLoadSessionMessages,
  } = useAgentStore(
    useShallow((state) => ({
      messages: state.messages,
      isLoading: state.isLoading,
      loadingSessionId: state.loadingSessionId,
      sendMessage: state.sendMessage,
      cancelMessage: state.cancelMessage,
      activeSessionId: state.activeSessionId,
      settings: state.settings,
      setShowSettings: state.setShowSettings,
      workspacePath: state.workspacePath,
      refreshProjectDiagnostics: state.refreshProjectDiagnostics,
      _taskChecklists: state._taskChecklists,
      resetToMessage: state.resetToMessage,
      messageCheckpoints: state._messageCheckpoints,
      gitReady: state._gitReady,
      gitReadyError: state._gitReadyError,
      checkpointError: state._checkpointError,
      persistenceError: state._persistenceError,
      _agentDefinitions: state._agentDefinitions,
      _skillDefinitions: state._skillDefinitions,
      mentorEnabled: state.settings.mentorEnabled ?? true,
      sessionMessagesLoading: state.sessionMessagesLoading,
      messageLoadFailedSessions: state._messageLoadFailedSessions,
      retryLoadSessionMessages: state.retryLoadSessionMessages,
    }))
  );
  // 输入框状态（模式/草稿/附件）按会话存取：切换会话自动换到对应会话的状态，
  // 互不串扰；组件卸载（如切到代码预览 tab）也不丢失。
  // 无活动会话时（空项目/会话全部删除）回退到组件本地状态，保证不必先点
  // 「新对话」也能输入发送——sendMessage 会在发送时自动创建会话。
  const sessionInputMap = useAgentStore((state) => state._sessionInputState);
  const [fallbackInput, setFallbackInput] = useState<SessionInputState>(DEFAULT_SESSION_INPUT);
  const sessionInputState = activeSessionId ? sessionInputMap[activeSessionId] : fallbackInput;
  const input = sessionInputState?.draft ?? '';
  const pendingImages = sessionInputState?.images ?? NO_PENDING_IMAGES;
  const pendingFiles = sessionInputState?.files ?? NO_PENDING_FILES;
  const mode = sessionInputState?.mode ?? 'agent';

  useEffect(() => {
    if (activeSessionId) {
      setFallbackInput(DEFAULT_SESSION_INPUT);
    }
  }, [activeSessionId]);

  const updateSessionInput = useCallback(
    (updater: (state: SessionInputState) => SessionInputState) => {
      const {
        activeSessionId: sid,
        _sessionInputState: map,
        setSessionInputState: apply,
      } = useAgentStore.getState();
      if (!sid) {
        setFallbackInput(updater);
        return;
      }
      apply(sid, updater(map[sid] ?? DEFAULT_SESSION_INPUT));
    },
    []
  );
  const setInput = useCallback(
    (v: string | ((prev: string) => string)) =>
      updateSessionInput((st) => ({ ...st, draft: typeof v === 'function' ? v(st.draft) : v })),
    [updateSessionInput]
  );
  const setPendingImages = useCallback(
    (v: ImagePreview[] | ((prev: ImagePreview[]) => ImagePreview[])) =>
      updateSessionInput((st) => ({ ...st, images: typeof v === 'function' ? v(st.images) : v })),
    [updateSessionInput]
  );
  const setPendingFiles = useCallback(
    (v: TextFileAttachment[] | ((prev: TextFileAttachment[]) => TextFileAttachment[])) =>
      updateSessionInput((st) => ({ ...st, files: typeof v === 'function' ? v(st.files) : v })),
    [updateSessionInput]
  );
  const setMode = useCallback(
    (v: WorkMode | ((prev: WorkMode) => WorkMode)) =>
      updateSessionInput((st) => ({ ...st, mode: typeof v === 'function' ? v(st.mode) : v })),
    [updateSessionInput]
  );

  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const onPreviewImage = useCallback((src: string) => setPreviewImage(src), []);

  const sessionLock = useMemo<'app' | 'coding' | null>(() => {
    // 会话锁只取决于第一条可见用户消息：find 短路即可，无需全量 filter
    // （流式合批时本 memo 每帧重算，长会话下 filter 是纯浪费）。
    const firstUserMessage = messages.find(
      (m) => m.role === 'user' && !m.synthetic && !m.hidden
    );
    if (!firstUserMessage) return null;
    return firstUserMessage.workMode === 'app' ? 'app' : 'coding';
  }, [messages]);

  useEffect(() => {
    // 仅强制会话级模式约束；空会话的默认模式由 _sessionInputState 兜底，
    // 不在此重置，否则会覆盖用户为该会话记住的模式。
    if (sessionLock === 'app') {
      setMode('app');
    } else if (sessionLock === 'coding') {
      setMode((current) => (current === 'app' ? 'agent' : current));
    }
  }, [sessionLock, setMode]);

  useEffect(() => {
    useAgentStore.setState({ _currentMode: mode });
  }, [mode]);

  // 按当前会话在渲染时派生，不能放进 useState + useEffect：ChatPanel 不随
  // 新会话卸载，effect 要等绘制之后才过滤，空对话欢迎页会顶着上一会话的
  // 「Mentor 思考完成」。进度变更只用来触发重渲染。
  const [, setSubagentProgressEpoch] = useState(0);
  useEffect(() => {
    return subscribeSubagentProgress(() => {
      setSubagentProgressEpoch((epoch) => epoch + 1);
    });
  }, []);
  const subagentRuns = getSubagentRunsForSession(activeSessionId);
  const [resetConfirmMsgId, setResetConfirmMsgId] = useState<string | null>(null);
  const [resetInFlight, setResetInFlight] = useState(false);
  const [retryMessagesLoading, setRetryMessagesLoading] = useState(false);
  const [resetBanner, setResetBanner] = useState<{ kind: 'success' | 'warn' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (!resetBanner) return;
    const timer = window.setTimeout(() => setResetBanner(null), 3000);
    return () => window.clearTimeout(timer);
  }, [resetBanner]);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const slashDropdownRef = useRef<SlashCommandDropdownHandle | null>(null);
  const [atFilter, setAtFilter] = useState<string | null>(null);
  const atTriggerIndexRef = useRef<number>(-1);
  const atDropdownRef = useRef<AtMentionDropdownHandle | null>(null);
  const inputWrapperRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageListContentRef = useRef<HTMLDivElement | null>(null);
  const lastVisibleMessageIdRef = useRef<string | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const hasStreamingMessageRef = useRef(false);
  const isProgrammaticScrollRef = useRef(false);
  const isComposingRef = useRef(false);
  const handleIncomingFilesRef = useRef<(files: File[]) => Promise<void>>(async () => {});
  const handlePrimaryActionRef = useRef<() => Promise<void>>(async () => {});
  const slashFilterRef = useRef<string | null>(null);
  const atFilterRef = useRef<string | null>(null);

  // isLoading 是全局「任一会话在执行」（单执行模型）；isActiveLoading 才是
  // 当前查看会话自身的执行状态，输入框/按钮等 UI 一律按它对齐。
  const isActiveLoading = isLoading && loadingSessionId !== null && loadingSessionId === activeSessionId;
  const otherSessionRunning = isLoading && !isActiveLoading;
  // N16：当前会话历史加载失败的可见提示（此前无任何 UI 消费者，空白会话无提示）。
  const sessionMessagesLoadFailed =
    activeSessionId !== null && messageLoadFailedSessions[activeSessionId] === true;

  useLayoutEffect(() => {
    if (isActiveLoading) {
      shouldStickToBottomRef.current = true;
    }
  }, [isActiveLoading]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const settingsError = getSettingsError(settings);
  const isConfigured = !settingsError;
  // Block sending while the session's history is still loading on demand —
  // submitting early would build context from an incomplete message list.
  // 全局 isLoading 阻断发送：单执行模型下任一会话执行中都不允许开启新回合。
  // 本地 slash（/help /commands /compact）零 token，回合中仍可执行。
  const localSlashReady = (() => {
    const slash = parseSlashInput(input.trim());
    return Boolean(slash && isLocalSlashCommand(slash.name));
  })();
  const canSubmit = (!!input.trim() || pendingImages.length > 0 || pendingFiles.length > 0)
    && (!isLoading || localSlashReady)
    && !sessionMessagesLoading;
  const visibleMessages = useMemo(
    () => messages.filter((message) => !message.hidden && !(message.synthetic && message.carryForwardInContext)),
    [messages]
  );
  const tailExecutionProcessGroup = useMemo(
    () => buildTailExecutionProcessGroup(visibleMessages),
    [visibleMessages]
  );
  const hasStreamingMessage = useMemo(
    () => visibleMessages.some(
      (message) => message.role === 'assistant' && message.isStreaming
    ),
    [visibleMessages]
  );
  hasStreamingMessageRef.current = hasStreamingMessage;
  const tailMessageId = useMemo(
    () => visibleMessages[visibleMessages.length - 1]?.id ?? null,
    [visibleMessages]
  );
  const streamingMessage = useMemo(
    () => visibleMessages.find(
      (message) => message.role === 'assistant' && message.isStreaming
    ),
    [visibleMessages]
  );
  const t = getTranslation(settings.lang);
  const { feedStream: ttsFeedStream, stop: ttsStop, skip: ttsSkip, isPlaying: ttsIsPlaying, lastError: ttsError, clearError: ttsClearError, serverStatus: ttsServerStatus, serverModelVersion: ttsServerModelVersion, serverHalfPrecision: ttsServerHalfPrecision, serverDevice: ttsServerDevice, installed: ttsInstalled, refreshInstalled: ttsRefreshInstalled, startServer: ttsStartServer, replayText: ttsReplayText, setVoiceConfig: ttsSetVoiceConfig, setTextLanguage: ttsSetTextLanguage, setVoiceModel: ttsSetVoiceModel, setFineTunedModel: ttsSetFineTunedModel, preloadModel: ttsPreloadModel, setPlaybackMode: ttsSetPlaybackMode, setSampleSteps: ttsSetSampleSteps, setSpeed: ttsSetSpeed, setSentencesPerChunk: ttsSetSentencesPerChunk, setInteractionMode: ttsSetInteractionMode, volume: ttsVolume, setVolume: ttsSetVolume, serverLog: ttsServerLog, clearServerLog: ttsClearServerLog } = useTtsPlayer();
  const [showInstaller, setShowInstaller] = useState(false);
  const [ttsStarting, setTtsStarting] = useState(false);
  const ttsStartingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showTtsLog, setShowTtsLog] = useState(false);
  const prevFtPathRef = useRef('');

  useEffect(() => {
    return () => {
      if (ttsStartingTimeoutRef.current) {
        clearTimeout(ttsStartingTimeoutRef.current);
      }
    };
  }, []);

  const handleTtsClick = useCallback(async () => {
    // If a start is already in progress, do nothing — the backend has its
    // own re-entrancy guard and clicking again would just be wasted noise.
    if (ttsServerStatus === 'starting' || ttsStarting) {
      return;
    }
    if (ttsServerStatus === 'running') {
      // Playing: stop speech. Idle: toggle the server log.
      if (ttsIsPlaying) {
        ttsStop();
        return;
      }
      setShowTtsLog(!showTtsLog);
      return;
    }

    // Re-check installation; if missing, open the installer instead.
    const status = await ttsRefreshInstalled();
    const isInstalled = status?.installed === true;
    if (!isInstalled) {
      setShowInstaller(true);
      return;
    }

    // Installed and not currently starting → kick off a start.
    setTtsStarting(true);
    // 从 store 现取角色：此回调被 useCallback 记忆化，闭包里的 activeCharacter
    // 会停留在创建时的渲染（切换角色后用旧的 fineTunedModelPath 启动服务器）。
    const store = useCharactersStore.getState();
    const character = store.characters.find((c) => c.id === store.activeCharacterId) ?? null;
    const ftPath = character?.voice?.useFineTuned !== false && character?.voice?.fineTunedModelPath
      ? character.voice.fineTunedModelPath
      : '';
    ttsStartServer('v4', ftPath);
    // Safety: clear the "starting" UI flag eventually so the button isn't
    // permanently disabled if events get lost. The `starting` server status
    // owned by the hook is the source of truth for status display.
    if (ttsStartingTimeoutRef.current) {
      clearTimeout(ttsStartingTimeoutRef.current);
    }
    ttsStartingTimeoutRef.current = setTimeout(() => {
      setTtsStarting(false);
      ttsStartingTimeoutRef.current = null;
    }, 120_000);
  }, [ttsRefreshInstalled, ttsServerStatus, ttsStartServer, ttsStarting, showTtsLog, ttsIsPlaying, ttsStop]);

  // Clear the local "starting" flag whenever the hook reports a terminal state.
  useEffect(() => {
    if (ttsServerStatus === 'running' || ttsServerStatus === 'error' || ttsServerStatus === 'stopped') {
      if (ttsStartingTimeoutRef.current) {
        clearTimeout(ttsStartingTimeoutRef.current);
        ttsStartingTimeoutRef.current = null;
      }
      setTtsStarting(false);
    }
  }, [ttsServerStatus]);

  // Warn the user when the server is running with suboptimal settings:
  // - Not v4 model (v1 is extremely slow for Japanese/mixed text)
  // - Not MPS on Apple Silicon (CPU is 5-10x slower)
  // - Not using half precision (2x slower)
  const ttsWarningShownRef = useRef(false);
  useEffect(() => {
    if (ttsServerStatus !== 'running') {
      ttsWarningShownRef.current = false;
      return;
    }
    if (ttsWarningShownRef.current) return;
    ttsWarningShownRef.current = true;

    const warnings: string[] = [];
    if (ttsServerModelVersion && ttsServerModelVersion !== 'v4') {
      warnings.push(t.ttsWarnModelVersion.replace('{{version}}', ttsServerModelVersion));
    }
    if (ttsServerDevice === 'cpu') {
      warnings.push(t.ttsWarnCpu);
    }
    if (!ttsServerHalfPrecision) {
      warnings.push(t.ttsWarnNoHalf);
    }
    if (warnings.length > 0) {
      toast.warning(t.ttsPerfWarning.replace('{{details}}', warnings.join('；')), { durationMs: 10000 });
    }
  }, [ttsServerStatus, ttsServerModelVersion, ttsServerDevice, ttsServerHalfPrecision, t.ttsWarnModelVersion, t.ttsWarnCpu, t.ttsWarnNoHalf, t.ttsPerfWarning]);

  const activeCharacter = useCharactersStore((s) =>
    s.characters.find((c) => c.id === s.activeCharacterId) ?? null
  );

  const charactersEnabled = settings.experimentalCharacters;
  const voiceUiEnabled = settings.experimentalVoice;

  useEffect(() => {
    maybeInsertActiveCharacterGreeting();
  }, [activeCharacter?.id, activeCharacter?.firstMessage, activeCharacter?.selectedGreetingIndex, activeSessionId, sessionMessagesLoading, messages.length, charactersEnabled]);

  const showCharacterAvatar = Boolean(
    charactersEnabled && activeCharacter && (activeCharacter.showAvatar ?? true)
  );
  const characterAvatar = showCharacterAvatar
    ? (activeCharacter?.avatarDataUrl ?? null)
    : null;
  const characterName = showCharacterAvatar ? activeCharacter?.name : undefined;

  // Auto-speak only when experimental voice is on and the active character has voice enabled.
  const voiceEnabled = voiceUiEnabled && (activeCharacter?.voice?.enabled ?? false);

  useEffect(() => {
    if (voiceUiEnabled) return;
    ttsStop();
    setShowTtsLog(false);
    setShowInstaller(false);
  }, [voiceUiEnabled, ttsStop]);

  // Sync voice config (ref audio path, prompt text) to the TTS hook.
  useEffect(() => {
    const vc = activeCharacter?.voice;
    if (vc?.engine === 'gpt-sovits' && vc.referenceSamplePath) {
      const promptLang = vc.referenceTextLanguage || 'all_zh';
      const textLang = vc.textLanguage || promptLang;
      ttsSetVoiceConfig(vc.referenceSamplePath, vc.referenceText ?? '', promptLang);
      ttsSetTextLanguage(textLang);
      ttsSetPlaybackMode(vc.playbackMode ?? 'ws-batch');
      ttsSetSampleSteps(vc.sampleSteps ?? 8);
      ttsSetSpeed(vc.speed ?? 1.0);
      ttsSetVoiceModel(vc.modelName ?? '');
      const ftPath = vc.useFineTuned !== false && vc.fineTunedModelPath ? vc.fineTunedModelPath : '';
      ttsSetFineTunedModel(ftPath);
      ttsSetSentencesPerChunk(vc.sentencesPerChunk ?? 3);
      if (activeCharacter) {
        ttsSetInteractionMode(resolveCharacterInteractionMode(activeCharacter));
      }
      // Only preload/reset the model when the path actually changes
      // (avoiding an HTTP round-trip on every character save).
      if (ftPath !== prevFtPathRef.current && ttsServerStatus === 'running') {
        prevFtPathRef.current = ftPath;
        ttsPreloadModel(ftPath).catch(() => {});
      }
    } else {
      ttsSetVoiceConfig('', '', 'all_zh');
      ttsSetTextLanguage('all_zh');
      ttsSetVoiceModel('');
      ttsSetFineTunedModel('');
      ttsSetInteractionMode('persona');
      // Reset the preload tracker too, so switching back to a character that
      // DOES have a fine-tuned model re-triggers the preload (otherwise the
      // stale cached path would suppress it).
      prevFtPathRef.current = '';
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- D-4 ratchet：接入插件时的存量欠账，勿新增
  }, [activeCharacter?.voice?.referenceSamplePath, activeCharacter?.voice?.referenceText, activeCharacter?.voice?.referenceTextLanguage, activeCharacter?.voice?.textLanguage, activeCharacter?.voice?.engine, activeCharacter?.voice?.playbackMode, activeCharacter?.voice?.sampleSteps, activeCharacter?.voice?.speed, activeCharacter?.voice?.modelName, activeCharacter?.voice?.fineTunedModelPath, activeCharacter?.voice?.useFineTuned, activeCharacter?.voice?.sentencesPerChunk, activeCharacter?.interactionMode, ttsSetVoiceConfig, ttsSetTextLanguage, ttsSetVoiceModel, ttsSetFineTunedModel, ttsSetPlaybackMode, ttsSetSampleSteps, ttsSetSpeed, ttsSetSentencesPerChunk, ttsSetInteractionMode, ttsServerStatus]);

  const prevHasStreamingRef = useRef(hasStreamingMessage);
  const lastStreamingMsgIdRef = useRef<string | null>(null);
  const voiceServerHintShownRef = useRef(false);
  // We read `visibleMessages` from a ref inside the TTS effects so that the
  // effects do NOT re-run on every render (visibleMessages is an inline
  // `messages.filter(...)` result and gets a fresh reference each render).
  // Re-running the effects unnecessarily was a major contributor to the
  // "the character keeps repeating the same sentence" bug.
  const visibleMessagesRef = useRef(visibleMessages);
  visibleMessagesRef.current = visibleMessages;

  useEffect(() => {
    if (!voiceEnabled) {
      voiceServerHintShownRef.current = false;
      return;
    }
    if (ttsServerStatus === 'running' || ttsServerStatus === 'starting' || ttsServerStatus === 'unknown') {
      if (ttsServerStatus === 'running') {
        voiceServerHintShownRef.current = false;
      }
      return;
    }
    if (voiceServerHintShownRef.current) return;
    voiceServerHintShownRef.current = true;
    toast.warning(t.voiceWarmupServerNotRunning);
  }, [voiceEnabled, ttsServerStatus, t.voiceWarmupServerNotRunning]);

  // Streaming feed: sends new content chunks to TTS.
  // Also detects agent-round transitions (message ID changes) and force-completes
  // the previous round's text so buffered text isn't stranded.
  useEffect(() => {
    if (!voiceEnabled) return;
    if (ttsServerStatus !== 'running') return;

    const streaming = streamingMessage;

    // Round transition: streaming switched to a new message.
    // Force-complete the previous message's content first.
    if (lastStreamingMsgIdRef.current
        && streaming?.id
        && lastStreamingMsgIdRef.current !== streaming.id) {
      const prevMsg = visibleMessagesRef.current.find(
        (m) => m.id === lastStreamingMsgIdRef.current,
      );
      if (prevMsg?.content && prevMsg.role === 'assistant' && !prevMsg.synthetic) {
        ttsFeedStream(prevMsg.content, true, prevMsg.id);
      }
    }

    if (!streaming?.content) return;

    // Tool rounds still have spoken commentary around the work. sanitizeForSpeech
    // strips fences / traces; skipping the whole message made coding+voice silent.
    ttsFeedStream(streaming.content, false, streaming.id);
    lastStreamingMsgIdRef.current = streaming.id;
    // NOTE: deliberately NOT depending on `visibleMessages` (it changes
    // reference every render). We read it via `visibleMessagesRef`.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- D-4 ratchet：接入插件时的存量欠账，勿新增
  }, [streamingMessage?.content, streamingMessage?.id, voiceEnabled, ttsServerStatus, ttsFeedStream]);

  // Finalization: when all streaming stops, force-complete the last message.
  // The "previous had streaming" tracking is updated INSIDE this same effect
  // (top of the body) so there is no window where another render can
  // re-trigger finalize between two separate effects. Together with the
  // `lastFinalizedIdRef` idempotence guard inside `feedStream`, this makes
  // finalize fire exactly once per assistant message.
  useEffect(() => {
    const wasStreaming = prevHasStreamingRef.current;
    prevHasStreamingRef.current = hasStreamingMessage;

    if (!voiceEnabled) return;
    if (ttsServerStatus !== 'running') return;
    if (!wasStreaming || hasStreamingMessage) return;

    const msgs = visibleMessagesRef.current;
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.synthetic) return;
    if (!lastMsg.content) return;

    // forceComplete=true flushes any tail buffered behind unclosed markers.
    // `feedStream` is itself idempotent on (messageId, forceComplete), so
    // even if this effect ever runs twice for the same transition, the TTS
    // hook silently no-ops on the second call.
    ttsFeedStream(lastMsg.content, true, lastMsg.id);
    lastStreamingMsgIdRef.current = null;
  }, [hasStreamingMessage, voiceEnabled, ttsServerStatus, ttsFeedStream]);

  // `prevHasStreamingRef` is now updated synchronously at the top of the
  // finalize effect above. We intentionally do NOT update it in a separate
  // effect — doing so created a window where `visibleMessages` re-renders
  // could re-trigger the finalize effect before this updater ran, causing
  // duplicate playback of the same finalize.

  const latestPlanAssistantMessageId = useMemo(
    () =>
      [...visibleMessages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            message.workMode === 'plan' &&
            !message.synthetic &&
            !message.isStreaming
        )?.id ?? null,
    [visibleMessages]
  );
  // —— 历史滑动窗口渲染 ——
  // DOM 里恒定只保留约 N 轮：上滑时窗口整体上移（加载更早的轮、卸载下面的轮），
  // 下滑反之；滚回底部时窗口重新贴合尾部。完整 visibleMessages 仍供 LLM 上下文/
  // TTS/搜索使用，这里只裁剪渲染范围。未渲染区域用占位块撑起滚动高度，占位高度
  // 取自高度缓存（渲染时实测）或对未渲染过消息的估算。
  const chatRenderBatchRounds = Math.max(1, settings.chatRenderBatchRounds || 6);
  const slideStepRounds = Math.max(1, Math.ceil(chatRenderBatchRounds / 2));
  const chatRenderBatchRoundsRef = useRef(chatRenderBatchRounds);
  chatRenderBatchRoundsRef.current = chatRenderBatchRounds;
  const slideStepRoundsRef = useRef(slideStepRounds);
  slideStepRoundsRef.current = slideStepRounds;

  const roundStarts = useMemo(() => computeRoundStartIndices(visibleMessages), [visibleMessages]);
  const totalRounds = roundStarts.length;
  const roundStartsRef = useRef(roundStarts);
  roundStartsRef.current = roundStarts;

  // 窗口 [lo, hi) 是「轮」的下标区间；hi === totalRounds 表示贴合尾部。
  const [roundWindow, setRoundWindow] = useState<RoundWindow>(() =>
    computeInitialWindow(totalRounds, chatRenderBatchRounds)
  );
  const roundWindowRef = useRef(roundWindow);
  roundWindowRef.current = roundWindow;
  const pendingScrollToIdRef = useRef<string | null>(null);
  const windowSessionKeyRef = useRef<string | null>(null);
  // 跳转 / 打开会话后的程序化滚动期间暂缓窗口重定位，直到用户下一次主动滚动。
  const jumpScrollSuppressRef = useRef(false);

  // 防御：会话切换/截断的同一帧里窗口可能越界，先收敛再使用。
  const effectiveRoundWindow = useMemo(
    () => clampWindow(roundWindow, totalRounds, chatRenderBatchRounds),
    [roundWindow, totalRounds, chatRenderBatchRounds]
  );

  const windowBounds = useMemo(
    () => windowMessageBounds(visibleMessages, effectiveRoundWindow),
    [visibleMessages, effectiveRoundWindow]
  );
  const windowedMessages = useMemo(
    () => visibleMessages.slice(windowBounds.start, windowBounds.end),
    [visibleMessages, windowBounds]
  );

  // 高度缓存：消息 ID → 实测像素高度。跨会话保留（ID 唯一），回访时占位精确。
  const heightCacheRef = useRef(new Map<string, number>());
  const messageHeights = useMemo(
    () => visibleMessages.map((m) => heightCacheRef.current.get(m.id) ?? estimateMessageHeight(m)),
    // effectiveRoundWindow 入依赖：窗口滑动后必须用最新缓存重算占位高度。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- D-4 ratchet：接入插件时的存量欠账，勿新增
    [visibleMessages, effectiveRoundWindow]
  );
  const prefixHeights = useMemo(() => {
    const prefix = new Array<number>(messageHeights.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < messageHeights.length; i++) {
      prefix[i + 1] = prefix[i] + messageHeights[i];
    }
    return prefix;
  }, [messageHeights]);
  const topSpacerHeight = prefixHeights[windowBounds.start];
  const bottomSpacerHeight = prefixHeights[visibleMessages.length] - prefixHeights[windowBounds.end];
  const topSpacerHeightRef = useRef(topSpacerHeight);
  topSpacerHeightRef.current = topSpacerHeight;
  const prefixHeightsRef = useRef(prefixHeights);
  prefixHeightsRef.current = prefixHeights;

  // 视口所在的轮（1-based），供右侧轮次指示器使用。滚动比例在引入占位块后
  // 不再准确，改为用与占位同一份高度数据从 scrollTop 反查。
  const [viewportRoundIndex, setViewportRoundIndex] = useState(1);

  // 渲染后同步测量：共享一个 ResizeObserver 观察窗口内的消息包装元素。
  const itemObserverRef = useRef<ResizeObserver | null>(null);
  const observedItemsRef = useRef(new Set<Element>());
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const id = el.getAttribute('data-message-id');
        if (!id) continue;
        const height = el.getBoundingClientRect().height;
        if (height > 0) {
          if (heightCacheRef.current.size > 5000) {
            const firstKey = heightCacheRef.current.keys().next().value;
            if (firstKey) heightCacheRef.current.delete(firstKey);
          }
          heightCacheRef.current.set(id, height);
        }
      }
    });
    itemObserverRef.current = observer;
    return () => {
      observer.disconnect();
      itemObserverRef.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- D-4 ratchet：接入插件时的存量欠账，勿新增
      observedItemsRef.current.clear();
    };
  }, []);
  useLayoutEffect(() => {
    const observer = itemObserverRef.current;
    const content = messageListContentRef.current;
    if (!observer || !content) return;
    const seen = new Set<Element>();
    content.querySelectorAll('[data-window-item]').forEach((el) => {
      seen.add(el);
      if (!observedItemsRef.current.has(el)) {
        observedItemsRef.current.add(el);
        observer.observe(el);
      }
    });
    for (const el of observedItemsRef.current) {
      if (!seen.has(el)) {
        observedItemsRef.current.delete(el);
        observer.unobserve(el);
      }
    }
  });

  // 切换会话（含按需加载完成）时把窗口重置为「最近 N 轮」。
  // 用「会话 ID + 首条可见消息 ID」双重指纹防竞态：selectSession 分两步更新
  // activeSessionId 和 messages，只按会话 ID 判断会用旧会话的消息算出错误窗口。
  //
  // 打开后会程序化滚到底部：在那之前 scrollTop 仍是 0，视口中心落在顶部占位
  // 的旧轮上。若此时按视口重定位，批次刚好少 1 轮时就会把最新一轮卸掉，露出
  // 「加载更新的 1 轮」。先抑制窗口跟随，直到用户自己滚动。
  const windowInitFingerprintRef = useRef<string | null>(null);
  useEffect(() => {
    if (deferMessages || sessionMessagesLoading) return;
    const key = activeSessionId ?? '__none__';
    const fingerprint = visibleMessagesRef.current[0]?.id ?? '';
    if (windowSessionKeyRef.current === key && windowInitFingerprintRef.current === fingerprint) return;
    windowSessionKeyRef.current = key;
    windowInitFingerprintRef.current = fingerprint;
    pendingScrollToIdRef.current = null;
    jumpScrollSuppressRef.current = true;
    setRoundWindow(computeInitialWindow(roundStartsRef.current.length, chatRenderBatchRoundsRef.current));
  }, [deferMessages, sessionMessagesLoading, activeSessionId, messages]);

  // 消息变化（流式追加/重置截断）后收敛窗口：
  // - 越界（截断）→ clamp；贴尾窗口截断后仍贴尾
  // - 吸底时新轮到达 → 窗口重新贴尾，保证用户始终看到最新消息
  // - 贴尾且轮数超出窗口 → 卸载头部旧轮；但视口仍停留在窗口顶部附近时暂缓，
  //   避免把用户正在看的内容移出窗口（此时继续增长是暂时的，用户上滑会触发窗口跟随）
  useEffect(() => {
    const total = roundStartsRef.current.length;
    const batch = chatRenderBatchRoundsRef.current;
    const prev = roundWindowRef.current;
    // 退化窗口自愈：有轮次但窗口为空（初始化竞态残留）→ 直接贴尾。
    if (total > 0 && prev.lo === 0 && prev.hi === 0) {
      setRoundWindow(computeInitialWindow(total, batch));
      return;
    }
    if (prev.hi > total || prev.lo > prev.hi || prev.lo < 0) {
      setRoundWindow(clampWindow(prev, total, batch));
      return;
    }
    if (shouldStickToBottomRef.current && prev.hi < total) {
      setRoundWindow(computeInitialWindow(total, batch));
      return;
    }
    if (prev.hi === total && total > batch) {
      const lo = total - batch;
      if (lo !== prev.lo) {
        const container = messageListRef.current;
        const viewportClearOfWindowTop =
          !container || container.scrollTop > topSpacerHeightRef.current + 200;
        if (shouldStickToBottomRef.current || viewportClearOfWindowTop) {
          setRoundWindow({ lo, hi: total });
        }
      }
    }
  }, [visibleMessages]);

  // 滑动窗口。占位块高度与窗口内消息共用同一份高度数据（缓存/估算），
  // 消息在「占位 ↔ 渲染」之间切换时绝对位置不变，因此无需补偿 scrollTop，
  // 视口自然停在原内容上，新批次在其上/下方出现。
  const slideWindow = useCallback((dir: 'up' | 'down') => {
    const total = roundStartsRef.current.length;
    const current = roundWindowRef.current;
    const next = dir === 'up'
      ? slideWindowUp(current, total, chatRenderBatchRoundsRef.current, slideStepRoundsRef.current)
      : slideWindowDown(current, total, chatRenderBatchRoundsRef.current, slideStepRoundsRef.current);
    if (next.lo === current.lo && next.hi === current.hi) return;
    setRoundWindow(next);
  }, []);

  // 窗口跟随视口：滚动（含拖滚动条、打开会话的滚到底部、跳转后的滚动）时，
  // 按视口中心所在轮重定位窗口。占位块总高恒定，移动窗口不会改变 scrollTop，
  // 因此没有反馈环。仅当视口中心移出当前窗口才重定位，避免频繁重渲染。
  const placeRafRef = useRef(0);
  const placeWindowFromScroll = useCallback(() => {
    const container = messageListRef.current;
    const msgs = visibleMessagesRef.current;
    const starts = roundStartsRef.current;
    if (!container || msgs.length === 0 || starts.length === 0) return;
    const prefix = prefixHeightsRef.current;
    const centerOffset = container.scrollTop + container.clientHeight / 2;
    const messageIndex = findMessageIndexAtOffset(prefix, centerOffset);
    const centerRound = findRoundIndexAtMessageIndex(starts, messageIndex);
    setViewportRoundIndex((prev) => (prev === centerRound + 1 ? prev : centerRound + 1));
    if (jumpScrollSuppressRef.current) return;
    const current = roundWindowRef.current;
    if (centerRound >= current.lo && centerRound < current.hi) return;
    setRoundWindow(computeWindowForViewport(msgs, prefix, centerOffset, chatRenderBatchRoundsRef.current));
  }, []);
  const handleScrollPlace = useCallback(() => {
    if (placeRafRef.current) return;
    placeRafRef.current = requestAnimationFrame(() => {
      placeRafRef.current = 0;
      placeWindowFromScroll();
    });
  }, [placeWindowFromScroll]);
  useEffect(() => () => { cancelAnimationFrame(placeRafRef.current); }, []);

  // 窗口/消息变化后同步一次指示器轮次（如流式追加、切换会话后未发生滚动）。
  useLayoutEffect(() => {
    const container = messageListRef.current;
    const starts = roundStartsRef.current;
    if (!container || starts.length === 0) return;
    const prefix = prefixHeightsRef.current;
    const centerOffset = container.scrollTop + container.clientHeight / 2;
    const round = findRoundIndexAtMessageIndex(
      starts,
      findMessageIndexAtOffset(prefix, centerOffset)
    );
    setViewportRoundIndex((prev) => (prev === round + 1 ? prev : round + 1));
  }, [roundWindow, visibleMessages]);

  // 跳转到指定消息：窗口外先移动窗口，渲染后再滚动；已在窗口内则直接滚动。
  const scrollToMessageInView = useCallback((messageId: string) => {
    const msgs = visibleMessagesRef.current;
    const index = msgs.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    jumpScrollSuppressRef.current = true;
    const bounds = windowMessageBounds(msgs, roundWindowRef.current);
    if (index < bounds.start || index >= bounds.end) {
      pendingScrollToIdRef.current = messageId;
      isProgrammaticScrollRef.current = true;
      setRoundWindow(computeWindowForJump(msgs, index, chatRenderBatchRoundsRef.current));
      return;
    }
    const container = messageListRef.current;
    const el = container?.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (container && el) {
      isProgrammaticScrollRef.current = true;
      container.scrollTo?.({ top: Math.max(0, el.offsetTop - 80), behavior: 'smooth' });
    } else {
      pendingScrollToIdRef.current = messageId;
    }
  }, []);

  useLayoutEffect(() => {
    const targetId = pendingScrollToIdRef.current;
    if (!targetId) return;
    const container = messageListRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-message-id="${targetId}"]`) as HTMLElement | null;
    if (!el) return;
    pendingScrollToIdRef.current = null;
    isProgrammaticScrollRef.current = true;
    container.scrollTop = Math.max(0, el.offsetTop - 80);
  }, [roundWindow, visibleMessages]);

  // 跨面板跳转请求（如 AgentOpsPanel 里的会话搜索）。
  const pendingChatJump = useAgentStore((s) => s._pendingChatJump);
  useEffect(() => {
    if (!pendingChatJump) return;
    scrollToMessageInView(pendingChatJump.messageId);
    useAgentStore.setState({ _pendingChatJump: null });
  }, [pendingChatJump, scrollToMessageInView]);

  const renderedMessages = useMemo(() => {
    if (!tailExecutionProcessGroup) {
      return windowedMessages;
    }
    return windowedMessages.filter((message) => {
      if (message.id === tailExecutionProcessGroup.summaryMessageId) {
        return true;
      }
      if (message.id === tailExecutionProcessGroup.userMessageId) {
        return true;
      }
      return !tailExecutionProcessGroup.messages.some(
        (processMessage) => processMessage.id === message.id
      );
    });
  }, [windowedMessages, tailExecutionProcessGroup]);

  useLayoutEffect(() => {
    lastVisibleMessageIdRef.current = tailMessageId;
  }, [tailMessageId]);

  useLayoutEffect(() => {
    const container = messageListRef.current;
    const content = messageListContentRef.current;
    if (!container || !content || typeof ResizeObserver === 'undefined') {
      return;
    }

    let rafId = 0;

    const observer = new ResizeObserver(() => {
      const currentContainer = messageListRef.current;
      if (!currentContainer) return;

      cancelAnimationFrame(rafId);

      if (shouldStickToBottomRef.current) {
        isProgrammaticScrollRef.current = true;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          scrollContainerToBottom(currentContainer, hasStreamingMessageRef.current ? 'auto' : 'smooth');
        });
        return;
      }

      const distanceFromBottom = currentContainer.scrollHeight - currentContainer.scrollTop - currentContainer.clientHeight;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!currentContainer.isConnected) return;
        const targetScrollTop = currentContainer.scrollHeight - distanceFromBottom - currentContainer.clientHeight;
        if (Math.abs(targetScrollTop - currentContainer.scrollTop) > 1) {
          currentContainer.scrollTop = targetScrollTop;
        }
      });
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, []);

  // 对话内容首次进入已稳定布局的时刻（ProjectGraph 遮罩关闭、打开工作区、切换
  // 会话、按需历史加载完成）统一瞬时滚到底部。WKWebView 对「新插入的大列表 +
  // 同帧程序化滚动」可能不重绘（表现为空白、动一下滚动条才显示），因此用双 rAF
  // 让内容先完成合成，再瞬时滚动，最后补一次 1px 滚动微扰强制重绘。
  useLayoutEffect(() => {
    if (deferMessages || sessionMessagesLoading) return;
    shouldStickToBottomRef.current = true;
    jumpScrollSuppressRef.current = true;
    let raf2 = 0;
    let raf3 = 0;
    let raf4 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const container = messageListRef.current;
        if (!container) return;
        isProgrammaticScrollRef.current = true;
        scrollContainerToBottom(container, 'auto');
        raf3 = requestAnimationFrame(() => {
          container.scrollTop = Math.max(0, container.scrollTop - 1);
          raf4 = requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = true;
            scrollContainerToBottom(container, 'auto');
          });
        });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      cancelAnimationFrame(raf3);
      cancelAnimationFrame(raf4);
    };
  }, [deferMessages, sessionMessagesLoading, activeSessionId]);

  const submitMessage = useCallback(async (
    taskText: string,
    displayText: string,
    nextMode: WorkMode,
    images?: IImageContent[],
    attachedFiles?: { name: string; size: number }[]
  ): Promise<boolean> => {
    if (workspacePath && nextMode !== 'ask') {
      refreshProjectDiagnostics().catch(() => {});
    }

    shouldStickToBottomRef.current = true;
    if (attachedFiles && attachedFiles.length > 0) {
      return await sendMessage(taskText, displayText, nextMode, images, attachedFiles);
    }
    return await sendMessage(taskText, displayText, nextMode, images);
  }, [
    refreshProjectDiagnostics,
    sendMessage,
    workspacePath,
  ]);

  const handleSend = async () => {
    const userText = input.trim();
    const images = pendingImages.map(({ mediaType, data }) => ({ mediaType, data }));
    const slash = parseSlashInput(userText);
    const isLocalSlash = Boolean(slash && isLocalSlashCommand(slash.name));
    if (
      (!userText && images.length === 0 && pendingFiles.length === 0)
      || (!isLocalSlash && isLoading)
      || (!isLocalSlash && !isConfigured)
    ) {
      return;
    }
    ttsStop();
    const files = pendingFiles;
    const promptText = buildUserPromptWithFiles(userText, files);
    const displayText = userText || files.map((f) => f.name).join(', ') || (images.length ? '🖼️' : '');
    const attachedFiles = files.map((file) => ({ name: file.name, size: file.size }));
    const sendImages = images.length ? images : undefined;
    const sendFiles = attachedFiles.length ? attachedFiles : undefined;

    // #26：slash 命令先发送、成功后才清空草稿——模板展开/条件解析失败时
    // sendMessage 返回 false（消息未进入会话），此时保留草稿供用户修改重试。
    // 旧实现先 setInput('') 再发送，失败后用户打好的命令文本永久丢失。
    if (userText.startsWith('/')) {
      const consumed = sendFiles
        ? await sendMessage(promptText, displayText, mode, sendImages, sendFiles)
        : await sendMessage(promptText, displayText, mode, sendImages);
      if (consumed) {
        setInput('');
        setPendingImages([]);
        setPendingFiles([]);
      }
      return;
    }

    // 乐观清空（回合期间输入框不残留草稿），但发送被拒绝时恢复草稿：
    // sendMessage 返回 false（单执行守卫拒绝、默认项目创建失败等）表示
    // 消息未进入会话，旧实现先清空再发送，失败后用户打好的内容永久丢失。
    // sendMessage 会 await 整个回合，不能等它返回再清空（输入框会残留数分钟）。
    const draftImages = pendingImages;
    setInput('');
    setPendingImages([]);
    setPendingFiles([]);
    const consumed = await submitMessage(promptText, displayText, mode, sendImages, sendFiles);
    if (!consumed) {
      // 仅当输入框仍为空时恢复：等待期间用户可能已重新输入，不得覆盖。
      setInput((current) => (current.trim() ? current : userText));
      setPendingImages((current) => (current.length ? current : draftImages));
      setPendingFiles((current) => (current.length ? current : files));
    }
  };

  const addImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const oversized: string[] = [];
    const readable = files.filter((file) => {
      if (file.size > MAX_IMAGE_BYTES) {
        oversized.push(`${file.name} (${(file.size / 1024).toFixed(0)}KB)`);
        return false;
      }
      return true;
    });
    if (oversized.length > 0) {
      toast.error(
        t.toastAttachmentTooLarge
          .replace('{max}', formatBytesAsMbLabel(MAX_IMAGE_BYTES))
          .replace('{names}', oversized.join('\n')),
      );
    }
    const results = await Promise.all(readable.map(readFileAsImagePreview));
    const previews = results.filter((item): item is ImagePreview => item !== null);
    const skipped = readable.length - previews.length;
    if (skipped > 0) {
      toast.warning(t.toastAttachmentImageSkipped.replace('{count}', String(skipped)));
    }
    if (previews.length === 0) return;

    let droppedCount = 0;
    setPendingImages((current) => {
      const combined = [...current, ...previews];
      if (combined.length > MAX_PENDING_IMAGES) {
        droppedCount = combined.length - MAX_PENDING_IMAGES;
        return combined.slice(combined.length - MAX_PENDING_IMAGES);
      }
      return combined;
    });
    if (droppedCount > 0) {
      toast.warning(
        t.toastAttachmentLimitExceeded
          .replace('{max}', String(MAX_PENDING_IMAGES))
          .replace('{dropped}', String(droppedCount)),
      );
    }
  };

  const handleIncomingFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { images, textFiles, unsupportedImages, binaries } = partitionIncomingFiles(files);
    if (unsupportedImages.length > 0) {
      toast.warning(
        t.toastAttachmentImageSkipped.replace('{count}', String(unsupportedImages.length)),
      );
    }
    if (binaries.length > 0) {
      toast.warning(t.toastAttachmentBinarySkipped.replace('{names}', binaries.join('\n')));
    }
    if (images.length > 0) {
      await addImageFiles(images);
    }
    if (textFiles.length > 0) {
      await addTextFiles(textFiles);
    }
  };
  handleIncomingFilesRef.current = handleIncomingFiles;

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = collectDataTransferFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void handleIncomingFilesRef.current(files);
  }, []);

  const handleComposerDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleComposerDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    const files = collectDataTransferFiles(event.dataTransfer);
    if (files.length === 0) return;
    void handleIncomingFilesRef.current(files);
  }, []);

  useEffect(() => {
    const isFileDrag = (event: globalThis.DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
    };
    const onDrop = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const removePendingImage = (id: string) => {
    setPendingImages((current) => current.filter((image) => image.id !== id));
  };

  const removePendingFile = (id: string) => {
    setPendingFiles((current) => current.filter((file) => file.id !== id));
  };

  const handlePrimaryAction = async () => {
    if (!canSubmit) return;
    const slash = parseSlashInput(input.trim());
    const isLocalSlash = Boolean(slash && isLocalSlashCommand(slash.name));
    if (!isConfigured && !isLocalSlash) {
      setShowSettings(true);
      return;
    }
    await handleSend();
  };
  handlePrimaryActionRef.current = handlePrimaryAction;
  slashFilterRef.current = slashFilter;
  atFilterRef.current = atFilter;

  const applyComposerFilters = useCallback((value: string, cursorPos: number) => {
    if (isComposingRef.current) return;
    const next = resolveComposerFilters(value, cursorPos);
    atTriggerIndexRef.current = next.atTriggerIndex;
    setAtFilter(next.atFilter);
    setSlashFilter(next.slashFilter);
  }, []);

  const handleDraftValueChange = useCallback((value: string) => {
    setInput(value);
    const cursorPos = textareaRef.current?.selectionStart ?? value.length;
    applyComposerFilters(value, cursorPos);
  }, [setInput, applyComposerFilters]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback((value: string, cursorPos: number) => {
    isComposingRef.current = false;
    applyComposerFilters(value, cursorPos);
  }, [applyComposerFilters]);

  const handleSlashSelect = (name: string) => {
    setInput(`/${name} `);
    setSlashFilter(null);
  };

  const mentionItems = useMemo(
    () => buildMentionItems(_agentDefinitions, _skillDefinitions, settings.lang, mentorEnabled),
    [_agentDefinitions, _skillDefinitions, settings.lang, mentorEnabled]
  );

  const handleAtSelect = useCallback((item: MentionItem) => {
    const triggerIndex = atTriggerIndexRef.current;
    if (triggerIndex < 0) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    setInput((prev) => {
      const before = prev.slice(0, triggerIndex);
      const after = prev.slice(cursorPos);
      return `${before}@${item.name} ${after}`;
    });
    setAtFilter(null);
    atTriggerIndexRef.current = -1;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        const newPos = triggerIndex + item.name.length + 2;
        el.focus();
        el.setSelectionRange(newPos, newPos);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- D-4 ratchet：接入插件时的存量欠账，勿新增
  }, []);

  const handleAtDismiss = useCallback(() => {
    setAtFilter(null);
    atTriggerIndexRef.current = -1;
  }, []);

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.currentTarget.files;
    if (!fileList || fileList.length === 0) return;
    await handleIncomingFiles(Array.from(fileList));
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const addTextFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const oversizedFiles: string[] = [];
    const skippedFiles: string[] = [];
    const attachments: TextFileAttachment[] = [];

    for (const file of files) {
      if (file.size > MAX_TEXT_FILE_BYTES) {
        oversizedFiles.push(`${file.name} (${(file.size / 1024).toFixed(0)}KB)`);
        continue;
      }
      try {
        const text = await file.text();
        if (looksLikeBinaryText(text)) {
          skippedFiles.push(file.name);
          continue;
        }
        attachments.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`,
          name: file.name,
          content: text,
          size: file.size,
        });
      } catch {
        skippedFiles.push(file.name);
      }
    }

    let droppedCount = 0;
    setPendingFiles((current) => {
      const combined = [...current, ...attachments];
      if (combined.length > MAX_PENDING_FILES) {
        droppedCount = combined.length - MAX_PENDING_FILES;
        return combined.slice(combined.length - MAX_PENDING_FILES);
      }
      return combined;
    });

    if (droppedCount > 0) {
      toast.warning(
        t.toastAttachmentLimitExceeded
          .replace('{max}', String(MAX_PENDING_FILES))
          .replace('{dropped}', String(droppedCount)),
      );
    }

    if (oversizedFiles.length > 0) {
      toast.error(
        t.toastAttachmentTooLarge
          .replace('{max}', formatBytesAsMbLabel(MAX_TEXT_FILE_BYTES))
          .replace('{names}', oversizedFiles.join('\n')),
      );
    }

    if (skippedFiles.length > 0) {
      toast.warning(
        t.toastAttachmentBinarySkipped.replace('{names}', skippedFiles.join('\n')),
      );
    }
  };

  const handlePlanAction = useCallback(async (action: PlanFollowUpAction) => {
    if (isLoading || !isConfigured) {
      return;
    }

    // 标记源消息的 plan 问题为已答（持久化，防重复作答）。
    if (action.sourceMessageId && activeSessionId) {
      useAgentStore.setState((s) => {
        const currentSessionMessages = s.sessionMessages[activeSessionId] ?? s.messages;
        let changed = false;
        const nextMessages = currentSessionMessages.map((message) => {
          if (message.id !== action.sourceMessageId) {
            return message;
          }
          changed = true;
          return { ...message, questionAnswered: true };
        });
        if (!changed) {
          return {};
        }
        return {
          messages: activeSessionId === s.activeSessionId ? nextMessages : s.messages,
          sessionMessages: {
            ...s.sessionMessages,
            [activeSessionId]: nextMessages,
          },
        };
      });
    }

    setMode(action.mode);
    await submitMessage(action.prompt, action.label, action.mode);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- D-4 ratchet：接入插件时的存量欠账，勿新增
  }, [activeSessionId, isConfigured, isLoading, submitMessage]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent;
    const isComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;

    if (isComposing) {
      return;
    }

    const slashFilterValue = slashFilterRef.current;
    const atFilterValue = atFilterRef.current;

    if (slashFilterValue !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashDropdownRef.current?.navigateDown();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashDropdownRef.current?.navigateUp();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        slashDropdownRef.current?.selectCurrent();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const token = slashFilterValue.trim();
        const selectedName = slashDropdownRef.current?.getSelectedName() ?? null;
        if (token && selectedName === token) {
          setSlashFilter(null);
          void handlePrimaryActionRef.current();
          return;
        }
        const completed = slashDropdownRef.current?.selectCurrent() ?? false;
        if (!completed) {
          setSlashFilter(null);
          void handlePrimaryActionRef.current();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashFilter(null);
        return;
      }
    }

    if (atFilterValue !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        atDropdownRef.current?.navigateDown();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        atDropdownRef.current?.navigateUp();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        atDropdownRef.current?.selectCurrent();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleAtDismiss();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handlePrimaryActionRef.current();
    }
  }, [handleAtDismiss]);

  return (
    <div className="relative flex flex-col h-full">
      {resetBanner && (
        <div
          role="status"
          className={
            'pointer-events-none absolute inset-x-0 top-2 z-40 mx-auto w-fit max-w-[90%] rounded-full border px-4 py-1.5 text-xs shadow-lg backdrop-blur-sm fade-in ' +
            (resetBanner.kind === 'success'
              ? 'border-ok-bg bg-ok-bg text-ok'
              : resetBanner.kind === 'warn'
              ? 'border-warn-bg bg-warn-bg text-warn'
              : 'border-danger-bg bg-danger-bg text-danger')
          }
        >
          {resetBanner.text}
        </div>
      )}
      {sessionMessagesLoadFailed && !isActiveLoading && (
        <div className="absolute inset-x-0 top-2 z-40 mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-full border border-danger-bg bg-danger-bg px-4 py-1.5 text-xs text-danger shadow-lg backdrop-blur-sm fade-in">
          <span>
            {settings.lang === 'en'
              ? 'Session history failed to load — showing an incomplete view.'
              : settings.lang === 'zh-TW'
                ? '會話歷史載入失敗——目前顯示的內容可能不完整。'
                : '会话历史加载失败——当前显示的内容可能不完整。'}
          </span>
          <button
            type="button"
            disabled={retryMessagesLoading}
            onClick={async () => {
              setRetryMessagesLoading(true);
              const ok = await retryLoadSessionMessages();
              setRetryMessagesLoading(false);
              if (!ok) {
                setResetBanner({
                  kind: 'error',
                  text:
                    settings.lang === 'en'
                      ? 'Reload failed — session history still unavailable.'
                      : settings.lang === 'zh-TW'
                        ? '重新載入失敗——會話歷史仍不可用。'
                        : '重新加载失败——会话历史仍不可用。',
                });
              }
            }}
            className="rounded-md border border-danger-bg px-2 py-0.5 font-medium text-danger transition-colors hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {retryMessagesLoading
              ? settings.lang === 'en'
                ? 'Retrying…'
                : settings.lang === 'zh-TW'
                  ? '重試中…'
                  : '重试中…'
              : settings.lang === 'en'
                ? 'Retry'
                : settings.lang === 'zh-TW'
                  ? '重試'
                  : '重试'}
          </button>
        </div>
      )}
      {gitReadyError && !gitReady && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-2 z-30 mx-auto w-fit max-w-[90%] rounded-full border border-warn-bg bg-warn-bg px-4 py-1.5 text-xs text-warn shadow-lg backdrop-blur-sm"
        >
          {settings.lang === 'en'
            ? `Code reset disabled: ${gitReadyError}`
            : settings.lang === 'zh-TW'
            ? `程式碼重設不可用：${gitReadyError}`
            : `代码重置不可用：${gitReadyError}`}
        </div>
      )}
      {checkpointError && gitReady && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-2 z-30 mx-auto w-fit max-w-[90%] rounded-full border border-warn-bg bg-warn-bg px-4 py-1.5 text-xs text-warn shadow-lg backdrop-blur-sm"
        >
          {settings.lang === 'en'
            ? `Code snapshot failed: ${checkpointError} (see console)`
            : settings.lang === 'zh-TW'
            ? `程式碼快照失敗：${checkpointError}（詳見控制台）`
            : `代码快照创建失败：${checkpointError}（详见控制台）`}
        </div>
      )}
      {persistenceError && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-2 z-30 mx-auto w-fit max-w-[90%] rounded-full border border-danger-bg bg-danger-bg px-4 py-1.5 text-xs text-danger shadow-lg backdrop-blur-sm"
        >
          {settings.lang === 'en'
            ? `Failed to persist data: ${persistenceError} — your changes may not survive restart`
            : settings.lang === 'zh-TW'
            ? `資料持久化失敗：${persistenceError} — 重啟後變更可能遺失`
            : `数据持久化失败：${persistenceError} — 重启后更改可能丢失`}
        </div>
      )}
      <GoalBanner />
      {/* 消息列表 */}
      <div className="relative flex-1 min-h-0">
        <div
        ref={messageListRef}
        data-chat-scroll="true"
        onScroll={(event) => {
          if (!isProgrammaticScrollRef.current) {
            shouldStickToBottomRef.current = isScrollContainerNearBottom(event.currentTarget);
            jumpScrollSuppressRef.current = false;
          }
          if (isScrollContainerNearBottom(event.currentTarget)) {
            isProgrammaticScrollRef.current = false;
          }
          handleScrollPlace();
        }}
        className="h-full overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable px-4 py-4"
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={messageListContentRef}>
          <MessageList
            deferMessages={deferMessages}
            effectiveRoundWindow={effectiveRoundWindow}
            totalRounds={totalRounds}
            sessionMessagesLoading={sessionMessagesLoading}
            visibleMessagesCount={visibleMessages.length}
            isConfigured={isConfigured}
            t={t}
            topSpacerHeight={topSpacerHeight}
            bottomSpacerHeight={bottomSpacerHeight}
            subagentRuns={subagentRuns}
            renderedMessages={renderedMessages}
            tailExecutionProcessGroup={tailExecutionProcessGroup}
            latestPlanAssistantMessageId={latestPlanAssistantMessageId}
            tailMessageId={tailMessageId}
            lang={settings.lang ?? 'zh-CN'}
            isLoading={isLoading}
            onPlanAction={handlePlanAction}
            onOpenWorkspacePath={onOpenWorkspacePath}
            onPreviewImage={onPreviewImage}
            workspacePath={workspacePath}
            characterAvatar={characterAvatar}
            characterName={characterName}
            showCharacterAvatar={showCharacterAvatar}
            messageCheckpoints={messageCheckpoints}
            gitReady={gitReady}
            onTtsReplay={ttsReplayText}
            ttsReplayEnabled={voiceUiEnabled}
            onRequestReset={setResetConfirmMsgId}
            activeSessionId={activeSessionId}
            taskChecklists={_taskChecklists}
            isActiveLoading={isActiveLoading}
            hasStreamingMessage={hasStreamingMessage}
            onShowSettings={setShowSettings}
            onSlideWindow={slideWindow}
            onToggleSubagentCollapse={toggleSubagentCollapse}
          />

        {/* 重置到此点确认对话框 */}
        {resetConfirmMsgId !== null && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
            onClick={() => { if (!resetInFlight) setResetConfirmMsgId(null); }}
          >
            <div className="mx-4 w-full max-w-sm rounded-2xl border border-line bg-base p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <p className="mb-3 text-sm text-fg">
                {settings.lang === 'en'
                  ? 'Revert code and conversation to this point? Subsequent messages and code changes will be lost.'
                  : settings.lang === 'zh-TW'
                  ? '要將程式碼和對話重設到此位置嗎？後續的訊息和程式碼變更將會遺失。'
                  : '要将代码和对话重置到此位置吗？后续的消息和代码变更将会丢失。'}
              </p>
              <p className="mb-4 text-[11px] leading-relaxed text-fg-muted">
                {settings.lang === 'en'
                  ? 'Tip: any unsaved edits in open files will be overwritten when files are reloaded. Files matched by .gitignore (e.g. node_modules/, dist/, downloaded assets) and CodePapr\u2019s own .codepapr/ data are not affected.'
                  : settings.lang === 'zh-TW'
                  ? '提示：開啟的檔案中尚未儲存的修改會在檔案重載時被覆蓋。命中 .gitignore 的檔案（如 node_modules/、dist/、下載的素材）以及 CodePapr 自身的 .codepapr/ 資料不會受到影響。'
                  : '提示：已打开文件中尚未保存的修改会在文件重载时被覆盖。命中 .gitignore 的文件（如 node_modules/、dist/、下载的素材）以及 CodePapr 自身的 .codepapr/ 数据不会受影响。'}
              </p>
              <div className="flex justify-end gap-3">
                <button
                  className="rounded-lg border border-line px-4 py-2 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={resetInFlight}
                  onClick={() => setResetConfirmMsgId(null)}
                >
                  {settings.lang === 'en' ? 'Cancel' : '取消'}
                </button>
                <button
                  className="rounded-lg bg-danger px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-danger disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={resetInFlight}
                  onClick={async () => {
                    const msgId = resetConfirmMsgId;
                    if (!msgId) return;
                    setResetInFlight(true);
                    try {
                      const result = await resetToMessage(msgId);
                      if (result.ok) {
                        const lang = settings.lang;
                        // 把被截掉的用户消息内容回填到输入框，方便用户修改后重发
                        if (result.restoredInput) {
                          setInput(result.restoredInput);
                        }
                        if (result.restoredImages && result.restoredImages.length > 0) {
                          setPendingImages(result.restoredImages.map((img) => ({
                            ...img,
                            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                            dataUri: `data:${img.mediaType};base64,${img.data}`,
                          })));
                        } else {
                          setPendingImages([]);
                        }
                        const text = lang === 'en'
                          ? `Reset done · ${result.messagesRemoved} messages removed · ${result.filesChanged} files reverted (ignored files kept).`
                          : lang === 'zh-TW'
                          ? `重設完成 · 移除 ${result.messagesRemoved} 條訊息 · 回滾 ${result.filesChanged} 個檔案（被忽略的檔案保持不變）。`
                          : `重置完成 · 移除 ${result.messagesRemoved} 条消息 · 回滚 ${result.filesChanged} 个文件（被忽略的文件保持不变）。`;
                        setResetBanner({ kind: 'success', text });
                      } else {
                        const lang = settings.lang;
                        let text: string;
                        if (result.reason === 'no-checkpoint') {
                          text = lang === 'en'
                            ? 'No code snapshot for this message; nothing to reset.'
                            : lang === 'zh-TW'
                            ? '此訊息沒有程式碼快照，無法重設。'
                            : '此消息没有代码快照，无法重置。';
                        } else if (result.reason === 'message-not-found') {
                          text = lang === 'en' ? 'Message not found.' : lang === 'zh-TW' ? '找不到訊息。' : '找不到消息。';
                        } else if (result.reason === 'turn-running') {
                          text = lang === 'en'
                            ? 'A turn is still running; stop it before resetting.'
                            : lang === 'zh-TW'
                            ? '目前仍有回合執行中，請先停止再重設。'
                            : '当前仍有回合在运行，请先停止再重置。';
                        } else {
                          const detail = result.error ? ` (${result.error})` : '';
                          text = lang === 'en'
                            ? `Code reset failed${detail}; conversation unchanged.`
                            : lang === 'zh-TW'
                            ? `程式碼重設失敗${detail}，對話未變更。`
                            : `代码重置失败${detail}，对话未变更。`;
                        }
                        setResetBanner({ kind: 'error', text });
                      }
                    } finally {
                      setResetInFlight(false);
                      setResetConfirmMsgId(null);
                    }
                  }}
                >
                  {resetInFlight
                    ? (settings.lang === 'en' ? 'Resetting…' : settings.lang === 'zh-TW' ? '重設中…' : '重置中…')
                    : (settings.lang === 'en' ? 'Reset' : settings.lang === 'zh-TW' ? '重設' : '重置')}
                </button>
              </div>
            </div>
          </div>
        )}
        </div>
        </div>
        <ConversationRoundsIndicator
          messages={visibleMessages}
          scrollContainerRef={messageListRef}
          onScrollToMessage={scrollToMessageInView}
          currentRoundIndex={viewportRoundIndex}
        />
      </div>

      {/* 输入区 */}
      <div className="px-4 py-3 border-t border-line bg-base">
        {!isConfigured && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-warn-bg bg-warn-bg px-4 py-3 text-sm text-warn">
            <span>{settingsError}</span>
            <button
              onClick={() => setShowSettings(true)}
              className="flex-shrink-0 rounded-lg border border-warn-bg px-3 py-1.5 text-xs font-medium text-warn transition-colors hover:border-warn hover:text-fg"
            >
              {t.toSettings}
            </button>
          </div>
        )}
          <div
            className="relative"
            ref={inputWrapperRef}
            onDragOver={handleComposerDragOver}
            onDrop={handleComposerDrop}
          >
            {slashFilter !== null && (
              <SlashCommandDropdown
                ref={slashDropdownRef}
                filter={slashFilter}
                workspacePath={workspacePath}
                lang={settings.lang}
                onSelect={handleSlashSelect}
                onDismiss={() => setSlashFilter(null)}
              />
            )}
            {atFilter !== null && (
              <AtMentionDropdown
                ref={atDropdownRef}
                filter={atFilter}
                items={mentionItems}
                onSelect={handleAtSelect}
                onDismiss={handleAtDismiss}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.html,.css,.yaml,.yml,.toml,.xml,.csv,.log,.env,.sh,.bash,.zsh,.rb,.swift,.kt,.dart,.vue,.svelte,.graphql,.sql,.prisma,.proto,.cmake,.editorconfig,.gitignore,.dockerignore,.php,.scss,.less,Dockerfile,image/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {pendingFiles.map((file) => (
                  <div key={file.id} className="group flex items-center gap-1 rounded-md border border-accent-soft bg-accent-soft px-2 py-1">
                    <svg className="w-3.5 h-3.5 flex-shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
                    </svg>
                    <span className="text-xs font-medium text-accent-text max-w-[140px] truncate" title={file.name}>{file.name}</span>
                    <button
                      type="button"
                      onClick={() => removePendingFile(file.id)}
                      title={t.cancel}
                      className="flex-shrink-0 ml-0.5 rounded-full p-0.5 text-accent hover:bg-accent-soft hover:text-fg transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-1.5">
                {pendingImages.map((image) => (
                  <div key={image.id} className="relative group">
                    <img
                      src={image.dataUri}
                      alt="pending"
                      className="h-10 w-10 rounded-lg border border-line object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(image.id)}
                      title={t.cancel}
                      className="absolute -right-1 -top-1 h-4 w-4 rounded-full border border-line bg-raised
                                 text-[9px] leading-none text-fg-soft hover:text-fg"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={`chat-input-box relative flex flex-col rounded-2xl border bg-raised px-3 pt-3 pb-2 transition-colors duration-200 ${isActiveLoading ? 'border-line' : 'border-line focus-within:border-accent-soft'}`}>
              <ChatInputTextarea
                ref={textareaRef}
                value={input}
                placeholder={
                  isConfigured
                    ? t.chatPlaceholderConfigured
                    : t.chatPlaceholderUnconfigured
                }
                onValueChange={handleDraftValueChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
              />
              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isActiveLoading}
                    title={t.attachFilesTitle}
                    className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-slate-700/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                  </button>
                  {voiceUiEnabled && activeCharacter && (
                  <div className="relative flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => handleTtsClick()}
                      disabled={ttsStarting || ttsServerStatus === 'starting'}
                      title={
                        ttsError
                          ? `TTS error: ${ttsError}`
                          : ttsServerStatus === 'starting' || ttsStarting
                            ? t.ttsServerStarting
                            : ttsInstalled === false
                              ? t.ttsNotInstalled
                              : ttsServerStatus === 'running' && ttsIsPlaying
                                ? t.ttsStop
                                : ttsServerStatus === 'running'
                                  ? (showTtsLog ? t.ttsHideLog : t.ttsViewLog).replace('{{count}}', String(ttsServerLog.length))
                                  : ttsServerStatus === 'error'
                                    ? `TTS server error${ttsError ? `: ${ttsError}` : ''}`
                                    : t.ttsClickToStart
                      }
                      className={`p-1.5 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-wait ${
                        ttsServerStatus === 'running'
                          ? 'text-ok hover:text-ok hover:bg-ok-bg'
                          : ttsServerStatus === 'error'
                            ? 'text-danger hover:bg-danger-bg'
                            : ttsServerStatus === 'starting' || ttsStarting
                              ? 'text-blue-400 hover:bg-blue-500/10'
                              : ttsInstalled === false
                                ? 'text-fg-muted hover:text-fg hover:bg-slate-700/50'
                                : 'text-warn hover:text-warn hover:bg-warn-bg'
                      } ${ttsIsPlaying || ttsStarting || ttsServerStatus === 'starting' ? 'animate-pulse' : ''} ${showTtsLog ? 'ring-1 ring-ok-bg' : ''}`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                      </svg>
                    </button>
                    <TtsStatusBadge status={ttsServerStatus} />
                    {ttsIsPlaying && (
                      <>
                        <button
                          type="button"
                          onClick={() => ttsSkip()}
                          title={t.ttsSkip}
                          className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-slate-700/50 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5M15.75 4.5v15" />
                          </svg>
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(ttsVolume * 100)}
                          onChange={(e) => ttsSetVolume(Number(e.target.value) / 100)}
                          title={t.ttsVolume}
                          className="w-16 accent-accent"
                        />
                      </>
                    )}
                    {showTtsLog && (
                      <div className="absolute bottom-full left-0 mb-1 w-[52rem] max-w-[calc(100vw-3rem)] rounded-xl border border-slate-600/40 bg-slate-900/95 backdrop-blur px-3 py-2.5 text-xs text-fg z-40 max-h-[420px] overflow-y-auto select-text whitespace-pre-wrap break-words font-mono shadow-xl">
                        <div className="flex items-center justify-between mb-2 pb-1.5 border-b border-slate-700/50 sticky top-0 bg-slate-900/95 z-10">
                          <span className="text-[11px] font-semibold text-fg-muted select-none">
                            {t.ttsServerLogTitle.replace('{{count}}', String(ttsServerLog.length))}
                          </span>
                          <div className="flex items-center gap-1.5 select-none">
                            <button
                              type="button"
                              onClick={() => ttsClearServerLog()}
                              className="text-[10px] text-fg-muted hover:text-fg-soft px-1.5 py-0.5 rounded transition-colors"
                              title={t.ttsClearLog}
                            >
                              {t.ttsClearLog}
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowTtsLog(false)}
                              className="text-fg-muted hover:text-fg-soft px-1"
                            >
                              ×
                            </button>
                          </div>
                        </div>
                        {ttsServerLog.length === 0 ? (
                          <div className="text-fg-dim italic text-[11px]">{t.ttsNoLog}</div>
                        ) : (
                          ttsServerLog.map((entry, i) => (
                            <div
                              key={`${entry.ts}-${i}-${entry.stream}`}
                              className={`text-[10px] leading-snug ${
                                entry.stream === 'stderr'
                                  ? 'text-warn'
                                  : entry.stream === 'system'
                                    ? 'text-info'
                                    : 'text-fg-muted'
                              }`}
                            >
                              {entry.line}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                    {ttsError && (
                      <div className="absolute bottom-full left-0 mb-1 w-96 rounded-xl border border-danger-bg bg-danger-bg px-3 py-2 text-xs text-danger z-30 max-h-[480px] overflow-auto whitespace-pre-wrap break-words">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0 font-mono text-[11px] leading-relaxed">{ttsError}</div>
                          <button
                            type="button"
                            onClick={ttsClearError}
                            className="shrink-0 text-danger hover:text-danger"
                          >
                            ×
                          </button>
                        </div>
                        {ttsServerLog.length > 0 && (
                          <details className="mt-2 border-t border-danger-bg pt-2">
                            <summary className="cursor-pointer text-[11px] font-semibold text-danger hover:text-danger">
                              {t.ttsViewFullLog.replace('{{count}}', String(ttsServerLog.length))}
                            </summary>
                            <div className="mt-2 font-mono text-[10px] leading-snug">
                              {ttsServerLog.map((entry, i) => (
                                <div
                                  key={i}
                                  className={
                                    entry.stream === 'stderr'
                                      ? 'text-warn'
                                      : entry.stream === 'system'
                                        ? 'text-info'
                                        : 'text-fg-soft'
                                  }
                                >
                                  {entry.line}
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                    {!ttsError && (ttsServerStatus === 'starting' || ttsStarting) && ttsServerLog.length > 0 && (
                      <div className="absolute bottom-full left-0 mb-1 w-80 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-[11px] text-blue-100 z-30 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
                        <div className="text-blue-300 mb-1 font-semibold">TTS 启动日志（实时）</div>
                        {ttsServerLog.slice(-6).map((entry, i) => (
                          <div key={i} className={entry.stream === 'stderr' ? 'text-warn' : entry.stream === 'system' ? 'text-info' : 'text-blue-100'}>
                            {entry.line}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  )}
                  <ModeSelector
                    mode={mode}
                    setMode={setMode}
                    isLoading={isActiveLoading}
                    lang={settings.lang ?? 'zh-CN'}
                    sessionLock={sessionLock}
                  />
                  {onOpenProjectSwitcher && (
                    <button
                      type="button"
                      onClick={onOpenProjectSwitcher}
                      title={t.switchProjectTip}
                      className="flex min-w-0 max-w-[160px] items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-fg-muted hover:text-fg hover:bg-slate-700/50 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                      </svg>
                      <span className="truncate">{workspacePath ? pathBasename(workspacePath) : t.unselected}</span>
                      <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  )}
                  {onOpenProjectConfig && (
                    <button
                      type="button"
                      onClick={onOpenProjectConfig}
                      disabled={!workspacePath}
                      title={t.projectConfigTip}
                      className="flex-shrink-0 p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-slate-700/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v4m0 4v8m0-8a2 2 0 100-4 2 2 0 000 4zm6-4v12m0 0a2 2 0 100 4 2 2 0 000-4zm6-12v2m0 4v10m0-10a2 2 0 100-4 2 2 0 000 4z" />
                      </svg>
                    </button>
                  )}
                </div>
                {isActiveLoading ? (
                  <button
                    onClick={() => {
                      ttsStop();
                      cancelMessage();
                    }}
                    className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-danger"
                  >
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                      <rect x="2" y="2" width="12" height="12" rx="1" />
                    </svg>
                    {t.cancel}
                  </button>
                ) : (
                  <button
                    onClick={() => { void handlePrimaryAction(); }}
                    disabled={!canSubmit}
                    title={otherSessionRunning ? t.anotherSessionRunning : undefined}
                    className={`p-1.5 rounded-lg transition-colors shadow-sm flex items-center justify-center
                      ${canSubmit
                        ? 'bg-slate-200 text-slate-900 hover:bg-white'
                        : 'bg-raised text-fg-muted'}
                      disabled:cursor-not-allowed`}
                  >
                    <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M12 19V5m-7 7l7-7 7 7" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

      {/* 图片预览灯箱 */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay backdrop-blur-sm cursor-pointer"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            alt="preview"
            className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain"
          />
        </div>
      )}

      {showInstaller && voiceUiEnabled && (
        <TtsInstaller
          onClose={() => {
            setShowInstaller(false);
            void ttsRefreshInstalled();
          }}
        />
      )}
    </div>
  );
});
