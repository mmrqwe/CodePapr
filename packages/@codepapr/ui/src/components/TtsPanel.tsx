import type { UseTtsPlayerReturn } from '../hooks/useTtsPlayer';

interface TtsStatusBadgeProps {
  status: UseTtsPlayerReturn['serverStatus'];
}

export function TtsStatusBadge({ status }: TtsStatusBadgeProps) {
  const colors: Record<string, string> = {
    unknown: 'bg-slate-500',
    starting: 'bg-blue-400',
    running: 'bg-ok',
    stopped: 'bg-slate-500',
    error: 'bg-danger',
  };

  const animate = status === 'unknown' || status === 'starting';

  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${colors[status] ?? colors.unknown} ${animate ? 'animate-pulse' : ''}`}
      title={`TTS server: ${status}`}
    />
  );
}
