import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';

export default function NotFoundPage() {
  return (
    <div className="relative min-h-[75vh] flex items-center justify-center text-center px-6 bg-[#fafaf9]">
      {/* Dotted Grid Background */}
      <div className="absolute inset-0 bg-dotted-grid opacity-20 pointer-events-none" />

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="max-w-md bg-white border border-neutral-200/80 rounded-2xl p-8 sm:p-10 shadow-xl relative z-10 space-y-6"
      >
        <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 block leading-none">
          Error 404
        </span>
        <h2 className="font-serif italic text-4xl text-neutral-950">
          Page Not Found
        </h2>
        <p className="text-sm text-neutral-600 font-sans">
          The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.
        </p>
        <div className="pt-2">
          <Link
            to="/"
            className="inline-block px-6 py-3.5 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow-lg hover:bg-neutral-900 transition-all select-none"
          >
            Back to Booking
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
