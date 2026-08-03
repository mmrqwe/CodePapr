/**
 * 崩溃恢复辅助：页面解冻等待与延迟。
 *
 * WKWebView 在显示器关闭/窗口被遮挡时会冻结页面；解冻后的一段时间内
 * JS 仍可能被节流。崩溃重建前先等页面恢复可见，避免新 Worker 在节流期
 * 被再次误判/击杀。
 */

/** 页面已可见则立即返回；否则等待 visibilitychange→visible，超时兜底返回。 */
export function waitForPageVisible(timeoutMs: number): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      resolve();
    }, timeoutMs);
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      resolve();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
