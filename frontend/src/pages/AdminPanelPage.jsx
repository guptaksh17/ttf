import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import AnimatedModal from '../components/AnimatedModal';

export default function AdminPanelPage() {
  const { fetchWithAuth } = useAuth();
  const { addToast } = useToast();
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

  const [turfs, setTurfs] = useState([]);
  const [courts, setCourts] = useState([]);
  const [loading, setLoading] = useState(false);

  // Modal forms states
  const [turfModalOpen, setTurfModalOpen] = useState(false);
  const [courtModalOpen, setCourtModalOpen] = useState(false);
  const [editingTurf, setEditingTurf] = useState(null); // null for Add, turf object for Edit
  const [editingCourt, setEditingCourt] = useState(null); // null for Add, court object for Edit

  // Turf Form Inputs
  const [turfName, setTurfName] = useState('');
  const [turfCity, setTurfCity] = useState('');
  const [turfAddress, setTurfAddress] = useState('');
  const [turfOpensAt, setTurfOpensAt] = useState('08:00:00');
  const [turfClosesAt, setTurfClosesAt] = useState('22:00:00');

  // Court Form Inputs
  const [courtTurfId, setCourtTurfId] = useState('');
  const [courtSportType, setCourtSportType] = useState('football_5s');
  const [courtName, setCourtName] = useState('');
  const [courtPrice, setCourtPrice] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [turfRes, courtRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/api/admin/turfs`),
        fetchWithAuth(`${API_URL}/api/admin/courts`)
      ]);

      if (!turfRes.ok || !courtRes.ok) {
        throw new Error('Failed to retrieve management data.');
      }

      const turfData = await turfRes.json();
      const courtData = await courtRes.json();
      
      setTurfs(turfData);
      setCourts(courtData);

      // Pre-select first turf in dropdown if inputs are empty
      if (turfData.length > 0 && !courtTurfId) {
        setCourtTurfId(turfData[0].id);
      }
    } catch (err) {
      console.error(err);
      addToast(err.message || 'Error fetching facilities data.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Open Turf Modal (Add/Edit)
  const openTurfModal = (turf = null) => {
    setEditingTurf(turf);
    if (turf) {
      setTurfName(turf.name);
      setTurfCity(turf.city);
      setTurfAddress(turf.address);
      setTurfOpensAt(turf.opens_at);
      setTurfClosesAt(turf.closes_at);
    } else {
      setTurfName('');
      setTurfCity('');
      setTurfAddress('');
      setTurfOpensAt('08:00:00');
      setTurfClosesAt('22:00:00');
    }
    setTurfModalOpen(true);
  };

  // Open Court Modal (Add/Edit)
  const openCourtModal = (court = null) => {
    setEditingCourt(court);
    if (court) {
      setCourtTurfId(court.turf_id);
      setCourtSportType(court.sport_type);
      setCourtName(court.name);
      setCourtPrice(court.base_price_per_hour);
    } else {
      setCourtTurfId(turfs[0]?.id || '');
      setCourtSportType('football_5s');
      setCourtName('');
      setCourtPrice('');
    }
    setCourtModalOpen(true);
  };

  // Handle Turf Submit
  const handleTurfSubmit = async (e) => {
    e.preventDefault();
    if (!turfName || !turfCity || !turfAddress || !turfOpensAt || !turfClosesAt) {
      addToast('Please fill out all fields.', 'warning');
      return;
    }

    const payload = {
      name: turfName,
      city: turfCity,
      address: turfAddress,
      opensAt: turfOpensAt,
      closesAt: turfClosesAt
    };

    try {
      const url = editingTurf
        ? `${API_URL}/api/admin/turfs/${editingTurf.id}`
        : `${API_URL}/api/admin/turfs`;
      const method = editingTurf ? 'PUT' : 'POST';

      const res = await fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Turf database update failed');

      addToast(editingTurf ? 'Turf updated successfully.' : 'New Turf created successfully.', 'success');
      setTurfModalOpen(false);
      fetchData();
    } catch (err) {
      console.error(err);
      addToast(err.message, 'error');
    }
  };

  // Handle Court Submit
  const handleCourtSubmit = async (e) => {
    e.preventDefault();
    if (!courtTurfId || !courtSportType || !courtName || !courtPrice) {
      addToast('Please fill out all fields.', 'warning');
      return;
    }

    const payload = {
      turfId: courtTurfId,
      sportType: courtSportType,
      name: courtName,
      basePricePerHour: parseFloat(courtPrice)
    };

    try {
      const url = editingCourt
        ? `${API_URL}/api/admin/courts/${editingCourt.id}`
        : `${API_URL}/api/admin/courts`;
      const method = editingCourt ? 'PUT' : 'POST';

      const res = await fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Court database update failed');

      addToast(editingCourt ? 'Court updated successfully.' : 'New Court created successfully.', 'success');
      setCourtModalOpen(false);
      fetchData();
    } catch (err) {
      console.error(err);
      addToast(err.message, 'error');
    }
  };

  // Handle Turf Delete
  const handleTurfDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this Turf?')) return;
    try {
      const res = await fetchWithAuth(`${API_URL}/api/admin/turfs/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to delete turf');
      }
      addToast('Turf deleted successfully.', 'success');
      fetchData();
    } catch (err) {
      console.error(err);
      addToast(err.message, 'error');
    }
  };

  // Handle Court Delete
  const handleCourtDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this court?')) return;
    try {
      const res = await fetchWithAuth(`${API_URL}/api/admin/courts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to delete court');
      }
      addToast('Court deleted successfully.', 'success');
      fetchData();
    } catch (err) {
      console.error(err);
      addToast(err.message, 'error');
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
    <div className="relative min-h-[90vh] bg-[#fafaf9] py-12 px-6 sm:px-8">
      {/* Decorative Dotted Grid Background */}
      <div className="absolute inset-0 bg-dotted-grid opacity-20 pointer-events-none" />

      <div className="max-w-7xl mx-auto space-y-12 relative z-10">
        {/* Header */}
        <div className="border-b border-neutral-200 pb-6 flex justify-between items-end">
          <div>
            <h1 className="text-4xl sm:text-5xl font-black tracking-tight text-neutral-900 font-sans">
              Manage <span className="font-serif italic font-normal text-neutral-700">Facilities</span>
            </h1>
            <p className="text-neutral-400 text-xs font-mono uppercase mt-2 tracking-widest">
              Reference Table CRUD Operations (Admins Only)
            </p>
          </div>
          <div className="flex gap-4">
            <button
              onClick={() => openTurfModal(null)}
              className="px-5 py-2.5 bg-neutral-900 text-white text-xs font-bold uppercase tracking-wider rounded-full shadow hover:bg-neutral-800 transition-all"
            >
              + Add Turf
            </button>
            <button
              onClick={() => openCourtModal(null)}
              className="px-5 py-2.5 bg-neutral-900 text-white text-xs font-bold uppercase tracking-wider rounded-full shadow hover:bg-neutral-800 transition-all"
            >
              + Add Court
            </button>
          </div>
        </div>

        {loading && (
          <div className="text-center py-20 text-xs font-bold uppercase tracking-widest text-neutral-400">
            Loading management dashboard...
          </div>
        )}

        {!loading && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
            {/* Turfs List */}
            <div className="space-y-6">
              <h3 className="font-serif italic text-2xl text-neutral-900 border-b border-neutral-200 pb-3">
                Turf Venues
              </h3>
              {turfs.length === 0 ? (
                <div className="p-10 border border-dashed border-neutral-200 rounded-2xl bg-white/50 text-center text-xs font-mono text-neutral-400 uppercase tracking-widest">
                  No turf venues created yet.
                </div>
              ) : (
                <div className="space-y-4">
                  {turfs.map((turf) => (
                    <div 
                      key={turf.id}
                      className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm flex justify-between items-start"
                    >
                      <div className="space-y-2 font-sans">
                        <h4 className="font-bold text-lg text-neutral-950 leading-tight">
                          {turf.name}
                        </h4>
                        <p className="text-xs text-neutral-500">
                          {turf.address}, {turf.city}
                        </p>
                        <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-widest">
                          Hours: {turf.opens_at.slice(0, 5)} - {turf.closes_at.slice(0, 5)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => openTurfModal(turf)}
                          className="px-3 py-1.5 border border-neutral-200 hover:border-neutral-400 bg-white text-neutral-700 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleTurfDelete(turf.id)}
                          className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Courts List */}
            <div className="space-y-6">
              <h3 className="font-serif italic text-2xl text-neutral-900 border-b border-neutral-200 pb-3">
                Play Courts
              </h3>
              {courts.length === 0 ? (
                <div className="p-10 border border-dashed border-neutral-200 rounded-2xl bg-white/50 text-center text-xs font-mono text-neutral-400 uppercase tracking-widest">
                  No courts configured yet.
                </div>
              ) : (
                <div className="space-y-4">
                  {courts.map((court) => {
                    const parentTurf = turfs.find((t) => t.id === court.turf_id);
                    return (
                      <div 
                        key={court.id}
                        className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm flex justify-between items-start"
                      >
                        <div className="space-y-2 font-sans">
                          <span className="inline-block px-2.5 py-1 text-[9px] font-mono font-bold uppercase tracking-wider bg-neutral-100 text-neutral-600 rounded-md">
                            {getSportLabel(court.sport_type)}
                          </span>
                          <h4 className="font-bold text-lg text-neutral-950 leading-tight">
                            {court.name}
                          </h4>
                          {parentTurf && (
                            <p className="text-xs text-neutral-500">
                              Venue: {parentTurf.name}
                            </p>
                          )}
                          <p className="text-sm font-mono font-bold text-neutral-800">
                            ₹{parseInt(court.base_price_per_hour, 10)} / Hr
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => openCourtModal(court)}
                            className="px-3 py-1.5 border border-neutral-200 hover:border-neutral-400 bg-white text-neutral-700 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleCourtDelete(court.id)}
                            className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Turf Modal Form */}
      <AnimatedModal isOpen={turfModalOpen} onClose={() => setTurfModalOpen(false)}>
        <h3 className="font-serif italic text-2xl text-neutral-950 mb-6 text-center">
          {editingTurf ? 'Edit Turf Venue' : 'Create Turf Venue'}
        </h3>
        <form onSubmit={handleTurfSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
              Turf Name
            </label>
            <input
              type="text"
              value={turfName}
              onChange={(e) => setTurfName(e.target.value)}
              placeholder="Greenfield Arena"
              className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-sans text-sm"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
                City
              </label>
              <input
                type="text"
                value={turfCity}
                onChange={(e) => setTurfCity(e.target.value)}
                placeholder="Mumbai"
                className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-sans text-sm"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
                Address
              </label>
              <input
                type="text"
                value={turfAddress}
                onChange={(e) => setTurfAddress(e.target.value)}
                placeholder="Vile Parle West"
                className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-sans text-sm"
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
                Opens At
              </label>
              <input
                type="text"
                value={turfOpensAt}
                onChange={(e) => setTurfOpensAt(e.target.value)}
                placeholder="08:00:00"
                className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-mono text-sm"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
                Closes At
              </label>
              <input
                type="text"
                value={turfClosesAt}
                onChange={(e) => setTurfClosesAt(e.target.value)}
                placeholder="22:00:00"
                className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-mono text-sm"
                required
              />
            </div>
          </div>
          <div className="pt-4 flex gap-4">
            <button
              type="button"
              onClick={() => setTurfModalOpen(false)}
              className="flex-grow py-3 border border-neutral-200 hover:bg-neutral-50 font-bold uppercase tracking-wider text-xs rounded-full shadow"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-grow py-3 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow hover:bg-neutral-900"
            >
              {editingTurf ? 'Save Changes' : 'Create Turf'}
            </button>
          </div>
        </form>
      </AnimatedModal>

      {/* Court Modal Form */}
      <AnimatedModal isOpen={courtModalOpen} onClose={() => setCourtModalOpen(false)}>
        <h3 className="font-serif italic text-2xl text-neutral-950 mb-6 text-center">
          {editingCourt ? 'Edit Play Court' : 'Create Play Court'}
        </h3>
        <form onSubmit={handleCourtSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
              Parent Turf Venue
            </label>
            <select
              value={courtTurfId}
              onChange={(e) => setCourtTurfId(e.target.value)}
              className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-sans text-sm bg-white"
              required
            >
              {turfs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
                Sport Type
              </label>
              <select
                value={courtSportType}
                onChange={(e) => setCourtSportType(e.target.value)}
                className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-sans text-sm bg-white"
                required
              >
                <option value="football_5s">Football 5s</option>
                <option value="badminton">Badminton</option>
                <option value="box_cricket">Box Cricket</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
                Court Name
              </label>
              <input
                type="text"
                value={courtName}
                onChange={(e) => setCourtName(e.target.value)}
                placeholder="Court C"
                className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-sans text-sm"
                required
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
              Base Price Per Hour (₹)
            </label>
            <input
              type="number"
              value={courtPrice}
              onChange={(e) => setCourtPrice(e.target.value)}
              placeholder="800"
              className="w-full h-10 px-4 rounded-xl border border-neutral-200 focus:outline-none focus:border-neutral-950 font-mono text-sm"
              required
            />
          </div>
          <div className="pt-4 flex gap-4">
            <button
              type="button"
              onClick={() => setCourtModalOpen(false)}
              className="flex-grow py-3 border border-neutral-200 hover:bg-neutral-50 font-bold uppercase tracking-wider text-xs rounded-full shadow"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-grow py-3 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow hover:bg-neutral-900"
            >
              {editingCourt ? 'Save Changes' : 'Create Court'}
            </button>
          </div>
        </form>
      </AnimatedModal>
    </div>
  );
}
