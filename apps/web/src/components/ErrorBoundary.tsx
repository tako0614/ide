import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Application error:', error);
    console.error('Component stack:', errorInfo.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-bg">
          <div className="max-w-[500px] p-8 bg-panel border border-border text-center">
            <h1 className="m-0 mb-4 text-xl text-[#f14c4c]">Something went wrong</h1>
            <p className="m-0 mb-6 text-muted">The application encountered an unexpected error.</p>
            {this.state.error && (
              <details className="mb-6 text-left">
                <summary className="cursor-pointer text-muted mb-2">Error details</summary>
                <pre className="p-4 bg-bg-soft text-[0.75rem] overflow-x-auto whitespace-pre-wrap break-words">{this.state.error.message}</pre>
              </details>
            )}
            <button
              onClick={this.handleReload}
              className="px-4 py-2 bg-accent text-white border-0 rounded-[2px] font-medium cursor-pointer hover:opacity-90"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
