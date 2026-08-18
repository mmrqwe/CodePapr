import { describe, expect, it } from 'vitest';
import { buildCharacterCardSpec, normalizeCharacterCard } from './characterCard';
import { createEmptyCharacter } from './characterTypes';

describe('character card interactionMode round-trip', () => {
  it('imports missing extensions as persona', () => {
    const profile = normalizeCharacterCard({ name: 'Ada' }, null);
    expect(profile.interactionMode).toBe('persona');
  });

  it('imports codepapr.interactionMode from extensions', () => {
    const profile = normalizeCharacterCard(
      {
        spec: 'chara_card_v3',
        data: {
          name: 'Ada',
          extensions: { codepapr: { interactionMode: 'roleplay' } },
        },
      },
      null
    );
    expect(profile.interactionMode).toBe('roleplay');
  });

  it('exports interactionMode under extensions.codepapr', () => {
    const character = {
      ...createEmptyCharacter(),
      name: 'Ada',
      interactionMode: 'roleplay' as const,
    };
    const spec = buildCharacterCardSpec(character) as {
      data: { extensions: { codepapr: { interactionMode: string } } };
    };
    expect(spec.data.extensions.codepapr.interactionMode).toBe('roleplay');
  });
});
