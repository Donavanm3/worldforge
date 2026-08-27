import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button, Field } from '../components/ui.js';

function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <Link to="/beta" className="text-lg font-bold tracking-tight">
        WORLD<span className="text-accent-400">FORGE</span>
      </Link>
      <h1 className="mt-8 text-2xl font-semibold">{title}</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(identifier, password);
      navigate('/dashboard');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field
          label="Username or email"
          value={identifier}
          autoComplete="username"
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" loading={busy} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-sm text-slate-400">
        No account?{' '}
        <Link to="/register" className="text-accent-400 underline">
          Create one
        </Link>
      </p>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFields({});
    setBusy(true);
    try {
      await register(email, username, password);
      // Straight to the paywall: an account alone does not grant world access.
      navigate('/beta-access');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFields(caught.fieldErrors());
      } else {
        setError('Could not create your account.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create account">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field
          label="Email"
          type="email"
          value={email}
          autoComplete="email"
          error={fields['email']}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Field
          label="Username"
          value={username}
          autoComplete="username"
          error={fields['username']}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          autoComplete="new-password"
          error={fields['password']}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <p className="text-xs text-slate-500">At least 10 characters.</p>
        <Button type="submit" loading={busy} className="w-full">
          Create account
        </Button>
      </form>
      <p className="mt-6 text-sm text-slate-400">
        Already registered?{' '}
        <Link to="/login" className="text-accent-400 underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
