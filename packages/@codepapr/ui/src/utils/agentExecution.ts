import type { IAgentResponse, ICacheStatistics, IMessage } from '@codepapr/types';
import type { ProjectDiagnosticsReport } from './projectDiagnostics';
import type { WorkMode } from './agentPrompts';
import type { Lang } from './i18n';

const PLAN_OR_DEFER_PATTERNS = [
  /(现在需要|現在需要|还需要|還需要|仍需|还要|還要|需要先|需要更新|需要修改|需要安裝|需要安装|先安装|先安裝|先更新|先修改|接下来|接下來|下一步|后续|後續|我会先|我會先|我将先|我將先|我先|先检查|先檢查|先看看|先處理|先处理|接着处理|接著處理|继续修改|繼續修改|继续处理|繼續處理|继续执行|繼續執行|按计划继续|按計劃繼續|尚未|未完成|剩余|剩餘|还剩|還剩|部分完成|暂未|暫未)/,
  /(^|\s)(let me|i need to|we need to|i should|i'll|i will|next step|first,?|i'm going to)/i,
];

const REMAINING_WORK_PATTERNS = [
  /(现在需要|現在需要|还需要|還需要|仍需|还要|還要|需要先|接下来|接下來|下一步|后续|後續|尚未|未完成|剩余|剩餘|还剩|還剩|部分完成|暂未|暫未|继续修改|繼續修改|继续处理|繼續處理|继续执行|繼續執行|继续补|繼續補|继续修|繼續修|继续测试|繼續測試|继续验证|繼續驗證)/,
  /(^|\s)(i need to|we need to|next step|still need|remaining|not finished|unfinished|continue fixing|continue validating)(\s|$)/i,
];

const COMPLETION_PATTERNS = [
  /(已完成|已經完成|已经完成|完成了|已修改|已更新|已安裝|已安装|已执行|已執行|已验证|已驗證|验证通过|驗證通過|检查通过|檢查通過|最终检查通过|最終檢查通過|最终验证通过|最終驗證通過|全部通过|全部通過|修复完成|修復完成|实现完成|實現完成|已处理|已處理|已解决|已解決|解决了|解決了|修复了|修復了|修好了|已搞定|处理完成|處理完成)/,
  /(^|[\s，。；:：])(好了|完毕|完畢|搞定(?:了)?|改完了|改好了|没问题了|沒問題了)(?=$|[\s，。；!！?？])/,
  /(^|\s)(done|completed|finished|installed|updated|verified|fixed|resolved|all good|looks good|lgtm|pr ready)(?=$|[\s.!?,;:])/i,
];

const BLOCKER_PATTERNS = [
  /(请先在设置中填写 API Key|請先在設置中填寫 API Key|请先选择项目文件夹|請先選擇項目文件夾|请选择项目文件夹|請選擇項目文件夾|无法初始化会话|無法初始化會話|无法访问项目|無法訪問項目|无法写入|無法寫入|没有权限|沒有權限|权限不足|權限不足|需要你确认|需要你確認|请确认|請確認|需要用户确认|需要用戶確認|需要你提供|请提供|請提供|需要密钥|需要 token|需要 API Key|真实阻塞|真實阻塞)/,
  /(^|\s)(missing api key|permission denied|select a project|choose a folder|need confirmation|user confirmation|required secret)(\s|$)/i,
];

export const MAX_AGENT_AUTO_CONTINUE_PASSES = 6;

const AGENT_EXECUTION_SUMMARY_TRIGGER_TOOLS = new Set([
  'file_write',
  'write',
  'edit',
  'patch',
  'workspace_write_file',
  'workspace_apply_patch',
  'workspace_apply_diff',
  'git_write',
  'git',
  'workspace_git_branch_checkout',
  'workspace_git_stage',
  'workspace_git_commit',
  'workspace_git_restore',
  'workspace_git_reset',
  'web_access',
  'web_download',
  'web_download_file',
  'browser',
  'browser_take_screenshot',
  'terminal',
  'exec',
  'bash',
  'workspace_run_command',
  'workspace_run_shell_command',
  'workspace_start_background_command',
  'workspace_start_shell_background_command',
  'workspace_start_preview_session',
  'workspace_project_diagnostics',
]);

const BLOCKING_COMMAND_TOOL_NAMES = new Set(['workspace_run_command', 'workspace_run_shell_command']);
const BACKGROUND_COMMAND_TOOL_NAMES = new Set([
  'workspace_start_background_command',
  'workspace_start_preview_session',
  'workspace_start_shell_background_command',
]);

const FILE_MUTATION_TOOL_NAMES = new Set([
  'write',
  'edit',
  'patch',
  'workspace_write_file',
  'workspace_apply_patch',
  'workspace_apply_diff',
]);

export interface ExecutedToolSummary {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  success: boolean;
  result: unknown;
  error?: string;
}

export interface FileChangeSummary {
  path: string;
  kind: 'created' | 'updated';
  added: number;
  deleted: number;
  beforeLines: number;
  afterLines: number;
}

interface FileChangeTotals {
  files: number;
  created: number;
  updated: number;
  added: number;
  deleted: number;
}

interface CommandExecutionSummary {
  command: string;
  args: string[];
  status: number | null;
  timedOut: boolean;
  background: boolean;
  pid: number | null;
  started: boolean;
}

interface CommandExecutionRecord extends CommandExecutionSummary {
  index: number;
  stdout: string;
  stderr: string;
}

interface GitStatusFileSummary {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  originalPath?: string;
}

interface GitWorkspaceSummary {
  branch?: string;
  files: GitStatusFileSummary[];
}

interface GitActionSummary {
  toolName: string;
  ok: boolean;
  message: string;
}

interface ProjectDiagnosticsStageSummary {
  label: string;
  command: string;
  status: number | null;
  timedOut: boolean;
  success: boolean;
  fallback: boolean;
}

interface ProjectDiagnosticsSummary {
  available: boolean;
  overallStatus: 'passed' | 'failed' | 'unavailable';
  stages: ProjectDiagnosticsStageSummary[];
  message?: string;
}

interface ExecutionContextCopy {
  heading: string;
  files: string;
  commands: string;
  diagnostics: string;
  failures: string;
  commandOutputStdout: string;
  commandOutputStderr: string;
  diagnosticsOverall: (status: ProjectDiagnosticsSummary['overallStatus']) => string;
  diagnosticsUnavailable: (message: string) => string;
  toolFailure: (tool: string, error: string) => string;
}

interface CompletionCopy {
  heading: string;
  doneHeading: string;
  filesHeading: string;
  gitHeading: string;
  commandsHeading: string;
  diagnosticsHeading: string;
  nextHeading: string;
  inspected: (count: number) => string;
  changedFiles: (totals: FileChangeTotals) => string;
  fileLineRange: (beforeLines: number, afterLines: number) => string;
  undoState: (hasGitDelta: boolean) => string;
  gitActions: (count: number) => string;
  executedCommands: (count: number) => string;
  coveredSetupFailures: (count: number) => string;
  diagnosticsStatus: (summary: ProjectDiagnosticsSummary) => string;
  diagnosticsStage: (stage: ProjectDiagnosticsStageSummary) => string;
  diagnosticsUnavailable: (message: string) => string;
  finalReply: (content: string) => string;
  noStructuredWork: string;
  gitWorkspace: (branch: string | undefined, count: number) => string;
  gitAction: (action: GitActionSummary) => string;
  gitFile: (file: GitStatusFileSummary) => string;
  commandStatus: (command: string, status: number | null, timedOut: boolean) => string;
  backgroundCommandStatus: (command: string, pid: number | null, started: boolean) => string;
  failedCommandNextStep: (command: string) => string;
  failedToolNextStep: (tool: string) => string;
  continueLines: (pass: number, summarizedResponse: string) => string[];
  languageDirective: string;
}

