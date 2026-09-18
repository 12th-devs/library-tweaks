"use strict";

// Library Tweaks — Spaces enhancements for the native Zen Library.
//
// Two independent pieces, both purely additive (native drag handling and space
// data are never touched):
// 1. Drop indicator: a 2px accent line (rows) / card outline that follows the
//    cursor while dragging over the native spaces section.
// 2. New-space button: a trailing "+" tile that opens workspace creation.

(function () {
    const PREF_INDICATOR = "zen.library.tweaks.spaces.drop-indicator";
    const PREF_NEW_BUTTON = "zen.library.tweaks.spaces.new-button";
    const STYLE_ID = "lt-spaces-tweaks-style";
    const LINE_ID = "lt-space-drop-line";
    const BUTTON_CLASS = "lt-new-space";

    const getBool = (name, fallback) => {
        try { return Services.prefs.getBoolPref(name, fallback); }
        catch (e) { return fallback; }
    };
    const indicatorOn = () => getBool(PREF_INDICATOR, true);
    const buttonOn = () => getBool(PREF_NEW_BUTTON, true);

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
/* Trailing new-space tile. */
.zen-library-spaces > .${BUTTON_CLASS} {
  flex: 0 0 auto;
  align-self: stretch;
  min-width: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed color-mix(in srgb, currentColor 40%, transparent);
  border-radius: 14px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0 12px;
  margin: 0;
}
.zen-library-spaces > .${BUTTON_CLASS}:hover {
  border-color: color-mix(in srgb, currentColor 70%, transparent);
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.zen-library-spaces > .${BUTTON_CLASS} > span {
  font-size: 24px;
  font-weight: 300;
  line-height: 1;
  opacity: 0.7;
}
.zen-library-spaces > .${BUTTON_CLASS}:hover > span {
  opacity: 1;
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

    function createSpace() {
        try { window.gZenLibraryBookmarksIntegration?._closeLibraryAfterOpen?.(); } catch (e) { }
        try {
            const cmd = document.getElementById("cmd_zenOpenWorkspaceCreation");
            if (cmd) {
                cmd.doCommand();
                return;
            }
        } catch (e) { }
        try {
            if (typeof window.gZenWorkspaces?.createWorkspace === "function") {
                window.gZenWorkspaces.createWorkspace();
                return;
            }
        } catch (e) { }
        console.error("[LibraryTweaks] no workspace creation entry point found");
    }

    function syncButton(section) {
        try {
            const strip = section.querySelector?.(".zen-library-spaces");
            if (!strip) return;
            let button = strip.querySelector?.(":scope > ." + BUTTON_CLASS);
            if (!buttonOn()) {
                button?.remove();
                return;
            }
            if (!button) {
                button = document.createElement("button");
                button.type = "button";
                button.className = BUTTON_CLASS;
                button.title = "New space";
                button.setAttribute("aria-label", "New space");
                const plus = document.createElement("span");
                plus.textContent = "+";
                button.appendChild(plus);
                button.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    createSpace();
                });
                strip.appendChild(button);
            } else if (button.parentNode !== strip || button !== strip.lastElementChild) {
                strip.appendChild(button);
            }
        } catch (e) { }
    }

    function attachSection(section) {
        if (!section) return;
        syncButton(section);
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
        try { section.querySelector?.(":scope ." + BUTTON_CLASS)?.remove?.(); }
        catch (e) { }
        hideLine();
    }

    function scanDocument() {
        ensureStyle();
        for (const section of document.querySelectorAll?.("zen-library-spaces-section") || []) {
            if (indicatorOn() || buttonOn()) attachSection(section);
            else detachSection(section);
            // Keep the button in place across native re-renders without touching rows.
            if (buttonOn()) syncButton(section);
        }
    }

    function init() {
        scanDocument();
        if (state.docObserver) return;
        // The button must survive native re-renders: re-append when wiped. The
        // re-append is idempotent, so observer ping-pong terminates.
        state.docObserver = new MutationObserver(() => scanDocument());
        try {
            state.docObserver.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) {
            state.docObserver = null;
        }
        for (const pref of [PREF_INDICATOR, PREF_NEW_BUTTON]) {
            const observer = { observe: () => scanDocument() };
            try {
                Services.prefs.addObserver(pref, observer);
                state.prefObservers.push([pref, observer]);
            } catch (e) { }
        }
    }

    init();
})();
