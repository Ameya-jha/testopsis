"use strict";

/* Tell: reads face, mood and posture from the webcam with MediaPipe.
   The library and models download once; your video stays on your device.
   analysis.js = maths, vault.js = encrypted storage, this file = camera, loop, UI. */

const A = window.Analysis;
const Vault = window.Vault;
const { EMOTIONS, EMO, clamp, ema } = A;

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const GOOD = "#46ffb0", WARN = "#ffb000", BAD = "#ff3b30", BONE = "#efeee8", INK = "#050505";
const KEY_SETTINGS = "tell.settings2";

/* ---- Small helpers ------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const pad = (n) => String(n).padStart(2, "0");
const fmtClock = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const fmtShort = (s) => (s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${pad(Math.floor(s % 60))}s` : `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`);
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
const levelColor = (score) => (score == null ? BONE : score >= 80 ? GOOD : score >= 60 ? WARN : BAD);
function download(name, text, type) {
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---- Settings ----------------------------------------------------------- */

const DEFAULTS = {
  mesh: false, outline: true, box: true, skeleton: true, mirror: true,
  faces: 1, camera: "", perf: "auto", bg: true, wake: false, alerts: false, breakMin: 30,
  faceStrict: 1, autolock: true,
};
const S = Object.assign({}, DEFAULTS, store.get(KEY_SETTINGS, {}));

/* ---- DOM ---------------------------------------------------------------- */

const ui = {};
[
  "stage", "video", "overlay", "placeholder", "message", "calib", "calibCount", "calibText",
  "faceCount", "fps", "toasts", "toggleBtn", "calibBtn", "pipBtn", "csvBtn", "fsBtn",
  "statusText", "sessionClock", "vaultStat",
  "moodEmoji", "moodWord", "moodInt", "moodNote", "emoList",
  "postureState", "postureScore", "scoreWrap", "postureCanvas", "postureIssue", "postureSplit", "postureRows",
  "headMeters", "gaze", "gazeDot", "headRows", "gestureFlash", "eyeStats", "auMeters",
  "streamCanvas", "streamLegend", "mapCanvas", "lineCanvas", "sessionStats", "emoTime",
  "hud", "hudHome", "hudPh", "hudEmoji", "hudWord", "hudSub", "hudPosture", "hudFocus", "hudBlink", "hudSit", "hudAlert",
  "cameraSel", "historyList", "histCap", "favicon",
  "vaultState", "vaultNote", "vaultActions", "restoreFile", "vaultDlg", "vaultForm", "dlgTitle", "dlgBody", "dlgClose",
].forEach((id) => (ui[id] = $(id)));
const video = ui.video, canvas = ui.overlay, ctx = canvas.getContext("2d");

/* ---- Live state ----------------------------------------------------------- */

let lib = null, fileset = null, faceTask = null, poseTask = null, drawing = null;
let usedDelegate = "GPU", poseFailed = false, loadedFaces = 0, swapping = false;
let stream = null, imageCapture = null, running = false, busy = false;
let lastVideoTime = -1, lastTs = 0, lastPoseAt = 0, lastPoseResultAt = 0, lastFrameAt = 0, lastFaceAt = 0, lastDetectAt = 0;
let lastUi = 0, lastSample = 0, lastSave = 0, lastSmall = 0, frames = 0, fpsStart = performance.now();
let avgFace = 12, avgPose = 15;
let W = 960, H = 540;
const frameCanvas = document.createElement("canvas");
const fctx = frameCanvas.getContext("2d");

const trackers = [];
let headEst = new A.HeadPose();
let gest = new A.Gestures();
let baseline = null;
let history = [];
let calib = null;
let epiEmo = null, epiStart = 0;
let poorSince = null, closeSince = null, lastBreakAlert = 0;
const alertLast = {};
const moodTrail = [];
let audioCtx = null, wakeLock = null, pipWin = null;

/* Admin vault state */
let vaultOpen = false, vaultExistsFlag = false, vaultUnavailable = !Vault || !Vault.available;
let faceTpl = null, faceTplMean = null, faceScan = null, formHandler = null, pendingPass = null;
let lastAdminSeen = 0, idleSince = 0, lastDescAt = 0, saving = false, warnedShort = false;
let scanUi = null;
const watchBuf = [];

const L = {
  present: false, faces: 0, faceEmos: [], emo: null, b: {}, gaze: { x: 0, y: 0 }, head: null,
  rel: { yaw: 0, pitch: 0, roll: 0 }, attention: 0, val: 0, aro: 0,
  posture: null, postureSmooth: null, postureAt: 0, poseLm: null,
};

function newSession() {
  return {
    id: Date.now(), start: Date.now(), present: 0, away: 0, awayRun: 0, sitting: 0,
    emoTime: Object.fromEntries(EMOTIONS.map((e) => [e.id, 0])),
    episodes: Object.fromEntries(EMOTIONS.map((e) => [e.id, 0])),
    postureTime: { good: 0, okay: 0, poor: 0 }, postureSum: 0, postureN: 0,
    attSum: 0, attN: 0, samples: [],
  };
}
let sess = newSession();

/* ---- Small UI components ---------------------------------------------------- */

function makeMeter(parent, label, centered) {
  const row = el("div", "meter" + (centered ? " centered" : ""), `<span>${label}</span><div class="track"><i></i></div><b>0</b>`);
  parent.append(row);
  const bar = row.querySelector("i"), val = row.querySelector("b");
  return {
    set(frac, text) {
      if (centered) {
        const v = clamp(frac, -1, 1);
        bar.style.left = `${50 + Math.min(0, v) * 50}%`;
        bar.style.width = `${Math.abs(v) * 50}%`;
      } else {
        bar.style.left = "0";
        bar.style.width = `${clamp(frac, 0, 1) * 100}%`;
      }
      val.textContent = text;
    },
  };
}
function makeRow(parent, label) {
  const row = el("div", "row", `<span>${label}</span><b>--</b>`);
  parent.append(row);
  const b = row.querySelector("b");
  return { set(text, level) { b.textContent = text; row.dataset.level = level || ""; } };
}
function makeStat(parent, label) {
  const s = el("div", "stat", `<b>0</b><span>${label}</span>`);
  parent.append(s);
  const b = s.querySelector("b");
  return { set(text) { b.textContent = text; } };
}
function retrigger(node) {
  node.classList.remove("pop");
  void node.offsetWidth;
  node.classList.add("pop");
}
function toast(text, kind) {
  const t = el("div", "toast" + (kind ? " " + kind : ""));
  t.textContent = text;
  ui.toasts.append(t);
  setTimeout(() => t.remove(), 6000);
  while (ui.toasts.children.length > 3) ui.toasts.firstChild.remove();
}
function showMessage(text) {
  ui.message.textContent = text;
  ui.placeholder.classList.remove("hidden");
}
function setStatus(kind, text) {
  ui.statusText.textContent = text;
  document.body.dataset.status = kind;
}

/* Build the static parts of the dashboard. */
const emoRows = EMOTIONS.map((e) => {
  const li = el("li", "", `<span class="emo-ico">${e.emoji}</span><span class="emo-name">${e.label}</span><span class="emo-track"><i></i></span><span class="emo-pct">0%</span>`);
  ui.emoList.append(li);
  return { li, fill: li.querySelector("i"), pct: li.querySelector(".emo-pct") };
});
EMOTIONS.forEach((e) => ui.streamLegend.append(el("span", "", `<i style="background:${e.color}"></i>${e.label}`)));

const hm = {
  yaw: makeMeter(ui.headMeters, "Turn", true),
  pitch: makeMeter(ui.headMeters, "Nod", true),
  roll: makeMeter(ui.headMeters, "Tilt", true),
};
const hr = {
  focus: makeRow(ui.headRows, "Focus"),
  dist: makeRow(ui.headRows, "Distance"),
  gaze: makeRow(ui.headRows, "Looking"),
};
const es = {
  blinks: makeStat(ui.eyeStats, "blinks"),
  rate: makeStat(ui.eyeStats, "blinks/min"),
  drowsy: makeStat(ui.eyeStats, "drowsiness"),
  yawns: makeStat(ui.eyeStats, "yawns"),
  nods: makeStat(ui.eyeStats, "nods"),
  shakes: makeStat(ui.eyeStats, "head shakes"),
};
const au = {
  smile: makeMeter(ui.auMeters, "Smile"),
  browUp: makeMeter(ui.auMeters, "Brow raise"),
  browDown: makeMeter(ui.auMeters, "Brow furrow"),
  wide: makeMeter(ui.auMeters, "Eyes wide"),
  jaw: makeMeter(ui.auMeters, "Mouth open"),
  pucker: makeMeter(ui.auMeters, "Lip pucker"),
};
const ss = {
  dur: makeStat(ui.sessionStats, "session time"),
  face: makeStat(ui.sessionStats, "face in view"),
  post: makeStat(ui.sessionStats, "avg posture"),
  focus: makeStat(ui.sessionStats, "avg focus"),
  sit: makeStat(ui.sessionStats, "sitting"),
  smiles: makeStat(ui.sessionStats, "smiles"),
};
const pr = {
  tilt: makeRow(ui.postureRows, "Shoulders"),
  head: makeRow(ui.postureRows, "Head tilt"),
  slouch: makeRow(ui.postureRows, "Slouch"),
  forward: makeRow(ui.postureRows, "Head forward"),
  lean: makeRow(ui.postureRows, "Lean in"),
  shift: makeRow(ui.postureRows, "Sideways shift"),
};

/* ---- Settings wiring ------------------------------------------------------------ */

