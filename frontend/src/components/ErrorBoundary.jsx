import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Caught exception:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="relative min-h-[60vh] flex flex-col items-center justify-center text-center px-6 bg-[#fafaf9]">
          <div className="absolute inset-0 bg-dotted-grid opacity-20 pointer-events-none" />
          <div className="max-w-md bg-white border border-neutral-200/80 rounded-2xl p-8 shadow-xl relative z-10 space-y-4">
            <span className="text-[11px] font-bold uppercase tracking-widest text-rose-500 block leading-none">
              Application Error
            </span>
            <h2 className="font-serif italic text-3xl text-neutral-950">
              Something went wrong
            </h2>
            <p className="text-sm text-neutral-600 font-sans">
              An unexpected error occurred in the application. Please try reloading the page.
            </p>
            <pre className="p-4 bg-neutral-50 rounded-xl text-left font-mono text-xs text-neutral-500 overflow-x-auto max-h-40 border border-neutral-100">
              {this.state.error?.toString()}
            </pre>
            <div className="pt-2">
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-3 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow-md hover:bg-neutral-900 transition-all select-none"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
