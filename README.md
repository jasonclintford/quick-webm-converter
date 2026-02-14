# WebM Converter (Client-Only)

Browser-based video conversion to WebM using `ffmpeg.wasm`.
No upload is performed. Files stay local in the browser.

## Repository Packaging

This folder is prepared as a clean GitHub-ready repository:

- Includes source (`src/`) and static assets (`public/`).
- Includes GitHub Pages workflow at `.github/workflows/deploy.yml`.
- Includes vendored FFmpeg core files:
  - `public/ffmpeg-core/ffmpeg-core.js`
  - `public/ffmpeg-core/ffmpeg-core.wasm`

Because FFmpeg core is already in `public/ffmpeg-core`, the deployed site does not need to fetch core from a third-party CDN.

## Features

- Automatic FFmpeg core load on app startup.
- Input preview with codec fallback:
  - Native browser preview when supported.
  - Auto-generated WebM proxy preview when native decode is not supported.
- Trim editor:
  - Start/end numeric inputs.
  - Draggable timeline handles.
  - Timeline thumbnails with fallback generation.
- Crop editor:
  - Drag/move/resize crop rectangle.
  - Aspect presets (`Free`, `16:9`, `9:16`, `1:1`, `4:3`).
- Conversion resilience:
  - Multi-attempt fallback profiles for browser/WASM stability.
  - Detailed logs shown in the UI.

## Prerequisites

- Node.js 18+ (Node.js 20 recommended)
- npm 9+

## Setup

```bash
npm install
```

## Run (Development)

```bash
npm run dev
```

Vite will print the local URL (for example `http://127.0.0.1:4173/`).

## Build (Production)

```bash
npm run build
```

Preview production build locally:

```bash
npm run preview
```

## Test

```bash
npm run test
```

## Project Scripts

- `predev`: copies FFmpeg core assets into `public/ffmpeg-core`
- `dev`: starts Vite dev server
- `prebuild`: copies FFmpeg core assets before production build
- `build`: builds with Vite
- `preview`: serves the built app
- `test`: runs Vitest tests

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. Open repository `Settings` -> `Pages`.
3. Set source to `GitHub Actions`.
4. Use your workflow to build and publish the `dist/` output.

Notes:
- The app is configured for static hosting and relative asset paths.
- `ffmpeg-core` assets are copied into build output automatically.

## Troubleshooting

- FFmpeg load timeout:
  - Ensure the site is served over HTTP/HTTPS (not raw `file://`).
  - Check browser console/network for blocked `ffmpeg-core` files.
- No native preview:
  - Some inputs (for example HEVC/H.265) are not consistently supported.
  - The app automatically creates a WebM proxy preview when needed.
- Thumbnails missing:
  - The app tries native extraction first, then FFmpeg fallback extraction.
- Out-of-memory/out-of-bounds during convert:
  - Reduce clip duration and/or bitrate.
  - Keep browser tabs minimal to free memory.

## Privacy

All media processing is local to the browser runtime.
No source media is uploaded by this application.
