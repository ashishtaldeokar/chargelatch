import { useMemo } from "react";
import { useAuth } from "react-oidc-context";
import { createApi } from "./api.ts";
import { ADMIN_ROLE, realmRoles } from "./auth.ts";
import { Dashboard } from "./Dashboard.tsx";
import { createMqttFeed } from "./live.ts";

export function App() {
  const auth = useAuth();
  // The api reads the token lazily so a silently renewed token is picked up mid-session.
  const api = useMemo(() => createApi(() => auth.user?.access_token), [auth.user]);
  const feed = useMemo(() => createMqttFeed(), []);

  let body;
  if (auth.isLoading) {
    body = <p className="muted">Signing in…</p>;
  } else if (auth.error) {
    body = (
      <section className="card center">
        <p role="alert">Sign-in failed: {auth.error.message}</p>
        <button onClick={() => void auth.signinRedirect()}>Try again</button>
      </section>
    );
  } else if (!auth.isAuthenticated) {
    body = (
      <section className="card center">
        <h2>Sign in to manage devices</h2>
        <p className="muted">Switching contactors requires an administrator account.</p>
        <button className="primary" onClick={() => void auth.signinRedirect()}>
          Sign in
        </button>
      </section>
    );
  } else if (!realmRoles(auth.user?.access_token).includes(ADMIN_ROLE)) {
    body = (
      <section className="card center">
        <p role="alert">
          {auth.user?.profile.email} does not have the <code>{ADMIN_ROLE}</code> role.
        </p>
      </section>
    );
  } else {
    body = <Dashboard api={api} feed={feed} />;
  }

  return (
    <>
      <header className="topbar">
        <h1>
          chargelatch <span>admin</span>
        </h1>
        {auth.isAuthenticated && (
          <div className="user">
            <span>{auth.user?.profile.email}</span>
            <button onClick={() => void auth.signoutRedirect()}>Sign out</button>
          </div>
        )}
      </header>
      <main>{body}</main>
    </>
  );
}
