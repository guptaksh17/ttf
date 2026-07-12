import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '../components/Toast';
import AnimatedModal from '../components/AnimatedModal';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line } from 'recharts';
import { useAuth } from '../context/AuthContext';

export default function AdminPage() {
  const { addToast } = useToast();
  const { token, fetchWithAuth } = useAuth();
  
  // Database Stats
  const [stats, setStats] = useState({
    totalBookings: 0,
    totalRevenue: 0.0,
    activeReservations: 0,
    cancellationRate: 0.0
  });

  // Recharts live timeline data
  const [timelineData, setTimelineData] = useState([]);
  const [concurrencyConflicts, setConcurrencyConflicts] = useState(0);

  // SSE Rebuild projections state
  const [rebuildModalOpen, setRebuildModalOpen] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState(null); // { current, total }
  const [rebuildStatus, setRebuildStatus] = useState('idle'); // idle, running, complete, error
  const [rebuildMessage, setRebuildMessage] = useState('');
  
  const lastMetricsValueRef = useRef(null);

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

  // 1. Fetch direct aggregate DB Stats on mount
  const fetchDbStats = () => {
    fetchWithAuth(`${API_URL}/api/admin/stats`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load admin stats');
        return res.json();
      })
      .then((data) => {
        setStats(data);
      })
      .catch((err) => {
        console.error(err);
        addToast('Error loading facility stats.', 'error');
      });
  };

  useEffect(() => {
    fetchDbStats();
  }, []);

  // 2. Poll metrics-snapshot every 3 seconds for charts
  useEffect(() => {
    const fetchMetrics = () => {
      fetchWithAuth(`${API_URL}/api/admin/metrics-snapshot`)
        .then((res) => {
          if (!res.ok) throw new Error('Failed to load metrics snapshot');
          return res.json();
        })
        .then((data) => {
          // Set conflicts count
          setConcurrencyConflicts(data.concurrencyConflictsTotal);

          // Calculate request rate (commands/sec) based on difference with last value
          let rate = 0;
          if (lastMetricsValueRef.current !== null) {
            const diff = data.commandRequestsTotal - lastMetricsValueRef.current.total;
            const timeDiffSeconds = 3.0; // Polling interval
            rate = parseFloat((diff / timeDiffSeconds).toFixed(2));
          }
          lastMetricsValueRef.current = { total: data.commandRequestsTotal, time: Date.now() };

          // Append to rolling data window (keep last 20 points)
          setTimelineData((prev) => {
            const timeStr = new Date(data.timestamp).toLocaleTimeString(undefined, { hour12: false });
            const next = [
              ...prev,
              {
                time: timeStr,
                rate: Math.max(0, rate),
                availabilityLag: data.projectionLagSeconds.availability * 1000, // in ms
                historyLag: data.projectionLagSeconds.booking_history * 1000 // in ms
              }
            ];
            return next.slice(-20);
          });
        })
        .catch((err) => {
          console.error('[Admin Metrics] Error fetching metrics:', err);
        });
    };

    // Initial load
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 3000);

    return () => clearInterval(interval);
  }, []);

  // 3. Trigger SSE Rebuild projections
  const handleRebuildClick = () => {
    setRebuildModalOpen(true);
    setRebuildStatus('running');
    setRebuildProgress({ current: 0, total: 100 });
    setRebuildMessage('Establishing streaming channel to PG log replayer...');

    const eventSource = new EventSource(`${API_URL}/api/admin/rebuild-projections`, {
      // SSE default properties
    });

    // Custom POST/SSE handle since EventSource does not support method: 'POST' directly.
    // However, our Express route is POST /api/admin/rebuild-projections.
    // Wait! EventSource ONLY supports GET requests!
    // Ah! Let's check: did we define POST or GET in server.js?
    // In server.js we defined:
    // `app.post('/api/admin/rebuild-projections', ...)`
    // Wait! Since standard EventSource only triggers GET requests, let's update server.js to support GET or POST, or let's use GET for the SSE stream endpoint!
    // Yes! Let's allow GET or POST. Let's make sure we support GET `/api/admin/rebuild-projections` in server.js as well, since that works natively with new EventSource(url)!
    // Let's modify server.js to support GET for the rebuild route to be fully compatible with browser EventSource!
    // This is an extremely critical detail! EventSource in browsers CANNOT make POST requests easily without custom headers/polyfills. So using GET is standard and correct for SSE streams!
    // Let's update server.js to listen on GET `/api/admin/rebuild-projections`.
  };

  const startSSEStream = () => {
    setRebuildModalOpen(true);
    setRebuildStatus('running');
    setRebuildProgress({ current: 0, total: 0 });
    setRebuildMessage('Opening event stream...');

    const es = new EventSource(`${API_URL}/api/admin/rebuild-projections?token=${token}`);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress') {
          setRebuildProgress({ current: data.current, total: data.total });
          setRebuildMessage(`Replaying event log: replayed ${data.current} of ${data.total} events...`);
        } else if (data.type === 'complete') {
          setRebuildStatus('complete');
          setRebuildMessage('Rebuild complete. 100% of read models successfully reconstructed!');
          addToast('Database projections rebuilt successfully!', 'success');
          es.close();
          fetchDbStats(); // Refresh stats
        } else if (data.type === 'error') {
          setRebuildStatus('error');
          setRebuildMessage(`Rebuild failed: ${data.message}`);
          es.close();
        }
      } catch (err) {
        console.error(err);
      }
    };

    es.onerror = (err) => {
      console.error(err);
      setRebuildStatus('error');
      setRebuildMessage('Connection lost or failed to parse SSE stream.');
      es.close();
    };
  };

  // Custom Recharts tooltip styling
  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white/95 backdrop-blur-sm border border-neutral-200 p-3 rounded-lg shadow-md text-xs font-sans">
          <p className="font-bold text-neutral-900 mb-1">{label}</p>
          {payload.map((p, i) => (
            <p key={i} style={{ color: p.color }} className="font-mono font-medium">
              {p.name}: {p.value.toFixed(1)} {p.unit || ''}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="relative min-h-[90vh] bg-[#fafaf9] py-16 px-6 sm:px-8">
      {/* Dotted Grid Background */}
      <div className="absolute inset-0 bg-dotted-grid opacity-20 pointer-events-none" />

      <div className="max-w-7xl mx-auto relative z-10 space-y-16">
        
        {/* Header Block */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 border-b border-neutral-200 pb-8">
          <div>
            <h1 className="text-4xl sm:text-5xl font-black tracking-tight text-neutral-900 leading-none">
              Facility <span className="font-serif italic font-normal text-neutral-700">Metrics</span>
            </h1>
            <p className="text-neutral-400 text-xs font-mono uppercase mt-2 tracking-widest">
              Live CQRS & Outbox Analytics Dashboard
            </p>
          </div>

          <div className="flex gap-4">
            <Link
              to="/admin/manage"
              className="px-6 py-3 border border-neutral-200 hover:border-neutral-450 bg-white hover:bg-neutral-50 text-neutral-800 font-bold uppercase tracking-wider text-xs rounded-full shadow-md transition-all select-none flex items-center"
            >
              ⚙ Manage Facilities
            </Link>
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={startSSEStream}
              className="px-6 py-3 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow-lg hover:bg-neutral-850 hover:shadow-xl transition-all"
            >
              🛠 Rebuild Projections
            </motion.button>
          </div>
        </div>

        {/* Database Stats Cards Row */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
          <div className="bg-white border border-neutral-200/80 rounded-2xl p-6 shadow-md hover:shadow-lg transition-shadow">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-2 leading-none">
              Total Revenue
            </span>
            <span className="text-3xl font-mono font-black text-neutral-950 block">
              ₹{stats.totalRevenue.toLocaleString()}
            </span>
          </div>

          <div className="bg-white border border-neutral-200/80 rounded-2xl p-6 shadow-md hover:shadow-lg transition-shadow">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-2 leading-none">
              Confirmed Bookings
            </span>
            <span className="text-3xl font-mono font-black text-neutral-950 block">
              {stats.totalBookings}
            </span>
          </div>

          <div className="bg-white border border-neutral-200/80 rounded-2xl p-6 shadow-md hover:shadow-lg transition-shadow">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-2 leading-none">
              Active Holds
            </span>
            <span className="text-3xl font-mono font-black text-neutral-950 block">
              {stats.activeReservations}
            </span>
          </div>

          <div className="bg-white border border-neutral-200/80 rounded-2xl p-6 shadow-md hover:shadow-lg transition-shadow">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-2 leading-none">
              Cancellation Rate
            </span>
            <span className="text-3xl font-mono font-black text-neutral-950 block">
              {(stats.cancellationRate * 100).toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Live Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          
          {/* Chart 1: Throughput */}
          <div className="bg-white border border-neutral-200/80 rounded-2xl p-6 sm:p-8 shadow-xl space-y-4">
            <div>
              <h3 className="font-serif italic text-2xl text-neutral-950">
                Write Throughput
              </h3>
              <p className="text-[11px] font-sans text-neutral-400 uppercase font-semibold tracking-wider mt-1">
                Command Execution Rate (APIs/sec)
              </p>
            </div>

            <div className="h-[250px] w-full pt-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timelineData}>
                  <defs>
                    <linearGradient id="colorRate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#171717" stopOpacity={0.15}/>
                      <stop offset="95%" stopColor="#171717" stopOpacity={0.01}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f5f5f5" />
                  <XAxis dataKey="time" stroke="#a3a3a3" fontSize={9} fontFamily="monospace" />
                  <YAxis stroke="#a3a3a3" fontSize={9} fontFamily="monospace" />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="rate" name="Command Rate" unit="cmd/s" stroke="#171717" strokeWidth={2} fillOpacity={1} fill="url(#colorRate)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] font-serif italic text-neutral-400 text-left pt-2 leading-relaxed">
              * Counts successful slot reservations, payments, and cancellations entering the Postgres event store.
            </p>
          </div>

          {/* Chart 2: Projection Lag */}
          <div className="bg-white border border-neutral-200/80 rounded-2xl p-6 sm:p-8 shadow-xl space-y-4">
            <div>
              <h3 className="font-serif italic text-2xl text-neutral-950">
                Projection Sync Lag
              </h3>
              <p className="text-[11px] font-sans text-neutral-400 uppercase font-semibold tracking-wider mt-1">
                Time between a booking command succeeding and read view updates
              </p>
            </div>

            <div className="h-[250px] w-full pt-4">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timelineData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f5f5f5" />
                  <XAxis dataKey="time" stroke="#a3a3a3" fontSize={9} fontFamily="monospace" />
                  <YAxis stroke="#a3a3a3" fontSize={9} fontFamily="monospace" />
                  <Tooltip content={<CustomTooltip />} />
                  <Line type="monotone" dataKey="availabilityLag" name="Availability Lag" unit="ms" stroke="#d97706" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  <Line type="monotone" dataKey="historyLag" name="History Lag" unit="ms" stroke="#059669" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] font-serif italic text-neutral-400 text-left pt-2 leading-relaxed">
              * Directly monitors the eventual-consistency processing time of background projection streams. Typically remains under 100ms.
            </p>
          </div>
        </div>

        {/* Counter and Notes */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-12">
          {/* Concurrency Counter */}
          <div className="bg-white border border-neutral-200/80 rounded-2xl p-6 sm:p-8 shadow-md flex flex-col justify-center items-center text-center">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-2 leading-none">
              Concurrency Conflicts
            </span>
            <span className="text-5xl font-mono font-black text-amber-600 block my-2">
              {concurrencyConflicts}
            </span>
            <p className="text-xs text-neutral-400 max-w-[200px] mt-2">
              Ticks up dynamically when simultaneous overlapping requests collide on the same slots.
            </p>
          </div>

          {/* Architecture Caption Box */}
          <div className="sm:col-span-2 bg-neutral-900 text-neutral-300 rounded-2xl p-6 sm:p-8 border border-neutral-800 flex flex-col justify-center">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-3 leading-none">
              Distributed Systems Note
            </span>
            <p className="text-sm font-sans tracking-wide leading-relaxed text-neutral-300">
              TapToTurf implements **CQRS** (Command Query Responsibility Segregation) and the **Transactional Outbox pattern**. 
              Commands append atomically to an immutable PostgreSQL event log. Projections consume the events asynchronously via Redis Streams and write to optimized read views. 
              The lag chart shows this eventual consistency boundary in real-time, demonstrating distributed robustness under scale.
            </p>
          </div>
        </div>

      </div>

      {/* Projection Rebuild Progress Modal */}
      <AnimatedModal isOpen={rebuildModalOpen} onClose={() => rebuildStatus !== 'running' && setRebuildModalOpen(false)}>
        <div className="text-center space-y-6">
          <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 block leading-none mb-1">
            Projection Administration
          </span>
          <h3 className="font-serif italic text-3xl text-neutral-950">
            Replaying Event Store
          </h3>

          <div className="space-y-4 py-4">
            <p className="text-sm font-sans text-neutral-500 max-w-sm mx-auto leading-relaxed">
              {rebuildMessage}
            </p>

            {/* SSE Progress Bar */}
            {rebuildStatus === 'running' && rebuildProgress && (
              <div className="space-y-2">
                <div className="w-full h-2.5 bg-neutral-200 rounded-full overflow-hidden relative">
                  <motion.div
                    className="h-full bg-neutral-950"
                    initial={{ width: '0%' }}
                    animate={{ 
                      width: rebuildProgress.total > 0 
                        ? `${(rebuildProgress.current / rebuildProgress.total) * 100}%` 
                        : '0%' 
                    }}
                    transition={{ duration: 0.1 }}
                  />
                </div>
                <div className="flex justify-between font-mono text-[10px] text-neutral-400">
                  <span>Processed: {rebuildProgress.current}</span>
                  <span>Total Events: {rebuildProgress.total}</span>
                </div>
              </div>
            )}
          </div>

          <div className="pt-2">
            <button
              onClick={() => setRebuildModalOpen(false)}
              disabled={rebuildStatus === 'running'}
              className={`w-full py-4 font-bold uppercase tracking-wider text-xs rounded-full shadow-lg transition-colors ${
                rebuildStatus === 'running'
                  ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                  : 'bg-neutral-950 text-white hover:bg-neutral-900'
              }`}
            >
              {rebuildStatus === 'running' ? 'Streaming progress...' : 'Close Modal'}
            </button>
          </div>
        </div>
      </AnimatedModal>
    </div>
  );
}
