import { useState, useEffect, useRef } from 'react';

export function useEventStream() {
  const [events, setEvents] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // connecting, connected, disconnected
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const backoffRef = useRef(1000); // Backoff starts at 1 second

  const connect = () => {
    // Determine WebSocket URL dynamically based on current page host
    const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3100';
    console.log(`[useEventStream] Dynamic WebSocket URL target resolved to: ${wsUrl}`);
    setConnectionStatus('connecting');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[useEventStream] WebSocket connected successfully.');
      setConnectionStatus('connected');
      backoffRef.current = 1000; // Reset backoff on successful connection
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('[useEventStream] Received message:', msg);
        if (msg.type === 'EVENT') {
          setEvents((prev) => [msg, ...prev].slice(0, 100)); // Limit to last 100 events
        }
      } catch (err) {
        console.error('[useEventStream] Failed to parse message:', err);
      }
    };

    ws.onclose = () => {
      console.warn('[useEventStream] WebSocket connection closed.');
      setConnectionStatus('disconnected');
      
      // Auto-reconnect with exponential backoff
      const nextDelay = Math.min(backoffRef.current * 1.5, 30000);
      backoffRef.current = nextDelay;
      console.log(`[useEventStream] Reconnecting in ${(nextDelay / 1000).toFixed(1)}s...`);
      
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, nextDelay);
    };

    ws.onerror = (err) => {
      console.error('[useEventStream] WebSocket error:', err);
      ws.close();
    };
  };

  useEffect(() => {
    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect loop on unmount
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  return { events, connectionStatus };
}
