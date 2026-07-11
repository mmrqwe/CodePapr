import { create } from 'zustand';
import {
  type CharacterProfile,
  type CharactersStateFile,
  buildCharacterSystemPrompt,
} from '../utils/characterTypes';
import { loadCharactersState, saveCharactersState } from '../utils/characterStorage';

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
      set({ loaded: true, loading: false });
    }
  },
  upsertCharacter: async (character) => {
    const { characters } = get();
    const next = (() => {
      const idx = characters.findIndex((c) => c.id === character.id);
      if (idx === -1) return [...characters, character];
      const copy = characters.slice();
      copy[idx] = character;
      return copy;
    })();
    set({ characters: next });
    await saveCharactersState(buildStateFile({ ...get(), characters: next }));
  },
  deleteCharacter: async (characterId) => {
    const { characters, activeCharacterId } = get();
    const next = characters.filter((c) => c.id !== characterId);
    const nextActive = activeCharacterId === characterId ? null : activeCharacterId;
    set({ characters: next, activeCharacterId: nextActive });
    await saveCharactersState(buildStateFile({ ...get(), characters: next, activeCharacterId: nextActive }));
  },
  setActiveCharacter: async (characterId) => {
    set({ activeCharacterId: characterId });
    await saveCharactersState(buildStateFile(get()));
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
