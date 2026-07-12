import React from 'react';
import { motion } from 'framer-motion';

export default function StatusBadge({ status }) {
  const getStyle = () => {
    switch (status) {
      case 'reserved':
        return {
          bg: 'bg-amber-50 text-amber-800 border-amber-200/80',
          dot: 'bg-amber-500 animate-pulse',
          label: 'On Hold'
        };
      case 'payment_pending':
        return {
          bg: 'bg-yellow-50 text-yellow-800 border-yellow-200/80',
          dot: 'bg-yellow-500 animate-pulse',
          label: 'Paying'
        };
      case 'booking_confirmed':
      case 'confirmed':
        return {
          bg: 'bg-emerald-50 text-emerald-800 border-emerald-200/80',
          dot: 'bg-emerald-500',
          label: 'Confirmed'
        };
      case 'payment_failed':
        return {
          bg: 'bg-rose-50 text-rose-800 border-rose-200/80',
          dot: 'bg-rose-500',
          label: 'Payment Failed'
        };
      case 'released':
        return {
          bg: 'bg-neutral-50 text-neutral-600 border-neutral-200/80',
          dot: 'bg-neutral-400',
          label: 'Released'
        };
      case 'cancelled':
        return {
          bg: 'bg-neutral-100 text-neutral-500 border-neutral-300',
          dot: 'bg-neutral-400',
          label: 'Cancelled'
        };
      default:
        return {
          bg: 'bg-neutral-50 text-neutral-600 border-neutral-200/80',
          dot: 'bg-neutral-400',
          label: status
        };
    }
  };

  const style = getStyle();

  return (
    <motion.span
      layout
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className={`inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-full border shadow-sm select-none ${style.bg} transition-all duration-300`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      <span>{style.label}</span>
    </motion.span>
  );
}
