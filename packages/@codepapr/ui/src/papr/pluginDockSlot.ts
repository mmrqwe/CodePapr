import { useEffect, useState, useSyncExternalStore } from 'react';

let slotEl: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setPluginDockSlot(el: HTMLElement | null): void {
  if (slotEl === el) return;
  slotEl = el;
  listeners.forEach((listener) => listener());
}

export function getPluginDockSlot(): HTMLElement | null {
  return slotEl;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePluginDockRect(): { x: number; y: number; width: number; height: number } | null {
  const el = useSyncExternalStore(subscribe, () => slotEl, () => null);
  const [rect, setRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!el) {
      setRect(null);
      return;
    }
    const update = () => {
      const next = el.getBoundingClientRect();
      setRect({ x: next.x, y: next.y, width: next.width, height: next.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [el]);

  return rect;
}
