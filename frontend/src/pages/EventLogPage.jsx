import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import StatusBadge from '../components/StatusBadge';
import AnimatedModal from '../components/AnimatedModal';

// Event types constants
const EVENT_TYPES = [
  'SLOTS_RESERVED',
  'PAYMENT_INITIATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_FAILED',
  'SLOTS_RELEASED',
  'BOOKING_CONFIRMED',
  'BOOKING_CANCELLED'
];

// Initial state matching backend bookingAggregate.js
const initialState = {
  status: 'none',
  courtId: null,
  userId: null,
  bookingDate: null,
  startHour: null,
  durationHours: 0,
  totalAmount: 0,
  version: 0
};

// Pure reducer matching backend applyEvent
function applyEvent(currentState, event) {
  const nextState = { ...currentState };
  const payload = event.payload || {};

  switch (event.event_type) {
    case 'SLOTS_RESERVED':
      nextState.status = 'reserved';
      nextState.courtId = payload.courtId;
      nextState.userId = payload.userId;
      nextState.bookingDate = payload.bookingDate;
      nextState.startHour = payload.startHour;
      nextState.durationHours = payload.durationHours;
      nextState.totalAmount = parseFloat(payload.totalAmount || 0);
      break;
    case 'PAYMENT_INITIATED':
      nextState.status = 'payment_pending';
      break;
    case 'PAYMENT_CONFIRMED':
      nextState.status = 'confirmed';
      break;
    case 'PAYMENT_FAILED':
      nextState.status = 'payment_failed';
      break;
    case 'SLOTS_RELEASED':
      nextState.status = 'released';
      break;
    case 'BOOKING_CONFIRMED':
      nextState.status = 'booking_confirmed';
      break;
    case 'BOOKING_CANCELLED':
      nextState.status = 'cancelled';
      break;
    default:
      break;
  }

  nextState.version = event.version;
  return nextState;
}

// Convert event type to StatusBadge status equivalent
function getStatusEquivalent(eventType) {
  switch (eventType) {
    case 'SLOTS_RESERVED':
      return 'reserved';
    case 'PAYMENT_INITIATED':
      return 'payment_pending';
    case 'PAYMENT_CONFIRMED':
      return 'confirmed';
    case 'PAYMENT_FAILED':
      return 'payment_failed';
    case 'SLOTS_RELEASED':
      return 'released';
    case 'BOOKING_CONFIRMED':
      return 'booking_confirmed';
    case 'BOOKING_CANCELLED':
      return 'cancelled';
    default:
      return eventType.toLowerCase();
  }
}

// Helper for relative timestamps
function formatRelativeTime(dateString) {
  const diff = Date.now() - new Date(dateString).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return new Date(dateString).toLocaleDateString();
}