const COMPLETION_COPY: Record<Lang, CompletionCopy> = {
  'zh-CN': {
    heading: '执行总结',
    doneHeading: '已完成：',
    filesHeading: '影响文件：',
    gitHeading: 'Git 变更：',
    commandsHeading: '命令结果：',
    diagnosticsHeading: '项目诊断：',
    nextHeading: '下一步：',
    inspected: (count) => `已完成 ${count} 次上下文读取/搜索/目录检查。`,
    changedFiles: (totals) =>
      `已编辑 ${totals.files} 个文件（新增 ${totals.created}、修改 ${totals.updated}），+${totals.added}/-${totals.deleted}。`,
    fileLineRange: (beforeLines, afterLines) => `，${beforeLines} -> ${afterLines} 行`,
    undoState: (hasGitDelta) =>
      hasGitDelta
        ? '撤销状态：未自动撤销；可继续在 Git 增量面板检查或手动回退。'
        : '撤销状态：本轮未执行自动撤销。',
    gitActions: (count) => `已执行 ${count} 个 Git 操作。`,
    executedCommands: (count) => `已执行 ${count} 个命令。`,
    coveredSetupFailures: (count) =>
      `有 ${count} 个早期依赖/环境型失败命令已被后续成功验证覆盖，不再视为剩余风险。`,
    diagnosticsStatus: (summary) =>
      summary.overallStatus === 'passed'
        ? '项目级诊断通过。'
        : summary.overallStatus === 'failed'
        ? '项目级诊断存在失败项。'
        : '项目级诊断当前不可用。',
    diagnosticsStage: (stage) =>
      `${stage.label} -> ${stage.timedOut ? '超时' : `退出码 ${stage.status ?? 'unknown'}`}${
        stage.fallback ? '（build fallback）' : ''
      }`,
    diagnosticsUnavailable: (message) => `项目级诊断不可用：${message}`,
    finalReply: (content) => `模型最终说明：${content}`,
    noStructuredWork: '本轮已结束，但没有收集到可结构化展示的工具执行结果。',
    gitWorkspace: (branch, count) => `已读取 Git 工作区状态${branch ? `（${branch}）` : ''}，共 ${count} 个变更文件。`,
    gitAction: (action) => `${action.ok ? '成功' : '失败'} ${action.toolName}：${action.message}`,
    gitFile: (file) =>
      `${file.indexStatus || ' '}${file.worktreeStatus || ' '} ${file.path}${
        file.originalPath ? ` <- ${file.originalPath}` : ''
      }`,
    commandStatus: (command, status, timedOut) =>
      timedOut
        ? `${command} -> 超时`
        : `${command} -> 退出码 ${status ?? 'unknown'}`,
    backgroundCommandStatus: (command, pid, started) =>
      `${command} -> ${started ? '已在后台启动' : '已在后台运行'}${typeof pid === 'number' ? ` (PID ${pid})` : ''}`,
    failedCommandNextStep: (command) => `检查并处理失败命令：${command}`,
    failedToolNextStep: (tool) => `检查失败工具调用：${tool}`,
    continueLines: (pass, summarizedResponse) => [
      '系统提醒：你处于 Agent 模式。',
      `这是第 ${pass} 次继续执行提醒。`,
      '你上一条回复仍然停留在计划、说明或口头承诺，没有把修改真正做完。',
      summarizedResponse ? `上一条回复摘要：${summarizedResponse}` : '',
      '现在不要再解释计划，不要说“我先看看/我会修改”。',
      '请立刻调用可用工具继续读写文件、安装依赖、运行命令并验证结果。',
      '只有在真实阻塞存在时，才允许停止，并明确说明阻塞。',
    ],
    languageDirective:
      '语言要求：内部思考、reasoning_content、过程说明、工具结果总结和最终回答默认使用简体中文。除代码、命令、文件路径、错误原文外，不要输出英文思考；如果必须引用英文，请在中文说明后附原文。',
  },
  'zh-TW': {
    heading: '執行總結',
    doneHeading: '已完成：',
    filesHeading: '影響文件：',
    gitHeading: 'Git 變更：',
    commandsHeading: '命令結果：',
    diagnosticsHeading: '項目診斷：',
    nextHeading: '下一步：',
    inspected: (count) => `已完成 ${count} 次上下文讀取/搜索/目錄檢查。`,
    changedFiles: (totals) =>
      `已編輯 ${totals.files} 個文件（新增 ${totals.created}、修改 ${totals.updated}），+${totals.added}/-${totals.deleted}。`,
    fileLineRange: (beforeLines, afterLines) => `，${beforeLines} -> ${afterLines} 行`,
    undoState: (hasGitDelta) =>
      hasGitDelta
        ? '撤銷狀態：未自動撤銷；可繼續在 Git 增量面板檢查或手動回退。'
        : '撤銷狀態：本輪未執行自動撤銷。',
    gitActions: (count) => `已執行 ${count} 個 Git 操作。`,
    executedCommands: (count) => `已執行 ${count} 個命令。`,
    coveredSetupFailures: (count) =>
      `有 ${count} 個早期依賴/環境型失敗命令已被後續成功驗證覆蓋，不再視為剩餘風險。`,
    diagnosticsStatus: (summary) =>
      summary.overallStatus === 'passed'
        ? '項目級診斷通過。'
        : summary.overallStatus === 'failed'
        ? '項目級診斷存在失敗項。'
        : '項目級診斷當前不可用。',
    diagnosticsStage: (stage) =>
      `${stage.label} -> ${stage.timedOut ? '超時' : `退出碼 ${stage.status ?? 'unknown'}`}${
        stage.fallback ? '（build fallback）' : ''
      }`,
    diagnosticsUnavailable: (message) => `項目級診斷不可用：${message}`,
    finalReply: (content) => `模型最終說明：${content}`,
    noStructuredWork: '本輪已結束，但沒有收集到可結構化展示的工具執行結果。',
    gitWorkspace: (branch, count) => `已讀取 Git 工作區狀態${branch ? `（${branch}）` : ''}，共 ${count} 個變更文件。`,
    gitAction: (action) => `${action.ok ? '成功' : '失敗'} ${action.toolName}：${action.message}`,
    gitFile: (file) =>
      `${file.indexStatus || ' '}${file.worktreeStatus || ' '} ${file.path}${
        file.originalPath ? ` <- ${file.originalPath}` : ''
      }`,
    commandStatus: (command, status, timedOut) =>
      timedOut
        ? `${command} -> 超時`
        : `${command} -> 退出碼 ${status ?? 'unknown'}`,
    backgroundCommandStatus: (command, pid, started) =>
      `${command} -> ${started ? '已在後台啟動' : '已在後台運行'}${typeof pid === 'number' ? ` (PID ${pid})` : ''}`,
    failedCommandNextStep: (command) => `檢查並處理失敗命令：${command}`,
    failedToolNextStep: (tool) => `檢查失敗工具調用：${tool}`,
    continueLines: (pass, summarizedResponse) => [
      '系統提醒：你處於 Agent 模式。',
      `這是第 ${pass} 次繼續執行提醒。`,
      '你上一條回覆仍停留在計劃、說明或口頭承諾，沒有把修改真正做完。',
      summarizedResponse ? `上一條回覆摘要：${summarizedResponse}` : '',
      '現在不要再解釋計劃，不要說「我先看看/我會修改」。',
      '請立刻調用可用工具繼續讀寫文件、安裝依賴、運行命令並驗證結果。',
      '只有在真實阻塞存在時，才允許停止，並明確說明阻塞。',
    ],
    languageDirective:
      '語言要求：內部思考、reasoning_content、過程說明、工具結果總結和最終回答默認使用繁體中文。除代碼、命令、文件路徑、錯誤原文外，不要輸出英文思考；如果必須引用英文，請先用中文說明再附原文。',
  },
  en: {
    heading: 'Execution Summary',
    doneHeading: 'Completed:',
    filesHeading: 'Changed files:',
    gitHeading: 'Git changes:',
    commandsHeading: 'Command results:',
    diagnosticsHeading: 'Project diagnostics:',
    nextHeading: 'Next steps:',
    inspected: (count) => `Completed ${count} read/search/list inspection steps.`,
    changedFiles: (totals) =>
      `Edited ${totals.files} file(s) (${totals.created} created, ${totals.updated} updated), +${totals.added}/-${totals.deleted}.`,
    fileLineRange: (beforeLines, afterLines) => `, ${beforeLines} -> ${afterLines} lines`,
    undoState: (hasGitDelta) =>
      hasGitDelta
        ? 'Undo status: no automatic revert was performed; review or revert the current Git delta manually.'
        : 'Undo status: no automatic revert was performed in this run.',
    gitActions: (count) => `Executed ${count} Git action(s).`,
    executedCommands: (count) => `Ran ${count} command(s).`,
    coveredSetupFailures: (count) =>
      `${count} earlier setup/dependency command failure(s) were later covered by successful validation and are not treated as remaining risk.`,
    diagnosticsStatus: (summary) =>
      summary.overallStatus === 'passed'
        ? 'Project diagnostics passed.'
        : summary.overallStatus === 'failed'
        ? 'Project diagnostics reported failures.'
        : 'Project diagnostics are unavailable.',
    diagnosticsStage: (stage) =>
      `${stage.label} -> ${stage.timedOut ? 'timed out' : `exit ${stage.status ?? 'unknown'}`}${
        stage.fallback ? ' (build fallback)' : ''
      }`,
    diagnosticsUnavailable: (message) => `Project diagnostics unavailable: ${message}`,
    finalReply: (content) => `Final model note: ${content}`,
    noStructuredWork: 'This run finished, but no structured tool execution result was captured.',
    gitWorkspace: (branch, count) => `Read Git workspace status${branch ? ` (${branch})` : ''} with ${count} changed file(s).`,
    gitAction: (action) => `${action.ok ? 'Succeeded' : 'Failed'} ${action.toolName}: ${action.message}`,
    gitFile: (file) =>
      `${file.indexStatus || ' '}${file.worktreeStatus || ' '} ${file.path}${
        file.originalPath ? ` <- ${file.originalPath}` : ''
      }`,
    commandStatus: (command, status, timedOut) =>
      timedOut
        ? `${command} -> timed out`
        : `${command} -> exit ${status ?? 'unknown'}`,
    backgroundCommandStatus: (command, pid, started) =>
      `${command} -> ${started ? 'started in background' : 'already running in background'}${typeof pid === 'number' ? ` (PID ${pid})` : ''}`,
    failedCommandNextStep: (command) => `Investigate the failed command: ${command}`,
    failedToolNextStep: (tool) => `Investigate the failed tool call: ${tool}`,
    continueLines: (pass, summarizedResponse) => [
      'System reminder: you are in Agent mode.',
      `This is continue-execution reminder #${pass}.`,
      'Your previous reply stayed at plan/description/promise level and did not finish the requested work.',
      summarizedResponse ? `Previous reply summary: ${summarizedResponse}` : '',
      'Do not explain the plan again and do not say “let me check” or “I will modify it”.',
      'Use the available tools immediately to read/write files, install dependencies, run commands, and verify results.',
      'Only stop when there is a real blocker, and state that blocker explicitly.',
    ],
    languageDirective:
      'Language requirement: use English for internal reasoning, reasoning_content, progress explanations, tool-result summaries, and final answers by default. Only switch languages when the user explicitly asks for it or when code, commands, file paths, and raw error text must stay verbatim.',
  },
};

