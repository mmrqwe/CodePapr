import { selectContextCompactionModelRoute } from './modelRouting';
import { runCachedModelRequest } from './cachedModelRequest';
import { buildProviderInstance } from '../store/internals/providerFactory';
import { resolveProviderName } from '../store/internals/settingsNormalizer';
import type { Settings } from '../store/internals/types';

export const MEMORY_CONSOLIDATION_MAX_LINES = 200;

export function planMemoryConsolidation(content: string | undefined, maxLines: number = MEMORY_CONSOLIDATION_MAX_LINES): boolean {
  if (!content) return false;
  return content.split('\n').length > maxLines;
}

function buildMemoryConsolidationPrompt(options: {
  content: string;
  lang?: string;
}): { systemPrompt: string; userPrompt: string } {
  const { content, lang } = options;

  const prompts: Record<string, string> = {
    'zh-CN': [
      '你是一位项目知识整理专家。你的任务是将一个项目记忆文件进行去重和压缩。',
      '',
      '原始文件包含多个 ## YYYY-MM-DD 主题 格式的条目。',
      '',
      '整理规则：',
      '1. 合并：主题相同或高度相关的多个条目合并为一个',
      '2. 精简：压缩冗长描述，保留核心信息和关键细节',
      '3. 删除：移除已解决、过时、不再有价值的临时内容',
      '4. 必须保留：用户偏好（语言、工具链、代码风格等）、项目约定（构建/部署/配置约定）、错误模式与解法（同一错误多次出现的解决方案）、架构决策',
      '5. 格式：输出必须保持 ## YYYY-MM-DD 主题 的 markdown 结构',
      '6. 目标：输出控制在 200 行以内',
      '',
      '只输出整理后的完整 markdown 内容，不要任何解释。',
    ].join('\n'),
    'zh-TW': [
      '你是一位專案知識整理專家。你的任務是將一個專案記憶檔案進行去重和壓縮。',
      '',
      '原始檔案包含多個 ## YYYY-MM-DD 主題 格式的條目。',
      '',
      '整理規則：',
      '1. 合併：主題相同或高度相關的多個條目合併為一個',
      '2. 精簡：壓縮冗長描述，保留核心資訊和關鍵細節',
      '3. 刪除：移除已解決、過時、不再有價值的臨時內容',
      '4. 必須保留：使用者偏好（語言、工具鏈、程式碼風格等）、專案約定（建置/部署/設定約定）、錯誤模式與解法（同一錯誤多次出現的解決方案）、架構決策',
      '5. 格式：輸出必須保持 ## YYYY-MM-DD 主題 的 markdown 結構',
      '6. 目標：輸出控制在 200 行以內',
      '',
      '只輸出整理後的完整 markdown 內容，不要任何解釋。',
    ].join('\n'),
    en: [
      'You are a project knowledge organizer. Your task is to deduplicate and compress a project memory file.',
      '',
      'The original file contains entries in ## YYYY-MM-DD Topic format.',
      '',
      'Consolidation rules:',
      '1. Merge: Combine multiple entries on the same or closely related topics into one',
      '2. Compress: Condense verbose descriptions while retaining core information and key details',
      '3. Remove: Delete resolved, outdated, or no-longer-valuable temporary content',
      '4. Must retain: User preferences (language, toolchain, code style, etc.), project conventions (build/deploy/config conventions), error patterns and fixes (solutions to recurring errors), architectural decisions',
      '5. Format: Output must maintain the ## YYYY-MM-DD Topic markdown structure',
      '6. Target: Keep output under 200 lines',
      '',
      'Output ONLY the consolidated complete markdown content, no explanations.',
    ].join('\n'),
  };

  const systemPrompt = prompts[lang ?? 'zh-CN'] ?? prompts['zh-CN'];
  return {
    systemPrompt,
    userPrompt: content,
  };
}

function fallbackConsolidateMemory(content: string, maxLines: number): string {
  const sections = content.split(/(?=^## )/m);
  if (sections.length === 0) return content;

  const seen = new Set<string>();
  const unique = sections.filter((s) => {
    const title = s.split('\n')[0]?.trim();
    if (!title || seen.has(title)) return false;
    seen.add(title);
    return true;
  });

  const joined = unique.join('');
  if (joined.split('\n').length <= maxLines) {
    return joined.trim();
  }

  const sorted = [...unique].sort((a, b) => {
    const dateA = a.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '0000';
    const dateB = b.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '0000';
    return dateB.localeCompare(dateA);
  });

  let result = '';
  for (const s of sorted) {
    const candidate = result + s;
    if (candidate.split('\n').length > maxLines) break;
    result = candidate;
  }
  return result.trim();
}

export async function consolidateMemoryContent(
  content: string | undefined,
  settings: Settings
): Promise<string | null> {
  if (!content) return null;
  if (!planMemoryConsolidation(content)) return null;

  const route = selectContextCompactionModelRoute(
    {
      model: settings.model,
      fastModelEnabled: settings.fastModelEnabled,
      fastModel: settings.fastModel,
      temperature: settings.temperature,
      maxTokens: settings.compactionMaxTokens,
      thinkingEnabled: false,
      compactionTemperature: settings.compactionTemperature,
    },
    settings.compactionModel
  );

  if (!route) {
    return fallbackConsolidateMemory(content, MEMORY_CONSOLIDATION_MAX_LINES);
  }

  const provider = buildProviderInstance(settings);
  if (!provider) {
    return fallbackConsolidateMemory(content, MEMORY_CONSOLIDATION_MAX_LINES);
  }

  const { systemPrompt, userPrompt } = buildMemoryConsolidationPrompt({
    content,
    lang: settings.lang,
  });

  try {
    const result = await runCachedModelRequest({
      provider,
      providerName: resolveProviderName(settings),
      model: route.model,
      thinking: { type: 'disabled' },
      systemPrompt,
      userPrompt,
      temperature: route.temperature,
      maxTokens: route.maxTokens,
    });

    const consolidated = result.response.choices[0]?.message.content?.trim();
    if (consolidated && consolidated.length > 50) {
      return consolidated;
    }
  } catch (e) {
    console.warn('Memory consolidation via LLM failed, using fallback:', e);
  }

  return fallbackConsolidateMemory(content, MEMORY_CONSOLIDATION_MAX_LINES);
}
