import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import Navbar from './components/Navbar';
import BookingPage from './pages/BookingPage';
import HistoryPage from './pages/HistoryPage';
import AdminPage from './pages/AdminPage';
import AdminPanelPage from './pages/AdminPanelPage';
import EventLogPage from './pages/EventLogPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import NotFoundPage from './pages/NotFoundPage';
import ErrorBoundary from './components/ErrorBoundary';
import { useEventStream } from './hooks/useEventStream';
import { useToast } from './components/Toast';

function AdminRedirect() {
  const { addToast } = useToast();
  React.useEffect(() => {
    addToast("Admin accounts don't have booking access", 'warning');
  }, [addToast]);
  return <Navigate to="/admin" replace />;
}

function UserRedirect() {
  const { addToast } = useToast();
  React.useEffect(() => {
    addToast("Access denied. Admin role required.", 'error');
  }, [addToast]);
  return <Navigate to="/" replace />;
}

function ProtectedRoute({ children, adminOnly = false, userOnly = false }) {
  const { user, isAdmin } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && !isAdmin) {
    return <UserRedirect />;
  }
  if (userOnly && isAdmin) {
    return <AdminRedirect />;
  }
  return children;
}

function App() {
  const { events, connectionStatus } = useEventStream();

  return (
    <ToastProvider>
      <AuthProvider>
        <Router>
          <div className="flex flex-col min-h-screen bg-[#fafaf9]">
            {/* Main Navigation Bar */}
            <Navbar connectionStatus={connectionStatus} />

            {/* App Views */}
            <div className="flex-grow">
              <ErrorBoundary>
                <Routes>
                  <Route path="/" element={<ProtectedRoute userOnly><BookingPage events={events} wsStatus={connectionStatus} /></ProtectedRoute>} />
                  <Route path="/history" element={<ProtectedRoute userOnly><HistoryPage /></ProtectedRoute>} />
                  <Route path="/admin" element={<ProtectedRoute adminOnly><AdminPage /></ProtectedRoute>} />
                  <Route path="/admin/manage" element={<ProtectedRoute adminOnly><AdminPanelPage /></ProtectedRoute>} />
                  <Route path="/events" element={<ProtectedRoute><EventLogPage events={events} /></ProtectedRoute>} />
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/register" element={<RegisterPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </ErrorBoundary>
            </div>

            {/* Footer */}
            <footer className="border-t border-neutral-200 py-8 bg-neutral-900 text-neutral-400 text-xs text-center font-sans tracking-widest uppercase">
              © {new Date().getFullYear()} TAP TO TURF. All rights reserved.
            </footer>
          </div>
        </Router>
      </AuthProvider>
    </ToastProvider>
  );
}

export default App;