document.querySelectorAll("[data-set]").forEach((input) => {
  const key = input.dataset.set;
  if (input.type === "checkbox") input.checked = !!S[key];
  else input.value = S[key];
  input.addEventListener("change", () => {
    S[key] = input.type === "checkbox" ? input.checked : input.dataset.type === "number" ? Number(input.value) : input.value;
    store.set(KEY_SETTINGS, S);
    onSettingChange(key);
  });
});

function onSettingChange(key) {
  if (key === "mirror") ui.stage.classList.toggle("mirror", S.mirror);
  if (key === "faces" && running) rebuildFaceTask();
  if (key === "camera" && running) swapCamera();
  if (key === "bg") applyTicker();
  if (key === "wake") setWake();
  if (key === "alerts" && S.alerts) {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }
}
ui.stage.classList.toggle("mirror", S.mirror);

/* ---- Models --------------------------------------------------------------------- */

async function makeTask(Task, options) {
  const withDelegate = (delegate) => ({ ...options, baseOptions: { ...options.baseOptions, delegate } });
  try {
    return await Task.createFromOptions(fileset, withDelegate("GPU"));
  } catch (err) {
    usedDelegate = "CPU";
    console.warn("GPU delegate failed, falling back to CPU", err);
    toast("GPU unavailable, running on the CPU. Expect a lower frame rate.", "warn");
    return await Task.createFromOptions(fileset, withDelegate("CPU"));
  }
}

function faceOptions() {
  return {
    baseOptions: { modelAssetPath: FACE_MODEL },
    runningMode: "VIDEO",
    numFaces: S.faces,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  };
}

async function ensureModels() {
  if (!lib) lib = await import(`${VISION_URL}/vision_bundle.mjs`);
  if (!fileset) fileset = await lib.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
  if (!faceTask || loadedFaces !== S.faces) {
    if (faceTask) faceTask.close();
    faceTask = await makeTask(lib.FaceLandmarker, faceOptions());
    loadedFaces = S.faces;
  }
  if (!poseTask && !poseFailed) {
    try {
      poseTask = await makeTask(lib.PoseLandmarker, {
        baseOptions: { modelAssetPath: POSE_MODEL },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    } catch (err) {
      poseFailed = true;
      console.warn("Pose model failed to load. Posture tracking is off.", err);
      toast("Posture model failed to load. Face tracking still works.", "bad");
    }
  }
  drawing = new lib.DrawingUtils(ctx);
}

async function rebuildFaceTask() {
  swapping = true;
  try { await ensureModels(); } catch (err) { console.error(err); }
  swapping = false;
}

/* ---- Camera ----------------------------------------------------------------------- */

async function openStream() {
  const base = { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } };
  const tries = [];
  if (S.camera) tries.push({ ...base, deviceId: { exact: S.camera } });
  tries.push({ ...base, facingMode: "user" });
  let lastErr;
  for (const v of tries) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
      break;
    } catch (err) {
      lastErr = err;
      if (err && err.name === "NotAllowedError") throw err;
    }
  }
  if (!stream) throw lastErr;
  const track = stream.getVideoTracks()[0];
  imageCapture = "ImageCapture" in window && track ? new ImageCapture(track) : null;
  track.addEventListener("ended", () => { if (running) stop("Camera disconnected. Press Start camera to reconnect."); });
}

async function refreshCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    ui.cameraSel.innerHTML = '<option value="">Default camera</option>';
    devs.forEach((d, i) => {
      const o = el("option");
      o.value = d.deviceId;
      o.textContent = d.label || `Camera ${i + 1}`;
      ui.cameraSel.append(o);
    });
    ui.cameraSel.value = S.camera;
    if (ui.cameraSel.value !== S.camera) ui.cameraSel.value = "";
  } catch { /* device list unavailable */ }
}

async function swapCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  try {
    await openStream();
    video.srcObject = stream;
    await video.play();
    lastVideoTime = -1;
  } catch (err) {
    stop("Couldn't switch camera: " + (err && err.message ? err.message : err));
  }
}

async function start() {
  if (running) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showMessage("Camera access needs https:// or http://localhost. Open this page from a local server.");
    return;
  }
  ui.toggleBtn.disabled = true;
  setStatus("loading", "Loading models");
  showMessage("Loading face and posture models...");
  try {
    unlockAudio();
    await ensureModels();
    showMessage("Waiting for camera permission...");
    await openStream();
    video.srcObject = stream;
    await video.play();
    W = canvas.width = video.videoWidth;
    H = canvas.height = video.videoHeight;
    ui.placeholder.classList.add("hidden");

    sess = newSession();
    trackers.length = 0;
    headEst = new A.HeadPose();
    gest = new A.Gestures();
    Object.assign(L, { present: false, emo: null, head: null, attention: 0, val: 0, aro: 0, posture: null, postureSmooth: null, poseLm: null, faceEmos: [] });
    epiEmo = null; poorSince = null; closeSince = null; lastBreakAlert = 0;
    moodTrail.length = 0;
    const now = performance.now();
    lastFrameAt = now; lastFaceAt = now; lastPoseResultAt = now; lastSample = now; lastSave = now; lastDetectAt = 0;
    lastAdminSeen = now;
    lastVideoTime = -1;
    running = true;

    ui.toggleBtn.textContent = "Stop camera";
    ui.toggleBtn.classList.add("stop");
    ui.calibBtn.disabled = !poseTask;
    await refreshCameras();
    applyTicker();
    setWake();
    if (poseTask && !baseline) toast("Press Calibrate posture while sitting up straight for slouch and lean detection.");
  } catch (err) {
    console.error(err);
    setStatus("idle", "Idle");
    const denied = err && err.name === "NotAllowedError";
    showMessage(
      denied
        ? "Camera permission was blocked. Allow camera access for this page and try again."
        : "Couldn't start: " + (err && err.message ? err.message : err)
    );
  } finally {
    ui.toggleBtn.disabled = false;
  }
}

function stop(message) {
  if (!running && !stream) return;
  running = false;
  stopTicker();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  imageCapture = null;
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  calib = null;
  ui.calib.hidden = true;
  releaseWake();
  endSession();
  if (faceScan) { faceScan = null; }
  ui.toggleBtn.textContent = "Start camera";
  ui.toggleBtn.classList.remove("stop");
  ui.calibBtn.disabled = true;
  ui.faceCount.textContent = "0 faces";
  ui.fps.textContent = "0 fps";
  L.present = false; L.emo = null; L.posture = null; L.postureSmooth = null; L.poseLm = null;
  updateUI(performance.now());
  onSecond();
  showMessage(message || "Camera is off. Press Start camera to begin.");
  setStatus("idle", "Idle");
  document.title = "Tell: face and posture tracker";
}

/* ---- Frame loop: a Worker timer keeps ticking in hidden tabs -------------------------------
   Main-thread timers and requestAnimationFrame are throttled hard when a tab is hidden.
   Messages from a Worker are not, so the worker is the metronome. When the tab is hidden
   frames come from ImageCapture, which doesn't depend on the page being painted.
   A frame-gap governor keeps detection from hogging the main thread (the cause of lag). */

const WORKER_SRC = "let id=null;onmessage=e=>{clearInterval(id);id=null;if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}";
let tickWorker = null, fallbackTimer = null;

function startTicker(ms) {
  if (!tickWorker) {
    try {
      tickWorker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));
      tickWorker.onmessage = onTick;
    } catch { tickWorker = null; }
  }
  if (tickWorker) tickWorker.postMessage(ms);
  else { clearInterval(fallbackTimer); fallbackTimer = setInterval(onTick, ms); }
}
function stopTicker() {
  if (tickWorker) tickWorker.postMessage(0);
  clearInterval(fallbackTimer);
}
function applyTicker() {
  if (!running) { stopTicker(); return; }
  if (document.hidden && !S.bg) {
    stopTicker();
    setStatus("paused", "Paused (tab hidden)");
    return;
  }
  startTicker(document.hidden ? 100 : 25);
  setStatus("live", document.hidden ? "Tracking in background" : "Tracking");
}

/* Minimum time between detections. Auto aims to keep detection under half the main thread. */
function frameGap() {
  const gap = S.perf === "auto" ? clamp(avgFace * 2.2, 33, 120) : 1000 / Number(S.perf);
  return document.hidden ? Math.max(gap, 100) : gap;
}

async function onTick() {
  if (!running || busy || swapping || !faceTask) return;
  if (performance.now() - lastDetectAt < frameGap() - 3) return;
  busy = true;
  try { await processFrame(); } catch (err) { console.error(err); } finally { busy = false; }
}

async function grabHiddenFrame() {
  if (!document.hidden || !imageCapture) return null;
  try {
    const bmp = await imageCapture.grabFrame();
    if (frameCanvas.width !== bmp.width || frameCanvas.height !== bmp.height) {
      frameCanvas.width = bmp.width;
      frameCanvas.height = bmp.height;
    }
    fctx.drawImage(bmp, 0, 0);
    bmp.close();
    return frameCanvas;
  } catch { return null; }
}

