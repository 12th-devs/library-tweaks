"use strict";

// Library Tweaks — History section replacement for the native Zen Library.
//
// Ported from JustAdumbPrsn/ZenLibraryTweaks (dev branch,
// Modules/ZenLibraryHistoryTweaksSection.mjs). It subclasses the native
// history section in place, adding Recently closed tabs and Clear recent
// history shortcuts above the list. Closed tabs open in a sliding pane with
// reopen/forget actions; everything else about the section stays native.
//
// Differences from upstream:
// - Self-contained: the shared strings/helpers are inlined, and the enable
//   pref follows this mod's `zen.library.tweaks.*` convention (default on).
//   Unregistering restores the native section, so no disabled branches live
//   in the class itself.
// - Registered through this mod's integration (`_historySectionRegister`),
//   like the other section halves, instead of upstream's loader.

(function () {
    const HISTORY_SECTION_URL =
        "moz-src:///zen/library/sections/ZenLibraryHistorySection.mjs";
    const LIT_URL = "chrome://global/content/vendor/lit.all.mjs";
    const PREF = "zen.library.tweaks.history.section";
    const STYLE_ID = "zen-history-tweaks-native-style";

    // Session store tells this when the closed tabs or windows lists change.
    const CLOSED_OBJECTS_TOPIC = "sessionstore-closed-objects-changed";
    // What the native recently closed menu reads to decide whose tabs it lists.
    const CLOSED_FROM_ALL_WINDOWS_PREF =
        "browser.sessionstore.closedTabsFromAllWindows";
    const CLOSED_FROM_CLOSED_WINDOWS_PREF =
        "browser.sessionstore.closedTabsFromClosedWindows";

    // English text for the added rows. The native strings stay on Fluent.
    const STRINGS = {
        "library-history-closed-tabs": "Recently closed tabs",
        "library-history-clear": "Clear recent history\u2026",
        "library-history-closed-tabs-empty": "No recently closed tabs",
        "library-history-back": "Back to history",
    };

    function formatUrl(url) {
        return String(url || "")
            .replace(/^https?:\/\/(www\.)?/, "")
            .replace(/\/$/, "");
    }

    const isEnabled = () => {
        try { return Services.prefs.getBoolPref(PREF, true); }
        catch (e) { return true; }
    };

    let NativeHistory = null;
    try {
        ({ ZenLibraryHistorySection: NativeHistory } =
            ChromeUtils.importESModule(HISTORY_SECTION_URL, { global: "current" }));
    } catch (e) {
        console.error("[LibraryTweaks] native history section unavailable:", e);
    }
    let html = null;
    try {
        ({ html } = ChromeUtils.importESModule(LIT_URL, { global: "current" }));
    } catch (e) {
        console.error("[LibraryTweaks] lit unavailable for history tweaks:", e);
    }
    if (!NativeHistory || !html) return;

    const lazy = {};
    try {
        ChromeUtils.defineESModuleGetters(lazy, {
            PrivateBrowsingUtils:
                "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
            SessionWindowUI:
                "moz-src:///browser/components/sessionstore/SessionWindowUI.sys.mjs",
        });
    } catch (e) { }

    const closedAtFormat = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    });

    class ZenLibraryHistoryTweaksSection extends NativeHistory {
        static render(library) {
            return html`
      <zen-library-history-tweaks-section
        class="zen-library-section"
        data-section="history"
        .library=${library}
      ></zen-library-history-tweaks-section>
    `;
        }

        #observer = { observe: () => this.#readClosedTabs() };

        // What the closed tabs list shows, as `{tab, index, source}`.
        #closedEntries = [];
        #showingClosed = false;

        connectedCallback() {
            super.connectedCallback();
            this.addEventListener("keydown", this.#onKeyDown);
            try { Services.obs.addObserver(this.#observer, CLOSED_OBJECTS_TOPIC); } catch (e) { }
            this.#readClosedTabs();
        }

        disconnectedCallback() {
            super.disconnectedCallback();
            this.removeEventListener("keydown", this.#onKeyDown);
            try { Services.obs.removeObserver(this.#observer, CLOSED_OBJECTS_TOPIC); } catch (e) { }
        }

        // Reading the closed tabs

        /**
         * Lists the tabs the native menu lists: the ones closed in this window,
         * and by the same prefs in the other open windows and in windows that
         * were closed. Tabs closed along with a folder are listed as plain tabs,
         * and the blank tab Zen keeps in every folder is left out. Each tab keeps
         * the index it has in its own list, which is what restoring and
         * forgetting take.
         *
         * @returns {object[]}
         */
        #buildClosedEntries() {
            const store = window.SessionStore;
            if (!store) {
                return [];
            }
            const prefs = Services.prefs;
            const windows =
                prefs.getBoolPref(CLOSED_FROM_ALL_WINDOWS_PREF, true) &&
                store.getWindows
                    ? store.getWindows(window)
                    : [window];
            const sets = windows.map(win => store.getClosedTabDataForWindow(win));
            try {
                if (
                    prefs.getBoolPref(CLOSED_FROM_CLOSED_WINDOWS_PREF, true) &&
                    !lazy.PrivateBrowsingUtils.isWindowPrivate(window) &&
                    store.getClosedTabCountFromClosedWindows?.()
                ) {
                    sets.push(store.getClosedTabDataFromClosedWindows());
                }
            } catch (e) { }
            const entries = [];
            for (const set of sets) {
                try {
                    set.forEach((tab, index) => {
                        if (!this.#isFolderPlaceholder(tab)) {
                            entries.push({ tab, index, source: tab });
                        }
                    });
                } catch (e) { }
            }
            return entries;
        }

        #readClosedTabs() {
            try {
                this.#closedEntries = this.#buildClosedEntries();
            } catch (ex) {
                console.error("Failed to read the closed tabs", ex);
                this.#closedEntries = [];
            }
            // Nothing left to show, so the list has no reason to stay open.
            if (!this.#closedEntries.length) {
                this.#setShowingClosed(false);
            }
            try { this.requestUpdate(); } catch (e) { }
        }

        /**
         * Slides between the history and the closed tabs. The sliding itself
         * is a transition on the `closed-view` attribute in the CSS.
         *
         * @param {boolean} showing
         */
        #setShowingClosed(showing) {
            if (this.#showingClosed === showing) {
                return;
            }
            this.#showingClosed = showing;
            this.toggleAttribute("closed-view", showing);
            try { this.requestUpdate(); } catch (e) { }
            // Inert panes cannot take focus, so this waits for the update.
            try {
                this.updateComplete.then(() =>
                    this.querySelector(
                        showing ? ".zen-library-closed-back" : ".zen-library-closed-shortcut"
                    )?.focus()
                );
            } catch (e) { }
        }

        #onKeyDown = event => {
            if (event.key === "Escape" && this.#showingClosed) {
                // Goes back a step instead of closing the Library.
                event.preventDefault();
                event.stopPropagation();
                this.#setShowingClosed(false);
            }
        };

        // Closed tabs

        /**
         * @param {object} data - A closed tab or folder, or the tab it came with
         * @returns {object} What session store takes to find where it was closed:
         *   a window that is gone, or one that is still open
         */
        #sourceOf(data) {
            return typeof data.sourceClosedId === "number"
                ? { sourceClosedId: data.sourceClosedId }
                : { sourceWindowId: data.sourceWindowId };
        }

        /**
         * @param {object} closedTab - An entry of the session store's list
         * @returns {{title: string, url: string}} What the row shows: the page
         *   the tab was on when it closed
         */
        #closedTabInfo(closedTab) {
            const { entries = [], index = entries.length } = closedTab.state ?? {};
            const entry = entries[index - 1] ?? entries.at(-1);
            const url = entry?.url ?? "";
            return { url, title: closedTab.title || entry?.title || url };
        }

        /**
         * Zen keeps a blank pinned tab in every folder to hold its place. It
         * is not something to list. A blank tab that was not in a folder is a
         * real tab, so it stays.
         *
         * @param {object} closedTab
         * @returns {boolean}
         */
        #isFolderPlaceholder(closedTab) {
            const entries = closedTab?.state?.entries ?? [];
            return (
                !!closedTab?.closedInTabGroupId &&
                !!entries.length &&
                entries.every(({ url }) => url === "about:blank")
            );
        }

        #undoTab({ tab, index, source }) {
            const store = window.SessionStore;
            if (typeof source.sourceClosedId === "number") {
                const undo =
                    store.undoClosedTabFromClosedWindow ??
                    store.undoCloseTabFromClosedWindow;
                undo.call(store, this.#sourceOf(source), tab.closedId);
            } else if (typeof window.undoCloseTab === "function") {
                window.undoCloseTab(index, source.sourceWindowId);
            } else {
                lazy.SessionWindowUI.undoCloseTab(
                    window,
                    index,
                    source.sourceWindowId
                );
            }
        }

        #forgetTab({ tab, index, source }) {
            const store = window.SessionStore;
            try {
                if (store.forgetClosedTabById) {
                    store.forgetClosedTabById(tab.closedId, this.#sourceOf(source));
                } else {
                    store.forgetClosedTab(window, index);
                }
            } catch (ex) {
                console.error("Failed to forget the closed tab", ex);
            }
            this.#readClosedTabs();
        }

        #reopen(restore, event) {
            const background =
                !!event && (event.getModifierState("Accel") || event.button === 1);
            if (!background) {
                try {
                    restore();
                } catch (ex) {
                    console.error("Failed to restore", ex);
                    return;
                }
                try { this.library?.constructor.toggle(); } catch (e) { }
                return;
            }
            let restored = false;
            try {
                this.library.keepOpenWhile(() => {
                    const previous = window.gBrowser?.selectedTab;
                    try {
                        restore();
                        restored = true;
                    } catch (ex) {
                        console.error("Failed to restore", ex);
                    }
                    if (previous?.isConnected && window.gBrowser) {
                        window.gBrowser.selectedTab = previous;
                    }
                });
            } catch (e) {
                return;
            }
            if (restored) {
                try { window.gZenUIManager?.showToast("library-history-opened-in-background"); } catch (e) { }
            }
        }

        #onDragStart(event, title, url) {
            if (!url) {
                event.preventDefault();
                return;
            }
            const { dataTransfer } = event;
            dataTransfer.setData("text/x-moz-url", `${url}\n${title}`);
            dataTransfer.setData("text/uri-list", url);
            dataTransfer.setData("text/plain", url);
            dataTransfer.effectAllowed = "copyLink";
            dataTransfer.addElement(event.currentTarget);
            try {
                // eslint-disable-next-line mozilla/valid-services
                Services.zen.playHapticFeedback();
            } catch (e) { }
        }

        #clearHistory() {
            try { document.getElementById("Tools:Sanitize")?.doCommand(); } catch (e) { }
        }

        // Rendering

        #onActivateKey(event, onActivate) {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onActivate(event);
            }
        }

        #renderShortcut({
            icon,
            text,
            className = "",
            disabled = false,
            chevron = false,
            onActivate,
        }) {
            return html`
      <div
        class="zen-library-row zen-library-shortcut ${className}"
        role="button"
        tabindex=${disabled ? -1 : 0}
        ?disabled=${disabled}
        @click=${onActivate}
        @keydown=${event => this.#onActivateKey(event, onActivate)}
      >
        <img class="zen-library-row-icon" src=${icon} alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${text}</span>
        </div>
        ${chevron
                    ? html`<img
              class="zen-library-shortcut-chevron"
              src="chrome://global/skin/icons/arrow-right.svg"
              alt=""
            />`
                    : null}
      </div>
    `;
        }

        #renderRowActions(onForget, onReopen) {
            return html`
      <div class="zen-library-row-actions">
        <toolbarbutton
          class="toolbarbutton-1"
          data-l10n-id="library-history-forget-button"
          @click=${event => {
                    event.stopPropagation();
                    onForget();
                }}
        >
          <img
            class="toolbarbutton-icon"
            src="chrome://browser/skin/zen-icons/trash.svg"
            alt=""
          />
        </toolbarbutton>
        <toolbarbutton
          class="toolbarbutton-1"
          data-l10n-id="library-history-reopen-button"
          @click=${event => {
                    event.stopPropagation();
                    onReopen(event);
                }}
        >
          <img
            class="toolbarbutton-icon"
            src="chrome://browser/skin/zen-icons/u-turn-to-left.svg"
            alt=""
          />
        </toolbarbutton>
      </div>
    `;
        }

        #renderClosedTab(item) {
            const { tab, source } = item;
            const { title, url } = this.#closedTabInfo(tab);
            const closedAt = tab.closedAt ?? source.closedAt;
            const reopen = event => this.#reopen(() => this.#undoTab(item), event);
            return html`
      <div
        class="zen-library-row"
        role="button"
        tabindex="0"
        draggable="true"
        @click=${reopen}
        @auxclick=${event => {
                    if (event.button === 1) {
                        event.preventDefault();
                        reopen(event);
                    }
                }}
        @keydown=${event => this.#onActivateKey(event, reopen)}
        @dragstart=${event => this.#onDragStart(event, title, url)}
      >
        <img class="zen-library-row-icon" src="page-icon:${url}" alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${title}</span>
          <span class="zen-library-row-subtitle"
            >${closedAt
                    ? html`<span class="zen-library-visit-url"
                    >${formatUrl(url)}</span
                  ><span class="zen-library-visit-date"
                    >${closedAtFormat.format(closedAt)}</span
                  >`
                    : formatUrl(url)}</span
          >
        </div>
        ${this.#renderRowActions(() => this.#forgetTab(item), reopen)}
      </div>
    `;
        }

        #renderClosedPane() {
            const back = () => this.#setShowingClosed(false);
            return html`
      <div
        class="zen-library-pane zen-library-closed-pane"
        ?inert=${!this.#showingClosed}
      >
        <div class="zen-library-closed-header">
          <div
            class="zen-library-row zen-library-closed-back"
            role="button"
            tabindex="0"
            aria-label=${STRINGS["library-history-back"]}
            @click=${back}
            @keydown=${event => this.#onActivateKey(event, back)}
          >
            <img
              class="zen-library-row-icon"
              src="chrome://global/skin/icons/arrow-left.svg"
              alt=""
            />
            <div class="zen-library-row-text">
              <span class="zen-library-row-title"
                >${STRINGS["library-history-closed-tabs"]}</span
              >
            </div>
          </div>
        </div>
        <div class="zen-library-closed-list">
          ${this.#closedEntries.length
                    ? html`<div class="zen-library-group">
                ${this.#closedEntries.map(entry =>
                        this.#renderClosedTab(entry)
                    )}
              </div>`
                    : html`<div class="zen-library-empty">
                ${STRINGS["library-history-closed-tabs-empty"]}
              </div>`}
        </div>
      </div>
    `;
        }

        renderItems() {
            const items = super.renderItems();
            if (this.searchQuery) {
                return items;
            }
            return html`
      <div class="zen-library-group">
        ${this.#renderShortcut({
                icon: "chrome://browser/skin/zen-icons/u-turn-to-left.svg",
                text: STRINGS["library-history-closed-tabs"],
                className: "zen-library-closed-shortcut",
                disabled: !this.#closedEntries.length,
                chevron: true,
                onActivate: () => this.#setShowingClosed(true),
            })}
        ${this.#renderShortcut({
                icon: "chrome://browser/skin/zen-icons/trash.svg",
                text: STRINGS["library-history-clear"],
                onActivate: () => this.#clearHistory(),
            })}
      </div>
      ${items}
    `;
        }

        render() {
            return html`
      <div class="zen-library-pane-track">
        <div
          class="zen-library-pane zen-library-history-pane"
          ?inert=${this.#showingClosed}
        >
          ${super.render()}
        </div>
        ${this.#renderClosedPane()}
      </div>
    `;
        }
    }

    if (!customElements.get("zen-library-history-tweaks-section")) {
        try {
            customElements.define("zen-library-history-tweaks-section", ZenLibraryHistoryTweaksSection);
        } catch (e) {
            console.error("[LibraryTweaks] failed to define history tweaks element:", e);
        }
    }
    window.ZenLibraryHistoryTweaksSection = ZenLibraryHistoryTweaksSection;

    /* --------------------------------------- integration feature mixin */

    const HistorySectionIntegration = {
        _isHistorySectionEnabled() {
            try {
                return Services.prefs.getBoolPref(PREF, true);
            } catch (e) {
                return true;
            }
        },

        _watchHistorySectionPref() {
            if (this._historySectionPrefObserver) return;
            this._historySectionPrefObserver = {
                observe: () => this._onHistorySectionPrefChanged(),
            };
            try {
                Services.prefs.addObserver(PREF, this._historySectionPrefObserver);
            } catch (e) {
                this._historySectionPrefObserver = null;
            }
        },

        _unwatchHistorySectionPref() {
            if (!this._historySectionPrefObserver) return;
            try { Services.prefs.removeObserver(PREF, this._historySectionPrefObserver); } catch (e) { }
            this._historySectionPrefObserver = null;
        },

        // Called from the shared init() and once at file load (this file loads
        // after saves.uc.js, so a normal boot reaches here with init() done).
        _historySectionInit() {
            try { this._watchHistorySectionPref(); } catch (e) { }
            if (!this._isHistorySectionEnabled()) return;
            if (!this._initialized) {
                try { this.init(); } catch (e) { }
                return;
            }
            try { this._registerNativeWhenReady(); } catch (e) { }
            try { this._connectExistingNativeLibraries(); } catch (e) { }
        },

        _onHistorySectionPrefChanged() {
            if (this._isHistorySectionEnabled()) {
                if (!this._initialized) {
                    try { this.init(); } catch (e) { }
                    return;
                }
                try { this._registerNativeWhenReady(); } catch (e) { }
                try { this._connectExistingNativeLibraries(); } catch (e) { }
                return;
            }
            try { this._historySectionUnregister(); } catch (e) { }
            if (!this._anyFeatureEnabled?.()) {
                try { this._unregisterAllSections(); } catch (e) { }
                try { this._shutdown(); } catch (e) { }
            }
        },

        // Native History to restore when the feature is toggled off. Imported
        // on demand like the other native fallbacks.
        _nativeHistorySection() {
            try {
                return ChromeUtils.importESModule(HISTORY_SECTION_URL, { global: "current" }).ZenLibraryHistorySection || null;
            } catch (e) {
                return null;
            }
        },

        // Replaces the native history section in place, so the sidebar keeps
        // its position and everything else stays as Zen made it.
        _historySectionRegister(host) {
            if (!host) return false;
            if (!this._isHistorySectionEnabled?.()) return false;
            if (!customElements.get("zen-library-history-tweaks-section")) return false;
            const sections = host.zenLibrarySections;
            if (!sections || typeof sections !== "object") return false;
            let changed = false;
            if (sections.history !== window.ZenLibraryHistoryTweaksSection) {
                sections.history = window.ZenLibraryHistoryTweaksSection;
                changed = true;
            }
            try { if (this._sanitizeNativeTab?.(host)) changed = true; } catch (e) { }
            try {
                const root = this._nativeRoot?.(host);
                if (root) this._ensureHistoryStyles(root);
            } catch (e) { }
            if (changed) {
                try { host.requestUpdate?.(); } catch (e) { }
            }
            return true;
        },

        _historySectionUnregister() {
            let native = null;
            try { native = this._nativeHistorySection?.(); } catch (e) { native = null; }
            for (const host of Array.from(this._nativeHostObservers?.keys?.() || [])) {
                try {
                    const sections = host?.zenLibrarySections;
                    if (sections?.history && sections.history === window.ZenLibraryHistoryTweaksSection) {
                        if (native && typeof native.render === "function") sections.history = native;
                        else delete sections.history;
                    }
                    // Native history exists either way, so the tab can stay.
                    try {
                        host?.style?.removeProperty?.("--zen-library-content-width");
                    } catch (e) { }
                } catch (e) { }
                try { host?.requestUpdate?.(); } catch (e) { }
            }
        },

        _ensureHistoryStyles(root) {
            if (!root?.querySelector) return;
            const css = `/* Recently closed tabs + clear history (history tweaks). */
zen-library-history-tweaks-section {
  & .zen-library-visit-date {
    display: none;
  }

  & .zen-library-row:hover {
    & .zen-library-visit-url {
      display: none;
    }

    & .zen-library-visit-date {
      display: inline;
    }
  }
}
.zen-library-shortcut {
  &[disabled] {
    opacity: 0.5;
    pointer-events: none;
  }

  & .zen-library-row-icon {
    -moz-context-properties: fill;
    fill: currentColor;
  }
}
.zen-library-shortcut-chevron {
  width: 12px;
  height: 12px;
  margin-inline-start: auto;
  opacity: 0.5;
  -moz-context-properties: fill;
  fill: currentColor;

  &:dir(rtl) {
    scale: -1 1;
  }
}
zen-library-history-tweaks-section {
  overflow: clip;
}
.zen-library-pane-track {
  display: flex;
  flex: 1;
  min-height: 0;

  @media (prefers-reduced-motion: no-preference) {
    transition: translate 0.3s cubic-bezier(0.36, 0.06, 0, 0.94);
  }

  zen-library-history-tweaks-section[closed-view] & {
    translate: -100% 0;

    &:dir(rtl) {
      translate: 100% 0;
    }
  }
}
.zen-library-pane {
  display: flex;
  flex: 0 0 100%;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.zen-library-closed-header {
  padding: 12px 10px 8px;
  -moz-window-dragging: no-drag;
}
.zen-library-closed-list .zen-library-row {
  box-sizing: border-box;
  min-height: 54px;
}
.zen-library-closed-back {
  font-weight: 600;
}
.zen-library-closed-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 10px;
  scrollbar-width: thin;
  -moz-window-dragging: no-drag;
}`;
            const existing = root.querySelector(":scope > #zen-history-tweaks-native-style") ||
                root.querySelector("#zen-history-tweaks-native-style");
            if (existing) {
                if (existing.textContent !== css) existing.textContent = css;
                return;
            }
            const style = document.createElement("style");
            style.id = "zen-history-tweaks-native-style";
            style.textContent = css;
            try { root.appendChild(style); } catch (e) { }
        },
    };

    // Global attach so a saves-only Sine reload (which rebuilds the integration
    // without re-running this file) still picks the history half back up.
    window._libraryTweaksAttachHistorySection = (integration) => {
        if (!integration) return;
        Object.assign(integration, HistorySectionIntegration);
        try { integration._historySectionInit?.(); } catch (e) { console.error("[LibraryTweaks] _historySectionInit failed:", e); }
    };

    try {
        window._libraryTweaksAttachHistorySection(window.gZenLibraryBookmarksIntegration);
    } catch (e) { }
})();
