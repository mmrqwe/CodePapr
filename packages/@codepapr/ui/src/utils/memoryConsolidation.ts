import { selectContextCompactionModelRoute } from './modelRouting';
import { runCachedModelRequest } from './cachedModelRequest';
import { buildProviderInstance } from '../store/internals/providerFactory';
import { resolveProviderName } from '../store/internals/settingsNormalizer';
import type { Settings } from '../store/internals/types';

/**
 * ADR-008（PR4）：旧「回合后 consolidation 读改写 memory.md」路径已退役，
 * 由 memory_write + 准入策略 + ledger 投影替代。本文件只保留冷启动
 * bootstrap 内容生成（bootstrap 产物同样改走 ledger，见 sendMessage）。
 */

function formatMemoryDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildMemoryBootstrapPrompt(options: {
  projectGraphSummary?: string;
  rulesSection?: string;
  firstUserMessage?: string;
  lang?: string;
}): { systemPrompt: string; userPrompt: string } {
  const { projectGraphSummary, rulesSection, firstUserMessage, lang } = options;

  const prompts: Record<string, string> = {
    'zh-CN': [
      '你是一位项目记忆初始化助手。基于给定的项目信息，生成一份初始项目记忆的正文内容。',
      '',
      '生成内容必须覆盖（从输入中能识别的）：',
      '1. 项目目录结构与包布局',
      '2. 技术栈（语言、框架、包管理器）',
      '3. 构建/lint/test 命令',
      '4. 关键项目约定（从规则文件中识别）',
      '',
      '格式要求：',
      '- 使用简洁的 markdown，用 ### 子标题和列表组织',
      '- 只记录项目特定事实，不要记录通用知识或猜测',
      '- 如果某类信息无法从输入中识别，跳过该类，不要编造',
      '- 不要输出顶层 `## 日期` 标题（外层会自动添加）',
      '- 控制在 80 行以内',
      '',
      '只输出正文 markdown 内容，不要任何解释。',
    ].join('\n'),
    'zh-TW': [
      '你是一位專案記憶初始化助手。基於給定的專案資訊，生成一份初始專案記憶的正文內容。',
      '',
      '生成內容必須覆蓋（從輸入中能識別的）：',
      '1. 專案目錄結構與套件佈局',
      '2. 技術棧（語言、框架、套件管理器）',
      '3. 建置/lint/test 命令',
      '4. 關鍵專案約定（從規則檔案中識別）',
      '',
      '格式要求：',
      '- 使用簡潔的 markdown，用 ### 子標題和列表組織',
      '- 只記錄專案特定事實，不要記錄通用知識或猜測',
      '- 如果某類資訊無法從輸入中識別，跳過該類，不要編造',
      '- 不要輸出頂層 `## 日期` 標題（外層會自動添加）',
      '- 控制在 80 行以內',
      '',
      '只輸出正文 markdown 內容，不要任何解釋。',
    ].join('\n'),
    en: [
      'You are a project memory initializer. Based on the provided project information, generate the body content of an initial project memory.',
      '',
      'The content must cover (identifiable from the input):',
      '1. Project directory structure and package layout',
      '2. Tech stack (language, framework, package manager)',
      '3. Build/lint/test commands',
      '4. Key project conventions (identified from rules files)',
      '',
      'Format requirements:',
      '- Use concise markdown with ### subheadings and lists',
      '- Record only project-specific facts; do NOT record general knowledge or guesses',
      '- If a category cannot be identified from the input, skip it; do not fabricate',
      '- Do NOT output a top-level `## date` heading (the outer layer adds it automatically)',
      '- Keep it under 80 lines',
      '',
      'Output ONLY the body markdown content, no explanations.',
    ].join('\n'),
  };

  const systemPrompt = prompts[lang ?? 'zh-CN'] ?? prompts['zh-CN'];

  const sections: string[] = [];
  if (projectGraphSummary) sections.push(`### 项目结构概览\n${projectGraphSummary}`);
  if (rulesSection) sections.push(`### 项目规则\n${rulesSection}`);
  if (firstUserMessage) sections.push(`### 用户首条消息\n${firstUserMessage}`);
  const userPrompt = sections.join('\n\n');

  return { systemPrompt, userPrompt };
}

export async function bootstrapMemoryContent(
  input: { projectGraphSummary?: string; rulesSection?: string; firstUserMessage?: string },
  settings: Settings
): Promise<string | null> {
  const { projectGraphSummary, rulesSection, firstUserMessage } = input;
  if (!projectGraphSummary && !rulesSection && !firstUserMessage) return null;

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

  if (!route) return null;

  const provider = buildProviderInstance(settings);
  if (!provider) return null;

  const { systemPrompt, userPrompt } = buildMemoryBootstrapPrompt({
    projectGraphSummary,
    rulesSection,
    firstUserMessage,
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

    const generated = result.response.choices[0]?.message.content?.trim();
    if (generated && generated.length > 50) {
      const date = formatMemoryDate(new Date());
      return `## ${date} 项目初始化记忆\n\n${generated}`;
    }
  } catch (e) {
    console.warn('Memory bootstrap via LLM failed:', e);
  }

  return null;
}
