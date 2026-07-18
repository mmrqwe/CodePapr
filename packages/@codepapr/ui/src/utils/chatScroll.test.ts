import { describe, expect, it, vi } from 'vitest';
import {
  getChatAutoScrollBehavior,
  isScrollContainerNearBottom,
  scrollContainerToBottom,
} from './chatScroll';

describe('getChatAutoScrollBehavior', () => {
  it('uses auto scrolling for streaming updates on the same tail message', () => {
    expect(
      getChatAutoScrollBehavior({
        previousTailMessageId: 'assistant-1',
        nextTailMessageId: 'assistant-1',
        hasStreamingMessage: true,
      })
    ).toBe('auto');
  });

  it('uses smooth scrolling when a new tail message is appended', () => {
    expect(
      getChatAutoScrollBehavior({
        previousTailMessageId: 'assistant-1',
        nextTailMessageId: 'assistant-2',
        hasStreamingMessage: true,
      })
    ).toBe('smooth');
  });

  it('uses smooth scrolling when no streaming message is active', () => {
    expect(
      getChatAutoScrollBehavior({
        previousTailMessageId: 'assistant-1',
        nextTailMessageId: 'assistant-1',
        hasStreamingMessage: false,
      })
    ).toBe('smooth');
  });

  it('detects when a scroll container is near the bottom', () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 352,
        clientHeight: 400,
        scrollHeight: 780,
      })
    ).toBe(true);

    expect(
      isScrollContainerNearBottom({
        scrollTop: 120,
        clientHeight: 400,
        scrollHeight: 780,
      })
    ).toBe(false);
  });

  it('scrolls a container to the bottom via scrollTop for auto behavior', () => {
    const container = {
      scrollTop: 0,
      scrollHeight: 640,
    };
    scrollContainerToBottom(container, 'auto');

    expect(container.scrollTop).toBe(640);
  });

  it('scrolls a container to the bottom through scrollTo for smooth behavior', () => {
    const scrollTo = vi.fn();
    const container = {
      scrollTop: 0,
      scrollHeight: 640,
      scrollTo,
    };
    scrollContainerToBottom(container, 'smooth');

    expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: 'smooth' });
  });

  it('falls back to scrollTop assignment when scrollTo is unavailable', () => {
    const container: { scrollTop: number; scrollHeight: number } = {
      scrollTop: 0,
      scrollHeight: 640,
    };
    scrollContainerToBottom(container, 'smooth');

    expect(container.scrollTop).toBe(640);
  });
});
