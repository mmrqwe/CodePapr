export function getChatAutoScrollBehavior(params: {
  previousTailMessageId: string | null;
  nextTailMessageId: string | null;
  hasStreamingMessage: boolean;
}): ScrollBehavior {
  const { previousTailMessageId, nextTailMessageId, hasStreamingMessage } = params;
  if (
    hasStreamingMessage &&
    previousTailMessageId !== null &&
    previousTailMessageId === nextTailMessageId
  ) {
    return 'auto';
  }

  return 'smooth';
}

interface ScrollMetricsLike {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

interface ScrollContainerLike {
  scrollTop: number;
  scrollHeight: number;
  scrollTo?: (options: { top: number; behavior: ScrollBehavior }) => void;
}

export function isScrollContainerNearBottom(
  container: ScrollMetricsLike,
  thresholdPx: number = 48
): boolean {
  return container.scrollHeight - container.clientHeight - container.scrollTop <= thresholdPx;
}

export function scrollContainerToBottom(
  container: ScrollContainerLike,
  behavior: ScrollBehavior
): void {
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: container.scrollHeight, behavior });
    return;
  }

  container.scrollTop = container.scrollHeight;
}
