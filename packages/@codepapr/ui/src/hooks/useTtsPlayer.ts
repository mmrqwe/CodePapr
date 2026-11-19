import { useRef, useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { toast } from '../store/toastStore';
import { useAgentStore } from '../store/agentStore';
import { getTranslation } from '../utils/i18n';
import type { TtsPlaybackMode } from '../utils/characterTypes';
import {
  sanitizeForSpeech,
  splitSentences,
  pickSteps,
  mergeShortSentences,
  createFeedState,
  planFeed,
  dedupParts,
  type FeedState,
  type SpeechSanitizeMode,
} from './useTtsPlayer.helpers';

export { sanitizeForSpeech } from './useTtsPlayer.helpers';

function safeInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof invoke !== 'function') return Promise.reject(new Error('invoke unavailable'));
  return Promise.resolve(invoke(cmd, args)) as Promise<T>;
}

function safeListen<T = unknown>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  if (typeof listen !== 'function') return Promise.resolve(() => {});
  return listen(event, handler);
}

export type TtsServerStatus = 'unknown' | 'starting' | 'running' | 'stopped' | 'error';

export interface TtsInstallStatus {
  installed: boolean;
  api_py: boolean;
  venv_ok: boolean;
  models_ok: boolean;
}

export interface TtsServerLogLine {
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  ts: number;
}

export interface UseTtsPlayerReturn {
  /** True while audio is playing */
  isPlaying: boolean;
  /** Last error message, if any */
  lastError: string | null;
  clearError: () => void;
  /** Server running status */
  serverStatus: TtsServerStatus;
  /** Model version the server reported ("v1"/"v4"/etc). Empty until server starts. */
  serverModelVersion: string;
  /** Whether the server is running in half precision mode. */
  serverHalfPrecision: boolean;
  /** Device the server is running on ("mps", "cuda", or "cpu"). */
  serverDevice: string;
  refreshServerStatus: () => Promise<void>;
  /** Whether GPT-SoVITS is installed */
  installed: boolean | null;
  refreshInstalled: () => Promise<TtsInstallStatus | null>;
  /** Fire-and-forget start server. modelVersion: 'v4' (default) or 'v1'. fineTunedModelPath: optional path to load after start. */
  startServer: (modelVersion?: string, fineTunedModelPath?: string) => void;
  /** Feed streaming text for auto-speak */
  feedStream: (fullText: string, forceComplete?: boolean, messageId?: string) => void;
  /** Stop current playback */
  stop: () => void;
  /** Skip current sentence (advances queue) */
  skip: () => void;
  /** Replay the last spoken text */
  replayLast: () => void;
  /** Replay a specific text */
  replayText: (text: string) => void;
  /** Set voice config from character (reference audio + prompt). */
  setVoiceConfig: (refPath: string, promptText: string, promptLang: string) => void;
  /** Set the spoken text language independently of the reference audio language. */
  setTextLanguage: (textLang: string) => void;
  /** Set the default voice model name */
  setVoiceModel: (modelName: string) => void;
  /** Set the fine-tuned model path for this character */
  setFineTunedModel: (modelPath: string) => void;
  /** Preload a SoVITS model on the running server (without synthesising). */
  preloadModel: (modelPath: string) => Promise<void>;
  /** Set sentences-per-chunk for ws-batch mode (1-5) */
  setSentencesPerChunk: (n: number) => void;
  /** Set playback strategy (Mode A / B / F / WS). */
  setPlaybackMode: (mode: TtsPlaybackMode) => void;
  /** Set sample steps for speed/quality trade-off (4-32). */
  setSampleSteps: (steps: number) => void;
  /** Set playback speed (0.5-2.0). */
  setSpeed: (speed: number) => void;
  /** Set character interaction mode so sanitizer keeps persona glosses. */
  setInteractionMode: (mode: SpeechSanitizeMode) => void;
  /** Playback volume 0-2. */
  volume: number;
  setVolume: (volume: number) => void;
  /** Re-open the default output device after headphones are swapped. */
  resetAudioDevice: () => Promise<void>;
  /** Warm up the running CUDA or MPS synthesis backend. */
  warmupGpu: () => Promise<void>;
  /** Clone a voice: send reference audio + text to GPT-SoVITS */
  cloneVoice: (characterId: string, text: string) => Promise<void>;
  /** Save uploaded voice audio to disk, returns file path */
  saveVoiceFile: (characterId: string, base64Data: string, extension: string) => Promise<string>;
  /** Streaming log lines from the GPT-SoVITS server (rolling, capped) */
  serverLog: TtsServerLogLine[];
  clearServerLog: () => void;
}

