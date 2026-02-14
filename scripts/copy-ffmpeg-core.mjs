import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const sourceDir = join(root, "node_modules", "@ffmpeg", "core", "dist", "esm");
const outDir = join(root, "public", "ffmpeg-core");

await mkdir(outDir, { recursive: true });
await copyFile(join(sourceDir, "ffmpeg-core.js"), join(outDir, "ffmpeg-core.js"));
await copyFile(join(sourceDir, "ffmpeg-core.wasm"), join(outDir, "ffmpeg-core.wasm"));

console.log("Copied ffmpeg core assets to public/ffmpeg-core");
