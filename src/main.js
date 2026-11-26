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
  { label: "Face in oval, blink slowly", type: "blink",      count: 3 },
];

const YAW_DEG           = 14;
const PITCH_DEG         = 11;
const MOUTH_OPEN_THR    = 0.22;
const BLINK_CLOSE_RATIO = 0.74;   // eyes need only narrow to 74% of open to count
const BLINK_OPEN_RATIO  = 0.86;   // and reopen to 86% to complete the blink
const BLINK_MIN_MS      = 15;     // ignore sub-frame noise
const BLINK_MAX_MS      = 700;    // ignore long squints / closing your eyes
const HOLD_N            = 4;
const CALIB_N           = 20;
const TIMEOUT           = 90000;

let stream     = null;
let running    = false;
let baseline   = null;
let calibBuf   = [];
let stepIdx    = 0;
let held       = 0;
let blinkCount = 0;
let eyesClosed = false;
let closedAt   = 0;
let openEar    = null;
let earSmooth  = null;
let startedAt  = 0;
let ovalColor = "#6366f1";
let ovalGlow  = false;
let rafId     = null;
let faceMesh  = null;

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

  const lEyeTop = lpt(lm, 159, W, H);
  const lEyeBot = lpt(lm, 145, W, H);
  const lEyeOut = lpt(lm, 33,  W, H);
  const lEyeIn  = lpt(lm, 133, W, H);
  const rEyeTop = lpt(lm, 386, W, H);
  const rEyeBot = lpt(lm, 374, W, H);
  const rEyeOut = lpt(lm, 263, W, H);
  const rEyeIn  = lpt(lm, 362, W, H);

  const earL = dist(lEyeOut, lEyeIn) > 1 ? dist(lEyeTop, lEyeBot) / dist(lEyeOut, lEyeIn) : 0;
  const earR = dist(rEyeOut, rEyeIn) > 1 ? dist(rEyeTop, rEyeBot) / dist(rEyeOut, rEyeIn) : 0;
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
  calibBuf.push(m);
  const pct = Math.round((calibBuf.length / CALIB_N) * 100);
  labelEl.textContent = "Hold still…";
  subEl.textContent   = `Calibrating ${pct}%`;
  ovalColor = "#f59e0b";
  ovalGlow  = false;

  if (calibBuf.length < CALIB_N) return;

  const mean = key => calibBuf.reduce((s, x) => s + x[key], 0) / calibBuf.length;

  // Use a high percentile for the open-eye reference, not the mean: a blink or
  // half-closed eyes while calibrating must not drag the threshold down.
  const ears = calibBuf.map(x => x.ear).sort((a, b) => a - b);
  const openEarRef = ears[Math.floor((ears.length - 1) * 0.75)];

  baseline = { yaw: mean("yaw"), pitch: mean("pitch"), mar: mean("mar"), ear: openEarRef };
  calibBuf = [];
  ovalColor = "#6366f1";
  labelEl.textContent = STEPS[0].label;
  subEl.textContent   = "";
  refreshDots();
}

function advance() {
  held       = 0;
  blinkCount = 0;
  eyesClosed = false;
  closedAt   = 0;
  openEar    = null;
  earSmooth  = null;
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
}

function tick(m) {
  if (!baseline) { calibrate(m); return; }

  const step = STEPS[stepIdx];

  if (step.type === "blink") {
    // Light smoothing keeps landmark jitter from faking blinks without
    // hiding a fast one (most of the new value still comes through).
    earSmooth = earSmooth == null ? m.ear : earSmooth + (m.ear - earSmooth) * 0.65;

    // Track the current open-eye level so thresholds follow this face/camera
    // instead of relying only on the one-off calibration measurement.
    if (openEar == null) openEar = baseline.ear;
    const closeThr = openEar * BLINK_CLOSE_RATIO;
    const openThr  = openEar * BLINK_OPEN_RATIO;
    const now      = performance.now();

    if (!eyesClosed && earSmooth <= closeThr) {
      eyesClosed = true;
      closedAt   = now;
      ovalColor  = "#22c55e";
      ovalGlow   = true;
    } else if (eyesClosed) {
      if (earSmooth >= openThr) {
        const dur = now - closedAt;
        eyesClosed = false;
        ovalColor  = "#6366f1";
        ovalGlow   = false;
        if (dur >= BLINK_MIN_MS && dur <= BLINK_MAX_MS) blinkCount++;
      } else if (now - closedAt > BLINK_MAX_MS) {
        // Eyes stayed shut too long to be a blink — rearm without counting.
        eyesClosed = false;
        ovalColor  = "#6366f1";
        ovalGlow   = false;
      }
    } else if (earSmooth > closeThr) {
      // Adapt the open-eye reference while eyes are open. Rise quickly so wide
      // eyes raise the bar, fall slowly so a passing squint doesn't skew it.
      const alpha = earSmooth > openEar ? 0.25 : 0.03;
      openEar += (earSmooth - openEar) * alpha;
    }

    subEl.textContent = `Blinks: ${blinkCount}/${step.count}`;
    if (blinkCount >= step.count) advance();
    return;
  }

  if (matches(step.type, m)) {
    held++;
    ovalColor = "#22c55e";
    ovalGlow  = true;
    const holdNeeded = step.hold ?? HOLD_N;
    subEl.textContent = `Hold… ${held}/${holdNeeded}`;
    if (held >= holdNeeded) advance();
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

  // cut out the oval from the dark overlay
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
    held       = 0;
    eyesClosed = false;
    closedAt   = 0;
    earSmooth  = null;
    if (!baseline) calibBuf = [];
    ovalColor = "#ef4444";
    ovalGlow  = false;
    drawFrame();
    labelEl.textContent = !baseline ? "Hold still…" : (STEPS[stepIdx]?.label ?? "");
    subEl.textContent   = "Move into the oval";
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

  baseline   = null;
  calibBuf   = [];
  stepIdx    = 0;
  held       = 0;
  blinkCount = 0;
  eyesClosed = false;
  closedAt   = 0;
  openEar    = null;
  earSmooth  = null;
  ovalColor  = "#6366f1";
  ovalGlow   = false;

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
        refineLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
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
    labelEl.textContent = "Hold still…";
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
