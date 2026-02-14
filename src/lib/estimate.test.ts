import { describe, it, expect } from "vitest";
import { estimateBytesFromKbps } from "./estimate";

describe("estimateBytesFromKbps", () => {
  it("estimates roughly correct order of magnitude", () => {
    // 10s at 1000 kbps video + 128 kbps audio ~ 1.41 MB plus overhead
    const bytes = estimateBytesFromKbps(10, 1000, 128);
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThan(2_000_000);
  });

  it("never returns negative", () => {
    const bytes = estimateBytesFromKbps(-10, -1, -1);
    expect(bytes).toBe(0);
  });
});
