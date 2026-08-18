import { invoke } from '@tauri-apps/api/core';
import {
  type CharactersStateFile,
  normalizeLoadedCharacter,
} from './characterTypes';

interface AppCharactersResult {
  charactersJson: string | null;
  dbPath: string;
}

const EMPTY_STATE: CharactersStateFile = {
  version: 1,
  activeCharacterId: null,
  characters: [],
};

/**
 * Parse the persisted characters blob.
 *
 * `null` / missing JSON means the key has never been written — that is a real
 * empty library. Corrupt JSON, a non-object root, or a `characters` value that
 * is not an array must throw so the store refuses to mark itself loaded and
 * cannot overwrite disk with `[]`.
 */
export function parseCharactersStateJson(charactersJson: string | null): CharactersStateFile {
  if (!charactersJson) return { ...EMPTY_STATE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(charactersJson);
  } catch {
    throw new Error('角色卡 JSON 损坏，拒绝加载以免覆盖已有数据。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('角色卡 JSON 必须是对象，拒绝加载以免覆盖已有数据。');
  }

  const data = parsed as Partial<CharactersStateFile> & { characters?: unknown };
  if (data.characters !== undefined && !Array.isArray(data.characters)) {
    throw new Error('角色卡 characters 字段损坏，拒绝加载以免覆盖已有数据。');
  }

  const rawList = Array.isArray(data.characters) ? data.characters : [];
  const characters = rawList
    .map((entry) => normalizeLoadedCharacter(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (rawList.length > 0 && characters.length === 0) {
    throw new Error('角色卡条目全部无法解析，拒绝加载以免覆盖已有数据。');
  }

  return {
    version: 1,
    activeCharacterId: typeof data.activeCharacterId === 'string' ? data.activeCharacterId : null,
    characters,
  };
}

export async function loadCharactersState(): Promise<CharactersStateFile> {
  const result = await invoke<AppCharactersResult>('load_app_characters');
  return parseCharactersStateJson(result.charactersJson);
}

export async function saveCharactersState(state: CharactersStateFile): Promise<void> {
  await invoke<AppCharactersResult>('save_app_characters', {
    charactersJson: JSON.stringify(state),
  });
}
