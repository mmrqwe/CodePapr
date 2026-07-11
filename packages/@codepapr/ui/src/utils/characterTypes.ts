export type TtsPlaybackMode = 'whole' | 'streamed-pipeline' | 'streamed-pcm' | 'ws-batch';

export interface VoiceConfig {
  enabled: boolean;
  engine: 'gpt-sovits';
  referenceSamplePath?: string;
  referenceText?: string;
  referenceTextLanguage?: string;
  /**
   * Language passed to GPT-SoVITS as `text_language`.
   * Defaults to `referenceTextLanguage` (i.e. same as the reference audio).
   * Can be overridden separately so a Japanese reference voice can speak
   * Chinese text, or vice versa.
   */
  textLanguage?: string;
  trainingLanguage?: string;
  modelName?: string;
  /**
   * Path to a fine-tuned GPT-SoVITS model (.pth file) for this character.
   * When set and useFineTuned is true, synthesis uses this model instead of
   * the default pretrained model, resulting in better voice accuracy and
   * faster synthesis (fewer diffusion steps needed).
   */
  fineTunedModelPath?: string;
  /**
   * Whether to use the fine-tuned model for synthesis.
   * Default true when fineTunedModelPath is set.
   */
  useFineTuned?: boolean;
  speed: number;
  /**
   * Number of sentences to merge into a single TTS synthesis chunk.
   * Higher values = fewer HTTP/WS round-trips = faster, but slightly
   * more latency before the first word is heard. Range 1-5, default 3.
   */
  sentencesPerChunk?: number;
  /**
   * GPT-SoVITS v4 diffusion step count. Lower values = faster synthesis
   * with slightly lower quality. Range 4-32, default 8.
   * The model was trained with sample_steps=8 so quality difference
   * vs 16/32 is imperceptible to most listeners.
   */
  sampleSteps?: number;
  /**
   * Playback strategy for the TTS engine.
   *
   * - `'whole'`: wait for the full assistant reply, then synthesise and
   *   play the entire passage in one go. Most coherent listening
   *   experience but the longest time-to-first-byte (~30-60s).
   * - `'streamed-pipeline'` (recommended default): split the reply by
   *   sentence, synthesise sequentially, push raw PCM directly from the
   *   HTTP response into the shared rodio sink. Bypasses full-WAV decode.
   * - `'streamed-pcm'`: same PCM direct path as streamed-pipeline; kept
   *   for backward compatibility.
   * - `'ws-batch'` (fastest): batch-synthesise all sentences over a
   *   persistent WebSocket connection, eliminating per-sentence HTTP
   *   round-trip overhead. ~1-2s to first word.
   *
 * Optional for backwards compatibility — characters created before
 * this field existed default to `'ws-batch'` at runtime.
   */
  playbackMode?: TtsPlaybackMode;
}

export interface CharacterProfile {
  id: string;
  name: string;
  avatarDataUrl: string | null;
  showAvatar?: boolean;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleMessages: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  tags: string[];
  creator: string;
  characterVersion: string;
  source: 'manual' | 'chara-card-v3' | 'imported';
  createdAt: string;
  updatedAt: string;
  voice?: VoiceConfig;
}

export interface CharactersStateFile {
  version: 1;
  activeCharacterId: string | null;
  characters: CharacterProfile[];
}

export function createEmptyCharacter(): CharacterProfile {
  const now = new Date().toISOString();
  return {
    id: createCharacterId(),
    name: '',
    avatarDataUrl: null,
    showAvatar: true,
    description: '',
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
  };
}

export function createCharacterId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `char_${time}_${random}`;
}

export function buildCharacterSystemPrompt(character: CharacterProfile): string {
  const parts: string[] = [];
  const name = character.name.trim();
  if (name) {
    parts.push(`You are roleplaying as the character "${name}".`);
  }
  if (character.description.trim()) {
    parts.push(`# Description\n${character.description.trim()}`);
  }
  if (character.personality.trim()) {
    parts.push(`# Personality\n${character.personality.trim()}`);
  }
  if (character.scenario.trim()) {
    parts.push(`# Scenario\n${character.scenario.trim()}`);
  }
  if (character.exampleMessages.trim()) {
    parts.push(`# Example Dialog\n${character.exampleMessages.trim()}`);
  }
  if (character.firstMessage.trim()) {
    parts.push(`# Opening Line\n${character.firstMessage.trim()}`);
  }
  if (character.systemPrompt.trim()) {
    parts.push(`# Additional Instructions\n${character.systemPrompt.trim()}`);
  }
  if (character.postHistoryInstructions.trim()) {
    parts.push(`# Post-History Instructions\n${character.postHistoryInstructions.trim()}`);
  }
  parts.push(`# Roleplay Format
You must follow this format convention. The system uses it to distinguish between character actions and spoken dialogue for text-to-speech rendering.

*Wrap actions, narration, and descriptions in single asterisks.*
Examples: \`*she smiles warmly*\` \`*he walks to the window and lights a cigarette*\` \`*the rain taps against the glass*\`

**Spoken dialogue must be plain text without any markers.**
Only plain text is read aloud by the voice system.
Example: Hello there, traveler. You look like you've come a long way.

**Use double-asterisk \`**emphasis**\` for words spoken with extra stress or emotion.**
This is still spoken, just with emphasis.

**Parenthetical tone indicators \`(whispering)\` or \`（轻声）\` describe delivery style and are not spoken.**
Example: (softly) I've been waiting for you.

Example dialogue:
*The old wizard leans on his staff, a faint glow emanating from the crystal at its tip.*
Well now, that's a question I haven't heard in a **very** long time.
*He chuckles and gestures toward a dusty bookshelf.*
(tapping his chin) Let me think...`);
  return sanitizeCachePrompt(parts.join('\n\n'));
}

/**
 * Strip character-card template patterns that would violate cache consistency:
 * {{user}} / {{char}} double-braces, ${...} interpolation, ISO timestamps, etc.
 */
export function sanitizeCachePrompt(text: string): string {
  return text
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/\$\{([^}]+)\}/g, '$1')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g, '')
    .replace(/\[TIMESTAMP\]/gi, '')
    .replace(/\[SESSION\s*[^\]]*\]/gi, '')
    .replace(/\[TIME\s*[^\]]*\]/gi, '')
    .replace(/\[DATE\s*[^\]]*\]/gi, '')
    .replace(/\[RANDOM\s*[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
