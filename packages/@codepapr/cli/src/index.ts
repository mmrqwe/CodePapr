#!/usr/bin/env node

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import readline from 'node:readline';
import chalk from 'chalk';
import { Command } from 'commander';
import { DeepSeekProvider, OpenAIProvider, ClaudeProvider, LocalProvider, RequestBuilder, CacheValidator } from '@codepapr/api';
import {
  Agent,
  AppendOnlyLog,
  DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  buildSkillsSection,
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  EditHistory,
  ImmutablePrefix,
  Session,
  ToolRegistry,
  BUILTIN_PROMPT_COMMANDS,
  getDefaultAgentsTemplate,
  DEFAULT_SEARCH_SKILL_TEMPLATE,
  BUILTIN_AGENTS,
  mergeAgentDefinitions,
  parseSlashInput,
  expandCommandTemplate,
  getBuiltinPromptCommand,
  parseGoalCondition,
  evaluateGoalCondition,
  GoalRunner,
  serializeGoalState,
  GoalConditionParseError,
  type CommandDefinition,
  type ConditionExecutor,
} from '@codepapr/core';
import type { ILLMProvider, GoalVerdict, ConditionResult } from '@codepapr/types';
import { CacheStatsRepository, DSDatabase, SessionRepository } from '@codepapr/db';
import {
  DEFAULT_CODING_SYSTEM_PROMPT,
  buildCliSessionBootstrapPrompt,
  type CliMode,
} from './prompts';
import { ScriptedTestProvider } from './testing/scriptedTestProvider';
import { registerCliWorkspaceTools } from './tools/registerCliWorkspaceTools';
import { registerTaskTool } from './tools/subagent';
import {
  listCommandDefinitions,
  loadAgentDefinitions,
  loadCommandDefinition,
  loadProjectRulesSection,
  loadSkillDefinitions,
  readWorkspaceTextFile,
  runWorkspaceInlineCommand,
} from './tools/projectConfig';

const DEFAULT_DATA_DIR = join(homedir(), '.codepapr');
const DEFAULT_DB_FILE = 'codepapr.sqlite';
const APP_SETTINGS_KEY = 'ui.settings';
const PROJECT_AGENTS_FILE = '.CodePapr/AGENTS.md';
const PROJECT_SEARCH_SKILL_FILE = '.CodePapr/skills/search/SKILL.md';

interface StoredAppSettings {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  systemPrompt?: string;
  mentorEnabled?: boolean;
  mentorModel?: string;
  mentorBaseURL?: string;
  mentorApiKey?: string;
  mentorApiFormat?: 'openai' | 'claude';
  mentorMaxTokens?: number;
  maxMentorConsultations?: number;
  mentorThinkingEnabled?: boolean;
}

interface DataLocation {
  dir: string;
  dbFile: string;
}

interface BaseCommandOptions {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  system?: string;
  workspace?: string;
  mode?: CliMode;
}

interface PreparedRuntime {
  db: DSDatabase;
  sessionRepo: SessionRepository;
  statsRepo: CacheStatsRepository;
  sessionId: string;
  agent: Agent;
  workspacePath: string;
  mode: CliMode;
  customPrompt: string;
  rulesSection: string;
  skillDefinitions: import('@codepapr/core').SkillDefinition[];
  toolCount: number;
  editHistory: EditHistory;
  fastModel: string;
  baseModel: string;
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude';
  baseURL: string;
  systemPrompt: string;
  allToolDefinitions: import('@codepapr/types').IToolDefinition[];
  toolRegistry: ToolRegistry;
  maxToolRounds: number;
  close: () => void;
}

function formatCommandSummary(command: Pick<CommandDefinition, 'name' | 'description'>): string {
  return `--${command.name}${command.description ? `: ${command.description}` : ''}`;
}

function buildCommandHelpText(customCommands: readonly CommandDefinition[]): string[] {
  const lines = [
    '本地命令:',
    '--help: 查看命令说明',
    '--commands: 查看命令说明',
    '--goal <condition>: 自主循环执行直到验证条件达成（如 --goal exec:npm test）',
  ];

  if (BUILTIN_PROMPT_COMMANDS.length > 0) {
    lines.push('', '内置任务命令:');
    for (const command of BUILTIN_PROMPT_COMMANDS) {
      lines.push(formatCommandSummary(command));
    }
  }

  if (customCommands.length > 0) {
    lines.push('', '项目命令:');
    for (const command of customCommands) {
      lines.push(formatCommandSummary(command));
    }
  } else {
    lines.push('', '项目命令: 当前没有自定义命令（在 .CodePapr/commands/ 添加 *.md）');
  }

  lines.push('', '兼容说明: 旧的 /命令 仍可识别，但默认入口改为 --命令。');
  return lines;
}