const EXECUTION_CONTEXT_COPY: Record<Lang, ExecutionContextCopy> = {
  'zh-CN': {
    heading: '执行证据摘要',
    files: '关键文件改动',
    commands: '关键命令结果',
    diagnostics: '关键诊断结果',
    failures: '失败工具',
    commandOutputStdout: 'stdout',
    commandOutputStderr: 'stderr',
    diagnosticsOverall: (status) =>
      status === 'passed'
        ? '项目诊断通过'
        : status === 'failed'
        ? '项目诊断失败'
        : '项目诊断不可用',
    diagnosticsUnavailable: (message) => `项目诊断不可用：${message}`,
    toolFailure: (tool, error) => `${tool} 失败：${error}`,
  },
  'zh-TW': {
    heading: '執行證據摘要',
    files: '關鍵文件改動',
    commands: '關鍵命令結果',
    diagnostics: '關鍵診斷結果',
    failures: '失敗工具',
    commandOutputStdout: 'stdout',
    commandOutputStderr: 'stderr',
    diagnosticsOverall: (status) =>
      status === 'passed'
        ? '項目診斷通過'
        : status === 'failed'
        ? '項目診斷失敗'
        : '項目診斷不可用',
    diagnosticsUnavailable: (message) => `項目診斷不可用：${message}`,
    toolFailure: (tool, error) => `${tool} 失敗：${error}`,
  },
  en: {
    heading: 'Execution Evidence Summary',
    files: 'Key file changes',
    commands: 'Key command results',
    diagnostics: 'Key diagnostics',
    failures: 'Failed tools',
    commandOutputStdout: 'stdout',
    commandOutputStderr: 'stderr',
    diagnosticsOverall: (status) =>
      status === 'passed'
        ? 'project diagnostics passed'
        : status === 'failed'
        ? 'project diagnostics failed'
        : 'project diagnostics unavailable',
    diagnosticsUnavailable: (message) => `project diagnostics unavailable: ${message}`,
    toolFailure: (tool, error) => `${tool} failed: ${error}`,
  },
};

