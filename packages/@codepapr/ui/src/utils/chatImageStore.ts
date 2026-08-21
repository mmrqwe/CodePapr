import { invoke } from '@tauri-apps/api/core';
import type { IImageContent } from '@codepapr/types';

interface SaveChatImageResult {
  path: string;
}

interface ChatImageEntry {
  path: string;
  mediaType: string;
  data: string;
}

interface LoadChatImagesResult {
  images: ChatImageEntry[];
}

/** 发送时把图片写入 .CodePapr/chat-images/，返回路径引用（写入失败则无
 *  path，该图片将不被持久化）。单张失败不影响其它图片。 */
export async function persistChatImage(
  workspacePath: string,
  image: IImageContent
): Promise<IImageContent> {
  if (image.path) return image;
  if (!image.data) return image;
  try {
    const result = await invoke<SaveChatImageResult>('save_chat_image', {
      workspacePath: workspacePath.trim(),
      mediaType: image.mediaType,
      dataBase64: image.data,
    });
    return { ...image, path: result.path };
  } catch (err) {
    console.warn(
      '[CodePapr] 聊天图片落盘失败（重启后不可见）:',
      err instanceof Error ? err.message : err
    );
    return image;
  }
}

/** 加载消息后按路径回填图片 base64（图片文件缺失/损坏时跳过，消息其余内容
 *  不受影响）。返回按 path 索引的映射，由调用方合并回消息。 */
export async function loadChatImageData(
  workspacePath: string,
  paths: string[]
): Promise<Map<string, { mediaType: string; data: string }>> {
  const unique = [...new Set(paths)].filter((p) => p.trim().length > 0);
  const result = new Map<string, { mediaType: string; data: string }>();
  if (unique.length === 0) return result;
  // 后端单次批量上限：分批读取。
  const BATCH = 96;
  for (let i = 0; i < unique.length; i += BATCH) {
    try {
      const response = await invoke<LoadChatImagesResult>('load_chat_images', {
        workspacePath: workspacePath.trim(),
        paths: unique.slice(i, i + BATCH),
      });
      for (const entry of response.images) {
        result.set(entry.path, { mediaType: entry.mediaType, data: entry.data });
      }
    } catch (err) {
      console.warn(
        '[CodePapr] 回填聊天图片失败:',
        err instanceof Error ? err.message : err
      );
    }
  }
  return result;
}

/** 收集消息列表中缺少 data、需要从磁盘回填的图片路径。 */
export function collectUnresolvedImagePaths(messages: readonly { images?: IImageContent[] }[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const image of message.images ?? []) {
      if (image.path && !image.data) paths.add(image.path);
    }
  }
  return [...paths];
}

/** 用回填的数据补齐消息图片的 data 字段（无数据则保持原样）。 */
export function applyImageDataToMessages<T extends { images?: IImageContent[] }>(
  messages: T[],
  dataByPath: Map<string, { mediaType: string; data: string }>
): T[] {
  if (dataByPath.size === 0) return messages;
  return messages.map((message) => {
    if (!message.images?.some((image) => image.path && !image.data)) return message;
    return {
      ...message,
      images: message.images.map((image) => {
        if (!image.path || image.data) return image;
        const entry = dataByPath.get(image.path);
        if (!entry) return image;
        return { ...image, mediaType: entry.mediaType, data: entry.data };
      }),
    };
  });
}

/** 一站式：收集缺 data 的图片路径 → 从磁盘读取 → 回填。无待回填项时原样返回。 */
export async function hydrateImageMessages<T extends { images?: IImageContent[] }>(
  workspacePath: string,
  messages: T[]
): Promise<T[]> {
  const paths = collectUnresolvedImagePaths(messages);
  if (paths.length === 0 || !workspacePath) return messages;
  const dataByPath = await loadChatImageData(workspacePath, paths);
  return applyImageDataToMessages(messages, dataByPath);
}
