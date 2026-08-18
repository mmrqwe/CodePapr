import { describe, expect, it } from 'vitest';
import {
  type CharacterProfile,
  buildCharacterSystemPrompt,
  createEmptyCharacter,
  expandCharacterMacros,
  formatExampleDialog,
  normalizeLoadedCharacter,
  resolveCharacterGreeting,
  resolveCharacterInteractionMode,
  sanitizeCachePrompt,
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

describe('expandCharacterMacros', () => {
  it('replaces {{char}} and {{user}} instead of stripping the braces', () => {
    const expanded = expandCharacterMacros('Hello {{user}}, I am {{char}}.', {
      char: 'Ada',
    });
    expect(expanded).toBe('Hello User, I am Ada.');
    expect(expanded).not.toContain('{{');
    expect(expanded).not.toMatch(/\bchar\b/);
    expect(expanded).not.toMatch(/\buser\b/);
  });

  it('is case-insensitive and trims inner whitespace', () => {
    expect(expandCharacterMacros('{{CHAR}} / {{ User }}', { char: 'Ada', user: 'Mr' })).toBe(
      'Ada / Mr'
    );
  });
});

describe('sanitizeCachePrompt', () => {
  it('drops leftover unknown macros after expansion', () => {
    const text = sanitizeCachePrompt(expandCharacterMacros('Hi {{char}} {{unknown}}', { char: 'Ada' }));
    expect(text).toBe('Hi Ada');
  });
});

describe('normalizeLoadedCharacter', () => {
  it('maps legacy referenceTextLanguage zh to all_zh', () => {
    const loaded = normalizeLoadedCharacter({
      id: 'char_1',
      name: 'Ada',
      voice: { enabled: true, engine: 'gpt-sovits', speed: 1, referenceTextLanguage: 'zh' },
    });
    expect(loaded?.voice?.referenceTextLanguage).toBe('all_zh');
  });

  it('does not remap stored textLanguage zh', () => {
    const loaded = normalizeLoadedCharacter({
      id: 'char_1',
      name: 'Ada',
      voice: {
        enabled: true,
        engine: 'gpt-sovits',
        speed: 1,
        referenceTextLanguage: 'all_zh',
        textLanguage: 'zh',
      },
    });
    expect(loaded?.voice?.textLanguage).toBe('zh');
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

  it('roleplay mode keeps the stage-play contract without stuffing first_mes into the prompt', () => {
    const prompt = buildCharacterSystemPrompt(makeCharacter({ interactionMode: 'roleplay' }));
    expect(prompt).toContain('You are roleplaying as the character "TestChar"');
    expect(prompt).toContain('Spoken dialogue must be plain text');
    expect(prompt).not.toContain('Opening Line');
    expect(prompt).not.toContain('You actually want this done?');
    expect(prompt).toContain('still produce real code in fenced blocks');
  });

  it('expands macros in description fields', () => {
    const prompt = buildCharacterSystemPrompt(
      makeCharacter({ description: 'I am {{char}}. I talk to {{user}}.' })
    );
    expect(prompt).toContain('I am TestChar. I talk to User.');
    expect(prompt).not.toContain('{{char}}');
  });

  it('does not inject post-history instructions into the system prompt', () => {
    const prompt = buildCharacterSystemPrompt(
      makeCharacter({ postHistoryInstructions: 'Stay in character after history.' })
    );
    expect(prompt).not.toContain('Post-History');
    expect(prompt).not.toContain('Stay in character after history.');
  });

  it('splits <START> example blocks into labeled few-shot sections', () => {
    const prompt = buildCharacterSystemPrompt(
      makeCharacter({
        exampleMessages: '<START>\n{{user}}: hi\n{{char}}: hello\n<START>\n{{user}}: later',
      })
    );
    expect(prompt).toContain('## Example 1');
    expect(prompt).toContain('## Example 2');
    expect(prompt).not.toContain('<START>');
  });
});

describe('formatExampleDialog', () => {
  it('returns plain text unchanged when there is no START marker', () => {
    expect(formatExampleDialog('just a sample')).toBe('just a sample');
  });
});

describe('resolveCharacterGreeting', () => {
  it('uses firstMessage by default', () => {
    expect(resolveCharacterGreeting(makeCharacter({ firstMessage: 'Hello there.' }))).toBe(
      'Hello there.'
    );
  });

  it('selects an alternate greeting by index', () => {
    const character = makeCharacter({
      firstMessage: 'Default.',
      alternateGreetings: ['Alt one.', 'Alt two.'],
      selectedGreetingIndex: 2,
    });
    expect(resolveCharacterGreeting(character)).toBe('Alt two.');
  });
});

