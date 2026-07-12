import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

export default function CountdownRing({ expiresAt, onExpire, size = 50, strokeWidth = 3 }) {
  const [timeLeft, setTimeLeft] = useState(0);
  const [totalDuration, setTotalDuration] = useState(300); // Default to 5 minutes (300s)

  useEffect(() => {
    if (!expiresAt) return;

    const expiryTime = new Date(expiresAt).getTime();
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((expiryTime - now) / 1000));
    setTimeLeft(remaining);

    // Estimate total reservation duration (usually 5 mins, i.e., 300s)
    // If the remaining time is greater than 300s, set it to the remaining duration.
    const duration = Math.max(300, remaining);
    setTotalDuration(duration);

    const interval = setInterval(() => {
      const currentRemaining = Math.max(0, Math.ceil((expiryTime - Date.now()) / 1000));
      setTimeLeft(currentRemaining);

      if (currentRemaining <= 0) {
        clearInterval(interval);
        if (onExpire) onExpire();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  if (timeLeft <= 0) {
    return (
      <span className="text-[11px] font-bold uppercase tracking-widest text-rose-500">
        Expired
      </span>
    );
  }

  // Circular progress calculations
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const strokeDashoffset = circumference - (timeLeft / totalDuration) * circumference;

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="inline-flex items-center gap-3">
      {/* SVG Circle Timer */}
      <div className="relative" style={{ width: size, height: size }}>
        <svg className="w-full h-full transform -rotate-90" viewBox={`0 0 ${size} ${size}`}>
          {/* Background Track */}
          <circle
            className="text-neutral-200"
            strokeWidth={strokeWidth}
            stroke="currentColor"
            fill="transparent"
            r={radius}
            cx={size / 2}
            cy={size / 2}
          />
          {/* Animated Progress Bar */}
          <motion.circle
            className="text-neutral-900"
            strokeWidth={strokeWidth}
            stroke="currentColor"
            fill="transparent"
            r={radius}
            cx={size / 2}
            cy={size / 2}
            strokeDasharray={circumference}
            animate={{ strokeDashoffset }}
            transition={{ duration: 1, ease: 'linear' }}
          />
        </svg>
        {/* Inner Centered Text */}
        <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-bold text-neutral-800">
          {timeLeft}s
        </div>
      </div>

      {/* Expiry Text Summary */}
      <div className="flex flex-col text-left">
        <span className="text-[10px] font-bold tracking-widest text-neutral-400 uppercase leading-none mb-1">
          Hold Expiry
        </span>
        <span className="text-[13px] font-mono font-bold text-neutral-800 leading-none">
          {formatTime(timeLeft)}
        </span>
      </div>
    </div>
  );
}
