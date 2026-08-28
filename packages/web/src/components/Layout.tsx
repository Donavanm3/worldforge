import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.js';
import { formatMoney } from '../lib/format.js';

/**
 * Primary navigation (spec 46). Sections that exist as routes but have no
 * implementation render a Coming Soon panel rather than a dead link.
 */
const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/map', label: 'Map' },
  { to: '/land', label: 'Land' },
  { to: '/buildings', label: 'Buildings' },
  { to: '/markets', label: 'Markets' },
  { to: '/companies', label: 'Companies' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/government', label: 'Government' },
];

export function Layout() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/beta');
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-ink-600 bg-ink-800">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <NavLink to="/dashboard" className="text-lg font-bold tracking-tight">
            WORLD<span className="text-accent-400">FORGE</span>
          </NavLink>

          <nav className="flex flex-1 flex-wrap gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm transition ${
                    isActive
                      ? 'bg-ink-600 text-slate-100'
                      : 'text-slate-400 hover:bg-ink-700 hover:text-slate-200'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            {me?.user.role === 'admin' && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm transition ${
                    isActive ? 'bg-accent-600 text-ink-900' : 'text-accent-400 hover:bg-ink-700'
                  }`
                }
              >
                Admin
              </NavLink>
            )}
          </nav>

          <div className="flex items-center gap-3 text-sm">
            {me?.profile && (
              <span className="font-mono text-gain">{formatMoney(me.profile.balance)}</span>
            )}
            <span className="text-slate-300">{me?.user.username}</span>
            {me?.user.betaAccess && (
              <span
                title="Purchased or granted beta access"
                className="rounded bg-accent-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-400"
              >
                Beta Tester
              </span>
            )}
            <button onClick={onLogout} className="text-slate-400 underline hover:text-slate-200">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
