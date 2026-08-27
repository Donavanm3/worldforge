import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api/client.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { Layout } from './components/Layout.js';
import { ComingSoon, Spinner } from './components/ui.js';
import { AdminPage } from './pages/AdminPage.js';
import { BetaAccessPage, BetaSuccessPage } from './pages/BetaAccessPage.js';
import { BetaPage } from './pages/BetaPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { LandPage } from './pages/LandPage.js';
import { CompaniesPage } from './pages/CompaniesPage.js';
import { MarketsPage } from './pages/MarketsPage.js';
import { JobsPage } from './pages/JobsPage.js';
import { LoginPage, RegisterPage } from './pages/AuthPages.js';

// MapLibre is ~700 kB and is only needed on the map route, so it loads on
// demand rather than blocking first paint everywhere else.
const MapPage = lazy(() => import('./pages/MapPage.js').then((m) => ({ default: m.MapPage })));

/**
 * Gate for everything inside the game world.
 *
 * This is convenience only — the server enforces the same rules on every
 * request (spec 76). Hiding a route in the client is never the control.
 */
function RequireWorldAccess({ children }: { children: React.ReactNode }) {
  const { status, me } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;
    api
      .betaAccess()
      .then((access) => setAllowed(access.hasAccess))
      .catch(() => setAllowed(false));
  }, [status, me]);

  if (status === 'loading') return <Spinner />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  if (allowed === null) return <Spinner />;
  if (!allowed) return <Navigate to="/beta-access" replace />;
  return <>{children}</>;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <Spinner />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { status, me } = useAuth();
  if (status === 'loading') return <Spinner />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  if (me?.user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/** Redirects the root path based on where the player actually stands. */
function RootRedirect() {
  const { status } = useAuth();
  if (status === 'loading') return <Spinner />;
  return <Navigate to={status === 'authenticated' ? '/dashboard' : '/beta'} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/beta" element={<BetaPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/beta-access"
            element={
              <RequireAuth>
                <BetaAccessPage />
              </RequireAuth>
            }
          />
          <Route
            path="/beta/success"
            element={
              <RequireAuth>
                <BetaSuccessPage />
              </RequireAuth>
            }
          />

          <Route
            element={
              <RequireWorldAccess>
                <Layout />
              </RequireWorldAccess>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route
              path="/map"
              element={
                <Suspense fallback={<Spinner label="Loading map…" />}>
                  <MapPage />
                </Suspense>
              }
            />
            <Route path="/land" element={<LandPage />} />
            <Route path="/markets" element={<MarketsPage />} />
            <Route path="/companies" element={<CompaniesPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            {/* Specified but not built — never a dead link (spec 85). */}
            <Route
              path="/government"
              element={
                <div className="mx-auto max-w-4xl px-4 py-10">
                  <ComingSoon feature="Governments, elections, laws and taxation" />
                </div>
              }
            />
          </Route>

          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <Layout />
              </RequireAdmin>
            }
          >
            <Route index element={<AdminPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