function truncateForPrompt(content: string, maxLength: number = 240): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function getCompletionCopy(lang: Lang | undefined): CompletionCopy {
  return COMPLETION_COPY[lang ?? 'zh-CN'];
}

function truncateSummaryLine(content: string, maxLength: number = 180): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function getExecutionContextCopy(lang: Lang | undefined): ExecutionContextCopy {
  return EXECUTION_CONTEXT_COPY[lang ?? 'zh-CN'];
}

function truncateEvidenceBlock(content: string, maxLength: number = 260): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function buildGlobalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

function latestPatternMatchIndex(content: string, patterns: readonly RegExp[]): number {
  let latestIndex = -1;

  for (const pattern of patterns) {
    const globalPattern = buildGlobalPattern(pattern);
    let match: RegExpExecArray | null;

    while ((match = globalPattern.exec(content)) !== null) {
      latestIndex = Math.max(latestIndex, match.index);
      if (match[0].length === 0) {
        globalPattern.lastIndex += 1;
      }
    }
  }

  return latestIndex;
}

function getLatestAgentProgressSignal(content: string): 'completion' | 'remaining' | 'plan' | null {
  const latestCompletion = latestPatternMatchIndex(content, COMPLETION_PATTERNS);
  const latestRemaining = latestPatternMatchIndex(content, REMAINING_WORK_PATTERNS);
  const latestPlan = latestPatternMatchIndex(content, PLAN_OR_DEFER_PATTERNS);
  const latestIndex = Math.max(latestCompletion, latestRemaining, latestPlan);

  if (latestIndex < 0) {
    return null;
  }

  if (latestCompletion === latestIndex) {
    return 'completion';
  }

  if (latestRemaining === latestIndex) {
    return 'remaining';
  }

  return 'plan';
}

