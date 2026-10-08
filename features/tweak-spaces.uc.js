"use strict";

// Library Tweaks — Spaces enhancements for the native Zen Library.
//
// Purely additive (native drag handling and space data are never touched):
// 1. Drop indicator: a 2px accent line (rows) / card outline that follows the
//    cursor while dragging over the native spaces section.
// Native already renders its own add-space button
// (zen-swipe-add-space-container), so this mod adds none.

(function () {
    const PREF_INDICATOR = "zen.library.tweaks.spaces.drop-indicator";
    const STYLE_ID = "lt-spaces-tweaks-style";
    const LINE_ID = "lt-space-drop-line";
    const LEGACY_BUTTON_CLASS = "lt-new-space";

    const getBool = (name, fallback) => {
        try { return Services.prefs.getBoolPref(name, fallback); }
        catch (e) { return fallback; }
    };
    const indicatorOn = () => getBool(PREF_INDICATOR, true);

    const CSS = `
#${LINE_ID} {
  position: fixed;
  z-index: 2147483646;
  pointer-events: none;
  background: var(--zen-primary-color, currentColor);
  border-radius: 999px;
  opacity: 0;
  transition: opacity 120ms ease;
}
#${LINE_ID}[visible] {
  opacity: 1;
}
.zen-library-space[lt-drop-target] {
  outline: 2px solid var(--zen-primary-color, currentColor);
  outline-offset: -2px;
  border-radius: 14px;
}
`;

    const state = {
        sections: new Map(),
        docObserver: null,
        prefObservers: [],
        style: false,
        line: null,
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

    function ensureLine() {
        if (state.line?.isConnected) return state.line;
        const line = document.createElement("div");
        line.id = LINE_ID;
        try {
            document.documentElement.appendChild(line);
        } catch (e) {
            return null;
        }
        state.line = line;
        return line;
    }

    function hideLine() {
        try { state.line?.removeAttribute("visible"); } catch (e) { }
        try {
            document.querySelectorAll?.(".zen-library-space[lt-drop-target]")
                .forEach(n => n.removeAttribute("lt-drop-target"));
        } catch (e) { }
    }

    function moveLine(rect, horizontal) {
        const line = ensureLine();
        if (!line) return;
        try {
            if (horizontal) {
                line.style.left = `${rect.left}px`;
                line.style.width = `${rect.width}px`;
                line.style.top = `${rect.top}px`;
                line.style.height = "2px";
            } else {
                line.style.top = `${rect.top}px`;
                line.style.height = `${rect.height}px`;
                line.style.left = `${rect.left}px`;
                line.style.width = "2px";
            }
            line.setAttribute("visible", "");
        } catch (e) { }
    }

    // Purely visual: native owns the actual drop handling, we never
    // preventDefault here, so drops behave exactly as without us.
    function onDragOver(section, event) {
        if (!indicatorOn()) {
            hideLine();
            return;
        }
        const row = event.target?.closest?.(".zen-library-space-body, .zen-library-space-tabs, tab, .tab-group-label-container");
        const card = event.target?.closest?.(".zen-library-space");
        if (!card || !section.contains(card)) {
            hideLine();
            return;
        }
        // Over a card's empty area (not a row): outline the whole card.
        if (!row || !card.contains(row)) {
            hideLine();
            try { card.setAttribute("lt-drop-target", ""); } catch (e) { }
            return;
        }
        try { card.removeAttribute("lt-drop-target"); } catch (e) { }
        const rect = row.getBoundingClientRect();
        if (!rect || rect.width <= 0) {
            hideLine();
            return;
        }
        const before = event.clientY < rect.top + rect.height / 2;
        moveLine({
            left: rect.left,
            width: rect.width,
            top: before ? rect.top - 1 : rect.bottom - 1,
        }, true);
    }

    function removeLegacyButtons(section) {
        try {
            if (section?.querySelector) {
                section.querySelectorAll?.(":scope ." + LEGACY_BUTTON_CLASS)
                    ?.forEach(n => n.remove());
            } else {
                document.querySelectorAll?.(".zen-library-spaces > ." + LEGACY_BUTTON_CLASS)
                    ?.forEach(n => n.remove());
            }
        } catch (e) { }
    }

    function attachSection(section) {
        if (!section) return;
        removeLegacyButtons(section);
        if (state.sections.has(section)) return;
        const over = (event) => onDragOver(section, event);
        const hide = () => hideLine();
        section.addEventListener("dragover", over);
        section.addEventListener("dragleave", hide);
        section.addEventListener("drop", hide);
        section.addEventListener("dragend", hide);
        state.sections.set(section, { over, hide });
    }

    function detachSection(section) {
        const handlers = state.sections.get(section);
        if (handlers) {
            try {
                section.removeEventListener("dragover", handlers.over);
                section.removeEventListener("dragleave", handlers.hide);
                section.removeEventListener("drop", handlers.hide);
                section.removeEventListener("dragend", handlers.hide);
            } catch (e) { }
            state.sections.delete(section);
        }
        removeLegacyButtons(section);
        hideLine();
    }

    function scanDocument() {
        ensureStyle();
        // One-time cleanup of buttons added by older versions of this mod.
        removeLegacyButtons();
        for (const section of document.querySelectorAll?.("zen-library-spaces-section") || []) {
            if (indicatorOn()) attachSection(section);
            else detachSection(section);
        }
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
        for (const pref of [PREF_INDICATOR]) {
            const observer = { observe: () => scanDocument() };
            try {
                Services.prefs.addObserver(pref, observer);
                state.prefObservers.push([pref, observer]);
            } catch (e) { }
        }
    }

    init();
})();
