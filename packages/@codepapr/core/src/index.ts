/**
 * CodePapr Core: Agent framework with three-partition cache
 */

// Cache exports
export { Serializer } from './cache/Serializer';
export {
  ImmutablePrefix,
  ImmutablePrefixFactory,
  validateStaticContent,
} from './cache/ImmutablePrefix';
export type { StaticContentValidationOptions } from './cache/ImmutablePrefix';
export { AppendOnlyLog } from './cache/AppendOnlyLog';
export { VolatileScratch } from './cache/VolatileScratch';
export { CachePartition } from './cache/CachePartition';

// Agent / Session / Tool / Message
export {
  Agent,
  CONTINUATION_NUDGE,
  DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  EMPTY_COMPLETION_DISABLE_THINKING_AFTER,
  EMPTY_COMPLETION_RETRY_DELAYS_MS,
  MAX_CONTINUATIONS_PER_ROUND,
  MAX_EMPTY_COMPLETION_RETRIES_PER_ROUND,
  PERMISSION_WAITING_TOOL_TIMEOUTS,
  buildContextSnapshot,
  buildRequestContextDebugText,
  buildThinking,
} from './agent/Agent';
export type { AgentOptions, IRequestBuilder, ICacheValidator, ContextCompactionConfig, ContextSnapshotSource } from './agent/Agent';
export { Session } from './agent/Session';
export type { SessionOptions } from './agent/Session';
export { ToolRegistry, FilteringToolRegistry } from './tool/ToolRegistry';
export type { ToolHandler } from './tool/ToolRegistry';
export { EditHistory } from './tool/editHistory';
export type { EditRecord, RevertAction } from './tool/editHistory';
export { applySearchReplaceDiff, applySearchReplacePatch, locateSearchOccurrences } from './tool/searchReplaceDiff';
export type { SearchOccurrenceLocation } from './tool/searchReplaceDiff';
export {
  truncateToolOutput,
  stringifyToolResult,
  getByteSize,
  getCharLength,
  formatMiddleTruncated,
  formatOffloadedContent,
  generateToolOutputFilename,
  DEFAULT_INTERCEPT_CHARS,
  DEFAULT_MIDDLE_KEEP_CHARS,
  DEFAULT_OFFLOAD_CHARS,
  DEFAULT_OFFLOAD_PREVIEW_CHARS,
  DEFAULT_CEILING_CHARS,
} from './tool/toolOutputTruncation';
export type {
  ToolOutputTruncationOptions,
  TruncationResult,
} from './tool/toolOutputTruncation';
export {
  summarizeToolOutput,
  resolveToolContextMode,
  resolveToolContextOverrides,
  prepareHistorySummary,
  applyHistoryToolSummaries,
  headTailPreview,
  TOOL_SUMMARY_METADATA_KEY,
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_AUTO_THRESHOLD_CHARS,
  DEFAULT_TOOL_CONTEXT_OVERRIDES,
} from './tool/toolOutputSummary';
export type {
  ToolContextMode,
  ToolContextConfig,
  HistorySummaryInput,
} from './tool/toolOutputSummary';
export type {
  ApplySearchReplaceDiffFile,
  ApplySearchReplaceDiffPatch,
  ApplySearchReplaceDiffResult,
  ApplySearchReplacePatchPlan,
} from './tool/searchReplaceDiff';
export { buildWorkspaceProjectGraph, enrichProjectGraphEdges, extractStructuralSymbols, stripGraphNoise } from './tool/projectGraph';
export type {
  BuildWorkspaceProjectGraphParams,
  ProjectGraphEdge,
  ProjectGraphEdgeKind,
  ProjectGraphFileContent,
  ProjectGraphFileEntry,
  ProjectGraphFileInput,
  ProjectGraphFileType,
  ProjectGraphNode,
  ProjectGraphNodeKind,
  ProjectGraphSymbolInput,
  ProjectGraphSymbolSource,
  ProjectGraphQualityMetrics,
  LspProjectGraphEnhancer,
  LspMode,
  StructuralSymbol,
  WorkspaceProjectGraphResult,
} from './tool/projectGraph';
export { createProjectDiagnosticsPlan, runProjectDiagnostics } from './tool/workspace/diagnostics';
export type {
  ProjectDiagnosticsCommandResult,
  ProjectDiagnosticStagePlan,
  ProjectDiagnosticStageResult,
  ProjectDiagnosticsListEntry,
  ProjectDiagnosticsProjectType,
  ProjectDiagnosticsReport,
} from './tool/workspace/diagnostics';
export type {
  WorkspaceHost,
  WorkspaceHostCommandResult,
  WorkspaceHostListEntry,
  WorkspaceHostListFilesOptions,
  WorkspaceHostListFilesResult,
  WorkspaceHostReadTextFileOptions,
  WorkspaceHostReadTextFileResult,
  WorkspaceHostRunCommandOptions,
  WorkspaceHostWriteTextFileOptions,
  WorkspaceHostWriteTextFileResult,
  WorkspaceLanguageServiceHost,
  WorkspaceLanguageServiceRequestOptions,
} from './tool/workspace/host';
export {
  buildWorkspaceDependencySubgraph,
  findWorkspaceEntrypoints,
  findWorkspaceSymbolImplementations,
  lookupWorkspaceSymbols,
  analyzeWorkspaceChangeImpact,
  getWorkspaceSmartContext,
  planProjectGraphRename,
  computeRenameEditsForContent,
  applyRenameEditsToContent,
  detectCircularDependencies,
  detectDeadCode,
  buildTypeHierarchy,
  discoverAndMapTests,
  suggestRefactorings,
  selectTestsByChangeImpact,
  checkArchitectureLayers,
  computeSemanticDiff,
  generateTestSkeletons,
  planExtractMethod,
  planMoveSymbol,
  planInlineVariable,
  suggestInlineVariables,
  generateSmartTestSkeletons,
  computeIncrementalUpdate,
  applyIncrementalUpdate,
  fileIdFromGraphNodeId,
  findSymbolAtPosition,
  findSymbolByNameInFile,
  identifierAtPosition,
  replanProjectGraphRenameForSymbol,
} from './tool/workspace/graphQuery';
export type {
  WorkspaceChangeImpactOptions,
  WorkspaceChangeImpactResult,
  WorkspaceDependencySubgraphOptions,
  WorkspaceDependencySubgraphResult,
  WorkspaceEntrypointCandidate,
  WorkspaceEntrypointsResult,
  WorkspaceGraphSymbolMatch,
  WorkspaceSymbolImplementationsOptions,
  WorkspaceSymbolImplementationsResult,
  WorkspaceSymbolLookupOptions,
  WorkspaceSymbolLookupResult,
  WorkspaceSmartContextOptions,
  WorkspaceSmartContextResult,
  ProjectGraphRenameParams,
  ProjectGraphRenameResult,
  ProjectGraphRenamePlan,
  ProjectGraphRenameEdit,
  CircularDependency,
  CircularDependencyResult,
  DeadCodeSymbol,
  DeadCodeResult,
  DeadCodeConfidence,
  TypeNode,
  TypeHierarchyResult,
  TestDiscoveryResult,
  MethodExtractionSuggestion,
  SymbolMovePlan,
  RefactorSuggestionResult,
  ImpactBasedTestSelectionResult,
  ArchitectureLayer,
  LayerViolation,
  ArchitectureCheckResult,
  SemanticChangeKind,
  SemanticSymbolChange,
  SemanticEdgeChange,
  SemanticDiffResult,
  GeneratedTest,
  TestGenerationResult,
  ExtractMethodPlan,
  MoveSymbolEdits,
  InlineVariablePlan,
  InlineVariableSuggestion,
  SmartTestSkeleton,
  SmartTestGenerationResult,
  IncrementalGraphUpdate,
} from './tool/workspace/graphQuery';
export {
  performWorkspaceApplyCodeAction,
  performWorkspaceFixDiagnostics,
  performWorkspaceFormatFiles,
  performWorkspaceOrganizeImports,
  performWorkspaceRename,
  performProjectGraphRename,
  requestWorkspaceSymbolDefinition,
  requestWorkspaceSymbolReferences,
  requestWorkspaceHover,
  requestWorkspaceDocumentSymbol,
  requestWorkspaceSymbol,
  requestWorkspaceImplementation,
  requestWorkspacePrepareCallHierarchy,
  requestWorkspaceIncomingCalls,
  requestWorkspaceOutgoingCalls,
} from './tool/workspace/languageTools';
export type {
  WorkspaceCodeOperationResult,
  WorkspaceLanguagePositionArgs,
  WorkspaceNavigationResult,
  WorkspaceSymbolLocation,
  WorkspaceHoverResult,
  WorkspaceDocumentSymbol,
  WorkspaceDocumentSymbolResult,
  WorkspaceSymbolInformation,
  WorkspaceSymbolSearchResult,
  WorkspaceCallHierarchyItem,
  WorkspaceCallHierarchyPrepareResult,
  WorkspaceCallHierarchyCall,
  WorkspaceCallHierarchyCallsResult,
} from './tool/workspace/languageTools';
export {
  filePathFromFileUri,
  findFileUriForRelativePath,
  relativePathFromFileUri,
  workspaceFileUri,
} from './tool/workspace/fileUri';
export { WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS } from './tool/workspace/toolDefinitions';
export { NEW_TOOL_DEFINITIONS, MERGE_TOOL_DEFINITIONS, OLD_MERGE_TOOL_NAMES } from './tool/workspace/mergeToolDefs';
export { registerSharedToolDispatchers, registerSharedMergeToolDispatchers } from './tool/workspace/registerSharedWorkspaceTools';
export type { SharedToolDispatcherOptions } from './tool/workspace/registerSharedWorkspaceTools';
export {
  asString,
  asOptionalString,
  asOptionalNumber,
  asPositiveInteger,
  asOptionalPositiveInteger,
  asOptionalBoolean,
  asOptionalStringArray,
  asPatchArray,
  asSafeSkillName,
  boundedNumber,
} from './tool/workspace/toolArgHelpers';
export { MessageFactory, stripInternalFields, redactImagePayloadsForTranscript, redactTranscriptOutputString } from './message/Message';

