// The only file that touches Web Serial / esptool-js. Everything else talks to DeviceConnection.
import { ESPLoader, Transport, type FlashOptions } from "esptool-js";
import { md5 } from "js-md5";
import { parseChipDescription, parseFlashSize, type DeviceConnection } from "./connection.ts";

export const isWebSerialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resets an ESP32 from software by arming its RTC watchdog through the flasher stub. This works
 * on boards whose auto-reset circuit is missing or does not reach EN/IO0 from the USB bridge
 * (the ones where BOOT has to be held to enter download mode), where esptool's RTS-line hard
 * reset silently does nothing and the chip would sit in the bootloader until someone presses
 * EN. Register map: ESP-IDF soc/esp32/include/soc/rtc_cntl_reg.h. ESP32 only.
 */
async function watchdogReset(loader: ESPLoader): Promise<boolean> {
  if (loader.chip.CHIP_NAME !== "ESP32") return false;
  const RTC_CNTL = 0x3ff48000;
  const WDTCONFIG0 = RTC_CNTL + 0x8c;
  const WDTCONFIG1 = RTC_CNTL + 0x90;
  const WDTWPROTECT = RTC_CNTL + 0xa4;
  const WDT_WKEY = 0x50d83aa1;
  const WDT_EN = 1 << 31;
  const STG0_RESET_SYSTEM = 3 << 28; // stage 0 action: reset CPU + peripherals; strapping pins are re-sampled
  const RESET_LENGTHS = (7 << 11) | (7 << 14); // longest system / CPU reset pulses

  await loader.writeReg(WDTWPROTECT, WDT_WKEY); // unlock
  await loader.writeReg(WDTCONFIG1, 5000); // stage 0 timeout, RTC slow-clock ticks (~30 ms)
  await loader.writeReg(WDTCONFIG0, (WDT_EN | STG0_RESET_SYSTEM | RESET_LENGTHS) >>> 0);
  await loader.writeReg(WDTWPROTECT, 0).catch(() => {}); // may race the reset itself
  return true;
}

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
      reset: async () => {
        // Software reset first, because it needs no reset wiring; the RTS-line hard reset after
        // it is harmless on a chip that already rebooted and is the only option on other chips.
        let reset = false;
        try {
          reset = await watchdogReset(loader);
        } catch (error) {
          log(`! software reset failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (reset) {
          log("Reset via RTC watchdog");
          await sleep(200);
        }
        await loader.after("hard_reset").catch(() => {});
      },
      disconnect: () => transport.disconnect(),
    };
  } catch (error) {
    // esptool-js prints "Connecting..." and its retry marks without a newline: show them.
    if (line.trim()) log(line);
    await transport.disconnect().catch(() => {});
    throw error;
  }
}
