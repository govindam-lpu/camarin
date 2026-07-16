import { Aperture } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export function AuthPage() {
  const { user, ready, login, signup } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (mode === 'login' ? login(email, password) : signup(email, password));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong — try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      {/* The safelight: one warm glow in the dark. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80"
        style={{
          background:
            'radial-gradient(600px 300px at 50% -40px, rgba(242,163,60,0.14), transparent 70%)',
        }}
      />

      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex size-12 items-center justify-center rounded-xl border border-amber/30 bg-amber/10 text-amber">
            <Aperture size={24} />
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Darkroom</h1>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted">
            Drop in images. The pipeline develops a caption, labels, and a safety verdict for each
            one.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-xl border border-edge bg-surface p-6 shadow-xl shadow-black/30"
        >
          <div className="flex gap-1 rounded-md border border-edge bg-bg p-1">
            {(['login', 'signup'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`flex-1 rounded px-3 py-1.5 font-mono text-xs font-medium uppercase tracking-wider transition-colors ${
                  mode === m ? 'bg-raised text-ink' : 'text-faint hover:text-muted'
                }`}
              >
                {m === 'login' ? 'Log in' : 'Sign up'}
              </button>
            ))}
          </div>

          <label className="mt-5 block">
            <span className="font-mono text-xs uppercase tracking-wider text-muted">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-edge bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-amber/60"
              placeholder="you@example.com"
            />
          </label>

          <label className="mt-4 block">
            <span className="font-mono text-xs uppercase tracking-wider text-muted">Password</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-edge bg-bg px-3 py-2 text-sm placeholder:text-faint focus:border-amber/60"
              placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
            />
          </label>

          {error && (
            <p role="alert" className="mt-4 rounded-md bg-alarm/10 px-3 py-2 text-sm text-alarm">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-md bg-amber px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-amber/90 disabled:opacity-60"
          >
            {busy ? 'One moment…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>

        <p className="mt-6 text-center font-mono text-[11px] uppercase tracking-wider text-faint">
          Async media pipeline · caption / labels / safety
        </p>
      </div>
    </div>
  );
}
