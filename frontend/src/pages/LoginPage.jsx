import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { login } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      addToast('Please fill in all fields.', 'warning');
      return;
    }

    setSubmitting(true);
    try {
      const loggedInUser = await login(email, password);
      addToast('Successfully logged in!', 'success');
      if (loggedInUser && loggedInUser.role === 'admin') {
        navigate('/admin');
      } else {
        navigate('/');
      }
    } catch (err) {
      console.error(err);
      addToast(err.message || 'Invalid email or password.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-[80vh] flex items-center justify-center px-4 py-16 bg-[#fafaf9]">
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
            Welcome Back
          </span>
          <h2 className="font-serif italic text-4xl text-neutral-950">
            Sign In
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 block font-sans">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full h-12 px-4 rounded-xl border border-neutral-200 hover:border-neutral-400 focus:border-neutral-950 focus:outline-none font-sans text-sm transition-all shadow-sm"
              required
            />
          </div>

          <div className="space-y-2">
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

          <div className="pt-2">
            <motion.button
              whileTap={{ scale: 0.97 }}
              type="submit"
              disabled={submitting}
              className="w-full py-4 bg-neutral-950 text-white font-bold uppercase tracking-wider text-xs rounded-full shadow-lg hover:bg-neutral-900 transition-all select-none"
            >
              {submitting ? 'Signing In...' : 'Sign In'}
            </motion.button>
          </div>
        </form>

        <p className="text-center text-xs text-neutral-500 font-sans mt-6">
          Don't have an account?{' '}
          <Link to="/register" className="font-bold text-neutral-950 hover:underline">
            Register here
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
