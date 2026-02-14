export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const dp = idx === 0 ? 0 : idx === 1 ? 1 : 2;
  return `${value.toFixed(dp)} ${units[idx]}`;
}

/**
 * Estimate output size from duration and bitrates.
 * bitrates are in kbps, duration in seconds.
 */
export function estimateBytesFromKbps(durationSec: number, videoKbps: number, audioKbps: number): number {
  const d = Math.max(0, durationSec);
  const v = Math.max(0, videoKbps);
  const a = Math.max(0, audioKbps);

  // (kbps * 1000 bits/s) => bits/s. Divide by 8 for bytes/s.
  const bytes = d * ((v + a) * 1000) / 8;

  // Container overhead heuristic
  return Math.round(bytes * 1.02);
}
