"use strict";

// Library Tweaks — better Boosts UI for the native Zen Library.
//
// Mirrors the reference mod's presentation on top of native rows: domain group
// headers, large tinted icon tiles, and a diagonal strike on disabled boosts.
// Row behavior (click, moz-toggle, context menu) stays 100% native — this only
// regroups and restyles. The native toggle is kept by design (accessible,
// already wired) instead of the mod's div switch.

(function () {
    const PREF = "zen.library.tweaks.boosts.ui";
    const STYLE_ID = "lt-boosts-ui-style";
    const HEADER_CLASS = "lt-boost-domain";

    const isOn = () => {
        try { return Services.prefs.getBoolPref(PREF, true); }
        catch (e) { return true; }
    };

    const CSS = `
/* Domain group headers, like the reference section. */
zen-library-boosts-section .${HEADER_CLASS} {
  margin: 10px 8px 5px;
  font-size: 12px;
  font-weight: 700;
  opacity: 0.6;
  display: flex;
  align-items: center;
  gap: 8px;
}
zen-library-boosts-section .${HEADER_CLASS}::after {
  content: "";
  flex: 1;
  height: 1px;
  background: color-mix(in srgb, currentColor 15%, transparent);
}
/* Large tinted icon tile. */
zen-library-boosts-section .zen-library-boost-icon {
  width: 46px;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  flex-shrink: 0;
}
zen-library-boosts-section .zen-library-boost-icon::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 10px;
  background: color-mix(in srgb, var(--zen-primary-color, currentColor) 18%, transparent);
}
zen-library-boosts-section .zen-library-boost-icon img {
  position: relative;
  width: 24px;
  height: 24px;
  object-fit: contain;
}
zen-library-boosts-section .zen-library-boost-row {
  padding: 6px 12px 6px 4px;
  border-radius: 18px;
}
/* Disabled: dim + diagonal strike across the tile. */
zen-library-boosts-section .zen-library-boost-row[disabled] .zen-library-row-text,
zen-library-boosts-section .zen-library-boost-row[disabled] .zen-library-boost-icon img {
  opacity: 0.5;
}
zen-library-boosts-section .zen-library-boost-row[disabled] .zen-library-boost-icon::before,
zen-library-boosts-section .zen-library-boost-row[disabled] .zen-library-boost-icon img {
  mask-image: linear-gradient(45deg, black calc(50% - 5px), transparent calc(50% - 5px), transparent calc(50% + 5px), black calc(50% + 5px));
  mask-size: 200% 200%;
  mask-position: center;
  mask-repeat: no-repeat;
}
zen-library-boosts-section .zen-library-boost-row[disabled] .zen-library-boost-icon::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 135%;
  height: 4px;
  border-radius: 10px;
  background: color-mix(in srgb, currentColor 55%, transparent);
  transform: translate(-50%, -50%) rotate(45deg);
  pointer-events: none;
}
`;

    const state = {
        sections: new Map(),
        docObserver: null,
        prefObserver: null,
        style: false,
    };

    function ensureStyle() {
        if (state.style || document.getElementById(STYLE_ID)) {
            state.style = true;
            return;
        }
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        try {
            document.documentElement.appendChild(style);
            state.style = true;
        } catch (e) { }
    }

    function removeStyle() {
        try { document.getElementById(STYLE_ID)?.remove(); } catch (e) { }
        state.style = false;
    }

    function clearHeaders(section) {
        try {
            section.querySelectorAll("." + HEADER_CLASS).forEach(n => n.remove());
        } catch (e) { }
    }

    // Regroup visible rows under domain headers. Runs after native commits, so
    // wipes from native updates simply regroup on the next pass. Compares an
    // order signature first: without that check our own insertions would
    // re-trigger the observer forever.
    function applyHeaders(section) {
        if (!isOn()) {
            clearHeaders(section);
            return;
        }
        try {
            for (const group of section.querySelectorAll(".zen-library-group")) {
                const rows = [...group.querySelectorAll(":scope > .zen-library-boost-row")];
                if (!rows.length) continue;
                const expected = [];
                let last = null;
                for (const row of rows) {
                    const domain = (row.querySelector(".zen-library-row-subtitle")?.textContent || "").trim();
                    if (domain && domain !== last) {
                        expected.push("H:" + domain);
                        last = domain;
                    }
                    expected.push("R");
                }
                const actual = [];
                for (const child of group.children) {
                    if (child.classList?.contains(HEADER_CLASS)) actual.push("H:" + child.textContent);
                    else if (child.classList?.contains("zen-library-boost-row")) actual.push("R");
                }
                if (expected.join("\n") === actual.join("\n")) continue;
                group.querySelectorAll(":scope > ." + HEADER_CLASS).forEach(n => n.remove());
                last = null;
                for (const row of group.querySelectorAll(":scope > .zen-library-boost-row")) {
                    const domain = (row.querySelector(".zen-library-row-subtitle")?.textContent || "").trim();
                    if (!domain || domain === last) continue;
                    last = domain;
                    const header = document.createElement("div");
                    header.className = HEADER_CLASS;
                    header.textContent = domain;
                    row.before(header);
                }
            }
        } catch (e) { }
    }

    function attachSection(section) {
        if (!section || state.sections.has(section)) return;
        const observer = new MutationObserver(() => applyHeaders(section));
        try {
            const results = section.querySelector?.(".zen-library-search-results") || section;
            observer.observe(results, { childList: true, subtree: true });
        } catch (e) { return; }
        state.sections.set(section, observer);
        applyHeaders(section);
    }

    function detachSection(section) {
        const observer = state.sections.get(section);
        if (observer) {
            try { observer.disconnect(); } catch (e) { }
            state.sections.delete(section);
        }
        clearHeaders(section);
    }

    function scanDocument() {
        ensureStyle();
        for (const section of document.querySelectorAll?.("zen-library-boosts-section") || []) {
            if (isOn()) attachSection(section);
            else detachSection(section);
        }
        if (!isOn()) removeStyle();
    }

    function init() {
        scanDocument();
        if (state.docObserver) return;
        state.docObserver = new MutationObserver(() => scanDocument());
        try {
            state.docObserver.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) {
            state.docObserver = null;
        }
        if (!state.prefObserver) {
            state.prefObserver = { observe: () => scanDocument() };
            try { Services.prefs.addObserver(PREF, state.prefObserver); } catch (e) { state.prefObserver = null; }
        }
    }

    init();
})();
