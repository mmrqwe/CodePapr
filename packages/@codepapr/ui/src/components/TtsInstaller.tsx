import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

interface InstallStep {
  step_id: string;
  label: string;
  status: 'pending' | 'running' | 'ok' | 'fail' | 'cancelled';
  percent: number | null;
  log_line: string;
}

interface TtsInstallerProps {
  onClose: () => void;
}

export function TtsInstaller({ onClose }: TtsInstallerProps) {
  const [steps, setSteps] = useState<InstallStep[]>(() =>
    [
      { step_id: 'check-python', label: 'Checking Python', status: 'pending', percent: null, log_line: '' },
      { step_id: 'clone-code', label: 'Downloading code', status: 'pending', percent: null, log_line: '' },
      { step_id: 'install-deps', label: 'Installing packages', status: 'pending', percent: null, log_line: '' },
      { step_id: 'download-models', label: 'Downloading models', status: 'pending', percent: null, log_line: '' },
      { step_id: 'verify', label: 'Verifying installation', status: 'pending', percent: null, log_line: '' },
    ]
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      if (scrollTimerRef.current !== null) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    // Throttle scroll to once per 150ms — high-frequency log lines
    // (e.g. pip install output) would otherwise trigger continuous
    // layout thrashing from smooth scroll reflows.
    if (scrollTimerRef.current !== null) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 150);
  }, [logs]);

  const updateStep = useCallback((progress: InstallStep) => {
    setSteps((prev) =>
      prev.map((s) => (s.step_id === progress.step_id ? { ...s, ...progress } : s))
    );
    if (progress.log_line) {
      setLogs((prev) => [...prev.slice(-200), progress.log_line]);
    }
  }, []);

  const startInstall = useCallback(async () => {
    setRunning(true);
    // 重复点击安装（或取消后重装）时先解绑旧监听器，避免监听器累积。
    unlistenRef.current?.();
    unlistenRef.current = null;
    unlistenRef.current = await listen<InstallStep>('tts-install-progress', (event) => {
      updateStep(event.payload);
      if (event.payload.status === 'cancelled' || event.payload.status === 'ok' || event.payload.status === 'fail') {
        setRunning(false);
      }
    });

    try {
      await invoke('tts_install', { source: 'hf-mirror' });
    } catch (err) {
      // 启动失败要让用户看到：日志区留痕并退出 running 态，否则按钮永远卡在 Installing。
      setRunning(false);
      setLogs((prev) => [...prev, `Failed to start installation: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }, [updateStep]);

  const handleCancel = useCallback(() => {
    invoke('tts_install_cancel').catch(() => {});
  }, []);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'ok': return <span className="text-ok">&#10003;</span>;
      case 'fail': return <span className="text-danger">&#10007;</span>;
      case 'cancelled': return <span className="text-warn">&#8855;</span>;
      case 'running': return <span className="animate-spin text-warn">&#8635;</span>;
      default: return <span className="text-fg-dim">&#9679;</span>;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm">
      <div className="w-[440px] rounded-2xl border border-line bg-raised shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-fg">
            {running ? 'Installing GPT-SoVITS...' : 'GPT-SoVITS Setup'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="text-fg-muted hover:text-fg-soft text-lg leading-none disabled:opacity-30"
          >
            x
          </button>
        </div>

        <div className="px-5 py-3 space-y-1.5">
          {steps.map((step) => (
            <div key={step.step_id} className="flex items-center gap-2.5">
              <span className="w-4 text-center text-xs">{statusIcon(step.status)}</span>
              <span className={`text-xs flex-1 ${
                step.status === 'fail' ? 'text-danger' :
                step.status === 'cancelled' ? 'text-warn' :
                step.status === 'ok' ? 'text-ok' :
                step.status === 'running' ? 'text-fg' :
                'text-fg-muted'
              }`}>
                {step.label}
              </span>
              {step.percent !== null && step.percent < 100 && (
                <span className="text-[10px] text-fg-dim">{step.percent}%</span>
              )}
            </div>
          ))}
        </div>

        <div className="mx-4 border-t border-line" />

        <div className="px-5 py-2 h-40 overflow-y-auto bg-base font-mono text-[11px] leading-relaxed text-fg-muted scrollbar-thin">
          {logs.length === 0 && (
            <span className="text-slate-700">
              {running ? 'Starting...' : 'Click "Install" to begin.'}
            </span>
          )}
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          <div ref={logEndRef} />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          {running ? (
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-lg border border-danger-bg px-4 py-2 text-xs font-medium text-danger hover:bg-danger-bg transition-colors"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { void startInstall(); }}
              className="rounded-lg bg-accent-soft border border-accent-soft px-4 py-2 text-xs font-medium text-accent-text hover:bg-accent-soft transition-colors"
            >
              Install GPT-SoVITS
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
