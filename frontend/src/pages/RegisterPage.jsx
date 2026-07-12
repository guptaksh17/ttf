import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { register } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name || !email || !phone || !password) {
      addToast('Please fill in all fields.', 'warning');
      return;
    }

    setSubmitting(true);
    try {
      await register(name, email, phone, password);
      addToast('Account created successfully!', 'success');
      navigate('/');
    } catch (err) {
      console.error(err);
      addToast(err.message || 'Registration failed.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-[85vh] flex items-center justify-center px-4 py-16 bg-[#fafaf9]">
      {/* Dotted Grid Background */}
      <div className="absolute inset-0 bg-dotted-grid opacity-20 pointer-events-none" />

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md bg-white border border-neutral-200/80 rounded-2xl p-8 sm:p-10 shadow-xl relative z-10"
      >
        <div className="text-center mb-8">
          <span className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 mb-2 block leading-none">
            Join TapToTurf
          </span>
          <h2 className="font-serif italic text-4xl text-neutral-950">
            Create Account
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
              Full Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
              className="w-full h-12 px-4 rounded-xl border border-neutral-200 hover:border-neutral-400 focus:border-neutral-950 focus:outline-none font-sans text-sm transition-all shadow-sm"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
              className="w-full h-12 px-4 rounded-xl border border-neutral-200 hover:border-neutral-400 focus:border-neutral-950 focus:outline-none font-sans text-sm transition-all shadow-sm"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
              Phone Number
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+919876543210"
              className="w-full h-12 px-4 rounded-xl border border-neutral-200 hover:border-neutral-400 focus:border-neutral-950 focus:outline-none font-sans text-sm transition-all shadow-sm"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full h-12 px-4 rounded-xl border border-neutral-200 hover:border-neutral-400 focus:border-neutral-950 focus:outline-none font-sans text-sm transition-all shadow-sm"
              required
            />
          </div>

          <div className="pt-4">
            <motion.button
              whileTap={{ scale: 0.97 }}
              type="submit"
              disabled={submitting}
              className="w-full py-4 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow-lg hover:bg-neutral-900 transition-all select-none"
            >
              {submitting ? 'Registering...' : 'Register'}
            </motion.button>
          </div>
        </form>

        <p className="text-center text-xs text-neutral-500 font-sans mt-6">
          Already have an account?{' '}
          <Link to="/login" className="font-bold text-neutral-950 hover:underline">
            Sign In here
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
