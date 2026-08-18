import type { CharacterProfile } from './characterTypes';

export function stripAvatarDataUrl(character: CharacterProfile): CharacterProfile {
  return { ...character, avatarDataUrl: null };
}

export async function persistCharacterAvatar(
  character: CharacterProfile
): Promise<CharacterProfile> {
  const dataUrl = character.avatarDataUrl;
  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    if (!dataUrl && character.avatarPath) {
      await deleteCharacterAvatar(character.id);
      return { ...character, avatarPath: undefined, avatarDataUrl: null };
    }
    return character;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke<string>('save_character_avatar', {
      characterId: character.id,
      dataUrl,
    });
    return { ...character, avatarPath: path };
  } catch (err) {
    console.warn('Failed to persist character avatar:', err);
    return character;
  }
}

export async function hydrateCharacterAvatar(
  character: CharacterProfile
): Promise<CharacterProfile> {
  if (character.avatarPath && !character.avatarDataUrl?.startsWith('data:')) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const dataUrl = await invoke<string>('read_character_avatar', {
        filePath: character.avatarPath,
      });
      return { ...character, avatarDataUrl: dataUrl };
    } catch (err) {
      console.warn('Failed to load character avatar:', err);
      return character;
    }
  }
  if (character.avatarDataUrl?.startsWith('data:image/') && !character.avatarPath) {
    return persistCharacterAvatar(character);
  }
  return character;
}

export async function hydrateCharacterAvatars(
  characters: CharacterProfile[]
): Promise<CharacterProfile[]> {
  return Promise.all(characters.map((character) => hydrateCharacterAvatar(character)));
}

export async function deleteCharacterAvatar(characterId: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_character_avatar', { characterId });
  } catch (err) {
    console.warn('Failed to delete character avatar:', err);
  }
}