async function processFrame() {
  const now = performance.now();
  let src = await grabHiddenFrame();
  if (!src) {
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    src = video;
  }
  const w = src === video ? video.videoWidth : frameCanvas.width;
  const h = src === video ? video.videoHeight : frameCanvas.height;
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  W = w; H = h;
  lastDetectAt = now;

  const ts = Math.max(lastTs + 1, performance.now());
  lastTs = ts;
  const t0 = performance.now();
  const faceRes = faceTask.detectForVideo(src, ts);
  avgFace = avgFace * 0.9 + (performance.now() - t0) * 0.1;

  let poseRes = null;
  const poseGap = Math.max(document.hidden ? 300 : 200, avgPose * 5);
  if (poseTask && now - lastPoseAt >= poseGap) {
    const t1 = performance.now();
    poseRes = poseTask.detectForVideo(src, ts);
    avgPose = avgPose * 0.8 + (performance.now() - t1) * 0.2;
    lastPoseAt = now;
  }

  const dt = clamp((now - lastFrameAt) / 1000, 0.001, 0.5);
  lastFrameAt = now;
  analyze(faceRes, poseRes, dt, now, w, h);
  calibStep(now);

  if (!document.hidden) draw(faceRes, w, h);

  frames++;
  if (now - fpsStart >= 1000) {
    if (!document.hidden) ui.fps.textContent = `${Math.round((frames * 1000) / (now - fpsStart))} fps · ${usedDelegate} · ${Math.round(avgFace)} ms`;
    frames = 0;
    fpsStart = now;
  }
  if (now - lastUi >= (document.hidden ? 500 : 120)) { lastUi = now; updateUI(now); }
  if (now - lastSample >= 1000) { lastSample = now; takeSample(); onSecond(); }
}

/* ---- Analysis: turns raw landmarks into readings ---------------------------------------------- */

const avg2 = (b, k) => ((b[k + "Left"] || 0) + (b[k + "Right"] || 0)) / 2;

function analyze(fr, poseRes, dt, now, w, h) {
  const faces = fr.faceLandmarks || [];
  L.faces = faces.length;
  const tsec = now / 1000;

  L.faceEmos = faces.map((pts, i) => {
    const cats = fr.faceBlendshapes && fr.faceBlendshapes[i] && fr.faceBlendshapes[i].categories;
    const b = A.blendMap(cats);
    const tr = trackers[i] || (trackers[i] = new A.EmotionTracker());
    const extra = i === 0 ? { eyelid: gest.lid, yawn: gest.yawnRecent(tsec) } : {};
    return { b, res: tr.update(A.rawEmotions(b, extra), dt) };
  });

  if (faces.length) {
    lastFaceAt = now;
    L.present = true;
    const { b, res } = L.faceEmos[0];
    const mat = fr.facialTransformationMatrixes && fr.facialTransformationMatrixes[0];
    const head = headEst.update(faces[0], mat && mat.data, w, h);
    const bh = baseline && baseline.head;
    L.b = b;
    L.emo = res;
    L.head = head;
    L.gaze = A.computeGaze(b);
    L.rel = {
      yaw: bh ? head.sy * (head.yawRaw - bh.yawRaw) : head.yaw,
      pitch: bh ? head.sp * (head.pitchRaw - bh.pitchRaw) : head.pitch,
      roll: head.roll - (bh ? bh.roll : 0),
    };
    L.attention = ema(L.attention, A.attentionInstant(L.rel, L.gaze, gest.lid), dt, 4);
    L.val = ema(L.val, res.valence, dt, 0.6);
    L.aro = ema(L.aro, res.arousal, dt, 0.6);

    const events = gest.update(tsec, dt, {
      blink: avg2(b, "eyeBlink"), jaw: b.jawOpen || 0, smile: avg2(b, "mouthSmile"),
      wide: avg2(b, "eyeWide"), squint: avg2(b, "eyeSquint"), yaw: L.rel.yaw, pitch: L.rel.pitch,
    });
    events.forEach((ev) => {
      if (ev === "nod") flashGesture("Nod");
      else if (ev === "shake") flashGesture("Head shake");
      else if (ev === "yawn") flashGesture("Yawn");
      else if (ev === "longclose") flashGesture("Long blink");
    });

    sess.present += dt;
    sess.awayRun = 0;
    sess.sitting += dt;
    sess.emoTime[res.dominant] += dt;
    sess.attSum += L.attention * dt;
    sess.attN += dt;
    if (res.dominant !== epiEmo) {
      if (epiEmo && epiEmo !== "neutral" && now - epiStart > 600) sess.episodes[epiEmo]++;
      epiEmo = res.dominant;
      epiStart = now;
    }
    adminHook(faces[0], w, h, now);
  } else if (now - lastFaceAt > 1200) {
    L.present = false;
    sess.away += dt;
    sess.awayRun += dt;
    if (sess.awayRun > 45) { sess.sitting = 0; lastBreakAlert = 0; }
  }

  if (poseRes) {
    const poseDt = clamp((now - lastPoseResultAt) / 1000, 0.01, 1);
    lastPoseResultAt = now;
    L.postureAt = now;
    const lm = poseRes.landmarks && poseRes.landmarks[0];
    L.poseLm = lm || null;
    if (lm) {
      const m = A.postureMetrics(lm, w, h, L.present && L.head ? L.head.faceW : null);
      if (m.ok) {
        const sc = A.postureScore(m, baseline);
        L.posture = { ok: true, m, ...sc };
        L.postureSmooth = L.postureSmooth == null ? sc.score : ema(L.postureSmooth, sc.score, poseDt, 0.8);
        sess.postureTime[sc.level] += poseDt;
        sess.postureSum += L.postureSmooth * poseDt;
        sess.postureN += poseDt;
        calibCollect(m);
      } else {
        L.posture = { ok: false };
        L.postureSmooth = null;
      }
    } else {
      L.posture = null;
      L.postureSmooth = null;
    }
  }
  if (L.postureAt && now - L.postureAt > 2500) { L.posture = null; L.postureSmooth = null; L.poseLm = null; }
}

let flashTimer = null;
function flashGesture(text) {
  ui.gestureFlash.textContent = text;
  retrigger(ui.gestureFlash);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (ui.gestureFlash.textContent = ""), 1600);
}

/* ---- Posture calibration ---------------------------------------------------------------------------- */

function startCalibration() {
  if (!running || !poseTask) return;
  calib = { t0: performance.now(), samples: [] };
  ui.calib.hidden = false;
}
function calibStep(now) {
  if (!calib) return;
  const e = (now - calib.t0) / 1000;
  if (e < 3) {
    ui.calibCount.textContent = Math.ceil(3 - e);
    ui.calibText.textContent = "Sit up straight and look at the screen";
  } else if (e < 5) {
    ui.calibCount.textContent = "•";
    ui.calibText.textContent = "Hold still";
  } else finishCalibration();
}
function calibCollect(m) {
  if (!calib || (performance.now() - calib.t0) / 1000 < 3) return;
  const h = L.present && L.head ? { yawRaw: L.head.yawRaw, pitchRaw: L.head.pitchRaw, roll: L.head.roll } : null;
  calib.samples.push({ m, h });
}
function finishCalibration() {
  const samples = calib.samples;
  calib = null;
  ui.calib.hidden = true;
  if (samples.length < 6) {
    toast("Calibration failed. Make sure your head and shoulders are in frame.", "bad");
    return;
  }
  const base = A.averageMetrics(samples.map((s) => s.m));
  const hs = samples.filter((s) => s.h);
  if (hs.length) {
    const mean = (k) => hs.reduce((t, s) => t + s.h[k], 0) / hs.length;
    base.head = { yawRaw: mean("yawRaw"), pitchRaw: mean("pitchRaw"), roll: mean("roll") };
  }
  base.at = Date.now();
  baseline = base;
  if (vaultOpen) {
    Vault.put("baseline", "main", baseline).catch((e) => console.warn("baseline save failed", e));
    toast("Posture baseline saved to your vault.", "good");
  } else {
    toast("Baseline set for this session. Unlock the vault to keep it.", "good");
  }
}

/* ---- Overlay drawing (batched paths, no glow: both are big lag savers) ------------------------------------- */

