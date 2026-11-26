const { FaceMesh } = window;

const video    = document.getElementById("video");
const overlay  = document.getElementById("overlay");
const ctx      = overlay.getContext("2d");
const labelEl  = document.getElementById("label");
const subEl    = document.getElementById("sublabel");
const dotsEl   = document.getElementById("dots");
const gate     = document.getElementById("gate");
const retryBtn = document.getElementById("retryBtn");

const STEPS = [
  { label: "Turn your head LEFT",  type: "left",       hold: 4 },
  { label: "Turn your head RIGHT", type: "right",      hold: 4 },
  { label: "Look UP",              type: "up",         hold: 4 },
  { label: "Look DOWN",            type: "down",       hold: 4 },
  { label: "Open your mouth wide", type: "mouth_open", hold: 3 },
  { label: "Face in oval, blink once", type: "blink", count: 1 },
];

const YAW_DEG        = 14;
const PITCH_DEG      = 11;
const MOUTH_OPEN_THR = 0.22;
const HOLD_N         = 4;
const CALIB_N        = 30;
const TIMEOUT        = 90000;

// Simple, reliable single-blink detection
const BLINK = {
  CLOSE_RATIO: 0.60,      // Eye closed at 60% of open
  OPEN_RATIO:  0.80,      // Eye open at 80% of open
  MIN_MS:      50,        // Minimum blink duration
  MAX_MS:      500,       // Maximum blink duration
  SMOOTH:      0.3,       // EAR smoothing
  CALIB_FRAMES: 30,
  OPEN_PCT:    0.85,      // 85th percentile for baseline
};

let stream     = null;
let running    = false;
let baseline   = null;
let calibBuf   = [];
let stepIdx    = 0;
let held       = 0;
let startedAt  = 0;
let ovalColor  = "#6366f1";
let ovalGlow   = false;
let rafId      = null;
let faceMesh   = null;

// Blink state
const B = {
  calibFrames: 0,
  earHistory: [],
  openEar: null,
  ear: null,
  state: "OPEN",       // OPEN | CLOSED
  closedAt: 0,
  blinkCount: 0,
  done: false,
};

function buildDots() {
  dotsEl.innerHTML = "";
  STEPS.forEach((_, i) => {
    const dot = document.createElement("div");
    dot.className = "dot";
    dot.id = `d${i}`;
    dotsEl.appendChild(dot);
  });
}

