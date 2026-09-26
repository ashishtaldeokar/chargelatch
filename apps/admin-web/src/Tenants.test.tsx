import { expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { device, fakeBackend } from "../test/fakes.ts";
import { Tenants } from "./Tenants.tsx";

test("lists tenants and adds one through the form", async () => {
  const backend = fakeBackend([device()]);
  render(<Tenants api={backend.api} />);

  expect(await screen.findByText("chargelatch-partner-sonik")).toBeInTheDocument();

  const form = within(screen.getByRole("form", { name: "Add tenant" }));
  await userEvent.type(form.getByLabelText("Id"), "acme");
  await userEvent.type(form.getByLabelText("Name"), "Acme Charging");
  await userEvent.type(form.getByLabelText("Keycloak client id"), "chargelatch-partner-acme");
  await userEvent.type(form.getByLabelText("Webhook URL"), "https://acme.example/hook");
  await userEvent.click(form.getByRole("button", { name: "Add tenant" }));

  expect(await screen.findByRole("cell", { name: "Acme Charging" })).toBeInTheDocument();
  expect(backend.tenants.at(-1)).toMatchObject({ id: "acme", name: "Acme Charging", keycloakClientId: "chargelatch-partner-acme", webhookUrl: "https://acme.example/hook", meterValueIntervalSeconds: 30 });
  expect(form.getByLabelText("Id")).toHaveValue(""); // form cleared for the next one
});

test("an empty webhook is stored as null, and API errors are shown", async () => {
  const backend = fakeBackend([device()], { failTenant: "A tenant with that id or Keycloak client already exists" });
  render(<Tenants api={backend.api} />);
  const form = within(await screen.findByRole("form", { name: "Add tenant" }));
  await userEvent.type(form.getByLabelText("Id"), "sonik");
  await userEvent.type(form.getByLabelText("Name"), "Dup");
  await userEvent.type(form.getByLabelText("Keycloak client id"), "x");
  await userEvent.click(form.getByRole("button", { name: "Add tenant" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
});

test("the webhook URL and interval of an existing tenant can be changed inline", async () => {
  const backend = fakeBackend([device()]);
  render(<Tenants api={backend.api} />);
  const url = await screen.findByLabelText("sonik webhook URL");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();

  await userEvent.clear(url);
  await userEvent.type(url, "https://sonik.example/v2/hook");
  await userEvent.clear(screen.getByLabelText("sonik meter value interval"));
  await userEvent.type(screen.getByLabelText("sonik meter value interval"), "15");
  expect(save).toBeEnabled();
  await userEvent.click(save);

  expect(backend.tenants[0]).toMatchObject({ webhookUrl: "https://sonik.example/v2/hook", meterValueIntervalSeconds: 15 });
  expect(await screen.findByRole("button", { name: "Save" })).toBeDisabled();
});
