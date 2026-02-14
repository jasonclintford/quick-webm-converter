import "./styles.css";
import { FfmpegService, type ConvertOptions } from "./ffmpeg/ffmpegService";
import { estimateBytesFromKbps, formatBytes } from "./lib/estimate";
import {
  DEFAULT_MIN_CLIP_SEC,
  clamp,
  clampCropRect,
  cropNormToPixels,
  fitCropToAspect,
  formatSeconds,
  isFullFrameCrop,
  normalizeTrimRange,
  type CropRectNorm
} from "./lib/editing";

type Thumbnail = {
  timeSec: number;
  dataUrl: string;
};

type CropAspectPreset = "free" | "16:9" | "9:16" | "1:1" | "4:3";
type CropDragMode = "move" | "nw" | "ne" | "sw" | "se";

type AppState = {
  file?: File;
  inputUrl?: string;
  previewUrl?: string;
  previewIsProxy: boolean;
  durationSec?: number;
  width?: number;
  height?: number;

  ffmpegLoaded: boolean;
  coreLoading: boolean;
  coreDownloadRatio: number;
  coreLoadingIndeterminate: boolean;
  transcodeRatio: number;
  busy: boolean;

  videoKbps: number;
  audioKbps: number;
  includeAudio: boolean;

  trimEnabled: boolean;
  trimStartSec: number;
  trimEndSec: number;
  thumbnails: Thumbnail[];
  thumbsBusy: boolean;

  cropEnabled: boolean;
  cropAspect: CropAspectPreset;
  cropRect: CropRectNorm;

  outputUrl?: string;
  outputBytes?: number;

  status: string;
  logs: string[];
};

type CropDragSession = {
  pointerId: number;
  mode: CropDragMode;
  startX: number;
  startY: number;
  startRect: CropRectNorm;
};

const ffmpeg = new FfmpegService();
const THUMBNAIL_COUNT = 10;
const DEFAULT_CROP_RECT: CropRectNorm = { x: 0, y: 0, width: 1, height: 1 };

const state: AppState = {
  previewIsProxy: false,
  ffmpegLoaded: false,
  coreLoading: false,
  coreDownloadRatio: 0,
  coreLoadingIndeterminate: false,
  transcodeRatio: 0,
  busy: false,
  videoKbps: 1600,
  audioKbps: 128,
  includeAudio: true,
  trimEnabled: true,
  trimStartSec: 0,
  trimEndSec: 0,
  thumbnails: [],
  thumbsBusy: false,
  cropEnabled: true,
  cropAspect: "free",
  cropRect: { ...DEFAULT_CROP_RECT },
  status: "Select a file to begin.",
  logs: []
};

let trimDragHandle: "start" | "end" | null = null;
let trimDragPointerId: number | null = null;
let cropDrag: CropDragSession | null = null;
let thumbnailToken = 0;
let coreLoadPromise: Promise<void> | null = null;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

function setStatus(msg: string) {
  state.status = msg;
  el<HTMLDivElement>("status").textContent = msg;
}

function pushLog(line: string) {
  state.logs.push(line);
  if (state.logs.length > 200) state.logs.shift();
  el<HTMLPreElement>("logs").textContent = state.logs.join("\n");
}

function setProgress(id: string, ratio: number) {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const bar = el<HTMLDivElement>(id);
  bar.style.width = `${pct}%`;

  const label = el<HTMLSpanElement>(`${id}-label`);
  if (id === "coreBar" && state.coreLoadingIndeterminate) {
    label.textContent = `Loading... ${pct}%`;
  } else {
    label.textContent = `${pct}%`;
  }
}

function setCoreLoadingIndeterminate(active: boolean) {
  state.coreLoadingIndeterminate = active;
  el<HTMLDivElement>("coreProgress").classList.toggle("loading", active);

  if (!active) {
    setProgress("coreBar", state.coreDownloadRatio);
  }
}

function getMinimumClipSec(): number {
  if (!state.durationSec || state.durationSec <= 0) return DEFAULT_MIN_CLIP_SEC;
  return Math.min(DEFAULT_MIN_CLIP_SEC, state.durationSec);
}

function getEffectiveDurationSec(): number | undefined {
  if (!state.durationSec || !Number.isFinite(state.durationSec)) return undefined;
  if (!state.trimEnabled) return state.durationSec;
  return Math.max(0, state.trimEndSec - state.trimStartSec);
}

function isTrimRangeValid(): boolean {
  if (!state.trimEnabled || !state.durationSec) return true;
  return state.trimEndSec - state.trimStartSec >= getMinimumClipSec() - 1e-6;
}

function getAspectRatio(preset: CropAspectPreset): number | null {
  switch (preset) {
    case "16:9":
      return 16 / 9;
    case "9:16":
      return 9 / 16;
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    default:
      return null;
  }
}

function applyTrimValue(nextValue: number, changed: "start" | "end") {
  if (!state.durationSec || !Number.isFinite(state.durationSec)) return;
  const next = normalizeTrimRange(
    changed === "start" ? nextValue : state.trimStartSec,
    changed === "end" ? nextValue : state.trimEndSec,
    state.durationSec,
    changed,
    getMinimumClipSec()
  );
  state.trimStartSec = next.start;
  state.trimEndSec = next.end;
  updateInfo();
}