export default function EventLogPage({ events }) {
  const { fetchWithAuth, isAdmin } = useAuth();
  const { addToast } = useToast();
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

  const [streamsList, setStreamsList] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [courts, setCourts] = useState([]);

  // Error toast tracking ref to prevent toast spamming
  const hasErrorToastShownRef = useRef(false);

  // Filters
  const [eventTypeFilter, setEventTypeFilter] = useState('ALL');
  const [streamIdFilter, setStreamIdFilter] = useState('');
  
  // Pagination
  const [offset, setOffset] = useState(0);
  const limit = 10; // 10 stream cards per page is clean

  // Nested expansion states
  const [expandedStreams, setExpandedStreams] = useState({}); // streamId -> bool
  const [expandedEvents, setExpandedEvents] = useState({}); // eventId -> bool

  // Replay Modal State
  const [replayStreamId, setReplayStreamId] = useState(null);
  const [replayEvents, setReplayEvents] = useState([]);
  const [replayStep, setReplayStep] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [loadingReplay, setLoadingReplay] = useState(false);

  // Fetch court mapping list
  useEffect(() => {
    fetchWithAuth(`${API_URL}/api/courts`)
      .then((res) => {
        if (res.ok) return res.json();
        return [];
      })
      .then((data) => setCourts(data))
      .catch((err) => console.error('Error fetching courts:', err));
  }, []);

  const getCourtName = (courtId) => {
    if (!courtId) return 'Unknown Court';
    const court = courts.find(c => c.id === courtId);
    return court ? court.name : `Court (${courtId.substring(0, 8)})`;
  };

  // Fetch paginated grouped streams from backend
  const fetchStreams = async (currentOffset = offset) => {
    setLoading(true);
    try {
      let query = `${API_URL}/api/events?limit=${limit}&offset=${currentOffset}`;
      if (eventTypeFilter !== 'ALL') query += `&eventType=${eventTypeFilter}`;
      if (streamIdFilter.trim() !== '') query += `&streamId=${streamIdFilter.trim()}`;

      const res = await fetchWithAuth(query);
      if (!res.ok) throw new Error('Failed to load event log');
      const data = await res.json();
      
      setStreamsList(data.streams || []);
      setTotalCount(data.totalCount || 0);
      hasErrorToastShownRef.current = false;
    } catch (err) {
      console.error(err);
      if (!hasErrorToastShownRef.current) {
        addToast(err.message || 'Failed to load event log', 'error');
        hasErrorToastShownRef.current = true;
      }
    } finally {
      setLoading(false);
    }
  };

  // Trigger fetch when filters change (deduplicated with offset changes)
  useEffect(() => {
    if (offset !== 0) {
      setOffset(0);
    } else {
      fetchStreams(0);
    }
  }, [eventTypeFilter, streamIdFilter]);

  // Trigger fetch when offset changes
  useEffect(() => {
    fetchStreams(offset);
  }, [offset]);

  // Handle incoming live websocket events
  useEffect(() => {
    if (!events || events.length === 0) return;
    const latest = events[0];

    // Filter validation
    if (eventTypeFilter !== 'ALL' && latest.eventType !== eventTypeFilter) return;
    if (streamIdFilter.trim() !== '' && latest.streamId !== streamIdFilter.trim()) return;

    // Convert to row structure
    const mappedEvent = {
      id: latest.id || Math.random().toString(),
      stream_id: latest.streamId,
      version: latest.version || 1,
      event_type: latest.eventType,
      payload: latest.payload || {},
      created_at: latest.timestamp || new Date().toISOString()
    };

    setStreamsList((prev) => {
      const matchIndex = prev.findIndex(s => s.streamId === latest.streamId);
      
      if (matchIndex !== -1) {
        // Stream card already exists: update its nested event log list
        const updated = [...prev];
        const stream = { ...updated[matchIndex] };
        
        // Prevent duplicate events
        if (stream.events.some(e => e.id === mappedEvent.id || e.version === mappedEvent.version)) {
          return prev;
        }

        stream.events = [...stream.events, mappedEvent].sort((a, b) => a.version - b.version);
        stream.latestEvent = mappedEvent;

        if (latest.eventType === 'SLOTS_RESERVED') {
          stream.bookingDetails = {
            courtId: latest.payload.courtId,
            bookingDate: latest.payload.bookingDate,
            startHour: latest.payload.startHour,
            durationHours: latest.payload.durationHours,
            totalAmount: latest.payload.totalAmount
          };
        }

        updated[matchIndex] = stream;
        return updated;
      } else {
        // Prepend new stream card
        const newStream = {
          streamId: latest.streamId,
          userName: null,
          userEmail: null,
          events: [mappedEvent],
          latestEvent: mappedEvent,
          bookingDetails: latest.eventType === 'SLOTS_RESERVED' ? {
            courtId: latest.payload.courtId,
            bookingDate: latest.payload.bookingDate,
            startHour: latest.payload.startHour,
            durationHours: latest.payload.durationHours,
            totalAmount: latest.payload.totalAmount
          } : null
        };
        const next = [newStream, ...prev];
        if (next.length > limit) {
          next.pop();
        }
        setTotalCount(c => c + 1);
        return next;
      }
    });
  }, [events, eventTypeFilter, streamIdFilter]);

  // Load stream for replay modal
  const openReplay = async (streamId) => {
    console.log('[EventLogPage] Fetching replay streamId:', streamId);
    setReplayStreamId(streamId);
    setLoadingReplay(true);
    setReplayStep(0);
    setReplayPlaying(false);
    
    try {
      const res = await fetchWithAuth(`${API_URL}/api/events/streams/${streamId}`);
      if (!res.ok) throw new Error('Failed to load stream details');
      const data = await res.json();
      setReplayEvents(data);
      addToast(`Replay stream ${streamId.substring(0, 8)} loaded!`, 'success');
    } catch (err) {
      console.error(err);
      addToast(err.message, 'error');
      setReplayStreamId(null);
    } finally {
      setLoadingReplay(false);
    }
  };

  // Autoplay effect
  useEffect(() => {
    let timer;
    if (replayPlaying && replayEvents.length > 0) {
      timer = setInterval(() => {
        setReplayStep((prev) => {
          if (prev < replayEvents.length - 1) {
            return prev + 1;
          } else {
            setReplayPlaying(false);
            addToast('Replay finished!', 'success');
            return prev;
          }
        });
      }, 800);
    }
    return () => clearInterval(timer);
  }, [replayPlaying, replayEvents.length]);

  // Compute state at current step
  const getReplayState = () => {
    let state = { ...initialState };
    if (replayEvents.length === 0) return state;
    for (let i = 0; i <= replayStep; i++) {
      state = applyEvent(state, replayEvents[i]);
    }
    return state;
  };

  const currentReplayState = getReplayState();
  const activeReplayEvent = replayEvents[replayStep];

  // Clipboard copy helper
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    addToast('Copied to clipboard!', 'success');
  };

  const toggleStreamExpand = (id) => {
    setExpandedStreams(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleEventExpand = (id) => {
    setExpandedEvents(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="relative min-h-[90vh] bg-[#fafaf9] py-12 px-6 sm:px-8 max-w-7xl mx-auto flex flex-col">
      {/* Decorative Dotted Grid */}
      <div className="absolute inset-0 bg-dotted-grid opacity-20 pointer-events-none" />

      {/* Page Header */}
      <div className="relative z-10 mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-neutral-200/80 pb-6">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 mb-1.5 block">
            Event Store Explorer
          </span>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-neutral-900 leading-none">
            Audit <span className="font-serif italic font-normal text-neutral-700">Event Stream</span>
          </h1>
        </div>
        <p className="text-xs text-neutral-400 font-mono tracking-wide max-w-md md:text-right leading-relaxed">
          Stream-grouped transaction store logs. Replaying immutable event states resolves aggregate histories dynamically on demand.
        </p>
      </div>

      {/* Filters bar */}
      <div className="relative z-10 bg-white border border-neutral-200 rounded-2xl p-5 shadow-sm mb-8 flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto items-center">
          {/* Event Type Filter */}
          <div className="w-full sm:w-56">
            <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-1.5 font-sans">
              Filter Event Type
            </label>
            <select
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-neutral-200 text-xs font-semibold text-neutral-700 focus:outline-none focus:border-neutral-950 bg-neutral-50"
            >
              <option value="ALL">All Event Types</option>
              {EVENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>

          {/* Stream ID Filter */}
          <div className="w-full sm:w-80">
            <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-1.5 font-sans">
              Filter Stream UUID
            </label>
            <div className="relative">
              <input
                type="text"
                placeholder="Exact stream ID..."
                value={streamIdFilter}
                onChange={(e) => setStreamIdFilter(e.target.value)}
                className="w-full h-10 px-3 pr-8 rounded-lg border border-neutral-200 text-xs font-mono text-neutral-700 focus:outline-none focus:border-neutral-950 bg-neutral-50"
              />
              {streamIdFilter && (
                <button
                  onClick={() => setStreamIdFilter('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-900 text-xs font-bold font-sans"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Live sync badge */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-100 bg-emerald-50/50 text-[10px] font-bold tracking-wider uppercase text-emerald-700">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
          <span>Real-time Streams Grouped</span>
        </div>
      </div>

      {/* Main List */}
      <div className="relative z-10 flex-grow">
        {loading && streamsList.length === 0 ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-28 bg-white rounded-2xl animate-pulse border border-neutral-200/50" />
            ))}
          </div>
        ) : streamsList.length === 0 ? (
          <div className="bg-white border border-neutral-200 rounded-2xl p-16 text-center shadow-sm">
            <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 mb-2 leading-none block">
              No Streams Found
            </span>
            <h3 className="font-serif italic text-2xl text-neutral-950 mb-2">
              Clean Stream Store
            </h3>
            <p className="text-sm font-sans text-neutral-400 max-w-sm mx-auto leading-relaxed">
              No transactions logs matching the filter settings are registered under your account.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <AnimatePresence initial={false}>
              {streamsList.map((stream) => {
                const isStreamExpanded = !!expandedStreams[stream.streamId];
                const latestEvt = stream.latestEvent || stream.events[stream.events.length - 1];
                const details = stream.bookingDetails;
                
                return (
                  <motion.div
                    key={stream.streamId}
                    layoutId={`stream-card-${stream.streamId}`}
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white border border-neutral-200/80 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 overflow-hidden"
                  >
                    {/* Stream Card Header */}
                    <div className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-neutral-100 bg-[#fafaf9]/40">
                      <div>
                        {/* Court Name / Booking Details Info */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <h4 className="font-serif italic text-lg text-neutral-950">
                            {details ? getCourtName(details.courtId) : 'Unknown Court'}
                          </h4>
                          {details && (
                            <span className="text-xs text-neutral-400 font-sans">
                              — {details.bookingDate} @ {details.startHour}:00 ({details.durationHours} hrs)
                            </span>
                          )}
                        </div>

                        {/* Admin Specific Identity Tag */}
                        {isAdmin && stream.userName && (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-100 block w-fit mb-2">
                            Booked by: {stream.userName} ({stream.userEmail})
                          </span>
                        )}

                        {/* Stream UUID info */}
                        <div className="flex items-center gap-1.5 text-xs text-neutral-400 font-mono">
                          <span>stream:</span>
                          <button
                            onClick={() => copyToClipboard(stream.streamId)}
                            className="hover:text-neutral-900 transition-colors underline decoration-dotted font-semibold cursor-pointer"
                            title="Click to copy stream ID"
                          >
                            {stream.streamId}
                          </button>
                        </div>
                      </div>

                      {/* Status / Quick Replay triggers */}
                      <div className="flex items-center gap-3 justify-between md:justify-end">
                        <div className="flex items-center gap-3">
                          <StatusBadge status={getStatusEquivalent(latestEvt?.event_type || 'none')} />
                          <span className="text-xs text-neutral-400 font-medium font-sans">
                            {latestEvt ? formatRelativeTime(latestEvt.created_at) : ''}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => openReplay(stream.streamId)}
                            className="h-8 px-3 rounded-lg bg-neutral-900 hover:bg-neutral-850 text-white text-[11px] font-bold uppercase tracking-wider transition-all font-sans shadow-sm cursor-pointer"
                          >
                            Replay Stream
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Version History Toggle */}
                    <div className="px-5 py-3 border-b border-neutral-100 flex items-center justify-between text-xs bg-neutral-50/20">
                      <button
                        onClick={() => toggleStreamExpand(stream.streamId)}
                        className="text-neutral-500 hover:text-neutral-950 font-bold uppercase tracking-wider text-[10px] flex items-center gap-1 cursor-pointer"
                      >
                        {isStreamExpanded ? 'Hide' : 'Show'} Version History ({stream.events.length} events) {isStreamExpanded ? '▴' : '▾'}
                      </button>
                      <span className="text-[10px] text-neutral-400 font-mono">
                        versions: v1 - v{stream.events.length}
                      </span>
                    </div>

                    {/* Expandable Version Timeline */}
                    <AnimatePresence>
                      {isStreamExpanded && (
                        <motion.div
                          initial={{ height: 0 }}
                          animate={{ height: 'auto' }}
                          exit={{ height: 0 }}
                          transition={{ duration: 0.35 }}
                          className="border-t border-neutral-100 bg-neutral-50/30 p-5 space-y-4"
                        >
                          <div className="relative pl-6 border-l-2 border-neutral-200 space-y-5">
                            {stream.events.map((evt) => {
                              const isEvtExpanded = !!expandedEvents[evt.id];
                              
                              return (
                                <div key={evt.id} className="relative">
                                  {/* Timeline bullet dot */}
                                  <div className="absolute -left-[31px] top-1 w-2.5 h-2.5 rounded-full border-2 border-neutral-200 bg-white" />
                                  
                                  {/* Inner version card */}
                                  <div className="bg-white border border-neutral-200/60 p-3 rounded-xl shadow-xs">
                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                      <div className="flex items-center gap-2">
                                        <span className="px-1.5 py-0.5 rounded bg-neutral-100 border border-neutral-200 text-[9px] font-mono font-bold text-neutral-600">
                                          v{evt.version}
                                        </span>
                                        <StatusBadge status={getStatusEquivalent(evt.event_type)} />
                                        <span className="text-[10px] text-neutral-400 font-mono">
                                          id: {evt.id.substring(0, 8)}...
                                        </span>
                                      </div>

                                      <div className="flex items-center gap-3">
                                        <span className="text-[11px] text-neutral-400">
                                          {new Date(evt.created_at).toLocaleTimeString()}
                                        </span>
                                        <button
                                          onClick={() => toggleEventExpand(evt.id)}
                                          className="text-[10px] font-bold text-neutral-600 hover:text-neutral-900 border border-neutral-200 rounded px-2 py-0.5 hover:bg-neutral-50 cursor-pointer"
                                        >
                                          {isEvtExpanded ? 'Hide Payload' : 'Show Payload'}
                                        </button>
                                      </div>
                                    </div>

                                    {/* Nested JSON payload view */}
                                    <AnimatePresence>
                                      {isEvtExpanded && (
                                        <motion.div
                                          initial={{ height: 0, opacity: 0 }}
                                          animate={{ height: 'auto', opacity: 1 }}
                                          exit={{ height: 0, opacity: 0 }}
                                          className="mt-2 pt-2 border-t border-neutral-100 overflow-hidden"
                                        >
                                          {/* Diagnostic Log for payloads */}
                                          {(() => {
                                            console.log('[EventLogPage] Raw Event Object displayed in payload section:', evt);
                                            return null;
                                          })()}
                                          <pre className="text-[10px] font-mono text-neutral-700 bg-neutral-50 p-3 border border-neutral-200 rounded-lg max-h-56 overflow-y-auto leading-relaxed shadow-inner">
                                            {JSON.stringify(evt.payload, null, 2)}
                                          </pre>
                                        </motion.div>
                                      )}
                                    </AnimatePresence>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Pagination Footer */}
      {totalCount > limit && (
        <div className="relative z-10 mt-10 pt-6 border-t border-neutral-200/80 flex items-center justify-between">
          <p className="text-xs text-neutral-400 font-sans tracking-wide">
            Showing <span className="font-semibold text-neutral-700">{offset + 1}</span> -{' '}
            <span className="font-semibold text-neutral-700">{Math.min(offset + limit, totalCount)}</span> of{' '}
            <span className="font-semibold text-neutral-700">{totalCount}</span> bookings
          </p>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setOffset(prev => Math.max(0, prev - limit))}
              disabled={offset === 0}
              className="h-9 px-4 rounded-xl border border-neutral-200 hover:border-neutral-900 disabled:opacity-40 text-xs font-bold uppercase tracking-wider text-neutral-700 transition-all font-sans cursor-pointer disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setOffset(prev => prev + limit)}
              disabled={offset + limit >= totalCount}
              className="h-9 px-4 rounded-xl border border-neutral-200 hover:border-neutral-900 disabled:opacity-40 text-xs font-bold uppercase tracking-wider text-neutral-700 transition-all font-sans cursor-pointer disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Replay Stream Visualizer Modal */}
      <AnimatedModal isOpen={!!replayStreamId} onClose={() => setReplayStreamId(null)}>
        {loadingReplay ? (
          <div className="p-12 text-center">
            <span className="block text-2xl font-serif italic text-neutral-900 mb-2">Loading Stream...</span>
            <p className="text-sm font-sans text-neutral-400">Fetching aggregate events from event store DB.</p>
          </div>
        ) : (
          <div className="p-6 sm:p-8 max-w-4xl w-full">
            <div className="flex justify-between items-start border-b border-neutral-100 pb-4 mb-6">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 mb-1 block">
                  Interactive Replay State
                </span>
                <h3 className="font-serif italic text-2xl text-neutral-950">
                  Aggregate Construction
                </h3>
                <p className="text-[11px] font-mono text-neutral-400 mt-1 select-all">
                  stream: {replayStreamId}
                </p>
              </div>
              <button
                onClick={() => setReplayStreamId(null)}
                className="text-neutral-400 hover:text-neutral-900 text-lg font-bold font-sans h-8 w-8 flex items-center justify-center rounded-full hover:bg-neutral-50 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Replay Layout Split */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
              {/* Left Column: Events Log Stream List */}
              <div className="md:col-span-5 space-y-3 max-h-[360px] overflow-y-auto pr-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block mb-2 font-sans">
                  Applied Event Log History
                </span>
                {replayEvents.map((evt, idx) => {
                  const isActive = idx === replayStep;
                  const isFuture = idx > replayStep;
                  
                  return (
                    <div
                      key={evt.id}
                      onClick={() => { setReplayStep(idx); setReplayPlaying(false); }}
                      className={`p-3 border rounded-xl transition-all duration-350 cursor-pointer ${
                        isActive
                          ? 'border-neutral-950 bg-neutral-950 text-white shadow-md scale-[1.02] ring-2 ring-neutral-950/20'
                          : isFuture
                          ? 'border-neutral-200 bg-neutral-50/50 text-neutral-400 opacity-60'
                          : 'border-neutral-250 bg-white text-neutral-800'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] font-mono uppercase tracking-widest opacity-80">
                          {evt.event_type.replace('_', ' ')}
                        </span>
                        <span className="text-[9px] font-mono font-bold px-1 rounded bg-black/10">
                          v{evt.version}
                        </span>
                      </div>
                      <p className="text-[9px] font-sans truncate opacity-80 leading-normal">
                        Time: {new Date(evt.created_at).toLocaleTimeString()}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* Right Column: State visualizer */}
              <div className="md:col-span-7 bg-neutral-900 border border-neutral-950 rounded-2xl p-5 sm:p-6 shadow-lg text-white relative">
                {/* Header state name */}
                <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">
                    Booking Aggregate State
                  </span>
                  <span className="font-mono text-xs text-neutral-300">
                    version: {currentReplayState.version}
                  </span>
                </div>

                {/* State Object Properties */}
                <div className="font-mono text-[11px] space-y-2">
                  <div className="flex justify-between items-center py-1 border-b border-white/5">
                    <span className="text-neutral-400">status:</span>
                    <span className={`px-2 py-0.5 rounded font-bold uppercase text-[9px] ${
                      currentReplayState.status === 'booking_confirmed' || currentReplayState.status === 'confirmed'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : currentReplayState.status === 'payment_failed'
                        ? 'bg-rose-500/20 text-rose-400'
                        : currentReplayState.status === 'none'
                        ? 'bg-neutral-800 text-neutral-400'
                        : 'bg-amber-500/20 text-amber-400'
                    }`}>
                      {currentReplayState.status}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-white/5">
                    <span className="text-neutral-400">courtId:</span>
                    <span className="text-neutral-200 select-all truncate max-w-[200px]" title={currentReplayState.courtId}>
                      {currentReplayState.courtId || 'null'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-white/5">
                    <span className="text-neutral-400">userId:</span>
                    <span className="text-neutral-200 select-all truncate max-w-[200px]" title={currentReplayState.userId}>
                      {currentReplayState.userId || 'null'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-white/5">
                    <span className="text-neutral-400">bookingDate:</span>
                    <span className="text-neutral-200 font-bold">{currentReplayState.bookingDate || 'null'}</span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-white/5">
                    <span className="text-neutral-400">startHour:</span>
                    <span className="text-neutral-200 font-bold">
                      {currentReplayState.startHour !== null ? `${currentReplayState.startHour}:00` : 'null'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-white/5">
                    <span className="text-neutral-400">durationHours:</span>
                    <span className="text-neutral-200 font-bold">{currentReplayState.durationHours} hours</span>
                  </div>
                  <div className="flex justify-between items-center py-1">
                    <span className="text-neutral-400">totalAmount:</span>
                    <span className="text-emerald-400 font-bold">
                      ₹{currentReplayState.totalAmount ? currentReplayState.totalAmount.toFixed(2) : '0.00'}
                    </span>
                  </div>
                </div>

                {/* Explainer card based on event */}
                {activeReplayEvent && (
                  <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-3 text-[11px] font-sans text-neutral-300 leading-relaxed">
                    <strong className="text-white block uppercase text-[9px] tracking-wider mb-1 font-mono">
                      Event Effect ({activeReplayEvent.event_type}):
                    </strong>
                    {activeReplayEvent.event_type === 'SLOTS_RESERVED' && (
                      <span>Locks slot <b>{activeReplayEvent.payload?.startHour}:00</b> on date <b>{activeReplayEvent.payload?.bookingDate}</b> for court <b>{activeReplayEvent.payload?.courtId?.substring(0, 8)}</b>. Acquisition hold of ₹{activeReplayEvent.payload?.totalAmount} is set.</span>
                    )}
                    {activeReplayEvent.event_type === 'PAYMENT_INITIATED' && (
                      <span>Saga process triggers payment gateway transaction redirect. status moves to <b>payment_pending</b>.</span>
                    )}
                    {activeReplayEvent.event_type === 'PAYMENT_CONFIRMED' && (
                      <span>Payment callback succeeds. Money captures successfully, status becomes <b>confirmed</b>.</span>
                    )}
                    {activeReplayEvent.event_type === 'PAYMENT_FAILED' && (
                      <span>Payment callback fails. Saga compensation sweeps to rollback locked holds, status becomes <b>payment_failed</b>.</span>
                    )}
                    {activeReplayEvent.event_type === 'SLOTS_RELEASED' && (
                      <span>Reservation hold expires or gets rolled back. Availability slots are released back to availability view.</span>
                    )}
                    {activeReplayEvent.event_type === 'BOOKING_CONFIRMED' && (
                      <span>Write projection confirms booking, saving rows in booking history. status moves to <b>booking_confirmed</b>.</span>
                    )}
                    {activeReplayEvent.event_type === 'BOOKING_CANCELLED' && (
                      <span>User cancels booking. Cancellation compensation rolls back availability slots to available.</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Slider / Controls Bar */}
            <div className="mt-8 border-t border-neutral-100 pt-6">
              {/* Progress Slider */}
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[10px] font-mono text-neutral-400 font-bold select-none">
                  Step {replayStep + 1} of {replayEvents.length}
                </span>
                <input
                  type="range"
                  min="0"
                  max={replayEvents.length - 1}
                  value={replayStep}
                  onChange={(e) => { setReplayStep(parseInt(e.target.value, 10)); setReplayPlaying(false); }}
                  className="flex-grow accent-neutral-900 cursor-pointer h-1 rounded-lg bg-neutral-200 appearance-none"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setReplayStep(0); setReplayPlaying(false); }}
                    disabled={replayStep === 0}
                    className="h-9 px-3 rounded-lg border border-neutral-200 hover:border-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed font-sans text-xs font-bold uppercase tracking-wider text-neutral-700 hover:text-neutral-900 cursor-pointer"
                  >
                    ⏮ Reset
                  </button>
                  <button
                    onClick={() => { setReplayStep(prev => Math.max(0, prev - 1)); setReplayPlaying(false); }}
                    disabled={replayStep === 0}
                    className="h-9 px-3 rounded-lg border border-neutral-200 hover:border-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed font-sans text-xs font-bold uppercase tracking-wider text-neutral-700 hover:text-neutral-900 cursor-pointer"
                  >
                    ◀ Prev
                  </button>
                  <button
                    onClick={() => setReplayPlaying(!replayPlaying)}
                    className={`h-9 px-5 rounded-lg text-white font-sans text-xs font-bold uppercase tracking-wider shadow-sm cursor-pointer ${
                      replayPlaying ? 'bg-amber-600 hover:bg-amber-550' : 'bg-neutral-900 hover:bg-neutral-850'
                    }`}
                  >
                    {replayPlaying ? '⏸ Pause' : '▶ Play Auto'}
                  </button>
                  <button
                    onClick={() => { setReplayStep(prev => Math.min(replayEvents.length - 1, prev + 1)); setReplayPlaying(false); }}
                    disabled={replayStep === replayEvents.length - 1}
                    className="h-9 px-3 rounded-lg border border-neutral-200 hover:border-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed font-sans text-xs font-bold uppercase tracking-wider text-neutral-700 hover:text-neutral-900 cursor-pointer"
                  >
                    Next ▶
                  </button>
                </div>

                <button
                  onClick={() => setReplayStep(replayEvents.length - 1)}
                  disabled={replayStep === replayEvents.length - 1}
                  className="h-9 px-3 rounded-lg border border-neutral-200 hover:border-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed font-sans text-xs font-bold uppercase tracking-wider text-neutral-700 hover:text-neutral-900 cursor-pointer"
                >
                  ⏭ Fast Forward
                </button>
              </div>
            </div>
          </div>
        )}
      </AnimatedModal>
    </div>
  );
}
