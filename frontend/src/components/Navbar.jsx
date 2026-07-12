import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar({ connectionStatus }) {
  const { user, logout, isAdmin } = useAuth();
  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected':
        return 'bg-emerald-500 shadow-emerald-500/50';
      case 'connecting':
        return 'bg-amber-500 shadow-amber-500/50 animate-pulse';
      case 'disconnected':
      default:
        return 'bg-rose-500 shadow-rose-500/50';
    }
  };

  const getStatusText = () => {
    switch (connectionStatus) {
      case 'connected':
        return 'Live Sync';
      case 'connecting':
        return 'Syncing...';
      case 'disconnected':
      default:
        return 'Offline';
    }
  };

  return (
    <header className="border-b border-neutral-200/80 bg-white/70 backdrop-blur-md sticky top-0 z-50 transition-all duration-300">
      <div className="max-w-7xl mx-auto px-6 sm:px-8 py-5 flex items-center justify-between">
        {/* Brand Logo - KATACHI Inspired Editorial Styling */}
        <NavLink 
          to="/" 
          className="font-sans font-black text-xl tracking-[0.25em] text-neutral-900 select-none uppercase hover:opacity-80 transition-opacity"
        >
          TAP TO TURF
        </NavLink>

        {/* Navigation Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-semibold tracking-wider text-neutral-500 uppercase">
          {user ? (
            <>
              {!isAdmin && (
                <>
                  <NavLink 
                    to="/" 
                    className={({ isActive }) => 
                      `transition-colors duration-200 hover:text-neutral-900 ${
                        isActive ? 'text-neutral-900 border-b border-neutral-900 pb-1' : ''
                      }`
                    }
                  >
                    Booking
                  </NavLink>
                  <NavLink 
                    to="/history" 
                    className={({ isActive }) => 
                      `transition-colors duration-200 hover:text-neutral-900 ${
                        isActive ? 'text-neutral-900 border-b border-neutral-900 pb-1' : ''
                      }`
                    }
                  >
                    History
                  </NavLink>
                </>
              )}
              {isAdmin && (
                <>
                  <NavLink 
                    to="/admin" 
                    className={({ isActive }) => 
                      `transition-colors duration-200 hover:text-neutral-900 ${
                        isActive ? 'text-neutral-900 border-b border-neutral-900 pb-1' : ''
                      }`
                    }
                  >
                    Dashboard
                  </NavLink>
                  <NavLink 
                    to="/admin/manage" 
                    className={({ isActive }) => 
                      `transition-colors duration-200 hover:text-neutral-900 ${
                        isActive ? 'text-neutral-900 border-b border-neutral-900 pb-1' : ''
                      }`
                    }
                  >
                    Manage
                  </NavLink>
                </>
              )}
              <NavLink 
                to="/events" 
                className={({ isActive }) => 
                  `transition-colors duration-200 hover:text-neutral-900 ${
                    isActive ? 'text-neutral-900 border-b border-neutral-900 pb-1' : ''
                  }`
                }
              >
                Event Log
              </NavLink>
              <div className="h-4 w-px bg-neutral-200 mx-2" />
              <span className="text-neutral-900 font-sans font-bold text-xs lowercase select-none">
                @{user.name.replace(' ', '').toLowerCase()}
              </span>
              <button 
                onClick={logout} 
                className="transition-colors duration-200 hover:text-neutral-900 text-xs font-bold text-neutral-400"
              >
                Logout
              </button>
            </>
          ) : (
            <>
              <NavLink 
                to="/login" 
                className={({ isActive }) => 
                  `transition-colors duration-200 hover:text-neutral-900 ${
                    isActive ? 'text-neutral-900 border-b border-neutral-900 pb-1' : ''
                  }`
                }
              >
                Login
              </NavLink>
              <NavLink 
                to="/register" 
                className={({ isActive }) => 
                  `transition-colors duration-200 hover:text-neutral-900 ${
                    isActive ? 'text-neutral-900 border-b border-neutral-900 pb-1' : ''
                  }`
                }
              >
                Register
              </NavLink>
            </>
          )}
        </nav>

        {/* Real-time Status Badge */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-neutral-200 bg-neutral-50 text-[11px] font-bold tracking-widest uppercase text-neutral-600 select-none">
          <span className={`w-2 h-2 rounded-full shadow-sm ${getStatusColor()} transition-colors duration-500`} />
          <span>{getStatusText()}</span>
        </div>
      </div>
    </header>
  );
}
