import { WebStorageStateStore } from "oidc-client-ts";
import type { AuthProviderProps } from "react-oidc-context";

const keycloakUrl = import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080";
const realm = import.meta.env.VITE_KEYCLOAK_REALM ?? "chargelatch";

export const ADMIN_ROLE = "admin";

export const oidcConfig: AuthProviderProps = {
  authority: `${keycloakUrl}/realms/${realm}`,
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "chargelatch-admin-web",
  redirect_uri: window.location.origin + "/",
  post_logout_redirect_uri: window.location.origin + "/",
  scope: "openid profile email",
  // PKCE (S256) is oidc-client-ts's default for the code flow.
  automaticSilentRenew: true,
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  // Drop ?code=&state= from the URL after the redirect back from Keycloak.
  onSigninCallback: () => window.history.replaceState({}, document.title, window.location.pathname),
};

/** Realm roles from the access token. Display-only: the API verifies the token for real. */
export function realmRoles(accessToken: string | undefined): string[] {
  try {
    const payload = accessToken?.split(".")[1];
    if (!payload) return [];
    const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    return (JSON.parse(json) as { realm_access?: { roles?: string[] } }).realm_access?.roles ?? [];
  } catch {
    return [];
  }
}
