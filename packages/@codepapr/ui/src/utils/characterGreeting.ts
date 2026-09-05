import { useAgentStore } from '../store/agentStore';
import { getActiveCharacter } from '../store/charactersStore';
import { saveCurrentProjectState } from '../store/internals/projectSnapshot';
import type { UIMessage } from '../store/internals/types';
import { expandCharacterMacros, resolveCharacterGreeting, sanitizeCachePrompt } from './characterTypes';

export function characterGreetingMessageId(sessionId: string, characterId: string, revision?: string): string {
  const base = `character-greeting:${sessionId}:${characterId}`;
  return revision ? `${base}:${revision}` : base;
}

/** Small stable FNV-1a hash so edits to the greeting text/index replace the
 *  inserted message instead of being blocked as "already inserted". */
export function greetingRevision(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
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

function isGreetingMessage(message: UIMessage): boolean {
  return message.id.startsWith('character-greeting:');
}

/** Real user/assistant turns, ignoring character greetings and synthetic lines. */
function hasRealConversation(messages: UIMessage[]): boolean {
  return messages.some(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') && !m.synthetic && !isGreetingMessage(m)
  );
}

/**
 * If the active session is empty and the enabled character has a first_mes,
 * insert it as a real assistant message (visible + in context, TTS-eligible).
 * When the session is still empty but carries a greeting from a *different*
 * character (e.g. the user just switched characters), the stale greeting is
 * replaced with the new character's one instead of being blocked by it.
 * Returns true when a greeting was inserted or replaced.
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
  if (hasRealConversation(messages)) return false;

  const text = expandCharacterGreeting(greetingRaw, character.name);
  if (!text) return false;

  const greetingId = characterGreetingMessageId(sessionId, character.id, greetingRevision(text));
  const currentGreetingInPlace = messages.some((m) => m.id === greetingId);
  const staleGreetingPresent = messages.some((m) => isGreetingMessage(m) && m.id !== greetingId);
  if (currentGreetingInPlace && !staleGreetingPresent) return false;

  const greetingMsg: UIMessage = {
    id: greetingId,
    role: 'assistant',
    content: text,
    timestamp: Date.now(),
  };

  let changed = false;
  useAgentStore.setState((s) => {
    if (s.activeSessionId !== sessionId) return s;
    if (!s.sessions.some((session) => session.id === sessionId)) return s;
    const current = s.sessionMessages[sessionId] ?? s.messages;
    if (hasRealConversation(current)) return s;
    const stillCurrentInPlace = current.some((m) => m.id === greetingId);
    const stillStalePresent = current.some((m) => isGreetingMessage(m) && m.id !== greetingId);
    if (stillCurrentInPlace && !stillStalePresent) return s;
    changed = true;
    const nextMessages = [
      ...current.filter((m) => !isGreetingMessage(m)),
      greetingMsg,
    ];
    return {
      messages: nextMessages,
      sessionMessages: {
        ...s.sessionMessages,
        [sessionId]: nextMessages,
      },
    };
  });

  if (!changed) return false;
  saveCurrentProjectState(useAgentStore.getState());
  return true;
}
