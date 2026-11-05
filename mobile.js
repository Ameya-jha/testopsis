/* mobile.js
   Small companion to mobile.css. It only reads the page and adjusts presentation;
   it never changes how the tracker, the vault or the analysis work. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const video = $("video"), stage = $("stage");
  const touchOnly = window.matchMedia("(hover: none)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  /* 1. On portrait phones the camera delivers a tall picture. Tell the CSS its real shape
        so the stage isn't a thin 16:9 strip cropped out of it. */
  function syncShape() {
    if (video && stage && video.videoWidth > 0 && video.videoHeight > 0) {
      stage.style.setProperty("--vid-ar", video.videoWidth + " / " + video.videoHeight);
    }
  }
  if (video) ["loadedmetadata", "resize", "playing"].forEach((ev) => video.addEventListener(ev, syncShape));

  /* 2. Hide buttons that would do nothing in this browser. */
  if (stage && !stage.requestFullscreen && $("fsBtn")) $("fsBtn").hidden = true;
  if (coarse && !("documentPictureInPicture" in window) && $("pipBtn")) $("pipBtn").hidden = true;

  /* 3. Keyboard shortcut hint is noise on a touchscreen. */
  if (touchOnly) {
    document.querySelectorAll(".cell-head .cap").forEach((c) => {
      if (/^S start\/stop/.test(c.textContent.trim())) c.hidden = true;
    });
  }

  /* 4. Be honest about what phones can't do. */
  if (coarse) {
    const foot = document.querySelector(".foot");
    if (foot) {
      const p = document.createElement("p");
      p.textContent =
        "On phones and tablets the browser usually pauses the camera when you switch apps or lock the screen, so tracking pauses too. Turn on Keep the screen awake in Settings and leave this tab open.";
      foot.append(p);
    }
  }
})();