function strokeConnections(pts, sets, color, width, w, h) {
  ctx.beginPath();
  for (const set of sets) {
    for (const c of set) {
      const a = pts[c.start], b = pts[c.end];
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
}

function draw(fr, w, h) {
  ctx.clearRect(0, 0, w, h);
  const faces = fr.faceLandmarks || [];
  const FL = lib.FaceLandmarker;
  ctx.save();
  if (S.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  faces.forEach((pts, i) => {
    const fe = L.faceEmos[i];
    const col = EMO[fe ? fe.res.dominant : "neutral"].color;
    if (S.mesh) strokeConnections(pts, [FL.FACE_LANDMARKS_TESSELATION], rgba(col, 0.25), 1, w, h);
    if (S.outline) {
      strokeConnections(pts, [
        FL.FACE_LANDMARKS_FACE_OVAL, FL.FACE_LANDMARKS_LEFT_EYE, FL.FACE_LANDMARKS_RIGHT_EYE,
        FL.FACE_LANDMARKS_LEFT_EYEBROW, FL.FACE_LANDMARKS_RIGHT_EYEBROW, FL.FACE_LANDMARKS_LIPS,
        FL.FACE_LANDMARKS_LEFT_IRIS, FL.FACE_LANDMARKS_RIGHT_IRIS,
      ], col, 2.5, w, h);
    }
  });
  if (S.skeleton && L.poseLm) drawSkeleton(w, h);
  ctx.restore();
  if (S.box) faces.forEach((pts, i) => drawBox(pts, i, w, h));
}

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [7, 11], [8, 12], [0, 7], [0, 8]];
function drawSkeleton(w, h) {
  const lm = L.poseLm;
  const col = levelColor(L.postureSmooth);
  const ok = (i) => lm[i] && (lm[i].visibility === undefined || lm[i].visibility > 0.35);
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  BONES.forEach(([a, b]) => {
    if (!ok(a) || !ok(b)) return;
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
  });
  ctx.stroke();
  ctx.beginPath();
  [11, 12, 7, 8, 13, 14].forEach((i) => {
    if (!ok(i)) return;
    ctx.moveTo(lm[i].x * w + 7, lm[i].y * h);
    ctx.arc(lm[i].x * w, lm[i].y * h, 7, 0, Math.PI * 2);
  });
  ctx.fill();
  ctx.restore();
}

function drawBox(pts, i, w, h) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (S.mirror) { const t = minX; minX = 1 - maxX; maxX = 1 - t; }
  const pad = 0.02;
  const x = (minX - pad) * w, y = (minY - pad) * h;
  const bw = (maxX - minX + pad * 2) * w, bh = (maxY - minY + pad * 2) * h;
  const c = Math.min(bw, bh) * 0.18;
  const fe = L.faceEmos[i];
  const e = EMO[fe ? fe.res.dominant : "neutral"];

  ctx.strokeStyle = e.color;
  ctx.lineWidth = 5;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
  ctx.moveTo(x + bw - c, y); ctx.lineTo(x + bw, y); ctx.lineTo(x + bw, y + c);
  ctx.moveTo(x + bw, y + bh - c); ctx.lineTo(x + bw, y + bh); ctx.lineTo(x + bw - c, y + bh);
  ctx.moveTo(x + c, y + bh); ctx.lineTo(x, y + bh); ctx.lineTo(x, y + bh - c);
  ctx.stroke();

  const text = `${e.emoji} ${e.label}${e.id === "neutral" ? "" : " " + Math.round(fe.res.intensity * 100) + "%"}`;
  ctx.font = '600 20px "Martian Mono", ui-monospace, monospace';
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width + 22;
  const ty = Math.max(0, y - 36);
  ctx.fillStyle = e.color;
  ctx.fillRect(x - 2, ty, tw, 32);
  ctx.fillStyle = INK;
  ctx.fillText(text, x + 9, ty + 17);
}

/* ---- UI updates -------------------------------------------------------------------------------------------- */

let lastMoodWord = "", lastMoodColor = "", lastTitleKey = "";

function setMoodColor(color) {
  if (color === lastMoodColor) return;
  lastMoodColor = color;
  document.documentElement.style.setProperty("--mood", color);
  if (pipWin) pipWin.document.documentElement.style.setProperty("--mood", color);
}

function dirText(v, thr, neg, pos, zero) {
  return Math.abs(v) < thr ? zero : `${Math.round(Math.abs(v))}° ${v > 0 ? pos : neg}`;
}

function updateUI(now) {
  const present = L.present && L.emo;
  const e = present ? EMO[L.emo.dominant] : null;
  setMoodColor(e ? e.color : EMO.neutral.color);
  const slow = now - lastSmall > 250;

  /* Emotion cell */
  const word = e ? e.label : running ? "No face" : "Idle";
  if (word !== lastMoodWord) {
    lastMoodWord = word;
    ui.moodWord.textContent = word;
    ui.moodEmoji.textContent = e ? e.emoji : "👀";
    retrigger(ui.moodWord);
  }
  ui.moodInt.textContent = present ? Math.round(L.emo.intensity * 100) : "--";
  ui.moodNote.textContent = present
    ? L.faces > 1 ? `${L.faces} faces in view, reading the first` : "Reading 1 face"
    : running ? "Move into frame" : "Start the camera";
  ui.faceCount.textContent = `${L.faces} ${L.faces === 1 ? "face" : "faces"}`;
  emoRows.forEach((r, i) => {
    const p = present ? L.emo.probs[i] : 0;
    r.fill.style.width = `${Math.round(p * 100)}%`;
    r.pct.textContent = `${Math.round(p * 100)}%`;
    r.li.classList.toggle("on", !!present && L.emo.dominant === EMOTIONS[i].id);
  });
  if (present) {
    moodTrail.push({ v: L.val, a: L.aro, c: e.color });
    if (moodTrail.length > 70) moodTrail.shift();
  }
  if (!document.hidden && slow) drawMoodMap();

  /* Head and gaze */
  if (present && L.head) {
    const r = L.rel;
    hm.yaw.set(r.yaw / 60, dirText(r.yaw, 4, "left", "right", "center"));
    hm.pitch.set(r.pitch / 40, dirText(r.pitch, 4, "up", "down", "level"));
    hm.roll.set(r.roll / 45, dirText(r.roll, 3, "left", "right", "level"));
    ui.gazeDot.style.left = `${50 + clamp(L.gaze.x / 0.6, -1, 1) * 42}%`;
    ui.gazeDot.style.top = `${50 + clamp(L.gaze.y / 0.6, -1, 1) * 42}%`;
    hr.focus.set(`${Math.round(L.attention * 100)}%`, L.attention > 0.7 ? "good" : L.attention > 0.4 ? "warn" : "bad");
    const d = L.head.dist;
    hr.dist.set(d ? `~${Math.round(d)} cm` : "--", d && d < 32 ? "bad" : "");
    const g = L.gaze;
    hr.gaze.set(Math.abs(g.x) < 0.15 && Math.abs(g.y) < 0.15 ? "at screen" : `${Math.abs(g.y) > Math.abs(g.x) ? (g.y > 0 ? "down" : "up") : g.x > 0 ? "right" : "left"}`);
  } else {
    hm.yaw.set(0, "--"); hm.pitch.set(0, "--"); hm.roll.set(0, "--");
    ui.gazeDot.style.left = "50%"; ui.gazeDot.style.top = "50%";
    hr.focus.set("--"); hr.dist.set("--"); hr.gaze.set("--");
  }

  /* Eyes and expression */
  const br = gest.blinkRate(now / 1000);
  es.blinks.set(gest.blinks);
  es.rate.set(br == null ? "--" : Math.round(br));
  es.drowsy.set(`${Math.round(gest.perclos * 100)}%`);
  es.yawns.set(gest.yawns);
  es.nods.set(gest.nods);
  es.shakes.set(gest.shakes);
  const b = present ? L.b : {};
  const pct = (v) => `${Math.round(v * 100)}%`;
  const smile = avg2(b, "mouthSmile"), up = Math.max(b.browInnerUp || 0, avg2(b, "browOuterUp"));
  const down = avg2(b, "browDown"), wide = avg2(b, "eyeWide"), jaw = b.jawOpen || 0, puck = b.mouthPucker || 0;
  au.smile.set(smile, pct(smile));
  au.browUp.set(up, pct(up));
  au.browDown.set(down, pct(down));
  au.wide.set(wide, pct(wide));
  au.jaw.set(jaw, pct(jaw));
  au.pucker.set(puck, pct(puck));

  updatePostureUI(slow);
  if (slow) lastSmall = now;

  /* HUD and tab chrome */
  const ps = L.postureSmooth == null ? null : Math.round(L.postureSmooth);
  ui.hudEmoji.textContent = e ? e.emoji : "👀";
  ui.hudWord.textContent = word;
  ui.hudSub.textContent = present ? `${Math.round(L.emo.intensity * 100)}% intensity` : running ? "no face in view" : "camera off";
  ui.hudPosture.textContent = ps == null ? "--" : ps;
  ui.hudFocus.textContent = present ? `${Math.round(L.attention * 100)}%` : "--";
  ui.hudBlink.textContent = br == null ? "--" : Math.round(br);
  ui.hudSit.textContent = `${Math.floor(sess.sitting / 60)}m`;
  ui.sessionClock.textContent = running ? fmtClock((Date.now() - sess.start) / 1000) : "00:00:00";

  const key = `${e ? e.id : "none"}|${ps}`;
  if (running && key !== lastTitleKey) {
    lastTitleKey = key;
    document.title = e ? `${e.emoji} ${e.label}${ps != null ? ` | posture ${ps}` : ""} | Tell` : "Tell: waiting for a face";
    ui.favicon.href = "data:image/svg+xml," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='${e ? e.color : "#d9d8d0"}'/><text x='50' y='76' font-size='70' text-anchor='middle'>${e ? e.emoji : "👀"}</text></svg>`
    );
  }
}

function updatePostureUI(redraw) {
  const P = L.posture;
  const wrap = ui.scoreWrap;
  if (!running) {
    ui.postureScore.textContent = "--";
    wrap.dataset.level = "";
    ui.postureState.textContent = baseline ? "Baseline set" : "Not calibrated";
    ui.postureIssue.textContent = "Start the camera and sit so your shoulders are in frame.";
  } else if (!poseTask) {
    ui.postureScore.textContent = "--";
    wrap.dataset.level = "";
    ui.postureState.textContent = "Unavailable";
    ui.postureIssue.textContent = "The posture model didn't load. Check your connection and restart the camera.";
  } else if (!P) {
    ui.postureScore.textContent = "--";
    wrap.dataset.level = "";
    ui.postureState.textContent = "No body found";
    ui.postureIssue.textContent = "Sit back so your head and shoulders are both in frame.";
  } else if (!P.ok) {
    ui.postureScore.textContent = "--";
    wrap.dataset.level = "";
    ui.postureState.textContent = "Shoulders hidden";
    ui.postureIssue.textContent = "Your shoulders aren't visible. Sit back or tilt the screen down a little.";
  } else {
    const sc = Math.round(L.postureSmooth);
    ui.postureScore.textContent = sc;
    wrap.dataset.level = sc >= 80 ? "good" : sc >= 60 ? "okay" : "poor";
    ui.postureState.textContent = (sc >= 80 ? "Strong" : sc >= 60 ? "Okay" : "Poor") + (baseline ? "" : ", not calibrated");
    ui.postureIssue.textContent = P.issue || (baseline ? "Looking good. Keep it up." : "Looking good. Calibrate for slouch and lean detection.");
    const m = P.m, d = P.detail;
    pr.tilt.set(Math.abs(m.shoulderTilt) < 1.5 ? "level" : `${Math.abs(m.shoulderTilt).toFixed(1)}° ${m.shoulderTilt > 0 ? "left" : "right"} lower`, Math.abs(m.shoulderTilt) > 6 ? "bad" : Math.abs(m.shoulderTilt) > 3 ? "warn" : "good");
    pr.head.set(Math.abs(m.headTilt) < 2 ? "level" : `${Math.abs(m.headTilt).toFixed(1)}° to the ${m.headTilt > 0 ? "left" : "right"}`, Math.abs(m.headTilt) > 12 ? "bad" : Math.abs(m.headTilt) > 6 ? "warn" : "good");
    if (d.neckDrop != null) {
      const sl = Math.round(d.neckDrop * 100);
      pr.slouch.set(sl <= 3 ? "none" : `${sl}% lower`, sl > 18 ? "bad" : sl > 8 ? "warn" : "good");
      const fw = d.forward == null ? null : Math.round(d.forward * 100);
      pr.forward.set(fw == null ? "--" : fw <= 3 ? "none" : `${fw}% closer`, fw == null ? "" : fw > 22 ? "bad" : fw > 10 ? "warn" : "good");
      const ln = Math.round(d.lean * 100);
      pr.lean.set(ln <= 4 ? "none" : `${ln}% closer`, ln > 25 ? "bad" : ln > 12 ? "warn" : "good");
      const sh = Math.round((m.offset - baseline.offset) * 100);
      pr.shift.set(Math.abs(sh) < 4 ? "centered" : `${Math.abs(sh)}% ${sh > 0 ? "left" : "right"}`, Math.abs(sh) > 20 ? "bad" : Math.abs(sh) > 10 ? "warn" : "good");
    } else {
      pr.slouch.set("calibrate"); pr.forward.set("calibrate"); pr.lean.set("calibrate");
      const sh = Math.round(m.offset * 100);
      pr.shift.set(Math.abs(sh) < 4 ? "centered" : `${Math.abs(sh)}% ${sh > 0 ? "left" : "right"}`);
    }
  }
  if (redraw && !document.hidden) drawPosturePreview();
}

/* ---- Once-a-second work: samples, charts, alerts ---------------------------------------------------------------------- */

function takeSample() {
  const e = L.present && L.emo ? L.emo : null;
  sess.samples.push({
    t: Math.round((Date.now() - sess.start) / 1000),
    emo: e ? e.dominant : null,
    int: e ? +e.intensity.toFixed(3) : null,
    val: e ? +L.val.toFixed(3) : null,
    aro: e ? +L.aro.toFixed(3) : null,
    post: L.postureSmooth != null ? Math.round(L.postureSmooth) : null,
    att: e ? Math.round(L.attention * 100) : null,
    yaw: e ? +L.rel.yaw.toFixed(1) : null,
    pitch: e ? +L.rel.pitch.toFixed(1) : null,
    roll: e ? +L.rel.roll.toFixed(1) : null,
    gx: e ? +L.gaze.x.toFixed(2) : null,
    gy: e ? +L.gaze.y.toFixed(2) : null,
    dist: e && L.head && L.head.dist ? Math.round(L.head.dist) : null,
    smile: e ? +avg2(L.b, "mouthSmile").toFixed(2) : null,
    jaw: e ? +(L.b.jawOpen || 0).toFixed(2) : null,
    p: e ? e.probs.map((v) => Math.round(v * 1000) / 1000) : null,
  });
  if (sess.samples.length > 20000) sess.samples.shift();
}

function onSecond() {
  const now = performance.now();
  const total = sess.present + sess.away;
  ss.dur.set(running ? fmtClock((Date.now() - sess.start) / 1000) : "00:00:00");
  ss.face.set(total > 1 ? `${Math.round((sess.present / total) * 100)}%` : "--");
  ss.post.set(sess.postureN > 1 ? Math.round(sess.postureSum / sess.postureN) : "--");
  ss.focus.set(sess.attN > 1 ? `${Math.round((sess.attSum / sess.attN) * 100)}%` : "--");
  ss.sit.set(fmtShort(sess.sitting));
  ss.smiles.set(gest.smiles);

  const pt = sess.postureTime, ptTotal = pt.good + pt.okay + pt.poor || 1;
  ui.postureSplit.children[0].style.flexGrow = pt.good / ptTotal;
  ui.postureSplit.children[1].style.flexGrow = pt.okay / ptTotal;
  ui.postureSplit.children[2].style.flexGrow = pt.poor / ptTotal;

  const rows = EMOTIONS.filter((e) => sess.emoTime[e.id] > 0.5).sort((a, b) => sess.emoTime[b.id] - sess.emoTime[a.id]).slice(0, 6);
  const max = rows.length ? sess.emoTime[rows[0].id] : 1;
  ui.emoTime.innerHTML = rows.length
    ? rows.map((e) => `<div class="et"><span>${e.emoji} ${e.label}</span><span class="et-bar"><i style="width:${(sess.emoTime[e.id] / max) * 100}%;background:${e.color}"></i></span><b>${fmtShort(sess.emoTime[e.id])}${sess.episodes[e.id] ? ` · ${sess.episodes[e.id]}x` : ""}</b></div>`).join("")
    : '<p class="empty">Time spent in each emotion shows up here.</p>';

  if (!document.hidden) { drawStream(); drawLines(); }
  checkAlerts(now);
  if (running && vaultOpen && now - lastSave > 90000) { lastSave = now; persistSession(false); }
}

/* ---- Charts ---------------------------------------------------------------------------------------------------------------- */

function fit(c) {
  const r = c.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}

const MONO = '11px "Martian Mono", ui-monospace, monospace';

function chartFrame(g, w, h, labels) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#0a0a0a";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(239,238,232,0.14)";
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = Math.round((h / 4) * i) + 0.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  for (let i = 1; i < 3; i++) {
    const x = Math.round((w / 3) * i) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  g.font = MONO;
  g.fillStyle = "rgba(239,238,232,0.55)";
  g.textBaseline = "bottom";
  g.textAlign = "left";
  g.fillText(labels[0], 8, h - 6);
  g.textAlign = "right";
  g.fillText(labels[1], w - 8, h - 6);
  g.textAlign = "left";
}
function emptyChart(g, w, h, text) {
  g.font = MONO;
  g.fillStyle = "rgba(239,238,232,0.5)";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2);
  g.textAlign = "left";
}

const WINDOW = 180;

function drawStream() {
  const c = fit(ui.streamCanvas);
  if (!c) return;
  const { g, w, h } = c;
  const data = sess.samples.slice(-WINDOW);
  chartFrame(g, w, h, ["3 min ago", "now"]);
  if (data.length < 2) { emptyChart(g, w, h, "Emotion mix appears once a face is tracked"); return; }
  const step = w / (WINDOW - 1);
  const xAt = (i) => w - (data.length - 1 - i) * step;
  const cum = new Array(data.length).fill(0);
  EMOTIONS.forEach((e, j) => {
    const tops = data.map((s, i) => cum[i] + (s.p ? s.p[j] : 0));
    g.beginPath();
    data.forEach((s, i) => { const x = xAt(i), y = h - tops[i] * h; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    for (let i = data.length - 1; i >= 0; i--) g.lineTo(xAt(i), h - cum[i] * h);
    g.closePath();
    g.fillStyle = e.color;
    g.fill();
    g.beginPath();
    data.forEach((s, i) => { const x = xAt(i), y = h - tops[i] * h; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.stroke();
    for (let i = 0; i < data.length; i++) cum[i] = tops[i];
  });
}

function drawLines() {
  const c = fit(ui.lineCanvas);
  if (!c) return;
  const { g, w, h } = c;
  const data = sess.samples.slice(-WINDOW);
  chartFrame(g, w, h, ["3 min ago", "now"]);
  if (data.length < 2) { emptyChart(g, w, h, "Posture, focus and mood appear once tracking starts"); return; }
  const step = w / (WINDOW - 1);
  const xAt = (i) => w - (data.length - 1 - i) * step;
  const series = [
    { get: (s) => s.post, color: GOOD, width: 3 },
    { get: (s) => s.att, color: "#3bd5ff", width: 2 },
    { get: (s) => (s.val == null ? null : (s.val + 1) * 50), color: "#ffd43b", width: 2, dash: [5, 4] },
  ];
  series.forEach((ser) => {
    g.beginPath();
    g.strokeStyle = ser.color;
    g.lineWidth = ser.width;
    g.setLineDash(ser.dash || []);
    g.lineJoin = "round";
    let pen = false;
    data.forEach((s, i) => {
      const v = ser.get(s);
      if (v == null) { pen = false; return; }
      const x = xAt(i), y = h - 14 - (clamp(v, 0, 100) / 100) * (h - 28);
      if (pen) g.lineTo(x, y); else g.moveTo(x, y);
      pen = true;
    });
    g.stroke();
    g.setLineDash([]);
  });
}

function drawMoodMap() {
  const c = fit(ui.mapCanvas);
  if (!c) return;
  const { g, w, h } = c;
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#0a0a0a";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(239,238,232,0.14)";
  g.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const x = Math.round((w / 8) * i) + 0.5, y = Math.round((h / 8) * i) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  g.strokeStyle = BONE;
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  g.font = MONO;
  g.fillStyle = "rgba(239,238,232,0.6)";
  g.textBaseline = "top"; g.textAlign = "left"; g.fillText("Tense", 10, 10);
  g.textAlign = "right"; g.fillText("Excited", w - 10, 10);
  g.textBaseline = "bottom"; g.textAlign = "left"; g.fillText("Low", 10, h - 10);
  g.textAlign = "right"; g.fillText("Calm", w - 10, h - 10);
  g.textAlign = "left";
  const X = (v) => ((clamp(v, -1, 1) + 1) / 2) * w, Y = (a) => (1 - (clamp(a, -1, 1) + 1) / 2) * h;
  moodTrail.forEach((p, i) => {
    g.fillStyle = rgba(p.c, 0.08 + (i / moodTrail.length) * 0.5);
    const s = 3 + (i / moodTrail.length) * 4;
    g.fillRect(X(p.v) - s / 2, Y(p.a) - s / 2, s, s);
  });
  const last = moodTrail[moodTrail.length - 1];
  if (last && L.present) {
    g.fillStyle = last.c;
    g.fillRect(X(last.v) - 11, Y(last.a) - 11, 22, 22);
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.strokeRect(X(last.v) - 11, Y(last.a) - 11, 22, 22);
  }
}

function figure(g, pts, w, h, color, dashed) {
  const X = (p) => (S.mirror ? 1 - p.x : p.x) * w, Y = (p) => p.y * h;
  const sm = { x: (pts.ls.x + pts.rs.x) / 2, y: (pts.ls.y + pts.rs.y) / 2 };
  const sw = Math.hypot((pts.ls.x - pts.rs.x) * w, (pts.ls.y - pts.rs.y) * h);
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = dashed ? 2 : 5;
  g.lineCap = "round";
  g.lineJoin = "round";
  if (dashed) g.setLineDash([6, 5]);
  g.beginPath(); g.moveTo(X(pts.ls), Y(pts.ls)); g.lineTo(X(pts.rs), Y(pts.rs)); g.stroke();
  g.beginPath(); g.moveTo(X(sm), Y(sm)); g.lineTo(X(pts.head), Y(pts.head)); g.stroke();
  g.beginPath(); g.arc(X(pts.head), Y(pts.head), sw * 0.26, 0, Math.PI * 2);
  if (!dashed) { g.globalAlpha = 0.22; g.fill(); g.globalAlpha = 1; }
  g.stroke();
  g.restore();
}

function drawPosturePreview() {
  const c = fit(ui.postureCanvas);
  if (!c) return;
  const { g, w, h } = c;
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#0a0a0a";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(239,238,232,0.12)";
  g.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const x = Math.round((w / 8) * i) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  for (let i = 1; i < 5; i++) {
    const y = Math.round((h / 5) * i) + 0.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  if (baseline && baseline.pts) figure(g, baseline.pts, w, h, "rgba(239,238,232,0.65)", true);
  if (L.posture && L.posture.ok) figure(g, L.posture.m.pts, w, h, levelColor(L.postureSmooth), false);
  g.font = MONO;
  g.fillStyle = "rgba(239,238,232,0.55)";
  g.textBaseline = "bottom";
  g.fillText(baseline ? "dashed = your baseline" : "no baseline yet", 8, h - 6);
}

/* ---- Reminders ------------------------------------------------------------------------------------------------------------ */

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* audio unavailable */ }
}
function chime() {
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
      o.type = "square";
      o.frequency.value = f;
      gn.gain.setValueAtTime(0.0001, t + i * 0.13);
      gn.gain.exponentialRampToValueAtTime(0.07, t + i * 0.13 + 0.01);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.13 + 0.11);
      o.connect(gn).connect(audioCtx.destination);
      o.start(t + i * 0.13);
      o.stop(t + i * 0.13 + 0.12);
    });
  } catch { /* audio unavailable */ }
}

let hudAlertTimer = null;
function raise(key, title, body, cooldownMs) {
  const t = Date.now();
  if (t - (alertLast[key] || 0) < cooldownMs) return;
  alertLast[key] = t;
  toast(`${title}. ${body}`, "warn");
  ui.hudAlert.textContent = `${title}. ${body}`;
  ui.hudAlert.hidden = false;
  clearTimeout(hudAlertTimer);
  hudAlertTimer = setTimeout(() => (ui.hudAlert.hidden = true), 10000);
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body, tag: "tell-alert", silent: true }); } catch { /* blocked */ }
  }
  chime();
}

function checkAlerts(now) {
  if (!S.alerts || !running || !L.present) { poorSince = null; closeSince = null; return; }
  const ps = L.postureSmooth;
  if (ps != null && ps < 55) {
    if (poorSince == null) poorSince = now;
    if (now - poorSince > 25000) raise("posture", "Posture check", (L.posture && L.posture.issue) || "Sit up and reset your shoulders.", 180000);
  } else poorSince = null;

  if (L.head && L.head.dist && L.head.dist < 32) {
    if (closeSince == null) closeSince = now;
    if (now - closeSince > 20000) raise("close", "Too close to the screen", "Move back to arm's length.", 300000);
  } else closeSince = null;

  const every = S.breakMin * 60;
  if (sess.sitting >= every && sess.sitting - lastBreakAlert >= every) {
    lastBreakAlert = sess.sitting;
    raise("sit", "Time for a break", `You've been sitting for ${Math.round(sess.sitting / 60)} minutes. Stand up and stretch.`, 60000);
  }
  if (gest.perclos > 0.2 && sess.present > 120) raise("tired", "Tired eyes", "Your eyes keep closing. Rest them for a minute.", 900000);
  const br = gest.blinkRate(now / 1000);
  if (br != null && br < 8 && L.attention > 0.7) raise("blink", "Blink more", "Your blink rate is low. Look 20 feet away for 20 seconds.", 600000);
}

/* ---- Background helpers: screen wake lock and floating HUD ------------------------------------------------------------------ */

async function setWake() {
  if (!S.wake || !running) { releaseWake(); return; }
  if (!("wakeLock" in navigator) || wakeLock || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => (wakeLock = null));
  } catch { wakeLock = null; }
}
function releaseWake() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

