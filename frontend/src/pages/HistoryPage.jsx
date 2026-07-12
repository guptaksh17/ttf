import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '../components/Toast';
import StatusBadge from '../components/StatusBadge';
import AnimatedModal from '../components/AnimatedModal';
import { useAuth } from '../context/AuthContext';

export default function HistoryPage() {
  const { user, fetchWithAuth, isAdmin } = useAuth();
  const { addToast } = useToast();
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState(user?.id || '');
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(false);

  // Modal confirm cancellation state
  const [cancelTarget, setCancelTarget] = useState(null); // booking object
  const [cancelling, setCancelling] = useState(false);

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

  // Fetch users switcher (Admins only)
  useEffect(() => {
    if (!isAdmin) return;

    fetchWithAuth(`${API_URL}/api/users`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch users');
        return res.json();
      })
      .then((data) => {
        setUsers(data);
        if (data.length > 0) {
          setSelectedUserId(data[0].id);
        }
      })
      .catch((err) => {
        console.error(err);
        addToast('Error loading user directory.', 'error');
      });
  }, [isAdmin]);

  // Fetch bookings for selected user
  const fetchUserBookings = async (userId) => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/api/users/${userId}/bookings`);
      if (!res.ok) throw new Error('Failed to load bookings');
      const data = await res.json();
      setBookings(data);
    } catch (err) {
      console.error(err);
      addToast('Error retrieving booking history.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUserBookings(selectedUserId);
  }, [selectedUserId]);

  // Connect to the WebSocket broadcast loop to update states live
  useEffect(() => {
    const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3100';
    console.log(`[HistoryPage] Dynamic WebSocket URL target resolved to: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'EVENT') {
          const { eventType, streamId, payload } = msg;

          setBookings((prevBookings) => {
            let matched = false;
            const updated = prevBookings.map((b) => {
              if (b.stream_id === streamId) {
                matched = true;
                let nextStatus = b.status;
                if (eventType === 'SLOTS_RESERVED') nextStatus = 'reserved';
                else if (eventType === 'PAYMENT_INITIATED') nextStatus = 'payment_pending';
                else if (eventType === 'PAYMENT_CONFIRMED') nextStatus = 'confirmed';
                else if (eventType === 'BOOKING_CONFIRMED') nextStatus = 'booking_confirmed';
                else if (eventType === 'SLOTS_RELEASED') nextStatus = 'released';
                else if (eventType === 'PAYMENT_FAILED') nextStatus = 'payment_failed';
                else if (eventType === 'BOOKING_CANCELLED') nextStatus = 'cancelled';

                return { ...b, status: nextStatus };
              }
              return b;
            });

            if (matched) {
              addToast(`Booking updated live: ${eventType.replace('_', ' ')}`, 'success');
              return updated;
            }
            return prevBookings;
          });
        }
      } catch (err) {
        console.error('[History WS] Error processing stream message:', err);
      }
    };

    return () => {
      ws.close();
    };
  }, [bookings]);

  // Trigger Cancel Booking POST /api/bookings/:streamId/cancel
  const handleCancelClick = (booking) => {
    setCancelTarget(booking);
  };

  const executeCancellation = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/api/bookings/${cancelTarget.stream_id}/cancel`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Cancellation request failed');

      addToast('Cancellation request submitted successfully.', 'success');
      setCancelTarget(null);
      fetchUserBookings(selectedUserId);
    } catch (err) {
      console.error(err);
      addToast('Failed to cancel booking.', 'error');
    } finally {
      setCancelling(false);
    }
  };

  const getSportLabel = (type) => {
    switch (type) {
      case 'football_5s': return 'Football 5s';
      case 'badminton': return 'Badminton';
      case 'box_cricket': return 'Box Cricket';
      default: return type.replace('_', ' ');
    }
  };

  return (
    <div className="relative min-h-[90vh] bg-[#fafaf9] py-16 px-6 sm:px-8">
      {/* Decorative Dotted Grid */}
      <div className="absolute inset-0 bg-dotted-grid opacity-20 pointer-events-none" />

      <div className="max-w-4xl mx-auto relative z-10 space-y-12">
        {/* User Switcher Dropdown */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-200 pb-8">
          <div>
            <h1 className="text-4xl sm:text-5xl font-black tracking-tight text-neutral-900 leading-none">
              Your <span className="font-serif italic font-normal text-neutral-700">Bookings</span>
            </h1>
            <p className="text-neutral-400 text-xs font-mono uppercase mt-2 tracking-widest">
              CQRS Read-Path Demo
            </p>
          </div>

          {isAdmin && (
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold tracking-widest uppercase text-neutral-400 font-sans">
                Switch User:
              </span>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="px-4 py-2 border border-neutral-200 bg-white rounded-full text-xs font-bold tracking-widest text-neutral-700 uppercase outline-none focus:border-neutral-950 shadow-sm cursor-pointer"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Bookings List */}
        {loading ? (
          <div className="text-center py-20 text-xs font-bold uppercase tracking-widest text-neutral-400">
            Loading reservations...
          </div>
        ) : bookings.length === 0 ? (
          <div className="border border-neutral-200/80 rounded-2xl p-16 text-center bg-white shadow-xl relative overflow-hidden flex flex-col items-center">
            {/* Small dotted grid overlay for empty state */}
            <div className="absolute inset-0 bg-dotted-grid opacity-30 pointer-events-none" />
            <span className="text-3xl mb-4">📭</span>
            <h3 className="font-serif italic text-xl text-neutral-950 mb-2">
              No Bookings Found
            </h3>
            <p className="text-sm text-neutral-400 tracking-wide max-w-xs mx-auto leading-relaxed">
              This user hasn't made any turf reservations yet. Switch to the Booking tab to create one.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <AnimatePresence>
              {bookings.map((booking) => {
                const canCancel = ['reserved', 'payment_pending', 'confirmed', 'booking_confirmed'].includes(booking.status);
                
                return (
                  <motion.div
                    key={booking.stream_id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    className="bg-white border border-neutral-200/80 rounded-2xl p-6 sm:p-8 shadow-md hover:shadow-lg transition-all duration-300 flex flex-col sm:flex-row justify-between sm:items-center gap-6"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] font-bold uppercase tracking-widest bg-neutral-100 border border-neutral-200 px-2 py-0.5 rounded text-neutral-500">
                          {getSportLabel(booking.sport_type)}
                        </span>
                        <span className="text-xs font-mono text-neutral-400">
                          ID: {booking.stream_id.substring(0, 8)}...
                        </span>
                      </div>
                      
                      <h3 className="font-serif text-xl sm:text-2xl font-bold text-neutral-950">
                        {booking.court_name}
                      </h3>
                      
                      <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-xs font-medium text-neutral-500">
                        <span className="flex items-center gap-1">
                          📅 {new Date(booking.booking_date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                        <span className="w-1.5 h-1.5 rounded-full bg-neutral-200 hidden sm:inline" />
                        <span className="flex items-center gap-1 font-mono">
                          ⏰ {booking.start_hour}:00 - {booking.start_hour + 2}:00
                        </span>
                      </div>
                    </div>

                    <div className="flex sm:flex-col justify-between items-end sm:text-right gap-4 border-t sm:border-t-0 pt-4 sm:pt-0 border-neutral-100">
                      <div>
                        <span className="text-xs font-medium text-neutral-400 block sm:mb-1">
                          Total Paid
                        </span>
                        <span className="text-xl font-mono font-bold text-neutral-950">
                          ₹{parseInt(booking.total_amount || 0, 10)}
                        </span>
                      </div>

                      <div className="flex items-center gap-3">
                        <StatusBadge status={booking.status} />

                        {canCancel && (
                          <motion.button
                            whileTap={{ scale: 0.96 }}
                            onClick={() => handleCancelClick(booking)}
                            className="px-4 py-2 border border-rose-200 hover:border-rose-400 bg-rose-50/50 hover:bg-rose-50 text-rose-600 rounded-full text-[10px] font-bold tracking-widest uppercase transition-colors"
                          >
                            Cancel
                          </motion.button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      <AnimatedModal isOpen={!!cancelTarget} onClose={() => setCancelTarget(null)}>
        {cancelTarget && (
          <div className="text-center space-y-6">
            <span className="text-[11px] font-bold uppercase tracking-widest text-rose-500 mb-2 block leading-none">
              Confirm Cancellation
            </span>
            <h3 className="font-serif italic text-3xl text-neutral-950">
              Are you sure?
            </h3>
            <p className="text-sm font-sans text-neutral-500 tracking-wide leading-relaxed max-w-sm mx-auto">
              You are about to cancel the reservation for **{cancelTarget.court_name}** on **{cancelTarget.booking_date}** at **{cancelTarget.start_hour}:00**. 
              This action appends a cancellation event to the event store and releases the slot.
            </p>

            <div className="flex gap-3 pt-4">
              <button
                onClick={() => setCancelTarget(null)}
                disabled={cancelling}
                className="flex-1 py-3.5 border border-neutral-200 text-neutral-600 font-bold uppercase tracking-wider text-xs rounded-full hover:bg-neutral-50"
              >
                No, Keep
              </button>
              <button
                onClick={executeCancellation}
                disabled={cancelling}
                className="flex-1 py-3.5 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow-lg hover:bg-neutral-900"
              >
                {cancelling ? 'Cancelling...' : 'Yes, Cancel'}
              </button>
            </div>
          </div>
        )}
      </AnimatedModal>
    </div>
  );
}