function updateTrimUi() {
  const trimEnabled = el<HTMLInputElement>("trimEnabled");
  const trimStart = el<HTMLInputElement>("trimStart");
  const trimEnd = el<HTMLInputElement>("trimEnd");
  const trimStartLabel = el<HTMLSpanElement>("trimStartLabel");
  const trimEndLabel = el<HTMLSpanElement>("trimEndLabel");
  const trimDurationLabel = el<HTMLSpanElement>("trimDurationLabel");
  const trimTimeline = el<HTMLDivElement>("trimTimeline");
  const trimRange = el<HTMLDivElement>("trimRange");
  const trimHandleStart = el<HTMLDivElement>("trimHandleStart");
  const trimHandleEnd = el<HTMLDivElement>("trimHandleEnd");

  const hasDuration = !!state.durationSec && Number.isFinite(state.durationSec) && state.durationSec > 0;

  trimEnabled.checked = state.trimEnabled;
  trimEnabled.disabled = !hasDuration || state.busy;

  trimStart.disabled = !hasDuration || !state.trimEnabled || state.busy;
  trimEnd.disabled = !hasDuration || !state.trimEnabled || state.busy;
  trimTimeline.classList.toggle("disabled", !hasDuration || !state.trimEnabled || state.busy);

  if (!hasDuration) {
    trimStart.value = "0";
    trimEnd.value = "0";
    trimStartLabel.textContent = "00:00.00";
    trimEndLabel.textContent = "00:00.00";
    trimDurationLabel.textContent = "-";
    trimHandleStart.style.left = "0%";
    trimHandleEnd.style.left = "100%";
    trimRange.style.left = "0%";
    trimRange.style.width = "100%";
    return;
  }

  const duration = state.durationSec as number;
  const normalized = normalizeTrimRange(
    state.trimStartSec,
    state.trimEndSec,
    duration,
    "end",
    getMinimumClipSec()
  );
  state.trimStartSec = normalized.start;
  state.trimEndSec = normalized.end;

  trimStart.min = "0";
  trimEnd.min = "0";
  trimStart.max = duration.toFixed(3);
  trimEnd.max = duration.toFixed(3);
  trimStart.step = "0.01";
  trimEnd.step = "0.01";

  trimStart.value = state.trimStartSec.toFixed(2);
  trimEnd.value = state.trimEndSec.toFixed(2);

  trimStartLabel.textContent = formatSeconds(state.trimStartSec);
  trimEndLabel.textContent = formatSeconds(state.trimEndSec);

  const clipLen = state.trimEnabled ? state.trimEndSec - state.trimStartSec : duration;
  trimDurationLabel.textContent = `${formatSeconds(clipLen)} (${clipLen.toFixed(2)}s)`;

  const startPct = duration > 0 ? (state.trimStartSec / duration) * 100 : 0;
  const endPct = duration > 0 ? (state.trimEndSec / duration) * 100 : 100;

  trimHandleStart.style.left = `${startPct}%`;
  trimHandleEnd.style.left = `${endPct}%`;
  trimRange.style.left = `${startPct}%`;
  trimRange.style.width = `${Math.max(0, endPct - startPct)}%`;
}

function updateCropUi() {
  const canEdit = !!state.file && !!state.width && !!state.height;

  const cropEnabled = el<HTMLInputElement>("cropEnabled");
  const cropAspect = el<HTMLSelectElement>("cropAspect");
  const cropReset = el<HTMLButtonElement>("cropReset");
  const cropStage = el<HTMLDivElement>("cropStage");
  const cropOverlay = el<HTMLDivElement>("cropOverlay");
  const cropSelection = el<HTMLDivElement>("cropSelection");
  const cropLabel = el<HTMLSpanElement>("cropLabel");
  const inputVideo = el<HTMLVideoElement>("inputVideo");

  cropEnabled.checked = state.cropEnabled;
  cropEnabled.disabled = !canEdit || state.busy;
  cropAspect.value = state.cropAspect;
  cropAspect.disabled = !canEdit || !state.cropEnabled || state.busy;
  cropReset.disabled = !canEdit || !state.cropEnabled || state.busy;

  const previewUrl = getActivePreviewUrl();
  const hasInput = !!previewUrl;
  inputVideo.style.display = hasInput ? "block" : "none";
  if (hasInput) {
    if (inputVideo.src !== previewUrl) {
      inputVideo.src = previewUrl as string;
      inputVideo.load();
    }
    void inputVideo.play().catch(() => {
      // Autoplay can be blocked depending on browser policy.
    });
  } else {
    inputVideo.pause();
    inputVideo.removeAttribute("src");
    inputVideo.load();
  }

  if (!canEdit) {
    cropStage.classList.add("disabled");
    cropOverlay.classList.add("disabled");
    cropLabel.textContent = "-";
    return;
  }

  cropStage.classList.toggle("disabled", !state.cropEnabled || state.busy);
  cropOverlay.classList.toggle("disabled", !state.cropEnabled || state.busy);
  cropStage.style.aspectRatio = `${state.width} / ${state.height}`;

  const normalized = clampCropRect(state.cropRect);
  state.cropRect = normalized;

  cropSelection.style.left = `${normalized.x * 100}%`;
  cropSelection.style.top = `${normalized.y * 100}%`;
  cropSelection.style.width = `${normalized.width * 100}%`;
  cropSelection.style.height = `${normalized.height * 100}%`;

  const pxCrop = cropNormToPixels(normalized, state.width as number, state.height as number);
  const onOff = state.cropEnabled ? "" : " (disabled)";
  cropLabel.textContent = `${pxCrop.width}x${pxCrop.height} @ (${pxCrop.x}, ${pxCrop.y})${onOff}`;
}

