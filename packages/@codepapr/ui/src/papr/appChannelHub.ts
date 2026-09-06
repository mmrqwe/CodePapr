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
 *
 * 挂载竞态缓冲：reveal-on-publish（app_publish 自动 pin 插件）发生在广播
 * 之后，新 iframe 必然错过当时的 papr://event。因此无 poster 时事件额外
 * 进入短 TTL 队列，待任一实例完成加载（papr://app-ready）冲刷补发。
 * 队列只在无挂载实例时写入，避免已消费过事件的文档（热重载换纪元）被
 * 二次投递；接收方仍应按 seq 去重（事件同时可从 db inbox 回放）。
 */

/** 未挂载事件在内存队列中的最长保留时间（覆盖「发布→自动打开→加载完成」
 *  的窗口；更晚打开的应用本来就会从 db 回放全量历史）。 */
const PENDING_TTL_MS = 30_000;
/** 每个 app 队列上限（只保留最新的，防无界增长）。 */
const PENDING_CAP = 32;

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

interface PendingEnvelope {
  envelope: AppChannelEnvelope;
  /** 入队墙钟时间（Date.now），用于 TTL 过期，与 event.ts（Rust 时钟）解耦。 */
  at: number;
}

const pendingByApp = new Map<string, PendingEnvelope[]>();

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

/** 向已挂载的 app 广播事件。没有任何挂载实例时返回 false 并把事件放入短 TTL
 *  队列（调用方据此标记 delivered:false + queued；数据已落库，不影响持久化
 *  语义。新挂载实例在 app-ready 时经 flushPendingAppEvents 补收）。 */
export function postAppEvent(appId: string, event: AppChannelEvent): boolean {
  const envelope: AppChannelEnvelope = { __papr: true, type: 'papr://event', payload: event };
  const set = postersByApp.get(appId);
  if (!set || set.size === 0) {
    queuePending(appId, envelope);
    return false;
  }
  for (const poster of set) {
    try {
      poster(envelope);
    } catch {
      // 单个 iframe 失效不阻塞其他订阅者
    }
  }
  return true;
}

function queuePending(appId: string, envelope: AppChannelEnvelope): void {
  const now = Date.now();
  const kept = (pendingByApp.get(appId) ?? []).filter((entry) => now - entry.at <= PENDING_TTL_MS);
  kept.push({ envelope, at: now });
  pendingByApp.set(appId, kept.slice(-PENDING_CAP));
}

/** 某 iframe 文档加载完成（papr://app-ready）时冲刷该 app 的排队事件。
 *  投递即清空队列：只有「广播时零挂载」的事件会被排队（见 postAppEvent），
 *  首个 ready 的文档拿全量，其余文档由自身 db 回放覆盖。
 *  返回实际送达条数（TTL 过期的条目被丢弃、不投递）。 */
export function flushPendingAppEvents(appId: string, deliver: AppPoster): number {
  const queued = pendingByApp.get(appId);
  pendingByApp.delete(appId);
  if (!queued || queued.length === 0) return 0;
  const now = Date.now();
  let delivered = 0;
  for (const entry of queued) {
    if (now - entry.at > PENDING_TTL_MS) continue;
    try {
      deliver(entry.envelope);
      delivered += 1;
    } catch {
      // 投递失败不阻断其余事件（本路径只服务刚 ready 的单个文档）
    }
  }
  return delivered;
}

/** 测试用：清空注册表与排队队列。 */
export function clearAppPosters(): void {
  postersByApp.clear();
  pendingByApp.clear();
}
