import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { maybeInsertActiveCharacterGreeting, sessionHasConversation } from './characterGreeting';
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

describe('sessionHasConversation', () => {
  it('ignores synthetic assistant lines', () => {
    const messages: UIMessage[] = [
      { id: 'info', role: 'assistant', content: 'hint', timestamp: 1, synthetic: true },
    ];
    expect(sessionHasConversation(messages)).toBe(false);
  });

  it('treats a real user or assistant line as conversation', () => {
    expect(
      sessionHasConversation([{ id: 'u', role: 'user', content: 'hi', timestamp: 1 }])
    ).toBe(true);
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
    expect(messages[0]?.id).toBe('character-greeting:sess-1:char-greet');
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
