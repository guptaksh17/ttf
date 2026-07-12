import React, { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const ToastContext = createContext(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'success', duration = 4000) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type, duration }]);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}

      {/* Toast Notification Container in Top-Right corner */}
      <div className="fixed top-6 right-6 z-50 flex flex-col gap-3 w-full max-w-sm pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onClose={() => removeToast(toast.id)}
            />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onClose }) {
  const { message, type, duration } = toast;

  React.useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const getColors = () => {
    switch (type) {
      case 'error':
        return {
          bg: 'bg-rose-50 border-rose-200/80',
          text: 'text-rose-900',
          bar: 'bg-rose-500',
          icon: '✕'
        };
      case 'warning':
        return {
          bg: 'bg-amber-50 border-amber-200/80',
          text: 'text-amber-900',
          bar: 'bg-amber-500',
          icon: '!'
        };
      case 'success':
      default:
        return {
          bg: 'bg-emerald-50 border-emerald-200/80',
          text: 'text-emerald-900',
          bar: 'bg-emerald-500',
          icon: '✓'
        };
    }
  };

  const colors = getColors();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.2 } }}
      transition={{ type: 'spring', damping: 20, stiffness: 300 }}
      className={`pointer-events-auto border rounded-xl shadow-lg overflow-hidden relative flex items-start gap-3 p-4 pr-10 ${colors.bg}`}
    >
      {/* Icon Badge */}
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-white shadow-sm border border-neutral-100 flex items-center justify-center text-[10px] font-bold select-none leading-none">
        {colors.icon}
      </span>

      {/* Message Text */}
      <div className="flex-1 flex flex-col text-left">
        <span className={`text-[13px] font-semibold leading-relaxed tracking-wide ${colors.text}`}>
          {message}
        </span>
      </div>

      {/* Manual Dismiss Button */}
      <button
        onClick={onClose}
        className="absolute top-3 right-3 w-5 h-5 rounded-full flex items-center justify-center border border-transparent hover:border-neutral-200 bg-transparent hover:bg-white text-neutral-400 hover:text-neutral-900 transition-all font-mono text-[9px]"
      >
        ✕
      </button>

      {/* Shrinking progress timer bar */}
      <motion.div
        initial={{ width: '100%' }}
        animate={{ width: '0%' }}
        transition={{ duration: duration / 1000, ease: 'linear' }}
        className={`absolute bottom-0 left-0 h-[3px] ${colors.bar}`}
      />
    </motion.div>
  );
}
