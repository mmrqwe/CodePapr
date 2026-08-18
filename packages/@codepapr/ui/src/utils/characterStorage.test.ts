import { describe, expect, it } from 'vitest';
import { parseCharactersStateJson } from './characterStorage';

describe('parseCharactersStateJson', () => {
  it('treats missing JSON as a genuine empty library', () => {
    expect(parseCharactersStateJson(null)).toEqual({
      version: 1,
      activeCharacterId: null,
      characters: [],
    });
  });

  it('loads a valid blob', () => {
    const parsed = parseCharactersStateJson(
      JSON.stringify({
        version: 1,
        activeCharacterId: 'char_1',
        characters: [{ id: 'char_1', name: 'Ada', tags: ['x'] }],
      })
    );
    expect(parsed.activeCharacterId).toBe('char_1');
    expect(parsed.characters).toHaveLength(1);
    expect(parsed.characters[0]?.name).toBe('Ada');
    expect(parsed.characters[0]?.tags).toEqual(['x']);
  });

  it('fills missing tags so the modal cannot crash on .join', () => {
    const parsed = parseCharactersStateJson(
      JSON.stringify({
        characters: [{ id: 'char_1', name: 'Ada' }],
      })
    );
    expect(parsed.characters[0]?.tags).toEqual([]);
  });

  it('throws on corrupt JSON instead of returning empty', () => {
    expect(() => parseCharactersStateJson('{not json')).toThrow(/损坏/);
  });

  it('throws when characters is not an array', () => {
    expect(() => parseCharactersStateJson(JSON.stringify({ characters: 'nope' }))).toThrow(
      /characters/
    );
  });

  it('throws when every entry is unreadable', () => {
    expect(() => parseCharactersStateJson(JSON.stringify({ characters: [{}, 1, null] }))).toThrow(
      /全部无法解析/
    );
  });
});
