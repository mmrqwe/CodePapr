import { describe, expect, it } from 'vitest';
import { stripAvatarDataUrl } from './characterAvatar';
import { createEmptyCharacter } from './characterTypes';

describe('stripAvatarDataUrl', () => {
  it('keeps the path and drops the in-memory data URL', () => {
    const character = {
      ...createEmptyCharacter(),
      avatarDataUrl: 'data:image/png;base64,aaaa',
      avatarPath: '/tmp/avatars/char.png',
    };
    expect(stripAvatarDataUrl(character)).toEqual({
      ...character,
      avatarDataUrl: null,
    });
  });
});
