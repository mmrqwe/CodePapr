import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalBoolean,
  asOptionalPositiveInteger,
} from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  syncPreviewWithPage,
  syncBrowserViewPage,
  asHttpOrHttpsUrl,
  type BrowserOpenPreviewArgs,
  type BrowserNavigatePreviewArgs,
  type BrowserClosePreviewArgs,
  type BrowserOpenPageArgs,
  type BrowserNavigatePageArgs,
  type BrowserClickArgs,
  type BrowserInputArgs,
  type BrowserReadDomArgs,
  type BrowserScreenshotArgs,
  type BrowserClosePageArgs,
  type StopBackgroundProcessResult,
  type BrowserPreviewStateResult,
  type BrowserClosePreviewResult,
  type BrowserPageSessionResult,
  type BrowserPageActionResult,
  type BrowserPageDomResult,
  type BrowserPageScreenshotResult,
  type BrowserPageCloseResult,
} from './workspaceToolHelpers';
import { usePreviewStore, type PreviewSession } from '../store/previewStore';
import { useBrowserViewStore } from '../store/browserViewStore';
import { type WorkspaceToolContext } from './workspaceToolContext';

export function registerWorkspaceBrowserTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
  } = ctx;

  registry.register(toolByName('browser_open_preview'), async (args: Record<string, unknown>) => {
    const parsed: BrowserOpenPreviewArgs = {
      url: asHttpOrHttpsUrl(args.url, 'url'),
      title: asOptionalString(args.title),
      linkedPid: asOptionalPositiveInteger(args.linkedPid, 'linkedPid'),
    };

    const session: PreviewSession = {
      pid: parsed.linkedPid ?? null,
      url: parsed.url,
      title: parsed.title ?? parsed.url,
      workspacePath: workspace(),
      openedAt: Date.now(),
    };
    return { session } satisfies BrowserPreviewStateResult;
  });

  registry.register(toolByName('browser_get_preview_session'), async () => {
    const session = usePreviewStore.getState().activePreviewSession;
    return {
      session: session && session.workspacePath === workspace() ? session : null,
    } satisfies BrowserPreviewStateResult;
  });

  registry.register(toolByName('browser_navigate_preview'), async (args: Record<string, unknown>) => {
    const parsed: BrowserNavigatePreviewArgs = {
      url: asHttpOrHttpsUrl(args.url, 'url'),
      title: asOptionalString(args.title),
    };
    const current = usePreviewStore.getState().activePreviewSession;
    const session: PreviewSession = {
      pid: current?.workspacePath === workspace() ? current.pid : null,
      url: parsed.url,
      title: parsed.title ?? current?.title ?? parsed.url,
      workspacePath: workspace(),
      openedAt: Date.now(),
    };
    return { session } satisfies BrowserPreviewStateResult;
  });

  registry.register(toolByName('browser_reload_preview'), async () => {
    const current = usePreviewStore.getState().activePreviewSession;
    if (current && current.workspacePath === workspace()) {
      usePreviewStore.getState().reloadPreviewSession();
      return {
        session: usePreviewStore.getState().activePreviewSession,
      } satisfies BrowserPreviewStateResult;
    }

    return { session: null } satisfies BrowserPreviewStateResult;
  });

  registry.register(toolByName('browser_close_preview'), async (args: Record<string, unknown>) => {
    const parsed: BrowserClosePreviewArgs = {
      stopLinkedProcess: asOptionalBoolean(args.stopLinkedProcess, 'stopLinkedProcess'),
    };
    const session = usePreviewStore.getState().activePreviewSession;
    if (!session || session.workspacePath !== workspace()) {
      return {
        closed: false,
        stoppedLinkedProcess: false,
      } satisfies BrowserClosePreviewResult;
    }

    let stoppedLinkedProcess = false;
    if ((parsed.stopLinkedProcess ?? true) && typeof session.pid === 'number') {
      const result = await invoke<StopBackgroundProcessResult>('stop_background_process', {
        pid: session.pid,
      });
      stoppedLinkedProcess = result.stopped;
    }

    await invoke<BrowserPageCloseResult>('close_browser_page', {
      workspacePath: workspace(),
    });

    usePreviewStore.getState().closePreviewSession();
    return {
      closed: true,
      stoppedLinkedProcess,
    } satisfies BrowserClosePreviewResult;
  });


  registry.register(toolByName('browser_open_page'), async (args: Record<string, unknown>) => {
    const parsed: BrowserOpenPageArgs = {
      url: asHttpOrHttpsUrl(args.url, 'url'),
      title: asOptionalString(args.title),
    };

    const result = await invoke<BrowserPageSessionResult>('open_browser_page', {
      workspacePath: workspace(),
      url: parsed.url,
    });
    const session = syncPreviewWithPage(workspace(), result, parsed.title ?? result.title);
    syncBrowserViewPage(workspace(), result, parsed.title ?? result.title);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_navigate_page'), async (args: Record<string, unknown>) => {
    const parsed: BrowserNavigatePageArgs = {
      url: asHttpOrHttpsUrl(args.url, 'url'),
      title: asOptionalString(args.title),
    };

    const result = await invoke<BrowserPageSessionResult>('navigate_browser_page', {
      workspacePath: workspace(),
      url: parsed.url,
    });
    const session = syncPreviewWithPage(workspace(), result, parsed.title ?? result.title);
    syncBrowserViewPage(workspace(), result, parsed.title ?? result.title);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_reload_page'), async () => {
    const result = await invoke<BrowserPageSessionResult>('reload_browser_page', {
      workspacePath: workspace(),
    });
    const session = syncPreviewWithPage(workspace(), result);
    syncBrowserViewPage(workspace(), result);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_click'), async (args: Record<string, unknown>) => {
    const parsed: BrowserClickArgs = {
      selector: asString(args.selector, 'selector'),
      selectorType: asOptionalString(args.selectorType),
      waitForNavigation: asOptionalBoolean(args.waitForNavigation, 'waitForNavigation'),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };

    const result = await invoke<BrowserPageActionResult>('click_browser_page_element', {
      workspacePath: workspace(),
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      waitForNavigation: parsed.waitForNavigation,
      timeoutSeconds: parsed.timeoutSeconds,
    });
    const session = syncPreviewWithPage(workspace(), result);
    syncBrowserViewPage(workspace(), result);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_input_text'), async (args: Record<string, unknown>) => {
    const parsed: BrowserInputArgs = {
      selector: asString(args.selector, 'selector'),
      text: asString(args.text, 'text'),
      selectorType: asOptionalString(args.selectorType),
      clear: asOptionalBoolean(args.clear, 'clear'),
      submit: asOptionalBoolean(args.submit, 'submit'),
      waitForNavigation: asOptionalBoolean(args.waitForNavigation, 'waitForNavigation'),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };

    const result = await invoke<BrowserPageActionResult>('input_browser_page_text', {
      workspacePath: workspace(),
      selector: parsed.selector,
      text: parsed.text,
      selectorType: parsed.selectorType,
      clear: parsed.clear,
      submit: parsed.submit,
      waitForNavigation: parsed.waitForNavigation,
      timeoutSeconds: parsed.timeoutSeconds,
    });
    const session = syncPreviewWithPage(workspace(), result);
    syncBrowserViewPage(workspace(), result);
    return { ...result, previewSession: session };
  });

  registry.register(toolByName('browser_read_dom'), async (args: Record<string, unknown>) => {
    const parsed: BrowserReadDomArgs = {
      selector: asOptionalString(args.selector),
      selectorType: asOptionalString(args.selectorType),
      contentType: asOptionalString(args.contentType),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };

    const result = await invoke<BrowserPageDomResult>('read_browser_page_dom', {
      workspacePath: workspace(),
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      contentType: parsed.contentType,
      timeoutSeconds: parsed.timeoutSeconds,
    });
    syncBrowserViewPage(workspace(), result);
    return result;
  });

  registry.register(toolByName('browser_take_screenshot'), async (args: Record<string, unknown>) => {
    const parsed: BrowserScreenshotArgs = {
      relativePath: asOptionalString(args.relativePath),
      selector: asOptionalString(args.selector),
      selectorType: asOptionalString(args.selectorType),
      format: asOptionalString(args.format),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };

    const result = await invoke<BrowserPageScreenshotResult>('screenshot_browser_page', {
      workspacePath: workspace(),
      relativePath: parsed.relativePath,
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      format: parsed.format,
      timeoutSeconds: parsed.timeoutSeconds,
    });
    syncBrowserViewPage(workspace(), result);

    return result;
  });

  registry.register(toolByName('browser_close_page'), async (args: Record<string, unknown>) => {
    const parsed: BrowserClosePageArgs = {
      stopLinkedProcess: asOptionalBoolean(args.stopLinkedProcess, 'stopLinkedProcess'),
    };
    const current = usePreviewStore.getState().activePreviewSession;
    let stoppedLinkedProcess = false;

    if (
      (parsed.stopLinkedProcess ?? false) &&
      current?.workspacePath === workspace() &&
      typeof current.pid === 'number'
    ) {
      const result = await invoke<StopBackgroundProcessResult>('stop_background_process', {
        pid: current.pid,
      });
      stoppedLinkedProcess = result.stopped;
    }

    const result = await invoke<BrowserPageCloseResult>('close_browser_page', {
      workspacePath: workspace(),
    });
    if (current?.workspacePath === workspace()) {
      usePreviewStore.getState().closePreviewSession();
    }
    const browserView = useBrowserViewStore.getState();
    if (browserView.pageSession?.workspacePath === workspace()) {
      browserView.setPageSession(null);
    }

    return {
      ...result,
      stoppedLinkedProcess,
    };
  });

}
