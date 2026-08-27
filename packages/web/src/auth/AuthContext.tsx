import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, clearSession, getRefreshToken, storeSession } from '../api/client.js';
import type { MeResponse } from '../api/types.js';

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  me: MeResponse | null;
  login: (identifier: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);

  const loadMe = useCallback(async () => {
    try {
      const profile = await api.me();
      setMe(profile);
      setStatus('authenticated');
    } catch {
      clearSession();
      setMe(null);
      setStatus('anonymous');
    }
  }, []);

  // On boot the access token is gone (it lives in memory only), but a refresh
  // token in storage means the session can be resumed silently.
  useEffect(() => {
    if (!getRefreshToken()) {
      setStatus('anonymous');
      return;
    }
    void loadMe();
  }, [loadMe]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      storeSession(await api.login({ identifier, password }));
      await loadMe();
    },
    [loadMe],
  );

  const register = useCallback(
    async (email: string, username: string, password: string) => {
      storeSession(await api.register({ email, username, password }));
      await loadMe();
    },
    [loadMe],
  );

  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      // Best-effort: revoke server-side, but always clear locally.
      try {
        await api.logout(refreshToken);
      } catch {
        /* already invalid */
      }
    }
    clearSession();
    setMe(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, me, login, register, logout, refresh: loadMe }),
    [status, me, login, register, logout, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return context;
}
