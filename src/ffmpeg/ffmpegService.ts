import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

export type CoreDownloadProgress = {
  loaded: number;
  total?: number;
  ratio?: number;
};

export type TranscodeProgress = {
  ratio: number;      // 0..1
  timeUs?: number;    // microseconds (best effort)
};

export type ConvertOptions = {
  videoKbps: number;
  audioKbps: number;
  includeAudio: boolean;
  trimStartSec?: number;
  trimEndSec?: number;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type ThumbnailFrame = {
  timeSec: number;
  bytes: Uint8Array;
};

export type PreviewProxyOptions = {
  width?: number;
  fps?: number;
  videoKbps?: number;
};

type WebmAttemptProfile = {
  label: string;
  width?: number;
  fps: number;
  videoKbps: number;
  audioKbps: number;
  audioCodec: "libvorbis" | "libopus";
  audioSampleRate: number;
  includeAudio: boolean;
};

const CORE_LOAD_TIMEOUT_MS = 120_000;

export class FfmpegService {
  private ffmpeg = new FFmpeg();
  private loaded = false;

  private onCoreProgress?: (p: CoreDownloadProgress) => void;
  private onTranscodeProgress?: (p: TranscodeProgress) => void;
  private onLog?: (line: string) => void;

  public isLoaded(): boolean {
    return this.loaded;
  }

  public setHandlers(handlers: {
    onCoreProgress?: (p: CoreDownloadProgress) => void;
    onTranscodeProgress?: (p: TranscodeProgress) => void;
    onLog?: (line: string) => void;
  }) {
    this.onCoreProgress = handlers.onCoreProgress;
    this.onTranscodeProgress = handlers.onTranscodeProgress;
    this.onLog = handlers.onLog;
  }

  public async load(): Promise<void> {
    if (this.loaded) return;

    this.ffmpeg.on("log", ({ message }) => {
      this.onLog?.(message);
    });

    this.ffmpeg.on("progress", ({ progress, time }) => {
      const ratio = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
      this.onTranscodeProgress?.({ ratio, timeUs: time });
    });

    const { coreURL, wasmURL } = this.getCoreAssetUrls();
    this.onCoreProgress?.({ loaded: 0, total: 1, ratio: 0 });
    const ac = new AbortController();
    const timeoutId = globalThis.setTimeout(() => ac.abort(), CORE_LOAD_TIMEOUT_MS);

    try {
      await this.ffmpeg.load({ coreURL, wasmURL }, { signal: ac.signal });
    } catch (err) {
      if (ac.signal.aborted) {
        throw new Error(`FFmpeg core load timed out after ${Math.round(CORE_LOAD_TIMEOUT_MS / 1000)}s.`);
      }
      throw err;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }

    this.onCoreProgress?.({ loaded: 1, total: 1, ratio: 1 });
    this.loaded = true;
  }

  public cancelAndReset(): void {
    // Terminates worker and aborts ongoing operations. Next call must load() again.
    this.ffmpeg.terminate();
    this.loaded = false;

    // Create a new instance to ensure a clean event state.
    this.ffmpeg = new FFmpeg();
  }

  public async convertToWebm(file: File, opts: ConvertOptions): Promise<Uint8Array> {
    if (!this.loaded) throw new Error("FFmpeg is not loaded yet.");

    const safeInput = this.safeName(file.name) || "input";
    const inputName = `input_${Date.now()}_${safeInput}`;
    const outputName = `output_${Date.now()}.webm`;
    const attempts = this.buildAttemptProfiles(opts);
    let lastError: unknown;

    if (opts.includeAudio) {
      this.onLog?.("[convert] Using WebM Vorbis audio path to avoid known wasm libopus crashes.");
    }

    try {
      for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i];
        const index = i + 1;
        this.onLog?.(`[convert] Attempt ${index}/${attempts.length}: ${attempt.label}`);

        try {
          const args = this.buildWebmArgs(inputName, outputName, attempt, opts);
          await this.ffmpeg.writeFile(inputName, await fetchFile(file));
          await this.ffmpeg.exec(args);
          const out = await this.ffmpeg.readFile(outputName);
          return out instanceof Uint8Array ? out : new Uint8Array(out as any);
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : String(err);
          this.onLog?.(`[convert] Attempt ${index} failed: ${msg}`);

          await this.safeDelete(inputName);
          await this.safeDelete(outputName);

          if (i < attempts.length - 1) {
            this.onLog?.("[convert] Resetting FFmpeg runtime before retry...");
            this.cancelAndReset();
            await this.load();
          }
        }
      }
    } finally {
      await this.safeDelete(inputName);
      await this.safeDelete(outputName);
    }

    throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? "Conversion failed.")));
  }

  public async generateThumbnails(file: File, timesSec: number[]): Promise<ThumbnailFrame[]> {
    if (!this.loaded) throw new Error("FFmpeg is not loaded yet.");
    if (timesSec.length === 0) return [];

    const safeInput = this.safeName(file.name) || "input";
    const inputName = `thumb_input_${Date.now()}_${safeInput}`;
    const outPrefix = `thumb_${Date.now()}`;
    const frames: ThumbnailFrame[] = [];

    await this.ffmpeg.writeFile(inputName, await fetchFile(file));

    try {
      for (let i = 0; i < timesSec.length; i++) {
        const timeSec = Math.max(0, timesSec[i]);
        const outputName = `${outPrefix}_${i}.jpg`;
        const args = [
          "-ss", timeSec.toFixed(3),
          "-i", inputName,
          "-frames:v", "1",
          "-vf", "scale=240:-2:flags=fast_bilinear",
          "-q:v", "5",
          "-an",
          outputName
        ];

        try {
          await this.ffmpeg.exec(args);
          const out = await this.ffmpeg.readFile(outputName);
          const bytes = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
          if (bytes.byteLength > 0) {
            frames.push({ timeSec, bytes });
          }
        } finally {
          await this.safeDelete(outputName);
        }
      }
    } finally {
      await this.safeDelete(inputName);
    }

    return frames;
  }

  public async createPreviewProxyWebm(
    file: File,
    opts: PreviewProxyOptions = {}
  ): Promise<Uint8Array> {
    if (!this.loaded) throw new Error("FFmpeg is not loaded yet.");

    const width = Math.max(240, Math.floor(opts.width ?? 640));
    const fps = Math.max(8, Math.floor(opts.fps ?? 24));
    const videoKbps = Math.max(200, Math.floor(opts.videoKbps ?? 700));

    const safeInput = this.safeName(file.name) || "input";
    const inputName = `preview_input_${Date.now()}_${safeInput}`;
    const outputName = `preview_output_${Date.now()}.webm`;

    await this.ffmpeg.writeFile(inputName, await fetchFile(file));

    try {
      const args = [
        "-i", inputName,
        "-vf", `fps=${fps},scale=${width}:-2:flags=fast_bilinear`,
        "-c:v", "libvpx",
        "-b:v", `${videoKbps}k`,
        "-deadline", "realtime",
        "-cpu-used", "8",
        "-lag-in-frames", "0",
        "-error-resilient", "1",
        "-an",
        outputName
      ];

      await this.ffmpeg.exec(args);
      const out = await this.ffmpeg.readFile(outputName);
      return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
    } finally {
      await this.safeDelete(inputName);
      await this.safeDelete(outputName);
    }
  }

  private async safeDelete(path: string): Promise<void> {
    try {
      await this.ffmpeg.deleteFile(path);
    } catch {
      // ignore
    }
  }

  private safeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  }

  private buildAttemptProfiles(opts: ConvertOptions): WebmAttemptProfile[] {
    const v = Math.max(1, Math.round(opts.videoKbps));
    const a = Math.max(1, Math.round(opts.audioKbps));

    return [
      {
        label: "wasm-stable profile (vp8 + vorbis)",
        fps: 30,
        videoKbps: v,
        audioKbps: a,
        audioCodec: "libvorbis",
        audioSampleRate: 44_100,
        includeAudio: opts.includeAudio
      },
      {
        label: "fallback 960w@24fps (vorbis)",
        width: 960,
        fps: 24,
        videoKbps: Math.min(v, 1100),
        audioKbps: Math.min(a, 96),
        audioCodec: "libvorbis",
        audioSampleRate: 44_100,
        includeAudio: opts.includeAudio
      },
      {
        label: "fallback 640w@24fps (vorbis)",
        width: 640,
        fps: 24,
        videoKbps: Math.min(v, 700),
        audioKbps: Math.min(a, 64),
        audioCodec: "libvorbis",
        audioSampleRate: 44_100,
        includeAudio: opts.includeAudio
      },
      {
        label: "emergency 480w@20fps (no audio)",
        width: 480,
        fps: 20,
        videoKbps: Math.min(v, 500),
        audioKbps: 0,
        audioCodec: "libvorbis",
        audioSampleRate: 44_100,
        includeAudio: false
      }
    ];
  }

  private buildWebmArgs(
    inputName: string,
    outputName: string,
    p: WebmAttemptProfile,
    opts: ConvertOptions
  ): string[] {
    const vfParts: string[] = [];

    if (opts.crop) {
      const x = Math.max(0, Math.floor(opts.crop.x));
      const y = Math.max(0, Math.floor(opts.crop.y));
      const w = Math.max(2, Math.floor(opts.crop.width));
      const h = Math.max(2, Math.floor(opts.crop.height));
      vfParts.push(`crop=${w}:${h}:${x}:${y}`);
    }

    vfParts.push(`fps=${p.fps}`);
    if (p.width) vfParts.push(`scale=${p.width}:-2:flags=fast_bilinear`);

    const args: string[] = ["-i", inputName];

    if (Number.isFinite(opts.trimStartSec) && (opts.trimStartSec as number) > 0) {
      args.push("-ss", (opts.trimStartSec as number).toFixed(3));
    }

    if (Number.isFinite(opts.trimEndSec) && (opts.trimEndSec as number) > 0) {
      args.push("-to", (opts.trimEndSec as number).toFixed(3));
    }

    args.push(
      "-vf", vfParts.join(","),
      "-c:v", "libvpx",
      "-b:v", `${p.videoKbps}k`,
      "-threads", "1",
      "-deadline", "realtime",
      "-cpu-used", "8",
      "-lag-in-frames", "0",
      "-error-resilient", "1",
      "-g", "120",
      "-pix_fmt", "yuv420p"
    );

    if (p.includeAudio) {
      args.push(
        "-c:a", p.audioCodec,
        "-b:a", `${p.audioKbps}k`,
        "-ar", `${p.audioSampleRate}`,
        "-ac", "2"
      );
    } else {
      args.push("-an");
    }

    args.push(outputName);
    return args;
  }

  private getCoreAssetUrls(): { coreURL: string; wasmURL: string } {
    const base = new URL(document.baseURI);
    const coreURL = new URL("ffmpeg-core/ffmpeg-core.js", base).toString();
    const wasmURL = new URL("ffmpeg-core/ffmpeg-core.wasm", base).toString();

    return { coreURL, wasmURL };
  }
}