// 项目规则 / 声明式子代理 / 自定义聊天命令（纯逻辑，IO 由各入口注入）
export {
  PROJECT_AGENTS_FILE,
  PROJECT_RULE_FILES,
  getDefaultAgentsTemplate,
  buildProjectRulesSection,
  resolveProjectRulesSection,
  stripEmptyRulePlaceholders,
} from './agent/projectRules';
export type { ProjectRuleFile } from './agent/projectRules';
export {
  detectProjectVerifyCommands,
  fillAgentsVerifyCommands,
} from './agent/projectVerifyCommands';
export type {
  ProjectVerifyCommands,
  DetectProjectVerifyCommandsInput,
} from './agent/projectVerifyCommands';
export { parseAgentMarkdown, filterToolsForAgent, filterToolsForMode, filterToolsForProfile, MINIMAL_AGENT_TOOLS, isMinimalAgentToolName, applyMinimalToolProfile, isPromptToolVisible, isReadOnlyMode, MUTATING_TOOL_NAMES, PARALLEL_SAFE_TOOL_NAMES, APP_ONLY_TOOL_NAMES, PLAN_ONLY_TOOL_NAMES, GIT_READ_ONLY_ACTIONS, allowToolForReadOnlyMode, readOnlyModeBlockMessage, buildTaskToolDefinition, listDelegableAgents, isExecutionHeavyTask, sanitizeAgentPrompt, resolveAgentPrompt, resolveAgentDescription, mergeAgentDefinitions, BUILTIN_AGENTS, VERIFIER_PROMPT_OBJECTIVE, VERIFIER_PROMPT_SUBJECTIVE, SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS, SUBAGENT_MAX_DEPTH, MAX_CUSTOM_PROMPT_LENGTH, EXECUTION_HEAVY_PATTERNS } from './agent/agentConfig';
export type { AgentDefinition, AgentMode, AgentToolProfile, MinimalAgentToolName } from './agent/agentConfig';
export {
  CONTEXT_COMPACTION_VERSION_V4,
  COMPACT_TRIGGER_RATIO,
  TAIL_ROUNDS_VERBATIM,
  TAIL_ROUNDS_FLOOR,
  TAIL_TURNS_VERBATIM,
  SKELETON_Q_MAX_CHARS,
  SKELETON_A_HEAD_CHARS,
  SKELETON_A_TAIL_CHARS,
  SUMMARY_INPUT_RATIO,
  SKELETON_SUMMARY_SYSTEM_PROMPTS,
  roundsFromCoreMessages,
  skeletonEntryFromRound,
  renderSkeletonEntries,
  renderRoundQuestionLine,
  renderCompactedBlock,
  foldRoundActivity,
  preSizeSummaryInput,
  deterministicSummary,
  planSkeletonCompaction,
} from './agent/compactionEngine';
export type {
  CompactionEngineLang,
  EngineRound,
  EngineTurn,
  SkeletonEntry,
  SkeletonPlan,
  SkeletonPlanParams,
  InRoundFold,
} from './agent/compactionEngine';
export { createHeadlessCompaction } from './agent/headlessCompaction';
export type { HeadlessCompactionParams } from './agent/headlessCompaction';
export {
  TODO_TOOL_NAME,
  TODO_CREATE_REJECTED_NOTICE,
  buildTodoToolDefinition,
  createEmptyTodoListContext,
  writeTodoList,
  updateTodoList,
  inferCurrentTaskId,
  applyTodoToolRequest,
  renderTodoListDigest,
  parseTodoUpdatePatches,
  parseTodoGoal,
  hasUnsettledTodoTasks,
  convergeUnconfirmedRunningTasks,
} from './agent/todoList';
export type { TodoUpdatePatch, TodoToolRequestResult } from './agent/todoList';
export { createTaskSlot, withTaskSlot, TASK_PARALLEL_CONCURRENCY } from './agent/taskSlot';
export { selectSubagentExecutionRoute } from './agent/subagentRoute';
export type { SubagentExecutionRoute, SubagentRouteSettings } from './agent/subagentRoute';
export {
  resolveSubagentExecution,
  runSubagentSession,
  SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
} from './agent/subagentConfig';
export type {
  SubagentTierSettings,
  SubagentMentorSettings,
  SubagentExecutionInput,
  ResolvedSubagentExecution,
  ResolvedSubagentParameters,
  ResolvedSubagentMentor,
  SubagentStep,
  SubagentSessionDeps,
  SubagentSessionResult,
} from './agent/subagentConfig';
export {
  SKILLS_DIR,
  DEFAULT_SEARCH_SKILL_NAME,
  DEFAULT_SEARCH_SKILL_TEMPLATE,
  getDefaultSearchSkillTemplate,
  parseSkillMarkdown,
  applySkillEnablement,
  isSkillAvailableToLoad,
  buildSkillsSection,
  buildSkillCatalogSignature,
  skillRootFromPath,
  resolveSkillCatalogName,
} from './agent/skillConfig';
export type { SkillDefinition, SkillEnablementMap } from './agent/skillConfig';
export {
  DEFAULT_CODING_SYSTEM_PROMPT,
  DEFAULT_PROMPT_TOOL_NAMES,
  USER_PROMPT_SECTION_ORDER,
  buildModeSystemPrompt,
  buildSessionBootstrapPrompt,
  buildMinimalToolSurfaceSection,
  collectPromptToolRefs,
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  buildStructuredUserPrompt,
  createDefaultUserPromptSections,
  parseStructuredUserPrompt,
  validateUserPrompt,
} from './agent/promptSystem';
export type {
  BuildModeSystemPromptOptions,
  BuildSessionBootstrapPromptOptions,
  BuildRuntimeSystemPromptOptions,
  BuildRuntimeUserPromptOptions,
  PromptLang,
  PromptMode,
  PromptValidationResult,
  UserPromptSectionKey,
  UserPromptSections,
  DelegableAgentHint,
} from './agent/promptSystem';
export {
  BUILTIN_PROMPT_COMMANDS,
  parseCommandMarkdown,
  parseInlineCommandLine,
  parseSlashInput,
  tokenizeQuotedLine,
  mergeSlashCommandList,
  resolveSlashCommandLine,
  splitSlashAttachmentBlock,
  expandCommandTemplate,
  getBuiltinPromptCommand,
  listBuiltinPromptCommandNames,
  isLocalSlashCommand,
  isKnownSlashCommandName,
  isFilesystemPathSlashName,
  resolveCommandDescription,
  resolveCommandUsage,
  wrapAskModeCommandTemplate,
  wrapCommandForSubagent,
  wrapCommandForSubagents,
  parseLeadingAgentMentions,
} from './agent/slashCommand';
export {
  DEFAULT_CHECK_COMMAND_NAME,
  getDefaultCheckCommandTemplate,
  getDefaultCheckCommandPrompt,
  shouldSuggestCheckCommand,
} from './agent/defaultCheckCommand';
export type {
  CommandDefinition,
  LocalizedCommandText,
  ParsedSlashInput,
  ParsedInlineCommandLine,
  CommandExpandContext,
  SlashCommandSource,
  SlashCommandListItem,
} from './agent/slashCommand';

