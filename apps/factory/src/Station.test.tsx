import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fakeApi, fakeConnection, firmware } from "../test/fakes.ts";
import { Station } from "./Station.tsx";

test("flashes a device and shows the identity to label it with", async () => {
  const { connection, calls } = fakeConnection();
  render(<Station api={fakeApi().api} connect={async () => connection} loadFirmware={async () => firmware} />);

  await screen.findByText("chargelatch_firmware 0.1.0");
  await userEvent.click(screen.getByRole("button", { name: "Connect & flash device" }));

  expect(await screen.findByText(/Flashed and verified\. Label the unit SONIK-1/)).toBeInTheDocument();
  expect(screen.getByTestId("identity")).toHaveTextContent("SONIK-1");
  expect(screen.getByText("24:6f:28:aa:bb:cc", { selector: "dd" })).toBeInTheDocument();
  expect(calls).toEqual(["erase", "write", "reset", "disconnect"]);
  // The device shows up in the recent list, and the station is ready for the next one.
  expect(await screen.findByRole("cell", { name: "SONIK-1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Flash next device" })).toBeEnabled();
});

test("shows the failure and always releases the serial port", async () => {
  const { connection, calls } = fakeConnection();
  connection.writeFlash = async () => {
    throw new Error("Timed out waiting for packet");
  };
  render(<Station api={fakeApi().api} connect={async () => connection} loadFirmware={async () => firmware} />);

  await screen.findByText("chargelatch_firmware 0.1.0");
  await userEvent.click(screen.getByRole("button", { name: "Connect & flash device" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Timed out waiting for packet");
  expect(calls).toContain("disconnect");
});

test("a chip that will not enter download mode gets the BOOT-button instructions", async () => {
  render(
    <Station
      api={fakeApi().api}
      connect={async () => Promise.reject(new Error("Failed to connect with the device"))}
      loadFirmware={async () => firmware}
    />,
  );
  await screen.findByText("chargelatch_firmware 0.1.0");
  await userEvent.click(screen.getByRole("button", { name: "Connect & flash device" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/Hold the BOOT \(IO0\) button/);
  expect(screen.getByRole("button", { name: "Flash next device" })).toBeEnabled();
});

test("explains a missing firmware bundle and keeps flashing disabled", async () => {
  render(
    <Station
      api={fakeApi().api}
      connect={async () => fakeConnection().connection}
      loadFirmware={async () => Promise.reject(new Error("No firmware bundle found. Run `pnpm firmware:build && pnpm firmware:bundle`."))}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("No firmware bundle found");
  expect(screen.getByRole("button", { name: "Connect & flash device" })).toBeDisabled();
});
