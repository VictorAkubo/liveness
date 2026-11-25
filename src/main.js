import * as faceapi from "@vladmandic/face-api";

const video    = document.getElementById("video");
const overlay  = document.getElementById("overlay");
const ctx      = overlay.getContext("2d");
const labelEl  = document.getElementById("label");
const subEl    = document.getElementById("sublabel");
const dotsEl   = document.getElementById("dots");
const gate     = document.getElementById("gate");
const retryBtn = document.getElementById("retryBtn");

const STEPS = [
  { label: "Turn LEFT",  type: "left"  },
  { label: "Turn RIGHT", type: "right" },
  { label: "Look UP",    type: "up"    },
  { label: "Look DOWN",  type: "down"  },
];

const YAW_DEG    = 14;
const PITCH_DEG  = 11;
const CENTER_DEG = 9;
const HOLD_N     = 4;
const CALIB_N    = 15;
const TIMEOUT_MS = 60000;

let stream    = null;
let running   = false;
let baseline  = null;
let calibBuf  = [];
let stepIdx   = 0;
let held      = 0;
let startedAt = 0;
let ovalColor = "#6366f1";
let ovalGlow  = false;

// ── dots ───────────────────────────────────────────────────────────────────

function buildDots() {
  dotsEl.innerHTML = "";
  STEPS.forEach((_, i) => {
    const d = document.createElement("div");
    d.className = "dot";
    d.id = `d${i}`;
    dotsEl.appendChild(d);
  });
}

function refreshDots() {
  STEPS.forEach((_, i) => {
    const d = document.getElementById(`d${i}`);
    if (!d) return;
    d.className = i < stepIdx ? "dot done" : i === stepIdx ? "dot active" : "dot";
  });
}

// ── pose estimation ────────────────────────────────────────────────────────
// 68-point landmarks, raw (unmirrored) video coords.
//
// YAW  — nose tip x offset from eye-midpoint, normalised by inter-ocular width
//         +ve = person's left, −ve = person's right
// PITCH — nose tip y relative to [eye-midpoint → chin] span
//         neutral ≈ 0.38–0.42; lower = looking up, higher = looking down

function pose(lm) {
  const p  = lm.positions;
  const iod = Math.hypot(p[45].x - p[36].x, p[45].y - p[36].y);
  if (iod < 1) return null;

  const eyeMidX = (p[36].x + p[45].x) / 2;
  const eyeMidY = (p[36].y + p[45].y) / 2;

  const yaw   = ((p[30].x - eyeMidX) / (iod * 0.5)) * 25;

  const faceH = Math.hypot(p[8].x - eyeMidX, p[8].y - eyeMidY);
  if (faceH < 1) return null;
  const ratio  = (p[30].y - eyeMidY) / faceH;
  const pitch  = (ratio - 0.40) * 90;

  return { yaw, pitch };
}

function rel(p) {
  return { yaw: p.yaw - baseline.yaw, pitch: p.pitch - baseline.pitch };
}

function matches(type, p) {
  const { yaw, pitch } = rel(p);
  if (type === "center") return Math.abs(yaw) < CENTER_DEG && Math.abs(pitch) < CENTER_DEG;
  if (type === "left")   return yaw  >  YAW_DEG;
  if (type === "right")  return yaw  < -YAW_DEG;
  if (type === "up")     return pitch < -PITCH_DEG;
  if (type === "down")   return pitch >  PITCH_DEG;
  return false;
}

// ── calibration ────────────────────────────────────────────────────────────

function calibrate(p) {
  calibBuf.push(p);
  const pct = Math.round((calibBuf.length / CALIB_N) * 100);
  labelEl.textContent = "Hold still…";
  subEl.textContent   = `Calibrating ${pct}%`;
  ovalColor = "#f59e0b";
  ovalGlow  = false;

  if (calibBuf.length < CALIB_N) return;
  const mean = key => calibBuf.reduce((s, x) => s + x[key], 0) / calibBuf.length;
  baseline = { yaw: mean("yaw"), pitch: mean("pitch") };
  calibBuf = [];
  ovalColor = "#6366f1";
  labelEl.textContent = STEPS[0].label;
  subEl.textContent   = "";
  refreshDots();
}

// ── step logic ─────────────────────────────────────────────────────────────

function advance() {
  held = 0;
  stepIdx++;
  refreshDots();

  if (stepIdx >= STEPS.length) {
    done(true);
    return;
  }
  labelEl.textContent = STEPS[stepIdx].label;
  subEl.textContent   = "";
  ovalColor  = "#6366f1";
  ovalGlow   = false;
}

function tick(p) {
  if (!baseline) { calibrate(p); return; }

  const step = STEPS[stepIdx];

  if (matches(step.type, p)) {
    held++;
    ovalColor = "#22c55e";
    ovalGlow  = true;
    subEl.textContent = `Hold… ${held}/${HOLD_N}`;
    if (held >= HOLD_N) advance();
  } else {
    held      = 0;
    ovalColor = "#6366f1";
    ovalGlow  = false;
    const r = rel(p);
    subEl.textContent = `↔ ${r.yaw.toFixed(1)}°  ↕ ${r.pitch.toFixed(1)}°`;
  }
}

// ── canvas ─────────────────────────────────────────────────────────────────

function syncSize() {
  if (overlay.width !== video.videoWidth) overlay.width = video.videoWidth || overlay.clientWidth;
  if (overlay.height !== video.videoHeight) overlay.height = video.videoHeight || overlay.clientHeight;
}

