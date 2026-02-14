import { describe, expect, it } from "vitest";
import {
  clampCropRect,
  cropNormToPixels,
  fitCropToAspect,
  formatSeconds,
  isFullFrameCrop,
  normalizeTrimRange
} from "./editing";

describe("normalizeTrimRange", () => {
  it("keeps start/end in bounds with minimum range", () => {
    const out = normalizeTrimRange(9.9, 10, 10, "start", 0.5);
    expect(out.start).toBeLessThanOrEqual(9.5);
    expect(out.end - out.start).toBeGreaterThanOrEqual(0.5);
  });

  it("moves start back when end is edited below minimum", () => {
    const out = normalizeTrimRange(4, 0.1, 5, "end", 1);
    expect(out.end).toBeGreaterThanOrEqual(1);
    expect(out.end - out.start).toBeGreaterThanOrEqual(1);
  });
});

describe("crop helpers", () => {
  it("clamps crop to unit bounds", () => {
    const out = clampCropRect({ x: -1, y: 0.9, width: 2, height: 0.5 });
    expect(out.x).toBe(0);
    expect(out.y + out.height).toBeLessThanOrEqual(1);
  });

  it("fits crop to a target aspect ratio", () => {
    const out = fitCropToAspect({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, 16 / 9);
    expect(out.width / out.height).toBeCloseTo(16 / 9, 2);
  });

  it("maps normalized crop to integer pixel crop", () => {
    const out = cropNormToPixels({ x: 0.101, y: 0.099, width: 0.5, height: 0.5 }, 1280, 720);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
    expect(out.x).toBeGreaterThanOrEqual(0);
    expect(out.y).toBeGreaterThanOrEqual(0);
    expect(out.x + out.width).toBeLessThanOrEqual(1280);
    expect(out.y + out.height).toBeLessThanOrEqual(720);
  });

  it("detects full-frame crop", () => {
    expect(isFullFrameCrop({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(isFullFrameCrop({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 })).toBe(false);
  });
});

describe("formatSeconds", () => {
  it("formats minute-second strings", () => {
    expect(formatSeconds(65.5)).toBe("01:05.50");
  });
});
