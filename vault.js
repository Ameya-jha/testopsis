/* vault.js
   An encrypted database that lives in this browser (IndexedDB).
   Every record is compressed, then sealed with AES-256-GCM. The key is derived from the
   admin passcode with PBKDF2 and only ever exists in memory while the vault is unlocked.
   Without the passcode the stored data is unreadable, even with full access to the browser profile. */
(function (root) {
  "use strict";

  const DB_NAME = "tell-vault";
  const ITER = 250000;
  const ENC = new TextEncoder(), DEC = new TextDecoder();
  const FAIL_KEY = "tell.vault.fails";

  let db = null, key = null, pendingKey = null;

  /* ---- helpers ---- */
  const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const b64 = (buf) => {
    const u = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => {
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("meta", { keyPath: "id" });
        r.result.createObjectStore("records", { keyPath: "key" });
      };
      r.onsuccess = () => { db = r.result; res(db); };
      r.onerror = () => rej(r.error);
    });
  }
  async function objStore(name, mode) { return (await open()).transaction(name, mode).objectStore(name); }

  async function derive(pass, salt, iter) {
    const base = await crypto.subtle.importKey("raw", ENC.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  async function seal(k, aad, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let bytes = ENC.encode(JSON.stringify(obj));
    let z = 0;
    if (typeof CompressionStream !== "undefined" && bytes.length > 2048) { bytes = await pipe(bytes, new CompressionStream("gzip")); z = 1; }
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ENC.encode(aad) }, k, bytes);
    return { iv, ct, z };
  }
  async function unseal(k, aad, rec) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv, additionalData: ENC.encode(aad) }, k, rec.ct);
    let bytes = new Uint8Array(pt);
    if (rec.z) bytes = await pipe(bytes, new DecompressionStream("gzip"));
    return JSON.parse(DEC.decode(bytes));
  }

  /* ---- failed-attempt lockout (client side, so a speed bump rather than a wall) ---- */
  function readFails() { try { return JSON.parse(localStorage.getItem(FAIL_KEY)) || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } }
  function lockInfo() { const f = readFails(); return { fails: f.n, wait: Math.max(0, Math.ceil((f.until - Date.now()) / 1000)) }; }
  function noteFail() {
    const f = readFails();
    f.n++;
    if (f.n >= 5) f.until = Date.now() + Math.min(3600, 30 * 2 ** (f.n - 5)) * 1000;
    try { localStorage.setItem(FAIL_KEY, JSON.stringify(f)); } catch { /* storage unavailable */ }
  }
  function clearFails() { try { localStorage.removeItem(FAIL_KEY); } catch { /* storage unavailable */ } }

  /* ---- public API ---- */
  const Vault = {
    available: typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle,
    lockInfo, noteFail, clearFails,
    get isOpen() { return !!key; },

    async exists() { return !!(await wrap((await objStore("meta", "readonly")).get("main"))); },

    /* Create a brand-new vault. Leaves it unlocked. */
    async create(pass, faceTemplate) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const k = await derive(pass, salt, ITER);
      const check = await seal(k, "check", { ok: "tell-vault-v1" });
      const d = await open();
      await new Promise((res, rej) => {
        const t = d.transaction(["meta", "records"], "readwrite");
        t.objectStore("records").clear();
        t.objectStore("meta").put({ id: "main", v: 1, salt, iter: ITER, check });
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
      key = k;
      await Vault.put("face", "template", faceTemplate);
      clearFails();
    },

    /* Step 1 of unlocking: check the passcode and read the face template.
       The vault only opens once commit() is called (after the face check). */
    async verifyPasscode(pass) {
      const meta = await wrap((await objStore("meta", "readonly")).get("main"));
      if (!meta) throw new Error("no-vault");
      const k = await derive(pass, meta.salt, meta.iter);
      try { await unseal(k, "check", meta.check); } catch { throw new Error("bad-passcode"); }
      const rec = await wrap((await objStore("records", "readonly")).get("face:template"));
      pendingKey = k;
      return rec ? unseal(k, "face:template", rec) : null;
    },
    commit() { key = pendingKey; pendingKey = null; clearFails(); },
    abort() { pendingKey = null; },
    lock() { key = null; pendingKey = null; },

    async put(kind, id, obj) {
      if (!key) throw new Error("locked");
      const k = `${kind}:${id}`;
      const sealed = await seal(key, k, obj);
      await wrap((await objStore("records", "readwrite")).put({ key: k, kind, id: String(id), at: Date.now(), ...sealed }));
    },
    async get(kind, id) {
      if (!key) throw new Error("locked");
      const k = `${kind}:${id}`;
      const rec = await wrap((await objStore("records", "readonly")).get(k));
      return rec ? unseal(key, k, rec) : null;
    },
    async list(kind) {
      if (!key) throw new Error("locked");
      const all = await wrap((await objStore("records", "readonly")).getAll());
      const out = [];
      for (const rec of all.filter((r) => r.kind === kind)) {
        try { out.push({ id: rec.id, at: rec.at, data: await unseal(key, rec.key, rec) }); } catch { /* skip unreadable record */ }
      }
      return out;
    },
    async del(kind, id) {
      if (!key) throw new Error("locked");
      await wrap((await objStore("records", "readwrite")).delete(`${kind}:${id}`));
    },

    /* Re-encrypt everything under a new passcode in one atomic transaction. */
    async changePasscode(oldPass, newPass) {
      const d = await open();
      const meta = await wrap(d.transaction("meta").objectStore("meta").get("main"));
      const oldKey = await derive(oldPass, meta.salt, meta.iter);
      try { await unseal(oldKey, "check", meta.check); } catch { throw new Error("bad-passcode"); }
      const all = await wrap(d.transaction("records").objectStore("records").getAll());
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const nk = await derive(newPass, salt, ITER);
      const records = [];
      for (const rec of all) {
        const data = await unseal(oldKey, rec.key, rec);
        records.push({ key: rec.key, kind: rec.kind, id: rec.id, at: rec.at, ...(await seal(nk, rec.key, data)) });
      }
      const check = await seal(nk, "check", { ok: "tell-vault-v1" });
      await new Promise((res, rej) => {
        const t = d.transaction(["meta", "records"], "readwrite");
        t.objectStore("meta").put({ id: "main", v: 1, salt, iter: ITER, check });
        records.forEach((r) => t.objectStore("records").put(r));
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
      key = nk;
    },

    async wipe() {
      const d = await open();
      await new Promise((res, rej) => {
        const t = d.transaction(["meta", "records"], "readwrite");
        t.objectStore("meta").clear();
        t.objectStore("records").clear();
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
      key = null; pendingKey = null;
      clearFails();
    },

    /* The backup is the encrypted records as stored, so it is useless without the passcode. */
    async exportBackup() {
      const d = await open();
      const meta = await wrap(d.transaction("meta").objectStore("meta").get("main"));
      const recs = await wrap(d.transaction("records").objectStore("records").getAll());
      const enc = (r) => ({ ...r, iv: b64(r.iv), ct: b64(r.ct) });
      return JSON.stringify({
        format: "tell-vault-backup", v: 1,
        meta: { ...meta, salt: b64(meta.salt), check: enc(meta.check) },
        records: recs.map(enc),
      });
    },
    async importBackup(text) {
      const j = JSON.parse(text);
      if (j.format !== "tell-vault-backup" || !j.meta || !Array.isArray(j.records)) throw new Error("bad-backup");
      const dec = (r) => ({ ...r, iv: unb64(r.iv), ct: unb64(r.ct) });
      const d = await open();
      await new Promise((res, rej) => {
        const t = d.transaction(["meta", "records"], "readwrite");
        t.objectStore("meta").clear();
        t.objectStore("records").clear();
        t.objectStore("meta").put({ ...j.meta, salt: unb64(j.meta.salt), check: dec(j.meta.check) });
        j.records.forEach((r) => t.objectStore("records").put(dec(r)));
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
      key = null; pendingKey = null;
    },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Vault;
  else root.Vault = Vault;
})(typeof window !== "undefined" ? window : globalThis);
