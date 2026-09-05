import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import {
  maybeInsertActiveCharacterGreeting,
  sessionCanHardDelete,
} from './characterGreeting';
import { useAgentStore } from '../store/agentStore';
import { useCharactersStore } from '../store/charactersStore';
import type { CharacterProfile } from './characterTypes';
import type { SessionMeta, UIMessage } from '../store/internals/types';

function makeCharacter(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  const now = new Date().toISOString();
  return {
    id: 'char-greet',
    name: 'Ada',
    avatarDataUrl: null,
    description: '',
    personality: '',
    scenario: '',
    firstMessage: 'Hello {{user}}, I am {{char}}.',
    exampleMessages: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: [],
    creator: '',
    characterVersion: '',
    source: 'manual',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSession(id = 'sess-1'): SessionMeta {
  return {
    id,
    name: 'Test',
    provider: 'deepseek',
    model: 'test',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('sessionCanHardDelete', () => {
  it('allows delete when messages are loaded and empty', () => {
    expect(sessionCanHardDelete([])).toBe(true);
  });

  it('allows delete when only a character greeting exists', () => {
    expect(
      sessionCanHardDelete([
        { id: 'character-greeting:s:c', role: 'assistant', content: 'hi', timestamp: 1 },
      ])
    ).toBe(true);
  });

  it('refuses delete after a user message, and when messages are not loaded', () => {
    expect(
      sessionCanHardDelete([{ id: 'u', role: 'user', content: 'hi', timestamp: 1 }])
    ).toBe(false);
    expect(sessionCanHardDelete(undefined)).toBe(false);
  });
});

describe('maybeInsertActiveCharacterGreeting', () => {
  afterEach(() => {
    useCharactersStore.setState({ characters: [], activeCharacterId: null });
    useAgentStore.setState({
      activeSessionId: null,
      sessions: [],
      messages: [],
      sessionMessages: {},
      sessionMessagesLoading: false,
      _messageLoadFailedSessions: {},
      workspacePath: '',
    });
  });

  it('inserts an expanded greeting into an empty session', () => {
    const character = makeCharacter();
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });
    useAgentStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession()],
      messages: [],
      sessionMessages: { 'sess-1': [] },
      sessionMessagesLoading: false,
      _messageLoadFailedSessions: {},
      workspacePath: '',
      settings: {
        ...useAgentStore.getState().settings,
        experimentalCharacters: true,
      },
    });

    expect(maybeInsertActiveCharacterGreeting()).toBe(true);
    const messages = useAgentStore.getState().sessionMessages['sess-1'] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.synthetic).toBeUndefined();
    expect(messages[0]?.content).toBe('Hello User, I am Ada.');
    expect(messages[0]?.id).toMatch(/^character-greeting:sess-1:char-greet:[0-9a-z]+$/);

    // Second run with the same character/greeting must be a no-op.
    expect(maybeInsertActiveCharacterGreeting()).toBe(false);
    expect(useAgentStore.getState().sessionMessages['sess-1']).toHaveLength(1);
  });

  it('replaces a stale greeting from a different character in an empty session', () => {
    const first = makeCharacter({ id: 'char-a', name: 'Ada', firstMessage: 'Ada here.' });
    const second = makeCharacter({ id: 'char-b', name: 'Ben', firstMessage: 'Ben here.' });
    useCharactersStore.setState({ characters: [first, second], activeCharacterId: first.id });
    useAgentStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession()],
      messages: [],
      sessionMessages: { 'sess-1': [] },
      sessionMessagesLoading: false,
      _messageLoadFailedSessions: {},
      workspacePath: '',
      settings: {
        ...useAgentStore.getState().settings,
        experimentalCharacters: true,
      },
    });

    expect(maybeInsertActiveCharacterGreeting()).toBe(true);
    useCharactersStore.setState({ activeCharacterId: second.id });
    expect(maybeInsertActiveCharacterGreeting()).toBe(true);

    const messages = useAgentStore.getState().sessionMessages['sess-1'] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Ben here.');
    expect(messages[0]?.id).toContain('char-b');
  });

  it('refreshes the inserted greeting when the selected greeting index changes', () => {
    const character = makeCharacter({
      alternateGreetings: ['Alt greeting.'],
      selectedGreetingIndex: 0,
    });
    useCharactersStore.setState({ characters: [character], activeCharacterId: character.id });
    useAgentStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession()],
      messages: [],
      sessionMessages: { 'sess-1': [] },
      sessionMessagesLoading: false,
      _messageLoadFailedSessions: {},
      workspacePath: '',
      settings: {
        ...useAgentStore.getState().settings,
        experimentalCharacters: true,
      },
    });

    expect(maybeInsertActiveCharacterGreeting()).toBe(true);
    useCharactersStore.setState({
      characters: [{ ...character, selectedGreetingIndex: 1 }],
    });
    expect(maybeInsertActiveCharacterGreeting()).toBe(true);

    const messages = useAgentStore.getState().sessionMessages['sess-1'] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Alt greeting.');
  });

  it('never touches a session that already has real conversation', () => {
    const first = makeCharacter({ id: 'char-a', firstMessage: 'Ada here.' });
    const second = makeCharacter({ id: 'char-b', firstMessage: 'Ben here.' });
    useCharactersStore.setState({ characters: [first, second], activeCharacterId: first.id });
    const existing: UIMessage[] = [
      { id: 'character-greeting:sess-1:char-a', role: 'assistant', content: 'Ada here.', timestamp: 1 },
      { id: 'u1', role: 'user', content: 'hi', timestamp: 2 },
    ];
    useAgentStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession()],
      messages: existing,
      sessionMessages: { 'sess-1': existing },
      sessionMessagesLoading: false,
      _messageLoadFailedSessions: {},
      workspacePath: '',
      settings: {
        ...useAgentStore.getState().settings,
        experimentalCharacters: true,
      },
    });
    useCharactersStore.setState({ activeCharacterId: second.id });

    expect(maybeInsertActiveCharacterGreeting()).toBe(false);
    const messages = useAgentStore.getState().sessionMessages['sess-1'] ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toContain('char-a');
  });

  it('does not insert when the session already has a user message', () => {
    const character = makeCharacter();
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });
    const existing: UIMessage[] = [{ id: 'u1', role: 'user', content: 'ship it', timestamp: 1 }];
    useAgentStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession()],
      messages: existing,
      sessionMessages: { 'sess-1': existing },
      sessionMessagesLoading: false,
      _messageLoadFailedSessions: {},
      workspacePath: '',
    });

    expect(maybeInsertActiveCharacterGreeting()).toBe(false);
    expect(useAgentStore.getState().sessionMessages['sess-1']).toHaveLength(1);
  });

  it('does not insert when experimental characters are disabled', () => {
    const character = makeCharacter();
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });
    useAgentStore.setState({
      activeSessionId: 'sess-1',
      sessions: [makeSession()],
      messages: [],
      sessionMessages: { 'sess-1': [] },
      sessionMessagesLoading: false,
      _messageLoadFailedSessions: {},
      workspacePath: '',
      settings: {
        ...useAgentStore.getState().settings,
        experimentalCharacters: false,
      },
    });

    expect(maybeInsertActiveCharacterGreeting()).toBe(false);
    expect(useAgentStore.getState().sessionMessages['sess-1']).toHaveLength(0);
  });
});