function getAgentCompletionSummaryRewriteInstructions(lang: Lang | undefined): {
  systemPrompt: string;
  userPromptPrefix: string;
} {
  switch (lang ?? 'zh-CN') {
    case 'zh-TW':
      return {
        systemPrompt:
          '你負責把一次已完成的編程 Agent 執行記錄，收束成給用戶看的簡潔最終總結。只能根據提供的記錄表述，不要腦補未發生的操作；保留關鍵文件路徑、命令驗證結果和仍存在的風險；只有在記錄明確顯示問題未被後續成功驗證覆蓋時，才把它寫成剩餘風險。語氣直接、簡短，不要再寫「執行總結」這類標題。若輸入中已經包含 Markdown 文件鏈接或 codepapr-file: 鏈接，請原樣保留，不要改寫鏈接目標。',
        userPromptPrefix: '請把下面這段結構化執行記錄改寫成更自然的最終總結，直接輸出最終內容：',
      };
    case 'en':
      return {
        systemPrompt:
          'You rewrite a completed coding-agent execution record into a concise final user-facing summary. Use only the provided record, do not invent work that did not happen, keep key file paths, validation results, and remaining risks, and only call something a remaining risk when the record shows it was not covered by later successful validation. Do not add headings like "Execution Summary". If the input already contains Markdown file links or codepapr-file: links, preserve those links exactly.',
        userPromptPrefix:
          'Rewrite the structured execution record below into a more natural final summary. Output only the final summary:',
      };
    case 'zh-CN':
    default:
      return {
        systemPrompt:
          '你负责把一次已完成的编程 Agent 执行记录，收束成给用户看的简洁最终总结。只能根据提供的记录表述，不要脑补未发生的操作；保留关键文件路径、命令验证结果和仍存在的风险；只有在记录明确显示问题未被后续成功验证覆盖时，才把它写成剩余风险。语气直接、简短，不要再写“执行总结”这类标题。如果输入里已经包含 Markdown 文件链接或 codepapr-file: 链接，请原样保留，不要改写链接目标。',
        userPromptPrefix: '请把下面这段结构化执行记录改写成更自然的最终总结，直接输出最终内容：',
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].filter(Boolean).join(' ').trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function buildToolRetryIdentity(tool: ExecutedToolSummary): Record<string, unknown> | undefined {
  const resultRecord = isRecord(tool.result) ? tool.result : undefined;
  const identity: Record<string, unknown> = {};

  for (const key of [
    'command',
    'args',
    'path',
    'relativePath',
    'url',
    'previewUrl',
    'query',
    'selector',
    'sessionId',
    'key',
  ]) {
    const value = resultRecord?.[key] ?? tool.arguments[key];
    if (value !== undefined) {
      identity[key] = value;
    }
  }

  if (Object.keys(identity).length > 0) {
    return identity;
  }

  return Object.keys(tool.arguments).length > 0 ? tool.arguments : undefined;
}

function buildToolRetryKey(tool: ExecutedToolSummary): string {
  const identity = buildToolRetryIdentity(tool);
  const toolKey = FILE_MUTATION_TOOL_NAMES.has(tool.name) ? 'workspace_file_mutation' : tool.name;
  return `${toolKey}:${identity ? stableStringify(identity) : tool.id}`;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function buildWorkspaceFileLink(path: string): string {
  return `[${escapeMarkdownLinkLabel(path)}](codepapr-file:${encodeURIComponent(path)})`;
}

export function buildLocalizedSystemPrompt(basePrompt: string, lang: Lang | undefined): string {
  const directive = getCompletionCopy(lang).languageDirective;
  const trimmed = basePrompt.trim();
  if (!trimmed) {
    return directive;
  }
  if (trimmed.includes(directive)) {
    return trimmed;
  }
  return `${directive}\n\n${trimmed}`;
}

export function buildAgentExecutionContinuePrompt(
  lastResponse: string,
  pass: number,
  lang: Lang | undefined = 'zh-CN'
): string {
  const summarizedResponse = truncateForPrompt(lastResponse);
  return getCompletionCopy(lang)
    .continueLines(pass, summarizedResponse)
    .filter(Boolean)
    .join(' ');
}

export function shouldAutoContinueAgentResponse(
  mode: WorkMode,
  taskText: string,
  response: Pick<IAgentResponse, 'content' | 'toolCalls'>
): boolean {
  if (mode !== 'agent') return false;
  if (response.toolCalls && response.toolCalls.length > 0) return false;

  const content = response.content.trim();
  if (!content) return false;
  if (hasAgentBlockerSignal(content)) return false;

  const latestSignal = getLatestAgentProgressSignal(content);

  if (latestSignal === 'completion') return false;
  if (latestSignal === 'remaining' || latestSignal === 'plan') return true;

  return false;
}

export function hasAgentPlanOrDeferralSignal(content: string): boolean {
  return PLAN_OR_DEFER_PATTERNS.some((pattern) => pattern.test(content));
}

export function hasAgentCompletionSignal(content: string): boolean {
  return COMPLETION_PATTERNS.some((pattern) => pattern.test(content));
}

export function hasAgentRemainingWorkSignal(content: string): boolean {
  return REMAINING_WORK_PATTERNS.some((pattern) => pattern.test(content));
}

export function hasAgentBlockerSignal(content: string): boolean {
  return BLOCKER_PATTERNS.some((pattern) => pattern.test(content));
}

export function hasSuccessfulValidationEvidence(
  tools: readonly ExecutedToolSummary[],
  projectDiagnosticsReport?: ProjectDiagnosticsReport | null
): boolean {
  if (projectDiagnosticsReport?.available === true && projectDiagnosticsReport.overallStatus === 'passed') {
    return true;
  }

  const diagnosticsSummary = summarizeProjectDiagnostics(tools);
  if (diagnosticsSummary?.available === true && diagnosticsSummary.overallStatus === 'passed') {
    return true;
  }

  return summarizeCommandExecutions(tools).some(
    (command) =>
      !command.background &&
      !command.timedOut &&
      (command.status ?? 1) === 0 &&
      /(test|vitest|jest|mocha|pytest|cargo test|build|compile|tsc|swiftc|py_compile|compileall|pyinstaller|lint|eslint|check|verify|validation|health ?check|\/health|smoke)/.test(
        formatCommand(command.command, command.args).toLowerCase()
      )
  );
}

export function hasOutstandingExecutionFailures(
  tools: readonly ExecutedToolSummary[]
): boolean {
  return (
    collectUnresolvedToolFailures(tools).length > 0 ||
    collectUnresolvedCommandFailures(tools).length > 0
  );
}

export function isAgentResponseSuccessfullyFinalized(params: {
  content: string;
  executedTools: readonly ExecutedToolSummary[];
  projectDiagnosticsReport?: ProjectDiagnosticsReport | null;
}): boolean {
  const content = params.content.trim();
  if (!content) {
    return false;
  }
  if (hasAgentBlockerSignal(content)) {
    return false;
  }

  if (getLatestAgentProgressSignal(content) !== 'completion') {
    return false;
  }
  if (params.projectDiagnosticsReport?.available === true && params.projectDiagnosticsReport.overallStatus === 'failed') {
    return false;
  }

  const diagnosticsSummary = summarizeProjectDiagnostics(params.executedTools);
  if (diagnosticsSummary?.available === true && diagnosticsSummary.overallStatus === 'failed') {
    return false;
  }

  if (collectUnresolvedCommandFailures(params.executedTools).length > 0) {
    return false;
  }

  if (hasSuccessfulValidationEvidence(params.executedTools, params.projectDiagnosticsReport)) {
    return true;
  }

  return collectUnresolvedToolFailures(params.executedTools).length === 0;
}

export function accumulateCacheStats(
  current: ICacheStatistics | undefined,
  next: ICacheStatistics | undefined
): ICacheStatistics | undefined {
  if (!current) return next;
  if (!next) return current;

  const promptCacheHitTokens =
    typeof current.promptCacheHitTokens === 'number' ||
    typeof next.promptCacheHitTokens === 'number'
      ? (current.promptCacheHitTokens ?? 0) + (next.promptCacheHitTokens ?? 0)
      : undefined;
  const promptCacheMissTokens =
    typeof current.promptCacheMissTokens === 'number' ||
    typeof next.promptCacheMissTokens === 'number'
      ? (current.promptCacheMissTokens ?? 0) + (next.promptCacheMissTokens ?? 0)
      : undefined;

  const newInputTokens = current.newInputTokens + next.newInputTokens;
  const cacheReadTokens = current.cacheReadTokens + next.cacheReadTokens;
  const cacheCreationTokens = current.cacheCreationTokens + next.cacheCreationTokens;
  const outputTokens = current.outputTokens + next.outputTokens;
  const totalInput = newInputTokens + cacheReadTokens + cacheCreationTokens;

  return {
    newInputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    cacheHitRate: totalInput > 0 ? cacheReadTokens / totalInput : 0,
    calls: (current.calls ?? 0) + (next.calls ?? 0),
    ...(typeof promptCacheHitTokens === 'number'
      ? { promptCacheHitTokens }
      : {}),
    ...(typeof promptCacheMissTokens === 'number'
      ? { promptCacheMissTokens }
      : {}),
  };
}

export function collectExecutedTools(messages: readonly IMessage[]): ExecutedToolSummary[] {
  const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  const executedTools: ExecutedToolSummary[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        toolCalls.set(toolCall.id, {
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
      }
      continue;
    }

    if (message.role !== 'tool' || !message.toolResult) {
      continue;
    }

    const toolCall = toolCalls.get(message.toolResult.toolCallId);
    const resultRecord = isRecord(message.toolResult.result) ? message.toolResult.result : undefined;
    const error =
      message.toolResult.error ??
      (typeof resultRecord?.error === 'string' ? resultRecord.error : undefined);

    executedTools.push({
      id: message.toolResult.toolCallId,
      name: toolCall?.name ?? 'unknown_tool',
      arguments: toolCall?.arguments ?? {},
      success: message.toolResult.success,
      result: message.toolResult.result,
      ...(error ? { error } : {}),
    });
  }

  return executedTools;
}

export function collectUnresolvedToolFailures(
  tools: readonly ExecutedToolSummary[]
): ExecutedToolSummary[] {
  const latestByKey = new Map<string, ExecutedToolSummary>();

  for (const tool of tools) {
    if (BLOCKING_COMMAND_TOOL_NAMES.has(tool.name)) {
      continue;
    }

    latestByKey.set(buildToolRetryKey(tool), tool);
  }

  return [...latestByKey.values()].filter(
    (tool) => !tool.success && hasMeaningfulFailureInfo(tool)
  );
}

function hasMeaningfulFailureInfo(tool: ExecutedToolSummary): boolean {
  const resultRecord = isRecord(tool.result) ? tool.result : undefined;
  const error =
    tool.error ??
    (typeof resultRecord?.error === 'string' ? resultRecord.error : '') ??
    '';
  if (error && error.trim() && error.trim() !== 'unknown') {
    return true;
  }
  if (typeof resultRecord?.stderr === 'string' && resultRecord.stderr.trim()) {
    return true;
  }
  if (typeof resultRecord?.message === 'string' && resultRecord.message.trim()) {
    return true;
  }
  return false;
}

function buildCommandRetryKey(command: string, args: readonly string[]): string {
  return stableStringify({ command, args: [...args] });
}

function collectCommandExecutionRecords(
  tools: readonly ExecutedToolSummary[]
): CommandExecutionRecord[] {
  return tools
    .flatMap((tool, index) => {
      if (!isRecord(tool.result)) {
        return [];
      }

      if (
        !BLOCKING_COMMAND_TOOL_NAMES.has(tool.name) &&
        !(BACKGROUND_COMMAND_TOOL_NAMES.has(tool.name) && tool.success)
      ) {
        return [];
      }

      const command =
        typeof tool.result.command === 'string'
          ? tool.result.command
          : typeof tool.arguments.command === 'string'
          ? tool.arguments.command
          : 'unknown';
      const args = toStringArray(tool.result.args ?? tool.arguments.args);

      return [
        {
          index,
          command,
          args,
          status:
            typeof tool.result.status === 'number' || tool.result.status === null
              ? tool.result.status
              : null,
          timedOut: tool.result.timedOut === true,
          background: BACKGROUND_COMMAND_TOOL_NAMES.has(tool.name),
          pid: typeof tool.result.pid === 'number' ? tool.result.pid : null,
          started: BACKGROUND_COMMAND_TOOL_NAMES.has(tool.name)
            ? tool.success && tool.result.started !== false
            : false,
          stdout: typeof tool.result.stdout === 'string' ? tool.result.stdout : '',
          stderr: typeof tool.result.stderr === 'string' ? tool.result.stderr : '',
        } satisfies CommandExecutionRecord,
      ];
    })
    .filter(Boolean);
}

const SETUP_LIKE_COMMAND_FAILURE_PATTERNS = [
  /module not found|modulenotfounderror|no module named|cannot find module|missing dependency|missing dependencies|dependency|dependencies/i,
  /command not found|not recognized as an internal or external command|no such file or directory/i,
  /importerror|cannot import name|failed to import|package .* is not installed/i,
  /依赖|缺少模块|未安装|找不到模块|模块不存在|命令不存在|command not found/i,
];

function isSetupLikeCommandFailure(command: CommandExecutionRecord): boolean {
  const haystack = [
    command.command,
    command.args.join(' '),
    command.stdout,
    command.stderr,
  ]
    .filter(Boolean)
    .join('\n');

  return SETUP_LIKE_COMMAND_FAILURE_PATTERNS.some((pattern) => pattern.test(haystack));
}

function collectCoveredSetupCommandFailures(
  tools: readonly ExecutedToolSummary[]
): CommandExecutionRecord[] {
  const records = collectCommandExecutionRecords(tools).filter((record) => !record.background);
  const latestByKey = new Map<string, CommandExecutionRecord>();

  for (const record of records) {
    latestByKey.set(buildCommandRetryKey(record.command, record.args), record);
  }

  return [...latestByKey.values()].filter((record) => {
    if (!(record.timedOut || (record.status ?? 0) !== 0)) {
      return false;
    }

    if (!isSetupLikeCommandFailure(record)) {
      return false;
    }

    return records.some(
      (laterRecord) =>
        laterRecord.index > record.index &&
        !laterRecord.timedOut &&
        (laterRecord.status ?? 1) === 0
    );
  });
}

function collectUnresolvedCommandFailures(
  tools: readonly ExecutedToolSummary[]
): CommandExecutionRecord[] {
  const records = collectCommandExecutionRecords(tools).filter((record) => !record.background);
  const latestByKey = new Map<string, CommandExecutionRecord>();

  for (const record of records) {
    latestByKey.set(buildCommandRetryKey(record.command, record.args), record);
  }

  const coveredKeys = new Set(
    collectCoveredSetupCommandFailures(tools).map((record) =>
      buildCommandRetryKey(record.command, record.args)
    )
  );

  return [...latestByKey.values()].filter(
    (record) =>
      (record.timedOut || (record.status ?? 0) !== 0) &&
      !coveredKeys.has(buildCommandRetryKey(record.command, record.args))
  );
}

export function shouldAppendAgentCompletionSummary(
  tools: readonly ExecutedToolSummary[]
): boolean {
  return tools.some((tool) => AGENT_EXECUTION_SUMMARY_TRIGGER_TOOLS.has(tool.name));
}

export function summarizeFileChanges(tools: readonly ExecutedToolSummary[]): FileChangeSummary[] {
  const fileChanges = new Map<string, FileChangeSummary>();

  for (const tool of tools) {
    if (!isRecord(tool.result)) {
      continue;
    }

    if (tool.name === 'web_access' || tool.name === 'web_download' || tool.name === 'web_download_file' || tool.name === 'browser' || tool.name === 'browser_page' || tool.name === 'browser_take_screenshot') {
      const path = typeof tool.result.path === 'string' ? tool.result.path : undefined;
      if (!path) {
        continue;
      }

      const existing = fileChanges.get(path);
      fileChanges.set(path, {
        path,
        kind: existing?.kind === 'created' ? 'created' : 'created',
        added: existing?.added ?? 0,
        deleted: existing?.deleted ?? 0,
        beforeLines: existing?.beforeLines ?? 0,
        afterLines: existing?.afterLines ?? 0,
      });
      continue;
    }

    const changedResults = (tool.name === 'workspace_apply_diff' || tool.name === 'edit') && isRecord(tool.result) && Array.isArray(tool.result.files)
      ? tool.result.files
      : [tool.result];

    if (
      tool.name !== 'file' &&
      tool.name !== 'file_write' &&
      tool.name !== 'write' &&
      tool.name !== 'edit' &&
      tool.name !== 'patch' &&
      tool.name !== 'workspace_write_file' &&
      tool.name !== 'workspace_apply_patch' &&
      tool.name !== 'workspace_apply_diff'
    ) {
      continue;
    }

    for (const result of changedResults) {
      if (!isRecord(result)) {
        continue;
      }
      const path = typeof result.path === 'string' ? result.path : undefined;
      const change = isRecord(result.change) ? result.change : undefined;
      if (!path || !change) {
        continue;
      }

      const existing = fileChanges.get(path);
      const next: FileChangeSummary = {
        path,
        kind: change.kind === 'created' ? 'created' : 'updated',
        added: typeof change.added === 'number' ? change.added : 0,
        deleted: typeof change.deleted === 'number' ? change.deleted : 0,
        beforeLines: typeof change.beforeLines === 'number' ? change.beforeLines : 0,
        afterLines: typeof change.afterLines === 'number' ? change.afterLines : 0,
      };

      fileChanges.set(
        path,
        existing
          ? {
              path,
              kind: existing.kind === 'created' || next.kind === 'created' ? 'created' : 'updated',
              added: existing.added + next.added,
              deleted: existing.deleted + next.deleted,
              beforeLines: existing.beforeLines,
              afterLines: next.afterLines,
            }
          : next
      );
    }
  }

  return [...fileChanges.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeFileChangeTotals(fileChanges: readonly FileChangeSummary[]): FileChangeTotals {
  return fileChanges.reduce<FileChangeTotals>(
    (totals, fileChange) => ({
      files: totals.files + 1,
      created: totals.created + (fileChange.kind === 'created' ? 1 : 0),
      updated: totals.updated + (fileChange.kind === 'updated' ? 1 : 0),
      added: totals.added + fileChange.added,
      deleted: totals.deleted + fileChange.deleted,
    }),
    {
      files: 0,
      created: 0,
      updated: 0,
      added: 0,
      deleted: 0,
    }
  );
}

function summarizeGitWorkspace(tools: readonly ExecutedToolSummary[]): GitWorkspaceSummary | undefined {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    const isGitStatusTool =
      tool?.name === 'git' || tool?.name === 'workspace_git_status';
    if (!isGitStatusTool || !tool.success || !isRecord(tool.result)) {
      continue;
    }

    if (tool.result.isRepo !== true || !Array.isArray(tool.result.files)) {
      return undefined;
    }

    const files = tool.result.files
      .filter((file): file is Record<string, unknown> => isRecord(file))
      .map((file) => ({
        path: typeof file.path === 'string' ? file.path : 'unknown',
        indexStatus: typeof file.indexStatus === 'string' ? file.indexStatus : '',
        worktreeStatus: typeof file.worktreeStatus === 'string' ? file.worktreeStatus : '',
        ...(typeof file.originalPath === 'string' ? { originalPath: file.originalPath } : {}),
      }))
      .filter((file) => file.path !== 'unknown');

    return {
      ...(typeof tool.result.branch === 'string' ? { branch: tool.result.branch } : {}),
      files,
    };
  }

  return undefined;
}

function summarizeGitActions(tools: readonly ExecutedToolSummary[]): GitActionSummary[] {
  return tools
    .filter((tool) =>
      [
        'git',
        'workspace_git_branch_checkout',
        'workspace_git_stage',
        'workspace_git_commit',
        'workspace_git_restore',
        'workspace_git_reset',
      ].includes(tool.name)
    )
    .map((tool) => {
      const resultMessage =
        isRecord(tool.result) && typeof tool.result.message === 'string' ? tool.result.message : undefined;
      const ok = isRecord(tool.result) && typeof tool.result.ok === 'boolean' ? tool.result.ok : tool.success;
      return {
        toolName: tool.name,
        ok,
        message: resultMessage || tool.error || (ok ? 'completed' : 'failed'),
      } satisfies GitActionSummary;
    });
}

function summarizeProjectDiagnostics(
  tools: readonly ExecutedToolSummary[]
): ProjectDiagnosticsSummary | undefined {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool?.name !== 'workspace_project_diagnostics' || !isRecord(tool.result)) {
      continue;
    }

    const stages = Array.isArray(tool.result.stages)
      ? tool.result.stages
          .filter((stage): stage is Record<string, unknown> => isRecord(stage))
          .map((stage) => ({
            label:
              typeof stage.label === 'string'
                ? stage.label
                : typeof stage.scriptName === 'string'
                ? stage.scriptName
                : 'unknown',
            command:
              typeof stage.command === 'string'
                ? formatCommand(stage.command, toStringArray(stage.args))
                : 'unknown',
            status:
              typeof stage.status === 'number' || stage.status === null
                ? stage.status
                : null,
            timedOut: stage.timedOut === true,
            success: stage.success === true,
            fallback: stage.fallback === true,
          }))
      : [];

    return {
      available: tool.result.available !== false,
      overallStatus:
        tool.result.overallStatus === 'passed' ||
        tool.result.overallStatus === 'failed'
          ? tool.result.overallStatus
          : 'unavailable',
      stages,
      ...(typeof tool.result.message === 'string'
        ? { message: tool.result.message }
        : {}),
    };
  }

  return undefined;
}

export function summarizeCommandExecutions(
  tools: readonly ExecutedToolSummary[]
): CommandExecutionSummary[] {
  return collectCommandExecutionRecords(tools).map(({ stdout: _stdout, stderr: _stderr, index: _index, ...record }) => record);
}

function getLatestDiagnosticsTool(
  tools: readonly ExecutedToolSummary[]
): ExecutedToolSummary | undefined {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool?.name === 'workspace_project_diagnostics' && isRecord(tool.result)) {
      return tool;
    }
  }

  return undefined;
}

