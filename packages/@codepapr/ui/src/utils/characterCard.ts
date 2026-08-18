import {
  type CharacterProfile,
  type CharacterInteractionMode,
  createCharacterId,
  resolveCharacterInteractionMode,
} from './characterTypes';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_AVATAR_PX = 512;

const CHARACTER_KEYWORDS = new Set(['chara', 'ccv3', 'character', 'character_card']);

export type PngTextChunk = { keyword: string; text: string };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return bytesEqual(bytes.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
}

function readUInt32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function decodeLatin1(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 1) {
    result += String.fromCharCode(bytes[i]!);
  }
  return result;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(
        new DecompressionStream(format)
      );
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // try the other wrapping
    }
  }
  return null;
}

async function decodePngTextChunks(buffer: ArrayBuffer): Promise<PngTextChunk[]> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const results: PngTextChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = readUInt32BE(view, offset);
    const type = decodeLatin1(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'tEXt') {
      const sep = data.indexOf(0);
      if (sep > -1) {
        const keyword = decodeLatin1(data.subarray(0, sep)).trim().toLowerCase();
        if (CHARACTER_KEYWORDS.has(keyword)) {
          results.push({ keyword, text: decodeLatin1(data.subarray(sep + 1)) });
        }
      }
    } else if (type === 'iTXt') {
      const sep = data.indexOf(0);
      if (sep > -1) {
        const keyword = decodeUtf8(data.subarray(0, sep)).trim().toLowerCase();
        if (CHARACTER_KEYWORDS.has(keyword)) {
          const compressionFlag = data[sep + 1];
          let cursor = sep + 3;
          const langEnd = data.indexOf(0, cursor);
          cursor = langEnd >= 0 ? langEnd + 1 : cursor;
          const translatedEnd = data.indexOf(0, cursor);
          cursor = translatedEnd >= 0 ? translatedEnd + 1 : cursor;
          const payload = data.subarray(cursor);
          if (compressionFlag === 0) {
            results.push({ keyword, text: decodeUtf8(payload) });
          } else {
            const inflated = await inflateZlib(payload);
            if (inflated) {
              results.push({ keyword, text: decodeUtf8(inflated) });
            }
          }
        }
      }
    }
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return results;
}

export function tryParseCardJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // try base64 decode
  }
  try {
    const stripped = trimmed.replace(/^data:[^,]+,/, '');
    const binary = atob(stripped);
    const decoded = new TextDecoder('utf-8').decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0))
    );
    const parsed = JSON.parse(decoded.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/** Prefer `ccv3` over older `chara` / leftover chunks. */
export function selectCharacterCardPayload(
  chunks: PngTextChunk[]
): Record<string, unknown> | null {
  const parsed = chunks
    .map((chunk) => ({ keyword: chunk.keyword, raw: tryParseCardJson(chunk.text) }))
    .filter((chunk): chunk is { keyword: string; raw: Record<string, unknown> } => chunk.raw !== null);
  const ccv3 = parsed.find((chunk) => chunk.keyword === 'ccv3');
  return (ccv3 ?? parsed[0])?.raw ?? null;
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value;
  return '';
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === 'string' && v.trim() && !seen.has(v.trim())) {
      seen.add(v.trim());
      out.push(v.trim());
    }
  }
  return out;
}

function arrayBufferToDataUrl(buffer: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function rasterImageFileToPngDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_AVATAR_PX / Math.max(bitmap.width, bitmap.height, 1));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('无法把头像转成 PNG。');
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

export async function importCharacterCardFromFile(file: File): Promise<CharacterProfile> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let raw: Record<string, unknown> | null = null;
  let avatarDataUrl: string | null = null;

  if (isPngBytes(bytes)) {
    const chunks = await decodePngTextChunks(buffer);
    raw = selectCharacterCardPayload(chunks);
    if (!raw) {
      throw new Error('PNG 中没有找到可解析的角色卡数据。');
    }
    avatarDataUrl = arrayBufferToDataUrl(buffer, 'image/png');
  } else {
    const text = new TextDecoder('utf-8').decode(buffer);
    raw = tryParseCardJson(text);
    if (!raw) {
      throw new Error('角色卡文件不是有效的 PNG 内嵌 JSON 或 JSON 文本。');
    }
  }

  return normalizeCharacterCard(raw, avatarDataUrl);
}

function readCodepaprInteractionMode(
  raw: Record<string, unknown>,
  data: Record<string, unknown>
): CharacterInteractionMode {
  for (const ext of [data.extensions, raw.extensions]) {
    if (!ext || typeof ext !== 'object' || Array.isArray(ext)) continue;
    const cp = (ext as Record<string, unknown>).codepapr;
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) continue;
    const mode = (cp as Record<string, unknown>).interactionMode;
    if (mode === 'roleplay' || mode === 'persona') return mode;
  }
  return 'persona';
}

export function normalizeCharacterCard(
  raw: Record<string, unknown>,
  avatarDataUrl: string | null
): CharacterProfile {
  const data =
    raw.data && typeof raw.data === 'object'
      ? (raw.data as Record<string, unknown>)
      : raw;
  const name = readString(data.name || raw.name).trim();
  if (!name) {
    throw new Error('角色卡缺少 name 字段。');
  }
  const now = new Date().toISOString();
  const isV3 =
    raw.spec === 'chara_card_v3' ||
    raw.spec_version === '3.0' ||
    raw.spec_version === '3.0.0';
  return {
    id: createCharacterId(),
    name,
    avatarDataUrl,
    interactionMode: readCodepaprInteractionMode(raw, data),
    description: readString(data.description),
    personality: readString(data.personality),
    scenario: readString(data.scenario),
    firstMessage: readString(data.first_mes || data.firstMessage || data.first_message),
    exampleMessages: readString(data.mes_example || data.exampleMessages || data.example_messages),
    systemPrompt: readString(data.system_prompt || data.systemPrompt),
    postHistoryInstructions: readString(
      data.post_history_instructions || data.postHistoryInstructions
    ),
    tags: uniqueStrings(data.tags),
    creator: readString(data.creator),
    characterVersion: readString(data.character_version || data.characterVersion),
    source: isV3 ? 'chara-card-v3' : 'imported',
    createdAt: now,
    updatedAt: now,
  };
}

export function buildCharacterCardSpec(character: CharacterProfile): Record<string, unknown> {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      first_mes: character.firstMessage,
      mes_example: character.exampleMessages,
      system_prompt: character.systemPrompt,
      post_history_instructions: character.postHistoryInstructions,
      creator: character.creator,
      character_version: character.characterVersion,
      tags: character.tags,
      extensions: {
        codepapr: {
          interactionMode: resolveCharacterInteractionMode(character),
        },
      },
    },
  };
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}