async function togglePip() {
  if (pipWin) { pipWin.close(); return; }
  if (!("documentPictureInPicture" in window)) {
    toast("The floating HUD needs Chrome or Edge 116 or newer.", "bad");
    return;
  }
  try {
    pipWin = await window.documentPictureInPicture.requestWindow({ width: 360, height: 300 });
  } catch (err) {
    toast("Couldn't open the HUD: " + (err && err.message ? err.message : err), "bad");
    return;
  }
  document.head.querySelectorAll('link[rel="stylesheet"], style').forEach((n) => {
    const copy = n.cloneNode(true);
    if (n.href) copy.href = n.href;
    pipWin.document.head.appendChild(copy);
  });
  pipWin.document.body.className = "pip";
  pipWin.document.body.append(ui.hud);
  pipWin.document.documentElement.style.setProperty("--mood", lastMoodColor || EMO.neutral.color);
  ui.hudPh.hidden = false;
  ui.pipBtn.textContent = "Close HUD";
  pipWin.addEventListener("pagehide", () => {
    ui.hudHome.prepend(ui.hud);
    ui.hudPh.hidden = true;
    ui.pipBtn.textContent = "Pop out HUD";
    pipWin = null;
  });
}

/* ---- Sessions ------------------------------------------------------------------------------------------------------------------ */

