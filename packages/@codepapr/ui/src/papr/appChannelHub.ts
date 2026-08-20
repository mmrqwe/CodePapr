/**
 * app 下行事件分发中心：agent 工具 app_publish 把内容推给已挂载的
 * app/plugin iframe。
 *
 * iframe 引用散在 AppModal / PluginOverlayHost 各组件里，此注册表让主线程
 * 任意位置（工具 handler）都能按 appId 找到对应 iframe 的 postMessage 通道。
 * usePaprBridge 挂载时注册 poster，卸载时注销——两个渲染面自动覆盖。
 *
 * 数据面（db 落库）不依赖本模块：即使没有挂载的 iframe（poster 为空），
 * app_publish 也已把事件写入 app 的 db.sqlite，应用下次打开可回放历史。
 */

/** papr://event 下行载荷（与 types 包 PaprAppEvent 一致）。 */
export interface AppChannelEvent {
  channel: string;
  seq: number;
  ts: number;
  payload: unknown;
}

export interface AppChannelEnvelope {
  __papr: true;
  type: 'papr://event';
  payload: AppChannelEvent;
}

type AppPoster = (envelope: AppChannelEnvelope) => void;

const postersByApp = new Map<string, Set<AppPoster>>();

/** 注册某 app 的下行通道（同一 appId 可有多个 iframe 实例，全部广播）。
 *  返回注销函数。 */
export function registerAppPoster(appId: string, poster: AppPoster): () => void {
  let set = postersByApp.get(appId);
  if (!set) {
    set = new Set();
    postersByApp.set(appId, set);
  }
  set.add(poster);
  return () => {
    const current = postersByApp.get(appId);
    if (!current) return;
    current.delete(poster);
    if (current.size === 0) postersByApp.delete(appId);
  };
}

/** 向已挂载的 app 广播事件。没有任何挂载实例时返回 false（调用方据此标记
 *  delivered；数据已落库，不影响持久化语义）。 */
export function postAppEvent(appId: string, event: AppChannelEvent): boolean {
  const set = postersByApp.get(appId);
  if (!set || set.size === 0) return false;
  const envelope: AppChannelEnvelope = { __papr: true, type: 'papr://event', payload: event };
  for (const poster of set) {
    try {
      poster(envelope);
    } catch {
      // 单个 iframe 失效不阻塞其他订阅者
    }
  }
  return true;
}

/** 测试用：清空注册表。 */
export function clearAppPosters(): void {
  postersByApp.clear();
}
