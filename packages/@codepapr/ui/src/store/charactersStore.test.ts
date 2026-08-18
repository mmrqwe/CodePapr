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

import { useCharactersStore } from './charactersStore';

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
  });
});
