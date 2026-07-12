import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '../components/Toast';
import AnimatedModal from '../components/AnimatedModal';
import CountdownRing from '../components/CountdownRing';
import StatusBadge from '../components/StatusBadge';
import { useAuth } from '../context/AuthContext';

export default function BookingPage({ events, wsStatus }) {
  const { addToast } = useToast();
  const { user, fetchWithAuth } = useAuth();
  const [courts, setCourts] = useState([]);
  const [selectedCourt, setSelectedCourt] = useState(null);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  
  // Slot states map
  const [slotsAvailability, setSlotsAvailability] = useState({});
  const [loadingAvailability, setLoadingAvailability] = useState(false);
  const [loadingCourts, setLoadingCourts] = useState(true);

  // Selected slot for booking process
  const [activeSlot, setActiveSlot] = useState(null); // { startHour, status }
  const [bookingDuration, setBookingDuration] = useState(2); // 1, 2, or 3 hours
  const [bookingStep, setBookingStep] = useState(null); // 'details', 'payment', 'success', 'failed'
  const [bookingStreamId, setBookingStreamId] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [bookingAmount, setBookingAmount] = useState(0);

  // Local user reservations
  const [myReservations, setMyReservations] = useState([]);

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

  // Keep a ref of myReservations to prevent stale closures or infinite loops
  const myReservationsRef = useRef(myReservations);
  useEffect(() => {
    myReservationsRef.current = myReservations;
  }, [myReservations]);

  // Fetch reservations from server scope
  const fetchMyReservations = async () => {
    if (!user?.id) {
      setMyReservations([]);
      return;
    }
    try {
      const res = await fetchWithAuth(`${API_URL}/api/users/${user.id}/bookings`);
      if (res.ok) {
        const data = await res.json();
        const mapped = data.map((item) => {
          // Calculate hold expiry if it is a temporary hold
          const isHold = item.status === 'reserved' || item.status === 'payment_pending';
          const expiresAt = isHold
            ? new Date(new Date(item.last_updated_at).getTime() + 5 * 60 * 1000).toISOString()
            : null;

          return {
            streamId: item.stream_id,
            courtName: item.court_name,
            turfName: item.sport_type ? item.sport_type.replace('_', ' ') : 'Court Slot',
            date: item.booking_date.split('T')[0],
            time: `${item.start_hour}:00 - ${item.start_hour + item.duration_hours}:00`,
            expiresAt,
            status: item.status
          };
        });
        setMyReservations(mapped);
      }
    } catch (err) {
      console.error('[Reservations] Fetch failed:', err);
    }
  };

  // Sync bookings on mount/user changes
  useEffect(() => {
    fetchMyReservations();
    
    if (!user?.id) return;

    const handleFocus = () => {
      fetchMyReservations();
    };
    window.addEventListener('focus', handleFocus);
    const interval = setInterval(fetchMyReservations, 15000);

    return () => {
      window.removeEventListener('focus', handleFocus);
      clearInterval(interval);
    };
  }, [user?.id]);

  // Fetch court reference data
  useEffect(() => {
    setLoadingCourts(true);
    fetch(`${API_URL}/api/courts`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load courts');
        return res.json();
      })
      .then(data => {
        setCourts(data);
        if (data.length > 0) setSelectedCourt(data[0]);
      })
      .catch(err => {
        console.error(err);
        addToast('Error loading court facilities.', 'error');
      })
      .finally(() => {
        setLoadingCourts(false);
      });
  }, []);

  // Check if a range [startHour, startHour + duration] overlaps with any occupied slot or exceeds closing time (22:00)
  const isOverlapping = (startHour, duration) => {
    const endHour = startHour + duration;
    if (endHour > 22) return true;
    for (const h of hours) {
      const avail = slotsAvailability[h];
      if (avail && avail.status && avail.status !== 'released' && avail.status !== 'cancelled') {
        // Checking overlap with another booking
        if (h < endHour && h + 2 > startHour) {
          return true;
        }
      }
    }
    return false;
  };

  // Fetch availability for selected court & date
  const fetchAvailability = async () => {
    if (!selectedCourt || !selectedDate) return;
    setLoadingAvailability(true);
    try {
      const res = await fetch(`${API_URL}/api/availability?courtId=${selectedCourt.id}&date=${selectedDate}`);
      if (!res.ok) throw new Error('Failed to load availability');
      const data = await res.json();
      
      // Map slot start hour to availability record by checking overlaps
      const mapped = {};
      hours.forEach(hour => {
        const overlappingItem = data.find(item => {
          if (item.status === 'released' || item.status === 'cancelled') return false;
          const itemStart = item.start_hour;
          const itemEnd = itemStart + (item.duration_hours || 2);
          return itemStart < hour + 2 && itemEnd > hour;
        });

        if (overlappingItem) {
          mapped[hour] = {
            streamId: overlappingItem.stream_id,
            status: overlappingItem.status,
            expiresAt: overlappingItem.reservation_expires_at,
            startHour: overlappingItem.start_hour,
            durationHours: overlappingItem.duration_hours || 2
          };
        }
      });
      setSlotsAvailability(mapped);
    } catch (err) {
      console.error(err);
      addToast('Error loading availability grid.', 'error');
    } finally {
      setLoadingAvailability(false);
    }
  };

  useEffect(() => {
    fetchAvailability();
  }, [selectedCourt, selectedDate]);

  // Listen to live WebSocket events to update grid states
  useEffect(() => {
    if (events.length === 0 || !selectedCourt) return;
    const latestEvent = events[0];

    // Check if the event is relevant to current court & date selection
    const payload = latestEvent.payload;
    if (
      payload &&
      payload.courtId === selectedCourt.id &&
      payload.bookingDate === selectedDate
    ) {
      const startHour = parseInt(payload.startHour, 10);
      const streamId = latestEvent.streamId;

      console.log(`[WebSocket] Live update for slot ${startHour}:`, latestEvent.eventType);

      if (latestEvent.eventType === 'SLOTS_RESERVED') {
        addToast(`Slot ${startHour}:00 is now ON HOLD.`, 'warning');
      } else if (latestEvent.eventType === 'SLOTS_RELEASED') {
        addToast(`Slot ${startHour}:00 has been RELEASED.`, 'success');
      } else if (latestEvent.eventType === 'BOOKING_CONFIRMED') {
        addToast(`Slot ${startHour}:00 is CONFIRMED.`, 'success');
      }

      setSlotsAvailability((prev) => {
        const next = { ...prev };
        if (latestEvent.eventType === 'SLOTS_RESERVED') {
          next[startHour] = {
            streamId,
            status: 'reserved',
            expiresAt: payload.reservationExpiresAt
          };
        } else if (latestEvent.eventType === 'SLOTS_RELEASED') {
          delete next[startHour];
        } else if (latestEvent.eventType === 'PAYMENT_INITIATED') {
          if (next[startHour]) next[startHour].status = 'payment_pending';
        } else if (latestEvent.eventType === 'PAYMENT_FAILED') {
          if (next[startHour]) next[startHour].status = 'payment_failed';
        } else if (latestEvent.eventType === 'BOOKING_CONFIRMED') {
          if (next[startHour]) next[startHour].status = 'booking_confirmed';
        } else if (latestEvent.eventType === 'BOOKING_CANCELLED') {
          delete next[startHour];
        }
        return next;
      });
    }

    // Update authenticated reservations list if status changes
    setMyReservations((prev) => {
      // 1. If it's a new reservation for the current user, append it
      if (latestEvent.eventType === 'SLOTS_RESERVED' && latestEvent.payload?.userId === user?.id) {
        if (prev.some(r => r.streamId === latestEvent.streamId)) return prev;

        const courtInfo = courts.find(c => c.id === latestEvent.payload.courtId);
        const newReservation = {
          streamId: latestEvent.streamId,
          courtName: courtInfo ? courtInfo.name : 'Play Court',
          turfName: courtInfo?.sport_type ? courtInfo.sport_type.replace('_', ' ') : 'Court Slot',
          date: latestEvent.payload.bookingDate,
          time: `${latestEvent.payload.startHour}:00 - ${latestEvent.payload.startHour + latestEvent.payload.durationHours}:00`,
          expiresAt: latestEvent.payload.reservationExpiresAt,
          status: 'reserved'
        };
        return [newReservation, ...prev];
      }

      // 2. If it's a status change, update the matching local item
      let changed = false;
      const next = prev.map((res) => {
        if (res.streamId === latestEvent.streamId) {
          changed = true;
          let newStatus = res.status;
          if (latestEvent.eventType === 'PAYMENT_INITIATED') newStatus = 'payment_pending';
          else if (latestEvent.eventType === 'PAYMENT_CONFIRMED') newStatus = 'confirmed';
          else if (latestEvent.eventType === 'BOOKING_CONFIRMED') newStatus = 'booking_confirmed';
          else if (latestEvent.eventType === 'SLOTS_RELEASED') newStatus = 'released';
          else if (latestEvent.eventType === 'PAYMENT_FAILED') newStatus = 'payment_failed';
          else if (latestEvent.eventType === 'BOOKING_CANCELLED') newStatus = 'cancelled';

          return { ...res, status: newStatus };
        }
        return res;
      });

      return changed ? next : prev;
    });
  }, [events, selectedCourt, selectedDate, courts, user]);

  // Handle Slot Click
  const handleSlotClick = (hour, status) => {
    if (!selectedCourt) {
      addToast('Please select a court facility first.', 'warning');
      return;
    }

    if (status && status !== 'released' && status !== 'cancelled') {
      // Slot is occupied/reserved
      addToast(`Slot ${hour}:00 is not available.`, 'error');
      return;
    }

    setActiveSlot(hour);
    let initialDuration = 2;
    if (isOverlapping(hour, 2)) {
      initialDuration = 1;
    }
    setBookingDuration(initialDuration);
    setBookingAmount(parseFloat(selectedCourt.base_price_per_hour) * initialDuration);
    setBookingStep('details');
  };

  // Step 1: Reserve Slot POST /api/bookings/reserve
  const handleReserve = async () => {
    try {
      const res = await fetchWithAuth(`${API_URL}/api/bookings/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courtId: selectedCourt.id,
          bookingDate: selectedDate,
          startHour: activeSlot,
          durationHours: bookingDuration
        })
      });

      if (res.status === 409) {
        addToast('This slot was locked concurrently by another user.', 'error');
        setActiveSlot(null);
        setBookingStep(null);
        fetchAvailability();
        return;
      }

      if (!res.ok) throw new Error('Reservation hold failed');

      const data = await res.json();
      setBookingStreamId(data.streamId);
      setExpiresAt(data.reservationExpiresAt);
      
      // Update local state list
      setMyReservations([
        {
          streamId: data.streamId,
          courtName: selectedCourt.name,
          turfName: selectedCourt.sport_type ? selectedCourt.sport_type.replace('_', ' ') : 'Court Slot',
          date: selectedDate,
          time: `${activeSlot}:00 - ${activeSlot + bookingDuration}:00`,
          expiresAt: data.reservationExpiresAt,
          status: 'reserved'
        },
        ...myReservations
      ]);

      addToast('5-minute reservation hold acquired!', 'success');
      setBookingStep('payment');
    } catch (err) {
      console.error(err);
      addToast('Failed to secure hold.', 'error');
    }
  };

  // Step 2: Confirm Payment Success flow
  const handleConfirmPayment = async () => {
    try {
      // 1. Initiate Payment
      const initRes = await fetchWithAuth(`${API_URL}/api/bookings/${bookingStreamId}/initiate-payment`, {
        method: 'POST'
      });
      if (!initRes.ok) throw new Error('Payment initiation failed');

      // 2. Confirm Payment
      const confirmRes = await fetchWithAuth(`${API_URL}/api/bookings/${bookingStreamId}/confirm-payment`, {
        method: 'POST'
      });
      if (!confirmRes.ok) throw new Error('Payment confirmation failed');

      addToast('Booking successfully confirmed!', 'success');
      setBookingStep('success');
      fetchAvailability();
    } catch (err) {
      console.error(err);
      addToast('Payment processing failed.', 'error');
    }
  };

  // Step 2b: Simulate Payment Failure (Triggers Saga compensations)
  const handleSimulateFailure = async () => {
    try {
      // 1. Initiate Payment
      const initRes = await fetchWithAuth(`${API_URL}/api/bookings/${bookingStreamId}/initiate-payment`, {
        method: 'POST'
      });
      if (!initRes.ok) throw new Error('Payment initiation failed');

      // 2. Fail Payment
      const failRes = await fetchWithAuth(`${API_URL}/api/bookings/${bookingStreamId}/fail-payment`, {
        method: 'POST'
      });
      if (!failRes.ok) throw new Error('Payment fail trigger failed');

      addToast('Payment failed. Saga compensation triggered!', 'error');
      setBookingStep('failed');
      fetchAvailability();
    } catch (err) {
      console.error(err);
      addToast('Failed to simulate failure.', 'error');
    }
  };

  const hours = [8, 10, 12, 14, 16, 18, 20];

  const getSlotColor = (status) => {
    switch (status) {
      case 'reserved':
        return 'bg-amber-100 text-amber-900 border-amber-300 cursor-not-allowed';
      case 'payment_pending':
        return 'bg-yellow-100 text-yellow-900 border-yellow-300 animate-pulse cursor-not-allowed';
      case 'booking_confirmed':
      case 'confirmed':
        return 'bg-rose-100 text-rose-900 border-rose-300 cursor-not-allowed';
      case 'payment_failed':
        return 'bg-rose-100 text-rose-900 border-rose-300';
      case 'released':
      case 'cancelled':
      default:
        return 'bg-white hover:bg-neutral-50 text-neutral-800 border-neutral-200 hover:border-neutral-400 hover:-translate-y-0.5';
    }
  };

  return (
    <div className="relative min-h-[90vh] bg-[#fafaf9]">
      {/* Decorative Dotted Grid Background */}
      <div className="absolute inset-0 bg-dotted-grid opacity-20 pointer-events-none" />

      {/* Hero Section with Parallax typography */}
      <section className="relative w-full h-[550px] overflow-hidden flex flex-col justify-center items-center text-center px-6 border-b border-neutral-200/80 text-white">
        {/* Background Image with dim overlay */}
        <div 
          className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-transform duration-1000 scale-[1.03]"
          style={{ backgroundImage: `url('https://images.unsplash.com/photo-1529900748604-07564a03e7a6?q=80&w=1920&auto=format&fit=crop')` }}
        />
        <div className="absolute inset-0 bg-neutral-950/70" />

        {/* Editorial Headline Overlay */}
        <div className="relative z-10 max-w-4xl mx-auto flex flex-col items-center">
          <motion.h1 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="text-6xl sm:text-7xl md:text-8xl font-black tracking-tight leading-[1.05] mb-8 font-sans"
          >
            Book your court,<br />
            <span className="font-serif italic font-normal text-neutral-200">instantly.</span>
          </motion.h1>

          {/* Badge Row (Editorial Pill styling) */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3, duration: 0.6 }}
            className="flex flex-wrap justify-center gap-4 bg-white/10 backdrop-blur-md px-6 py-3 rounded-full border border-white/20 shadow-xl"
          >
            <div className="flex items-center gap-2 text-xs font-bold tracking-widest uppercase text-neutral-200">
              <span className="text-[14px]">✓</span> Instant Confirmation
            </div>
            <div className="w-1.5 h-1.5 rounded-full bg-white/30 self-center hidden sm:block" />
            <div className="flex items-center gap-2 text-xs font-bold tracking-widest uppercase text-neutral-200">
              <span className="text-[14px]">⚡</span> Secure 5-Min Hold
            </div>
            <div className="w-1.5 h-1.5 rounded-full bg-white/30 self-center hidden sm:block" />
            <div className="flex items-center gap-2 text-xs font-bold tracking-widest uppercase text-neutral-200">
              <span className="text-[14px]">★</span> Verified Courts
            </div>
          </motion.div>
        </div>
      </section>

      {/* Main Reservation Console */}
      <main className="max-w-7xl mx-auto px-6 sm:px-8 py-20 relative z-10 grid grid-cols-1 lg:grid-cols-3 gap-16">
        
        {/* Selector Panel (Left/Center columns) */}
        <div className="lg:col-span-2 space-y-16">
          
          {/* Section: Court Cards Selector */}
          <div>
            <div className="flex items-baseline justify-between mb-8">
              <h2 className="text-3xl font-bold tracking-tight text-neutral-900">
                Select your <span className="font-serif italic font-normal text-neutral-700">court</span>
              </h2>
              <span className="text-xs font-mono font-bold tracking-widest uppercase text-neutral-400">
                Step 01
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <AnimatePresence>
                {loadingCourts ? (
                  Array.from({ length: 3 }).map((_, idx) => (
                    <div
                      key={`skeleton-court-${idx}`}
                      className="bg-white border border-neutral-200/80 rounded-2xl p-6 flex flex-col justify-between h-56 animate-pulse"
                    >
                      <div>
                        <div className="h-3 bg-neutral-200 rounded w-1/3 mb-4" />
                        <div className="h-6 bg-neutral-200 rounded w-3/4 mb-2" />
                        <div className="h-4 bg-neutral-100 rounded w-1/2" />
                      </div>
                      <div className="flex flex-col space-y-2 mt-4">
                        <div className="h-3 bg-neutral-100 rounded w-1/4" />
                        <div className="h-5 bg-neutral-200 rounded w-1/3" />
                      </div>
                    </div>
                  ))
                ) : courts.length === 0 ? (
                  <div className="col-span-3 py-16 border border-dashed border-neutral-200 rounded-2xl bg-white/50 text-center text-xs font-mono text-neutral-400 uppercase tracking-widest">
                    No courts available.
                  </div>
                ) : (
                  courts.map((court) => {
                    const isSelected = selectedCourt && selectedCourt.id === court.id;
                    return (
                      <motion.div
                        key={court.id}
                        onClick={() => setSelectedCourt(court)}
                        whileHover={{ y: -6, boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.08), 0 10px 10px -5px rgba(0, 0, 0, 0.04)' }}
                        whileTap={{ scale: 0.98 }}
                        className={`cursor-pointer bg-white border rounded-2xl p-6 transition-all duration-350 flex flex-col justify-between h-56 select-none ${
                          isSelected 
                            ? 'border-neutral-950 ring-2 ring-neutral-950/80 shadow-lg' 
                            : 'border-neutral-200/80 shadow-md hover:border-neutral-300'
                        }`}
                      >
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 leading-none block mb-2">
                            {court.sport_type.replace('_', ' ')}
                          </span>
                          <h3 className="font-serif text-xl font-bold text-neutral-950 leading-snug">
                            {court.name}
                          </h3>
                          <p className="text-[13px] text-neutral-500 font-sans tracking-wide mt-1">
                            {court.turf_name}
                          </p>
                        </div>

                        <div className="flex items-baseline justify-between pt-4 border-t border-neutral-100">
                          <span className="text-xs font-semibold tracking-wider text-neutral-400 uppercase">
                            Hourly Rate
                          </span>
                          <span className="text-lg font-mono font-bold text-neutral-900">
                            ₹{parseInt(court.base_price_per_hour, 10)}
                          </span>
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Section: Date Picker & Grid */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 mb-8">
              <h2 className="text-3xl font-bold tracking-tight text-neutral-900">
                Choose slot <span className="font-serif italic font-normal text-neutral-700">availability</span>
              </h2>
              
              <div className="flex items-center gap-3">
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="px-4 py-2 border border-neutral-200 bg-white rounded-full text-sm font-semibold tracking-wider text-neutral-700 uppercase outline-none focus:border-neutral-950 select-none shadow-sm"
                />
              </div>
            </div>

            {/* Time Slot Grid */}
            <div className="bg-white border border-neutral-200/80 rounded-2xl p-8 sm:p-10 shadow-xl relative overflow-hidden">
              {!selectedCourt ? (
                <div className="py-16 text-center text-xs font-mono text-neutral-400 uppercase tracking-widest">
                  Please select a court facility above to view slot availability.
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {loadingAvailability ? (
                    hours.map((hour) => (
                      <div
                        key={`skeleton-slot-${hour}`}
                        className="h-16 border border-neutral-100 rounded-xl bg-neutral-50 flex flex-col justify-center items-center animate-pulse"
                      >
                        <div className="h-4 bg-neutral-200 rounded w-1/2 mb-1.5" />
                        <div className="h-2.5 bg-neutral-200 rounded w-1/3" />
                      </div>
                    ))
                  ) : (
                    hours.map((hour) => {
                      const availability = slotsAvailability[hour];
                      const status = availability ? availability.status : null;
                      
                      const isPendingSelection = bookingStep === 'details' && activeSlot !== null && (hour < activeSlot + bookingDuration && hour + 2 > activeSlot);
                      const buttonClass = isPendingSelection
                        ? 'bg-neutral-950 hover:bg-neutral-900 text-white border-neutral-950 shadow-md scale-[1.02] ring-2 ring-neutral-950/20'
                        : getSlotColor(status);

                      return (
                        <motion.button
                          key={hour}
                          layoutId={`slot-${hour}`}
                          onClick={() => handleSlotClick(hour, status)}
                          className={`h-16 border rounded-xl font-mono font-bold text-sm tracking-wide transition-all duration-350 select-none flex flex-col justify-center items-center shadow-sm ${buttonClass}`}
                        >
                          <span>{hour}:00</span>
                          <span className={`text-[9px] font-sans uppercase tracking-widest mt-1 ${isPendingSelection ? 'text-neutral-300' : 'text-neutral-400'}`}>
                            {isPendingSelection ? 'Selecting' : status ? status.replace('_', ' ') : 'Available'}
                          </span>
                        </motion.button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Local Reservations Sidebar */}
        <div className="space-y-8">
          <div className="bg-neutral-900 text-white rounded-2xl p-6 sm:p-8 border border-neutral-800 shadow-2xl relative overflow-hidden min-h-[400px]">
            {/* Small subtle dotted grid inside sidebar */}
            <div className="absolute inset-0 bg-dotted-grid-dark opacity-10 pointer-events-none" />

            <h3 className="text-xl font-bold tracking-wider uppercase mb-6 relative z-10">
              My <span className="font-serif italic font-normal text-neutral-300">Reservations</span>
            </h3>

            <div className="space-y-6 relative z-10">
              {myReservations.length === 0 ? (
                <p className="text-neutral-500 text-sm italic py-10 text-center">
                  No reservations booked in this session.
                </p>
              ) : (
                <div className="divide-y divide-neutral-800 space-y-4">
                  {myReservations.slice(0, 5).map((res) => {
                    const isActiveHold = res.status === 'reserved';
                    return (
                      <div key={res.streamId} className="pt-4 first:pt-0 space-y-3">
                        <div className="flex items-start justify-between">
                          <div>
                            <h4 className="font-serif italic text-base text-neutral-100">
                              {res.courtName}
                            </h4>
                            <p className="text-[11px] text-neutral-400 font-mono mt-1">
                              {res.date} • {res.time}
                            </p>
                          </div>
                          <StatusBadge status={res.status} />
                        </div>

                        {/* If status is on-hold, render Countdown Ring */}
                        {isActiveHold && (
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3 flex items-center justify-between">
                            <CountdownRing
                              expiresAt={res.expiresAt}
                              onExpire={() => {
                                setMyReservations(
                                  myReservations.map((r) =>
                                    r.streamId === res.streamId
                                      ? { ...r, status: 'released' }
                                      : r
                                  )
                                );
                              }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Booking State Machine Animated Modal */}
      <AnimatedModal
        isOpen={!!activeSlot}
        onClose={() => {
          setActiveSlot(null);
          setBookingStep(null);
        }}
      >
        {bookingStep === 'details' && (
          <div className="text-center space-y-6">
            <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 mb-2 block leading-none">
              Reservation Summary
            </span>
            <h3 className="font-serif italic text-3xl text-neutral-950">
              {selectedCourt?.name}
            </h3>
            
            {/* Duration Selector */}
            <div className="space-y-3 py-2 border-t border-neutral-100">
              <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
                Select Duration
              </span>
              <div className="flex justify-center gap-3">
                {[1, 2, 3].map((d) => {
                  const disabled = isOverlapping(activeSlot, d);
                  const isSelected = bookingDuration === d;

                  return (
                    <button
                      key={d}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setBookingDuration(d);
                        setBookingAmount(parseFloat(selectedCourt.base_price_per_hour) * d);
                      }}
                      className={`px-4 py-2 text-xs font-mono font-bold tracking-wide rounded-full border transition-all select-none
                        ${disabled 
                          ? 'bg-neutral-50 text-neutral-300 border-neutral-100 cursor-not-allowed line-through' 
                          : isSelected 
                            ? 'bg-neutral-950 text-white border-neutral-950 shadow-sm' 
                            : 'bg-white hover:bg-neutral-50 text-neutral-700 border-neutral-200'
                        }`}
                    >
                      {d} {d === 1 ? 'Hour' : 'Hours'}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="border-y border-neutral-200/80 py-4 font-mono text-sm space-y-2 text-neutral-600">
              <div className="flex justify-between">
                <span>Date:</span> <span className="font-bold text-neutral-900">{selectedDate}</span>
              </div>
              <div className="flex justify-between">
                <span>Time Slot:</span> <span className="font-bold text-neutral-900">{activeSlot}:00 - {activeSlot + bookingDuration}:00</span>
              </div>
              <div className="flex justify-between">
                <span>Duration:</span> <span className="font-bold text-neutral-900">{bookingDuration} {bookingDuration === 1 ? 'Hour' : 'Hours'}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-neutral-100 font-sans text-base">
                <span className="font-semibold text-neutral-900">Amount Due:</span> 
                <span className="font-mono font-bold text-neutral-950">₹{bookingAmount}</span>
              </div>
            </div>

            <p className="text-xs text-neutral-400 font-sans">
              Pressing Reserve secures a 5-minute locks hold on the database, preventing anyone else from overlapping.
            </p>

            <div className="pt-2">
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={handleReserve}
                className="w-full py-4 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow-lg hover:bg-neutral-900 hover:scale-[1.01] transition-all"
              >
                Reserve Slot
              </motion.button>
            </div>
          </div>
        )}

        {bookingStep === 'payment' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between border-b border-neutral-200 pb-4">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block leading-none mb-1">
                  Hold Reserved
                </span>
                <span className="text-xs font-mono text-neutral-500">ID: {bookingStreamId?.substring(0, 8)}...</span>
              </div>
              <CountdownRing expiresAt={expiresAt} />
            </div>

            {/* Simulated Credit Card Fields */}
            <div className="space-y-4 pt-2">
              <h3 className="font-serif italic text-xl text-neutral-950 mb-2">
                Card Information
              </h3>
              
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Cardholder Name"
                  defaultValue="Jane Doe"
                  disabled
                  className="w-full px-4 py-3 border border-neutral-200 bg-neutral-50 rounded-xl text-sm font-semibold tracking-wide text-neutral-500 outline-none select-none"
                />
                <input
                  type="text"
                  placeholder="Card Number"
                  defaultValue="••••  ••••  ••••  4242"
                  disabled
                  className="w-full px-4 py-3 border border-neutral-200 bg-neutral-50 rounded-xl text-sm font-semibold tracking-wide text-neutral-500 outline-none select-none"
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    placeholder="Expiry Date"
                    defaultValue="12 / 29"
                    disabled
                    className="px-4 py-3 border border-neutral-200 bg-neutral-50 rounded-xl text-sm font-semibold tracking-wide text-neutral-500 outline-none select-none"
                  />
                  <input
                    type="text"
                    placeholder="CVV"
                    defaultValue="•••"
                    disabled
                    className="px-4 py-3 border border-neutral-200 bg-neutral-50 rounded-xl text-sm font-semibold tracking-wide text-neutral-500 outline-none select-none"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-4">
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={handleConfirmPayment}
                className="w-full py-4 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow-lg hover:bg-neutral-900 transition-colors"
              >
                Confirm Payment (₹{bookingAmount})
              </motion.button>

              <button
                onClick={handleSimulateFailure}
                className="w-full text-center text-xs font-bold uppercase tracking-widest text-neutral-400 hover:text-rose-500 transition-colors py-2"
              >
                Simulate Payment Failure
              </button>
            </div>
          </div>
        )}

        {bookingStep === 'success' && (
          <div className="text-center space-y-6 py-6">
            <div className="w-16 h-16 rounded-full border-2 border-emerald-500 text-emerald-500 text-xl font-bold flex items-center justify-center mx-auto mb-4 select-none leading-none">
              ✓
            </div>
            <h3 className="font-serif italic text-3xl text-neutral-950">
              Booking Confirmed
            </h3>
            <p className="text-sm font-sans text-neutral-500 tracking-wide leading-relaxed max-w-sm mx-auto">
              Your payment has been successfully cleared. The court is secured under aggregate transaction integrity.
            </p>

            <div className="pt-4">
              <button
                onClick={() => {
                  setActiveSlot(null);
                  setBookingStep(null);
                }}
                className="px-8 py-3 border border-neutral-950 text-neutral-950 font-bold uppercase tracking-wider text-xs rounded-full hover:bg-neutral-50 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {bookingStep === 'failed' && (
          <div className="text-center space-y-6 py-6">
            <div className="w-16 h-16 rounded-full border-2 border-rose-500 text-rose-500 text-xl font-bold flex items-center justify-center mx-auto mb-4 select-none leading-none">
              ✕
            </div>
            <h3 className="font-serif italic text-3xl text-neutral-950">
              Payment Failed
            </h3>
            <p className="text-sm font-sans text-neutral-500 tracking-wide leading-relaxed max-w-sm mx-auto">
              The payment process was rejected. Saga orchestrations have appended a compensatory SLOTS_RELEASED event to rollback availability automatically.
            </p>

            <div className="pt-4">
              <button
                onClick={() => {
                  setActiveSlot(null);
                  setBookingStep(null);
                }}
                className="px-8 py-3 border border-neutral-950 text-neutral-950 font-bold uppercase tracking-wider text-xs rounded-full hover:bg-neutral-50 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </AnimatedModal>
    </div>
  );
}
