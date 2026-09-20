import { useMemo } from "react";
import { useAuth } from "react-oidc-context";
import { FACTORY_ROLE, realmRoles } from "./auth.ts";
import { createFactoryApi } from "./lib/api.ts";
import { connectDevice, isWebSerialSupported } from "./lib/esptool.ts";
import { loadFirmware } from "./lib/firmware.ts";
import { Station } from "./Station.tsx";

export function App() {
  const auth = useAuth();
  const token = auth.user?.access_token;
  // The api reads the token lazily so a silently renewed token is picked up mid-session.
  const api = useMemo(() => createFactoryApi(() => auth.user?.access_token), [auth.user]);

  let body;
  if (auth.isLoading) {
    body = <p className="muted">Signing in…</p>;
  } else if (auth.error) {
    body = (
      <section className="card">
        <p role="alert">Sign-in failed: {auth.error.message}</p>
        <button onClick={() => void auth.signinRedirect()}>Try again</button>
      </section>
    );
  } else if (!auth.isAuthenticated) {
    body = (
      <section className="card center">
        <h2>Sign in to flash devices</h2>
        <p className="muted">Issuing device identities requires a factory account.</p>
        <button className="primary" onClick={() => void auth.signinRedirect()}>
          Sign in
        </button>
      </section>
    );
  } else if (!realmRoles(token).includes(FACTORY_ROLE)) {
    body = (
      <section className="card">
        <p role="alert">
          {auth.user?.profile.email} does not have the <code>{FACTORY_ROLE}</code> role. Ask an administrator to grant it.
        </p>
      </section>
    );
  } else if (!isWebSerialSupported()) {
    body = (
      <section className="card">
        <p role="alert">This browser has no Web Serial support. Use Chrome or Edge on a desktop.</p>
      </section>
    );
  } else {
    body = <Station api={api} connect={connectDevice} loadFirmware={loadFirmware} />;
  }

  return (
    <>
      <header className="topbar">
        <h1>
          chargelatch <span>factory</span>
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