function refreshDots() {
  STEPS.forEach((_, i) => {
    const dot = document.getElementById(`d${i}`);
    if (!dot) return;
    dot.className = i < stepIdx ? "dot done" : i === stepIdx ? "dot active" : "dot";
  });
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lpt(lm, idx, W, H) {
  return { x: lm[idx].x * W, y: lm[idx].y * H };
}

function getEAR(lm, W, H, isLeft) {
  if (isLeft) {
    const top = lpt(lm, 159, W, H);
    const bot = lpt(lm, 145, W, H);
    const out = lpt(lm, 33,  W, H);
    const inn = lpt(lm, 133, W, H);
    const w = dist(out, inn);
    return w > 1 ? dist(top, bot) / w : 0;
  } else {
    const top = lpt(lm, 386, W, H);
    const bot = lpt(lm, 374, W, H);
    const out = lpt(lm, 263, W, H);
    const inn = lpt(lm, 362, W, H);
    const w = dist(out, inn);
    return w > 1 ? dist(top, bot) / w : 0;
  }
}

function getMeasurements(lm) {
  const W = video.videoWidth;
  const H = video.videoHeight;

  const nose = lpt(lm, 1,   W, H);
  const eyeL = lpt(lm, 33,  W, H);
  const eyeR = lpt(lm, 263, W, H);
  const chin = lpt(lm, 152, W, H);

  const iod = dist(eyeL, eyeR);
  if (iod < 1) return null;

  const eyeMidX = (eyeL.x + eyeR.x) / 2;
  const eyeMidY = (eyeL.y + eyeR.y) / 2;
  const yaw     = ((nose.x - eyeMidX) / (iod * 0.5)) * 25;
  const faceH   = dist({ x: eyeMidX, y: eyeMidY }, chin);
  if (faceH < 1) return null;
  const pitch   = ((nose.y - eyeMidY) / faceH - 0.40) * 90;

  const mTop = lpt(lm, 13,  W, H);
  const mBot = lpt(lm, 14,  W, H);
  const mL   = lpt(lm, 61,  W, H);
  const mR   = lpt(lm, 291, W, H);
  const mW   = dist(mL, mR);
  const mar  = mW > 1 ? dist(mTop, mBot) / mW : 0;

  const earL = getEAR(lm, W, H, true);
  const earR = getEAR(lm, W, H, false);
  const ear  = (earL + earR) / 2;

  return { yaw, pitch, mar, ear };
}

function matches(type, m) {
  const dy   = m.yaw   - baseline.yaw;
  const dp   = m.pitch - baseline.pitch;
  const dmar = m.mar   - baseline.mar;

  switch (type) {
    case "left":       return dy   >  YAW_DEG;
    case "right":      return dy   < -YAW_DEG;
    case "up":         return dp   < -PITCH_DEG;
    case "down":       return dp   >  PITCH_DEG;
    case "mouth_open": return dmar >  MOUTH_OPEN_THR;
    default:           return false;
  }
}

function calibrate(m) {
  B.calibFrames++;
  B.earHistory.push(m.ear);

  const pct = Math.round((B.calibFrames / BLINK.CALIB_FRAMES) * 100);
  labelEl.textContent = "Hold still, eyes open…";
  subEl.textContent   = `Calibrating ${pct}%`;
  ovalColor = "#f59e0b";
  ovalGlow  = false;

  if (B.calibFrames < BLINK.CALIB_FRAMES) return;

  // 85th percentile = open eye baseline (ignores accidental blinks)
  const sorted = [...B.earHistory].sort((a, b) => a - b);
  B.openEar = sorted[Math.floor((sorted.length - 1) * BLINK.OPEN_PCT)];
  B.ear = B.openEar;

  baseline = { yaw: m.yaw, pitch: m.pitch, mar: m.mar, ear: B.openEar };
  B.calibFrames = 0;
  B.earHistory = [];

  ovalColor = "#6366f1";
  labelEl.textContent = STEPS[0].label;
  subEl.textContent   = "";
  refreshDots();
}

function advance() {
  held      = 0;
  stepIdx++;
  refreshDots();
  if (stepIdx >= STEPS.length) {
    done(true);
    return;
  }
  labelEl.textContent = STEPS[stepIdx].label;
  subEl.textContent   = "";
  ovalColor = "#6366f1";
  ovalGlow  = false;

  // Reset blink for new step
  B.state = "OPEN";
  B.blinkCount = 0;
  B.done = false;
}

function tick(m) {
  if (!baseline) { calibrate(m); return; }

  const step = STEPS[stepIdx];
  const now = performance.now();

  // Smooth EAR
  B.ear = B.ear + (m.ear - B.ear) * BLINK.SMOOTH;

  const closeThr = B.openEar * BLINK.CLOSE_RATIO;
  const openThr  = B.openEar * BLINK.OPEN_RATIO;

  if (step.type === "blink") {
    if (B.state === "OPEN") {
      // Detect eye closure
      if (B.ear <= closeThr) {
        B.state = "CLOSED";
        B.closedAt = now;
        ovalColor = "#22c55e";
        ovalGlow = true;
        subEl.textContent = "Eyes closed…";
      }
    } else { // CLOSED
      // Detect reopening
      if (B.ear >= openThr) {
        const dur = now - B.closedAt;
        B.state = "OPEN";
        ovalColor = "#6366f1";
        ovalGlow = false;

        if (dur >= BLINK.MIN_MS && dur <= BLINK.MAX_MS) {
          B.blinkCount++;
          B.done = true;
          subEl.textContent = `✓ Blink detected (${dur.toFixed(0)}ms)`;
          ovalColor = "#22c55e";
          ovalGlow = true;
          setTimeout(() => advance(), 500);
        } else {
          subEl.textContent = dur < BLINK.MIN_MS ? "⚠ Too fast, blink naturally" : "⚠ Too slow, try again";
          ovalColor = "#ef4444";
          ovalGlow = true;
        }
      }
    }

    if (!B.done) {
      subEl.textContent = `Blinks: ${B.blinkCount}/${step.count}  |  EAR: ${B.ear.toFixed(3)}`;
    }
    return;
  }

  // Non-blink steps
  if (matches(step.type, m)) {
    held++;
    ovalColor = "#22c55e";
    ovalGlow  = true;
    const need = step.hold ?? HOLD_N;
    subEl.textContent = `Hold… ${held}/${need}`;
    if (held >= need) advance();
  } else {
    held      = 0;
    ovalColor = "#6366f1";
    ovalGlow  = false;
    subEl.textContent = "";
  }
}

function syncSize() {
  const w = video.videoWidth  || overlay.clientWidth;
  const h = video.videoHeight || overlay.clientHeight;
  if (overlay.width !== w)  overlay.width  = w;
  if (overlay.height !== h) overlay.height = h;
}

function drawFrame() {
  syncSize();
  const W = overlay.width;
  const H = overlay.height;
  ctx.clearRect(0, 0, W, H);

  const cx = W * 0.5;
  const cy = H * 0.44;
  const rx = W * 0.33;
  const ry = H * 0.44;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.52)";
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.lineWidth   = 3.5;
  ctx.strokeStyle = ovalColor;
  if (ovalGlow) { ctx.shadowColor = ovalColor; ctx.shadowBlur = 18; }
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function stopCamera() {
  running = false;
  cancelAnimationFrame(rafId);
  rafId = null;
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
    dotsEl.querySelectorAll(".dot").forEach(dot => dot.className = "dot done");
  } else {
    labelEl.textContent = "❌  Failed";
    subEl.textContent   = reason || "Please try again";
  }

  retryBtn.style.display = "block";

  window.dispatchEvent(new CustomEvent("liveness-result", {
    detail: { completed: ok, reason, completedSteps: stepIdx, totalSteps: STEPS.length, elapsedMs: ms },
  }));
}