function drawArrow(W, H, cx, cy, type) {
  const reach = Math.min(W, H) * 0.38;
  let tx = cx, ty = cy;

  if (type === "left")  tx = cx - reach;
  if (type === "right") tx = cx + reach;
  if (type === "up")    ty = cy - reach * 1.1;
  if (type === "down")  ty = cy + reach * 0.9;

  const angle = Math.atan2(ty - cy, tx - cx);
  const len   = Math.hypot(tx - cx, ty - cy) * 0.55;
  const sx    = cx + Math.cos(angle) * len * 0.1;
  const sy    = cy + Math.sin(angle) * len * 0.1;
  const ex    = cx + Math.cos(angle) * len;
  const ey    = cy + Math.sin(angle) * len;

  const hw = 11;
  const aw = 20;

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.fillStyle   = "rgba(255,255,255,0.9)";
  ctx.lineWidth   = 3;
  ctx.lineCap     = "round";
  ctx.shadowColor = "#fff";
  ctx.shadowBlur  = 8;

  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex - Math.cos(angle) * aw, ey - Math.sin(angle) * aw);
  ctx.stroke();

  // arrowhead
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(
    ex - Math.cos(angle - 0.5) * aw,
    ey - Math.sin(angle - 0.5) * aw
  );
  ctx.lineTo(
    ex - Math.cos(angle + 0.5) * aw,
    ey - Math.sin(angle + 0.5) * aw
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawFrame(detected, lm, currentPose) {
  syncSize();
  const W = overlay.width;
  const H = overlay.height;
  ctx.clearRect(0, 0, W, H);

  const cx = W * 0.5;
  const cy = H * 0.44;
  const rx = W * 0.33;
  const ry = H * 0.44;

  // vignette with oval cutout
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.52)";
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // oval ring
  ctx.save();
  ctx.lineWidth   = 3.5;
  ctx.strokeStyle = ovalColor;
  if (ovalGlow) {
    ctx.shadowColor = ovalColor;
    ctx.shadowBlur  = 18;
  }
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // direction arrow — only after calibration, only when not already matching
  if (baseline && stepIdx < STEPS.length && detected && !ovalGlow) {
    drawArrow(W, H, cx, cy, STEPS[stepIdx].type);
  }

  // face mesh
  if (detected && lm) drawMesh(lm, W, H);
}

function drawMesh(lm, W, H) {
  const raw = lm.positions;
  const sx = W / video.videoWidth;
  const sy = H / video.videoHeight;
  const pt = i => ({ x: W - raw[i].x * sx, y: raw[i].y * sy });

  const segs = [
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
    [17,18,19,20,21],
    [22,23,24,25,26],
    [27,28,29,30,31,32,33,34,35],
    [36,37,38,39,40,41,36],
    [42,43,44,45,46,47,42],
    [48,49,50,51,52,53,54,55,56,57,58,59,48],
  ];

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.28)";
  ctx.lineWidth   = 1;
  ctx.lineJoin    = "round";
  segs.forEach(seg => {
    ctx.beginPath();
    seg.forEach((idx, i) => {
      const p = pt(idx);
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  });
  ctx.restore();
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function stopCamera() {
  running = false;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
}

function done(ok, reason = null) {
  const ms = Date.now() - startedAt;
  stopCamera();
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (ok) {
    labelEl.textContent = "✅  Verified";
    subEl.textContent   = "All checks passed";
    dotsEl.querySelectorAll(".dot").forEach(d => d.className = "dot done");
  } else {
    labelEl.textContent = "❌  Failed";
    subEl.textContent   = reason || "Please try again";
  }

  retryBtn.style.display = "block";

  window.dispatchEvent(new CustomEvent("liveness-result", {
    detail: { completed: ok, reason, completedSteps: stepIdx, totalSteps: STEPS.length, elapsedMs: ms },
  }));
}

async function run() {
  retryBtn.style.display = "none";
  baseline  = null;
  calibBuf  = [];
  stepIdx   = 0;
  held      = 0;
  ovalColor = "#6366f1";
  ovalGlow  = false;

  buildDots();
  labelEl.textContent = "Loading…";
  subEl.textContent   = "";

  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
      faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
    ]);

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    });

    video.srcObject = stream;
    await video.play();

    gate.classList.add("hidden");
    running   = true;
    startedAt = Date.now();

    labelEl.textContent = "Hold still…";

    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

    while (running) {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        done(false, "Time limit reached");
        break;
      }

      const dets = await faceapi.detectAllFaces(video, opts).withFaceLandmarks();
      if (!running) break;

      if (dets.length !== 1) {
        held = 0;
        if (!baseline) calibBuf = [];
        ovalColor = "#ef4444";
        ovalGlow  = false;
        drawFrame(false, null, null);

        const noFace = dets.length === 0;
        if (!baseline) {
          labelEl.textContent = "Hold still…";
          subEl.textContent   = noFace ? "Move into the oval" : "One face only";
        } else {
          labelEl.textContent = STEPS[stepIdx]?.label ?? "";
          subEl.textContent   = noFace ? "Keep your face visible" : "One face only";
        }
      } else {
        const lm = dets[0].landmarks;
        const p  = pose(lm);
        if (p) {
          tick(p);
          drawFrame(true, lm, p);
        }
      }

      if (!running) break;
      await new Promise(r => setTimeout(r, 80));
    }

  } catch (err) {
    stopCamera();
    labelEl.textContent = "Camera error";
    subEl.textContent   = err.message;
    retryBtn.style.display = "block";
    console.error(err);
  }
}

gate.addEventListener("click", run);
retryBtn.addEventListener("click", () => {
  gate.classList.remove("hidden");
  labelEl.textContent = "Position your face in the oval";
  subEl.textContent   = "";
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  buildDots();
  run();
});

buildDots();

window.addEventListener("liveness-result", e => console.log("liveness:", e.detail));
