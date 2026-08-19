/// <reference lib="webworker" />

import type { WorkspaceProjectGraphResult } from '@codepapr/core';
import {
  buildWorkspaceProjectGraph,
  buildWorkspaceProjectMapSync,
} from '../tools/workspaceProjectGraphShared';
import type {
  ProjectGraphWorkerBuildRequest,
  ProjectGraphWorkerMessage,
} from './projectGraphWorkerProtocol';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<ProjectGraphWorkerBuildRequest>) => {
  const request = event.data;
  if (request.type !== 'build') return;

  try {
    self.postMessage({ type: 'progress', phase: 'building-map' } as ProjectGraphWorkerMessage);
    const projectMap = buildWorkspaceProjectMapSync(request.projectMapParams);

    self.postMessage({ type: 'progress', phase: 'building-graph' } as ProjectGraphWorkerMessage);
    const projectGraph: WorkspaceProjectGraphResult = buildWorkspaceProjectGraph({
      projectMap,
      ...request.projectGraphParams,
    });

    self.postMessage({ type: 'result', projectMap, projectGraph } as ProjectGraphWorkerMessage);
  } catch (error) {
    self.postMessage({ type: 'error', error: (error as Error).message || 'Unknown error' } as ProjectGraphWorkerMessage);
  }
};
