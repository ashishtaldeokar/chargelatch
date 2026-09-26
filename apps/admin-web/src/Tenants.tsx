import { useEffect, useState, type FormEvent } from "react";
import type { Api, NewTenant, Tenant } from "./api.ts";

/**
 * Tenants: third parties that run charging transactions through the partner API. Each one is
 * a Keycloak service-account client (created in Keycloak with the `partner` role) mapped here
 * to an id, a name and a webhook URL.
 */
export function Tenants({ api }: { api: Api }) {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.listTenants().then((list) => active && setTenants(list), (e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [api]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const tenant: NewTenant = {
      id: String(data.get("id")).trim(),
      name: String(data.get("name")).trim(),
      keycloakClientId: String(data.get("keycloakClientId")).trim(),
      webhookUrl: String(data.get("webhookUrl")).trim() || null,
      meterValueIntervalSeconds: Number(data.get("meterValueIntervalSeconds")) || 30,
    };
    setSaving(true);
    setError(null);
    try {
      const created = await api.createTenant(tenant);
      setTenants((current) => [...(current ?? []), created]);
      form.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function update(id: string, patch: Partial<Omit<NewTenant, "id">>) {
    setError(null);
    try {
      const updated = await api.updateTenant(id, patch);
      setTenants((current) => current?.map((t) => (t.id === id ? updated : t)) ?? current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="card tenants">
      <h2>Tenants</h2>
      <p className="muted">
        A tenant is a partner platform with its own Keycloak service-account client (role <code>partner</code>). Its tokens may start and stop charging
        transactions on the devices assigned to it, and every transaction event is POSTed to its webhook URL.
      </p>

      <form onSubmit={(e) => void create(e)} aria-label="Add tenant">
        <label>
          Id
          <input name="id" required pattern="[a-z0-9][a-z0-9-]{1,31}" placeholder="sonik" title="lower-case slug" />
        </label>
        <label>
          Name
          <input name="name" required placeholder="Sonik" />
        </label>
        <label>
          Keycloak client id
          <input name="keycloakClientId" required placeholder="chargelatch-partner-sonik" />
        </label>
        <label>
          Meter values every (s)
          <input name="meterValueIntervalSeconds" type="number" min={5} max={3600} defaultValue={30} />
        </label>
        <label className="wide">
          Webhook URL
          <input name="webhookUrl" type="url" placeholder="https://partner.example.com/chargelatch/webhook" />
        </label>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Adding…" : "Add tenant"}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}
      {tenants === null && !error && <p className="muted">Loading…</p>}
      {tenants?.length === 0 && <p className="muted">No tenants yet.</p>}
      {tenants && tenants.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Keycloak client</th>
              <th>Webhook URL</th>
              <th>Meter values</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <TenantRow key={tenant.id} tenant={tenant} update={(patch) => update(tenant.id, patch)} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function TenantRow({ tenant, update }: { tenant: Tenant; update: (patch: Partial<Omit<NewTenant, "id">>) => Promise<void> }) {
  const [webhookUrl, setWebhookUrl] = useState(tenant.webhookUrl ?? "");
  const [interval, setInterval_] = useState(tenant.meterValueIntervalSeconds);
  const dirty = webhookUrl !== (tenant.webhookUrl ?? "") || interval !== tenant.meterValueIntervalSeconds;

  return (
    <tr>
      <td>
        <strong>{tenant.id}</strong>
      </td>
      <td>{tenant.name}</td>
      <td>
        <code>{tenant.keycloakClientId}</code>
      </td>
      <td>
        <input type="url" value={webhookUrl} aria-label={`${tenant.id} webhook URL`} placeholder="none: events are not delivered" onChange={(e) => setWebhookUrl(e.target.value)} />
      </td>
      <td className="actions-cell">
        <input type="number" min={5} max={3600} value={interval} aria-label={`${tenant.id} meter value interval`} onChange={(e) => setInterval_(Number(e.target.value))} style={{ width: "5rem" }} /> s{" "}
        <button disabled={!dirty} onClick={() => void update({ webhookUrl: webhookUrl.trim() || null, meterValueIntervalSeconds: interval })}>
          Save
        </button>
      </td>
    </tr>
  );
}