function onResults(results) {
  if (!running) return;

  const lm = results.multiFaceLandmarks?.[0];

  if (!lm) {
    held = 0;
    ovalColor = "#ef4444";
    ovalGlow  = false;
    drawFrame();
    labelEl.textContent = !baseline ? "Hold still…" : (STEPS[stepIdx]?.label ?? "");
    subEl.textContent   = "Move face into oval";
    return;
  }

  if (Date.now() - startedAt > TIMEOUT) {
    done(false, "Time limit reached");
    return;
  }

  const m = getMeasurements(lm);
  if (m) {
    tick(m);
    drawFrame();
  }
}

async function run() {
  gate.classList.add("hidden");
  retryBtn.style.display = "none";

  baseline     = null;
  calibBuf     = [];
  stepIdx      = 0;
  held         = 0;
  startedAt    = 0;
  ovalColor    = "#6366f1";
  ovalGlow     = false;

  B.calibFrames = 0;
  B.earHistory  = [];
  B.openEar     = null;
  B.ear         = null;
  B.state       = "OPEN";
  B.closedAt    = 0;
  B.blinkCount  = 0;
  B.done        = false;

  buildDots();
  labelEl.textContent = "Loading models…";
  subEl.textContent   = "This may take a few seconds";

  try {
    if (!faceMesh) {
      faceMesh = new FaceMesh({
        locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      faceMesh.onResults(onResults);
      await faceMesh.initialize();
    }

    labelEl.textContent = "Requesting camera…";
    subEl.textContent   = "";

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    });

    video.srcObject = stream;
    await video.play();

    running   = true;
    startedAt = Date.now();
    labelEl.textContent = "Hold still, eyes open…";
    subEl.textContent   = "";

    async function loop() {
      if (!running) return;
      if (video.readyState >= 2) await faceMesh.send({ image: video });
      if (!running) return;
      rafId = requestAnimationFrame(loop);
    }
    loop();

  } catch (err) {
    stopCamera();
    gate.classList.remove("hidden");
    labelEl.textContent = "Position your face in the oval";
    subEl.textContent   = err.message;
    retryBtn.style.display = "block";
    console.error(err);
  }
}

gate.addEventListener("click", run);

retryBtn.addEventListener("click", () => {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  buildDots();
  run();
});

buildDots();

window.addEventListener("liveness-result", e => console.log("liveness:", e.detail));