import { RequestBuilder } from '@codepapr/api';
import { AppendOnlyLog, ImmutablePrefix } from '@codepapr/core';
import type { IImageContent } from '@codepapr/types';
import { buildProviderForProfile, buildProviderInstance } from '../store/internals/providerFactory';
import { findProfileById, resolveProviderName } from '../store/internals/settingsNormalizer';
import type { Lang, Settings } from '../store/internals/types';
import { fastSlotSupportsVision, modelSupportsVision } from './visionRouting';

const VISION_OFFLOAD_SESSION = 'vision-offload';
const VISION_OFFLOAD_MAX_TOKENS = 2048;

const SYSTEM_PROMPT =
  'You describe images for another coding assistant that cannot see them. ' +
  'Be precise and complete: transcribe visible text, describe UI layout, errors, code, diagrams, and relevant visual details. ' +
  'Do not solve the user task. Output only the description.';

function userPrompt(lang: Lang, hint?: string): string {
  const trimmed = hint?.trim();
  if (trimmed) {
    return lang === 'en'
      ? `The user attached image(s) with this request:\n${trimmed}\n\nDescribe the image(s) so another model can continue the work.`
      : lang === 'zh-TW'
      ? `使用者附上圖片，請求如下：\n${trimmed}\n\n請描述圖片，供另一個無法看圖的模型繼續工作。`
      : `用户附上了图片，请求如下：\n${trimmed}\n\n请描述这些图片，供另一个无法看图的模型继续工作。`;
  }
  return lang === 'en'
    ? 'Describe these images for another coding assistant.'
    : lang === 'zh-TW'
    ? '請描述這些圖片，供另一個編程助手使用。'
    : '请描述这些图片，供另一个编程助手使用。';
}

export function formatVisionOffloadBlock(lang: Lang, description: string): string {
  const header =
    lang === 'en'
      ? '[Fast-model vision description]'
      : lang === 'zh-TW'
      ? '【快速模型識圖結果】'
      : '【快速模型识图结果】';
  return `${header}\n${description.trim()}`;
}

export async function describeImagesWithFastModel(
  settings: Settings,
  images: IImageContent[],
  options: { lang?: Lang; hint?: string } = {},
): Promise<string> {
  if (!images.length) {
    throw new Error('No images to describe');
  }
  if (!fastSlotSupportsVision(settings)) {
    throw new Error('Fast model vision is not available');
  }

  const lang = options.lang ?? settings.lang ?? 'zh-CN';
  const fastProfile = findProfileById(settings, settings.fastProfileId);
  const provider = fastProfile
    ? buildProviderForProfile(fastProfile, settings.streamIdleTimeoutMs)
    : buildProviderInstance(settings);
  const providerName = fastProfile
    ? resolveProviderName(fastProfile)
    : resolveProviderName(settings);
  const model = (fastProfile?.model || settings.fastModel).trim();

  const prefix = new ImmutablePrefix({
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    model,
    parameters: {
      temperature: 0.2,
      topP: 0.9,
      maxTokens: VISION_OFFLOAD_MAX_TOKENS,
      thinkingEnabled: false,
    },
  });
  const log = new AppendOnlyLog(VISION_OFFLOAD_SESSION);
  await log.append({
    id: 'vision-offload-user',
    role: 'user',
    content: userPrompt(lang, options.hint),
    images,
    timestamp: Date.now(),
  });

  const request = new RequestBuilder().build({
    prefix,
    appendLog: log,
    model,
    provider: providerName,
    temperature: 0.2,
    topP: 0.9,
    maxTokens: VISION_OFFLOAD_MAX_TOKENS,
    tools: [],
  });
  const response = await provider.chat(request);
  const text = response.choices[0]?.message.content?.trim();
  if (!text) {
    throw new Error('Fast model returned an empty vision description');
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * If the current model cannot see images, replace `__images` with a text
 * description from the fast model. Leaves native-vision results unchanged.
 */
export async function replaceImagesInToolResult(
  result: unknown,
  settings: Settings,
  currentModel: string,
): Promise<unknown> {
  if (!isRecord(result) || !('__images' in result)) return result;
  const images = result.__images;
  if (!Array.isArray(images) || images.length === 0) return result;
  if (modelSupportsVision(settings, currentModel)) return result;

  const rest: Record<string, unknown> = { ...result };
  delete rest.__images;

  if (!fastSlotSupportsVision(settings)) {
    return {
      ...rest,
      description:
        settings.lang === 'en'
          ? 'Image was not sent: no vision-capable fast model is enabled.'
          : '图片未发送：未启用支持多模态的快速模型。',
    };
  }

  try {
    const description = await describeImagesWithFastModel(settings, images as IImageContent[], {
      lang: settings.lang,
    });
    return {
      ...rest,
      describedByFastModel: true,
      description,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...rest,
      description:
        settings.lang === 'en'
          ? `Fast-model vision failed: ${message}`
          : `快速模型识图失败：${message}`,
    };
  }
}
