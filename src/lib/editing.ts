export type TrimHandle = "start" | "end";

export type CropRectNorm = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PixelCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const DEFAULT_MIN_CLIP_SEC = 0.25;
const DEFAULT_MIN_CROP_SIZE = 0.05;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatSeconds(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const secStr = seconds.toFixed(2).padStart(5, "0");

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secStr}`;
  }

  return `${String(minutes).padStart(2, "0")}:${secStr}`;
}

export function normalizeTrimRange(
  startSec: number,
  endSec: number,
  durationSec: number,
  changed: TrimHandle,
  minClipSec = DEFAULT_MIN_CLIP_SEC
): { start: number; end: number } {
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  if (duration <= 0) return { start: 0, end: 0 };

  const minClip = clamp(minClipSec, 0.01, duration);
  let start = Number.isFinite(startSec) ? startSec : 0;
  let end = Number.isFinite(endSec) ? endSec : duration;

  if (changed === "start") {
    start = clamp(start, 0, Math.max(0, duration - minClip));
    end = clamp(end, start + minClip, duration);
  } else {
    end = clamp(end, minClip, duration);
    start = clamp(start, 0, end - minClip);
  }

  return { start, end };
}

export function clampCropRect(rect: CropRectNorm, minSize = DEFAULT_MIN_CROP_SIZE): CropRectNorm {
  const min = clamp(minSize, 0.01, 1);
  const width = clamp(rect.width, min, 1);
  const height = clamp(rect.height, min, 1);
  const x = clamp(rect.x, 0, 1 - width);
  const y = clamp(rect.y, 0, 1 - height);
  return { x, y, width, height };
}

export function fitCropToAspect(rect: CropRectNorm, aspectRatio: number): CropRectNorm {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return clampCropRect(rect);
  }

  const normalized = clampCropRect(rect);
  const centerX = normalized.x + normalized.width / 2;
  const centerY = normalized.y + normalized.height / 2;

  let width = normalized.width;
  let height = normalized.height;
  const current = width / height;

  if (current > aspectRatio) {
    width = height * aspectRatio;
  } else {
    height = width / aspectRatio;
  }

  const next: CropRectNorm = {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height
  };

  return clampCropRect(next);
}

export function isFullFrameCrop(rect: CropRectNorm, epsilon = 0.001): boolean {
  const r = clampCropRect(rect);
  return (
    Math.abs(r.x) <= epsilon &&
    Math.abs(r.y) <= epsilon &&
    Math.abs(r.width - 1) <= epsilon &&
    Math.abs(r.height - 1) <= epsilon
  );
}

export function cropNormToPixels(
  rect: CropRectNorm,
  sourceWidth: number,
  sourceHeight: number,
  minSizePx = 16
): PixelCropRect {
  const wSrc = Math.max(1, Math.floor(sourceWidth));
  const hSrc = Math.max(1, Math.floor(sourceHeight));
  const minNorm = Math.max(minSizePx / wSrc, minSizePx / hSrc, 0.01);
  const r = clampCropRect(rect, minNorm);

  let width = Math.max(1, Math.floor(r.width * wSrc));
  let height = Math.max(1, Math.floor(r.height * hSrc));
  width = Math.min(width, wSrc);
  height = Math.min(height, hSrc);

  // Most video pipelines are safer with even dimensions.
  if (width > 2 && width % 2 === 1) width -= 1;
  if (height > 2 && height % 2 === 1) height -= 1;

  let x = Math.floor(r.x * wSrc);
  let y = Math.floor(r.y * hSrc);

  if (x % 2 === 1) x -= 1;
  if (y % 2 === 1) y -= 1;

  x = clamp(x, 0, Math.max(0, wSrc - width));
  y = clamp(y, 0, Math.max(0, hSrc - height));

  return { x, y, width, height };
}
