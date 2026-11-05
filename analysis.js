/* analysis.js
   The maths behind Tell: emotions, head pose, gaze, gestures, posture and the face signature.
   Nothing in here touches the DOM, so it can be unit-tested in Node. */
(function (root) {
  "use strict";

  const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
  const ema = (prev, x, dt, tau) => prev + (x - prev) * (1 - Math.exp(-dt / tau));
  const deg = (r) => (r * 180) / Math.PI;

  /* ---- Emotion catalogue --------------------------------------------------
     v = valence (unpleasant -1 .. pleasant +1), a = arousal (calm -1 .. wired +1).
     The mood map places you at the probability-weighted average of these. */
  const EMOTIONS = [
    { id: "neutral",   label: "Neutral",   emoji: "😐", color: "#d9d8d0", v: 0,    a: 0 },
    { id: "happy",     label: "Happy",     emoji: "😄", color: "#ffd43b", v: 0.8,  a: 0.5 },
    { id: "laughing",  label: "Laughing",  emoji: "😂", color: "#ff922b", v: 0.8,  a: 0.9 },
    { id: "playful",   label: "Playful",   emoji: "😜", color: "#ff5fa2", v: 0.6,  a: 0.6 },
    { id: "smirk",     label: "Smirk",     emoji: "😏", color: "#c084fc", v: 0.3,  a: 0.2 },
    { id: "surprised", label: "Surprised", emoji: "😲", color: "#3bd5ff", v: 0.2,  a: 0.9 },
    { id: "fearful",   label: "Fearful",   emoji: "😨", color: "#2dd4bf", v: -0.6, a: 0.8 },
    { id: "sad",       label: "Sad",       emoji: "😢", color: "#5b8cff", v: -0.8, a: -0.4 },
    { id: "angry",     label: "Angry",     emoji: "😠", color: "#ff4545", v: -0.7, a: 0.7 },
    { id: "disgusted", label: "Disgusted", emoji: "🤢", color: "#a3d63a", v: -0.6, a: 0.3 },
    { id: "skeptical", label: "Skeptical", emoji: "🤨", color: "#e0a96d", v: -0.2, a: 0.2 },
    { id: "focused",   label: "Focused",   emoji: "🧐", color: "#6ee7a8", v: 0.1,  a: 0.3 },
    { id: "sleepy",    label: "Sleepy",    emoji: "😴", color: "#a5a8e8", v: -0.1, a: -0.9 },
  ];
  const EMO = {};
  EMOTIONS.forEach((e, i) => { e.index = i; EMO[e.id] = e; });
  const NON_NEUTRAL = EMOTIONS.filter((e) => e.id !== "neutral");

  function blendMap(categories) {
    const m = {};
    if (categories) for (const c of categories) m[c.categoryName] = c.score;
    return m;
  }

  /* Raw (unsmoothed) score per emotion from the 52 ARKit-style blendshapes.
     ctx.eyelid = slow average eyelid closure, ctx.yawn = a yawn happened recently. */
  function rawEmotions(b, ctx = {}) {
    const g = (k) => b[k] || 0;
    const av = (k) => (g(k + "Left") + g(k + "Right")) / 2;

    const smileL = g("mouthSmileLeft"), smileR = g("mouthSmileRight");
    const smile = (smileL + smileR) / 2;
    const frown = av("mouthFrown");
    const browDown = av("browDown");
    const outerUp = av("browOuterUp");
    const inner = g("browInnerUp");
    const wide = av("eyeWide");
    const squint = av("eyeSquint");
    const sneer = av("noseSneer");
    const jaw = g("jawOpen");
    const press = av("mouthPress");
    const upperUp = av("mouthUpperUp");
    const lowerDown = av("mouthLowerDown");
    const stretch = av("mouthStretch");
    const cheekSq = av("cheekSquint");
    const shrugLower = g("mouthShrugLower");
    const tongue = g("tongueOut");
    const puff = g("cheekPuff");
    const dimpAsym = Math.abs(g("mouthDimpleLeft") - g("mouthDimpleRight"));
    const browAsym = Math.max(
      Math.abs(g("browOuterUpLeft") - g("browOuterUpRight")),
      Math.abs(g("browDownLeft") - g("browDownRight"))
    );
    const wink = clamp((Math.abs(g("eyeBlinkLeft") - g("eyeBlinkRight")) - 0.35) * 2.5);

    const s = {};
    s.happy = clamp(smile * 1.35 + cheekSq * 0.35 - frown * 0.4 - jaw * 0.6);
    s.laughing = clamp(Math.min(smile * 1.3, jaw * 1.8));
    s.playful = clamp(tongue * 1.7 + wink * 0.9 + puff * 0.8);
    s.smirk =
      Math.max(smileL, smileR) > 0.1
        ? clamp(Math.abs(smileL - smileR) * 3.2 + dimpAsym * 1.2 - Math.min(smileL, smileR) * 0.8)
        : 0;
    const surpriseBase = outerUp * 0.7 + inner * 0.5 + wide * 0.9;
    s.surprised = clamp(surpriseBase * 0.85 + jaw * 0.7 * Math.min(1, surpriseBase * 3) - smile * 0.5);
    s.fearful = clamp(stretch * 1.1 + inner * 0.6 + wide * 0.5 + frown * 0.2 - smile - outerUp * 0.4);
    s.sad = clamp(frown * 1.5 + inner * 0.9 * (1 - smile) + shrugLower * 0.4 - smile - jaw * 0.2);
    s.angry = clamp(browDown * 1.5 + squint * 0.4 + sneer * 0.5 + press * 0.7 + frown * 0.3 - smile - inner * 0.8 - 0.25);
    s.disgusted = clamp(sneer * 1.6 + upperUp * 0.7 * (1 - smile) + browDown * 0.25 + lowerDown * 0.2 - smile * 0.8);
    s.skeptical = clamp(browAsym * 2.4 - smile * 0.3);
    s.focused = clamp(browDown * 0.9 + squint * 0.8 + press * 0.5 - sneer * 0.5 - frown * 0.3 - smile - jaw - 0.15);
    s.sleepy = clamp(((ctx.eyelid || 0) - 0.2) * 2.4 + (ctx.yawn ? 0.5 : 0));
    return s;
  }

  /* Smooths scores over time, picks a stable dominant emotion, and turns the
     scores into a probability mix plus valence / arousal for the mood map. */
  class EmotionTracker {
    constructor() {
      this.s = {};
      EMOTIONS.forEach((e) => (this.s[e.id] = 0));
      this.cur = "neutral";
      this.res = null;
    }
    update(raw, dt) {
      let maxOther = 0;
      for (const e of NON_NEUTRAL) {
        this.s[e.id] = ema(this.s[e.id], raw[e.id] || 0, dt, 0.22);
        if (this.s[e.id] > maxOther) maxOther = this.s[e.id];
      }
      this.s.neutral = Math.max(0.06, 0.45 - 0.9 * maxOther);

      let best = "neutral", bv = this.s.neutral;
      for (const e of NON_NEUTRAL) if (this.s[e.id] > bv) { best = e.id; bv = this.s[e.id]; }
      if (best !== this.cur && bv > this.s[this.cur] * 1.12 + 0.02) this.cur = best;

      let sum = 0;
      EMOTIONS.forEach((e) => (sum += this.s[e.id]));
      const probs = EMOTIONS.map((e) => this.s[e.id] / sum);
      let valence = 0, arousal = 0;
      EMOTIONS.forEach((e, i) => { valence += probs[i] * e.v; arousal += probs[i] * e.a; });
      const intensity = this.cur === "neutral" ? clamp(this.s.neutral / 0.45) : clamp(this.s[this.cur]);
      this.res = { dominant: this.cur, intensity, probs, valence, arousal };
      return this.res;
    }
  }

  /* ---- Gaze: x positive = user's right, y positive = down ---------------- */
  function computeGaze(b) {
    const g = (k) => b[k] || 0;
    const right = (g("eyeLookOutRight") + g("eyeLookInLeft")) / 2;
    const left = (g("eyeLookOutLeft") + g("eyeLookInRight")) / 2;
    const up = (g("eyeLookUpLeft") + g("eyeLookUpRight")) / 2;
    const down = (g("eyeLookDownLeft") + g("eyeLookDownRight")) / 2;
    return { x: right - left, y: down - up };
  }

  /* ---- Head pose -----------------------------------------------------------
     Yaw / pitch come from the face transformation matrix (accurate degrees).
     Matrix sign conventions vary between builds, so each axis is cross-checked
     against a simple landmark-based proxy and flipped if they disagree.
     Convention out: yaw + = user turns right, pitch + = looking down,
     roll + = head tilts toward the user's right shoulder. */
  class AxisFixer {
    constructor() { this.ma = 0; this.mb = 0; this.acc = 0; this.n = 0; }
    sign(a, b) {
      this.n++;
      const k = this.n < 30 ? 1 / this.n : 0.02;
      this.ma += (a - this.ma) * k;
      this.mb += (b - this.mb) * k;
      this.acc = this.acc * 0.995 + (a - this.ma) * (b - this.mb);
      return this.acc < 0 ? -1 : 1;
    }
  }

  function matrixAngles(d) {
    const c0 = Math.hypot(d[0], d[1], d[2]) || 1;
    const c1 = Math.hypot(d[4], d[5], d[6]) || 1;
    const c2 = Math.hypot(d[8], d[9], d[10]) || 1;
    const r00 = d[0] / c0, r01 = d[4] / c1, r02 = d[8] / c2;
    const r12 = d[9] / c2, r22 = d[10] / c2;
    return {
      pitch: deg(Math.atan2(-r12, r22)),
      yaw: deg(Math.asin(clamp(r02, -1, 1))),
      dist: Math.abs(d[14]),
    };
  }

  function proxies(pts, w, h) {
    const nose = pts[1], a = pts[234], b = pts[454];
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    const ratio = (nose.x - lo) / (hi - lo || 1);
    const eyeY = (pts[33].y + pts[263].y) / 2;
    const chin = pts[152];
    return {
      yaw: -(ratio - 0.5),
      pitch: (nose.y - eyeY) / (chin.y - eyeY || 1),
      eyeAngle: deg(Math.atan2((pts[263].y - pts[33].y) * h, (pts[263].x - pts[33].x) * w)),
      faceW: Math.hypot((a.x - b.x) * w, (a.y - b.y) * h),
    };
  }

  class HeadPose {
    constructor() { this.fy = new AxisFixer(); this.fp = new AxisFixer(); this.sy = 1; this.sp = 1; }
    update(pts, matrixData, w, h) {
      const px = proxies(pts, w, h);
      let yawRaw, pitchRaw, dist = null;
      if (matrixData && matrixData.length >= 16) {
        const m = matrixAngles(matrixData);
        yawRaw = -m.yaw;
        pitchRaw = m.pitch;
        dist = m.dist;
        this.sy = this.fy.sign(yawRaw, px.yaw);
        this.sp = this.fp.sign(pitchRaw, px.pitch);
      } else {
        yawRaw = px.yaw * 120;
        pitchRaw = px.pitch * 150;
        this.sy = 1;
        this.sp = 1;
      }
      return {
        yawRaw, pitchRaw, sy: this.sy, sp: this.sp,
        yaw: yawRaw * this.sy, pitch: pitchRaw * this.sp,
        roll: -px.eyeAngle, dist, faceW: px.faceW,
      };
    }
  }

  function attentionInstant(rel, gaze, lid) {
    const on =
      Math.abs(rel.yaw) < 22 && Math.abs(rel.pitch) < 18 &&
      Math.abs(gaze.x) < 0.45 && Math.abs(gaze.y) < 0.5 && lid < 0.45;
    return on ? 1 : 0;
  }

  /* ---- Gestures: blinks, yawns, nods, shakes, smiles, drowsiness --------- */
  function range(a) { let lo = Infinity, hi = -Infinity; for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; } return hi - lo; }

  function countReversals(vals, thr) {
    let dir = 0, ext = vals[0], rev = 0;
    for (const v of vals) {
      if (dir === 0) {
        if (v > ext + thr) { dir = 1; ext = v; } else if (v < ext - thr) { dir = -1; ext = v; }
      } else if (dir === 1) {
        if (v > ext) ext = v; else if (v < ext - thr) { dir = -1; ext = v; rev++; }
      } else {
        if (v < ext) ext = v; else if (v > ext + thr) { dir = 1; ext = v; rev++; }
      }
    }
    return rev;
  }

  class Gestures {
    constructor() {
      this.blinks = 0; this.longCloses = 0; this.yawns = 0; this.nods = 0; this.shakes = 0; this.smiles = 0;
      this.closed = false; this.closeStart = 0; this.blinkTimes = []; this.t0 = null;
      this.lid = 0; this.perclos = 0;
      this.hist = []; this.cool = 0;
      this.yawnT = 0; this.yawning = false; this.yawnUntil = 0;
      this.smiling = false;
    }
    yawnRecent(t) { return t < this.yawnUntil; }
    blinkRate(t) {
      while (this.blinkTimes.length && t - this.blinkTimes[0] > 60) this.blinkTimes.shift();
      const win = Math.min(60, t - (this.t0 === null ? t : this.t0));
      if (win < 15) return null;
      return (this.blinkTimes.length * 60) / win;
    }
    update(t, dt, f) {
      const ev = [];
      if (this.t0 === null) this.t0 = t;

      this.lid = ema(this.lid, f.blink, dt, 3);
      this.perclos = ema(this.perclos, f.blink > 0.6 ? 1 : 0, dt, 30);

      const closedNow = this.closed ? f.blink > 0.35 : f.blink > 0.55;
      if (closedNow && !this.closed) { this.closed = true; this.closeStart = t; }
      else if (!closedNow && this.closed) {
        this.closed = false;
        if (t - this.closeStart < 0.9) { this.blinks++; this.blinkTimes.push(t); ev.push("blink"); }
        else { this.longCloses++; ev.push("longclose"); }
      }

      if (!this.smiling && f.smile > 0.45) { this.smiling = true; this.smiles++; ev.push("smile"); }
      else if (this.smiling && f.smile < 0.25) this.smiling = false;

      const yawnPose = f.jaw > 0.5 && f.smile < 0.3 && f.wide < 0.3 && f.blink + f.squint > 0.2;
      if (yawnPose) this.yawnT += dt; else this.yawnT = Math.max(0, this.yawnT - dt * 2);
      if (this.yawnT > 1.2 && !this.yawning) {
        this.yawning = true; this.yawns++; this.yawnUntil = t + 20; ev.push("yawn");
      }
      if (f.jaw < 0.3) this.yawning = false;

      this.hist.push({ t, yaw: f.yaw, pitch: f.pitch });
      while (this.hist.length && t - this.hist[0].t > 1.3) this.hist.shift();
      if (t > this.cool && this.hist.length > 8) {
        const ys = this.hist.map((h) => h.yaw), ps = this.hist.map((h) => h.pitch);
        const yr = range(ys), pr = range(ps);
        if (pr >= 7 && yr < pr * 0.8 && countReversals(ps, 2.5) >= 2) {
          this.nods++; ev.push("nod"); this.cool = t + 1.5; this.hist.length = 0;
        } else if (yr >= 12 && pr < yr * 0.8 && countReversals(ys, 3) >= 2) {
          this.shakes++; ev.push("shake"); this.cool = t + 1.5; this.hist.length = 0;
        }
      }
      return ev;
    }
  }

  /* ---- Posture --------------------------------------------------------------
     Works from a front-facing webcam using pose landmarks (7/8 ears, 11/12
     shoulders, 0 nose). Slouch, forward head and lean are measured against a
     calibrated baseline; tilt and sideways shift work without one. */
  function postureMetrics(lm, w, h, faceW) {
    const vis = (i) => (lm[i] && lm[i].visibility !== undefined ? lm[i].visibility : 1);
    if (!lm[11] || !lm[12] || vis(11) < 0.5 || vis(12) < 0.5) return { ok: false };
    const P = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
    const ls = P(11), rs = P(12);
    const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    if (sw < 20) return { ok: false };
    const smid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const ears = vis(7) > 0.4 && vis(8) > 0.4;
    const le = ears ? P(7) : null, re = ears ? P(8) : null;
    const head = ears ? { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 } : P(0);
    const shoulderAngle = deg(Math.atan2(ls.y - rs.y, ls.x - rs.x));
    const earAngle = ears ? deg(Math.atan2(le.y - re.y, le.x - re.x)) : shoulderAngle;
    const N = (p) => ({ x: p.x / w, y: p.y / h });
    return {
      ok: true,
      shoulderTilt: shoulderAngle,            // + = user's left shoulder lower
      headTilt: earAngle - shoulderAngle,     // + = head tilted toward user's left
      neck: (smid.y - head.y) / sw,           // ear-to-shoulder height, in shoulder widths
      offset: (head.x - smid.x) / sw,         // + = head shifted toward user's left
      size: sw / h,                           // closeness to the camera
      smidY: smid.y / h,
      swn: sw / h,
      faceRatio: faceW ? faceW / sw : null,   // face width vs shoulder width
      pts: { ls: N(ls), rs: N(rs), head: N(head), nose: N(P(0)), le: le && N(le), re: re && N(re) },
    };
  }

  const WEIGHTS = { slouch: 0.5, forward: 0.4, shoulders: 0.25, headTilt: 0.2, offset: 0.15, lean: 0.2 };
  const ISSUES = {
    slouch: "Slouching. Lift your chest and bring your shoulders back.",
    forward: "Your head is drifting forward. Tuck your chin.",
    shoulders: "Your shoulders are uneven. Level them out.",
    headTilt: "Your head is tilted. Bring it back to center.",
    offset: "Your head is off-center from your shoulders.",
    lean: "You're leaning toward the screen. Sit back.",
  };

  function postureScore(m, base) {
    const p = {};
    p.shoulders = clamp((Math.abs(m.shoulderTilt) - 2.5) / 10);
    p.headTilt = clamp((Math.abs(m.headTilt) - 5) / 18);
    let neckDrop = null, forward = null, lean = null, drop = null;
    if (base) {
      neckDrop = (base.neck - m.neck) / Math.max(0.05, Math.abs(base.neck));
      drop = (m.smidY - base.smidY) / Math.max(0.05, base.swn);
      p.slouch = Math.max(clamp((neckDrop - 0.06) / 0.22), clamp((drop - 0.1) / 0.4));
      if (m.faceRatio && base.faceRatio) {
        forward = m.faceRatio / base.faceRatio - 1;
        p.forward = clamp((forward - 0.08) / 0.3);
      }
      lean = m.size / base.size - 1;
      p.lean = clamp((lean - 0.12) / 0.35);
      p.offset = clamp((Math.abs(m.offset - base.offset) - 0.07) / 0.25);
    } else {
      p.offset = clamp((Math.abs(m.offset) - 0.1) / 0.3);
    }
    let total = 0, worst = null, worstV = 0.1;
    for (const k in p) {
      const v = p[k] * WEIGHTS[k];
      total += v;
      if (v > worstV) { worstV = v; worst = k; }
    }
    const score = Math.round(100 * (1 - Math.min(1, total)));
    return {
      score,
      level: score >= 80 ? "good" : score >= 60 ? "okay" : "poor",
      issue: worst ? ISSUES[worst] : null,
      detail: { neckDrop, forward, lean, drop },
    };
  }

  function averageMetrics(list) {
    const keys = ["shoulderTilt", "headTilt", "neck", "offset", "size", "smidY", "swn"];
    const out = {};
    for (const k of keys) out[k] = list.reduce((s, m) => s + m[k], 0) / list.length;
    const fr = list.filter((m) => m.faceRatio).map((m) => m.faceRatio);
    out.faceRatio = fr.length ? fr.reduce((s, v) => s + v, 0) / fr.length : null;
    out.pts = {};
    for (const n of ["ls", "rs", "head", "nose"]) {
      out.pts[n] = {
        x: list.reduce((s, m) => s + m.pts[n].x, 0) / list.length,
        y: list.reduce((s, m) => s + m.pts[n].y, 0) / list.length,
      };
    }
    return out;
  }

  /* ---- Face signature (for the admin gate) ------------------------------------
     A descriptor of pairwise 3D distances between rigid-ish landmarks, normalised
     by overall scale. It is unchanged by translation, rotation and distance, so it
     works from any head angle. This is a convenience gate, not strong biometrics. */
  const FACE_ID_POINTS = [
    6, 168, 1, 2, 98, 327, 4, 5, 197, 195, 9, 8, 10, 151,
    33, 133, 362, 263, 130, 243, 359, 463,
    234, 454, 93, 323, 127, 356, 132, 361,
    21, 251, 54, 284, 172, 397, 58, 288,
  ];
  const FACE_THR_FLOOR = 0.045;

  function faceDescriptor(pts, w, h) {
    const n = FACE_ID_POINTS.length;
    const P = FACE_ID_POINTS.map((i) => [pts[i].x * w, pts[i].y * h, (pts[i].z || 0) * w]);
    const d = new Float32Array((n * (n - 1)) / 2);
    let k = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
        d[k++] = v;
        sum += v;
      }
    }
    const m = sum / d.length || 1;
    for (let i = 0; i < d.length; i++) d[i] /= m;
    return d;
  }

  function descDistance(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const x = (a[i] - b[i]) / (a[i] + b[i] || 1);
      s += x * x;
    }
    return Math.sqrt(s / a.length) * 2;
  }

  function meanDesc(list) {
    const out = new Float32Array(list[0].length);
    for (const d of list) for (let i = 0; i < out.length; i++) out[i] += d[i];
    for (let i = 0; i < out.length; i++) out[i] /= list.length;
    return out;
  }

  /* Template from enrollment frames. The threshold comes from how far rolling
     averages of the enrollment frames wander, with a generous floor. */
  function buildFaceTemplate(descs, win = 10) {
    const mean = meanDesc(descs);
    const dists = [];
    for (let i = 0; i + win <= descs.length; i += 2) dists.push(descDistance(meanDesc(descs.slice(i, i + win)), mean));
    dists.sort((a, b) => a - b);
    const p95 = dists.length ? dists[Math.floor(0.95 * (dists.length - 1))] : 0;
    return { mean: Array.from(mean), thr: Math.max(p95 * 2.5, FACE_THR_FLOOR), n: descs.length, at: Date.now() };
  }

  const api = {
    clamp, ema, EMOTIONS, EMO, blendMap, rawEmotions, EmotionTracker,
    computeGaze, HeadPose, attentionInstant, Gestures,
    postureMetrics, postureScore, averageMetrics, countReversals,
    faceDescriptor, descDistance, meanDesc, buildFaceTemplate, FACE_ID_POINTS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Analysis = api;
})(typeof window !== "undefined" ? window : globalThis);
