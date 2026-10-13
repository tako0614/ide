import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  AUTH_REQUIRED_EVENT,
  AUTH_SESSION_REFRESH_EVENT,
  getAuthSession,
  login,
  type AuthSession
} from '../api';
import './auth.css';

interface AuthGateProps {
  children: ReactNode;
}

const OAUTH_RETURN_PARAMETERS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'resource',
  'scope'
]);

function continueToSafeOAuthRequest(): boolean {
  const returnTo = new URLSearchParams(window.location.search).get('returnTo');
  if (!returnTo || !returnTo.startsWith('/oauth/authorize')) return false;
  try {
    const url = new URL(returnTo, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== '/oauth/authorize' || url.hash) return false;
    const seen = new Set<string>();
    for (const [key] of url.searchParams) {
      if (!OAUTH_RETURN_PARAMETERS.has(key) || seen.has(key)) return false;
      seen.add(key);
    }
    if (
      url.searchParams.get('response_type') !== 'code' ||
      !url.searchParams.get('client_id') ||
      !url.searchParams.get('redirect_uri') ||
      !url.searchParams.get('code_challenge') ||
      url.searchParams.get('code_challenge_method') !== 'S256'
    ) return false;
    window.location.assign(`${url.pathname}${url.search}`);
    return true;
  } catch {
    return false;
  }
}

export function AuthGate({ children }: AuthGateProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loadError, setLoadError] = useState('');

  const refreshSession = useCallback(() => {
    setSession(null);
    setLoadError('');
    void getAuthSession()
      .then((nextSession) => {
        setSession(nextSession);
        if (nextSession.authenticated) continueToSafeOAuthRequest();
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : '認証状態を確認できませんでした。');
      });
  }, []);

  useEffect(() => {
    const handleAuthRequired = () => {
      setSession({ authEnabled: true, authenticated: false });
      setLoadError('');
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    window.addEventListener(AUTH_SESSION_REFRESH_EVENT, refreshSession);
    refreshSession();
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
      window.removeEventListener(AUTH_SESSION_REFRESH_EVENT, refreshSession);
    };
  }, [refreshSession]);

  const handleLogin = useCallback(async (username: string, password: string) => {
    const nextSession = await login(username, password);
    setSession(nextSession);
    if (nextSession.authenticated) continueToSafeOAuthRequest();
  }, []);

  if (session === null) {
    return (
      <main className="auth-screen" aria-live="polite">
        <div className="auth-card">
          <h1 className="auth-title">Deck IDE</h1>
          <p className="auth-message">{loadError || '認証状態を確認しています…'}</p>
          {loadError && <button className="auth-button" type="button" onClick={refreshSession}>再試行</button>}
        </div>
      </main>
    );
  }

  if (!session.authEnabled || session.authenticated) return <>{children}</>;
  return <LoginForm onLogin={handleLogin} />;
}

function LoginForm({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await onLogin(username, password);
      setPassword('');
    } catch (loginError: unknown) {
      setError(loginError instanceof Error ? loginError.message : 'ログインできませんでした。');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-mark" aria-hidden="true">D</div>
        <h1 className="auth-title" id="auth-title">Deck IDE</h1>
        <p className="auth-message">続けるにはログインしてください。</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-label" htmlFor="auth-username">ユーザー名</label>
          <input
            id="auth-username"
            className="auth-input"
            type="text"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            autoFocus
          />
          <label className="auth-label" htmlFor="auth-password">パスワード</label>
          <input
            id="auth-password"
            className="auth-input"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="auth-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? '確認中…' : 'ログイン'}
          </button>
        </form>
      </section>
    </main>
  );
}