export function buildExecutionContextSummary(params: {
  lang?: Lang;
  executedTools: readonly ExecutedToolSummary[];
}): string {
  const lang = params.lang ?? 'zh-CN';
  const copy = getExecutionContextCopy(lang);
  const lines: string[] = [copy.heading];
  const fileChanges = summarizeFileChanges(params.executedTools);
  const commandTools = params.executedTools.filter(
    (tool) =>
      (BLOCKING_COMMAND_TOOL_NAMES.has(tool.name) ||
        (BACKGROUND_COMMAND_TOOL_NAMES.has(tool.name) && tool.success)) &&
      isRecord(tool.result)
  );
  const failedTools = collectUnresolvedToolFailures(params.executedTools);
  const diagnosticsTool = getLatestDiagnosticsTool(params.executedTools);
  const diagnosticsSummary = summarizeProjectDiagnostics(params.executedTools);

  if (fileChanges.length > 0) {
    lines.push('', copy.files);
    for (const fileChange of fileChanges) {
      lines.push(
        `- ${fileChange.path} (${fileChange.kind}, +${fileChange.added}/-${fileChange.deleted}, ${fileChange.beforeLines} -> ${fileChange.afterLines})`
      );
    }
  }

  if (commandTools.length > 0) {
    lines.push('', copy.commands);
    for (const tool of commandTools) {
      const result = tool.result as Record<string, unknown>;
      const command =
        typeof result.command === 'string'
          ? result.command
          : typeof tool.arguments.command === 'string'
          ? tool.arguments.command
          : 'unknown';
      const args = toStringArray(result.args ?? tool.arguments.args);
      const commandLine = formatCommand(command, args);
      const status =
        typeof result.status === 'number' || result.status === null
          ? result.status
          : null;
      const timedOut = result.timedOut === true;
      const background = BACKGROUND_COMMAND_TOOL_NAMES.has(tool.name);
      const started = background ? result.started !== false : false;
      const pid = typeof result.pid === 'number' ? result.pid : null;
      const stdout =
        typeof result.stdout === 'string' ? truncateEvidenceBlock(result.stdout) : '';
      const stderr =
        typeof result.stderr === 'string' ? truncateEvidenceBlock(result.stderr) : '';
      const baseLine = background
        ? getCompletionCopy(lang).backgroundCommandStatus(commandLine, pid, started)
        : getCompletionCopy(lang).commandStatus(commandLine, status, timedOut);
      const evidenceParts = [baseLine];
      if (stdout) {
        evidenceParts.push(`${copy.commandOutputStdout}: ${stdout}`);
      }
      if (stderr) {
        evidenceParts.push(`${copy.commandOutputStderr}: ${stderr}`);
      }
      lines.push(`- ${evidenceParts.join(' | ')}`);
    }
  }

  if (diagnosticsTool && diagnosticsSummary) {
    lines.push('', copy.diagnostics);
    if (!diagnosticsSummary.available) {
      lines.push(`- ${copy.diagnosticsUnavailable(diagnosticsSummary.message ?? 'unknown')}`);
    } else {
      lines.push(`- ${copy.diagnosticsOverall(diagnosticsSummary.overallStatus)}`);
      const result = diagnosticsTool.result as Record<string, unknown>;
      if (Array.isArray(result.stages)) {
        for (const stage of result.stages) {
          if (!isRecord(stage)) {
            continue;
          }
          const label =
            typeof stage.label === 'string'
              ? stage.label
              : typeof stage.scriptName === 'string'
              ? stage.scriptName
              : 'unknown';
          const command =
            typeof stage.command === 'string'
              ? formatCommand(stage.command, toStringArray(stage.args))
              : 'unknown';
          const excerpt =
            typeof stage.excerpt === 'string'
              ? truncateEvidenceBlock(stage.excerpt)
              : typeof stage.stderr === 'string'
              ? truncateEvidenceBlock(stage.stderr)
              : '';
          const statusText = getCompletionCopy(lang).diagnosticsStage({
            label,
            command,
            status:
              typeof stage.status === 'number' || stage.status === null
                ? stage.status
                : null,
            timedOut: stage.timedOut === true,
            success: stage.success === true,
            fallback: stage.fallback === true,
          });
          lines.push(`- ${statusText}${excerpt ? ` | ${excerpt}` : ''}`);
        }
      }
    }
  }

  if (failedTools.length > 0) {
    const failureLines: string[] = [];
    for (const tool of failedTools) {
      const resultRecord = isRecord(tool.result) ? tool.result : undefined;
      const error =
        tool.error ??
        (typeof resultRecord?.error === 'string' ? resultRecord.error : '') ??
        '';
      const fallbackText =
        typeof resultRecord?.stderr === 'string'
          ? truncateEvidenceBlock(resultRecord.stderr)
          : typeof resultRecord?.message === 'string'
          ? truncateEvidenceBlock(resultRecord.message)
          : '';
      const errorText = error || fallbackText;
      if (!errorText) continue;
      failureLines.push(`- ${copy.toolFailure(tool.name, truncateEvidenceBlock(errorText))}`);
    }
    if (failureLines.length > 0) {
      lines.push('', copy.failures, ...failureLines);
    }
  }

  return lines.length > 1 ? lines.join('\n').trim() : '';
}