function renderThumbnails() {
  const strip = el<HTMLDivElement>("thumbStrip");
  strip.innerHTML = "";

  if (!state.file || !state.durationSec) {
    const msg = document.createElement("div");
    msg.className = "thumb-placeholder";
    msg.textContent = "Load a file to generate thumbnails.";
    strip.appendChild(msg);
    return;
  }

  if (state.thumbsBusy) {
    const msg = document.createElement("div");
    msg.className = "thumb-placeholder";
    msg.textContent = "Generating timeline thumbnails...";
    strip.appendChild(msg);
    return;
  }

  if (state.thumbnails.length === 0) {
    const msg = document.createElement("div");
    msg.className = "thumb-placeholder";
    msg.textContent = "Thumbnails unavailable for this file.";
    strip.appendChild(msg);
    return;
  }

  for (const thumb of state.thumbnails) {
    const item = document.createElement("div");
    item.className = "thumb-item";

    const img = document.createElement("img");
    img.className = "thumb-image";
    img.src = thumb.dataUrl;
    img.alt = `Thumbnail at ${formatSeconds(thumb.timeSec)}`;

    const t = document.createElement("div");
    t.className = "thumb-time";
    t.textContent = formatSeconds(thumb.timeSec);

    item.appendChild(img);
    item.appendChild(t);
    strip.appendChild(item);
  }
}

function updateInfo() {
  const file = state.file;
  const duration = state.durationSec;
  const effectiveDuration = getEffectiveDurationSec();

  el<HTMLDivElement>("fileName").textContent = file ? file.name : "-";
  el<HTMLDivElement>("fileSize").textContent = file ? formatBytes(file.size) : "-";
  el<HTMLDivElement>("duration").textContent =
    duration != null && Number.isFinite(duration) ? `${duration.toFixed(2)} s` : "-";

  const res = state.width && state.height ? `${state.width} x ${state.height}` : "-";
  el<HTMLDivElement>("resolution").textContent = res;

  const est =
    effectiveDuration != null && Number.isFinite(effectiveDuration)
      ? estimateBytesFromKbps(effectiveDuration, state.videoKbps, state.includeAudio ? state.audioKbps : 0)
      : 0;

  el<HTMLDivElement>("estimate").textContent = effectiveDuration != null ? formatBytes(est) : "-";
  el<HTMLDivElement>("outputSize").textContent =
    state.outputBytes != null ? formatBytes(state.outputBytes) : "-";

  const canConvert = !!state.file && state.ffmpegLoaded && !state.busy && isTrimRangeValid();
  el<HTMLButtonElement>("convertBtn").disabled = !canConvert;
  el<HTMLButtonElement>("pickFileBtn").disabled = state.busy || state.coreLoading;

  el<HTMLButtonElement>("cancelBtn").disabled = !state.busy && !state.coreLoading;
  el<HTMLButtonElement>("resetBtn").disabled = state.busy || state.coreLoading;

  el<HTMLAnchorElement>("downloadLink").style.display = state.outputUrl ? "inline-block" : "none";
  el<HTMLVideoElement>("outputVideo").style.display = state.outputUrl ? "block" : "none";

  el<HTMLSpanElement>("videoKbpsLabel").textContent = `${state.videoKbps} kbps`;
  el<HTMLSpanElement>("audioKbpsLabel").textContent = `${state.audioKbps} kbps`;

  updateTrimUi();
  updateCropUi();

  if (!isTrimRangeValid() && state.trimEnabled) {
    el<HTMLDivElement>("trimValidation").textContent = "Trim range is too short.";
  } else {
    el<HTMLDivElement>("trimValidation").textContent = "";
  }
}

function revoke(url?: string) {
  if (url) URL.revokeObjectURL(url);
}

function clearPreviewProxy() {
  if (state.previewIsProxy) {
    revoke(state.previewUrl);
  }
  state.previewUrl = undefined;
  state.previewIsProxy = false;
}

function getActivePreviewUrl(): string | undefined {
  return state.previewUrl ?? state.inputUrl;
}

function clearOutput() {
  revoke(state.outputUrl);
  state.outputUrl = undefined;
  state.outputBytes = undefined;
}

function resetEditState() {
  state.trimEnabled = true;
  state.trimStartSec = 0;
  state.trimEndSec = state.durationSec ?? 0;
  state.cropEnabled = true;
  state.cropAspect = "free";
  state.cropRect = { ...DEFAULT_CROP_RECT };
}

function deriveOutputName(inputName: string): string {
  const base = inputName.replace(/\.[^.]+$/, "");
  return `${base}.webm`;
}

function dragCropRect(startRect: CropRectNorm, dx: number, dy: number, mode: CropDragMode): CropRectNorm {
  const min = 0.05;

  if (mode === "move") {
    return clampCropRect(
      {
        x: startRect.x + dx,
        y: startRect.y + dy,
        width: startRect.width,
        height: startRect.height
      },
      min
    );
  }

  let x1 = startRect.x;
  let y1 = startRect.y;
  let x2 = startRect.x + startRect.width;
  let y2 = startRect.y + startRect.height;

  if (mode === "nw") {
    x1 += dx;
    y1 += dy;
  } else if (mode === "ne") {
    x2 += dx;
    y1 += dy;
  } else if (mode === "sw") {
    x1 += dx;
    y2 += dy;
  } else if (mode === "se") {
    x2 += dx;
    y2 += dy;
  }

  let rect = clampCropRect(
    {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    },
    min
  );

  const ratio = getAspectRatio(state.cropAspect);
  if (ratio) {
    rect = fitCropToAspect(rect, ratio);
  }

  return clampCropRect(rect, min);
}