function summaryOf(s) {
  const dur = (Date.now() - s.start) / 1000;
  const total = s.present + s.away;
  const top = EMOTIONS.filter((e) => e.id !== "neutral").sort((a, b) => s.emoTime[b.id] - s.emoTime[a.id])[0];
  return {
    id: s.id, at: s.start, dur,
    face: total > 0 ? s.present / total : 0,
    dom: top && s.emoTime[top.id] > 1 ? top.id : "neutral",
    post: s.postureN > 1 ? s.postureSum / s.postureN : null,
    att: s.attN > 1 ? s.attSum / s.attN : null,
    blinks: gest.blinks, smiles: gest.smiles,
  };
}

function endSession() {
  const sm = summaryOf(sess);
  if (sm.dur < 15 || sess.present < 5) return;
  if (vaultOpen) persistSession(true, sess, sm);
  else toast("This session wasn't saved. Unlock the vault to keep sessions.");
}

/* Sessions are written to the encrypted vault only, never to plain storage. */
async function persistSession(final, s = sess, sm = summaryOf(s)) {
  if (!vaultOpen) return;
  if (saving) { if (final) setTimeout(() => persistSession(true, s, sm), 1500); return; }
  if (sm.dur < 15 || s.present < 5) return;
  saving = true;
  try {
    await Vault.put("session", sm.id, { samples: s.samples });
    await Vault.put("summary", sm.id, sm);
    if (final) await refreshHistory();
  } catch (err) {
    console.warn("vault save failed", err);
  } finally {
    saving = false;
  }
}

async function refreshHistory() {
  if (!vaultOpen) { history = []; renderHistory(); return; }
  try {
    history = (await Vault.list("summary")).map((r) => r.data).sort((a, b) => b.at - a.at).slice(0, 50);
  } catch { history = []; }
  renderHistory();
}

