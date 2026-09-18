"use strict";

// Library Tweaks — section-switch animation for the native Zen Library.
//
// Mirrors the reference mod's content fade (opacity + rise, native easing):
// when the active tab changes, the incoming section element gets a one-shot
// entrance class. In-place updates (search, delete, re-render) do not retrigger
// it. Honors prefers-reduced-motion.

(function () {
    const PREF = "zen.library.tweaks.animation.switch";
    const STYLE_ID = "lt-switch-anim-style";
    const CLASS = "lt-content-fade-in";

    const isOn = () => {
        try { return Services.prefs.getBoolPref(PREF, true); }
        catch (e) { return true; }
    };

    const CSS = `
@keyframes ltContentFadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: no-preference) {
  .${CLASS} {
    animation: ltContentFadeIn 0.3s cubic-bezier(0.32, 0.72, 0, 1);
  }
}
`;

    const state = {
        hosts: new Map(),
        docObserver: null,
        prefObserver: null,
        style: false,
    };

    function ensureStyle() {
        if (state.style || document.getElementById(STYLE_ID)) {
            state.style = true;
            return;
        }
        // Native host is light-DOM; one shared block on the document is enough
        // and survives instance churn.
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        try {
            document.documentElement.appendChild(style);
            state.style = true;
        } catch (e) { }
    }

    function watchHost(host) {
        if (!host || state.hosts.has(host)) return;
        const content = host.querySelector?.("#zen-library-content");
        if (!content) return;
        const record = { tab: host.activeTab, observer: null };
        const observer = new MutationObserver(() => {
            if (!isOn()) {
                record.tab = host.activeTab;
                return;
            }
            const current = host.activeTab;
            if (current === record.tab) return;
            record.tab = current;
            // Entrance only when the panel is actually open; the first paint
            // of a fresh instance must not animate.
            if (!host.hasAttribute("open")) return;
            const node = content.firstElementChild;
            if (!node) return;
            node.classList.remove(CLASS);
            // Forced reflow so re-adding restarts the animation.
            void node.offsetWidth;
            node.classList.add(CLASS);
            node.addEventListener("animationend", () => node.classList.remove(CLASS), { once: true });
        });
        try {
            observer.observe(content, { childList: true });
            record.observer = observer;
            state.hosts.set(host, record);
        } catch (e) { }
    }

    function scanDocument() {
        for (const host of document.querySelectorAll?.("zen-library") || []) {
            ensureStyle();
            watchHost(host);
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
        if (!state.prefObserver) {
            state.prefObserver = { observe: () => { } };
            try { Services.prefs.addObserver(PREF, state.prefObserver); } catch (e) { state.prefObserver = null; }
        }
    }

    init();
})();
