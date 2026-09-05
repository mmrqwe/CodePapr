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

  it('exports portable voice params without local paths, and imports them back', () => {
    const spec = buildCharacterCardSpec({
      ...createEmptyCharacter(),
      name: 'Ada',
      voice: {
        enabled: true,
        engine: 'gpt-sovits',
        speed: 1.2,
        sampleSteps: 16,
        sentencesPerChunk: 5,
        playbackMode: 'streamed-pipeline',
        textLanguage: 'en',
        referenceTextLanguage: 'all_ja',
        referenceSamplePath: '/home/me/.codepapr/voices/ada_ref.wav',
        fineTunedModelPath: '/home/me/.codepapr/voices/ada/model.pth',
      },
    }) as { data: { extensions: { codepapr: { voice: Record<string, unknown> } } } };
    const voice = spec.data.extensions.codepapr.voice;
    expect(voice.speed).toBe(1.2);
    expect(voice.sampleSteps).toBe(16);
    expect(voice.sentencesPerChunk).toBe(5);
    expect(voice.playbackMode).toBe('streamed-pipeline');
    expect(voice.textLanguage).toBe('en');
    expect(voice.referenceTextLanguage).toBe('all_ja');
    expect(JSON.stringify(spec)).not.toContain('/home/me');
    expect(JSON.stringify(spec)).not.toContain('referenceSamplePath');

    const profile = normalizeCharacterCard(spec as unknown as Record<string, unknown>, null);
    expect(profile.voice?.speed).toBe(1.2);
    expect(profile.voice?.playbackMode).toBe('streamed-pipeline');
    // Imported voice must stay disarmed until a local reference is set up.
    expect(profile.voice?.enabled).toBe(false);
    expect(profile.voice?.referenceSamplePath).toBeUndefined();
  });

  it('omits voice extension for characters without voice config', () => {
    const spec = buildCharacterCardSpec({
      ...createEmptyCharacter(),
      name: 'Ada',
    }) as { data: { extensions: { codepapr: Record<string, unknown> } } };
    expect(spec.data.extensions.codepapr.voice).toBeUndefined();
  });
});