function renderHistory() {
  ui.histCap.textContent = vaultOpen ? `${history.length} saved` : "";
  if (!vaultOpen) {
    ui.historyList.innerHTML = `<p class="empty">${vaultUnavailable ? "Encrypted storage isn't available in this browser." : "Locked. Unlock the admin vault to see and save sessions."}</p>`;
    return;
  }
  if (!history.length) {
    ui.historyList.innerHTML = '<p class="empty">Finished sessions are saved here, encrypted.</p>';
    return;
  }
  ui.historyList.innerHTML = history.map((h) => {
    const e = EMO[h.dom] || EMO.neutral;
    const d = new Date(h.at);
    return `<div class="hist"><span class="hist-emo" style="background:${e.color}">${e.emoji}</span><div><b>${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</b><span class="hist-sub">${fmtShort(h.dur)}, mostly ${e.label.toLowerCase()}</span></div><span class="hist-nums">${h.post != null ? Math.round(h.post) : "--"}<small>posture</small></span><span class="hist-nums">${h.att != null ? Math.round(h.att * 100) : "--"}<small>focus</small></span><div class="hist-acts"><button class="link-btn" data-act="csv" data-id="${h.id}">CSV</button><button class="link-btn" data-act="del" data-id="${h.id}">Delete</button></div></div>`;
  }).join("");
}

ui.historyList.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn || !vaultOpen) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === "del") {
      await Vault.del("summary", id);
      await Vault.del("session", id);
      await refreshHistory();
    } else {
      const rec = await Vault.get("session", id);
      if (!rec) { toast("No detailed data was saved for that session."); return; }
      download(`tell-session-${id}.csv`, samplesToCsv(rec.samples), "text/csv");
    }
  } catch (err) { toast("Vault error: " + (err && err.message ? err.message : err), "bad"); }
});

function samplesToCsv(samples) {
  const cols = ["t_sec", "emotion", "intensity", "valence", "arousal", "posture", "focus", "yaw", "pitch", "roll", "gaze_x", "gaze_y", "distance_cm", "smile", "mouth_open"]
    .concat(EMOTIONS.map((e) => "p_" + e.id));
  const rows = samples.map((s) => [
    s.t, s.emo, s.int, s.val, s.aro, s.post, s.att, s.yaw, s.pitch, s.roll, s.gx, s.gy, s.dist, s.smile, s.jaw,
    ...EMOTIONS.map((e, i) => (s.p ? s.p[i] : "")),
  ].map((v) => (v == null ? "" : v)).join(","));
  return [cols.join(","), ...rows].join("\n");
}

function exportCsv() {
  if (!sess.samples.length) { toast("Nothing to export yet. Run a session first."); return; }
  download(`tell-session-${new Date(sess.start).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`, samplesToCsv(sess.samples), "text/csv");
}

/* ---- Admin vault: passcode + face, encrypted storage ---------------------------------------------------------------------------- */

function setTpl(tpl) {
  faceTpl = tpl;
  faceTplMean = tpl ? Float32Array.from(tpl.mean) : null;
}

/* Called on every processed frame while a scan is open (fast) or the vault is open (2 Hz). */
function adminHook(pts, w, h, now) {
  if (faceScan) {
    if (now - lastDescAt >= 40) { lastDescAt = now; scanStep(pts, w, h, now); }
  } else if (vaultOpen && faceTplMean && S.autolock && now - lastDescAt >= 500) {
    lastDescAt = now;
    watchBuf.push(A.faceDescriptor(pts, w, h));
    if (watchBuf.length > 6) watchBuf.shift();
    if (watchBuf.length >= 4) {
      const d = A.descDistance(A.meanDesc(watchBuf), faceTplMean);
      if (d <= faceTpl.thr * S.faceStrict * 1.3) lastAdminSeen = now;
    }
  }
}

function setScan(msg, progress, match) {
  if (!scanUi) return;
  scanUi.msg.textContent = msg;
  scanUi.bar.style.width = `${Math.round(clamp(progress) * 100)}%`;
  scanUi.match.textContent = match == null ? "" : `Match ${match}%`;
}

function scanStep(pts, w, h, now) {
  const sc = faceScan;
  const yaw = Math.abs(L.head.yaw), pitch = Math.abs(L.head.pitch);
  if (yaw > (sc.mode === "enroll" ? 35 : 25) || pitch > 30) { setScan("Face the camera", sc.mode === "enroll" ? sc.descs.length / 45 : sc.passes / 12); return; }
  const d = A.faceDescriptor(pts, w, h);

  if (sc.mode === "enroll") {
    sc.descs.push(d);
    setScan(`Learning your face. Turn your head slowly side to side. ${sc.descs.length}/45`, sc.descs.length / 45);
    if (sc.descs.length >= 45) {
      const tpl = A.buildFaceTemplate(sc.descs);
      const cb = sc.onDone;
      faceScan = null;
      cb(tpl);
    }
    return;
  }

  const blink = avg2(L.b, "eyeBlink");
  if (blink > 0.5) sc.sawClosed = true;
  else if (blink < 0.3 && sc.sawClosed) sc.blinked = true;
  sc.buf.push(d);
  if (sc.buf.length > 10) sc.buf.shift();
  if (sc.buf.length < 6) return;
  const dist = A.descDistance(A.meanDesc(sc.buf), Float32Array.from(sc.tpl.mean));
  const lim = sc.tpl.thr * S.faceStrict;
  const ok = dist <= lim;
  sc.passes = ok ? sc.passes + 1 : 0;
  const match = Math.round(clamp(1 - dist / (lim * 2)) * 100);
  setScan(ok ? (sc.blinked ? "Matched" : "Matched. Blink once to confirm you're live.") : "No match yet. Hold still, face the camera.", Math.min(1, sc.passes / 12), match);
  if (sc.passes >= 12 && sc.blinked) {
    const cb = sc.onDone;
    faceScan = null;
    cb(true);
  }
}

function openDlg(title, html, handler) {
  ui.dlgTitle.textContent = title;
  ui.dlgBody.innerHTML = html;
  formHandler = handler || null;
  scanUi = null;
  if (!ui.vaultDlg.open) ui.vaultDlg.showModal();
  const first = ui.dlgBody.querySelector("input");
  if (first) first.focus();
}
const setErr = (t) => { const e = $("dlgErr"); if (e) e.textContent = t; };
const closeDlg = () => { if (ui.vaultDlg.open) ui.vaultDlg.close(); };

ui.vaultDlg.addEventListener("close", () => {
  faceScan = null;
  formHandler = null;
  pendingPass = null;
  scanUi = null;
  if (Vault) Vault.abort();
});
ui.vaultForm.addEventListener("submit", (e) => { e.preventDefault(); if (formHandler) formHandler(); });
ui.dlgClose.addEventListener("click", closeDlg);

const passField = (id, label, auto) => `<label class="in">${label}<input id="${id}" type="password" autocomplete="${auto || "off"}"></label>`;
const submitBtn = (label) => `<div class="dlg-actions"><button class="btn primary sm" type="submit">${label}</button><button class="btn sm" type="button" onclick="document.getElementById('vaultDlg').close()">Cancel</button></div>`;