const LEGACY_SYSTEM_PROMPT_MARKERS = [
  '核心工作流：',
  'Ask 是普通聊天问答模式',
  'Agent 是完全自主执行模式',
];

function normalizeCustomSystemPrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  if (trimmed === DEFAULT_CODING_SYSTEM_PROMPT.trim()) {
    return '';
  }
  if (LEGACY_SYSTEM_PROMPT_MARKERS.every((marker) => trimmed.includes(marker))) {
    return '';
  }
  return trimmed;
}

function resolveDataLocation(): DataLocation {
  mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  return {
    dir: DEFAULT_DATA_DIR,
    dbFile: DEFAULT_DB_FILE,
  };
}

const ACTIVE_DATA_LOCATION = resolveDataLocation();

function openDB(): DSDatabase {
  const db = new DSDatabase(join(ACTIVE_DATA_LOCATION.dir, ACTIVE_DATA_LOCATION.dbFile));
  db.init();
  return db;
}

function readStoredSettings(db: DSDatabase): StoredAppSettings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(APP_SETTINGS_KEY) as
    | { value: string }
    | undefined;

  if (!row) return {};

  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StoredAppSettings;
  } catch {
    return {};
  }
}

function normalizeProviderName(provider: string | undefined): 'deepseek' | 'openai' | 'claude' | 'local' {
  if (provider === 'openai' || provider === 'claude' || provider === 'local') return provider;
  return 'deepseek';
}