type BasicVideoMetadata = {
  durationSec?: number;
  width?: number;
  height?: number;
};

function teardownTempVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.remove();
}

async function readVideoMetadata(url: string, timeoutMs = 15_000): Promise<BasicVideoMetadata> {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  await new Promise<void>((resolve) => {
    let timer = 0;
    const done = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onDone);
    };

    const onReady = () => {
      if (video.readyState >= 1) done();
    };
    const onDone = () => done();

    timer = window.setTimeout(onDone, timeoutMs);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("error", onDone);
  });

  const durationSec = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
  const width = Number.isFinite(video.videoWidth) && video.videoWidth > 0 ? Math.floor(video.videoWidth) : undefined;
  const height = Number.isFinite(video.videoHeight) && video.videoHeight > 0 ? Math.floor(video.videoHeight) : undefined;

  teardownTempVideo(video);
  return { durationSec, width, height };
}

async function waitForLoadedMetadata(video: HTMLVideoElement, timeoutMs = 20_000): Promise<void> {
  if (video.readyState >= 1) return;

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      if (video.readyState < 1) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to load video metadata."));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while loading video metadata."));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
  });
}

async function waitForFirstFrame(video: HTMLVideoElement, timeoutMs = 10_000): Promise<void> {
  const hasFrame = () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  if (hasFrame()) return;

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      if (!hasFrame()) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to decode a preview frame."));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for first decodable frame."));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("canplaythrough", onReady);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("canplaythrough", onReady);
    video.addEventListener("playing", onReady);
    video.addEventListener("error", onError);
  });
}

async function seekVideo(video: HTMLVideoElement, targetTimeSec: number): Promise<void> {
  const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;
  const target = clamp(targetTimeSec, 0, Math.max(0, duration - 0.001));

  if (Math.abs(video.currentTime - target) < 0.03 && video.readyState >= 2) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed while seeking video for thumbnail generation."));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while seeking video for thumbnail generation."));
    }, 7000);

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);

    try {
      video.currentTime = target;
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function generateTimelineThumbnails(
  fileUrl: string,
  durationSec: number,
  count: number
): Promise<Thumbnail[]> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];

  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.autoplay = false;
  video.style.position = "fixed";
  video.style.left = "-10000px";
  video.style.top = "-10000px";
  video.style.width = "1px";
  video.style.height = "1px";
  video.src = fileUrl;
  document.body.appendChild(video);

  try {
    await waitForLoadedMetadata(video, 12_000);
    await video.play().catch(() => {
      // Ignore autoplay blocks. Seeking still works for thumbnails.
    });
    await waitForFirstFrame(video, 10_000);
    video.pause();
  } catch (err) {
    teardownTempVideo(video);
    throw err;
  }

  const sourceWidth = Math.floor(video.videoWidth);
  const sourceHeight = Math.floor(video.videoHeight);
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    teardownTempVideo(video);
    throw new Error("Unable to decode frame dimensions for thumbnails.");
  }

  const thumbWidth = 120;
  const thumbHeight = Math.max(68, Math.round((sourceHeight / sourceWidth) * thumbWidth));

  const canvas = document.createElement("canvas");
  canvas.width = thumbWidth;
  canvas.height = thumbHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is unavailable.");

  const thumbs: Thumbnail[] = [];

  for (let i = 0; i < count; i++) {
    const ratio = count === 1 ? 0 : i / (count - 1);
    const rawTime = durationSec * ratio;
    const seekTime = clamp(rawTime, 0, Math.max(0, durationSec - 0.05));

    try {
      await seekVideo(video, seekTime);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight);
      thumbs.push({
        timeSec: seekTime,
        dataUrl: canvas.toDataURL("image/jpeg", 0.75)
      });
    } catch {
      if (thumbs.length > 0) {
        thumbs.push({
          timeSec: seekTime,
          dataUrl: thumbs[thumbs.length - 1].dataUrl
        });
      }
    }
  }

  teardownTempVideo(video);

  if (thumbs.length === 0) {
    throw new Error("Unable to decode frames for thumbnails.");
  }

  return thumbs;
}

function buildThumbnailTimes(durationSec: number, count: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || count <= 0) return [];
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const ratio = count === 1 ? 0 : i / (count - 1);
    times.push(clamp(durationSec * ratio, 0, Math.max(0, durationSec - 0.05)));
  }
  return times;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to encode thumbnail image."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

async function generateTimelineThumbnailsWithFfmpeg(
  file: File,
  durationSec: number,
  count: number
): Promise<Thumbnail[]> {
  const times = buildThumbnailTimes(durationSec, count);
  const frames = await ffmpeg.generateThumbnails(file, times);
  if (frames.length === 0) return [];

  const thumbs: Thumbnail[] = [];
  for (const frame of frames) {
    const dataUrl = await blobToDataUrl(new Blob([frame.bytes], { type: "image/jpeg" }));
    thumbs.push({ timeSec: frame.timeSec, dataUrl });
  }
  return thumbs;
}

async function canDecodePreviewNatively(url: string): Promise<boolean> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.style.position = "fixed";
  video.style.left = "-10000px";
  video.style.top = "-10000px";
  video.style.width = "1px";
  video.style.height = "1px";
  video.src = url;
  document.body.appendChild(video);

  try {
    await waitForLoadedMetadata(video, 6_000);
    await video.play().catch(() => {
      // Ignore autoplay restrictions while probing decode support.
    });
    await waitForFirstFrame(video, 6_000);
    return video.videoWidth > 0 && video.videoHeight > 0;
  } catch {
    return false;
  } finally {
    teardownTempVideo(video);
  }
}

