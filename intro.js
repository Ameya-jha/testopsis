/* intro.js
   Welcome sequence: an animated splash, a few questions, then the answers are sealed in the
   encrypted vault as a "profile" record.

   How it stays out of the way of the existing code:
   - It only uses the public Vault API (put / get / isOpen) and the existing setup and unlock
     dialogs. Nothing in script.js, vault.js or analysis.js is modified.
   - The answers are held in memory only. They are never written to localStorage or any other
     plain storage. If the vault isn't open yet, they wait until the person finishes the normal
     "Set up admin vault" or "Unlock" dialog, then get written, encrypted.
   - Everything typed or read back from the vault is rendered with textContent, never innerHTML. */
(function () {
  "use strict";

  const root = document.getElementById("intro");
  if (!root) return;
  const html = document.documentElement;
  const appEl = document.querySelector(".app");
  const inner = document.getElementById("introInner");
  const skipBtn = document.getElementById("introSkip");
  const dlg = document.getElementById("vaultDlg");
  const V = window.Vault;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  const KIND = "profile", ID = "main";
  const LINE = "Reads your face, mood and posture. Your video never leaves this device.";
  const FALLBACK = [
    { emoji: "😐", label: "Neutral", color: "#d9d8d0" }, { emoji: "😄", label: "Happy", color: "#ffd43b" },
    { emoji: "😲", label: "Surprised", color: "#3bd5ff" }, { emoji: "😢", label: "Sad", color: "#5b8cff" },
    { emoji: "😠", label: "Angry", color: "#ff4545" }, { emoji: "🧐", label: "Focused", color: "#6ee7a8" },
  ];
  const STEPS = [
    { id: "name", q: "What should we call you?", hint: "A first name or nickname.", type: "name" },
    { id: "age", q: "How old are you?", hint: "Just a number.", type: "age" },
    { id: "use", q: "What do you mostly do at your screen?", hint: "Optional.", type: "single", opts: [
      ["work", "Work"], ["study", "Study"], ["create", "Creative stuff"], ["play", "Gaming"], ["other", "Something else"]] },
    { id: "hours", q: "How long are you there on a normal day?", hint: "Optional.", type: "single", opts: [
      ["lt2", "Under 2 hours"], ["2-4", "2 to 4 hours"], ["4-8", "4 to 8 hours"], ["8+", "8 hours or more"]] },
    { id: "goals", q: "What do you want from Tell?", hint: "Pick any that fit. Optional.", type: "multi", opts: [
      ["posture", "Better posture"], ["eyes", "Less eye strain"], ["focus", "Stay focused"],
      ["mood", "Understand my mood"], ["breaks", "Remember breaks"], ["curious", "Just curious"]] },
  ];
  const label = (id, val) => {
    const st = STEPS.find((s) => s.id === id);
    const o = st && st.opts && st.opts.find((x) => x[0] === val);
    return o ? o[1] : null;
  };

  let vaultOk = !!(V && V.available), vaultExists = false;
  const blank = () => ({ name: "", age: null, use: null, hours: null, goals: [] });
  let profile = blank();
  let stepIdx = 0, pending = null, onSplash = false, timers = [], finished = false;

  /* ---- tiny DOM helpers (text only, never HTML) ---- */
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, cls, type) {
    const b = h("button", "btn" + (cls ? " " + cls : ""), text);
    b.type = type || "button";
    return b;
  }
  function clearTimers() { timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); timers = []; }
  function mount(node, focusEl) {
    clearTimers();
    onSplash = false;
    inner.replaceChildren(node);
    root.scrollTop = 0;
    if (focusEl) { try { focusEl.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  /* ---- leaving ---- */
  function dismiss(instant) {
    if (finished) return;
    finished = true;
    pending = null;
    profile = blank();
    clearTimers();
    const done = () => {
      root.classList.remove("on", "leaving", "away");
      html.classList.remove("intro-open");
      if (appEl) { appEl.removeAttribute("inert"); appEl.removeAttribute("aria-hidden"); }
      root.remove();
      const t = document.getElementById("toggleBtn");
      if (t) { try { t.focus({ preventScroll: true }); } catch { /* ignore */ } }
    };
    if (instant) return done();
    root.classList.add("leaving");
    setTimeout(done, 380);
  }

  /* ---- splash ---- */
  function typeInto(node, text) {
    if (reduce) { node.textContent = text; return; }
    let i = 0;
    timers.push(setInterval(() => { node.textContent = text.slice(0, ++i); }, 26));
  }
  function ticker(emojiEl, nameEl) {
    const list = (window.Analysis && window.Analysis.EMOTIONS) || FALLBACK;
    const settle = list.find((e) => e.label === "Happy") || list[0];
    const show = (e) => { root.style.setProperty("--mood", e.color); emojiEl.textContent = e.emoji; nameEl.textContent = e.label; };
    if (reduce) { show(settle); return; }
    let i = 0;
    show(list[0]);
    const id = setInterval(() => {
      i++;
      if (i >= list.length * 2) { clearInterval(id); show(settle); return; }
      show(list[i % list.length]);
    }, 240);
    timers.push(id);
  }

  function showSplash() {
    const returning = vaultOk && vaultExists;
    const s = h("div", "step splash");
    const cap = h("p", "intro-cap");
    cap.append(h("span", "rec"), document.createTextNode(returning ? "Welcome back" : "Ready"));
    const word = h("h1", "intro-word", "Tell");
    const face = h("div", "intro-face");
    const em = h("span", "intro-emoji", "😐"), nm = h("span", "intro-emo", "Neutral");
    em.setAttribute("aria-hidden", "true"); nm.setAttribute("aria-hidden", "true");
    face.append(em, nm);
    const line = h("p", "intro-line");
    const typed = h("span"); typed.setAttribute("aria-hidden", "true");
    line.append(h("span", "sr", LINE), typed);
    const acts = h("div", "intro-actions");
    const go = btn(returning ? "Unlock vault" : "Begin", "primary");
    go.addEventListener("click", () => (returning ? requestVault("greet") : startQuestions()));
    acts.append(go);
    s.append(cap, word, face, line, acts);
    mount(s, go);
    onSplash = true;
    ticker(em, nm);
    typeInto(typed, LINE);
  }

  /* ---- questions ---- */
  function startQuestions() { stepIdx = 0; renderStep(); }

  function renderStep() {
    const st = STEPS[stepIdx];
    const f = h("form", "step");
    f.noValidate = true;
    f.setAttribute("autocomplete", "off");
    const prog = h("div", "intro-prog");
    prog.setAttribute("aria-hidden", "true");
    STEPS.forEach((_, i) => prog.append(h("i", i <= stepIdx ? "on" : "")));
    const q = h("h2", "intro-q", st.q);
    q.id = "introQ"; q.tabIndex = -1;
    f.append(prog, h("p", "intro-cap", `Step ${stepIdx + 1} of ${STEPS.length}`), q);
    if (st.hint) f.append(h("p", "intro-hint", st.hint));

    let input = null, collect;
    if (st.type === "name" || st.type === "age") {
      input = h("input", "intro-in");
      input.type = "text";
      input.setAttribute("aria-labelledby", "introQ");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("enterkeyhint", "next");
      if (st.type === "name") {
        input.maxLength = 40; input.placeholder = "Your name";
        input.setAttribute("autocapitalize", "words"); input.setAttribute("spellcheck", "false");
        input.value = profile.name;
      } else {
        input.maxLength = 3; input.placeholder = "00";
        input.setAttribute("inputmode", "numeric"); input.setAttribute("pattern", "[0-9]*");
        input.value = profile.age == null ? "" : String(profile.age);
        input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 3); });
      }
      if (coarse) input.addEventListener("focus", () => setTimeout(() => input.scrollIntoView({ block: "center", behavior: "smooth" }), 300));
      f.append(input);
      collect = () => {
        if (st.type === "name") {
          const v = input.value.replace(/\s+/g, " ").trim();
          if (!v) return "Tell us what to call you.";
          profile.name = v;
        } else {
          const v = input.value.trim();
          if (!/^\d{1,3}$/.test(v)) return "Enter your age as a number.";
          const n = Number(v);
          if (n < 1 || n > 120) return "Enter an age between 1 and 120.";
          profile.age = n;
        }
        return "";
      };
    } else {
      const grid = h("div", "opts");
      const multi = st.type === "multi";
      st.opts.forEach(([val, text]) => {
        const lab = h("label", "opt");
        const inp = h("input");
        inp.type = multi ? "checkbox" : "radio";
        inp.name = st.id; inp.value = val;
        inp.checked = multi ? profile.goals.includes(val) : profile[st.id] === val;
        lab.append(inp, h("span", "", text));
        grid.append(lab);
      });
      f.append(grid);
      collect = () => {
        const picked = Array.from(grid.querySelectorAll("input:checked")).map((i) => i.value);
        if (multi) profile.goals = picked; else profile[st.id] = picked[0] || null;
        return "";
      };
    }

    const err = h("p", "intro-err");
    err.setAttribute("role", "alert");
    const acts = h("div", "intro-actions");
    const back = btn("Back");
    back.addEventListener("click", () => { if (stepIdx > 0) { stepIdx--; renderStep(); } else showSplash(); });
    acts.append(back, btn(stepIdx === STEPS.length - 1 ? "Review" : "Next", "primary", "submit"));
    f.append(err, acts);
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const msg = collect();
      if (msg) { err.textContent = msg; if (input) input.setAttribute("aria-invalid", "true"); return; }
      stepIdx++;
      if (stepIdx >= STEPS.length) renderReview(""); else renderStep();
    });
    mount(f, input || q);
  }

  /* ---- review and save ---- */
  function reviewCopy() {
    if (!vaultOk) return { note: "Encrypted storage isn't available in this browser (open the page from http://localhost or https://), so this can't be saved.", cta: "Continue without saving", save: false };
    if (V.isOpen) return { note: "Your vault is unlocked. This will be saved to it, encrypted.", cta: "Save to vault" };
    if (vaultExists) return { note: "Unlock your vault to save this. Your passcode and a quick face scan open it.", cta: "Unlock and save" };
    return { note: "This is kept in memory only until it goes into an encrypted vault. Next you'll choose a passcode and Tell will learn your face as a second gate.", cta: "Create vault and save" };
  }

  function renderReview(message) {
    const c = reviewCopy();
    const f = h("div", "step");
    const prog = h("div", "intro-prog");
    prog.setAttribute("aria-hidden", "true");
    STEPS.forEach(() => prog.append(h("i", "on")));
    const q = h("h2", "intro-q", "Look right?");
    q.tabIndex = -1;
    const sum = h("dl", "intro-sum");
    const row = (k, v) => { const d = h("div"); d.append(h("dt", "", k), h("dd", "", v)); sum.append(d); };
    row("Name", profile.name);
    row("Age", String(profile.age));
    row("Screen use", label("use", profile.use) || "Not said");
    row("Daily hours", label("hours", profile.hours) || "Not said");
    row("Goals", profile.goals.length ? profile.goals.map((g) => label("goals", g)).join(", ") : "Not said");
    const note = h("p", "intro-note", c.note);
    const err = h("p", "intro-err", message || "");
    err.setAttribute("role", "alert");
    const acts = h("div", "intro-actions");
    const back = btn("Edit");
    back.addEventListener("click", () => { stepIdx = 0; renderStep(); });
    const go = btn(c.cta, "primary");
    go.addEventListener("click", () => (c.save === false ? dismiss() : saveProfile(err, go)));
    acts.append(back, go);
    f.append(prog, h("p", "intro-cap", "Review"), q, sum, note, err, acts);
    mount(f, q);
  }

  async function writeProfile() {
    await V.put(KIND, ID, {
      v: 1, name: profile.name, age: profile.age, use: profile.use,
      hours: profile.hours, goals: profile.goals.slice(), savedAt: Date.now(),
    });
  }

  async function saveProfile(err, goBtn) {
    if (V.isOpen) {
      goBtn.disabled = true;
      try { await writeProfile(); renderSaved(); }
      catch (e) { goBtn.disabled = false; err.textContent = "Couldn't save: " + (e && e.message ? e.message : e); }
      return;
    }
    requestVault("save");
  }

  /* Hand over to the existing setup / unlock dialog, then pick up where we left off. */
  function requestVault(intent) {
    pending = intent;
    root.classList.add("away");
    const name = vaultExists ? "beginUnlock" : "beginSetup";
    if (typeof window[name] === "function") { window[name](); return; }
    const b = document.querySelector("#vaultActions .btn.primary");   // fallback: press the page's own button
    if (b) b.click(); else { pending = null; root.classList.remove("away"); }
  }

  if (dlg) dlg.addEventListener("close", async () => {
    if (!pending || finished) return;
    const intent = pending;
    pending = null;
    root.classList.remove("away");
    if (!(V && V.isOpen)) {                       // dialog was cancelled
      if (intent === "save") renderReview("The vault wasn't opened, so nothing was saved yet.");
      else showSplash();
      return;
    }
    vaultExists = true;
    try {
      if (intent === "save") { await writeProfile(); renderSaved(); return; }
      const p = await V.get(KIND, ID);
      if (p && typeof p.name === "string" && p.name) renderWelcome(String(p.name).slice(0, 60));
      else { profile = blank(); startQuestions(); }    // vault from before this feature: ask once, save straight in
    } catch (e) {
      if (intent === "save") renderReview("Couldn't save: " + (e && e.message ? e.message : e));
      else dismiss();
    }
  });

  /* ---- end screens ---- */
  function endScreen(capText, heading, who, sub) {
    const s = h("div", "step");
    const q = h("h2", "intro-q big");
    q.tabIndex = -1;
    q.append(document.createTextNode(heading));
    if (who) { const w = h("span", "who", who); q.append(w, document.createTextNode(".")); }
    const acts = h("div", "intro-actions");
    const go = btn("Open Tell", "primary");
    go.addEventListener("click", () => dismiss());
    acts.append(go);
    s.append(h("p", "intro-cap", capText), q);
    if (sub) s.append(h("p", "intro-lead", sub));
    s.append(acts);
    mount(s, go);
    timers.push(setTimeout(() => dismiss(), 2600));
  }
  function renderSaved() { endScreen("Saved", "Sealed in your vault, ", profile.name, "Encrypted with your passcode. Only your passcode and face open it."); }
  function renderWelcome(name) { endScreen("Vault unlocked", "Welcome back, ", name, ""); }

  /* ---- wiring ---- */
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();                         // the page's S / C / H / L shortcuts must not fire from here
    if (e.key === "Escape" && onSplash && !pending) dismiss();
  });
  if (skipBtn) skipBtn.addEventListener("click", () => dismiss());

  (async function boot() {
    try {
      html.classList.add("intro-open");
      if (appEl) appEl.setAttribute("inert", "");
      if (vaultOk) {
        try {
          vaultExists = await Promise.race([
            V.exists(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2500)),
          ]);
        } catch { vaultOk = false; }
      }
      root.dataset.ready = "1";
      showSplash();
    } catch (e) {
      console.warn("intro failed, skipping", e);
      dismiss(true);
    }
  })();
})();
