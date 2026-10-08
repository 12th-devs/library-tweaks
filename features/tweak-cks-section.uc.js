"use strict";

// Library Tweaks — Keyboard Shortcuts section for about:preferences#zenCKS.
//
// Groups the mod's shortcuts (Bookmark This Page, Show All History, Open
// Downloads, Show Bookmarks Library) under one "Library" header in Zen's
// keyboard-shortcuts settings, instead of leaving them scattered across the
// native groups. The rows themselves are only relocated, never rebuilt, so
// bindings, labels and conflict handling stay 100% native.
//
// Sine only injects .uc.js files into browser windows, so this file just
// installs a WindowActor (see background/cks-bootstrap.sys.mjs) whose child
// runs inside the about:preferences document.

(function () {
    try {
        ChromeUtils.importESModule(
            "chrome://sine/content/library-tweaks/background/cks-bootstrap.sys.mjs"
        ).install();
    } catch (e) {
        console.error("[LibraryTweaks] CKS section bootstrap failed:", e);
    }
})();
