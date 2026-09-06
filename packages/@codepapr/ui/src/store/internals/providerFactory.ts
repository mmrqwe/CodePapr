import {
  ClaudeProvider,
  DEFAULT_LOCAL_BASE_URL,
  DeepSeekProvider,
  LocalProvider,
  OpenAIProvider,
  ResponseProvider,
} from '@codepapr/api';
import { resolveProviderName } from './settingsNormalizer';
import type { ApiFormat, ApiMode, ModelProfile } from './types';

export function buildProviderInstance(
  s: { apiMode: ApiMode; apiFormat: ApiFormat; apiKey: string; baseURL: string; streamIdleTimeoutMs?: number }
) {
  const idleTimeoutMs = s.streamIdleTimeoutMs ?? 30000;
  if (s.apiMode === 'local') {
    return new LocalProvider({
      apiKey: s.apiKey.trim() || 'local',
      baseURL: s.baseURL.trim().replace(/\/+$/, '') || DEFAULT_LOCAL_BASE_URL,
      idleTimeoutMs,
    });
  }

  const cfg: { apiKey: string; baseURL?: string; idleTimeoutMs?: number } = {
    apiKey: s.apiKey.trim(),
    idleTimeoutMs,
  };
  if (s.apiMode === 'custom') {
    cfg.baseURL = s.baseURL.trim().replace(/\/+$/, '');
  }

  switch (resolveProviderName(s)) {
    case 'deepseek': return new DeepSeekProvider(cfg);
    case 'openai': return new OpenAIProvider(cfg);
    case 'response': return new ResponseProvider(cfg);
    case 'claude': return new ClaudeProvider(cfg);
  }
}

export function buildProviderForProfile(
  profile: ModelProfile,
  streamIdleTimeoutMs: number = 30000
) {
  return buildProviderInstance({
    apiMode: profile.apiMode,
    apiFormat: profile.apiFormat,
    apiKey: profile.apiKey,
    baseURL: profile.baseURL,
    streamIdleTimeoutMs,
  });
}

export { toWorkerAgentSettings, resolveWorkerMultimodalEnabled } from './workerSettings';

export function shouldUseWorkerAgentRuntime(): boolean {
  if (typeof Worker === 'undefined') {
    return false;
  }

  if (import.meta.env?.MODE === 'test') {
    return false;
  }

  if (typeof navigator !== 'undefined' && /jsdom|happy-dom/i.test(navigator.userAgent)) {
    return false;
  }

  const override = agentRuntimeOverride();
  if (override === 'worker') {
    return true;
  }
  if (override === 'main' || override === 'sidecar') {
    return false;
  }
  // Tauri default is the Node sidecar. Worker is emergency rollback only.
  // Non-Tauri browser (vite preview) still uses a Worker.
  return !isTauriRuntime();
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function agentRuntimeOverride(): string | null {
  try {
    const fromStorage = localStorage.getItem('codepapr-agent-runtime');
    if (fromStorage && fromStorage.trim()) {
      return fromStorage.trim().toLowerCase();
    }
  } catch {
    // private mode / non-browser
  }
  const fromEnv = import.meta.env?.VITE_AGENT_RUNTIME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim().toLowerCase();
  }
  return null;
}

/** Desktop P2: Node sidecar unless explicitly rolled back to `worker` or `main`. */
export function shouldUseSidecarAgentRuntime(): boolean {
  if (import.meta.env?.MODE === 'test') {
    return false;
  }
  if (typeof navigator !== 'undefined' && /jsdom|happy-dom/i.test(navigator.userAgent)) {
    return false;
  }
  const override = agentRuntimeOverride();
  if (override === 'worker' || override === 'main') {
    return false;
  }
  if (override === 'sidecar') {
    return true;
  }
  return isTauriRuntime();
}
