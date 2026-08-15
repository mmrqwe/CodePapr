import { useState } from 'react';
import { errorMessage } from '@codepapr/common';

export interface ConnectionTestLabels {
  idle: string;
  connecting: string;
  success: string;
  failedPrefix: string;
}

/** 连接测试按钮：自带 connecting/success/error 状态与结果提示，
 *  供主 LLM / 快速 LLM / mentor 设置复用。 */
export function ConnectionTestButton({
  onTest,
  labels,
}: {
  onTest: () => Promise<void>;
  labels: ConnectionTestLabels;
}) {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handle = async () => {
    setStatus('connecting');
    setMessage('');
    try {
      await onTest();
      setStatus('success');
      setMessage(labels.success);
    } catch (err) {
      setStatus('error');
      setMessage(`${labels.failedPrefix}: ${errorMessage(err).slice(0, 500)}`);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => void handle()}
        disabled={status === 'connecting'}
        className="rounded-xl border border-accent-soft px-4 py-2 text-xs font-medium text-accent-text transition-colors hover:border-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'connecting' ? (
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            {labels.connecting}
          </span>
        ) : (
          labels.idle
        )}
      </button>
      {message && (
        <div
          className={`mt-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${
            status === 'success'
              ? 'border border-green-500/30 bg-green-500/10 text-green-200'
              : 'border border-danger-bg bg-danger-bg text-danger'
          }`}
        >
          {message}
        </div>
      )}
    </div>
  );
}
