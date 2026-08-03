import { invoke } from '@tauri-apps/api/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  type LocalTimeNowResult,
} from './workspaceToolHelpers';
import { runProjectDiagnostics } from '../utils/projectDiagnostics';
import { type WorkspaceToolContext } from './workspaceToolContext';

export function registerWorkspaceMiscTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
  } = ctx;

  registry.register(toolByName('workspace_project_diagnostics'), async () => {
    return await runProjectDiagnostics(workspace(), invoke);
  });

  registry.register(toolByName('local_time_now'), async () => {
    const now = new Date();
    const offsetMinutes = -now.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absoluteOffset = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
    const offsetRemainder = String(absoluteOffset % 60).padStart(2, '0');
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return {
      iso: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemainder}`,
      local: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
      date: `${year}-${month}-${day}`,
      time: `${hours}:${minutes}:${seconds}`,
      weekday: now.toLocaleDateString(undefined, { weekday: 'long' }),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
      offsetMinutes,
      unixMs: now.getTime(),
    } satisfies LocalTimeNowResult;
  });
}
