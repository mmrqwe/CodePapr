import { invoke } from '@tauri-apps/api/core';
import type { CharactersStateFile } from './characterTypes';

interface AppCharactersResult {
  charactersJson: string | null;
  dbPath: string;
}

const EMPTY_STATE: CharactersStateFile = {
  version: 1,
  activeCharacterId: null,
  characters: [],
};

export async function loadCharactersState(): Promise<CharactersStateFile> {
  try {
    const result = await invoke<AppCharactersResult>('load_app_characters');
    if (!result.charactersJson) return { ...EMPTY_STATE };
    const parsed = JSON.parse(result.charactersJson);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_STATE };
    const data = parsed as Partial<CharactersStateFile>;
    return {
      version: 1,
      activeCharacterId: typeof data.activeCharacterId === 'string' ? data.activeCharacterId : null,
      characters: Array.isArray(data.characters) ? data.characters : [],
    };
  } catch (err) {
    console.warn('Failed to load characters state:', err);
    return { ...EMPTY_STATE };
  }
}

export async function saveCharactersState(state: CharactersStateFile): Promise<void> {
  await invoke<AppCharactersResult>('save_app_characters', {
    charactersJson: JSON.stringify(state),
  });
}
