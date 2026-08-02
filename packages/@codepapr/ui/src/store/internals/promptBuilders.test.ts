import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentSessionBootstrapPrompt } from './promptBuilders';
import { useCharactersStore } from '../charactersStore';
import type { CharacterProfile } from '../../utils/characterTypes';
import type { Settings } from './types';

function makeCharacter(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  const now = new Date().toISOString();
  return {
    id: 'char-test',
    name: 'TestChar',
    avatarDataUrl: null,
    description: 'UNIQUE_CHAR_DESCRIPTION_MARKER',
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    systemPrompt: '',
    lang: 'zh-CN',
    ...overrides,
  } as unknown as Settings;
}

describe('buildAgentSessionBootstrapPrompt', () => {
  afterEach(() => {
    useCharactersStore.setState({ characters: [], activeCharacterId: null });
  });

  it('includes the custom system prompt in the bootstrap', () => {
    const settings = makeSettings({ systemPrompt: 'CUSTOM_SYS_PROMPT_MARKER' });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');
    expect(bootstrap).toContain('CUSTOM_SYS_PROMPT_MARKER');
    expect(bootstrap).toContain('some memory');
  });

  it('does NOT inject the active character description (character lives in the prefix system prompt)', () => {
    const character = makeCharacter();
    useCharactersStore.setState({
      characters: [character],
      activeCharacterId: character.id,
    });

    const settings = makeSettings({ systemPrompt: 'CUSTOM_SYS_PROMPT_MARKER' });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');

    expect(bootstrap).toContain('CUSTOM_SYS_PROMPT_MARKER');
    expect(bootstrap).not.toContain('UNIQUE_CHAR_DESCRIPTION_MARKER');
    expect(bootstrap).not.toContain('roleplaying as the character');
  });

  it('omits the custom guidance section entirely when system prompt is empty', () => {
    const settings = makeSettings({ systemPrompt: '   ' });
    const bootstrap = buildAgentSessionBootstrapPrompt(settings, '/tmp/ws', [], 'some memory');
    expect(bootstrap).toContain('some memory');
    expect(bootstrap).not.toContain('长期附加指导');
  });
});
