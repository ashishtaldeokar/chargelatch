import { expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { device, fakeBackend } from "../test/fakes.ts";
import { Dashboard } from "./Dashboard.tsx";

const show = (backend: ReturnType<typeof fakeBackend>) => render(<Dashboard api={backend.api} feed={backend.feed} />);

test("shows each device with its status, contactor state and meter readings", async () => {
  show(fakeBackend([device()]));

  const card = within(await screen.findByRole("article", { name: "SONIK-1" }));
  expect(card.getByText("online")).toBeInTheDocument();
  expect(card.getByText(/SDM120 @1/)).toBeInTheDocument();
  expect(card.getByTestId("relay-state")).toHaveTextContent("Open (off)");
  // The chart end-label repeats the latest power, so pin this to the readings list.
  expect(card.getByText("1,430 W", { selector: "dd" })).toBeInTheDocument();
  expect(card.getByText("230.5 V")).toBeInTheDocument();
  expect(card.getByText("1,234.76 kWh")).toBeInTheDocument();
  expect(screen.getByText("Live")).toBeInTheDocument();
});

test("switching the contactor sends the command over http and follows the state the device publishes", async () => {
  const backend = fakeBackend([device()]);
  show(backend);

  const toggle = await screen.findByRole("switch", { name: "SONIK-1 contactor" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  await userEvent.click(toggle);

  expect(backend.relayCalls).toEqual([["SONIK-1", true]]);
  expect(await screen.findByText("Closed (on)")).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-checked", "true");

  await userEvent.click(toggle);
  expect(backend.relayCalls).toEqual([["SONIK-1", true], ["SONIK-1", false]]);
  expect(await screen.findByText("Open (off)")).toBeInTheDocument();
});

test("a contactor switched by someone else shows up too", async () => {
  const backend = fakeBackend([device()]);
  show(backend);
  await screen.findByText("Open (off)");

  backend.deviceSays("SONIK-1", "relay", { on: true, id: "someone-elses-request" });
  expect(await screen.findByText("Closed (on)")).toBeInTheDocument();
  expect(backend.relayCalls).toEqual([]);
});

test("a command the device did not confirm leaves the switch where it was and says why", async () => {
  const backend = fakeBackend([device()], { failRelay: "SONIK-1 did not confirm the command in time" });
  show(backend);

  const toggle = await screen.findByRole("switch", { name: "SONIK-1 contactor" });
  await userEvent.click(toggle);

  expect(await screen.findByRole("alert")).toHaveTextContent("did not confirm the command in time");
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).toBeEnabled();
});

test("device messages update readings and online status without a reload", async () => {
  const backend = fakeBackend([device()]);
  show(backend);
  await screen.findByText("1,430 W");

  backend.deviceSays("SONIK-1", "meter", { model: "SDM120", phases: 1, ok: true, voltage: 229.8, current: 31.3, power: 7200, total_energy: 1240 });
  expect(await screen.findByText("7,200 W")).toBeInTheDocument();
  expect(screen.getByText("229.8 V")).toBeInTheDocument();

  // The broker publishes the last will when the device drops off.
  backend.deviceSays("SONIK-1", "status", { online: false });
  expect(await screen.findByText("offline")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "SONIK-1 contactor" })).toBeDisabled();
});

test("messages from identities that are not in the registry never create a device", async () => {
  const backend = fakeBackend([device()]);
  show(backend);
  await screen.findByRole("article", { name: "SONIK-1" });

  // Anyone can publish on the anonymous broker.
  backend.deviceSays("SONIK-666", "status", { online: true });
  backend.deviceSays("SONIK-666", "relay", { on: true });
  backend.deviceSays("SONIK-1", "relay", { on: "yes" }); // malformed: ignored by the shared reducer
  backend.deviceSays("SONIK-1", "meter", undefined); // not JSON

  await screen.findByText("Open (off)");
  expect(screen.queryByRole("article", { name: "SONIK-666" })).not.toBeInTheDocument();
});

test("a device flashed while the page is open appears once it starts talking", async () => {
  const backend = fakeBackend([device()]);
  show(backend);
  await screen.findByRole("article", { name: "SONIK-1" });
  expect(backend.listCalls()).toBe(1);

  backend.register(device({ identity: "SONIK-2", online: null, relay: null, meter: null }));
  backend.deviceSays("SONIK-2", "status", { online: true, firmware: "0.1.0" });

  const second = within(await screen.findByRole("article", { name: "SONIK-2" }));
  expect(second.getByText("No meter readings yet.")).toBeInTheDocument();
  expect(backend.listCalls()).toBe(2);

  // Unknown chatter cannot make the page hammer the API: the refetch is rate limited.
  backend.deviceSays("SONIK-666", "status", { online: true });
  backend.deviceSays("SONIK-667", "status", { online: true });
  expect(backend.listCalls()).toBe(2);
});

test("the power chart is seeded from stored readings and grows with live ones", async () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const backend = fakeBackend([device({ meter: null })], { power: { "SONIK-1": [{ time: minutesAgo(8), power: 1000 }, { time: minutesAgo(4), power: 1200 }] } });
  const { container } = show(backend);

  const figure = await screen.findByRole("figure", { name: "Active power, last 10 minutes" });
  expect(await within(figure).findByText("1,200 W")).toBeInTheDocument();
  expect(container.querySelectorAll("path.line")).toHaveLength(1);

  backend.deviceSays("SONIK-1", "meter", { model: "SDM120", phases: 1, ok: true, power: 7200 });
  expect(await within(figure).findByText("7,200 W")).toBeInTheDocument();
});

test("an offline device cannot be switched", async () => {
  show(fakeBackend([device({ online: false })]));
  expect(await screen.findByRole("switch", { name: "SONIK-1 contactor" })).toBeDisabled();
  expect(screen.getByText("offline")).toBeInTheDocument();
});

test("an unreadable meter is reported, and old readings are marked as not live", async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  show(
    fakeBackend([
      device({ identity: "SONIK-1", meter: { model: "SDM120", phases: 1, ok: false, error: "timeout", values: {}, receivedAt: new Date().toISOString() } }),
      device({ identity: "SONIK-2", meter: { ...device().meter!, receivedAt: old } }),
    ]),
  );
  expect(within(await screen.findByRole("article", { name: "SONIK-1" })).getByRole("alert")).toHaveTextContent("Meter not readable (timeout)");
  expect(within(screen.getByRole("article", { name: "SONIK-2" })).getByText(/no longer live/)).toBeInTheDocument();
});

test("says when the broker connection is down, and disconnects when unmounted", async () => {
  const backend = fakeBackend([device()]);
  const { unmount } = show(backend);
  await screen.findByText("Live");

  backend.setConnected(false);
  expect(await screen.findByText("Connecting…")).toBeInTheDocument();

  unmount();
  expect(backend.watching()).toBe(false);
});
