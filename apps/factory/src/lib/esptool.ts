// The only file that touches Web Serial / esptool-js. Everything else talks to DeviceConnection.
import { ESPLoader, Transport, type FlashOptions } from "esptool-js";
import { md5 } from "js-md5";
import { parseChipDescription, parseFlashSize, type DeviceConnection } from "./connection.ts";

export const isWebSerialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

/** Prompts the operator to pick a serial port, then syncs with the ROM bootloader and uploads the flasher stub. */
export async function connectDevice(log: (line: string) => void, baudrate = 921600): Promise<DeviceConnection> {
  const port = await navigator.serial.requestPort();
  const transport = new Transport(port, false);

  let line = "";
  const loader = new ESPLoader({
    transport,
    baudrate,
    terminal: {
      clean: () => {},
      writeLine: (data) => log(data),
      // esptool-js streams progress dots through write(); buffer them into whole lines.
      write: (data) => {
        line += data;
        const lines = line.split("\n");
        line = lines.pop()!;
        lines.forEach(log);
      },
    },
  });

  try {
    await loader.main(); // reset into bootloader, detect chip, upload stub, switch baud rate
    const description = await loader.chip.getChipDescription(loader);
    const flashSize = await loader.detectFlashSize().catch(() => undefined);

    const info = {
      ...parseChipDescription(description),
      macAddress: (await loader.chip.readMac(loader)).toLowerCase(),
      chipFamily: loader.chip.CHIP_NAME,
      chipFeatures: await loader.chip.getChipFeatures(loader),
      crystalMhz: await loader.chip.getCrystalFreq(loader),
      flashSizeBytes: flashSize ? parseFlashSize(flashSize) : undefined,
    };

    return {
      info,
      eraseFlash: async () => {
        await loader.eraseFlash();
      },
      writeFlash: (files, settings, onProgress) =>
        loader.writeFlash({
          fileArray: files.map((file) => ({ data: file.data, address: file.address })),
          flashMode: settings.mode as FlashOptions["flashMode"],
          flashFreq: settings.freq as FlashOptions["flashFreq"],
          // "keep" leaves the size the bootloader image was built with.
          flashSize: "keep",
          eraseAll: false,
          compress: true,
          reportProgress: (fileIndex, written, total) => onProgress({ fileIndex, written, total }),
          // Makes esptool-js verify every region against the chip's own MD5 after writing.
          calculateMD5Hash: (image) => md5(image),
        }),
      reset: () => loader.after("hard_reset"),
      disconnect: () => transport.disconnect(),
    };
  } catch (error) {
    // esptool-js prints "Connecting..." and its retry marks without a newline: show them.
    if (line.trim()) log(line);
    await transport.disconnect().catch(() => {});
    throw error;
  }
}
