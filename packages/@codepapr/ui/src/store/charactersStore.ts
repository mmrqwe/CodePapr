import { create } from 'zustand';
import {
  type CharacterProfile,
  type CharactersStateFile,
  buildCharacterSystemPrompt,
} from '../utils/characterTypes';
import { loadCharactersState, saveCharactersState } from '../utils/characterStorage';
import {
  deleteCharacterAvatar,
  hydrateCharacterAvatars,
  persistCharacterAvatar,
  stripAvatarDataUrl,
} from '../utils/characterAvatar';
import { toast } from './toastStore';
import { useAgentStore } from './agentStore';
import { saveCurrentProjectState } from './internals/projectSnapshot';

interface CharacterState {
  loaded: boolean;
  loading: boolean;
  characters: CharacterProfile[];
  activeCharacterId: string | null;
}

interface CharacterActions {
  loadCharacters: () => Promise<void>;
  upsertCharacter: (character: CharacterProfile) => Promise<boolean>;
  deleteCharacter: (characterId: string) => Promise<void>;
  setActiveCharacter: (characterId: string | null) => Promise<void>;
}

function buildStateFile(state: CharacterState): CharactersStateFile {
  return {
    version: 1,
    activeCharacterId: null,
    characters: state.characters.map(stripAvatarDataUrl),
  };
}

// Serialise persistence so concurrent mutations cannot write the JSON blob
// out of order. Each mutation enqueues a snapshot of its post-mutation state;
// the chain guarantees the latest (most complete) snapshot is the final thing
// written to disk. A failed save is surfaced to the user rather than letting
// in-memory state silently diverge from what is persisted.
//
// Every link resolves to a boolean (persisted / not persisted) and never
// rejects: a rejected chain would be "poisoned" — all later `.then()` links
// would skip their callback and saving would stop silently forever.
let saveChain: Promise<boolean> = Promise.resolve(true);
let loadInFlight: Promise<void> | null = null;

/** A hung IPC call must not block the save chain forever. */
const SAVE_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function persistState(state: CharacterState): Promise<boolean> {
  if (!state.loaded) {
    toast.error('角色数据尚未加载成功，已跳过保存以免覆盖已有角色卡。');
    return Promise.resolve(false);
  }
  const file = buildStateFile(state);
  saveChain = saveChain.then(async () => {
    try {
      await withTimeout(saveCharactersState(file), SAVE_TIMEOUT_MS, '角色数据保存');
      return true;
    } catch (err) {
      console.warn('Failed to persist characters state:', err);
      toast.error('角色数据保存失败，最近的更改可能未被持久化。');
      return false;
    }
  });
  return saveChain;
}

/** 等待角色卡保存链全部落库（退出前 flush 用）。 */
export function flushCharactersState(): Promise<void> {
  return saveChain.then(() => undefined);
}

export const useCharactersStore = create<CharacterState & CharacterActions>((set, get) => ({
  loaded: false,
  loading: false,
  characters: [],
  activeCharacterId: null,
  loadCharacters: async () => {
    if (get().loaded) return;
    if (loadInFlight) return loadInFlight;
    loadInFlight = (async () => {
      set({ loading: true });
      try {
        const file = await loadCharactersState();
        const characters = await hydrateCharacterAvatars(file.characters);
        set({
          loaded: true,
          loading: false,
          characters,
          activeCharacterId: get().activeCharacterId,
        });
        if (characters.some((character, index) => character.avatarPath !== file.characters[index]?.avatarPath)) {
          await persistState(get());
        }
      } catch (err) {
        console.warn('Failed to load characters:', err);
        toast.error('角色数据加载失败，已停止写入以免覆盖已有角色卡。');
        // Leave `loaded` false so a later invocation retries, and so persist
        // refuses to write an empty snapshot over disk.
        set({ loaded: false, loading: false });
      } finally {
        loadInFlight = null;
      }
    })();
    return loadInFlight;
  },
  upsertCharacter: async (character) => {
    if (!get().loaded) {
      await get().loadCharacters();
    }
    if (!get().loaded) return false;
    const next = await persistCharacterAvatar(character);
    if (character.avatarDataUrl && !next.avatarPath) {
      toast.warning('角色头像未能写入磁盘，已随角色数据暂存，下次启动会自动重试。');
    }
    set((state) => {
      const idx = state.characters.findIndex((c) => c.id === next.id);
      const characters =
        idx === -1
          ? [...state.characters, next]
          : state.characters.map((c) => (c.id === next.id ? next : c));
      return { characters };
    });
    return persistState(get());
  },
  deleteCharacter: async (characterId) => {
    if (!get().loaded) {
      await get().loadCharacters();
    }
    if (!get().loaded) return;
    set((state) => ({
      characters: state.characters.filter((c) => c.id !== characterId),
      activeCharacterId: state.activeCharacterId === characterId ? null : state.activeCharacterId,
    }));
    await persistState(get());
    await deleteCharacterAvatar(characterId);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('tts_delete_character_voices', { characterId });
    } catch (err) {
      console.warn('Failed to delete character voice files:', err);
    }
    try {
      useAgentStore.setState((s) => ({
        sessions: s.sessions.map((session) =>
          session.activeCharacterId === characterId
            ? { ...session, activeCharacterId: null }
            : session
        ),
      }));
      saveCurrentProjectState(useAgentStore.getState());
    } catch (err) {
      console.warn('Failed to clear session character after delete:', err);
    }
  },
  setActiveCharacter: async (characterId) => {
    if (!get().loaded) {
      await get().loadCharacters();
    }
    if (!get().loaded) return;
    set({ activeCharacterId: characterId });
    try {
      const sessionId = useAgentStore.getState().activeSessionId;
      if (!sessionId) return;
      useAgentStore.setState((s) => ({
        sessions: s.sessions.map((session) =>
          session.id === sessionId ? { ...session, activeCharacterId: characterId } : session
        ),
      }));
      saveCurrentProjectState(useAgentStore.getState());
    } catch (err) {
      console.warn('Failed to bind character to the current session:', err);
    }
  },
}));

export function getActiveCharacterPrompt(workMode?: string): string {
  const { characters, activeCharacterId } = useCharactersStore.getState();
  if (!activeCharacterId) return '';
  const character = characters.find((c) => c.id === activeCharacterId);
  if (!character) return '';
  return buildCharacterSystemPrompt(character, workMode);
}

export function getActiveCharacter(): CharacterProfile | null {
  const { characters, activeCharacterId } = useCharactersStore.getState();
  if (!activeCharacterId) return null;
  return characters.find((c) => c.id === activeCharacterId) ?? null;
}

export function syncActiveCharacterFromSession(characterId: string | null | undefined): void {
  useCharactersStore.setState({ activeCharacterId: characterId ?? null });
}

export function applySessionCharacterMap<T extends { id: string; activeCharacterId?: string | null }>(
  sessions: T[],
  map: Record<string, string | null> | undefined
): T[] {
  if (!map) return sessions;
  return sessions.map((session) => ({
    ...session,
    activeCharacterId: Object.prototype.hasOwnProperty.call(map, session.id)
      ? map[session.id] ?? null
      : session.activeCharacterId ?? null,
  }));
}

export function sessionActiveCharacterMap(
  sessions: { id: string; activeCharacterId?: string | null }[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const session of sessions) {
    if (session.activeCharacterId) {
      map[session.id] = session.activeCharacterId;
    }
  }
  return map;
}
