import type { AgentDefinition, SkillDefinition } from '@codepapr/core';
import type { McpSettings } from '../utils/mcpTypes';
import type {
  IAgentResponse,
  IChatRequest,
  IChatResponse,
  IChatStreamEvent,
  IImageContent,
  IMessage,
  IToolDefinition,
} from '@codepapr/types';
import type { Lang } from '../utils/i18n';

export type WorkerApiMode = 'deepseek' | 'custom' | 'local';
export type WorkerApiFormat = 'openai' | 'claude';
export type WorkerProviderName = 'deepseek' | 'openai' | 'claude';

export interface WorkerAgentSettings {
  apiMode: WorkerApiMode;
  apiFormat: WorkerApiFormat;
  provider: WorkerProviderName;
  baseURL: string;
  apiKey: string;
  model: string;
  fastModelEnabled: boolean;
  fastModel: string;
  temperature: number;
  maxTokens: number;
  maxToolRounds: number;
  thinkingEnabled: boolean;
  thinkingEffort: 'high' | 'max';
  lang?: Lang;
  mentorEnabled: boolean;
  mentorModel: string;
  mentorBaseURL: string;
  mentorApiKey: string;
  mentorApiFormat: WorkerApiFormat;
  mentorMaxTokens: number;
  mentorThinkingEnabled: boolean;
  exploreTopP: number;
  exploreMaxTokens: number;
  exploreThinkingEnabled: boolean;
  exploreTemperature: number;
  exploreMaxToolRounds: number;
  exploreMaxDepth: number;
  exploreModelTier: 'primary' | 'fast';
  scoutTopP: number;
  scoutMaxTokens: number;
  scoutThinkingEnabled: boolean;
  scoutTemperature: number;
  scoutMaxToolRounds: number;
  scoutMaxDepth: number;
  scoutModelTier: 'primary' | 'fast';
  appSubAgentModelTier: 'primary' | 'fast';
  appSubAgentThinkingEnabled: boolean;
  appSubAgentMaxToolRounds: number;
  mcp: McpSettings;
  graphToolTimeoutMs: number;
  toolIpcTimeoutMs: number;
  multimodalEnabled: boolean;
  multimodalModelTier: 'primary' | 'fast' | 'all';
  toolOutputInterceptChars: number;
  toolOutputOffloadChars: number;
  toolOutputCeilingChars: number;
  toolOutputPreviewChars: number;
  pruneOldToolResults: boolean;
  pruneProtectRounds: number;
  pruneMinChars: number;
  maxContextTokens: number;
  maxConversationRounds: number;
  compactionModel: 'fast' | 'primary';
  compactionMaxTokens: number;
  compactionTemperature: number;
}

export interface WorkerAgentParameters {
  temperature: number;
  topP: number;
  maxTokens: number;
  thinkingEnabled: boolean;
  reasoningEffort: 'high' | 'max';
}

export interface WorkerAgentRuntimeConfig {
  rulesSection?: string;
  customPrompt?: string;
  memorySection?: string;
  lang?: Lang;
  /** 当前工作模式：ask/plan 会在注册层屏蔽变更类工具。缺省 agent。 */
  mode?: 'ask' | 'plan' | 'agent' | 'app';
  skillDefinitions?: SkillDefinition[];
  agentDefinitions?: AgentDefinition[];
  mcpToolDefinitions?: IToolDefinition[];
  mcpToolMappings?: Array<{ serverId: string; toolName: string; displayName: string }>;
}

export interface AgentWorkerChatPayload {
  requestId: string;
  sessionId: string;
  workspacePath: string;
  messages: IMessage[];
  /** When set, the worker reuses its cached log for `sessionId` (verified to be
   *  at `expectedBaseLength`) and appends `newMessages` instead of rebuilding
   *  from `messages` — avoiding a full-log structured clone each turn. `messages`
   *  is then empty. Absent => full sync from `messages`. */
  incrementalSync?: {
    expectedBaseLength: number;
    newMessages: IMessage[];
  };
  userInput: string;
  images?: IImageContent[];
  settings: WorkerAgentSettings;
  providerName: WorkerProviderName;
  model: string;
  systemPrompt: string;
  parameters: WorkerAgentParameters;
  toolDefinitions: IToolDefinition[];
  runtime: WorkerAgentRuntimeConfig;
}

