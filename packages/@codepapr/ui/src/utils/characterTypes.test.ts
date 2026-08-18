import { describe, expect, it } from 'vitest';
import {
  type CharacterProfile,
  buildCharacterSystemPrompt,
  createEmptyCharacter,
  resolveCharacterInteractionMode,
} from './characterTypes';

function makeCharacter(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    ...createEmptyCharacter(),
    name: 'TestChar',
    description: 'A sarcastic engineer with no patience for ceremony.',
    personality: 'Blunt, dry, hates busywork.',
    firstMessage: '*He lights a cigarette.* You actually want this done?',
    ...overrides,
  };
}

describe('resolveCharacterInteractionMode', () => {
  it('defaults missing mode to persona', () => {
    const character = makeCharacter();
    delete character.interactionMode;
    expect(resolveCharacterInteractionMode(character)).toBe('persona');
  });

  it('keeps an explicit roleplay mode', () => {
    expect(resolveCharacterInteractionMode(makeCharacter({ interactionMode: 'roleplay' }))).toBe(
      'roleplay'
    );
  });
});

describe('buildCharacterSystemPrompt', () => {
  it('persona mode overlays voice without forcing stage-play format', () => {
    const prompt = buildCharacterSystemPrompt(makeCharacter());
    expect(prompt).toContain('Work in the voice of "TestChar"');
    expect(prompt).toContain('coding agent');
    expect(prompt).toContain('A sarcastic engineer');
    expect(prompt).toContain('lens, not a veto');
    expect(prompt).not.toContain('You are roleplaying as the character');
    expect(prompt).not.toContain('Spoken dialogue must be plain text');
    expect(prompt).not.toContain('Opening Line');
    expect(prompt).not.toContain('You actually want this done?');
  });

  it('persona mode with voice on adds a TTS note without stage directions', () => {
    const prompt = buildCharacterSystemPrompt(
      makeCharacter({
        voice: { enabled: true, engine: 'gpt-sovits', speed: 1 },
      })
    );
    expect(prompt).toContain('text-to-speech');
    expect(prompt).not.toContain('Spoken dialogue must be plain text');
    expect(prompt).not.toContain('*Wrap actions');
  });

  it('roleplay mode keeps the stage-play contract and opening line', () => {
    const prompt = buildCharacterSystemPrompt(makeCharacter({ interactionMode: 'roleplay' }));
    expect(prompt).toContain('You are roleplaying as the character "TestChar"');
    expect(prompt).toContain('Spoken dialogue must be plain text');
    expect(prompt).toContain('Opening Line');
    expect(prompt).toContain('You actually want this done?');
    expect(prompt).toContain('still produce real code in fenced blocks');
  });
});
