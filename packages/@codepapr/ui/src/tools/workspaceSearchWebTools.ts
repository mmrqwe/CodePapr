import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalBoolean,
  asSafeSkillName,
  boundedNumber,
} from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  asHttpOrHttpsUrl,
  type ReadFileResult,
  type SearchTextArgs,
  type SearchFilesArgs,
  type SkillLoadArgs,
  type WebSearchArgs,
  type WebFetchArgs,
  type WebDownloadArgs,
  type WebSearchResponse,
  type WebFetchUrlResult,
  type SearchResult,
  type PathSearchResult,
  type DownloadFileResult,
} from './workspaceToolHelpers';
import { useAgentStore } from '../store/agentStore';
import { resolveSkillFilePath } from '../utils/projectConfigLoader';
import { type WorkspaceToolContext } from './workspaceToolContext';

export function registerWorkspaceSearchWebTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
    notifyWorkspaceMutation,
    options,
  } = ctx;
  // app 模式下放行 .CodePapr/apps（Papr 应用源码存放处），其余模式保持屏蔽
  const includeCodePaprApps = options.mode === 'app';

  registry.register(toolByName('workspace_search_text'), async (args: Record<string, unknown>) => {
    const parsed: SearchTextArgs = {
      query: asString(args.query, 'query'),
      caseSensitive: asOptionalBoolean(args.caseSensitive, 'caseSensitive'),
      isRegexp: asOptionalBoolean(args.isRegexp, 'isRegexp'),
      contextLines: asOptionalNumber(args.contextLines),
      maxResults: asOptionalNumber(args.maxResults),
      maxMatchesPerFile: asOptionalNumber(args.maxMatchesPerFile),
      maxBytesPerFile: asOptionalNumber(args.maxBytesPerFile),
      includeIgnoredDirs: asOptionalBoolean(args.includeIgnoredDirs, 'includeIgnoredDirs'),
    };
    return await invoke<SearchResult>('search_workspace_text', {
      workspacePath: workspace(),
      query: parsed.query,
      caseSensitive: parsed.caseSensitive,
      isRegexp: parsed.isRegexp,
      contextLines: parsed.contextLines,
      maxResults: parsed.maxResults,
      maxMatchesPerFile: parsed.maxMatchesPerFile,
      maxBytesPerFile: parsed.maxBytesPerFile,
      includeCodePaprApps,
      includeIgnoredDirs: parsed.includeIgnoredDirs,
    });
  });

  registry.register(toolByName('workspace_search_files'), async (args: Record<string, unknown>) => {
    const parsed: SearchFilesArgs = {
      query: asString(args.query, 'query'),
      caseSensitive: asOptionalBoolean(args.caseSensitive, 'caseSensitive'),
      isRegexp: asOptionalBoolean(args.isRegexp, 'isRegexp'),
      maxResults: asOptionalNumber(args.maxResults),
      includeIgnoredDirs: asOptionalBoolean(args.includeIgnoredDirs, 'includeIgnoredDirs'),
    };
    return await invoke<PathSearchResult>('search_workspace_paths', {
      workspacePath: workspace(),
      query: parsed.query,
      caseSensitive: parsed.caseSensitive,
      isRegexp: parsed.isRegexp,
      maxResults: parsed.maxResults,
      includeCodePaprApps,
      includeIgnoredDirs: parsed.includeIgnoredDirs,
    });
  });

  registry.register(toolByName('skill_load'), async (args: Record<string, unknown>) => {
    const parsed: SkillLoadArgs = {
      name: asSafeSkillName(args.name, 'name'),
    };
    const relativePath = await resolveSkillFilePath(invoke, workspace(), parsed.name);
    if (!relativePath) {
      throw new Error(`Skill 不存在: ${parsed.name}`);
    }
    const result = await invoke<ReadFileResult>('read_text_file', {
      workspacePath: workspace(),
      relativePath,
      maxBytes: 500_000,
    });
    return {
      ...result,
      skillPath: relativePath,
      skillRoot: relativePath.replace(/\/SKILL\.md$/i, '').replace(/\.md$/i, ''),
    };
  });

  if (!options.disableWebSearchTools) {
    registry.register(toolByName('websearch'), async (args: Record<string, unknown>) => {
      const storeSettings = useAgentStore.getState().settings;
      const parsed: WebSearchArgs = {
        query: asString(args.query, 'query'),
        maxResults: boundedNumber(asOptionalNumber(args.maxResults), 5, 1, 10),
        searxngCategory: asOptionalString(args.searxngCategory),
        searxngTimeRange: asOptionalString(args.searxngTimeRange),
        searxngLanguage: asOptionalString(args.searxngLanguage),
        searxngSafeSearch: asOptionalNumber(args.searxngSafeSearch),
      };

      const category =
        parsed.searxngCategory || storeSettings.searxngCategories || '';
      const timeRange =
        parsed.searxngTimeRange || (storeSettings.searxngTimeRange || undefined);
      const language =
        parsed.searxngLanguage || (storeSettings.searxngLanguage || undefined);
      const safeSearch =
        parsed.searxngSafeSearch ?? storeSettings.searxngSafeSearch ?? 1;

      return await invoke<WebSearchResponse>('search_web', {
        query: parsed.query,
        maxResults: parsed.maxResults,
        searxngEnabled: storeSettings.searxngEnabled || false,
        searxngBaseUrl: storeSettings.searxngBaseUrl || '',
        searxngCategories: category,
        searxngTimeRange: timeRange || '',
        searxngLanguage: language || '',
        searxngSafeSearch: safeSearch,
        searxngEngines: storeSettings.searxngEngines || '',
      });
    });

    registry.register(toolByName('web_fetch_url'), async (args: Record<string, unknown>) => {
      const parsed: WebFetchArgs = {
        url: asHttpOrHttpsUrl(args.url, 'url'),
        maxBytes: boundedNumber(asOptionalNumber(args.maxBytes), 20_000, 1_000, 100_000),
      };

      return await invoke<WebFetchUrlResult>('fetch_web_url', {
        url: parsed.url,
        maxBytes: parsed.maxBytes,
      });
    });

    registry.register(toolByName('web_download_file'), async (args: Record<string, unknown>) => {
      const parsed: WebDownloadArgs = {
        url: asHttpOrHttpsUrl(args.url, 'url'),
        relativePath: asOptionalString(args.relativePath),
      };

      const result = await invoke<DownloadFileResult>('download_web_file', {
        workspacePath: workspace(),
        url: parsed.url,
        relativePath: parsed.relativePath,
      });
      notifyWorkspaceMutation([result.path]);
      return result;
    });
  }

}