async function createPreviewProxyUrl(file: File): Promise<string> {
  const bytes = await ffmpeg.createPreviewProxyWebm(file, {
    width: 640,
    fps: 24,
    videoKbps: 700
  });
  return URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
}

async function refreshThumbnails() {
  const myToken = ++thumbnailToken;
  clearPreviewProxy();
  state.thumbnails = [];
  state.thumbsBusy = !!state.inputUrl && !!state.durationSec;
  renderThumbnails();

  if (!state.inputUrl || !state.durationSec || state.durationSec <= 0) {
    state.thumbsBusy = false;
    renderThumbnails();
    return;
  }

  try {
    let sourceUrl = state.inputUrl;
    let nativePlayable = await canDecodePreviewNatively(sourceUrl);
    if (myToken !== thumbnailToken) return;

    if (!nativePlayable) {
      pushLog("[preview] Native preview decode unavailable. Building WebM proxy preview...");
      await ensureFfmpegLoaded("Preparing browser-compatible preview...");
      if (myToken !== thumbnailToken) return;
      if (!state.ffmpegLoaded || !state.file) {
        throw new Error("FFmpeg is not available for preview proxy generation.");
      }

      sourceUrl = await createPreviewProxyUrl(state.file);
      if (myToken !== thumbnailToken) {
        revoke(sourceUrl);
        return;
      }

      const proxyPlayable = await canDecodePreviewNatively(sourceUrl);
      if (myToken !== thumbnailToken) {
        revoke(sourceUrl);
        return;
      }
      if (!proxyPlayable) {
        revoke(sourceUrl);
        throw new Error("Generated preview proxy cannot be decoded by this browser.");
      }

      state.previewUrl = sourceUrl;
      state.previewIsProxy = true;
      nativePlayable = true;
      pushLog("[preview] Proxy preview ready.");
      setStatus("Proxy preview generated for unsupported input codec.");
    }

    updateInfo();

    if (!nativePlayable) {
      throw new Error("Preview cannot be decoded.");
    }

    try {
      const thumbs = await generateTimelineThumbnails(sourceUrl, state.durationSec, THUMBNAIL_COUNT);
      if (myToken !== thumbnailToken) return;
      state.thumbnails = thumbs;
    } catch (err) {
      if (myToken !== thumbnailToken) return;
      const nativeErr = err instanceof Error ? err.message : String(err);
      pushLog(`[thumb] Native thumbnailing failed: ${nativeErr}`);

      try {
        if (!state.ffmpegLoaded) {
          await ensureFfmpegLoaded("Loading FFmpeg core for thumbnail fallback...");
        }

        if (myToken !== thumbnailToken) return;
        if (!state.ffmpegLoaded || !state.file || !state.durationSec) {
          throw new Error("FFmpeg thumbnail fallback unavailable.");
        }

        pushLog("[thumb] Trying FFmpeg thumbnail fallback...");
        const thumbs = await generateTimelineThumbnailsWithFfmpeg(
          state.file,
          state.durationSec,
          THUMBNAIL_COUNT
        );

        if (myToken !== thumbnailToken) return;
        if (thumbs.length === 0) {
          throw new Error("FFmpeg fallback returned no frames.");
        }

        state.thumbnails = thumbs;
        pushLog(`[thumb] FFmpeg fallback generated ${thumbs.length} thumbnails.`);
      } catch (fallbackErr) {
        if (myToken !== thumbnailToken) return;
        const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        pushLog(`[thumb:error] ${msg}`);
      }
    }
  } catch (err) {
    if (myToken !== thumbnailToken) return;
    const msg = err instanceof Error ? err.message : String(err);
    pushLog(`[preview:error] ${msg}`);
  } finally {
    if (myToken !== thumbnailToken) return;
    state.thumbsBusy = false;
    renderThumbnails();
    updateInfo();
  }
}

async function ensureFfmpegLoaded(statusMessage = "Loading FFmpeg core..."): Promise<void> {
  if (state.ffmpegLoaded) return;
  if (coreLoadPromise) {
    await coreLoadPromise;
    return;
  }

  coreLoadPromise = (async () => {
    let pulseTimer: number | undefined;
    try {
      state.coreLoading = true;
      state.coreDownloadRatio = 0;
      updateInfo();
      setCoreLoadingIndeterminate(true);
      pushLog("[load] Starting FFmpeg core initialization...");

      pulseTimer = window.setInterval(() => {
        if (!state.coreLoading || !state.coreLoadingIndeterminate) return;
        if (state.coreDownloadRatio < 0.9) {
          state.coreDownloadRatio = Math.min(0.9, state.coreDownloadRatio + 0.01);
          setProgress("coreBar", state.coreDownloadRatio);
        }
      }, 250);

      ffmpeg.setHandlers({
        onCoreProgress: (p) => {
          const ratio = p.ratio ?? (p.total ? p.loaded / p.total : 0);
          state.coreDownloadRatio = Number.isFinite(ratio) ? ratio : 0;
          setProgress("coreBar", state.coreDownloadRatio);
        },
        onTranscodeProgress: (p) => {
          state.transcodeRatio = p.ratio;
          setProgress("transcodeBar", state.transcodeRatio);
        },
        onLog: (line) => pushLog(line)
      });

      setStatus(statusMessage);
      await ffmpeg.load();
      state.ffmpegLoaded = true;
      state.coreDownloadRatio = 1;
      setProgress("coreBar", 1);
      setCoreLoadingIndeterminate(false);
      pushLog("[load] FFmpeg core loaded.");
      setStatus(state.file ? "FFmpeg loaded. Ready to convert." : "FFmpeg loaded. Select a file to begin.");
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      state.ffmpegLoaded = false;
      pushLog(`[load:error] ${err}`);
      setStatus(`Load failed: ${err}`);
    } finally {
      if (pulseTimer != null) window.clearInterval(pulseTimer);
      setCoreLoadingIndeterminate(false);
      state.coreLoading = false;
      updateInfo();
      coreLoadPromise = null;
    }
  })();

  await coreLoadPromise;
}

