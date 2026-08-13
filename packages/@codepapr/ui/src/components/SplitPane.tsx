import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface SplitPaneProps {
  direction: 'horizontal' | 'vertical';
  defaultRatio: number;
  minFirstSize: number;
  minSecondSize: number;
  first: ReactNode;
  second: ReactNode;
  className?: string;
  firstPaneClassName?: string;
  secondPaneClassName?: string;
  /** 隐藏分隔条：第一面板占满剩余空间，第二面板按内容高度收缩（折叠态布局）。
   *  用于"折叠/展开"两种布局共用同一组件树，避免切换时子组件被卸载重建。 */
  hideSeparator?: boolean;
}

export function SplitPane({
  direction,
  defaultRatio,
  minFirstSize,
  minSecondSize,
  first,
  second,
  className = '',
  firstPaneClassName = '',
  secondPaneClassName = '',
  hideSeparator = false,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startPosition: number; startRatio: number } | null>(null);
  const isHorizontal = direction === 'horizontal';
  const [ratio, setRatio] = useState(defaultRatio);
  const [isDragging, setIsDragging] = useState(false);

  // defaultRatio 变化时重置比例（如面板折叠/展开切换布局档位）。原实现靠改
  // key 强制重挂载来获得同样的效果，但那会卸载子组件、丢失面板内部状态。
  useEffect(() => {
    setRatio(defaultRatio);
  }, [defaultRatio]);

  const clampRatio = useCallback((nextRatio: number) => {
    const container = containerRef.current;
    if (!container) {
      return clamp(nextRatio, 0.1, 0.9);
    }

    const rect = container.getBoundingClientRect();
    const totalSize = isHorizontal ? rect.width : rect.height;
    if (totalSize <= 0) {
      return clamp(nextRatio, 0.1, 0.9);
    }

    const minRatio = minFirstSize / totalSize;
    const maxRatio = 1 - minSecondSize / totalSize;
    if (maxRatio <= minRatio) {
      return 0.5;
    }

    return clamp(nextRatio, minRatio, maxRatio);
  }, [isHorizontal, minFirstSize, minSecondSize]);

  useEffect(() => {
    setRatio((currentRatio) => clampRatio(currentRatio));
  }, [clampRatio]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      setRatio((currentRatio) => clampRatio(currentRatio));
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [clampRatio]);

  useEffect(() => {
    const remeasure = () => {
      setRatio((currentRatio) => clampRatio(currentRatio));
    };

    window.addEventListener('resize', remeasure);
    return () => {
      window.removeEventListener('resize', remeasure);
    };
  }, [clampRatio]);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const stopDrag = () => {
      dragStateRef.current = null;
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    const handlePointerMove = (event: PointerEvent) => {
      const container = containerRef.current;
      const dragState = dragStateRef.current;
      if (!container || !dragState) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const totalSize = isHorizontal ? rect.width : rect.height;
      if (totalSize <= 0) {
        return;
      }

      const pointerPosition = isHorizontal ? event.clientX : event.clientY;
      const deltaRatio = (pointerPosition - dragState.startPosition) / totalSize;
      setRatio(clampRatio(dragState.startRatio + deltaRatio));
    };

    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [clampRatio, isDragging, isHorizontal]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStateRef.current = {
      startPosition: isHorizontal ? event.clientX : event.clientY,
      startRatio: ratio,
    };
    setIsDragging(true);
  };

  const firstPaneStyle = hideSeparator
    ? { minHeight: `${minFirstSize}px` }
    : isHorizontal
      ? { flexBasis: `${ratio * 100}%`, minWidth: `${minFirstSize}px` }
      : { flexBasis: `${ratio * 100}%`, minHeight: `${minFirstSize}px` };
  const secondPaneStyle = hideSeparator
    ? {}
    : isHorizontal
      ? { minWidth: `${minSecondSize}px` }
      : { minHeight: `${minSecondSize}px` };

  return (
    <div
      ref={containerRef}
      className={`flex min-h-0 min-w-0 ${isHorizontal ? 'flex-row' : 'flex-col'} ${className}`.trim()}
    >
      <div
        className={`min-h-0 min-w-0 ${
          hideSeparator ? 'flex-1' : 'shrink-0'
        } ${firstPaneClassName}`.trim()}
        style={firstPaneStyle}
      >
        {first}
      </div>

      {!hideSeparator && (
        <div
          role="separator"
          aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
          onPointerDown={handlePointerDown}
          className={`group flex-shrink-0 bg-[#0f1117] ${
            isHorizontal ? 'w-2 cursor-col-resize px-[3px]' : 'h-2 cursor-row-resize py-[3px]'
          }`}
        >
          <div
            className={`h-full w-full rounded-full transition-colors ${
              isDragging ? 'bg-indigo-400/80' : 'bg-[#2a2d3a] group-hover:bg-indigo-500/60'
            }`}
          />
        </div>
      )}

      <div
        className={`min-h-0 min-w-0 ${
          hideSeparator ? 'shrink-0' : 'flex-1'
        } ${secondPaneClassName}`.trim()}
        style={secondPaneStyle}
      >
        {second}
      </div>
    </div>
  );
}