function buildProvider(
  name: string,
  apiKey: string,
  baseURL?: string
): { provider: ILLMProvider; key: 'deepseek' | 'openai' | 'claude' } {
  if (process.env.CODEPAPR_TEST_PROVIDER === 'scripted') {
    return {
      provider: new ScriptedTestProvider(),
      key: name === 'openai' || name === 'claude' ? name : 'deepseek',
    };
  }

  switch (name) {
    case 'deepseek':
      return { provider: new DeepSeekProvider({ apiKey }), key: 'deepseek' };
    case 'openai':
      return { provider: new OpenAIProvider({ apiKey, ...(baseURL ? { baseURL } : {}) }), key: 'openai' };
    case 'claude':
      return { provider: new ClaudeProvider({ apiKey }), key: 'claude' };
    case 'local':
      // 本地模型走 OpenAI 兼容协议，请求构建语义复用 openai
      return { provider: new LocalProvider({ apiKey, ...(baseURL ? { baseURL } : {}) }), key: 'openai' };
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

async function prepareRuntime(opts: BaseCommandOptions): Promise<PreparedRuntime> {
  const db = openDB();
  const storedSettings = readStoredSettings(db);
  const providerName = normalizeProviderName(opts.provider ?? storedSettings.provider);
  const model = opts.model ?? storedSettings.model ?? 'deepseek-v4-pro';
  const customPrompt = normalizeCustomSystemPrompt(opts.system ?? storedSettings.systemPrompt);
  const apiKey =
    opts.apiKey ||
    storedSettings.apiKey ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    '';

  if (!apiKey && providerName !== 'local' && process.env.CODEPAPR_TEST_PROVIDER !== 'scripted') {
    db.close();
    throw new Error('未提供 API key');
  }

  const workspacePath = resolve(opts.workspace ?? process.cwd());
  const rulesSection = await loadProjectRulesSection(workspacePath);
  const skillDefinitions = await loadSkillDefinitions(workspacePath);
  const mode = opts.mode ?? 'agent';
  const sessionRepo = new SessionRepository(db);
  const statsRepo = new CacheStatsRepository(db);
  const baseURL = opts.baseUrl ?? storedSettings.baseURL;
  const { provider, key } = buildProvider(providerName, apiKey || 'test-key', baseURL);

  const editHistory = new EditHistory();
  const toolRegistry = new ToolRegistry();
  const workspaceTools = registerCliWorkspaceTools(toolRegistry, workspacePath, editHistory);
  const customAgentDefinitions = await loadAgentDefinitions(workspacePath);
  const agentDefinitions = mergeAgentDefinitions(BUILTIN_AGENTS, customAgentDefinitions);
  const taskToolContext: import('./tools/subagent').TaskToolContext = {
    workspacePath,
    provider,
    providerKey: key,
    baseModel: model,
    fastModelEnabled: true,
    fastModel: 'deepseek-v4-flash',
    maxToolRounds: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
    rulesSection,
    customPrompt,
    lang: 'zh-CN',
    skillDefinitions,
    agents: agentDefinitions,
    editHistory,
    baseURL: baseURL ?? '',
    statsRepo,
    parentSessionId: '',
    mentor: storedSettings.mentorEnabled
      ? {
          enabled: true,
          model: storedSettings.mentorModel ?? '',
          baseURL: storedSettings.mentorBaseURL ?? '',
          apiKey: storedSettings.mentorApiKey ?? '',
          apiFormat: storedSettings.mentorApiFormat ?? 'openai',
           maxTokens: storedSettings.mentorMaxTokens ?? 10000,
          maxConsultations: storedSettings.maxMentorConsultations ?? 2,
          thinkingEnabled: storedSettings.mentorThinkingEnabled ?? false,
        }
      : undefined,
  };
  const taskTool = registerTaskTool(toolRegistry, taskToolContext);
  const allTools = [
    ...workspaceTools,
    ...(taskTool ? [taskTool] : []),
  ];
  const systemPrompt = buildRuntimeSystemPrompt({
    mode,
    workspacePath,
    lang: 'zh-CN',
    rulesSection,
    toolNames: allTools.map((tool) => tool.name),
  });

  const prefix = new ImmutablePrefix({
    systemPrompt,
    tools: allTools,
    model,
    parameters: { temperature: 0.7, topP: 0.9, maxTokens: 393_216, thinkingEnabled: true },
  });

  const sessionId = sessionRepo.create({
    model,
    provider: key,
    tools: allTools,
    systemPrompt,
    parameters: { temperature: 0.7, topP: 0.9, maxTokens: 393_216, thinkingEnabled: true },
    isPrefixFrozen: true,
    prefixHash: prefix.computeHash(),
  });

  taskToolContext.parentSessionId = sessionId;

  // 生成轻量的 ProjectGraph 概览，注入到 bootstrap 提示中
  let projectGraphSummary: string | undefined;
  try {
    const { buildWorkspaceProjectGraphSummary } = await import('./tools/workspaceFs');
    const projectGraph = await buildWorkspaceProjectGraphSummary(workspacePath, undefined, 2, 12, 120, 6, 120);

    // 将 ProjectGraph 转换为简洁的文本摘要
    const summaryParts: string[] = [];
    summaryParts.push(`项目根: ${projectGraph.root}`);

    // 添加入口点列表
    const entryPoints = projectGraph.nodes.filter((n) => n.entryPoint && n.kind === 'file');
    if (entryPoints.length > 0) {
      summaryParts.push('');
      summaryParts.push('入口点:');
      for (const entry of entryPoints.slice(0, 8)) {
        summaryParts.push(`  - ${entry.path}`);
      }
      if (entryPoints.length > 8) {
        summaryParts.push(`  ... 还有 ${entryPoints.length - 8} 个入口点`);
      }
    }

    // 添加关键符号概览
    const symbolNodes = projectGraph.nodes.filter((n) => n.kind === 'symbol' && n.symbol);
    const classSymbols = symbolNodes.filter((s) => s.symbol?.kind === 'class' || s.symbol?.kind.toLowerCase().includes('class'));
    const functionSymbols = symbolNodes.filter((s) => s.symbol?.kind === 'function' || s.symbol?.kind.toLowerCase().includes('function'));

    if (classSymbols.length > 0) {
      summaryParts.push('');
      summaryParts.push(`关键类 (共 ${classSymbols.length} 个):`);
      for (const sym of classSymbols.slice(0, 8)) {
        summaryParts.push(`  - ${sym.symbol?.name} (${sym.path})`);
      }
      if (classSymbols.length > 8) {
        summaryParts.push(`  ... 还有 ${classSymbols.length - 8} 个`);
      }
    }

    if (functionSymbols.length > 0) {
      summaryParts.push('');
      summaryParts.push(`关键函数 (共 ${functionSymbols.length} 个):`);
      for (const sym of functionSymbols.slice(0, 8)) {
        summaryParts.push(`  - ${sym.symbol?.name} (${sym.path})`);
      }
      if (functionSymbols.length > 8) {
        summaryParts.push(`  ... 还有 ${functionSymbols.length - 8} 个`);
      }
    }

    // 添加统计
    summaryParts.push('');
    summaryParts.push(`统计: ${projectGraph.summary.files} 个文件, ${projectGraph.summary.symbols} 个符号, ${projectGraph.summary.edges} 个关系`);

    projectGraphSummary = summaryParts.join('\n');
  } catch {
    // 静默失败，不生成 ProjectGraph 摘要
    projectGraphSummary = undefined;
  }

  const sessionBootstrapPrompt = buildCliSessionBootstrapPrompt(
    workspacePath,
    customPrompt,
    buildSkillsSection(skillDefinitions, 'zh-CN'),
    projectGraphSummary
  );
  const log = new AppendOnlyLog(sessionId);
  if (sessionBootstrapPrompt.trim()) {
    await log.append({
      id: 'session-bootstrap',
      role: 'assistant',
      content: sessionBootstrapPrompt.trim(),
      timestamp: Date.now(),
      metadata: {
        sessionBootstrap: true,
      },
    });
  }

  const session = new Session({ sessionId, prefix, toolRegistry, log });
  const agent = new Agent({
    session,
    provider,
    providerName: key,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
  });

  return {
    db,
    sessionRepo,
    statsRepo,
    sessionId,
    agent,
    workspacePath,
    mode,
    customPrompt,
    rulesSection,
    skillDefinitions,
    toolCount: allTools.length,
    editHistory,
    fastModel: 'deepseek-v4-flash',
    baseModel: model,
    provider,
    providerName: key,
    baseURL: baseURL ?? '',
    systemPrompt,
    allToolDefinitions: toolRegistry.getAll(),
    toolRegistry,
    maxToolRounds: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
    close: () => {
      db.close();
    },
  };
}

function createEphemeralAgent(runtime: PreparedRuntime, model: string): Agent {
  const prefix = new ImmutablePrefix({
    systemPrompt: runtime.systemPrompt,
    tools: runtime.allToolDefinitions,
    model,
    parameters: { temperature: 0.3, topP: 0.9, maxTokens: 393_216, thinkingEnabled: false },
  });
  const sessionId = runtime.sessionRepo.create({
    model,
    provider: runtime.providerName,
    tools: runtime.allToolDefinitions,
    systemPrompt: runtime.systemPrompt,
    parameters: { temperature: 0.3, topP: 0.9, maxTokens: 393_216, thinkingEnabled: false },
    isPrefixFrozen: true,
    prefixHash: prefix.computeHash(),
  });
  const log = new AppendOnlyLog(sessionId);
  const session = new Session({ sessionId, prefix, log, toolRegistry: runtime.toolRegistry });
  return new Agent({
    session,
    provider: runtime.provider,
    providerName: runtime.providerName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    maxToolRounds: runtime.maxToolRounds,
  });
}

function resolveAgentForCommand(runtime: PreparedRuntime, command: CommandDefinition): Agent {
  if (command.model === 'fast' && runtime.fastModel) {
    return createEphemeralAgent(runtime, runtime.fastModel);
  }
  return runtime.agent;
}

function printCacheStats(sessionId: string, statsRepo: CacheStatsRepository, cacheStats?: {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  newInputTokens: number;
  outputTokens: number;
  cacheHitRate?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}): void {
  if (!cacheStats) return;
  statsRepo.save(sessionId, cacheStats);
  const officialPromptCacheSummary =
    typeof cacheStats.promptCacheHitTokens === 'number' ||
    typeof cacheStats.promptCacheMissTokens === 'number'
      ? ` prompt_hit=${cacheStats.promptCacheHitTokens ?? 0} prompt_miss=${cacheStats.promptCacheMissTokens ?? 0}`
      : '';
  console.log(
    chalk.gray(
      `  [缓存] hit=${cacheStats.cacheReadTokens} create=${cacheStats.cacheCreationTokens} in=${cacheStats.newInputTokens} out=${cacheStats.outputTokens}${officialPromptCacheSummary} 命中率=${((cacheStats.cacheHitRate ?? 0) * 100).toFixed(1)}%`
    )
  );
}

async function runSinglePrompt(mode: CliMode, prompt: string, opts: BaseCommandOptions): Promise<void> {
  const runtime = await prepareRuntime({ ...opts, mode });
  try {
    const wrappedPrompt = buildRuntimeUserPrompt({
      mode,
      input: prompt,
      workspacePath: runtime.workspacePath,
      lang: 'zh-CN',
    });
    const response = await runtime.agent.chat(wrappedPrompt);
    console.log(response.content);
    printCacheStats(runtime.sessionId, runtime.statsRepo, response.cacheStats);
  } finally {
    runtime.close();
  }
}

async function runInteractive(mode: CliMode, opts: BaseCommandOptions): Promise<void> {
  const runtime = await prepareRuntime({ ...opts, mode });
  console.log(
    chalk.cyan(
      `\nCodePapr ${mode.toUpperCase()} (${runtime.sessionId.slice(0, 8)})\nworkspace: ${runtime.workspacePath}\ntools: ${runtime.toolCount}\n输入 --help 查看命令，--exit 退出\n`
    )
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> => new Promise((resolveQuestion) => rl.question(question, resolveQuestion));
  let isRunning = true;

  try {
    while (isRunning) {
      const input = (await ask(chalk.green(`${mode} ▸ `))).trim();
      if (!input) continue;
      if (input === '--exit' || input === '--quit' || input === '/exit' || input === '/quit') {
        isRunning = false;
        continue;
      }

      const slash = parseSlashInput(input);
      if (slash) {
        const handled = await handleSlashCommand(slash, runtime);
        if (handled) {
          continue;
        }
      }

      try {
        const wrappedPrompt = buildRuntimeUserPrompt({
          mode,
          input,
          workspacePath: runtime.workspacePath,
          lang: 'zh-CN',
        });
        const response = await runtime.agent.chat(wrappedPrompt);
        console.log(chalk.cyan('AI ▸ ') + response.content);
        printCacheStats(runtime.sessionId, runtime.statsRepo, response.cacheStats);
      } catch (error) {
        console.error(chalk.red(`错误: ${(error as Error).message}`));
      }
    }
  } finally {
    rl.close();
    runtime.close();
  }
}

const CLI_VERIFIER_OBJECTIVE_PROMPT = `You are a Goal Verifier. You have NO tools. You can only read the execution transcript and condition results provided to you. Your job is to detect whether the Worker is fabricating success.

## Judgment Rules
- SATISFIED: condition met: true AND transcript shows real tool calls matching the claimed work
- NOT_MET: condition met: false OR Worker skipped verification or assumed output
- AMBIGUOUS: condition and Worker's claims contradict in a way you cannot resolve

## Output Format (STRICT JSON)
{"verdict": "SATISFIED" | "NOT_MET" | "AMBIGUOUS", "evidence": "...", "missing": "..."}

Output ONLY the JSON object.`;

const CLI_VERIFIER_SUBJECTIVE_PROMPT = `You are a Goal Verifier for a subjective task. You have NO tools. You can only read the execution transcript.

## Judgment Rules
- SATISFIED: transcript shows real, meaningful tool calls (file writes, edits, downloads, etc.) that clearly advance the stated goal
- NOT_MET: Worker hasn't done enough, OR declared success without actual tool calls, OR work is superficial
- AMBIGUOUS: You genuinely cannot tell from the transcript. Use sparingly.

## Output Format (STRICT JSON)
{"verdict": "SATISFIED" | "NOT_MET" | "AMBIGUOUS", "evidence": "...", "missing": "..."}

Output ONLY the JSON object.`;

function parseVerifierJson(content: string): GoalVerdict {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.verdict === 'SATISFIED' || parsed.verdict === 'NOT_MET' || parsed.verdict === 'AMBIGUOUS') {
      return {
        verdict: parsed.verdict,
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
        missing: typeof parsed.missing === 'string' ? parsed.missing : undefined,
      };
    }
  } catch { /* fall through */ }
  const upper = trimmed.toUpperCase();
  if (upper.includes('SATISFIED')) return { verdict: 'SATISFIED', evidence: trimmed.slice(0, 500) };
  if (upper.includes('AMBIGUOUS')) return { verdict: 'AMBIGUOUS', evidence: trimmed.slice(0, 500), missing: '解析失败' };
  return { verdict: 'NOT_MET', evidence: trimmed.slice(0, 500) || 'Verifier 未返回有效判定', missing: '无法解析' };
}

async function runCliVerifier(
  transcript: string,
  conditionResult: ConditionResult,
  goalText: string,
  isSubjective: boolean,
  runtime: PreparedRuntime
): Promise<GoalVerdict> {
  const verifierModel = runtime.fastModel || runtime.baseModel;
  const systemPrompt = isSubjective ? CLI_VERIFIER_SUBJECTIVE_PROMPT : CLI_VERIFIER_OBJECTIVE_PROMPT;

  const userPrompt = isSubjective
    ? [
        '## Goal (Subjective — no machine-verifiable condition)',
        goalText,
        '',
        '## Worker Execution Transcript',
        '```',
        transcript || '(No tool calls recorded)',
        '```',
        '',
        'Did the Worker genuinely complete the goal? Output your verdict as strict JSON.',
      ].join('\n')
    : [
        '## Worker Execution Transcript',
        '```',
        transcript || '(No tool calls recorded)',
        '```',
        '',
        '## Objective Condition Result',
        `**Met:** ${conditionResult.met}`,
        '```',
        conditionResult.evidence,
        '```',
        '',
        'Output your verdict as strict JSON.',
      ].join('\n');

  const prefix = new ImmutablePrefix({
    systemPrompt,
    tools: [],
    model: verifierModel,
    parameters: { temperature: 0.1, topP: 0.9, maxTokens: 1000, thinkingEnabled: false },
  });
  const log = new AppendOnlyLog(`verifier-${Date.now()}`);
  await log.append({ id: 'v-user', role: 'user', content: userPrompt, timestamp: Date.now() });
  const request = new RequestBuilder().build({
    prefix,
    appendLog: log,
    model: verifierModel,
    provider: runtime.providerName,
    temperature: 0.1,
    maxTokens: 1000,
    tools: [],
  });

  try {
    const response = await runtime.provider.chat(request);
    const content = response.choices[0]?.message.content?.trim() ?? '';
    return parseVerifierJson(content);
  } catch (err) {
    return {
      verdict: conditionResult.met ? 'SATISFIED' : 'NOT_MET',
      evidence: `Verifier 调用失败（${(err as Error).message}），降级为仅条件评估`,
    };
  }
}

const cliConditionExecutor: ConditionExecutor = {
  runCommand: async (workspacePath, command, args) => {
    const result = spawnSync(command, args, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.signal === 'SIGTERM' && result.status === null,
    };
  },
};

async function runCliGoalLoop(goalArgs: string, runtime: PreparedRuntime): Promise<void> {
  const condition = parseGoalCondition(goalArgs);
  const pipeIndex = goalArgs.indexOf('|');
  const userGoalText = pipeIndex > 0 ? goalArgs.slice(0, pipeIndex).trim() : '';

  console.log(chalk.cyan(`\n🎯 Goal: ${condition.humanReadable}`));
  console.log(chalk.gray(`   验证条件: ${condition.clauses.length} 个子句\n`));

  let aborted = false;
  const onSigInt = () => { aborted = true; };
  process.on('SIGINT', onSigInt);

  try {
    const goalRunner = new GoalRunner({
      condition,
      userGoalText,
      lang: 'zh-CN',
      limits: {
        maxIterations: 20,
        maxWallClockMs: 1_800_000,
      },
      callbacks: {
        runWorkerTurn: async (turnPrompt, isFeedback) => {
          if (isFeedback) {
            console.log(chalk.yellow(`\n🔄 反馈注入，继续...\n`));
          }
          const response = await runtime.agent.chat(turnPrompt);
          console.log(chalk.cyan('\nAI ▸ ') + response.content);
          if (response.cacheStats) {
            printCacheStats(runtime.sessionId, runtime.statsRepo, response.cacheStats);
          }
          const session = runtime.agent.getSession();
          const allMessages = session.logStore.getAllMessages();
          const transcript = allMessages
            .filter(
              (m) =>
                m.role === 'tool' ||
                (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0)
            )
            .slice(-20)
            .map((m) => {
              if (m.role === 'tool') {
                const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                return `[Tool Result] ${c.slice(0, 500)}`;
              }
              if (m.toolCalls) {
                return `[Tool Calls] ${m.toolCalls.map((tc) => tc.name).join(', ')}`;
              }
              return '';
            })
            .filter(Boolean)
            .join('\n');
          return {
            content: response.content,
            transcript,
            outputTokens: response.cacheStats?.outputTokens ?? 0,
          };
        },
        runVerifier: async (transcript, conditionResult) => {
          return runCliVerifier(transcript, conditionResult, condition.humanReadable, condition.clauses.length === 0, runtime);
        },
        evaluateCondition: async () => {
          return evaluateGoalCondition(condition, runtime.workspacePath, cliConditionExecutor);
        },
        onStateChange: (state) => {
          if (state.status === 'running') {
            console.log(chalk.gray(`\n   [Goal] 第 ${state.iteration} 轮 | Verifier: ${state.lastVerdict?.verdict ?? '—'} | ${Math.round(state.elapsedMs / 1000)}s`));
          }
        },
        writeGoalState: async (state) => {
          try {
            writeFileSync(
              join(runtime.workspacePath, '.CodePapr', 'goal-state.md'),
              serializeGoalState(state, condition, userGoalText),
              'utf-8'
            );
          } catch { /* silent */ }
        },
        isAborted: () => aborted,
      },
    });

    const result = await goalRunner.run();

    console.log('');
    if (result.status === 'satisfied') {
      console.log(chalk.green(`✅ Goal 已达成，共 ${result.iteration} 轮（${Math.round(result.elapsedMs / 1000)} 秒）`));
    } else if (result.status === 'interrupted') {
      console.log(chalk.yellow('⏹ Goal 已被中断'));
    } else if (result.status === 'limit_exceeded') {
      console.log(chalk.yellow(`⚠ Goal 超过限制，已执行 ${result.iteration} 轮`));
    } else {
      console.log(chalk.red(`❌ Goal 出错: ${result.error ?? '未知'}`));
    }
    console.log('');
  } finally {
    process.off('SIGINT', onSigInt);
  }
}

/**
 * 处理本地聊天命令（--help）与项目自定义/内置提示命令。
 * 返回 true 表示已处理（无需再交给 Agent）；返回 false 表示应作为普通输入交给 Agent。
 */
async function handleSlashCommand(
  slash: { name: string; args: string[] },
  runtime: PreparedRuntime
): Promise<boolean> {
  const lower = slash.name.toLowerCase();
  if (lower === 'undo') {
    console.log(chalk.gray('命令已移除。请直接让代理执行回滚，或在 Git 面板中做显式恢复/回退。'));
    return true;
  }

  if (lower === 'redo') {
    console.log(chalk.gray('命令已移除。请直接让代理执行回滚，或在 Git 面板中做显式恢复/回退。'));
    return true;
  }

  if (lower === 'help' || lower === 'commands') {
    const definitions = await listCommandDefinitions(runtime.workspacePath);
    console.log('');
    for (const line of buildCommandHelpText(definitions)) {
      console.log(line ? chalk.bold(line) : '');
    }
    console.log('');
    return true;
  }

  if (lower === 'goal') {
    const goalArgs = slash.args.join(' ');
    try {
      await runCliGoalLoop(goalArgs, runtime);
    } catch (err) {
      console.error(
        chalk.red(
          err instanceof GoalConditionParseError
            ? err.message
            : `Goal 出错: ${(err as Error).message}`
        )
      );
    }
    return true;
  }

  const definition = await loadCommandDefinition(runtime.workspacePath, slash.name);
  const promptCommand = definition ?? getBuiltinPromptCommand(lower);
  if (!promptCommand) {
    return false;
  }

  const expanded = await expandCommandTemplate(promptCommand.template, slash.args, {
    readFile: (path) => readWorkspaceTextFile(runtime.workspacePath, path),
    runShell: (command) => runWorkspaceInlineCommand(runtime.workspacePath, command),
  });

  try {
    const wrappedPrompt = buildRuntimeUserPrompt({
      mode: runtime.mode,
      input: expanded,
      workspacePath: runtime.workspacePath,
      lang: 'zh-CN',
    });
    const agent = resolveAgentForCommand(runtime, promptCommand);
    const response = await agent.chat(wrappedPrompt);
    console.log(chalk.cyan('AI ▸ ') + response.content);
    printCacheStats(runtime.sessionId, runtime.statsRepo, response.cacheStats);
  } catch (error) {
    console.error(chalk.red(`错误: ${(error as Error).message}`));
  }
  return true;
}

function attachAgentOptions(command: Command): Command {
  return command
    .option('-p, --provider <provider>', '提供商 (deepseek|openai|claude|local)')
    .option('-m, --model <model>', '模型名称')
    .option('-k, --api-key <key>', 'API key')
    .option('--base-url <url>', '自定义 API 端点（OpenAI 兼容 / 本地模型）')
    .option('-s, --system <prompt>', '系统提示词')
    .option('-w, --workspace <path>', '工作区路径，默认当前目录');
}

async function executeAgentCommand(mode: CliMode, promptParts: string[], opts: BaseCommandOptions): Promise<void> {
  const prompt = promptParts.join(' ').trim();
  if (prompt) {
    await runSinglePrompt(mode, prompt, opts);
    return;
  }
  await runInteractive(mode, opts);
}

const program = new Command();
program.name('codepapr').description('CodePapr 终端编程 Agent').version('0.1.0');

attachAgentOptions(
  program
    .command('chat')
    .description('进入交互式终端编程 Agent；默认使用 Agent 模式')
    .argument('[prompt...]', '消息内容')
    .option('--mode <mode>', '模式 (ask|plan|agent)', 'agent')
).action(async (promptParts: string[], opts: BaseCommandOptions) => {
  const mode = opts.mode === 'ask' || opts.mode === 'plan' || opts.mode === 'agent' ? opts.mode : 'agent';
  await executeAgentCommand(mode, promptParts, opts);
});

attachAgentOptions(
  program.command('ask').description('Ask 模式：普通问答，默认不改文件').argument('[prompt...]', '问题')
).action(async (promptParts: string[], opts: BaseCommandOptions) => {
  await executeAgentCommand('ask', promptParts, opts);
});

attachAgentOptions(
  program.command('plan').description('Plan 模式：拆解复杂任务并给出执行方案').argument('[prompt...]', '任务')
).action(async (promptParts: string[], opts: BaseCommandOptions) => {
  await executeAgentCommand('plan', promptParts, opts);
});

attachAgentOptions(
  program.command('agent').description('Agent 模式：自主执行任务并验证结果').argument('[prompt...]', '任务')
).action(async (promptParts: string[], opts: BaseCommandOptions) => {
  await executeAgentCommand('agent', promptParts, opts);
});

program
  .command('init')
  .description('在当前工作区初始化 .CodePapr 项目规则和默认 Skill')
  .option('-w, --workspace <path>', '工作区路径，默认当前目录')
  .action((opts: { workspace?: string }) => {
    const workspacePath = resolve(opts.workspace ?? process.cwd());
    const target = join(workspacePath, PROJECT_AGENTS_FILE);
    mkdirSync(join(workspacePath, '.CodePapr'), { recursive: true });
    if (existsSync(target)) {
      console.log(chalk.yellow(`${PROJECT_AGENTS_FILE} 已存在: ${target}`));
    } else {
      writeFileSync(target, getDefaultAgentsTemplate(), 'utf8');
      console.log(chalk.green(`已创建项目规则文件: ${target}`));
    }
    const skillTarget = join(workspacePath, PROJECT_SEARCH_SKILL_FILE);
    if (!existsSync(skillTarget)) {
      mkdirSync(join(workspacePath, '.CodePapr', 'skills', 'search'), { recursive: true });
      writeFileSync(skillTarget, DEFAULT_SEARCH_SKILL_TEMPLATE, 'utf8');
      console.log(chalk.green(`已创建默认搜索 Skill: ${skillTarget}`));
    } else {
      console.log(chalk.yellow(`${PROJECT_SEARCH_SKILL_FILE} 已存在: ${skillTarget}`));
    }
  });

program
  .command('session')
  .description('列出所有会话')
  .action(() => {
    const db = openDB();
    const repo = new SessionRepository(db);
    const sessions = repo.list();
    if (sessions.length === 0) {
      console.log(chalk.gray('暂无会话'));
    } else {
      console.log(chalk.bold('\n会话列表:\n'));
      for (const session of sessions) {
        console.log(
          `  ${chalk.yellow(session.sessionId.slice(0, 8))} | ${session.provider}/${session.model} | ${new Date(session.lastModified).toLocaleString()}`
        );
      }
    }
    db.close();
  });

program
  .command('stats <sessionId>')
  .description('查看会话缓存统计')
  .action((sessionId: string) => {
    const db = openDB();
    const repo = new CacheStatsRepository(db);
    const aggregate = repo.getAggregate(sessionId);
    console.log(chalk.bold(`\n会话 ${sessionId.slice(0, 8)} 累积统计:\n`));
    console.log(`  缓存读取: ${chalk.green(aggregate.totalCacheRead)}`);
    console.log(`  缓存创建: ${chalk.yellow(aggregate.totalCacheCreation)}`);
    console.log(`  新输入:   ${aggregate.totalInput}`);
    console.log(`  输出:     ${aggregate.totalOutput}`);
    console.log(`  命中率:   ${chalk.cyan((aggregate.avgHitRate * 100).toFixed(2) + '%')}`);
    console.log(`  轮次:     ${aggregate.count}\n`);
    db.close();
  });

program
  .command('config')
  .description('显示配置')
  .action(() => {
    const db = openDB();
    const storedSettings = readStoredSettings(db);
    console.log(chalk.bold('\nCodePapr 配置:\n'));
    console.log(`  数据目录: ${ACTIVE_DATA_LOCATION.dir}`);
    console.log(`  数据库文件: ${ACTIVE_DATA_LOCATION.dbFile}`);
    console.log(`  SQLite 设置: ${storedSettings.model ? '✓' : '✗'}`);
    console.log(`  Provider: ${storedSettings.provider ?? 'deepseek'}`);
    console.log(`  Model: ${storedSettings.model ?? 'deepseek-v4-pro'}`);
    console.log(`  SQLite API Key: ${storedSettings.apiKey ? '✓' : '✗'}`);
    console.log(`  DEEPSEEK_API_KEY:  ${process.env.DEEPSEEK_API_KEY ? '✓' : '✗'}`);
    console.log(`  OPENAI_API_KEY:    ${process.env.OPENAI_API_KEY ? '✓' : '✗'}`);
    console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}\n`);
    db.close();
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(chalk.red('错误:'), error.message);
  process.exit(1);
});
