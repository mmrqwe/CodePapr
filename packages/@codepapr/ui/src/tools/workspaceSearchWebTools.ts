import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalBoolean,
  asOptionalStringArray,
  asSafeSkillName,
  boundedNumber,
  isSkillAvailableToLoad,
  skillRootFromPath,
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
import { effectiveCodePaprMode, assertAgentCodePaprAccess } from './codepaprAgentAccess';

export function registerWorkspaceSearchWebTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
    notifyWorkspaceMutation,
    options,
  } = ctx;
  const includeCodePaprAppsFor = (appAccess?: { allowCodepaprApps?: boolean }): boolean =>
    effectiveCodePaprMode(options.mode, appAccess) === 'app';

  registry.register(toolByName('workspace_search_text'), async (args: Record<string, unknown>, context) => {
    const parsed: SearchTextArgs = {
      query: asString(args.query, 'query'),
      caseSensitive: asOptionalBoolean(args.caseSensitive, 'caseSensitive'),
      isRegexp: asOptionalBoolean(args.isRegexp, 'isRegexp'),
      contextLines: asOptionalNumber(args.contextLines),
      maxResults: asOptionalNumber(args.maxResults),
      maxMatchesPerFile: asOptionalNumber(args.maxMatchesPerFile),
      maxBytesPerFile: asOptionalNumber(args.maxBytesPerFile),
      includeIgnoredDirs: asOptionalBoolean(args.includeIgnoredDirs, 'includeIgnoredDirs'),
      includeGlobs: asOptionalStringArray(args.includeGlobs),
      excludeGlobs: asOptionalStringArray(args.excludeGlobs),
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
      includeCodePaprApps: includeCodePaprAppsFor(context?.appAccess),
      includeIgnoredDirs: parsed.includeIgnoredDirs,
      includeGlobs: parsed.includeGlobs,
      excludeGlobs: parsed.excludeGlobs,
    });
  });

  registry.register(toolByName('workspace_search_files'), async (args: Record<string, unknown>, context) => {
    const parsed: SearchFilesArgs = {
      query: asString(args.query, 'query'),
      caseSensitive: asOptionalBoolean(args.caseSensitive, 'caseSensitive'),
      isRegexp: asOptionalBoolean(args.isRegexp, 'isRegexp'),
      maxResults: asOptionalNumber(args.maxResults),
      includeIgnoredDirs: asOptionalBoolean(args.includeIgnoredDirs, 'includeIgnoredDirs'),
      includeGlobs: asOptionalStringArray(args.includeGlobs),
      excludeGlobs: asOptionalStringArray(args.excludeGlobs),
    };
    return await invoke<PathSearchResult>('search_workspace_paths', {
      workspacePath: workspace(),
      query: parsed.query,
      caseSensitive: parsed.caseSensitive,
      isRegexp: parsed.isRegexp,
      maxResults: parsed.maxResults,
      includeCodePaprApps: includeCodePaprAppsFor(context?.appAccess),
      includeIgnoredDirs: parsed.includeIgnoredDirs,
      includeGlobs: parsed.includeGlobs,
      excludeGlobs: parsed.excludeGlobs,
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
    const { _skillDefinitions } = useAgentStore.getState();
    // 停用的 Skill 对 Agent 完全不可见：报「不存在」而非「已停用」，避免泄漏停用状态。
    if (!isSkillAvailableToLoad(parsed.name, _skillDefinitions) || !isSkillAvailableToLoad(relativePath, _skillDefinitions)) {
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
      skillRoot: skillRootFromPath(relativePath),
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

      // 设置里的分类/时间/语言只在 SearXNG 启用时作为默认值注入；
      // Agent 显式传参照常下发（未启用时由后端在 note 中说明参数被忽略）。
      const searxngOn = storeSettings.searxngEnabled || false;
      const category =
        parsed.searxngCategory || (searxngOn ? storeSettings.searxngCategories || '' : '');
      const timeRange =
        parsed.searxngTimeRange || (searxngOn ? storeSettings.searxngTimeRange || undefined : undefined);
      const language =
        parsed.searxngLanguage || (searxngOn ? storeSettings.searxngLanguage || undefined : undefined);
      const safeSearch =
        parsed.searxngSafeSearch ?? (searxngOn ? storeSettings.searxngSafeSearch ?? 1 : 1);

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

    registry.register(toolByName('web_download_file'), async (args: Record<string, unknown>, context) => {
      const parsed: WebDownloadArgs = {
        url: asHttpOrHttpsUrl(args.url, 'url'),
        relativePath: asOptionalString(args.relativePath),
      };
      // 下载即写盘：与 write/edit 同一 .CodePapr 闸门，否则 webfetch(save) 可绕过
      // 覆写 AGENTS.md 等非 app 模式禁写路径。未传 relativePath 时 Rust 侧落到
      // .CodePapr/downloads（草稿区，闸门放行）。
      assertAgentCodePaprAccess(
        parsed.relativePath,
        'write',
        effectiveCodePaprMode(options.mode, context?.appAccess)
      );

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