async function startScan(title, intro, mode, tpl, onDone) {
  openDlg(title, `<p>${intro}</p><div class="scan-video"><video id="dlgVideo" muted playsinline autoplay></video></div><div class="scan-msg" id="scanMsg">Starting camera...</div><div class="prog"><i id="scanBar"></i></div><div class="scan-match" id="scanMatch"></div><div class="dlg-actions"><button class="btn sm" type="button" onclick="document.getElementById('vaultDlg').close()">Cancel</button></div>`, null);
  scanUi = { msg: $("scanMsg"), bar: $("scanBar"), match: $("scanMatch") };
  if (!running) await start();
  if (!ui.vaultDlg.open) return;
  if (!running) { setScan("Couldn't start the camera. Close this and check permissions.", 0); return; }
  const v = $("dlgVideo");
  if (v && stream) { v.srcObject = stream; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  setScan("Look at the camera", 0);
  faceScan = { mode, tpl, descs: [], buf: [], passes: 0, blinked: false, sawClosed: false, t0: performance.now(), onDone };
}

function beginSetup() {
  warnedShort = false;
  openDlg("Set up admin vault",
    `<p>Choose an admin passcode. Everything in the vault is encrypted with it, and there is no recovery: forget it and the data is gone. After this, Tell learns your face as a second gate.</p>${passField("pc1", "Passcode", "new-password")}${passField("pc2", "Repeat passcode", "new-password")}<p class="dlg-err" id="dlgErr"></p>${submitBtn("Next: learn my face")}`,
    () => {
      const a = $("pc1").value, b = $("pc2").value;
      if (a.length < 4) return setErr("Use at least 4 characters.");
      if (a !== b) return setErr("The passcodes don't match.");
      if (a.length < 6 && !warnedShort) { warnedShort = true; return setErr("Short passcodes are easy to guess. Press Next again to keep it anyway."); }
      pendingPass = a;
      startScan("Learn your face", "Look at the camera and slowly turn your head a little side to side.", "enroll", null, async (tpl) => {
        try {
          await Vault.create(pendingPass, tpl);
        } catch (err) { setScan("Couldn't create the vault: " + (err && err.message ? err.message : err), 0); return; }
        setTpl(tpl);
        vaultExistsFlag = true;
        closeDlg();
        await onVaultOpened();
        toast("Vault created and unlocked.", "good");
      });
    });
}

function beginUnlock() {
  openDlg("Unlock vault",
    `<p>Enter your admin passcode, then confirm it's you on camera.</p>${passField("pc", "Passcode", "current-password")}<p class="dlg-err" id="dlgErr"></p>${submitBtn("Continue")}`,
    async () => {
      const info = Vault.lockInfo();
      if (info.wait > 0) return setErr(`Too many attempts. Try again in ${info.wait}s.`);
      const pass = $("pc").value;
      if (!pass) return;
      let tpl;
      try {
        tpl = await Vault.verifyPasscode(pass);
        if (!tpl) throw new Error("This vault has no face enrolled.");
      } catch (err) {
        if (err.message === "bad-passcode") {
          Vault.noteFail();
          const i = Vault.lockInfo();
          setErr(i.wait > 0 ? `Too many attempts. Try again in ${i.wait}s.` : "Wrong passcode.");
          $("pc").value = "";
        } else setErr("Couldn't open the vault: " + err.message);
        return;
      }
      startScan("Unlock vault", "Look at the camera, then blink once to show you're live.", "verify", tpl, async (ok) => {
        if (!ok) {
          Vault.noteFail();
          Vault.abort();
          openDlg("Not recognised", `<p>The face scan didn't match. Check the lighting and that you're facing the camera. If it keeps failing, set Face match to Relaxed in Settings.</p>${submitBtn("Try again")}`, beginUnlock);
          return;
        }
        Vault.commit();
        setTpl(tpl);
        closeDlg();
        await onVaultOpened();
        toast("Vault unlocked.", "good");
      });
    });
}

function beginReenroll() {
  startScan("Re-learn your face", "Look at the camera and slowly turn your head a little side to side.", "enroll", null, async (tpl) => {
    try { await Vault.put("face", "template", tpl); } catch (err) { setScan("Couldn't save: " + err.message, 0); return; }
    setTpl(tpl);
    closeDlg();
    toast("Face updated.", "good");
  });
}

function beginChangePass() {
  openDlg("Change passcode",
    `${passField("old", "Current passcode", "current-password")}${passField("n1", "New passcode", "new-password")}${passField("n2", "Repeat new passcode", "new-password")}<p class="dlg-err" id="dlgErr"></p>${submitBtn("Change passcode")}`,
    async () => {
      const o = $("old").value, a = $("n1").value, b = $("n2").value;
      if (a.length < 4) return setErr("Use at least 4 characters.");
      if (a !== b) return setErr("The new passcodes don't match.");
      try {
        await Vault.changePasscode(o, a);
        closeDlg();
        toast("Passcode changed. Everything was re-encrypted.", "good");
      } catch (err) { setErr(err.message === "bad-passcode" ? "Current passcode is wrong." : "Failed: " + err.message); }
    });
}

function beginWipe() {
  openDlg("Wipe vault",
    `<p>This permanently deletes every saved session, your baseline and your face. It can't be undone. Type WIPE and enter your passcode.</p><label class="in">Type WIPE<input id="wp" type="text" autocomplete="off"></label>${passField("wpc", "Passcode", "current-password")}<p class="dlg-err" id="dlgErr"></p>${submitBtn("Delete everything")}`,
    async () => {
      if ($("wp").value !== "WIPE") return setErr("Type WIPE in capitals to confirm.");
      try {
        await Vault.verifyPasscode($("wpc").value);
        Vault.abort();
      } catch (err) { return setErr(err.message === "bad-passcode" ? "Wrong passcode." : "Failed: " + err.message); }
      await Vault.wipe();
      vaultExistsFlag = false;
      lockVault(null);
      baseline = null;
      closeDlg();
      toast("Vault wiped.", "bad");
    });
}

async function backupVault() {
  try {
    download(`tell-vault-backup-${new Date().toISOString().slice(0, 10)}.json`, await Vault.exportBackup(), "application/json");
    toast("Encrypted backup saved. It needs your passcode to open.", "good");
  } catch (err) { toast("Backup failed: " + err.message, "bad"); }
}

ui.restoreFile.addEventListener("change", () => {
  const file = ui.restoreFile.files[0];
  ui.restoreFile.value = "";
  if (!file) return;
  file.text().then((text) => {
    openDlg("Restore backup",
      `<p>This replaces the vault in this browser with the backup file. The current vault is erased. You'll unlock the restored vault with the passcode and face it was made with.</p><p class="dlg-err" id="dlgErr"></p>${submitBtn("Replace vault")}`,
      async () => {
        try {
          await Vault.importBackup(text);
          vaultExistsFlag = true;
          lockVault(null);
          closeDlg();
          toast("Backup restored. Unlock to use it.", "good");
        } catch { setErr("That file isn't a Tell vault backup."); }
      });
  });
});

async function migrateLegacy() {
  const hist = store.get("tell.history", null);
  const base = store.get("tell.baseline", null);
  if (Array.isArray(hist)) {
    for (const h of hist) await Vault.put("summary", h.id, h);
    store.del("tell.history");
  }
  if (base && !(await Vault.get("baseline", "main"))) await Vault.put("baseline", "main", base);
  store.del("tell.baseline");
}

async function onVaultOpened() {
  vaultOpen = true;
  vaultExistsFlag = true;
  lastAdminSeen = performance.now();
  idleSince = 0;
  watchBuf.length = 0;
  try {
    await migrateLegacy();
    const saved = await Vault.get("baseline", "main");
    if (saved) baseline = saved;
    else if (baseline) await Vault.put("baseline", "main", baseline);
  } catch (err) { console.warn("vault load failed", err); }
  await refreshHistory();
  renderVault();
}

function lockVault(reason) {
  if (Vault) Vault.lock();
  const wasOpen = vaultOpen;
  vaultOpen = false;
  setTpl(null);
  history = [];
  baseline = null;
  watchBuf.length = 0;
  renderVault();
  renderHistory();
  if (reason && wasOpen) toast(reason, "warn");
}

function renderVault() {
  let cap, note, acts;
  if (vaultUnavailable) {
    cap = "Unavailable";
    note = "This page can't use encrypted storage here. Open it from http://localhost or https:// in a current browser.";
    acts = [];
  } else if (vaultOpen) {
    cap = "Unlocked";
    note = "Sessions and your posture baseline save to the encrypted vault. Only your passcode and face open it.";
    acts = [["Lock now", () => lockVault("Vault locked.")], ["Re-learn face", beginReenroll], ["Change passcode", beginChangePass], ["Backup", backupVault], ["Restore", () => ui.restoreFile.click()], ["Wipe", beginWipe, "danger"]];
  } else if (vaultExistsFlag) {
    cap = "Locked";
    note = "Passcode first, then a face scan with a blink. Nothing is saved or shown while locked.";
    acts = [["Unlock", beginUnlock, "primary"], ["Restore backup", () => ui.restoreFile.click()]];
  } else {
    cap = "Not set up";
    note = "Create a private encrypted database. Your passcode is the key, and your face is a second gate.";
    acts = [["Set up admin vault", beginSetup, "primary"], ["Restore backup", () => ui.restoreFile.click()]];
  }
  ui.vaultState.textContent = cap;
  ui.vaultStat.textContent = vaultOpen ? "Unlocked" : vaultExistsFlag ? "Locked" : "Not set up";
  document.body.dataset.vault = vaultOpen ? "open" : "locked";
  ui.vaultNote.textContent = note;
  ui.vaultActions.innerHTML = "";
  acts.forEach(([label, fn, cls]) => {
    const b = el("button", "btn sm" + (cls ? " " + cls : ""));
    b.textContent = label;
    b.addEventListener("click", fn);
    ui.vaultActions.append(b);
  });
}

/* Housekeeping once a second: scan timeouts, auto-lock. */
setInterval(() => {
  const now = performance.now();
  if (faceScan && now - faceScan.t0 > (faceScan.mode === "enroll" ? 60000 : 30000)) {
    const sc = faceScan;
    faceScan = null;
    if (sc.mode === "enroll") setScan("Scan timed out. Close this and try again.", 0);
    else sc.onDone(false);
  }
  if (vaultOpen && !running) {
    if (!idleSince) idleSince = now;
    else if (now - idleSince > 600000) lockVault("Vault locked after 10 minutes idle.");
  } else idleSince = 0;
  if (vaultOpen && running && S.autolock && faceTpl && now - lastAdminSeen > 120000) {
    lockVault("Vault locked: your face wasn't seen for 2 minutes.");
  }
}, 1000);

/* ---- Wiring ------------------------------------------------------------------------------------------------------------------------------ */

ui.toggleBtn.addEventListener("click", () => (running ? stop() : start()));
ui.calibBtn.addEventListener("click", startCalibration);
ui.pipBtn.addEventListener("click", togglePip);
ui.csvBtn.addEventListener("click", exportCsv);
ui.fsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (ui.stage.requestFullscreen) ui.stage.requestFullscreen();
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || ui.vaultDlg.open) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  const k = e.key.toLowerCase();
  if (k === "s") (running ? stop() : start());
  else if (k === "c") startCalibration();
  else if (k === "h") togglePip();
  else if (k === "l" && !vaultUnavailable) (vaultOpen ? lockVault("Vault locked.") : vaultExistsFlag ? beginUnlock() : beginSetup());
});

document.addEventListener("visibilitychange", () => {
  applyTicker();
  setWake();
  if (!document.hidden && running) { updateUI(performance.now()); onSecond(); }
});
window.addEventListener("resize", () => { if (!document.hidden) { drawStream(); drawLines(); drawMoodMap(); drawPosturePreview(); } });
window.addEventListener("pagehide", () => { if (stream) stream.getTracks().forEach((t) => t.stop()); });

/* ---- Boot ---------------------------------------------------------------------------------------------------------------------------------- */

store.del("tell.live");
(async function boot() {
  if (!vaultUnavailable) {
    try { vaultExistsFlag = await Vault.exists(); } catch { vaultUnavailable = true; }
  }
  renderVault();
  renderHistory();
})();
updateUI(performance.now());
onSecond();
requestAnimationFrame(() => { drawMoodMap(); drawPosturePreview(); drawStream(); drawLines(); });