function render() {
  el<HTMLDivElement>("app").innerHTML = `
    <div class="container">
      <div class="card">
        <h1>WebM Converter (client-only)</h1>
        <div class="muted">
          Converts a local video file to WebM in your browser. Nothing is uploaded.
          First use downloads FFmpeg core (tens of MB).
        </div>
        <div id="status" class="status-banner"></div>
        <div class="top-progress">
          <label>Transcode</label>
          <div class="progress"><div id="transcodeBar"></div></div>
          <div class="muted"><span id="transcodeBar-label">0%</span></div>
        </div>

        <div class="editor-grid">
          <div class="editor-panel upload-panel">
            <div class="upload-icon" aria-hidden="true"></div>
            <button id="pickFileBtn" type="button" class="upload-btn">Choose a video file</button>
            <input id="fileInput" class="hidden-file-input" type="file" accept="video/*" />
          </div>

          <div class="editor-panel">
            <label>
              <input id="trimEnabled" type="checkbox" checked />
              Enable trim
            </label>

            <div class="trim-grid">
              <div>
                <label>Start (s)</label>
                <input id="trimStart" type="number" min="0" step="0.01" value="0" />
                <div class="muted"><span id="trimStartLabel">00:00.00</span></div>
              </div>
              <div>
                <label>End (s)</label>
                <input id="trimEnd" type="number" min="0" step="0.01" value="0" />
                <div class="muted"><span id="trimEndLabel">00:00.00</span></div>
              </div>
            </div>

            <div id="thumbStrip" class="thumb-strip"></div>

            <div id="trimTimeline" class="trim-timeline">
              <div id="trimRange" class="trim-range"></div>
              <div id="trimHandleStart" class="trim-handle" data-handle="start" title="Trim start"></div>
              <div id="trimHandleEnd" class="trim-handle" data-handle="end" title="Trim end"></div>
            </div>

            <div class="muted">
              Clip length: <span id="trimDurationLabel">-</span>
            </div>
            <div class="error-text" id="trimValidation"></div>
          </div>

          <div class="editor-panel">
            <label>
              <input id="cropEnabled" type="checkbox" checked />
              Enable crop
            </label>

            <div class="crop-toolbar">
              <div>
                <label>Aspect</label>
                <select id="cropAspect">
                  <option value="free">Free</option>
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                  <option value="4:3">4:3</option>
                </select>
              </div>
              <div>
                <label>&nbsp;</label>
                <button id="cropReset" type="button">Reset crop</button>
              </div>
            </div>

            <div id="cropStage" class="crop-stage">
              <video id="inputVideo" class="input-preview" playsinline muted autoplay loop></video>
              <div id="cropOverlay" class="crop-overlay">
                <div id="cropSelection" class="crop-selection" title="Drag to move crop">
                  <div class="crop-handle nw" data-handle="nw"></div>
                  <div class="crop-handle ne" data-handle="ne"></div>
                  <div class="crop-handle sw" data-handle="sw"></div>
                  <div class="crop-handle se" data-handle="se"></div>
                </div>
              </div>
            </div>

            <div class="muted">Crop: <span id="cropLabel">-</span></div>
          </div>
        </div>

        <hr />

        <div class="kv">
          <div class="key">File</div><div class="val" id="fileName">-</div>
          <div class="key">Input size</div><div class="val" id="fileSize">-</div>
          <div class="key">Duration</div><div class="val" id="duration">-</div>
          <div class="key">Resolution</div><div class="val" id="resolution">-</div>
          <div class="key">Estimated output size</div><div class="val" id="estimate">-</div>
          <div class="key">Actual output size</div><div class="val" id="outputSize">-</div>
        </div>

        <hr />

        <div class="row">
          <div>
            <label>Video bitrate <span class="muted" id="videoKbpsLabel"></span></label>
            <input id="videoKbps" type="range" min="300" max="8000" step="50" value="${state.videoKbps}" />
          </div>
          <div>
            <label>Audio bitrate <span class="muted" id="audioKbpsLabel"></span></label>
            <input id="audioKbps" type="range" min="48" max="320" step="8" value="${state.audioKbps}" />
          </div>
        </div>

        <div style="margin-top: 10px;">
          <label>
            <input id="includeAudio" type="checkbox" ${state.includeAudio ? "checked" : ""} />
            Include audio
          </label>
        </div>

        <hr />

        <div class="core-progress-block">
          <label>Core download</label>
          <div id="coreProgress" class="progress"><div id="coreBar"></div></div>
          <div class="muted"><span id="coreBar-label">0%</span></div>
        </div>

        <div class="actions">
          <button class="primary" id="convertBtn">Convert to WebM</button>
          <button id="cancelBtn">Cancel</button>
        </div>

        <div class="actions" style="grid-template-columns: 1fr 1fr;">
          <button id="resetBtn">Reset</button>
          <a id="downloadLink" href="#" download="output.webm">Download WebM</a>
        </div>

        <video id="outputVideo" class="video" controls></video>

        <hr />

        <label>Logs</label>
        <pre id="logs"></pre>
      </div>
    </div>
  `;

  bind();
  updateInfo();
  renderThumbnails();
  setProgress("coreBar", state.coreDownloadRatio);
  setCoreLoadingIndeterminate(state.coreLoadingIndeterminate);
  setProgress("transcodeBar", state.transcodeRatio);
  setStatus(state.status);
  el<HTMLPreElement>("logs").textContent = state.logs.join("\n");
}

