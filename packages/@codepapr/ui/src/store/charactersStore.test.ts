import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadCharactersStateMock, saveCharactersStateMock, toastErrorMock } = vi.hoisted(() => ({
  loadCharactersStateMock: vi.fn(),
  saveCharactersStateMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('../utils/characterStorage', () => ({
  loadCharactersState: loadCharactersStateMock,
  saveCharactersState: saveCharactersStateMock,
}));

vi.mock('./toastStore', () => ({
  toast: { error: toastErrorMock, success: vi.fn(), warning: vi.fn() },
}));

import { useCharactersStore, applySessionCharacterMap, sessionActiveCharacterMap } from './charactersStore';

describe('useCharactersStore persist guard', () => {
  beforeEach(() => {
    loadCharactersStateMock.mockReset();
    saveCharactersStateMock.mockReset();
    toastErrorMock.mockReset();
    saveCharactersStateMock.mockResolvedValue(undefined);
    useCharactersStore.setState({
      loaded: false,
      loading: false,
      characters: [],
      activeCharacterId: null,
    });
  });

  afterEach(() => {
    useCharactersStore.setState({
      loaded: false,
      loading: false,
      characters: [],
      activeCharacterId: null,
    });
  });

  it('does not persist when load failed', async () => {
    loadCharactersStateMock.mockRejectedValue(new Error('disk missing'));
    await useCharactersStore.getState().loadCharacters();
    expect(useCharactersStore.getState().loaded).toBe(false);

    await useCharactersStore.getState().upsertCharacter({
      id: 'char_new',
      name: 'Ada',
      avatarDataUrl: null,
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      exampleMessages: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      tags: [],
      creator: '',
      characterVersion: '',
      source: 'manual',
      createdAt: '',
      updatedAt: '',
    });

    expect(saveCharactersStateMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalled();
  });

  it('persists after a successful load', async () => {
    loadCharactersStateMock.mockResolvedValueOnce({
      version: 1,
      activeCharacterId: null,
      characters: [],
    });
    await useCharactersStore.getState().loadCharacters();
    expect(useCharactersStore.getState().loaded).toBe(true);

    await useCharactersStore.getState().upsertCharacter({
      id: 'char_new',
      name: 'Ada',
      avatarDataUrl: null,
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      exampleMessages: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      tags: [],
      creator: '',
      characterVersion: '',
      source: 'manual',
      createdAt: '',
      updatedAt: '',
    });

    expect(saveCharactersStateMock).toHaveBeenCalledTimes(1);
    expect(saveCharactersStateMock.mock.calls[0]?.[0].characters).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'char_new', name: 'Ada' })])
    );
    expect(saveCharactersStateMock.mock.calls[0]?.[0].activeCharacterId).toBeNull();
  });

  it('strips avatar data URLs from the persisted blob', async () => {
    loadCharactersStateMock.mockResolvedValueOnce({
      version: 1,
      activeCharacterId: null,
      characters: [],
    });
    await useCharactersStore.getState().loadCharacters();
    await useCharactersStore.getState().upsertCharacter({
      id: 'char_img',
      name: 'Ada',
      avatarDataUrl: 'data:image/png;base64,aaaa',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      exampleMessages: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      tags: [],
      creator: '',
      characterVersion: '',
      source: 'manual',
      createdAt: '',
      updatedAt: '',
    });
    expect(saveCharactersStateMock.mock.calls[0]?.[0].characters[0]?.avatarDataUrl).toBeNull();
  });
});

describe('sessionActiveCharacterMap', () => {
  it('keeps only sessions that have a character enabled', () => {
    expect(
      sessionActiveCharacterMap([
        { id: 's1', activeCharacterId: 'c1' },
        { id: 's2', activeCharacterId: null },
        { id: 's3' },
      ])
    ).toEqual({ s1: 'c1' });
  });

  it('applies a persisted map without inventing characters for unknown sessions', () => {
    expect(
      applySessionCharacterMap(
        [
          { id: 's1', activeCharacterId: null },
          { id: 's2', activeCharacterId: 'old' },
        ],
        { s1: 'c1' }
      )
    ).toEqual([
      { id: 's1', activeCharacterId: 'c1' },
      { id: 's2', activeCharacterId: 'old' },
    ]);
  });
});