export function buildAgentCompletionSummary(params: {
  lang?: Lang;
  finalResponseContent: string;
  executedTools: readonly ExecutedToolSummary[];
}): string {
  const lang = params.lang ?? 'zh-CN';
  const copy = getCompletionCopy(lang);
  const lines: string[] = [copy.heading, '', copy.doneHeading];
  const fileChanges = summarizeFileChanges(params.executedTools);
  const fileChangeTotals = summarizeFileChangeTotals(fileChanges);
  const gitWorkspace = summarizeGitWorkspace(params.executedTools);
  const gitActions = summarizeGitActions(params.executedTools);
  const diagnosticsSummary = summarizeProjectDiagnostics(params.executedTools);
  const commandExecutions = summarizeCommandExecutions(params.executedTools);
  const coveredSetupFailures = collectCoveredSetupCommandFailures(params.executedTools);
  const inspectionCount = params.executedTools.filter((tool) =>
    [
      'file_read',
      'read',
      'grep',
      'glob',
      'list',
      'file',
      'workspace_list_files',
      'workspace_read_file',
      'workspace_search_text',
      'workspace_search_files',
      'project_graph',
      'graph',
      'workspace_project_graph',
      'git_read',
      'git',
      'workspace_git_status',
      'workspace_git_diff',
      'workspace_git_history',
      'browser',
      'browser_page',
      'browser_read_dom',
      'web_access',
      'web_search',
      'web_fetch',
      'web_fetch_url',
    ].includes(tool.name)
  ).length;
  const finalReply = truncateSummaryLine(params.finalResponseContent);

  if (inspectionCount > 0) {
    lines.push(`- ${copy.inspected(inspectionCount)}`);
  }
  if (fileChanges.length > 0) {
    lines.push(`- ${copy.changedFiles(fileChangeTotals)}`);
    lines.push(`- ${copy.undoState(Boolean(gitWorkspace?.files.length))}`);
  }
  if (gitActions.length > 0) {
    lines.push(`- ${copy.gitActions(gitActions.length)}`);
  }
  if (commandExecutions.length > 0) {
    lines.push(`- ${copy.executedCommands(commandExecutions.length)}`);
  }
  if (coveredSetupFailures.length > 0) {
    lines.push(`- ${copy.coveredSetupFailures(coveredSetupFailures.length)}`);
  }
  if (diagnosticsSummary) {
    lines.push(
      `- ${
        diagnosticsSummary.available
          ? copy.diagnosticsStatus(diagnosticsSummary)
          : copy.diagnosticsUnavailable(
              diagnosticsSummary.message ?? 'unknown'
            )
      }`
    );
  }
  if (gitWorkspace) {
    lines.push(`- ${copy.gitWorkspace(gitWorkspace.branch, gitWorkspace.files.length)}`);
  }
  if (finalReply) {
    lines.push(`- ${copy.finalReply(finalReply)}`);
  }
  if (lines[lines.length - 1] === copy.doneHeading) {
    lines.push(`- ${copy.noStructuredWork}`);
  }

  if (fileChanges.length > 0) {
    lines.push('', copy.filesHeading);
    for (const fileChange of fileChanges) {
      const prefix = fileChange.kind === 'created' ? '[new] ' : '';
      const linkedPath = buildWorkspaceFileLink(fileChange.path);
      lines.push(
        `- ${prefix}${linkedPath} (+${fileChange.added}/-${fileChange.deleted}${
          fileChange.beforeLines > 0 || fileChange.afterLines > 0
            ? copy.fileLineRange(fileChange.beforeLines, fileChange.afterLines)
            : ''
        })`
      );
    }
  }

  if (gitActions.length > 0 || (gitWorkspace && gitWorkspace.files.length > 0)) {
    lines.push('', copy.gitHeading);
    for (const action of gitActions) {
      lines.push(`- ${copy.gitAction(action)}`);
    }
    if (gitWorkspace) {
      for (const file of gitWorkspace.files) {
        lines.push(`- ${copy.gitFile(file)}`);
      }
    }
  }

  if (commandExecutions.length > 0) {
    lines.push('', copy.commandsHeading);
    for (const commandExecution of commandExecutions) {
      lines.push(
        `- ${
          commandExecution.background
            ? copy.backgroundCommandStatus(
                formatCommand(commandExecution.command, commandExecution.args),
                commandExecution.pid,
                commandExecution.started
              )
            : copy.commandStatus(
                formatCommand(commandExecution.command, commandExecution.args),
                commandExecution.status,
                commandExecution.timedOut
              )
        }`
      );
    }
  }

  if (diagnosticsSummary) {
    lines.push('', copy.diagnosticsHeading);
    if (!diagnosticsSummary.available) {
      lines.push(
        `- ${copy.diagnosticsUnavailable(diagnosticsSummary.message ?? 'unknown')}`
      );
    } else {
      for (const stage of diagnosticsSummary.stages) {
        lines.push(`- ${copy.diagnosticsStage(stage)}`);
      }
    }
  }

  const nextSteps: string[] = [];
  for (const commandExecution of collectUnresolvedCommandFailures(params.executedTools)) {
    nextSteps.push(copy.failedCommandNextStep(formatCommand(commandExecution.command, commandExecution.args)));
  }
  for (const tool of collectUnresolvedToolFailures(params.executedTools)) {
    if (!BLOCKING_COMMAND_TOOL_NAMES.has(tool.name)) {
      nextSteps.push(copy.failedToolNextStep(tool.name));
    }
  }
  if (diagnosticsSummary?.available) {
    for (const stage of diagnosticsSummary.stages) {
      if (!stage.success) {
        nextSteps.push(copy.failedCommandNextStep(stage.command));
      }
    }
  }

  if (nextSteps.length > 0) {
    lines.push('', copy.nextHeading);
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join('\n').trim();
}

export function buildAgentCompletionSummaryPrompt(params: {
  lang?: Lang;
  structuredSummary: string;
}): {
  systemPrompt: string;
  userPrompt: string;
} {
  const instructions = getAgentCompletionSummaryRewriteInstructions(params.lang);
  return {
    systemPrompt: instructions.systemPrompt,
    userPrompt: `${instructions.userPromptPrefix}\n\n${params.structuredSummary}`.trim(),
  };
}
