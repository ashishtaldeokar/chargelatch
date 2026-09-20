import { expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { device, fakeApi } from "../test/fakes.ts";
import { Dashboard } from "./Dashboard.tsx";

test("shows each device with its status, contactor state and meter readings", async () => {
  render(<Dashboard api={fakeApi([device()]).api} />);

  const card = within(await screen.findByRole("article", { name: "SONIK-1" }));
  expect(card.getByText("online")).toBeInTheDocument();
  expect(card.getByTestId("relay-state")).toHaveTextContent("Open (off)");
  expect(card.getByText("1,430 W")).toBeInTheDocument();
  expect(card.getByText("230.5 V")).toBeInTheDocument();
  expect(card.getByText("1,234.76 kWh")).toBeInTheDocument();
  expect(screen.getByText("Live")).toBeInTheDocument();
});

test("switching the contactor sends the command and follows the state the device reports", async () => {
  const fake = fakeApi([device()]);
  render(<Dashboard api={fake.api} />);

  const toggle = await screen.findByRole("switch", { name: "SONIK-1 contactor" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  await userEvent.click(toggle);

  expect(fake.relayCalls).toEqual([["SONIK-1", true]]);
  expect(await screen.findByText("Closed (on)")).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-checked", "true");

  await userEvent.click(toggle);
  expect(fake.relayCalls).toEqual([["SONIK-1", true], ["SONIK-1", false]]);
  expect(await screen.findByText("Open (off)")).toBeInTheDocument();
});

test("a command the device did not confirm leaves the switch where it was and says why", async () => {
  const fake = fakeApi([device()], { failRelay: "SONIK-1 did not confirm the command in time" });
  render(<Dashboard api={fake.api} />);

  const toggle = await screen.findByRole("switch", { name: "SONIK-1 contactor" });
  await userEvent.click(toggle);

  expect(await screen.findByRole("alert")).toHaveTextContent("did not confirm the command in time");
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).toBeEnabled();
});

test("an offline device cannot be switched", async () => {
  render(<Dashboard api={fakeApi([device({ online: false })]).api} />);
  expect(await screen.findByRole("switch", { name: "SONIK-1 contactor" })).toBeDisabled();
  expect(screen.getByText("offline")).toBeInTheDocument();
});

test("live updates change readings, status and contactor state without a reload", async () => {
  const fake = fakeApi([device()]);
  render(<Dashboard api={fake.api} />);
  await screen.findByText("1,430 W");

  const base = device();
  fake.push({ ...base, relay: { on: true, updatedAt: new Date().toISOString() }, meter: { ...base.meter!, values: { ...base.meter!.values, power: 7200 } } });
  expect(await screen.findByText("7,200 W")).toBeInTheDocument();
  expect(screen.getByText("Closed (on)")).toBeInTheDocument();

  // A device flashed while the page is open appears by itself.
  fake.push(device({ identity: "SONIK-2", meter: null, relay: null }));
  const second = within(await screen.findByRole("article", { name: "SONIK-2" }));
  expect(second.getByText("No meter readings yet.")).toBeInTheDocument();
  expect(second.getByTestId("relay-state")).toHaveTextContent("State unknown");
});

test("an unreadable meter is reported, and old readings are marked as not live", async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  render(
    <Dashboard
      api={
        fakeApi([
          device({ identity: "SONIK-1", meter: { model: "SDM120", phases: 1, ok: false, error: "timeout", values: {}, receivedAt: new Date().toISOString() } }),
          device({ identity: "SONIK-2", meter: { ...device().meter!, receivedAt: old } }),
        ]).api
      }
    />,
  );
  expect(within(await screen.findByRole("article", { name: "SONIK-1" })).getByRole("alert")).toHaveTextContent("Meter not readable (timeout)");
  expect(within(screen.getByRole("article", { name: "SONIK-2" })).getByText(/no longer live/)).toBeInTheDocument();
});

test("says when live updates are down, and stops watching when unmounted", async () => {
  const fake = fakeApi([device()]);
  const { unmount } = render(<Dashboard api={fake.api} />);
  await screen.findByText("Live");

  fake.setConnected(false);
  expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();

  unmount();
  expect(fake.watching()).toBe(false);
});
