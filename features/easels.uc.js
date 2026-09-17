"use strict";

// Library Tweaks — Easels section for the native Zen Library.
//
// Ported from the Zen Library mod's Easels section (features/Easels.uc.js).
// Cards, grid, search filtering, context menu and host delegation are identical;
// the surrounding chrome follows the native library instead:
//  - section shape is a real Section class (static id/label/render) like the
//    built-ins, mounted through <zen-library-easels-section>;
//  - the search header uses the native pill markup;
//  - open/close goes through the shared native-aware helpers;
//  - ZenLibraryUtil is optional (trailing-edge debounce + card-remove fallbacks).
//
// Data comes straight from zen-easel's background store
// (chrome://sine/content/zen-easel/background/store.sys.mjs), so this works even
// with the easel mod's per-window scripts disabled or not yet loaded.

(function () {
    const STORE_URL = "chrome://sine/content/zen-easel/background/store.sys.mjs";
    const EASELS_PREF = "zen.easels.enabled";

    class ZenLibraryEasels {
        constructor(library) {
            this.library = library;
            this._easels = [];
            this._searchTerm = "";
            this._grid = null;
            this._searchDebounce = null;
            this._refreshing = false;
        }

        get el() { return this.library.el.bind(this.library); }
        get svg() { return this.library.svg.bind(this.library); }

        // Resolved lazily so that a profile without the easel mod installed shows an
        // empty state rather than throwing at library construction.
        _store() {
            try {
                return ChromeUtils.importESModule(STORE_URL).EaselStore;
            } catch (e) {
                return null;
            }
        }

        async init() {
            await this.refresh();
        }

        async refresh() {
            const store = this._store();
            if (!store) {
                this._easels = [];
                return;
            }
            try {
                this._easels = await store.listEasels();
            } catch (e) {
                console.error("[LibraryTweaks] could not read the easel index:", e);
                this._easels = [];
            }
        }

        // refresh() reloads the list; this puts the reloaded list back on screen.
        // Guarded because a mutation can land after the section has been left, and
        // re-rendering then would redraw a detached element for nothing.
        async _reload() {
            await this.refresh();
            if (this._isOpenOnEasels()) {
                try { this.library.update(true); } catch (e) { }
            }
        }

        _isOpenOnEasels() {
            try {
                if (this.library?.activeTab !== "easels") return false;
                const Ctor = customElements.get("zen-library");
                if (Ctor && typeof Ctor.getInstance === "function") {
                    return !!Ctor.getInstance(false)?.hasAttribute?.("open");
                }
                return !!window.gZenLibrary?._isOpen;
            } catch (e) {
                return false;
            }
        }

        // Trailing-edge debounce fallback for when the custom library mod (and its
        // ZenLibraryUtil) is not loaded. Same re-arming semantics.
        _debounceFn(fn, ms) {
            let timer = null;
            const wrapped = (...args) => {
                if (timer) window.clearTimeout(timer);
                timer = window.setTimeout(() => {
                    timer = null;
                    fn(...args);
                }, ms);
            };
            wrapped.cancel = () => {
                if (timer) window.clearTimeout(timer);
                timer = null;
            };
            return wrapped;
        }

        // Native pill search header (no filter panel on this section). Typing only
        // refills the grid in place, so focus never leaves the field.
        renderHeaderControls() {
            const searchInput = this.el("input", {
                type: "search",
                placeholder: "Search Easels...",
                value: this._searchTerm,
                oninput: (event) => {
                    this._searchTerm = event.target.value;
                    if (!this._searchDebounce) {
                        const debounce = window.ZenLibraryUtil?.debounce ||
                            ((fn, ms) => this._debounceFn(fn, ms));
                        this._searchDebounce = debounce(() => {
                            if (this._grid?.isConnected) this._fillGrid(this._grid);
                        }, 250);
                    }
                    this._searchDebounce();
                }
            });
            return this.el("div", { className: "zen-library-search-top" }, [
                this.el("div", { className: "zen-library-search-header" }, [
                    this.el("div", { className: "zen-library-search-box" }, [
                        this.el("img", { src: "chrome://browser/skin/zen-icons/search-glass.svg", alt: "" }),
                        searchInput
                    ])
                ])
            ]);
        }

        render() {
            const grid = this.el("div", { className: "easel-card-grid" });
            this._grid = grid;
            this.library.enterContent(grid);
            this._fillGrid(grid);
            this._scheduleRerender();
            return grid;
        }

        _fillGrid(grid) {
            grid.replaceChildren();

            if (!this._store()) {
                grid.appendChild(this._easelInstallCard());
                return;
            }

            // First child of the two-column grid, so it sits at the top of the left
            // column rather than trailing the last board.
            grid.appendChild(this.el("button", {
                className: "easel-card easel-card-new",
                type: "button",
                title: "New easel",
                onclick: () => this._newEasel()
            }));

            const term = (this._searchTerm || "").trim().toLowerCase();
            const visible = term
                ? this._easels.filter(e => (e.title || "").toLowerCase().includes(term))
                : this._easels;

            if (!visible.length) {
                grid.appendChild(this._empty(
                    term ? "No easels match" : "No easels yet",
                    term ? "Try a different search." : "Press Ctrl+Shift+E to start one."
                ));
            } else {
                for (const entry of visible) grid.appendChild(this._card(entry));
            }
        }

        // A cheap identity for the rendered list: what would make the grid look
        // different. Comparing signatures means the refresh loop below settles the
        // moment the list stops changing instead of re-rendering forever.
        _signature(list = this._easels) {
            return list.map(e => `${e.id}:${e.updatedAt}:${e.title}`).join("|");
        }

        // The list is read asynchronously but render() is synchronous, so the first
        // paint after opening the section can be a frame behind. Re-render once the
        // fresh index lands rather than making the click wait on a file read.
        _scheduleRerender() {
            if (this._refreshing) return;
            this._refreshing = true;
            const before = this._signature();

            this.refresh()
                .then(() => {
                    this._refreshing = false;
                    if (this.library.activeTab !== "easels") return;
                    if (this._signature() === before) return;
                    this.library.update(true);
                })
                .catch(() => { this._refreshing = false; });
        }

        _cardTitle(title) {
            const text = title || "Untitled Easel";
            return text.length > 20 ? `${text.slice(0, 20)}…` : text;
        }

        _card(entry) {
            const mark = this.el("div", { className: "easel-card-mark" });
            const squiggle = this.svg(this._squiggleSvg());
            if (squiggle) mark.appendChild(squiggle);

            const fullTitle = entry.title || "Untitled Easel";
            return this.el("button", {
                className: "easel-card",
                type: "button",
                dataset: { id: entry.id },
                title: fullTitle,
                oncontextmenu: e => this._contextMenu(e, entry),
                onclick: () => this._openEasel(entry.id)
            }, [
                this.el("div", { className: "easel-card-frame" }, [
                    this.el("div", { className: "easel-card-body" }, [
                        this.el("div", { className: "easel-card-count", textContent: String(entry.objectCount ?? 0) }),
                        this.el("div", { className: "easel-card-copy" }, [
                            mark,
                            this.el("div", { className: "easel-card-title", textContent: this._cardTitle(entry.title) })
                        ])
                    ])
                ])
            ]);
        }

        _squiggleSvg() {
            return `<svg class="easel-card-squiggle" viewBox="20 38 76 68" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M 79.08 42.08 C 91.19 54.79 88.45 58.62 81.98 56.04 C 75.51 53.47 66.12 44.54 59.62 47.55 C 53.12 50.56 91.47 84.24 77.76 86.61 C 72.57 87.51 43.87 53.27 34.03 56.04 C 23.75 58.94 58.53 84.24 60.64 100.31" stroke="currentColor" stroke-width="7.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        }

        /* ------------------------------------------- missing-easel install UI */

        // Synchronous best-known state: store importable? host alive? folder present?
        // Whether the present folder is enabled is resolved by just enabling it —
        // flipping an already-enabled entry is harmless and the restart fixes a
        // half-loaded host either way.
        _easelInstallState() {
            let host = null;
            try { host = window.gZenEaselHost || null; } catch (e) { }
            if (this._store()) {
                return host ? "ready" : "needs-restart";
            }
            let folderExists = false;
            try {
                const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
                dir.append(PathUtils.profileDir);
                dir.appendRelativePath(PathUtils.join("chrome", "sine-mods", "zen-easel"));
                folderExists = dir.exists() && dir.isDirectory();
            } catch (e) { }
            return folderExists ? "disabled" : "missing";
        }

        _easelInstallCard() {
            const state = this._easelInstallState();
            const card = this.el("div", { className: "empty-state easel-install" });
            const mark = this.el("div", { className: "easel-install-mark" });
            const squiggle = this.svg(this._squiggleSvg());
            if (squiggle) mark.appendChild(squiggle);
            card.appendChild(mark);

            if (state === "needs-restart") {
                card.appendChild(this.el("h3", { textContent: "Zen Easel needs a restart" }));
                card.appendChild(this.el("p", { textContent: "Its files are here but its window scripts did not load. Restart Zen to finish enabling it." }));
                card.appendChild(this.el("button", {
                    className: "easel-install-button",
                    type: "button",
                    onclick: () => this._restartBrowser()
                }, [this.el("span", { textContent: "Restart Zen" })]));
                return card;
            }

            card.appendChild(this.el("h3", { textContent: "Boards live in Zen Easel" }));
            if (state === "disabled") {
                card.appendChild(this.el("p", { textContent: "The zen-easel mod is installed but not enabled. Enable it and restart to keep boards here." }));
                card.appendChild(this.el("button", {
                    className: "easel-install-button",
                    type: "button",
                    onclick: async () => {
                        await this._enableEaselMod();
                        this._restartBrowser();
                    }
                }, [this.el("span", { textContent: "Enable Zen Easel" })]));
                card.appendChild(this.el("div", {
                    className: "easel-install-note",
                    textContent: "Zen will restart to load it."
                }));
                return card;
            }

            card.appendChild(this.el("p", { textContent: "Install the Zen Easel mod to capture, sketch and keep boards here." }));
            card.appendChild(this.el("button", {
                className: "easel-install-button",
                type: "button",
                onclick: () => {
                    try { window.openTrustedLinkIn("https://sineorg.github.io/store", "tab"); } catch (e) { }
                }
            }, [this.el("span", { textContent: "Get Zen Easel" })]));
            card.appendChild(this.el("div", {
                className: "easel-install-note",
                textContent: "Opens the Sine store — search for Zen Easel, then come back here."
            }));
            return card;
        }

        // Targeted mods.json surgery (brace-matched, so the file's single-line
        // formatting is preserved) instead of a full JSON rewrite.
        async _enableEaselMod() {
            try {
                const path = PathUtils.join(PathUtils.profileDir, "chrome", "sine-mods", "mods.json");
                const raw = await IOUtils.readUTF8(path);
                const key = '"zen-easel":';
                const start = raw.indexOf(key);
                if (start === -1) throw new Error("zen-easel entry not found");
                let open = raw.indexOf("{", start);
                let depth = 0;
                let end = open;
                let inStr = false;
                let esc = false;
                for (;;) {
                    const ch = raw[end];
                    if (inStr) {
                        if (esc) esc = false;
                        else if (ch === "\\") esc = true;
                        else if (ch === '"') inStr = false;
                    } else if (ch === '"') {
                        inStr = true;
                    } else if (ch === "{") {
                        depth++;
                    } else if (ch === "}") {
                        depth--;
                        if (depth === 0) break;
                    }
                    end++;
                }
                const entry = raw.slice(start, end + 1);
                const flipped = entry.replace(/"enabled"\s*:\s*false/, '"enabled":true');
                if (flipped === entry) return true;
                await IOUtils.writeUTF8(path, raw.slice(0, start) + flipped + raw.slice(end + 1));
                return true;
            } catch (e) {
                console.error("[LibraryTweaks] could not enable zen-easel:", e);
                return false;
            }
        }

        _restartBrowser() {
            try {
                Services.startup.quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit);
            } catch (e) {
                try { Services.prompt.alert(window, "Restart needed", "Please restart Zen to apply the change."); } catch (x) { }
            }
        }

        _empty(title, detail) {
            return this.el("div", { className: "empty-state" }, [
                this.el("div", { className: "empty-icon easels-icon" }),
                this.el("h3", { textContent: title }),
                this.el("p", { textContent: detail })
            ]);
        }

        /* ------------------------------------------------------------- actions */

        _closeLibrary() {
            try { window.gZenLibraryBookmarksIntegration?._closeLibraryAfterOpen?.(); } catch (e) { }
            try { window.gZenLibrary?.close?.(); } catch (e) { }
        }

        // Opening is the easel host's job: it owns the one-tab-per-easel rule and
        // knows whether about:easel resolved or the chrome URL fallback is in play.
        _openEasel(easelId) {
            const host = this._host();
            if (!host) return;
            host.openEasel(easelId);
            this._closeLibrary();
        }

        // The "+" card creates a board and opens it. Falls back to creating the
        // document directly if the host predates createEasel, so a mismatched pair
        // of mod versions degrades to a working button rather than a silent one.
        async _newEasel() {
            const host = this._host();
            if (!host) return;

            // Started before the panel closes, but not awaited until after: creating
            // a board is a file write, and holding the library open across it would
            // make the click feel like it had not registered.
            const creating = (async () => {
                if (typeof host.createEasel === "function") return host.createEasel();
                const store = this._store();
                if (!store) throw new Error("the Zen Easel store is not available");
                const { entry } = await store.createDocument("Untitled Easel");
                return host.openEasel(entry.id);
            })();

            this._closeLibrary();

            try {
                await creating;
            } catch (e) {
                console.error("[LibraryTweaks] could not create an easel:", e);
                return;
            }

            // The cached list is stale the moment a board is added.
            await this._reload();
        }

        _host() {
            const host = window.gZenEaselHost;
            if (!host) {
                console.error("[LibraryTweaks] the Zen Easel host is not loaded in this window");
            }
            return host || null;
        }

        _ensureContextMenu() {
            if (document.getElementById("zen-easels-context-menu")) return;
            const popup = document.createXULElement("menupopup");
            popup.id = "zen-easels-context-menu";

            const openItem = document.createXULElement("menuitem");
            openItem.id = "zen-easels-ctx-open";
            openItem.setAttribute("label", "Open");

            const renameItem = document.createXULElement("menuitem");
            renameItem.id = "zen-easels-ctx-rename";
            renameItem.setAttribute("label", "Rename…");

            const deleteItem = document.createXULElement("menuitem");
            deleteItem.id = "zen-easels-ctx-delete";
            deleteItem.setAttribute("label", "Delete");

            popup.appendChild(openItem);
            popup.appendChild(renameItem);
            popup.appendChild(document.createXULElement("menuseparator"));
            popup.appendChild(deleteItem);
            (document.getElementById("mainPopupSet") || document.body).appendChild(popup);
        }

        _contextMenu(e, entry) {
            e.preventDefault();
            const store = this._store();
            if (!store) return;

            this._ensureContextMenu();
            const popup = document.getElementById("zen-easels-context-menu");

            // One popup is shared by every card, so the previous card's handlers have
            // to go before this card's are attached. Cloning each item over itself
            // drops them with the old node.
            for (const id of ["zen-easels-ctx-open", "zen-easels-ctx-rename", "zen-easels-ctx-delete"]) {
                const el = document.getElementById(id);
                if (el) el.replaceWith(el.cloneNode(true));
            }

            const on = (id, handler) => {
                document.getElementById(id).addEventListener("command", async () => {
                    try { await handler(); } catch (err) { console.error("[LibraryTweaks]", err); }
                });
            };

            on("zen-easels-ctx-open", () => this._openEasel(entry.id));

            on("zen-easels-ctx-rename", async () => {
                const current = entry.title || "Untitled Easel";
                const value = { value: current };
                const ok = Services.prompt.prompt(window, "Rename easel", "New name:", value, null, { value: false });
                const title = ok ? value.value.trim() : "";
                // A name that came back unchanged is not worth an index write and a
                // full re-render of the grid.
                if (!title || title === current) return;
                await store.renameEasel(entry.id, title);
                await this._reload();
            });

            on("zen-easels-ctx-delete", async () => {
                const confirmed = Services.prompt.confirm(
                    window, "Delete easel",
                    `Delete "${entry.title || "Untitled Easel"}" and everything on it? This cannot be undone.`
                );
                if (!confirmed) return;
                await store.removeEasel(entry.id);

                this._easels = this._easels.filter(e => e.id !== entry.id);
                const grid = this._grid;
                const card = grid?.querySelector(`.easel-card[data-id="${CSS.escape(entry.id)}"]`);
                if (!card) {
                    await this._reload();
                    return;
                }
                const siblings = [...grid.querySelectorAll(".easel-card")].filter(n => n !== card);
                await this._animateCardRemove(card, siblings);
                if (grid.isConnected && !grid.querySelector(".easel-card:not(.easel-card-new)")) {
                    // Branch on the search term like render() does, or the last match
                    // deleted reads as "no easels at all".
                    const term = (this._searchTerm || "").trim();
                    grid.appendChild(this._empty(
                        term ? "No easels match" : "No easels yet",
                        term ? "Try a different search." : "Press Ctrl+Shift+E to start one."
                    ));
                }
            });

            popup.openPopupAtScreen(e.screenX, e.screenY, true);
        }

        async _animateCardRemove(card, siblings) {
            try {
                if (window.ZenLibraryUtil?.animateCardRemove) {
                    await window.ZenLibraryUtil.animateCardRemove(card, { siblings });
                    return;
                }
            } catch (e) { }
            try {
                card.style.transition = "opacity 150ms ease, transform 150ms ease";
                card.style.opacity = "0";
                card.style.transform = "scale(0.96)";
                await new Promise(resolve => window.setTimeout(resolve, 160));
            } catch (e) { }
            try { card.remove(); } catch (e) { }
        }

        destroy() {
            // The popup lives in mainPopupSet, outside anything the library tears down
            // itself, so it has to be removed by hand or a reload leaves one behind.
            document.getElementById("zen-easels-context-menu")?.remove();
            this._grid = null;
        }
    }

    window.ZenLibraryEasels = ZenLibraryEasels;

    /* ------------------------------------------------- native section wiring */

    class ZenLibraryEaselsSectionElement extends HTMLElement {
        constructor() {
            super();
            this._mounted = false;
            this._library = null;
        }
        set library(value) { this._library = value; }
        get library() { return this._library; }
        connectedCallback() {
            if (this._mounted) return;
            this._mounted = true;
            try { this.classList.add("zen-library-section"); } catch (e) { }
            try { this.dataset.section = "easels"; } catch (e) { }
            const integration = window.gZenLibraryBookmarksIntegration;
            const module = integration?._ensureEaselsModule?.();
            if (!module) {
                this.replaceChildren(document.createTextNode("Easels unavailable"));
                return;
            }
            try {
                module.library = integration._nativeModuleShell(this);
                this.replaceChildren();
                let header = null;
                try { header = module.renderHeaderControls(); }
                catch (e) { console.error("[LibraryTweaks] easels header failed:", e); }
                if (header) this.appendChild(header);
                let grid = null;
                try { grid = module.render(); }
                catch (e) { console.error("[LibraryTweaks] easels grid failed:", e); }
                if (grid) this.appendChild(grid);
            } catch (e) {
                console.error("[LibraryTweaks] easels native mount failed:", e);
            }
        }
    }

    if (!customElements.get("zen-library-easels-section")) {
        try {
            customElements.define("zen-library-easels-section", ZenLibraryEaselsSectionElement);
        } catch (e) {
            console.error("[LibraryTweaks] failed to define easels section element:", e);
        }
    }

    class ZenLibraryEaselsSection {
        static render(library) {
            let html = null;
            try { html = window.gZenLibraryBookmarksIntegration?._nativeHtml?.(); } catch (e) { }
            if (html) {
                return html`<zen-library-easels-section class="zen-library-section" data-section="easels" .library=${library}></zen-library-easels-section>`;
            }
            const el = document.createElement("zen-library-easels-section");
            try { el.library = library; } catch (e) { }
            return el;
        }
    }
    ZenLibraryEaselsSection.id = "easels";
    // No upstream Fluent string exists; the sidebar label is patched to text.
    ZenLibraryEaselsSection.label = "library-easels-section-title";
    window.ZenLibraryEaselsSection = ZenLibraryEaselsSection;

    /* --------------------------------------- integration feature mixin */

    const EaselsIntegration = {
        _isEaselsEnabled() {
            try {
                return Services.prefs.getBoolPref(EASELS_PREF, true);
            } catch (e) {
                return true;
            }
        },

        _watchEaselsPref() {
            if (this._easelsPrefObserver) return;
            this._easelsPrefObserver = {
                observe: () => this._onEaselsPrefChanged(),
            };
            try {
                Services.prefs.addObserver(EASELS_PREF, this._easelsPrefObserver);
            } catch (e) {
                this._easelsPrefObserver = null;
            }
        },

        _unwatchEaselsPref() {
            if (!this._easelsPrefObserver) return;
            try { Services.prefs.removeObserver(EASELS_PREF, this._easelsPrefObserver); } catch (e) { }
            this._easelsPrefObserver = null;
        },

        // Called from the shared init() and once at file load (this file loads
        // after saves.uc.js, so a normal boot reaches here with init() done).
        _easelsInit() {
            try { this._watchEaselsPref(); } catch (e) { }
            if (!this._isEaselsEnabled()) return;
            if (!this._initialized) {
                try { this.init(); } catch (e) { }
                return;
            }
            try { this._registerNativeWhenReady(); } catch (e) { }
            try { this._connectExistingNativeLibraries(); } catch (e) { }
        },

        _onEaselsPrefChanged() {
            if (this._isEaselsEnabled()) {
                if (!this._initialized) {
                    try { this.init(); } catch (e) { }
                    return;
                }
                try { this._registerNativeWhenReady(); } catch (e) { }
                try { this._connectExistingNativeLibraries(); } catch (e) { }
                return;
            }
            try { this._easelsUnregister(); } catch (e) { }
            if (!this._anyFeatureEnabled?.()) {
                try { this._unregisterAllSections(); } catch (e) { }
                try { this._shutdown(); } catch (e) { }
            }
        },

        _ensureEaselsModule() {
            if (this._easelsModule) return this._easelsModule;
            try {
                this._easelsModule = new ZenLibraryEasels(this._moduleShell());
                try {
                    const warming = this._easelsModule.init?.();
                    warming?.catch?.(() => { });
                } catch (e) { }
            } catch (e) {
                console.error("[LibraryTweaks] failed to initialize easels module:", e);
            }
            return this._easelsModule;
        },

        _easelsRegister(host) {
            if (!host || !this._isEaselsEnabled?.()) return false;
            if (!customElements.get("zen-library-easels-section")) return false;
            const sections = host.zenLibrarySections;
            if (!sections || typeof sections !== "object") return false;
            let changed = false;
            if (sections.easels !== window.ZenLibraryEaselsSection) {
                sections.easels = window.ZenLibraryEaselsSection;
                changed = true;
            }
            try { if (this._sanitizeNativeTab?.(host)) changed = true; } catch (e) { }
            try { this._easelsTabPatch(host); } catch (e) { }
            try {
                const root = this._nativeRoot?.(host);
                if (root) this._ensureEaselsStyles(root);
            } catch (e) { }
            if (changed) {
                try { host.requestUpdate?.(); } catch (e) { }
            }
            return true;
        },

        _easelsUnregister() {
            for (const host of Array.from(this._nativeHostObservers?.keys?.() || [])) {
                try {
                    const sections = host?.zenLibrarySections;
                    if (sections?.easels && sections.easels === window.ZenLibraryEaselsSection) {
                        delete sections.easels;
                    }
                    if (host?.activeTab === "easels") host.activeTab = "history";
                } catch (e) { }
                try { host?.requestUpdate?.(); } catch (e) { }
            }
            try { this._easelsModule?.destroy?.(); } catch (e) { }
            this._easelsModule = null;
        },

        // Sidebar label + the reference folder-pane glyph. Lit skips rewriting
        // unchanged bindings, so removing data-l10n-id sticks.
        _easelsTabPatch(host) {
            let root = null;
            try { root = this._nativeRoot?.(host); } catch (e) { }
            const tab = root?.querySelector?.('.zen-library-tab[data-section="easels"]');
            if (!tab) return false;
            const label = tab.querySelector?.("label");
            if (!label) return false;
            let touched = false;
            if (label.textContent !== "Easels") {
                label.textContent = "Easels";
                touched = true;
            }
            if (label.hasAttribute("data-l10n-id")) {
                label.removeAttribute("data-l10n-id");
                touched = true;
            }
            const iconBox = tab.querySelector?.(".zen-library-tab-icon");
            if (iconBox && !iconBox.querySelector(".zen-easels-icon")) {
                const icon = this._easelsTabIcon();
                if (icon) iconBox.replaceChildren(icon);
            }
            return touched;
        },

        _easelsTabIcon() {
            try {
                const parser = new DOMParser();
                const doc = parser.parseFromString(this._easelsIconSvg(), "image/svg+xml");
                const node = doc.documentElement;
                if (!node || node.localName !== "svg") return null;
                node.removeAttribute("xmlns");
                return node;
            } catch (e) {
                return null;
            }
        },

        _easelsIconSvg() {
            return `
<svg class="zen-easels-icon" width="28" height="28" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient gradientUnits="userSpaceOnUse" x1="64" y1="10" x2="64" y2="138" id="zen-easels-grad-front">
      <stop offset="0" style="stop-color: rgb(255, 255, 255)"/>
      <stop offset="1" style="stop-color: rgb(0, 0, 0)"/>
    </linearGradient>
    <mask id="zen-easels-mask">
      <rect x="-10" y="-10" width="148" height="148" fill="white" />
      <g class="zen-easels-inner-pane" style="transform-origin: 64px 71.28px;">
        <rect x="16.16" y="36.04" width="95.68" height="70.48" rx="8" fill="black" />
      </g>
    </mask>
  </defs>
  <g class="zen-easels-bounce" style="transform-origin: 64px 64px;">
    <g class="zen-easels-outer-frame" mask="url(#zen-easels-mask)">
      <rect class="zen-easels-frame-fill" x="8" y="12.76" width="112" height="102.48" rx="12"
            style="fill: var(--zen-folder-stroke);" />
    </g>
    <g class="zen-easels-inner-pane" style="transform-origin: 64px 71.28px;">
      <rect class="zen-easels-bg" x="16.16" y="36.04" width="95.68" height="70.48" rx="8"
            style="fill: var(--zen-folder-front-bgcolor); fill-opacity: 0;" />
      <rect class="zen-easels-gradient" x="16.16" y="36.04" width="95.68" height="70.48" rx="8"
            style="fill: url(#zen-easels-grad-front); fill-opacity: 0;" />
    </g>
    <g class="zen-easels-squiggle" style="transform-origin: 64px 71.28px; transform: scale(0.82);">
      <path d="M 79.08 42.08 C 91.19 54.79 88.45 58.62 81.98 56.04 C 75.51 53.47 66.12 44.54 59.62 47.55 C 53.12 50.56 91.47 84.24 77.76 86.61 C 72.57 87.51 43.87 53.27 34.03 56.04 C 23.75 58.94 58.53 84.24 60.64 100.31"
            style="fill: none; stroke: var(--zen-folder-stroke); stroke-width: 7.1px; stroke-linecap: round; stroke-linejoin: round;" />
    </g>
  </g>
</svg>`;
        },

        _ensureEaselsStyles(root) {
            if (!root?.querySelector) return;
            const css = `
/* Easel cards, ported from the reference section. The grid is static (not
   absolute) so it lives inside the flex column section element. */
zen-library-easels-section {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
zen-library-easels-section .easel-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  flex: 1;
  min-height: 0;
  gap: 18px;
  padding: 12px 18px 12px 18px;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, currentColor, transparent 50%) transparent;
  /* The open panel is window-draggable; without this the scrollbar drags it. */
  -moz-window-dragging: no-drag;
}
zen-library-easels-section .easel-card-grid > .empty-state {
  grid-column: 1 / -1;
}
zen-library-easels-section .easel-card {
  --easel-card-radius: var(--border-radius-medium, 8px);
  --easel-card-pad: 12px;
  --easel-card-frame: 4px;
  position: relative;
  aspect-ratio: 1;
  overflow: visible;
  display: flex;
  padding: var(--easel-card-pad);
  border: none;
  border-radius: var(--easel-card-radius);
  background: var(--zen-toolbar-element-bg, var(--zen-library-hover-bg, rgba(128, 128, 128, 0.14)));
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  -moz-window-dragging: no-drag;
}
zen-library-easels-section .easel-card-frame {
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
  padding: var(--easel-card-frame);
  border-radius: calc(var(--easel-card-radius) - 2px);
  background: light-dark(#ffffff, #3c3c3c);
  box-sizing: border-box;
}
zen-library-easels-section .easel-card-body {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: flex-start;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 14px 14px 12px;
  border-radius: calc(var(--easel-card-radius) - 5px);
  background: light-dark(#e8e8e8, #2a2a2a);
  box-sizing: border-box;
  overflow: hidden;
}
zen-library-easels-section .easel-card:hover:not(.easel-card-new) .easel-card-body {
  background: light-dark(#dedede, #323232);
}
zen-library-easels-section .easel-card:focus-visible {
  outline: 2px solid var(--zen-primary-color);
  outline-offset: 1px;
}
zen-library-easels-section .easel-card::-moz-focus-inner {
  border: 0;
  padding: 0;
}
zen-library-easels-section .easel-card-count {
  position: absolute;
  top: 12px;
  right: 14px;
  font-size: 12px;
  font-weight: 500;
  opacity: 0.5;
  line-height: 1;
}
zen-library-easels-section .easel-card-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding-right: 28px;
}
zen-library-easels-section .easel-card-mark {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  color: var(--zen-folder-stroke, var(--zen-primary-color, currentColor));
}
zen-library-easels-section .easel-card-squiggle {
  display: block;
  width: 100%;
  height: 100%;
}
zen-library-easels-section .easel-card-title {
  width: 100%;
  min-width: 0;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
zen-library-easels-section .easel-card-new {
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: 2px dashed color-mix(in srgb, currentColor 50%, transparent);
  box-sizing: border-box;
  line-height: 1;
}
zen-library-easels-section .easel-card-new::before {
  content: "+";
  font-size: 32px;
  font-weight: 300;
  line-height: 1;
  translate: 0 -0.08em;
  color: color-mix(in srgb, currentColor 55%, transparent);
  transition: color 0.15s var(--zen-library-easing, ease);
}
zen-library-easels-section .easel-card-new:hover {
  border-color: color-mix(in srgb, currentColor 70%, transparent);
}
zen-library-easels-section .easel-card-new:hover::before {
  content: "New easel";
  font-size: 13px;
  font-weight: 600;
  translate: 0;
  color: color-mix(in srgb, currentColor 85%, transparent);
}
/* Empty states share the ported base; there is no mask asset for the easels
   glyph, so the icon box stays hidden like the reference section. */
zen-library-easels-section .empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  padding: 20px;
  gap: 10px;
  box-sizing: border-box;
}
zen-library-easels-section .empty-state h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  opacity: 0.9;
}
zen-library-easels-section .empty-state p {
  margin: 0;
  font-size: 13px;
  opacity: 0.6;
  max-width: 250px;
}
zen-library-easels-section .empty-state .empty-icon {
  display: none;
}
/* Missing-easel install card: hero squiggle, accent button, quiet note. */
zen-library-easels-section .easel-install-mark {
  width: 56px;
  height: 56px;
  margin-bottom: 2px;
  color: var(--zen-folder-stroke, var(--zen-primary-color, currentColor));
  opacity: 0.9;
}
zen-library-easels-section .easel-install-button {
  appearance: none;
  border: 0;
  cursor: pointer;
  margin-top: 4px;
  padding: 9px 18px;
  border-radius: 12px;
  background: var(--zen-primary-color, #0060df);
  color: white;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
}
zen-library-easels-section .easel-install-button:hover {
  filter: brightness(1.1);
}
zen-library-easels-section .easel-install-note {
  font-size: 11px;
  opacity: 0.55;
  max-width: 230px;
}
@keyframes zenEaselsBounce {
  0% {
    transform: translateY(0px) rotate(0deg);
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
  }
  24.41% { /* Dip */
    transform: translateY(3px) rotate(0deg);
    animation-timing-function: cubic-bezier(0.4, 0, 0.64, 1);
  }
  55.88% { /* Launch and tilt */
    transform: translateY(-12px) rotate(6deg);
    animation-timing-function: cubic-bezier(0.25, 0, 0.75, 1);
  }
  88.24% {
    transform: translateY(0px) rotate(0deg);
    animation-timing-function: linear;
  }
  100% {
    transform: translateY(0px) rotate(0deg);
  }
}

@keyframes zenEaselsSquiggle {
  0% {
    transform: scale(0.82);
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
  }
  22% { /* Beat one */
    transform: scale(0.94);
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
  }
  40% {
    transform: scale(0.8);
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
  }
  58% { /* Beat two */
    transform: scale(0.9);
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
  }
  80%, 100% {
    transform: scale(0.82);
  }
}
/* Reference sidebar glyph: sprite box hidden, injected SVG in its place. The
   inner pane fills when selected, exactly like the reference section. */
.zen-library-tab[data-section="easels"] .zen-library-tab-icon-image {
  display: none;
}
.zen-library-tab[data-section="easels"] .zen-easels-icon {
  width: 28px;
  height: 28px;
  display: block;
}
.zen-library-tab[data-section="easels"][active] .zen-easels-bg {
  fill: var(--zen-folder-front-bgcolor) !important;
  fill-opacity: 1 !important;
}
.zen-library-tab[data-section="easels"][active] .zen-easels-gradient {
  fill-opacity: 0.1 !important;
}
@media (prefers-reduced-motion: no-preference) {
  :is(.zen-library-tab[data-section="easels"][active],
      .zen-library-tab[data-section="easels"][animate]) .zen-easels-bounce {
    animation: zenEaselsBounce 0.583s forwards;
  }
  :is(.zen-library-tab[data-section="easels"][active],
      .zen-library-tab[data-section="easels"][animate]) .zen-easels-squiggle {
    animation: zenEaselsSquiggle 0.583s forwards;
  }
}
`;
            const existing = root.querySelector(":scope > #zen-easels-native-style") ||
                root.querySelector("#zen-easels-native-style");
            if (existing) {
                if (existing.textContent !== css) existing.textContent = css;
                return;
            }
            const style = document.createElement("style");
            style.id = "zen-easels-native-style";
            style.textContent = css;
            try { root.appendChild(style); } catch (e) { }
        },
    };

    // Global attach so a saves-only Sine reload (which rebuilds the integration
    // without re-running this file) still picks the easels half back up: the
    // saves script calls this for every fresh integration.
    window._libraryTweaksAttachEasels = (integration) => {
        if (!integration) return;
        Object.assign(integration, EaselsIntegration);
        try { integration._easelsInit?.(); } catch (e) { }
    };

    try {
        window._libraryTweaksAttachEasels(window.gZenLibraryBookmarksIntegration);
    } catch (e) { }
})();
