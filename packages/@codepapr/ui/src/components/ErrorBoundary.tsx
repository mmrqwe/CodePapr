import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[CodePapr] 组件渲染崩溃:', error, info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="text-3xl">⚠</div>
          <p className="max-w-md text-sm text-fg-soft">
            {this.state.error?.message ?? '组件渲染时发生错误'}
          </p>
          <button
            onClick={this.handleReset}
            className="rounded-lg border border-slate-600 px-4 py-2 text-xs text-fg-soft hover:bg-slate-700/50"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