export function useTtsPlayer(): UseTtsPlayerReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<TtsServerStatus>('unknown');
  const [serverModelVersion, setServerModelVersion] = useState<string>('');
  const [serverHalfPrecision, setServerHalfPrecision] = useState<boolean>(false);
  const [serverDevice, setServerDevice] = useState<string>('');
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [serverLog, setServerLog] = useState<TtsServerLogLine[]>([]);
  const [volume, setVolumeState] = useState(1);
  const interactionModeRef = useRef<SpeechSanitizeMode>('persona');
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const abortedRef = useRef(false);
  // The messageId that was active when `stop()` was last invoked. While the
  // same message keeps streaming in, `feedStream` ignores its frames so a
  // mid-stream stop doesn't restart playback from the beginning (resetting
  // `feedStateRef` alone would make the next frame look like brand-new
  // content). Cleared as soon as a different messageId arrives.
  const stoppedMessageIdRef = useRef<string | undefined>(undefined);
  // Set by `skip()` so the consumer loop can tell a user-initiated skip
  // (backend aborts because we called `tts_stop_playback`) apart from a
  // genuine synthesis failure. Without this, each skip counts toward
  // `errorCountRef` and three skips would wrongly drop the whole queue.
  const skipRef = useRef(false);
  // Consolidated feed-state (cursor + dedup keys). See `planFeed`.
  // Holding these on a single object makes the pure-function reducer in
  // `useTtsPlayer.helpers` exhaustively testable.
  const feedStateRef = useRef<FeedState>(createFeedState());
  const errorCountRef = useRef(0);
  const errorCooldownUntilRef = useRef(0);
  const lastSpokenTextRef = useRef<string>('');
  const voiceModelRef = useRef('');
  const fineTunedModelRef = useRef('');
  const refAudioPathRef = useRef('');
  const promptTextRef = useRef('');
  const promptLangRef = useRef('zh');
  const textLangRef = useRef('zh');
  const playbackModeRef = useRef<TtsPlaybackMode>('ws-batch');
  const sampleStepsRef = useRef<number>(8);
  const speedRef = useRef<number>(1.0);
  const sentencesPerChunkRef = useRef<number>(3);
  const pcmFallbackWarnedRef = useRef(false);
  const pendingStopRef = useRef<Promise<unknown> | null>(null);
  const startSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The startup status-poll interval. Kept on a ref (like the safety timer)
  // so it can be cleared on unmount — otherwise a start begun mid-lifecycle
  // would keep polling `tts_server_status` for up to 120s after the component
  // is gone.
  const startPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modelPreloadedRef = useRef(false);

  const setPlaybackMode = useCallback((mode: TtsPlaybackMode) => {
    playbackModeRef.current = mode;
  }, []);

  const setSampleSteps = useCallback((steps: number) => {
    sampleStepsRef.current = Math.max(4, Math.min(32, steps));
  }, []);

  const setSpeed = useCallback((speed: number) => {
    speedRef.current = Math.max(0.5, Math.min(2.0, speed));
  }, []);

  const setInteractionMode = useCallback((mode: SpeechSanitizeMode) => {
    interactionModeRef.current = mode;
  }, []);

  const setVolume = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(2, next));
    setVolumeState(clamped);
    safeInvoke('tts_set_volume', { volume: clamped }).catch(() => {});
  }, []);

  const resetAudioDevice = useCallback(async () => {
    await safeInvoke('tts_reset_audio_device');
  }, []);

  const setSentencesPerChunk = useCallback((n: number) => {
    sentencesPerChunkRef.current = Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 3;
  }, []);

  const clearError = useCallback(() => setLastError(null), []);
  const clearServerLog = useCallback(() => setServerLog([]), []);

  // `refreshServerStatus` is called once on mount + when the user explicitly
  // wants to re-check. It must NEVER overwrite `running` with `stopped` while
  // the server is mid-warmup, to avoid misleading the user into thinking the
  // start failed and clicking again (which would spawn a duplicate process).
  // However, once we know the server was running and is now not responding,
  // we should show `stopped` — otherwise a PID-reuse false-alive watchdog
  // race leaves the UI stuck on `running` forever.
  const refreshServerStatus = useCallback(async () => {
    try {
      const running = await safeInvoke<boolean>('tts_server_status');
      if (running) {
        setServerStatus('running');
      } else {
        setServerStatus((prev) => {
          if (prev === 'starting') return prev;
          return 'stopped';
        });
      }
    } catch {
      setServerStatus((prev) => {
        if (prev === 'starting') return prev;
        return 'stopped';
      });
    }
  }, []);

  const refreshInstalled = useCallback(async (): Promise<TtsInstallStatus | null> => {
    try {
      const status = await safeInvoke<TtsInstallStatus>('tts_check_installed');
      setInstalled(status.installed);
      return status;
    } catch {
      setInstalled(false);
      return null;
    }
  }, []);

  const startServer = useCallback((modelVersion?: string, fineTunedModelPath?: string) => {
    // Clear stale errors / logs from previous attempts so the user sees fresh
    // output for this run.
    setLastError(null);
    setServerLog([]);
    setServerStatus('starting');
    // Reset the first-synth hint flag so it fires again for the new server
    // lifecycle. The event listener does this too, but this covers the case
    // where the event is dropped or the listener hasn't registered yet.
    firstSynthHintShownRef.current = false;
    safeInvoke('tts_server_start', { modelVersion: modelVersion ?? 'v4', fineTunedModelPath: fineTunedModelPath ?? '' })
      .then(() => {
        // Backend returned Ok immediately; the actual startup runs in a
        // background thread that will emit `tts-server-started` /
        // `tts-server-error` when done.
        // We poll only as a safety net (in case events get dropped), and
        // never downgrade `starting` — we only confirm `running`.
        const poll = setInterval(async () => {
          try {
            const running = await safeInvoke<boolean>('tts_server_status');
            if (running) {
              setServerStatus('running');
              clearInterval(poll);
              startPollRef.current = null;
              // Reference the timer via its ref (not a local captured before
              // its initialiser) so there is no temporal-dead-zone ordering
              // hazard between the interval and the timeout.
              if (startSafetyTimerRef.current !== null) {
                clearTimeout(startSafetyTimerRef.current);
                startSafetyTimerRef.current = null;
              }
            }
          } catch {
            // Ignore transient invoke errors during startup.
          }
        }, 2000);
        startPollRef.current = poll;
        // After 120s of waiting, give up the polling. Don't change status
        // here — by then the error event will have already fired (or the
        // user can read the streaming log).
        const safetyTimer = setTimeout(() => {
          clearInterval(poll);
          startPollRef.current = null;
          startSafetyTimerRef.current = null;
        }, 120_000);
        startSafetyTimerRef.current = safetyTimer;
      })
      .catch((e) => {
        // Synchronous start error: usually means another start is already
        // in flight, or the lock is held.
        setLastError(`Failed to start server: ${e}`);
        setServerStatus('error');
        if (startSafetyTimerRef.current !== null) {
          clearTimeout(startSafetyTimerRef.current);
          startSafetyTimerRef.current = null;
        }
        if (startPollRef.current !== null) {
          clearInterval(startPollRef.current);
          startPollRef.current = null;
        }
      });
  }, []);

  const saveVoiceFile = useCallback(async (characterId: string, base64Data: string, extension: string): Promise<string> => {
    const path = await safeInvoke<string>('tts_save_voice_file', { characterId, base64Data, extension });
    return path;
  }, []);

  const cloneVoice = useCallback(async (characterId: string, text: string) => {
    const path = refAudioPathRef.current;
    if (!path) throw new Error('No reference audio uploaded');
    const baseArgs: Record<string, unknown> = {
      text,
      refAudioPath: path,
      speed: speedRef.current,
    };
    if (fineTunedModelRef.current) {
      baseArgs.modelName = fineTunedModelRef.current;
    } else if (voiceModelRef.current) {
      baseArgs.modelName = voiceModelRef.current;
    }
    await safeInvoke('tts_synthesize_and_play', baseArgs);
  }, []);

  const warmupGpu = useCallback(async () => {
    await safeInvoke('tts_warmup_gpu');
  }, []);

  const synthesize = useCallback(async (parts: string[], mode: TtsPlaybackMode) => {
    if (!firstSynthHintShownRef.current && serverDeviceRef.current === 'mps') {
      firstSynthHintShownRef.current = true;
      toast.info(getTranslation(useAgentStore.getState().settings.lang).ttsFirstSynthHint, {
        durationMs: 8000,
      });
    }
    const baseArgs: Record<string, unknown> = {
      sampleSteps: Math.max(...parts.map((part) => pickSteps(part, sampleStepsRef.current))),
      speed: speedRef.current,
    };
    if (fineTunedModelRef.current) {
      baseArgs.modelName = fineTunedModelRef.current;
    } else if (voiceModelRef.current) {
      baseArgs.modelName = voiceModelRef.current;
    }
    if (refAudioPathRef.current) {
      baseArgs.refAudioPath = refAudioPathRef.current;
      baseArgs.promptText = promptTextRef.current;
      baseArgs.promptLanguage = promptLangRef.current;
      baseArgs.textLanguage = textLangRef.current;
    }
    if (mode === 'ws-batch') {
      await safeInvoke('tts_synthesize_batch_ws', { ...baseArgs, sentences: parts });
      return;
    }

    const text = parts[0];
    const reset = pendingStopRef.current;
    try {
      await safeInvoke('tts_synthesize_and_play', { ...baseArgs, text, playbackMode: mode });
    } catch (e) {
      // streamed-pcm is experimental — fall back to streamed-pipeline on error.
      if (mode === 'streamed-pcm' && pendingStopRef.current === reset) {
        if (!pcmFallbackWarnedRef.current) {
          pcmFallbackWarnedRef.current = true;
          console.warn('[tts] streamed-pcm failed, falling back to streamed-pipeline:', e);
        }
        await safeInvoke('tts_synthesize_and_play', {
          ...baseArgs,
          text,
          playbackMode: 'streamed-pipeline',
        });
      } else {
        throw e;
      }
    }
  }, []);

  /**
   * Consumer loop that drains `queueRef` one batch/sentence at a time.
   *
   * State machine invariants:
   *  - `processingRef` is a single-entry guard — concurrent calls from
   *    `feedStream` while a previous loop is still running re-enter
   *    immediately after `processingRef` is released, so they naturally
   *    pick up new items pushed to `queueRef` in the meantime.
   *  - `abortedRef` short-circuits the loop (set by `stop()`).
   *  - `isPlaying` stays true until the rodio sink actually drains
   *    (`tts-playback-ended` / `tts_is_playing`), not when the queue empties.
   *  - After releasing `processingRef`, a non-empty queue re-enters
   *    `processQueue` so a late enqueue during the last iteration is not stuck.
   *  - `errorCountRef` accumulates across batches; after 3 consecutive
   *    failures the queue is dropped and the server is marked `error`.
   */
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setIsPlaying(true);

    const releaseAndMaybeContinue = () => {
      processingRef.current = false;
      if (abortedRef.current) return;
      if (queueRef.current.length > 0) {
        void processQueue();
        return;
      }
      void safeInvoke<boolean>('tts_is_playing')
        .then((playing) => {
          if (
            !playing
            && queueRef.current.length === 0
            && !processingRef.current
            && !abortedRef.current
          ) {
            setIsPlaying(false);
          }
        })
        .catch(() => {});
    };

    while (queueRef.current.length > 0) {
      if (pendingStopRef.current) await pendingStopRef.current;
      if (abortedRef.current || queueRef.current.length === 0) break;

      const mode = playbackModeRef.current;
      const count = mode === 'ws-batch' ? sentencesPerChunkRef.current : 1;
      const batch = queueRef.current.splice(0, count);

      try {
        await synthesize(batch, mode);
        errorCountRef.current = 0;
        skipRef.current = false;
      } catch (e) {
        if (abortedRef.current) break;
        // A skip aborts the in-flight synthesis via tts_stop_playback; treat
        // it as "advance to the next sentence", not a failure, so repeated
        // skips don't trip the consecutive-error circuit breaker.
        if (skipRef.current || String(e).includes('Synthesis cancelled by user')) {
          skipRef.current = false;
          errorCountRef.current = 0;
          continue;
        }
        errorCountRef.current++;
        if (errorCountRef.current <= 1) {
          setLastError(String(e));
        }
        if (errorCountRef.current >= 3) {
          queueRef.current = [];
          setServerStatus('error');
          errorCooldownUntilRef.current = Date.now() + 10_000;
          break;
        }
      }
    }

    releaseAndMaybeContinue();
  }, [synthesize]);

  const enqueue = useCallback((parts: string[]) => {
    // Defensive dedup: skip a chunk that is byte-identical to the most
    // recently enqueued one. Prevents user-visible duplicate playback when
    // any upstream code path accidentally re-feeds the same content
    // (race between streaming/finalize effects, content normalization by
    // the message store, StrictMode double-invocation, etc.).
    const { kept, lastEnqueued } = dedupParts(parts, feedStateRef.current.lastEnqueued);
    feedStateRef.current.lastEnqueued = lastEnqueued;
    if (kept.length === 0) return;
    for (const part of kept) {
      queueRef.current.push(part);
    }
    processQueue();
  }, [processQueue]);

  /**
   * Feed raw streaming text from the AI. The cursor tracks position in
   * the *raw* fullText (which is monotonic-increasing as the AI appends).
   *
   * To avoid speaking unclosed roleplay action descriptors (e.g. an
   * `*嘴角微扬` whose closing `*` hasn't streamed in yet), we only commit
   * up through the last *safe split point*: the position where every
   * inline marker is balanced AND the last char is sentence-end
   * punctuation. Everything after that boundary stays buffered until a
   * later frame closes it (or `forceComplete` flushes the tail).
   */
  const feedStream = useCallback(
    (fullText: string, forceComplete?: boolean, messageId?: string) => {
      if (!fullText) return;

      // Run the pure decision function — it tells us either to do nothing
      // (e.g. finalize was already done for this messageId; or no safe
      // split exists yet) or to emit a chunk of raw text. The returned
      // `state` is the new value for `feedStateRef`. All idempotence,
      // new-message detection, and cursor accounting live there.
      const { state, action } = planFeed(
        feedStateRef.current,
        fullText,
        forceComplete === true,
        messageId,
        playbackModeRef.current === 'whole' ? 'whole' : 'streaming',
      );
      feedStateRef.current = state;

      // A mid-stream `stop()` arms `stoppedMessageIdRef`. Ignore any further
      // frames of that same message so playback does NOT resume from the top;
      // a different messageId means a new turn started, so disarm and proceed.
      if (stoppedMessageIdRef.current !== undefined) {
        if (messageId === stoppedMessageIdRef.current) return;
        stoppedMessageIdRef.current = undefined;
      }

      abortedRef.current = false;
      if (Date.now() > errorCooldownUntilRef.current) {
        errorCountRef.current = 0;
        if (errorCooldownUntilRef.current > 0) {
          setServerStatus('running');
          errorCooldownUntilRef.current = 0;
        }
      }
      lastSpokenTextRef.current = fullText;

      if (action.type === 'noop') return;

      // Whole-mode emission: send the entire passage as one unit. We bypass
      // sentence splitting (the synthesizer handles its own internal segmentation
      // in this mode) but still run sanitize to strip code blocks / markdown.
      if (action.isWholeMode) {
        const cleaned = sanitizeForSpeech(action.chunkToSpeak, interactionModeRef.current);
        if (cleaned) enqueue([cleaned]);
        return;
      }

      // Streaming-mode emission: sanitize → split → merge → chunk → enqueue.
      const cleaned = sanitizeForSpeech(action.chunkToSpeak, interactionModeRef.current);
      if (!cleaned) return;

      const { sentences, lastEnd } = splitSentences(cleaned);
      const remainder = cleaned.slice(lastEnd).trim();
      if (remainder) sentences.push(remainder);

      enqueue(mergeShortSentences(sentences));
    },
    [enqueue],
  );

  const resetPlayback = useCallback(() => {
    const pending = safeInvoke('tts_stop_playback').catch(() => {});
    pendingStopRef.current = pending;
    return pending;
  }, []);

  const stop = useCallback(() => {
    abortedRef.current = true;
    skipRef.current = false;
    // Ignore late streaming frames for the message the user stopped.
    stoppedMessageIdRef.current = feedStateRef.current.lastMessageId;
    queueRef.current = [];
    feedStateRef.current = createFeedState();
    setIsPlaying(false);
    return resetPlayback();
  }, [resetPlayback]);

  const skip = useCallback(() => {
    skipRef.current = processingRef.current;
    void resetPlayback();
  }, [resetPlayback]);

  const replayText = useCallback((text: string) => {
    const cleaned = sanitizeForSpeech(text, interactionModeRef.current);
    if (!cleaned) return;

    const reset = stop();
    void reset.then(() => {
      if (pendingStopRef.current !== reset || !abortedRef.current) return;
      abortedRef.current = false;
      if (playbackModeRef.current === 'whole') {
        enqueue([cleaned]);
        return;
      }
      const { sentences, lastEnd } = splitSentences(cleaned);
      const remainder = cleaned.slice(lastEnd).trim();
      if (remainder) sentences.push(remainder);
      enqueue(mergeShortSentences(sentences));
    });
  }, [stop, enqueue]);

  const replayLast = useCallback(() => {
    const text = lastSpokenTextRef.current;
    if (text) replayText(text);
  }, [replayText]);

  const setVoiceConfig = useCallback((refPath: string, promptText: string, promptLang: string) => {
    refAudioPathRef.current = refPath;
    promptTextRef.current = promptText;
    promptLangRef.current = promptLang;
  }, []);

  const setTextLanguage = useCallback((textLang: string) => {
    textLangRef.current = textLang;
  }, []);

  const setVoiceModel = useCallback((modelName: string) => {
    voiceModelRef.current = modelName;
  }, []);

  const setFineTunedModel = useCallback((modelPath: string) => {
    fineTunedModelRef.current = modelPath;
  }, []);

  const preloadModel = useCallback(async (modelPath: string) => {
    fineTunedModelRef.current = modelPath;
    modelPreloadedRef.current = true;
    await safeInvoke('tts_set_model', { modelName: modelPath || '' });
  }, []);

  // The compute backend the running server reports it's using ("mps" / "cpu").
  // Used to give the user a one-time hint that the FIRST synthesis on MPS
  // will be slow due to Metal kernel JIT compilation.
  const serverDeviceRef = useRef<string>('');
  const firstSynthHintShownRef = useRef<boolean>(false);

  // Server lifecycle event listeners for instant status updates.
  const unlistenFnsRef = useRef<UnlistenFn[]>([]);
  useEffect(() => {
    // listen() 是异步注册：组件在 promise 解析前卸载时，cleanup 跑完时 fns
    // 还是空的，晚到的监听器会永久泄漏。用 disposed 标志兜底。
    let disposed = false;
    const fns: UnlistenFn[] = [];
    const track = (pending: Promise<UnlistenFn>): void => {
      void pending.then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        fns.push(fn);
      });
    };
    track(safeListen<{ device: string; model_version: string; half_precision: boolean } | null>('tts-server-started', (event) => {
      const payload = event.payload;
      const device = (payload && typeof payload === 'object' && typeof payload.device === 'string')
        ? payload.device
        : '';
      serverDeviceRef.current = device;
      setServerDevice(device);
      const mv = (payload && typeof payload === 'object' && typeof payload.model_version === 'string')
        ? payload.model_version
        : '';
      setServerModelVersion(mv);
      const hp = (payload && typeof payload === 'object' && typeof payload.half_precision === 'boolean')
        ? payload.half_precision
        : false;
      setServerHalfPrecision(hp);
      // Reset the "first synth" flag for this server lifecycle so a restart
      // re-shows the hint (Metal kernel cache is per-process).
      firstSynthHintShownRef.current = false;
      modelPreloadedRef.current = false;
      setServerStatus('running');
    }));
    track(safeListen('tts-playback-ended', () => {
      if (queueRef.current.length === 0 && !processingRef.current && !abortedRef.current) {
        setIsPlaying(false);
      }
    }));
    track(safeListen('tts-server-error', (event: { payload: string }) => {
      const msg = typeof event.payload === 'string' ? event.payload : 'Unknown error';
      setLastError(`Server: ${msg}`);
      setServerStatus('error');
    }));
    track(safeListen('tts-server-stopped', () => {
      setServerStatus('stopped');
      // Status now reaps a dead Python handle, so the next start is not
      // rejected as "already running".
      void safeInvoke('tts_server_status').catch(() => {});
    }));
    track(safeListen<{ stream: 'stdout' | 'stderr' | 'system'; line: string }>(
      'tts-server-log',
      (event) => {
        const payload = event.payload;
        if (!payload || typeof payload !== 'object') return;
        const line = typeof payload.line === 'string' ? payload.line : '';
        const stream: 'stdout' | 'stderr' | 'system' =
          payload.stream === 'stderr' || payload.stream === 'system' ? payload.stream : 'stdout';
        if (!line) return;
        setServerLog((prev) => {
          const entry: TtsServerLogLine = { stream, line, ts: Date.now() };
          const next = [...prev, entry];
          // Cap at 1000 lines to keep memory + render cost bounded.
          return next.length > 1000 ? next.slice(next.length - 1000) : next;
        });
      },
    ));
    unlistenFnsRef.current = fns;
    return () => {
      disposed = true;
      unlistenFnsRef.current.forEach((fn) => fn());
    };
  }, []);

  // Set voice model and ref audio path externally

  useEffect(() => {
    void refreshServerStatus();
    void refreshInstalled();
    return () => {
      if (startSafetyTimerRef.current !== null) {
        clearTimeout(startSafetyTimerRef.current);
        startSafetyTimerRef.current = null;
      }
      if (startPollRef.current !== null) {
        clearInterval(startPollRef.current);
        startPollRef.current = null;
      }
    };
  }, [refreshServerStatus, refreshInstalled]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    isPlaying,
    lastError,
    clearError,
    serverStatus,
    serverModelVersion,
    serverHalfPrecision,
    serverDevice,
    refreshServerStatus,
    installed,
    refreshInstalled,
    startServer,
    feedStream,
    stop,
    skip,
    replayLast,
    replayText,
    setVoiceConfig,
    setTextLanguage,
    setVoiceModel,
    setFineTunedModel,
    preloadModel,
    setSentencesPerChunk,
    setPlaybackMode,
    setSampleSteps,
    setSpeed,
    setInteractionMode,
    volume,
    setVolume,
    resetAudioDevice,
    warmupGpu,
    cloneVoice,
    saveVoiceFile,
    serverLog,
    clearServerLog,
  } as UseTtsPlayerReturn;
}
