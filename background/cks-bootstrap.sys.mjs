// Library Tweaks — WindowActor bootstrap for the Keyboard Shortcuts section.
//
// Imported (and install() called) by features/tweak-cks-section.uc.js in
// every browser window; module evaluation is cached per process, and the
// `installed` flag guards repeat install() calls. Registers an actor that
// matches about:preferences, whose child groups our shortcuts under one
// "Library" header in Zen's keyboard-shortcuts settings. Pattern mirrors
// zen-glance-long-press/bootstrap.sys.mjs.

const ROOT = "chrome://sine/content/library-tweaks/background/";

let installed = false;

export function install() {
  if (installed) return;
  try {
    ChromeUtils.registerWindowActor("LibraryTweaksCKS", {
      child: {
        esModuleURI: ROOT + "cks-section-child.sys.mjs",
        events: { DOMContentLoaded: {} },
      },
      matches: ["about:preferences*"],
      includeChrome: true,
    });
  } catch (e) {
    console.error("[LibraryTweaks] CKS actor registration failed:", e);
    return;
  }
  installed = true;
}