function bind() {
  const fileInput = el<HTMLInputElement>("fileInput");
  const pickFileBtn = el<HTMLButtonElement>("pickFileBtn");
  const convertBtn = el<HTMLButtonElement>("convertBtn");
  const cancelBtn = el<HTMLButtonElement>("cancelBtn");
  const resetBtn = el<HTMLButtonElement>("resetBtn");

  const videoKbps = el<HTMLInputElement>("videoKbps");
  const audioKbps = el<HTMLInputElement>("audioKbps");
  const includeAudio = el<HTMLInputElement>("includeAudio");

  const trimEnabled = el<HTMLInputElement>("trimEnabled");
  const trimStart = el<HTMLInputElement>("trimStart");
  const trimEnd = el<HTMLInputElement>("trimEnd");
  const trimTimeline = el<HTMLDivElement>("trimTimeline");

  const cropEnabled = el<HTMLInputElement>("cropEnabled");
  const cropAspect = el<HTMLSelectElement>("cropAspect");
  const cropReset = el<HTMLButtonElement>("cropReset");
  const cropOverlay = el<HTMLDivElement>("cropOverlay");
  const cropSelection = el<HTMLDivElement>("cropSelection");
  const inputVideo = el<HTMLVideoElement>("inputVideo");

  pickFileBtn.addEventListener("click", () => {
    if (state.busy || state.coreLoading) return;
    fileInput.click();
  });

  inputVideo.addEventListener("loadeddata", () => {
    void inputVideo.play().catch(() => {
      // Ignore autoplay restrictions.
    });
  });

  inputVideo.addEventListener("error", () => {
    if (!state.inputUrl) return;
    pushLog("[preview:error] Input preview failed in this browser for this codec.");
    setStatus("Input preview unavailable for this codec/browser. You can still convert.");
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    state.file = file || undefined;

    clearOutput();
    clearPreviewProxy();

    revoke(state.inputUrl);
    state.inputUrl = undefined;

    state.durationSec = undefined;
    state.width = undefined;
    state.height = undefined;

    state.thumbnails = [];
    state.thumbsBusy = false;
    thumbnailToken++;

    if (!file) {
      resetEditState();
      setStatus("Select a file to begin.");
      renderThumbnails();
      updateInfo();
      return;
    }

    setStatus("Reading metadata...");
    state.inputUrl = URL.createObjectURL(file);

    const metadata = await readVideoMetadata(state.inputUrl);
    state.durationSec = metadata.durationSec;
    state.width = metadata.width;
    state.height = metadata.height;

    resetEditState();

    setStatus(state.ffmpegLoaded ? "Ready to convert." : "Preparing converter...");
    updateInfo();
    void refreshThumbnails();
    if (!state.ffmpegLoaded) {
      void ensureFfmpegLoaded("Loading FFmpeg core...");
    }
  });

  videoKbps.addEventListener("input", () => {
    state.videoKbps = Number(videoKbps.value);
    updateInfo();
  });

  audioKbps.addEventListener("input", () => {
    state.audioKbps = Number(audioKbps.value);
    updateInfo();
  });

  includeAudio.addEventListener("change", () => {
    state.includeAudio = includeAudio.checked;
    updateInfo();
  });

  trimEnabled.addEventListener("change", () => {
    state.trimEnabled = trimEnabled.checked;
    updateInfo();
  });

  trimStart.addEventListener("input", () => {
    applyTrimValue(Number(trimStart.value), "start");
  });

  trimEnd.addEventListener("input", () => {
    applyTrimValue(Number(trimEnd.value), "end");
  });

  trimTimeline.addEventListener("pointerdown", (ev) => {
    if (!state.trimEnabled || !state.durationSec || state.busy) return;

    const target = ev.target as HTMLElement;
    if (target.dataset.handle === "start" || target.dataset.handle === "end") {
      trimDragHandle = target.dataset.handle;
    } else {
      const bounds = trimTimeline.getBoundingClientRect();
      if (bounds.width <= 0) return;
      const ratio = clamp((ev.clientX - bounds.left) / bounds.width, 0, 1);
      const time = ratio * state.durationSec;
      const distStart = Math.abs(time - state.trimStartSec);
      const distEnd = Math.abs(time - state.trimEndSec);
      trimDragHandle = distStart <= distEnd ? "start" : "end";
      applyTrimValue(time, trimDragHandle);
    }

    trimDragPointerId = ev.pointerId;
    try {
      trimTimeline.setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }
    ev.preventDefault();
  });

  trimTimeline.addEventListener("pointermove", (ev) => {
    if (!trimDragHandle || trimDragPointerId !== ev.pointerId || !state.durationSec) return;
    const bounds = trimTimeline.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const ratio = clamp((ev.clientX - bounds.left) / bounds.width, 0, 1);
    applyTrimValue(ratio * state.durationSec, trimDragHandle);
  });

  const stopTrimDrag = (ev: PointerEvent) => {
    if (trimDragPointerId !== ev.pointerId) return;
    trimDragHandle = null;
    trimDragPointerId = null;
  };

  trimTimeline.addEventListener("pointerup", stopTrimDrag);
  trimTimeline.addEventListener("pointercancel", stopTrimDrag);

  cropEnabled.addEventListener("change", () => {
    state.cropEnabled = cropEnabled.checked;
    updateInfo();
  });

  cropAspect.addEventListener("change", () => {
    state.cropAspect = cropAspect.value as CropAspectPreset;
    const ratio = getAspectRatio(state.cropAspect);
    state.cropRect = ratio ? fitCropToAspect(state.cropRect, ratio) : clampCropRect(state.cropRect);
    updateInfo();
  });

  cropReset.addEventListener("click", () => {
    state.cropRect = { ...DEFAULT_CROP_RECT };
    state.cropAspect = "free";
    updateInfo();
  });

  cropSelection.addEventListener("pointerdown", (ev) => {
    if (!state.cropEnabled || !state.file || !state.width || !state.height || state.busy) return;

    const target = ev.target as HTMLElement;
    const handle = target.dataset.handle as CropDragMode | undefined;
    const mode: CropDragMode = handle === "nw" || handle === "ne" || handle === "sw" || handle === "se" ? handle : "move";

    cropDrag = {
      pointerId: ev.pointerId,
      mode,
      startX: ev.clientX,
      startY: ev.clientY,
      startRect: { ...state.cropRect }
    };

    try {
      cropOverlay.setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }

    ev.preventDefault();
  });

  cropOverlay.addEventListener("pointermove", (ev) => {
    if (!cropDrag || cropDrag.pointerId !== ev.pointerId) return;
    const bounds = cropOverlay.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const dx = (ev.clientX - cropDrag.startX) / bounds.width;
    const dy = (ev.clientY - cropDrag.startY) / bounds.height;

    state.cropRect = dragCropRect(cropDrag.startRect, dx, dy, cropDrag.mode);
    updateInfo();
  });

  const stopCropDrag = (ev: PointerEvent) => {
    if (!cropDrag || cropDrag.pointerId !== ev.pointerId) return;
    cropDrag = null;
  };

  cropOverlay.addEventListener("pointerup", stopCropDrag);
  cropOverlay.addEventListener("pointercancel", stopCropDrag);

  convertBtn.addEventListener("click", async () => {
    if (!state.file) return;
    if (!isTrimRangeValid()) {
      setStatus("Trim range is too short.");
      return;
    }

    try {
      if (!state.ffmpegLoaded) {
        await ensureFfmpegLoaded("Loading FFmpeg core before conversion...");
      }
      if (!state.ffmpegLoaded) {
        throw new Error("FFmpeg core is not loaded.");
      }

      state.busy = true;
      state.transcodeRatio = 0;
      setProgress("transcodeBar", 0);
      updateInfo();

      const convertOptions: ConvertOptions = {
        videoKbps: state.videoKbps,
        audioKbps: state.audioKbps,
        includeAudio: state.includeAudio
      };

      if (state.trimEnabled && state.durationSec) {
        convertOptions.trimStartSec = state.trimStartSec;
        convertOptions.trimEndSec = state.trimEndSec;
        pushLog(`[convert] Trim: ${formatSeconds(state.trimStartSec)} -> ${formatSeconds(state.trimEndSec)}`);
      }

      if (state.cropEnabled && state.width && state.height && !isFullFrameCrop(state.cropRect)) {
        const crop = cropNormToPixels(state.cropRect, state.width, state.height);
        convertOptions.crop = crop;
        pushLog(`[convert] Crop: ${crop.width}x${crop.height}+${crop.x}+${crop.y}`);
      }

      setStatus("Converting to WebM...");
      const out = await ffmpeg.convertToWebm(state.file, convertOptions);

      const blob = new Blob([out], { type: "video/webm" });
      state.outputBytes = blob.size;

      revoke(state.outputUrl);
      state.outputUrl = URL.createObjectURL(blob);

      const a = el<HTMLAnchorElement>("downloadLink");
      a.href = state.outputUrl;
      a.download = deriveOutputName(state.file.name);

      const vid = el<HTMLVideoElement>("outputVideo");
      vid.src = state.outputUrl;

      setStatus("Done. Preview and download your WebM.");
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      pushLog(`[convert:error] ${err}`);
      setStatus(`Convert failed: ${err}`);
    } finally {
      state.busy = false;
      updateInfo();
    }
  });

  cancelBtn.addEventListener("click", () => {
    setStatus("Cancelling and resetting FFmpeg...");
    ffmpeg.cancelAndReset();
    state.ffmpegLoaded = false;
    state.coreLoading = false;
    state.busy = false;
    state.coreDownloadRatio = 0;
    state.transcodeRatio = 0;
    setProgress("coreBar", 0);
    setProgress("transcodeBar", 0);
    updateInfo();
    setStatus("Cancelled. Reloading FFmpeg core...");
    void ensureFfmpegLoaded("Reloading FFmpeg core...");
  });

  resetBtn.addEventListener("click", () => {
    clearPreviewProxy();
    revoke(state.inputUrl);
    state.inputUrl = undefined;

    clearOutput();

    state.file = undefined;
    state.durationSec = undefined;
    state.width = undefined;
    state.height = undefined;

    state.logs = [];
    el<HTMLPreElement>("logs").textContent = "";

    state.thumbnails = [];
    state.thumbsBusy = false;
    thumbnailToken++;

    resetEditState();
    fileInput.value = "";

    setStatus("Select a file to begin.");
    renderThumbnails();
    updateInfo();
  });
}

render();
void ensureFfmpegLoaded("Loading FFmpeg core...");
