import {
  forwardRef,
  useImperativeHandle,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import type { AgentDefinition, SkillDefinition } from '@codepapr/core';

export interface AtMentionDropdownHandle {
  navigateDown: () => void;
  navigateUp: () => void;
  selectCurrent: () => void;
}

export interface MentionItem {
  type: 'agent' | 'skill';
  name: string;
  description: string;
}

interface AtMentionDropdownProps {
  filter: string;
  items: MentionItem[];
  onSelect: (item: MentionItem) => void;
  onDismiss: () => void;
}

function resolveDescription(
  def: AgentDefinition,
  lang?: string
): string {
  const d = def.description;
  if (typeof d === 'string') return d;
  const key = lang === 'zh-TW' || lang === 'en' ? lang : 'zh-CN';
  return d[key] ?? d['zh-CN'] ?? '';
}

export function buildMentionItems(
  agentDefinitions: AgentDefinition[],
  skillDefinitions: SkillDefinition[],
  lang?: string,
  mentorEnabled?: boolean,
): MentionItem[] {
  const agents = agentDefinitions
    .filter((a) => {
      if (a.mode === 'primary') return false;
      if (a.internal) return false;
      if (a.name === 'mentor' && mentorEnabled === false) return false;
      return true;
    })
    .map((a) => ({
      type: 'agent' as const,
      name: a.name,
      description: resolveDescription(a, lang),
    }));

  const skills = skillDefinitions
    .filter((s) => s.enabled !== false)
    .map((s) => ({
      type: 'skill' as const,
      name: s.name,
      description: s.description,
    }));

  return [...agents, ...skills];
}

const AtMentionDropdown = forwardRef<AtMentionDropdownHandle, AtMentionDropdownProps>(
  ({ filter, items, onSelect, onDismiss }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    const filtered = useMemo(() => {
      const q = filter.trim().toLowerCase();
      if (!q) return items;
      return items.filter((item) => item.name.toLowerCase().includes(q));
    }, [items, filter]);

    useEffect(() => {
      setSelectedIndex(0);
    }, [filter]);

    useEffect(() => {
      const selectedEl = itemRefs.current.get(selectedIndex);
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
      }
    }, [selectedIndex]);

    const navigateDown = useCallback(() => {
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    }, [filtered.length]);

    const navigateUp = useCallback(() => {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    }, []);

    const selectCurrent = useCallback(() => {
      const item = filtered[selectedIndex];
      if (item) {
        onSelect(item);
      }
    }, [filtered, selectedIndex, onSelect]);

    useImperativeHandle(
      ref,
      () => ({
        navigateDown,
        navigateUp,
        selectCurrent,
      }),
      [navigateDown, navigateUp, selectCurrent]
    );

    useEffect(() => {
      const handler = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          onDismiss();
        }
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, [onDismiss]);

    if (filtered.length === 0) return null;

    const typeLabel = (type: string) => (type === 'agent' ? 'Agent' : 'Skill');
    const typeColor = (type: string) =>
      type === 'agent' ? 'text-emerald-400' : 'text-amber-400';

    return (
      <div
        ref={containerRef}
        className="absolute bottom-full left-0 right-0 flex mb-2 z-50"
      >
        <div className="flex-1 max-h-[240px] overflow-y-auto rounded-xl border border-[#2a2d3a] bg-[#1a1d27] shadow-lg shadow-black/30 py-1">
          {filtered.map((item, index) => (
            <div
              key={`${item.type}:${item.name}`}
              ref={(el) => {
                if (el) {
                  itemRefs.current.set(index, el);
                } else {
                  itemRefs.current.delete(index);
                }
              }}
              onMouseEnter={() => {
                setSelectedIndex(index);
              }}
              onClick={() => onSelect(item)}
              className={`group/item relative flex items-center gap-3 px-4 py-2.5 text-sm cursor-pointer transition-colors ${
                index === selectedIndex
                  ? 'bg-indigo-600/20 text-white'
                  : 'text-slate-300 hover:bg-[#222639]'
              }`}
            >
              <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${typeColor(item.type)} bg-slate-800/80`}>
                {typeLabel(item.type)}
              </span>
              <span className="font-mono text-indigo-400 whitespace-nowrap">@{item.name}</span>
              {item.description && (
                <span className="text-slate-500 truncate flex-1 min-w-0">{item.description}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }
);

AtMentionDropdown.displayName = 'AtMentionDropdown';

export default AtMentionDropdown;
