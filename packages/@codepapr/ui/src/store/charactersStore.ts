import { create } from 'zustand';
import {
  type CharacterProfile,
  type CharactersStateFile,
  buildCharacterSystemPrompt,
} from '../utils/characterTypes';
import { loadCharactersState, saveCharactersState } from '../utils/characterStorage';
import { toast } from './toastStore';

interface CharacterState {
  loaded: boolean;
  loading: boolean;
  characters: CharacterProfile[];
  activeCharacterId: string | null;
}

interface CharacterActions {
  loadCharacters: () => Promise<void>;
  upsertCharacter: (character: CharacterProfile) => Promise<void>;
  deleteCharacter: (characterId: string) => Promise<void>;
  setActiveCharacter: (characterId: string | null) => Promise<void>;
}

function buildStateFile(state: CharacterState): CharactersStateFile {
  return {
    version: 1,
    activeCharacterId: state.activeCharacterId,
    characters: state.characters,
  };
}

// Serialise persistence so concurrent mutations cannot write the JSON blob
// out of order. Each mutation enqueues a snapshot of its post-mutation state;
// the chain guarantees the latest (most complete) snapshot is the final thing
// written to disk. A failed save is surfaced to the user rather than letting
// in-memory state silently diverge from what is persisted.
let saveChain: Promise<void> = Promise.resolve();

function persistState(state: CharacterState): Promise<void> {
  const file = buildStateFile(state);
  saveChain = saveChain.then(() =>
    saveCharactersState(file).catch((err) => {
      console.warn('Failed to persist characters state:', err);
      toast.error('角色数据保存失败，最近的更改可能未被持久化。');
    }),
  );
  return saveChain;
}

/** 等待角色卡保存链全部落库（退出前 flush 用）。 */
export function flushCharactersState(): Promise<void> {
  return saveChain;
}

export const useCharactersStore = create<CharacterState & CharacterActions>((set, get) => ({
  loaded: false,
  loading: false,
  characters: [],
  activeCharacterId: null,
  loadCharacters: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const file = await loadCharactersState();
      set({
        loaded: true,
        loading: false,
        characters: file.characters,
        activeCharacterId: file.activeCharacterId,
      });
    } catch (err) {
      console.warn('Failed to load characters:', err);
      // Leave `loaded` false so a later invocation (e.g. reopening the
      // characters modal) retries instead of being permanently blocked by a
      // transient failure.
      set({ loaded: false, loading: false });
    }
  },
  upsertCharacter: async (character) => {
    // Functional update: compute `next` from the latest committed state so
    // two rapid upserts cannot lose one another's writes (the previous
    // read-then-set captured a stale snapshot).
    set((state) => {
      const idx = state.characters.findIndex((c) => c.id === character.id);
      const characters =
        idx === -1
          ? [...state.characters, character]
          : state.characters.map((c) => (c.id === character.id ? character : c));
      return { characters };
    });
    await persistState(get());
  },
  deleteCharacter: async (characterId) => {
    set((state) => ({
      characters: state.characters.filter((c) => c.id !== characterId),
      activeCharacterId: state.activeCharacterId === characterId ? null : state.activeCharacterId,
    }));
    await persistState(get());
  },
  setActiveCharacter: async (characterId) => {
    set({ activeCharacterId: characterId });
    await persistState(get());
  },
}));

export function getActiveCharacterPrompt(): string {
  const { characters, activeCharacterId } = useCharactersStore.getState();
  if (!activeCharacterId) return '';
  const character = characters.find((c) => c.id === activeCharacterId);
  if (!character) return '';
  return buildCharacterSystemPrompt(character);
}

export function getActiveCharacter(): CharacterProfile | null {
  const { characters, activeCharacterId } = useCharactersStore.getState();
  if (!activeCharacterId) return null;
  return characters.find((c) => c.id === activeCharacterId) ?? null;
}
