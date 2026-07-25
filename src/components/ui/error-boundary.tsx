import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";

interface Props {
  readonly children: ReactNode;
  readonly fallbackLabel?: string;
}

interface State {
  readonly hasError: boolean;
  readonly error: Error | null;
}

/**
 * Reusable ErrorBoundary for any panel/section.
 * Shows a contextual error message with retry (reset state) and reload options.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch() {
    // Error is already captured in getDerivedStateFromError
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const label = this.props.fallbackLabel ?? "Component";
      const errorMessage = this.state.error?.message ?? "An unknown error occurred";

      return (
        <div className="flex flex-col items-center justify-center h-full w-full p-6">
          <div className="flex flex-col items-center gap-4 max-w-md">
            <AlertTriangle size={36} className="text-red-500" />
            <div className="text-center">
              <h2 className="text-[14px] font-semibold text-[#E0E0E0] mb-2">
                {label} Error
              </h2>
              <p className="text-[12px] text-[#999999] mb-4 font-mono break-all">
                {errorMessage}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={this.handleRetry}
                className="flex items-center gap-2 px-3 py-1.5 bg-hover-overlay/5 hover:bg-hover-overlay/10 text-muted-foreground rounded-md transition-colors text-[12px] font-medium"
              >
                <RotateCcw size={14} />
                Retry
              </button>
              <button
                onClick={this.handleReload}
                className="flex items-center gap-2 px-3 py-1.5 bg-accent-purple hover:bg-accent-purple/80 text-white rounded-md transition-colors text-[12px] font-medium"
              >
                <RefreshCw size={14} />
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
