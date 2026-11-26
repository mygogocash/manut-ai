/// Reading the Mac's QR code with the phone's camera, where the browser can: its own `BarcodeDetector` (the Shape
/// Detection API), which Chrome on Android has. Safari on an iPhone does not offer it, so there the tab offers the
/// pasted link only (docs/remote-access.md, "The phone's side"). No reader of our own is shipped: one that fits and
/// reads nothing from the network is a later choice for the owner, written down there.
///
/// The camera is asked for only when the person presses Scan, so the browser's own permission prompt is theirs to
/// answer; it is stopped as soon as a code is read, or Cancel is pressed, or the tab goes away. No frame is kept or sent.

/// What the tab needs of a scanner, so a test can stand in for the camera.
export interface Scanner {
  readonly available: boolean;
  /// Reads one QR code from the camera into `video`, or resolves null when stopped or refused.
  scan(video: HTMLVideoElement, signal: AbortSignal): Promise<string | null | "refused">;
}

interface Detected {
  readonly rawValue: string;
}

interface Detector {
  detect(source: HTMLVideoElement): Promise<Detected[]>;
}

interface DetectorClass {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats?(): Promise<string[]>;
}

const SCAN_EVERY_MS = 250;

function detectorClass(): DetectorClass | null {
  const found = typeof window === "undefined" ? undefined : (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  return typeof found === "function" ? found : null;
}

/// The browser's own reader, or none. Whether it reads QR codes is asked once, before the button shows.
export async function browserScanner(): Promise<Scanner> {
  const Reader = detectorClass();
  const camera = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
  let qr = false;
  try {
    qr = !!Reader && camera && (Reader.getSupportedFormats ? (await Reader.getSupportedFormats()).includes("qr_code") : true);
  } catch {
    qr = false;
  }
  if (!Reader || !qr) return { available: false, scan: async () => null };
  return {
    available: true,
    scan: async (video, signal) => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        return "refused";
      }
      const stop = () => {
        for (const track of stream.getTracks()) track.stop();
        video.srcObject = null;
      };
      if (signal.aborted) {
        stop();
        return null;
      }
      try {
        video.srcObject = stream;
        await video.play();
        const detector = new Reader({ formats: ["qr_code"] });
        while (!signal.aborted) {
          const found = await detector.detect(video).catch(() => [] as Detected[]);
          const value = found.find((code) => typeof code.rawValue === "string" && code.rawValue.length > 0)?.rawValue;
          if (value) return value;
          await new Promise<void>((resolve) => setTimeout(resolve, SCAN_EVERY_MS));
        }
        return null;
      } catch {
        return "refused";
      } finally {
        stop();
      }
    },
  };
}