export interface AgentWorkerToolResponse {
  requestId: string;
  toolRequestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export type MainToAgentWorkerMessage =
  | {
      type: 'chat';
      payload: AgentWorkerChatPayload;
    }
  | {
      type: 'tool-response';
      payload: AgentWorkerToolResponse;
    }
  | {
      type: 'proxy-chat-response';
      proxyChatId: string;
      success: boolean;
      result?: IChatResponse;
      error?: string;
    }
  | {
      type: 'fetch-response-start';
      fetchId: string;
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
    }
  | {
      type: 'fetch-response-chunk';
      fetchId: string;
      chunk: Uint8Array;
    }
  | {
      type: 'fetch-response-end';
      fetchId: string;
    }
  | {
      type: 'fetch-response-error';
      fetchId: string;
      error: string;
    }
  | {
      type: 'cancel-session';
      requestId: string;
    }
  | {
      type: 'run-app-agent';
      requestId: string;
      payload: AppAgentPayload;
    }
  | {
      type: 'cancel-app-agent';
      requestId: string;
    };

export interface AgentWorkerProxyChatConfig {
  apiKey: string;
  baseURL?: string;
  format: WorkerApiFormat;
}

export interface AppAgentPayload {
  appId: string;
  agentName: string;
  systemPrompt?: string;
  model?: string;
  task: string;
  tools?: string[];
  maxToolRounds?: number;
  workspacePath?: string;
  level?: number;
  inheritContext?: {
    skills?: boolean;
    projectRules?: boolean;
    projectMemory?: boolean;
    customPrompt?: boolean;
  };
}

export interface AppAgentResult {
  content: string;
  reasoningContent?: string;
  steps?: Array<{ name: string; status: string; summary?: string }>;
}

export type AgentWorkerToMainMessage =
  | {
      type: 'stream';
      requestId: string;
      event: IChatStreamEvent;
    }
    | {
        type: 'tool-request';
        requestId: string;
        toolRequestId: string;
        toolName: string;
        arguments: Record<string, unknown>;
        /** Assistant tool-call id this execution fulfills; preferred for matching
         *  the pending call over name+arguments (robust for identical calls). */
        toolCallId?: string;
      }
  | {
      type: 'proxy-chat';
      requestId: string;
      proxyChatId: string;
      config: AgentWorkerProxyChatConfig;
      chatRequest: IChatRequest;
    }
  | {
      type: 'fetch-request';
      fetchId: string;
      url: string;
      method: string;
      headers: Array<[string, string]>;
      body: Uint8Array | null;
    }
  | {
      type: 'fetch-cancel';
      fetchId: string;
    }
    | {
        type: 'result';
        requestId: string;
        response: IAgentResponse;
        deltaMessages: IMessage[];
        /** Total length of the worker's authoritative log after this turn; the
         *  main thread records it to decide incremental vs full sync next turn. */
        logLength: number;
        /** True when mid-loop compaction replaced the worker log this turn. The
         *  main thread must then replace its authoritative log with `fullMessages`
         *  (the compacted epoch) instead of appending `deltaMessages`, whose
         *  indices no longer line up after the worker reset its log. */
        compacted?: boolean;
        fullMessages?: IMessage[];
      }
  | {
      type: 'error';
      requestId: string;
      error: string;
      errorName?: string;
      errorDetails?: {
        provider?: string;
        status?: number;
        requestId?: string;
        responseBody?: string;
        retriable?: boolean;
      };
    }
  | {
      type: 'cancelled';
      requestId: string;
    }
  | {
      type: 'app-agent-result';
      requestId: string;
      content: string;
      reasoningContent?: string;
      steps?: Array<{ name: string; status: string; summary?: string }>;
    }
  | {
      type: 'app-agent-error';
      requestId: string;
      error: string;
      errorName?: string;
    }
  | {
      type: 'app-agent-stream';
      requestId: string;
      event: IChatStreamEvent;
    };
