# Browser Face Liveness Demo

A small Vite + vanilla JavaScript proof of concept for a browser-based, active head-movement challenge.

## Requirements

- Node.js 18 or newer
- A modern browser
- Webcam permission
- `localhost` for local development, or HTTPS when deployed

## Setup

```bash
npm install
npm run dev
```

The `dev` command copies the model assets from the installed `@vladmandic/face-api` package into `public/models` before starting Vite.

Open the local URL printed by Vite and allow camera access.

## Files

- `index.html`: the page and its styling
- `src/main.js`: webcam, face detection, calibration, challenge flow, and result event
- `scripts/copy-models.mjs`: copies model files into the public directory
- `package.json`: dependencies and commands

## Reading the result

The page dispatches a `liveness-result` browser event when the challenge ends:

```js
window.addEventListener("liveness-result", (event) => {
  const result = event.detail;
  console.log(result);
});
```

A successful result has this shape:

```js
{
  completed: true,
  reason: null,
  completedSteps: 14,
  totalSteps: 14,
  elapsedMs: 18520
}
```

## Important technical note

This is a proof of concept, not production-grade liveness verification. In particular, confirm that the installed face-api result actually exposes `face.angle.yaw`, `face.angle.pitch`, and `face.angle.roll`. The code deliberately reports an error if those values are absent rather than silently treating missing pose data as a successful check.

A head-movement challenge alone can be spoofed with replayed or manipulated video. Do not use this client-side result as proof of identity or as the sole control for KYC, payments, account recovery, or other high-risk flows.