// Goal 自主循环（Worker + Evaluator 双模型）
export {
  parseGoalCondition,
  evaluateGoalCondition,
  GoalConditionParseError,
} from './agent/goalCondition';
export type {
  ConditionExecutor,
} from './agent/goalCondition';
export {
  GoalRunner,
  DEFAULT_GOAL_MAX_ITERATIONS,
  DEFAULT_GOAL_MAX_WALL_CLOCK_MS,
  DEFAULT_GOAL_COMPACTION_INTERVAL,
  serializeGoalState,
} from './agent/GoalRunner';
export type {
  WorkerTurnResult,
  GoalRunnerCallbacks,
  GoalRunnerOptions,
} from './agent/GoalRunner';

// Re-export types from types package
export * from '@codepapr/types';

// Unified symbol provider types (LSP → AST → Regex fallback)
export type {
  SymbolSource,
  SymbolConfidence,
  ProviderCapability,
  UnifiedSymbolDefinition,
  SymbolLocation,
  HoverResult,
  ResolvedProviderInfo,
  SymbolProvider,
  DispatchResult,
} from './tool/unifiedSymbols';
export {
  sourceToConfidence,
  SymbolProviderRegistry,
  UnifiedSymbolDispatcher,
} from './tool/unifiedSymbols';

export type {
  ContextTrust,
  ContextDisposition,
  ContextFactKind,
  ContextArtifactRef,
  ContextFact,
} from "./context/ContextFacts";
export { CONTEXT_FACT_MAX_SUMMARY_CHARS, truncateFactSummary } from "./context/ContextFacts";
export type {
  ContextBudgetAction,
  ContextEstimateSource,
  ContextBudgetStageTokens,
  ContextBudgetBreakdown,
  ContextBudgetDecisionInput,
  ContextBudgetDecision,
} from "./context/ContextBudget";
export {
  buildContextBudgetBreakdown,
  decideContextBudgetAction,
  ContextBudgetRejectedError,
} from "./context/ContextBudget";
export {
  IMAGE_WIRE_TOKEN_WEIGHT,
  describeLogWireMeta,
  measureLogWireFootprint,
  stripConsumedImages,
  clearConsumedImageData,
  findLastUnconsumedImageIndex,
} from "./context/wireShape";
export type { LogWireMeta, LogWireFootprint } from "./context/wireShape";

export type {
  ContentSourceKind,
  ContentTrust,
  ContentRiskFlag,
  ContentEnvelope,
  EnvelopeInput,
  MemoryAdmissionResult,
  MemoryKind,
  MemoryWriteDecision,
} from "./context/ContentEnvelope";
export {
  envelopeContent,
  redactSecrets,
  planMemoryAdmission,
  planMemoryWrite,
  normalizeMemoryKind,
  memoryProjectsToBootstrap,
  memoryEntryProjectsToBootstrap,
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_CONTENT_MIN_CHARS,
  MEMORY_REPORTED_MAX_CHARS,
  MEMORY_KINDS,
  BOOTSTRAP_EXCLUDED_MEMORY_KINDS,
} from "./context/ContentEnvelope";
