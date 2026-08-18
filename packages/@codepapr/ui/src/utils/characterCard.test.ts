import { describe, expect, it } from 'vitest';
import {
  buildCharacterCardSpec,
  normalizeCharacterCard,
  selectCharacterCardPayload,
  tryParseCardJson,
} from './characterCard';
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

describe('selectCharacterCardPayload', () => {
  it('prefers ccv3 over an earlier chara chunk', () => {
    const chara = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'V2' } });
    const ccv3 = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'V3' } });
    const raw = selectCharacterCardPayload([
      { keyword: 'chara', text: chara },
      { keyword: 'ccv3', text: ccv3 },
    ]);
    expect(raw).toEqual({ spec: 'chara_card_v3', data: { name: 'V3' } });
  });

  it('decodes base64 chara payloads', () => {
    const json = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Ada' } });
    const encoded = btoa(json);
    expect(tryParseCardJson(encoded)).toEqual({ spec: 'chara_card_v3', data: { name: 'Ada' } });
    const raw = selectCharacterCardPayload([{ keyword: 'chara', text: encoded }]);
    expect(raw).toEqual({ spec: 'chara_card_v3', data: { name: 'Ada' } });
  });

  it('imports alternate_greetings', () => {
    const profile = normalizeCharacterCard(
      {
        spec: 'chara_card_v3',
        data: {
          name: 'Ada',
          first_mes: 'Hi.',
          alternate_greetings: ['Yo.', 'Hey.'],
        },
      },
      null
    );
    expect(profile.firstMessage).toBe('Hi.');
    expect(profile.alternateGreetings).toEqual(['Yo.', 'Hey.']);
  });

  it('exports alternate_greetings', () => {
    const spec = buildCharacterCardSpec({
      ...createEmptyCharacter(),
      name: 'Ada',
      firstMessage: 'Hi.',
      alternateGreetings: ['Yo.'],
    }) as { data: { alternate_greetings: string[] } };
    expect(spec.data.alternate_greetings).toEqual(['Yo.']);
  });
});
