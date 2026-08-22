import { useAgentStore } from '../store/agentStore';
import { getActiveCharacter } from '../store/charactersStore';
import { saveCurrentProjectState } from '../store/internals/projectSnapshot';
import type { UIMessage } from '../store/internals/types';
import { expandCharacterMacros, resolveCharacterGreeting, sanitizeCachePrompt } from './characterTypes';

export function characterGreetingMessageId(sessionId: string, characterId: string): string {
  return `character-greeting:${sessionId}:${characterId}`;
}

export function sessionHasConversation(messages: UIMessage[]): boolean {
  return messages.some(
    (m) => (m.role === 'user' || m.role === 'assistant') && !m.synthetic
  );
}

/** 用户还没发过消息：侧栏可直接删除（不必归档）。角色开场白不算对话。
 *  消息尚未加载（undefined）时不能当空会话，避免把有内容的会话误删。 */
export function sessionCanHardDelete(messages: UIMessage[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  return !messages.some((m) => m.role === 'user' && !m.synthetic && !m.hidden);
}

export function expandCharacterGreeting(text: string, characterName: string): string {
  return sanitizeCachePrompt(expandCharacterMacros(text, { char: characterName }));
}

/**
 * If the active session is empty and the enabled character has a first_mes,
 * insert it as a real assistant message (visible + in context, TTS-eligible).
 * Returns true when a greeting was inserted.
 */
export function maybeInsertActiveCharacterGreeting(): boolean {
  const state = useAgentStore.getState();
  if (!state.settings.experimentalCharacters) return false;

  const character = getActiveCharacter();
  const greetingRaw = character ? resolveCharacterGreeting(character).trim() : '';
  if (!character || !greetingRaw) return false;

  const sessionId = state.activeSessionId;
  if (!sessionId || state.sessionMessagesLoading) return false;
  if (state._messageLoadFailedSessions[sessionId]) return false;
  if (!state.sessions.some((session) => session.id === sessionId)) return false;

  const messages = state.sessionMessages[sessionId] ?? state.messages;
  const greetingId = characterGreetingMessageId(sessionId, character.id);
  if (messages.some((m) => m.id.startsWith('character-greeting:'))) return false;
  if (sessionHasConversation(messages)) return false;

  const text = expandCharacterGreeting(greetingRaw, character.name);
  if (!text) return false;

  const greetingMsg: UIMessage = {
    id: greetingId,
    role: 'assistant',
    content: text,
    timestamp: Date.now(),
  };

  useAgentStore.setState((s) => {
    if (s.activeSessionId !== sessionId) return s;
    if (!s.sessions.some((session) => session.id === sessionId)) return s;
    const current = s.sessionMessages[sessionId] ?? s.messages;
    if (current.some((m) => m.id === greetingId || m.id.startsWith('character-greeting:'))) {
      return s;
    }
    const nextMessages = [...current, greetingMsg];
    return {
      messages: nextMessages,
      sessionMessages: {
        ...s.sessionMessages,
        [sessionId]: nextMessages,
      },
    };
  });

  saveCurrentProjectState(useAgentStore.getState());
  return true;
}
