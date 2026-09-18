"use strict";

(function () {
    class ZenLibraryBookmarks {
        constructor(library) {
            this.library = library;
            this._container = null;
            this._items = [];
            this._searchTerm = "";
            this._openFolders = new Set();
            this._searchDebounce = null;
            this._placesListener = null;
            this._placesTimer = null;
            this._activeTags = new Set();
            this._activeSpace = "all";
            this._filtersOpen = false;
            this._knownTags = [];
            this._headerEls = null;
            this._chipEls = [];
            this._draggedNode = null;
            this._folderHoverTimer = null;
            this._lastDragAt = 0;
            this._lastSelfMutateAt = 0;
            this._addedListener = null;
            this._libraryDropNodes = new Set();
            this._libraryDropObserver = null;
            this._tabDropBadge = null;
            this._smartSaveTooltipTimer = null;
            this._rootFolderGuid = null;
        }

        static ROOT_PREF = "zen.bookmarks.rootGuid";

        static PLACES_EVENTS = ["bookmark-added", "bookmark-removed", "bookmark-moved", "bookmark-title-changed", "bookmark-url-changed", "bookmark-tags-changed"];

        get el() { return this.library.el.bind(this.library); }

        _placesObservers() {
            try {
                return globalThis.PlacesObservers || ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils.observers;
            } catch (e) { return null; }
        }

        init() {
            this._watchPlaces();
            this._watchAdded();
            this._watchLibraryDrop();
        }

        _markSelfMutating() {
            this._lastSelfMutateAt = Date.now();
        }

        // Fires the save animation + toast for bookmarks created outside the
        // Library (e.g. the site-data panel). Library-internal creates/moves
        // set _lastSelfMutateAt/_lastDragAt first, so they are skipped here.
        _watchAdded() {
            const observers = this._placesObservers();
            if (this._addedListener || !observers) return;
            this._addedListener = (events) => {
                try {
                    for (const ev of events || []) {
                        if (ev?.type !== "bookmark-added") continue;
                        const guid = ev.guid || ev.bookmarkGuid;
                        if (!guid) continue;
                        if (Date.now() - this._lastSelfMutateAt < 1200) continue;
                        if (Date.now() - this._lastDragAt < 1200) continue;
                        this._onExternalBookmarkAdded(guid);
                    }
                } catch (e) { }
            };
            try { observers.addListener(["bookmark-added"], this._addedListener); } catch (e) { this._addedListener = null; }
        }

        _unwatchAdded() {
            if (!this._addedListener) return;
            try { this._placesObservers()?.removeListener(["bookmark-added"], this._addedListener); } catch (e) { }
            this._addedListener = null;
        }

        _clearSmartSaveTooltip() {
            clearTimeout(this._smartSaveTooltipTimer);
            this._smartSaveTooltipTimer = null;
            try { document.getElementById("zen-bookmarks-save-tooltip-container")?.remove?.(); } catch (e) { }
        }

        _watchPlaces() {
            const observers = this._placesObservers();
            if (this._placesListener || !observers) return;
            this._placesListener = () => {
                // Drag/drop and Library-internal mutations re-render explicitly;
                // skip the debounced echo so the list does not rebuild twice.
                if (Date.now() - this._lastDragAt < 800) return;
                if (Date.now() - this._lastSelfMutateAt < 800) return;
                clearTimeout(this._placesTimer);
                this._placesTimer = setTimeout(() => {
                    this._placesTimer = null;
                    if (this._container?.isConnected) this.renderList();
                }, 250);
            };
            try { observers.addListener(ZenLibraryBookmarks.PLACES_EVENTS, this._placesListener); } catch (e) { this._placesListener = null; }
        }

        _unwatchPlaces() {
            clearTimeout(this._placesTimer);
            this._placesTimer = null;
            if (!this._placesListener) return;
            try { this._placesObservers()?.removeListener(["bookmark-added"], this._placesListener); } catch (e) { }
            this._placesListener = null;
        }

        static TAB_DROP_TYPES = [
            "application/x-moz-tabbrowser-tab",
            "application/x-moz-tab",
            "text/tab",
            "text/x-moz-url",
            "text/uri-list"
        ];

        // Dragging browser tabs onto the library button silently bookmarks
        // them into the toolbar. Kept in this module (not the controller) so
        // insert/pulse/toast/render stay in one place; the MutationObserver
        // re-binds after CustomizableUI rebuilds, like the downloads buttons.
        _watchLibraryDrop() {
            this._unwatchLibraryDrop();
            this._onLibraryDragEnd = () => this._hideTabDropBadge();
            try { window.addEventListener("dragend", this._onLibraryDragEnd, true); } catch (e) { }
            // Same-window tab/group drags: snapshot the payload at dragstart.
            // dataTransfer tab flavors are unreliable mid-flight, and a group
            // header carries no URL at all — the snapshot does.
            this._onTabDragStart = (event) => {
                try {
                    const target = event.target?.closest?.("tab") || event.target?.closest?.("tab-group") || null;
                    if (target) {
                        const tabs = this._tabsFromDragNode(target);
                        if (tabs.length) {
                            window._zenLibraryPendingTabDrop = { tabs, at: Date.now() };
                            return;
                        }
                    }
                    // Unknown tab element or flavor: any tab-ish flavor still
                    // snapshots the live selection.
                    if (!ZenLibraryBookmarks._hasTabFlavor(event.dataTransfer?.types)) return;
                    const sel = window.gBrowser?.selectedTabs?.length ? Array.from(window.gBrowser.selectedTabs) : [];
                    const tabs = [];
                    for (const tab of sel) {
                        const info = this._tabInfo(tab);
                        if (info) tabs.push(info);
                    }
                    if (tabs.length) {
                        window._zenLibraryPendingTabDrop = { tabs, at: Date.now() };
                    }
                } catch (e) { }
            };
            try { window.addEventListener("dragstart", this._onTabDragStart, true); } catch (e) { }
            this._libraryDropObserver = new MutationObserver(() => this._bindLibraryDropButton());
            try { this._libraryDropObserver.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { }
            this._bindLibraryDropButton();
        }

        _unwatchLibraryDrop() {
            try { this._libraryDropObserver?.disconnect(); } catch (e) { }
            this._libraryDropObserver = null;
            try { window.removeEventListener("dragend", this._onLibraryDragEnd, true); } catch (e) { }
            this._onLibraryDragEnd = null;
            try { window.removeEventListener("dragstart", this._onTabDragStart, true); } catch (e) { }
            this._onTabDragStart = null;
            for (const node of this._libraryDropNodes) {
                try {
                    node.removeEventListener("dragenter", this._onLibraryDropEnter, true);
                    node.removeEventListener("dragover", this._onLibraryDropOver, true);
                    node.removeEventListener("dragleave", this._onLibraryDropLeave, true);
                    node.removeEventListener("drop", this._onLibraryTabDrop, true);
                } catch (e) { }
            }
            this._libraryDropNodes.clear();
            this._hideTabDropBadge();
        }

        _bindLibraryDropButton() {
            if (!this._onLibraryDropEnter) {
                this._onLibraryDropEnter = (e) => this._handleLibraryDropHover(e, true);
                this._onLibraryDropOver = (e) => this._handleLibraryDropHover(e, false);
                this._onLibraryDropLeave = (e) => {
                    const btn = e.currentTarget;
                    if (btn?.contains?.(e.relatedTarget)) return;
                    this._hideTabDropBadge();
                };
                this._onLibraryTabDrop = (e) => this._dropTabsOnLibrary(e);
            }
            const node = document.getElementById("zen-library-button");
            if (!node || this._libraryDropNodes.has(node)) return;
            node.addEventListener("dragenter", this._onLibraryDropEnter, true);
            node.addEventListener("dragover", this._onLibraryDropOver, true);
            node.addEventListener("dragleave", this._onLibraryDropLeave, true);
            node.addEventListener("drop", this._onLibraryTabDrop, true);
            this._libraryDropNodes.add(node);
        }

        _isTabDrop(event) {
            try { return ZenLibraryBookmarks._hasTabFlavor(event.dataTransfer?.types); }
            catch (e) { return false; }
        }

        // Exact list first, then any flavor with "tab" in the name — Zen
        // renames these across builds, so never rely on one literal.
        static _hasTabFlavor(types) {
            try {
                const list = Array.from(types || []);
                if (ZenLibraryBookmarks.TAB_DROP_TYPES.some(t => list.includes(t))) return true;
                return list.some(t => typeof t === "string" && t.toLowerCase().includes("tab"));
            } catch (e) { return false; }
        }

        // One tab's bookmark payload, or null when unusable.
        _tabInfo(tab) {
            try {
                const url = tab?.linkedBrowser?.currentURI?.spec || "";
                if (!url || url === "about:blank") return null;
                let title = url;
                try { title = tab.label || url; } catch (e) { }
                let icon = "";
                try { icon = tab.image || ""; } catch (e) { }
                return { url, title, icon };
            } catch (e) { return null; }
        }

        _handleLibraryDropHover(event, isEnter) {
            if (!this._isTabDrop(event)) return;
            event.preventDefault();
            try { event.dataTransfer.dropEffect = "link"; } catch (e) { }
            const btn = event.currentTarget;
            if (isEnter && btn && !btn.classList.contains("tabdrop-hover")) {
                btn.classList.add("tabdrop-hover");
                try { this._pulseLibraryButton(); } catch (e) { }
            }
            if (!this._tabDropBadge) {
                this._showTabDropBadge(btn, event);
            }
        }

        // Single tab, whole selection, or every tab inside a dragged
        // group/folder element. Shared by the dragstart snapshot and the drop.
        // First source of truth is how Zen itself knows: the dragged node
        // carries the whole moving set at `_dragData.movingTabs` (group labels
        // arrive expanded to sub-tabs, like native's own drop handling).
        _tabsFromDragNode(node) {
            const out = [];
            const seen = new Set();
            const pushTab = (tab) => {
                const info = this._tabInfo(tab);
                if (info && !seen.has(info.url)) {
                    seen.add(info.url);
                    out.push(info);
                }
            };
            // A group label/element expands to member tabs; anything else is
            // ignored (labels have no URL of their own).
            const expand = (item, allowDescendants) => {
                if (!item) return;
                if (item.linkedBrowser || item.localName === "tab") {
                    pushTab(item);
                    return;
                }
                try {
                    const g = item.group;
                    if (g && Array.isArray(g.tabs) && g.tabs.length) {
                        g.tabs.forEach(pushTab);
                        return;
                    }
                } catch (e) { }
                try {
                    if (Array.isArray(item.tabs) && item.tabs.length) {
                        item.tabs.forEach(pushTab);
                        return;
                    }
                } catch (e) { }
                if (!allowDescendants) return;
                try {
                    if (typeof item.querySelectorAll === "function") {
                        Array.from(item.querySelectorAll("tab") || []).forEach(pushTab);
                    }
                } catch (e) { }
            };
            const groupish = (el) => {
                try {
                    if (Array.isArray(el?.tabs)) return true;
                    if (el?.group) return true;
                    let cls = "";
                    try {
                        cls = typeof el.className === "string" ? el.className : (el.className?.baseVal || "");
                    } catch (e) { }
                    const name = `${el?.localName || ""} ${cls}`.toLowerCase();
                    return name.includes("group") || name.includes("folder");
                } catch (e) { return false; }
            };
            try {
                if (!node) return out;
                // 0. Native/Zen drag state on the dragged node itself.
                let dragCount = -1;
                try {
                    const moving = node._dragData?.movingTabs;
                    if (moving?.length) {
                        dragCount = moving.length;
                        Array.from(moving).forEach(item => expand(item, true));
                        if (out.length) return out;
                    } else {
                        dragCount = 0;
                    }
                } catch (e) { }
                if (node.linkedBrowser || node.localName === "tab") {
                    // Fallback: whatever selection the source window holds is
                    // what a tab drag moves — selectedTabs plus any tab
                    // carrying the multiselected attribute. No identity check:
                    // cross-compartment wrappers defeat includes().
                    const list = [];
                    const consider = (tab) => {
                        try {
                            const url = tab?.linkedBrowser?.currentURI?.spec || "";
                            if (!url || url === "about:blank") return;
                            list.push(tab);
                        } catch (e) { }
                    };
                    let selCount = -1;
                    let multiCount = -1;
                    try {
                        const gb = node.ownerGlobal?.gBrowser;
                        if (gb?.selectedTabs?.length) {
                            selCount = gb.selectedTabs.length;
                            Array.from(gb.selectedTabs).forEach(consider);
                        } else {
                            selCount = 0;
                        }
                        try {
                            const multi = gb?.tabContainer?.querySelectorAll?.("tab[multiselected]");
                            multiCount = multi?.length ?? 0;
                            if (multi?.length) Array.from(multi).forEach(consider);
                        } catch (e) { }
                    } catch (e) { }
                    consider(node);
                    list.forEach(pushTab);
                    return out;
                }
                // Group/folder header outside a drag: descendants only for
                // group-like containers (never the whole strip).
                if (groupish(node)) expand(node, true);
            } catch (e) { }
            return out;
        }

        _extractDroppedTabs(event) {
            const tabs = [];
            const dt = event?.dataTransfer;
            if (!dt) return tabs;
            // 1. Same-window snapshot from dragstart: exact tabs, exact
            // selection, groups already expanded. Only trusted when the drop
            // actually carries a tab flavor (never for plain link drops).
            try {
                const hasTabFlavor = ZenLibraryBookmarks._hasTabFlavor(dt.types);
                const pending = window._zenLibraryPendingTabDrop;
                if (hasTabFlavor && pending?.tabs?.length && Date.now() - pending.at < 10000) {
                    return pending.tabs.filter(t => t?.url && t.url !== "about:blank");
                }
            } catch (e) { }
            // 2. Live tab/group objects (cross-window drags): try every flavor
            // present — the payload may sit under a build-specific type name.
            try {
                let found = [];
                if (typeof dt.mozGetDataAt === "function") {
                    const list = Array.from(dt.types || []);
                    for (const t of list) {
                        if (typeof t !== "string") continue;
                        if (t === "text" || t.startsWith("text/")) continue;
                        let raw = null;
                        try { raw = dt.mozGetDataAt(t, 0); } catch (e) { continue; }
                        if (!raw || typeof raw !== "object") continue;
                        if (raw.nodeType !== Node.ELEMENT_NODE && !raw.linkedBrowser && !Array.isArray(raw.tabs)) continue;
                        found = this._tabsFromDragNode(raw);
                        if (found.length) break;
                    }
                }
                if (found.length) return found;
            } catch (e) { }
            // Links / cross-window tab drags: URL + title lines.
            const read = (type) => {
                try { return dt.getData(type) || ""; } catch (e) { return ""; }
            };
            let url = "";
            let title = "";
            const mozUrl = read("text/x-moz-url");
            if (mozUrl) {
                const parts = mozUrl.split("\n");
                url = (parts[0] || "").trim();
                title = (parts[1] || "").trim() || url;
            }
            if (!url) {
                const uriList = read("text/uri-list");
                if (uriList) {
                    url = (uriList.split("\n").find(line => line && !line.startsWith("#")) || "").trim();
                    title = url;
                }
            }
            if (!url) {
                const plain = read("text/plain");
                if (plain) {
                    url = plain.trim().split("\n")[0].trim();
                    title = url;
                }
            }
            if (!url || url === "about:blank") return tabs;
            try { Services.io.newURI(url); }
            catch (e) { return tabs; }
            tabs.push({ url, title: title || url, icon: `page-icon:${url}` });
            return tabs;
        }

        _showTabDropBadge(btn, event) {
            try {
                this._hideTabDropBadge();
                const rect = btn?.getBoundingClientRect?.();
                if (!rect || rect.width <= 0) return;
                // Exact payload when known (dragstart snapshot), else live
                // selection favicons, else a single generic glyph.
                let tabs = [];
                try {
                    const pending = window._zenLibraryPendingTabDrop;
                    if (pending?.tabs?.length && Date.now() - pending.at < 10000) tabs = pending.tabs;
                } catch (e) { }
                if (!tabs.length) {
                    try {
                        const srcWin = window.gBrowser ? window : Services.wm.getMostRecentWindow("navigator:browser");
                        const selected = srcWin?.gBrowser?.selectedTabs?.length
                            ? Array.from(srcWin.gBrowser.selectedTabs).slice(0, 4)
                            : [];
                        tabs = selected.map(tab => {
                            let icon = "";
                            try { icon = tab.image || ""; } catch (e) { }
                            return { icon };
                        }).filter(t => t.icon);
                    } catch (e) { tabs = []; }
                }
                const badge = document.createElement("div");
                badge.className = "zen-tabdrop-badge";
                badge.setAttribute("role", "presentation");
                badge.setAttribute("aria-hidden", "true");
                badge.style.left = `${rect.left}px`;
                badge.style.top = `${rect.top}px`;
                badge.style.width = `${rect.width}px`;
                badge.style.height = `${rect.height}px`;
                const show = tabs.length ? tabs.slice(0, 3) : [{ icon: "chrome://browser/skin/bookmark.svg" }];
                show.forEach((t, i) => badge.appendChild(this._miniArcGhost(t.icon, i)));
                if (tabs.length > 3) {
                    const more = document.createElement("div");
                    more.className = "zen-tabdrop-badge-more";
                    more.textContent = `+${tabs.length - 3}`;
                    badge.appendChild(more);
                }
                document.body.appendChild(badge);
                this._tabDropBadge = badge;
            } catch (e) { }
        }

        // One badge icon: a smaller copy of the arc ghost (hover-bg ring,
        // adaptive white/black disc, page favicon). Container is unchanged.
        _miniArcGhost(iconSrc, index) {
            const size = 32;
            const ghost = document.createElement("div");
            ghost.style.cssText = [
                "flex:0 0 auto",
                `width:${size}px`,
                `height:${size}px`,
                "margin:0",
                "padding:2px",
                "pointer-events:none",
                "display:flex",
                "align-items:center",
                "justify-content:center",
                "border-radius:50%",
                "box-sizing:border-box",
                "background-color:var(--zen-colors-hover-bg)",
                "box-shadow:var(--zen-big-shadow)"
            ].join(";") + `;margin:${index * 6}px 0 0 ${index === 0 ? 0 : -14}px;`;
            const inner = document.createElement("div");
            inner.style.cssText = [
                "position:relative",
                "width:100%",
                "height:100%",
                "border-radius:50%",
                "background-color:#fff",
                "display:flex",
                "align-items:center",
                "justify-content:center",
                "pointer-events:none"
            ].join(";");
            const icon = document.createElement("img");
            icon.alt = "";
            icon.style.cssText = "width:70%;height:70%;flex:0 0 auto;pointer-events:none;";
            icon.addEventListener("error", () => {
                if (icon.src !== "chrome://browser/skin/bookmark.svg") {
                    icon.src = "chrome://browser/skin/bookmark.svg";
                }
            }, { once: true });
            icon.src = iconSrc;
            inner.appendChild(icon);
            ghost.appendChild(inner);
            try {
                this._sampleDiscColor(iconSrc, (color) => {
                    try { if (ghost.isConnected) inner.style.backgroundColor = color; } catch (e) { }
                });
            } catch (e) { }
            return ghost;
        }

        _hideTabDropBadge() {
            try { this._tabDropBadge?.remove?.(); } catch (e) { }
            this._tabDropBadge = null;
            try {
                for (const node of this._libraryDropNodes) node.classList?.remove?.("tabdrop-hover");
            } catch (e) { }
        }

        async _dropTabsOnLibrary(event) {
            if (!this._isTabDrop(event)) return;
            event.preventDefault();
            event.stopPropagation();
            this._hideTabDropBadge();
            const tabs = this._extractDroppedTabs(event);
            if (!tabs.length) return;
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                this._markSelfMutating();
                this._lastDragAt = Date.now();
                try { window._zenLibrarySuppressCelebrationUntil = Date.now() + 5000; } catch (e) { }
                const rootGuid = await this._rootGuid();
                const guids = [];
                const seenUrls = new Set();
                for (const tab of tabs) {
                    try {
                        if (seenUrls.has(tab.url)) continue;
                        seenUrls.add(tab.url);
                        // Already bookmarked → reuse it. Never duplicate, and
                        // never touch the existing item's folder or position.
                        let guid = null;
                        try {
                            const existing = await this._bookmarkForUrl(tab.url);
                            if (existing?.guid) guid = existing.guid;
                        } catch (e) { }
                        if (!guid) {
                            const inserted = await PlacesUtils.bookmarks.insert({
                                parentGuid: rootGuid,
                                url: tab.url,
                                title: tab.title || tab.url,
                                index: PlacesUtils.bookmarks.DEFAULT_INDEX
                            });
                            guid = inserted?.guid || null;
                        }
                        if (guid && !guids.includes(guid)) guids.push(guid);
                    } catch (e) { console.error("[ZenLibrary Bookmarks] tab drop insert failed:", tab.url, e); }
                }
                if (!guids.length) return;
                if (this._container?.isConnected) {
                    try { await this.renderList(); } catch (e) { }
                }
                // Hand the dragged tab's own URL-bar icon to any visuals so
                // they never fall back to the Places page-icon lookup.
                try {
                    if (tabs[0]?.icon) {
                        window._zenLibraryDroppedTabIcon = { icon: tabs[0].icon, at: Date.now() };
                    }
                } catch (e) { }
                try { this._pulseLibraryButton(); } catch (e) { }
                this._showBookmarkSavedToast(guids[0], guids.length);
            } catch (e) {
                console.error("[ZenLibrary Bookmarks] tab drop failed:", e);
            }
        }

        async saveCurrentPageWithSmartTags() {
            try {
                const browser = window.gBrowser?.selectedBrowser;
                const tab = window.gBrowser?.selectedTab;
                const url = browser?.currentURI?.spec || tab?.linkedBrowser?.currentURI?.spec || "";
                if (!this._isSafeBookmarkUrl(url)) return false;

                const context = await this._pageContextForSave(browser, tab, url);
                const provisionalTitle = this._cleanSaveTitle(context.title || tab?.label || url);
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

                this._markSelfMutating();
                try { window._zenLibrarySuppressCelebrationUntil = Date.now() + 10000; } catch (e) { }
                const rootGuid = await this._rootGuid();
                let bookmark = await this._bookmarkForUrl(url);
                const wasInserted = !bookmark?.guid;
                const previousTitle = bookmark?.title || "";
                let previousTags = [];
                try { previousTags = PlacesUtils.tagging.getTagsForURI(Services.io.newURI(url)) || []; } catch (e) { }
                if (!bookmark?.guid) {
                    bookmark = await PlacesUtils.bookmarks.insert({
                        parentGuid: rootGuid,
                        url,
                        title: provisionalTitle,
                        index: PlacesUtils.bookmarks.DEFAULT_INDEX
                    });
                } else if (!bookmark.title && provisionalTitle) {
                    bookmark = await PlacesUtils.bookmarks.update({ guid: bookmark.guid, title: provisionalTitle });
                }

                const originEl = document.getElementById("zen-site-data-icon-button") ||
                    document.getElementById("identity-box") ||
                    tab;
                const fromRect = originEl?.getBoundingClientRect?.();
                const iconSrcs = [
                    tab?.image,
                    `page-icon:${url}`,
                    "chrome://browser/skin/bookmark.svg"
                ].filter(Boolean);
                let reduceMotion = false;
                try { reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; } catch (e) { }
                const dest = document.getElementById("zen-library-button");
                const canFly = !reduceMotion && fromRect && dest &&
                    this._isRectVisible(fromRect) && this._isRectVisible(dest.getBoundingClientRect());
                if (canFly) {
                    this._flyBookmarkToLibrary({ fromRect, iconSrcs });
                } else {
                    try { this._pulseLibraryButton(); } catch (e) { }
                }

                const labels = await this._labelsForPage(context);
                const title = labels.title || provisionalTitle || url;
                const tags = (labels.tags || []).slice(0, 3);
                if (bookmark?.guid && title && title !== bookmark.title) {
                    try {
                        this._markSelfMutating();
                        bookmark = await PlacesUtils.bookmarks.update({ guid: bookmark.guid, title });
                    } catch (e) { }
                }
                if (bookmark?.guid && tags.length) {
                    try {
                        const uri = Services.io.newURI(url);
                        PlacesUtils.tagging.untagURI(uri, null);
                        PlacesUtils.tagging.tagURI(uri, tags.slice(0, 3));
                    } catch (e) { }
                }

                if (this._container?.isConnected) {
                    try { await this.renderList(); } catch (e) { }
                }
                const undoState = { guid: bookmark.guid, url, wasInserted, previousTitle, previousTags };
                this._showSmartSaveTooltip({
                    title,
                    tags,
                    status: "Save labeled as:",
                    undoState
                });
                this._showBookmarkSavedToast(bookmark.guid, 1, { titleText: "Saved to Saves", bodyText: title });
                if (wasInserted) this._afterSmartSaveNotified(bookmark.guid, { title, tags, context });
                return true;
            } catch (e) {
                console.error("[ZenLibrary Bookmarks] smart save failed:", e);
                return false;
            }
        }

        async _bookmarkForUrl(url) {
            if (!url) return null;
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            const existing = await PlacesUtils.bookmarks.fetch({ url }).catch(() => null);
            if (existing?.guid) return existing;
            try {
                const db = await PlacesUtils.promiseDBConnection();
                const rows = await db.executeCached(`
                    SELECT b.guid, b.parent AS parentId, p.guid AS parentGuid, b.position AS position, b.title
                    FROM moz_bookmarks b
                    JOIN moz_places h ON h.id = b.fk
                    LEFT JOIN moz_bookmarks p ON p.id = b.parent
                    WHERE h.url = :url
                    ORDER BY b.lastModified DESC
                    LIMIT 1
                `, { url });
                if (!rows.length) return null;
                const row = rows[0];
                return {
                    guid: row.getResultByName("guid"),
                    parentGuid: row.getResultByName("parentGuid"),
                    index: row.getResultByName("position"),
                    title: row.getResultByName("title") || "",
                    type: PlacesUtils.bookmarks.TYPE_BOOKMARK
                };
            } catch (e) {
                return null;
            }
        }

        _afterSmartSaveNotified(guid, details) {
            setTimeout(() => {
                this._placeBookmarkNearSimilar(guid, details).catch(() => { });
            }, 0);
        }

        async _undoSmartSave(state) {
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                this._markSelfMutating();
                if (state.wasInserted) {
                    await PlacesUtils.bookmarks.remove(state.guid);
                } else {
                    if (state.previousTitle) {
                        await PlacesUtils.bookmarks.update({ guid: state.guid, title: state.previousTitle });
                    }
                    if (state.url) {
                        const uri = Services.io.newURI(state.url);
                        PlacesUtils.tagging.untagURI(uri, null);
                        if (state.previousTags?.length) PlacesUtils.tagging.tagURI(uri, state.previousTags);
                    }
                }
                if (this._container?.isConnected) {
                    try { await this.renderList(); } catch (e) { }
                }
            } catch (e) {
                console.error("[ZenLibrary Bookmarks] undo smart save failed:", e);
            }
        }

        async _placeBookmarkNearSimilar(guid, details) {
            try {
                if (!guid) return;
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                const bookmark = await PlacesUtils.bookmarks.fetch(guid).catch(() => null);
                if (!bookmark || bookmark.type !== PlacesUtils.bookmarks.TYPE_BOOKMARK) return;
                const candidates = await this._similarBookmarkCandidates(guid, details);
                if (!candidates.length) return;
                const chosenGuid = await this._aiChooseSimilarBookmark(details, candidates) ||
                    this._bestSimilarBookmark(details, candidates)?.guid;
                if (!chosenGuid) return;
                const chosen = candidates.find(candidate => candidate.guid === chosenGuid);
                if (!chosen?.parentGuid) return;
                let index = Number(chosen.index);
                if (!Number.isFinite(index) || index < 0) index = PlacesUtils.bookmarks.DEFAULT_INDEX;
                else index += 1;
                if (bookmark.parentGuid === chosen.parentGuid && Number(bookmark.index) < Number(chosen.index)) {
                    index -= 1;
                }
                this._markSelfMutating();
                await PlacesUtils.bookmarks.update({ guid, parentGuid: chosen.parentGuid, index });
                if (this._container?.isConnected) {
                    try { await this.renderList(); } catch (e) { }
                }
            } catch (e) { }
        }

        async _similarBookmarkCandidates(skipGuid, details) {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            const roots = [
                PlacesUtils.bookmarks.toolbarGuid,
                PlacesUtils.bookmarks.menuGuid,
                PlacesUtils.bookmarks.unfiledGuid,
                PlacesUtils.bookmarks.mobileGuid
            ];
            const candidates = [];
            const walk = async (node, parentGuid) => {
                const type = node.type ?? node.itemType;
                const url = node.uri || node.url?.href || node.url || "";
                const isBookmark = type === PlacesUtils.bookmarks.TYPE_BOOKMARK || type === "bookmark" || !!url;
                if (isBookmark && node.guid && node.guid !== skipGuid && url) {
                    let tags = [];
                    try { tags = PlacesUtils.tagging.getTagsForURI(Services.io.newURI(String(url))); } catch (e) { }
                    candidates.push({
                        guid: node.guid,
                        parentGuid,
                        index: node.index ?? PlacesUtils.bookmarks.DEFAULT_INDEX,
                        title: node.title || String(url),
                        url: String(url),
                        tags
                    });
                }
                for (const child of node.children || []) await walk(child, node.guid || parentGuid);
            };
            for (const root of roots) {
                const tree = await PlacesUtils.promiseBookmarksTree(root, { includeItemIds: true }).catch(() => null);
                if (tree) await walk(tree, null);
            }
            return candidates
                .map(candidate => ({ ...candidate, _score: this._similarityScore(details, candidate) }))
                .sort((a, b) => b._score - a._score)
                .slice(0, 40);
        }

        async _aiChooseSimilarBookmark(details, candidates) {
            const provider = this._aiProviderConfig();
            if (!provider || !candidates.length) return null;
            const compact = candidates.slice(0, 24).map(candidate => ({
                guid: candidate.guid,
                title: candidate.title,
                url: candidate.url,
                tags: candidate.tags
            }));
            const systemPrompt = "You place a new browser bookmark next to the most similar existing bookmark. Return strict JSON only.";
            const userPrompt = [
                "Choose the existing bookmark that is most similar to the new bookmark.",
                "Prefer matching topic, page type, site, project, or tags.",
                'Return JSON like {"guid":"bookmark-guid"}.',
                "",
                `New bookmark: ${JSON.stringify({
                    title: details.title,
                    url: details.context?.url,
                    tags: details.tags,
                    description: details.context?.description,
                    headings: details.context?.headings
                })}`,
                `Existing bookmarks: ${JSON.stringify(compact)}`
            ].join("\n").slice(0, 6000);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3500);
            try {
                const response = await fetch(provider.url, {
                    method: "POST",
                    signal: controller.signal,
                    headers: provider.headers,
                    body: JSON.stringify(provider.body(systemPrompt, userPrompt))
                });
                if (!response.ok) return null;
                const data = await response.json();
                const content = provider.read(data);
                const jsonText = String(content || "").match(/\{[\s\S]*\}/)?.[0] || "";
                if (!jsonText) return null;
                const parsed = JSON.parse(jsonText);
                const guid = String(parsed.guid || "");
                return candidates.some(candidate => candidate.guid === guid) ? guid : null;
            } catch (e) {
                return null;
            } finally {
                clearTimeout(timeout);
            }
        }

        _bestSimilarBookmark(details, candidates) {
            return candidates.length && candidates[0]._score > 0 ? candidates[0] : null;
        }

        _similarityScore(details, candidate) {
            const sourceTags = new Set((details.tags || []).map(tag => String(tag).toLowerCase()));
            const candidateTags = new Set((candidate.tags || []).map(tag => String(tag).toLowerCase()));
            let score = 0;
            for (const tag of sourceTags) if (candidateTags.has(tag)) score += 8;
            try {
                const a = new URL(details.context?.url || "");
                const b = new URL(candidate.url || "");
                if (a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "")) score += 12;
            } catch (e) { }
            const words = (text) => new Set(String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []);
            const aWords = words(`${details.title} ${details.context?.description || ""} ${details.context?.headings || ""}`);
            const bWords = words(`${candidate.title} ${candidate.url}`);
            for (const word of aWords) if (bWords.has(word)) score += 1;
            return score;
        }

        _showSmartSaveTooltip({ title, tags = [], status = "Save labeled as:", undoState = null }) {
            try {
                clearTimeout(this._smartSaveTooltipTimer);
                const old = document.getElementById("zen-bookmarks-save-tooltip-container");
                old?.remove?.();

                const anchor = document.getElementById("zen-library-button") ||
                    document.querySelector(".zen-library-section-button[data-section='bookmarks']") ||
                    document.querySelector("[data-section='bookmarks']");
                const rect = anchor?.getBoundingClientRect?.();
                const container = document.createElement("div");
                container.id = "zen-bookmarks-save-tooltip-container";
                container.className = "zen-bookmarks-save-tooltip-container";
                container.style.cssText = [
                    "position:fixed",
                    "z-index:2147483645",
                    "width:160px",
                    "max-width:calc(100vw - 16px)",
                    "pointer-events:none",
                    "box-sizing:border-box",
                    "-moz-window-dragging:no-drag",
                    "left:8px",
                    "bottom:48px"
                ].join(";");

                const tooltip = document.createElement("div");
                tooltip.className = "zen-bookmarks-save-tooltip";
                tooltip.dataset.visible = "true";
                tooltip.style.cssText = [
                    "position:relative",
                    "width:100%",
                    "box-sizing:border-box",
                    "background:color-mix(in srgb, var(--zen-primary-color) 40%, black 60%)",
                    "backdrop-filter:blur(40px)",
                    "-webkit-backdrop-filter:blur(10px)",
                    "border-radius:calc(10px * var(--zen-squircle-value, 1))",
                    "padding:8px 5px 6px 7px",
                    "color:white",
                    "display:flex",
                    "flex-direction:column",
                    "gap:5px",
                    "pointer-events:none",
                    "opacity:0",
                    "transform:scaleY(0.8) translateY(10px)",
                    "transform-origin:bottom left",
                    "transition:opacity 0.3s ease-out 0.15s, transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1.1) 0.15s",
                    "min-width:0",
                    "overflow:visible"
                ].join(";");

                if (!document.getElementById("zen-bookmarks-smart-save-style")) {
                    const style = document.createElement("style");
                    style.id = "zen-bookmarks-smart-save-style";
                    style.textContent = "@keyframes zen-bookmarks-sparkle-shine{0%{transform:scale(0) rotate(0deg);opacity:0}50%{transform:scale(1) rotate(180deg);opacity:.5}100%{transform:scale(0) rotate(360deg);opacity:0}}";
                    document.documentElement.appendChild(style);
                }

                const sparkleLayer = document.createElement("div");
                sparkleLayer.className = "ai-sparkle-layer visible";
                sparkleLayer.style.cssText = [
                    "position:absolute",
                    "inset:0",
                    "pointer-events:none",
                    "z-index:0",
                    "overflow:hidden",
                    "border-radius:inherit",
                    "opacity:1"
                ].join(";");
                for (let i = 0; i < 5; i++) {
                    const sparkle = document.createElement("div");
                    const positions = [
                        "top:10%;left:10%;width:9px;height:9px;animation-delay:0s",
                        "top:25%;right:25%;width:11px;height:11px;animation-delay:.5s",
                        "bottom:15%;left:20%;width:8px;height:8px;animation-delay:1.2s",
                        "bottom:25%;right:10%;width:12px;height:12px;animation-delay:1.8s",
                        "top:50%;left:50%;width:6px;height:6px;animation-delay:2.5s"
                    ];
                    sparkle.style.cssText = [
                        "position:absolute",
                        "background-image:url(\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAABzklEQVR4nO2ZS04CQRRFzwh06HcJfuIS1IEaXI3AAhR/Iyc4MA4UTDRAdB9+UOI+YCwEVExs08nrxJiyrYb+VBlOcidNQt/bqXpVrwpG/F/yQEuUwzJWAeeHVrCIHUUA95k1FBUBjrGImiKA+8wanhUBGlhCGugpAvTkN+PZVJj3tIEFXPgEKGE400DHJ0AbmMJgTn3MezrBUBaAvkaAD2AJw0gDdQ3znh5Mq0jlAOY9VTCEgwHMezpM0rg7BC6HMO/pBhiP2/xiwDH/l+ryn5EzCRwB7yGad75Vp3NgNoqhkpEV1m+RCksdeVdmkErldlIF2btXZVep2pjFpVfxUBNPu36dXT5Bo05AZVUBWgYYczTVVAVo2h4ga4AxR0OfwNZv82BZJnFRlvonoJug2a54qIingngMRApYlxrdjsH0C3Am73TfHSoTspC9RWC8Lx9phhiYB+5DNH8LzBEzqZA2c9fAGAmyP4T5PQyhNID5KwwiLW2irvm7KCpMGBNbp6nvJzFhdTnRCGD0KfWUxsGW2xQZTdkngLvCGk/GJ8AaFh+vd02sPL/RUAR4xPIrpiqWX/IVsfyadRuLWFG0gYE7qaTJSfPd9OthR2A5XyXfjAnQ4fRwAAAAAElFTkSuQmCC\")",
                        "background-size:contain",
                        "background-repeat:no-repeat",
                        "opacity:0",
                        "filter:brightness(0) invert(1) drop-shadow(0 0 1px rgba(255,255,255,.5))",
                        "animation:zen-bookmarks-sparkle-shine 3s infinite ease-in-out",
                        positions[i]
                    ].join(";");
                    sparkleLayer.appendChild(sparkle);
                }

                const statusEl = document.createElement("div");
                statusEl.className = "card-status";
                statusEl.textContent = status;
                // Matches tidy-downloads rename-success tooltip (.card-status):
                // 10px, line-height 1.2, #a0a0a0 (no text-transform).
                statusEl.style.cssText = "font-size:10px;color:#a0a0a0;line-height:1.2;";

                const titleEl = document.createElement("div");
                titleEl.className = "card-title";
                titleEl.textContent = title || "Saved Page";
                titleEl.title = title || "Saved Page";
                // Matches tidy-downloads rename tooltip (.card-title):
                // 11px / 600 / 1.3, nowrap, padding-right 5px, 1px margins.
                titleEl.style.cssText = [
                    "font-size:11px",
                    "font-weight:600",
                    "line-height:1.3",
                    "color:#fff",
                    "white-space:nowrap",
                    "overflow:hidden",
                    "padding-right:5px",
                    "box-sizing:border-box",
                    "margin-top:1px",
                    "margin-bottom:1px",
                    "mask-image:linear-gradient(to right, black 80%, transparent 100%)",
                    "mask-size:100% 100%",
                    "mask-position:left",
                    "mask-repeat:no-repeat",
                    "mask-origin:content-box",
                    "mask-clip:content-box"
                ].join(";");

                const tagsEl = document.createElement("div");
                tagsEl.className = "card-original-filename zen-bookmarks-save-tags";
                tagsEl.textContent = tags.length ? tags.join(", ") : "No tags applied";
                tagsEl.title = tagsEl.textContent;
                // Matches tidy-downloads rename tooltip (.card-original-filename):
                // 9px, nowrap, margin-bottom 2px, padding-right 50px (button
                // clearance). No line-through: tags are new labels, not the
                // old name tidy strikes through.
                tagsEl.style.cssText = [
                    "display:block",
                    "font-size:9px",
                    "color:rgba(255,255,255,.3)",
                    "white-space:nowrap",
                    "overflow:hidden",
                    "margin-bottom:2px",
                    "padding-right:50px",
                    "box-sizing:border-box",
                    "text-decoration:none",
                    "mask-image:linear-gradient(to right, black 80%, transparent 100%)",
                    "mask-size:100% 100%",
                    "mask-position:left",
                    "mask-repeat:no-repeat",
                    "mask-origin:content-box",
                    "mask-clip:content-box"
                ].join(";");

                const arrow = document.createElement("div");
                arrow.className = "zen-bookmarks-save-tooltip-arrow";
                arrow.style.cssText = [
                    "position:absolute",
                    "left:18px",
                    "bottom:-6px",
                    "width:0",
                    "height:0",
                    "border-left:6px solid transparent",
                    "border-right:6px solid transparent",
                    "border-top:6px solid color-mix(in srgb, var(--zen-primary-color) 40%, black 60%)",
                    "filter:drop-shadow(0 1px 1px rgba(0,0,0,.16))",
                    "pointer-events:none"
                ].join(";");

                const buttons = document.createElement("div");
                buttons.className = "tooltip-buttons-container";
                buttons.style.cssText = [
                    "position:absolute",
                    "top:8px",
                    "right:12px",
                    "display:flex",
                    "align-items:center",
                    "z-index:2"
                ].join(";");

                const undoButton = document.createElement("span");
                undoButton.className = "card-undo-button";
                undoButton.title = "Undo save";
                undoButton.tabIndex = 0;
                undoButton.setAttribute("role", "button");
                undoButton.textContent = "↩";
                undoButton.style.cssText = [
                    "background:none",
                    "border:none",
                    "color:rgba(255,255,255,.3)",
                    "cursor:pointer",
                    "padding:2px 2px 2px 0",
                    "line-height:1",
                    "display:inline-flex",
                    "pointer-events:auto",
                    "width:10px",
                    "height:10px",
                    "vertical-align:middle"
                ].join(";");
                const undo = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (undoState) this._undoSmartSave(undoState).catch(() => { });
                    dismiss();
                };
                undoButton.addEventListener("click", undo);
                undoButton.addEventListener("keydown", (event) => {
                    if (event.key === "Enter" || event.key === " ") undo(event);
                });
                undoButton.addEventListener("mouseenter", () => { undoButton.style.color = "#fff"; });
                undoButton.addEventListener("mouseleave", () => { undoButton.style.color = "rgba(255,255,255,.3)"; });
                buttons.appendChild(undoButton);

                tooltip.appendChild(sparkleLayer);
                tooltip.appendChild(statusEl);
                tooltip.appendChild(titleEl);
                tooltip.appendChild(tagsEl);
                if (undoState) tooltip.appendChild(buttons);
                tooltip.appendChild(arrow);
                container.appendChild(tooltip);
                document.body.appendChild(container);

                if (rect) {
                    let contentLeft = 0;
                    try { contentLeft = window.gBrowser?.selectedBrowser?.getBoundingClientRect?.().left || 0; } catch (e) { }
                    if (!contentLeft) {
                        try { contentLeft = document.getElementById("appcontent")?.getBoundingClientRect?.().left || 0; } catch (e) { }
                    }
                    const sidebarLeft = Math.max(8, Math.min(rect.left, window.innerWidth - 160));
                    const sidebarRight = contentLeft > sidebarLeft ? contentLeft : Math.min(window.innerWidth - 8, rect.right + 148);
                    const tooltipWidth = Math.max(120, Math.min(300, sidebarRight - sidebarLeft - 8));
                    const sidebarBottom = Math.max(48, window.innerHeight - rect.bottom + 14);
                    container.style.left = `${sidebarLeft}px`;
                    container.style.width = `${tooltipWidth}px`;
                    container.style.bottom = `${sidebarBottom}px`;
                    const arrowLeft = Math.max(14, Math.min(tooltipWidth - 14, rect.left + rect.width / 2 - sidebarLeft - 6));
                    arrow.style.left = `${arrowLeft}px`;
                }

                requestAnimationFrame(() => {
                    tooltip.style.display = "flex";
                    tooltip.style.visibility = "visible";
                    tooltip.style.opacity = "1";
                    tooltip.style.transform = "scaleY(1) translateY(0)";
                });

                const dismiss = () => {
                    try {
                        tooltip.style.opacity = "0";
                        tooltip.style.transform = "scaleY(0.8) translateY(10px)";
                        tooltip.style.pointerEvents = "none";
                        setTimeout(() => {
                            try { if (container.isConnected) container.remove(); } catch (e) { }
                        }, 450);
                    } catch (e) {
                        try { container.remove(); } catch (_e) { }
                    }
                };
                this._smartSaveTooltipTimer = setTimeout(() => {
                    this._smartSaveTooltipTimer = null;
                    dismiss();
                }, 5200);
            } catch (e) { }
        }

        async _labelsForPage(context) {
            const vocabulary = await this._tagVocabularyForContext(context);
            try {
                const ai = await this._aiLabelsForPage(context, vocabulary);
                if (ai?.title && Array.isArray(ai.tags) && ai.tags.length) return ai;
            } catch (e) { }
            const fallback = this._smartLabelsForPage(context);
            return {
                title: fallback.title,
                tags: this._cleanTags(fallback.tags)
            };
        }

        async _aiLabelsForPage(context, vocabulary = []) {
            const provider = this._aiProviderConfig();
            if (!provider) return null;
            const input = [
                `URL: ${context.url}`,
                `Title: ${context.title}`,
                `Description: ${context.description}`,
                `Headings: ${context.headings}`,
                `Page excerpt: ${context.body}`
            ].join("\n").slice(0, 3200);
            const systemPrompt = "You label browser bookmarks. Return strict JSON only.";
            const userPrompt = [
                "Create a concise bookmark title and exactly 3 lowercase tags.",
                "The title should be simple, human-readable, and keep the core meaning.",
                "Do not over-explain the title. Use normal spaces in the title, not hyphenated slug text.",
                "Prefer existing tags when they fit. Choose broad reusable labels over narrow one-off labels.",
                "Tags should include page type, main topic, and useful category labels.",
                "Look at the user's existing tags as the preferred vocabulary and match their style.",
                "For browser customization, userChrome, Sine, Zen Library, or mod work, prefer broad labels such as mods or development when they fit instead of overly narrow labels such as browser-extension or zen.",
                "For the broadest tag, prefer a reusable category that could apply to many saved pages.",
                "Use hyphenated tags. Do not invent private data.",
                'Return JSON like {"title":"Example","tags":["docs","zen-browser","reference"]}.',
                vocabulary.length ? `Existing tags to prefer: ${vocabulary.join(", ")}` : "",
                "",
                input
            ].join("\n");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3500);
            try {
                const response = await fetch(provider.url, {
                    method: "POST",
                    signal: controller.signal,
                    headers: provider.headers,
                    body: JSON.stringify(provider.body(systemPrompt, userPrompt))
                });
                if (!response.ok) return null;
                const data = await response.json();
                const content = provider.read(data);
                return this._normalizeAiLabels(content);
            } finally {
                clearTimeout(timeout);
            }
        }

        _aiProviderConfig() {
            const get = (name, fallback = "") => {
                try { return Services.prefs.getStringPref(name, fallback); } catch (e) { return fallback; }
            };
            const provider = get("extensions.downloads.ai_provider", "").trim().toLowerCase();
            const openAiBody = (model) => (systemPrompt, userPrompt) => ({
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.2,
                max_tokens: 180
            });
            const readOpenAi = (data) => data?.choices?.[0]?.message?.content || "";
            if (provider === "openai") {
                const apiKey = get("extensions.downloads.openai_api_key", "").trim();
                if (!apiKey) return null;
                return {
                    url: "https://api.openai.com/v1/chat/completions",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                    body: openAiBody(get("extensions.downloads.openai_model", "gpt-4o-mini")),
                    read: readOpenAi
                };
            }
            if (provider === "openrouter") {
                const apiKey = get("extensions.downloads.openrouter_api_key", "").trim();
                if (!apiKey) return null;
                return {
                    url: "https://openrouter.ai/api/v1/chat/completions",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                    body: openAiBody(get("extensions.downloads.openrouter_model", "openai/gpt-4o-mini")),
                    read: readOpenAi
                };
            }
            if (provider === "openai_compat") {
                const apiKey = get("extensions.downloads.openai_compat_api_key", "").trim();
                const base = get("extensions.downloads.openai_compat_base_url", "https://openrouter.ai/api/v1")
                    .trim()
                    .replace(/\/+$/, "")
                    .replace(/\/chat\/completions$/i, "");
                if (!base) return null;
                const headers = { "Content-Type": "application/json" };
                if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
                return {
                    url: `${base}/chat/completions`,
                    headers,
                    body: openAiBody(get("extensions.downloads.openai_compat_model", "gpt-4o-mini")),
                    read: readOpenAi
                };
            }
            if (provider === "ollama") {
                const host = get("extensions.downloads.ollama_base_url", "http://localhost:11434").replace(/\/+$/, "");
                return {
                    url: `${host}/v1/chat/completions`,
                    headers: { "Content-Type": "application/json" },
                    body: openAiBody(get("extensions.downloads.ollama_model", "llama3.1")),
                    read: readOpenAi
                };
            }
            return null;
        }

        _normalizeAiLabels(content) {
            const text = String(content || "").trim();
            if (!text) return null;
            const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
            let parsed = null;
            try { parsed = JSON.parse(jsonText); } catch (e) { return null; }
            const title = this._cleanSaveTitle(parsed.title || "");
            const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
            const cleanTags = this._cleanTags(tags);
            if (!title || !cleanTags.length) return null;
            return { title, tags: cleanTags };
        }

        async _tagVocabularyForContext(context) {
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                const rows = PlacesUtils.tagging.allTags || this._knownTags || [];
                const normalized = Array.from(new Set(rows.map(tag => this._normalizeTag(tag)).filter(Boolean)));
                const text = [
                    context?.title,
                    context?.host,
                    context?.path,
                    context?.description,
                    context?.headings
                ].join(" ").toLowerCase();
                return normalized
                    .map(tag => ({ tag, score: this._tagVocabularyScore(tag, text) }))
                    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
                    .slice(0, 40)
                    .map(item => item.tag);
            } catch (e) {
                return Array.from(new Set((this._knownTags || []).map(tag => this._normalizeTag(tag)).filter(Boolean)));
            }
        }

        _tagVocabularyScore(tag, text) {
            let score = 0;
            if (text.includes(tag.replace(/-/g, " "))) score += 12;
            if (text.includes(tag)) score += 8;
            return score;
        }

        _cleanTags(tags) {
            return Array.from(new Set((tags || []).map(tag => this._normalizeTag(tag)).filter(Boolean))).slice(0, 3);
        }

        _normalizeTag(tag) {
            return String(tag || "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 28);
        }

        async _pageContextForSave(browser, tab, url) {
            const context = {
                url,
                host: "",
                path: "",
                title: "",
                description: "",
                headings: "",
                body: ""
            };
            try {
                const parsed = new URL(url);
                context.host = parsed.hostname.replace(/^www\./i, "");
                context.path = parsed.pathname || "";
            } catch (e) { }
            try { context.title = (browser?.contentTitle || tab?.label || "").trim(); } catch (e) { }
            try {
                const doc = browser?.contentDocument;
                if (doc) {
                    context.title = (doc.title || context.title || "").trim();
                    context.description = (doc.querySelector?.("meta[name='description'],meta[property='og:description']")?.content || "").trim();
                    context.headings = Array.from(doc.querySelectorAll?.("h1,h2") || [])
                        .slice(0, 6)
                        .map(node => node.textContent?.trim())
                        .filter(Boolean)
                        .join(" ");
                    context.body = (doc.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1800);
                }
            } catch (e) { }
            return context;
        }

        _smartLabelsForPage(context) {
            const title = this._cleanSaveTitle(context.title || context.url || "Saved Page");
            const haystack = [
                context.title,
                context.host,
                context.path,
                context.description,
                context.headings,
                context.body
            ].join(" ").toLowerCase();
            const tags = new Set();
            const add = (tag) => {
                const clean = String(tag || "")
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "")
                    .slice(0, 28);
                if (clean && clean.length > 1) tags.add(clean);
            };

            if (/github\.com/.test(context.host)) {
                add("github");
                if (/\/pull\/\d+/.test(context.path)) add("pull-request");
                else if (/\/issues\/\d+/.test(context.path)) add("issue");
                else add("repository");
            } else if (/youtube\.com|youtu\.be|vimeo\.com|twitch\.tv/.test(context.host)) add("video");
            else if (/docs|documentation|reference|api|guide|manual/.test(haystack)) add("docs");
            else if (/shop|cart|product|price|amazon|ebay|store/.test(haystack)) add("shopping");
            else if (/mail|inbox|message|notification/.test(haystack)) add("communication");
            else if (/school|class|course|assignment|grade|student/.test(haystack)) add("school");
            else if (/news|article|blog|post|story/.test(haystack)) add("article");
            else if (/dashboard|analytics|report|admin/.test(haystack)) add("dashboard");
            else add("page");

            for (const part of context.host.split(".")) {
                if (!["com", "org", "net", "io", "app", "dev", "www"].includes(part)) {
                    add(part);
                    break;
                }
            }

            const stop = new Set("about after also and are can from have into more page that the this with your you for not but was were has its use using how what when where why".split(" "));
            const words = (context.title + " " + context.description + " " + context.headings)
                .toLowerCase()
                .match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
            const scores = new Map();
            for (const word of words) {
                if (stop.has(word) || /^\d+$/.test(word)) continue;
                scores.set(word, (scores.get(word) || 0) + 1);
            }
            Array.from(scores.entries())
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, 3)
                .forEach(([word]) => add(word));

            return { title, tags: Array.from(tags).slice(0, 3) };
        }

        _cleanSaveTitle(title) {
            const text = String(title || "").replace(/\s+/g, " ").trim();
            if (!text) return "Saved Page";
            return text.length > 90 ? `${text.slice(0, 87).trim()}...` : text;
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

        renderHeaderControls() {            const top = this.el("div", { className: "zen-library-search-top" });
            const searchInput = this.el("input", {
                type: "search",
                placeholder: "Search Bookmarks...",
                value: this._searchTerm,
                oninput: (event) => {
                    this._searchTerm = event.target.value;
                    if (!this._searchDebounce) {
                        const debounce = window.ZenLibraryUtil?.debounce ||
                            ((fn, ms) => this._debounceFn(fn, ms));
                        this._searchDebounce = debounce(() => this.renderList(), 250);
                    }
                    this._searchDebounce();
                }
            });
            const searchHeader = this.el("div", { className: "zen-library-search-header" }, [
                this.el("div", { className: "zen-library-search-box" }, [
                    this.el("img", { src: "chrome://browser/skin/zen-icons/search-glass.svg", alt: "" }),
                    searchInput
                ]),
                this.el("button", {
                    className: "zen-library-filter-button",
                    onclick: (event) => {
                        event.preventDefault();
                        this._setFiltersOpen(true);
                    }
                }, [
                    this.el("img", { src: "chrome://browser/skin/zen-icons/sliders.svg", alt: "" }),
                    this.el("span", { textContent: "Filter" })
                ])
            ]);
            const filterHeader = this.el("div", { className: "zen-library-filter-header" }, [
                this.el("h2", { textContent: "Filter Bookmarks..." }),
                this.el("button", {
                    className: "zen-library-filter-done",
                    textContent: "Done",
                    onclick: (event) => {
                        event.preventDefault();
                        this._setFiltersOpen(false);
                    }
                })
            ]);

            this._chipEls = [];
            const panelInner = this.el("div", { className: "zen-library-filter-panel-inner" }, [
                this._renderFilterGroup("space", "Which space?", this._spaceOptions()),
                this._renderFilterGroup("tag", "Which tag?", this._tagOptions())
            ]);

            top.appendChild(searchHeader);
            top.appendChild(filterHeader);
            top.appendChild(this.el("div", { className: "zen-library-filter-panel" }, [panelInner]));

            this._headerEls = { top, searchHeader, filterHeader, panelInner };
            this._syncChips();
            this._applyFiltersOpen();
            return top;
        }

        _spaceOptions() {
            const options = [["all", "All Spaces"]];
            try {
                const workspaces = window.gZenWorkspaces?.getWorkspaces?.();
                for (const workspace of workspaces || []) {
                    if (!workspace?.uuid) continue;
                    options.push([workspace.uuid, workspace.name || "Space"]);
                }
            } catch (e) { }
            return options;
        }

        _tagOptions() {
            const options = [["all", "All Tags"]];
            for (const tag of this._knownTags || []) options.push([tag, tag]);
            return options;
        }

        _setFiltersOpen(open) {
            this._filtersOpen = open;
            this._applyFiltersOpen();
        }

        _applyFiltersOpen() {
            const els = this._headerEls;
            if (!els) return;
            const open = this._filtersOpen;
            els.top.toggleAttribute("open", open);
            els.searchHeader.toggleAttribute("inert", open);
            els.filterHeader.toggleAttribute("inert", !open);
            els.panelInner.toggleAttribute("inert", !open);
            const host = this.library;
            if (!open) {
                host.style?.setProperty("--zen-library-filter-height", "0px");
                return;
            }
            requestAnimationFrame(() => {
                if (this._headerEls !== els || !this._filtersOpen) return;
                host.style?.setProperty("--zen-library-filter-height", `${els.panelInner.scrollHeight + 8}px`);
            });
        }

        _renderFilterGroup(groupId, title, options) {
            return this.el("div", { className: "zen-library-filter-group" }, [
                this.el("h3", { textContent: title }),
                this.el("div", { className: "zen-library-filter-options" },
                    options.map(([id, label]) => this._renderFilterChip(groupId, id, label))
                )
            ]);
        }

        _renderFilterChip(groupId, id, label) {
            const chip = this.el("button", {
                className: "zen-library-filter-chip",
                onclick: (event) => {
                    event.preventDefault();
                    if (groupId === "tag") {
                        if (id === "all") {
                            this._activeTags.clear();
                        } else if (this._activeTags.has(id)) {
                            this._activeTags.delete(id);
                        } else {
                            this._activeTags.add(id);
                        }
                    }
                    if (groupId === "space") this._activeSpace = id;
                    this._syncChips();
                    this.renderList();
                },
                oncontextmenu: (event) => {
                    if (groupId !== "tag" || id === "all") return;
                    event.preventDefault();
                    event.stopPropagation();
                    this._showFilterTagContextMenu(event, id);
                }
            }, [this.el("span", { textContent: label })]);
            this._chipEls.push({ chip, groupId, id });
            return chip;
        }

        _syncChips() {
            for (const { chip, groupId, id } of this._chipEls || []) {
                const active = groupId === "tag"
                    ? (id === "all" ? this._activeTags.size === 0 : this._activeTags.has(id))
                    : this._activeSpace === id;
                chip.toggleAttribute("active", active);
            }
        }

        render() {
            const container = this.el("div", { className: "library-list-container bookmarks-list-container" });
            this._container = container;
            this.renderList();
            this.library.enterContent(container);
            requestAnimationFrame(() => container.classList.add("scrollbar-visible"));
            return container;
        }

        async renderList() {
            if (!this._container) return;
            const scroller = this._container;
            const savedTop = scroller.scrollTop || 0;
            const token = {};
            this._renderToken = token;
            const loading = this.el("div", { className: "empty-state" }, [
                this.el("div", { className: "empty-icon bookmarks-icon" }),
                this.el("h3", { textContent: "Loading bookmarks..." })
            ]);
            this._container.replaceChildren(loading);

            try {
                const roots = await this.fetchBookmarks();
                if (this._renderToken !== token) return;
                this._items = roots;
                const list = this.el("div", { className: "bookmarks-tree" });
                for (const root of roots) this._renderNode(root, list, 0);
                if (!list.childElementCount) {
                    this._container.replaceChildren(this.el("div", { className: "empty-state" }, [
                        this.el("div", { className: "empty-icon bookmarks-icon" }),
                        this.el("h3", { textContent: "No bookmarks found" }),
                        this.el("p", { textContent: this._searchTerm ? "Try a different search term." : "Your bookmarks will appear here." })
                    ]));
                } else {
                    this._container.replaceChildren(list);
                }
                // Rebuilding the list resets scrollTop to 0; restore it so a
                // drag/drop (or background Places echo) does not jump the view.
                try {
                    if (this._container === scroller && savedTop > 0) scroller.scrollTop = savedTop;
                } catch (e) { }
            } catch (e) {
                console.error("[ZenLibrary Bookmarks] render failed:", e);
                this._container.replaceChildren(this.el("div", { className: "empty-state" }, [
                    this.el("div", { className: "empty-icon bookmarks-icon" }),
                    this.el("h3", { textContent: "Bookmarks unavailable" })
                ]));
            }
        }

        async fetchBookmarks() {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            const systemRootGuids = [
                PlacesUtils.bookmarks.toolbarGuid,
                PlacesUtils.bookmarks.menuGuid,
                PlacesUtils.bookmarks.unfiledGuid,
                PlacesUtils.bookmarks.mobileGuid
            ];
            let rootGuid = await this._rootGuid();
            const trees = [];
            const tags = new Set();
            const workspaceMap = await this._bookmarkWorkspaceMap();
            let rootNode = null;
            try {
                const tree = await PlacesUtils.promiseBookmarksTree(rootGuid, { includeItemIds: true });
                rootNode = await this._normalizeNode(tree, null, workspaceMap);
            } catch (e) {
                rootGuid = PlacesUtils.bookmarks.toolbarGuid;
                this._setStoredRootGuid(rootGuid);
                const tree = await PlacesUtils.promiseBookmarksTree(rootGuid, { includeItemIds: true });
                rootNode = await this._normalizeNode(tree, null, workspaceMap);
            }
            if (rootNode) trees.push(...(rootNode.children || []));
            // Other top-level Firefox folders stay visible as folders alongside
            // the Saves root contents, so bookmarks outside the Saves root are
            // reachable (and can be dragged into it).
            const seenGuids = new Set(trees.map(node => node?.guid).filter(Boolean));
            for (const guid of systemRootGuids) {
                if (guid === rootGuid || seenGuids.has(guid)) continue;
                try {
                    const tree = await PlacesUtils.promiseBookmarksTree(guid, { includeItemIds: true });
                    const normalized = await this._normalizeNode(tree, null, workspaceMap);
                    if (normalized) {
                        trees.push(normalized);
                        seenGuids.add(normalized.guid);
                    }
                } catch (e) { }
            }
            const collectTags = (node) => {
                for (const tag of node.tags || []) tags.add(tag);
                for (const child of node.children || []) collectTags(child);
            };
            for (const tree of trees) collectTags(tree);
            const knownTags = Array.from(tags).sort((a, b) => a.localeCompare(b));
            if (knownTags.join("\n") !== this._knownTags.join("\n")) {
                this._knownTags = knownTags;
                for (const tag of Array.from(this._activeTags)) {
                    if (!tags.has(tag)) this._activeTags.delete(tag);
                }
                this._rebuildFilterPanel();
            }
            const term = this._searchTerm.trim().toLowerCase();
            const hasFilters = term || this._activeTags.size > 0 || this._activeSpace !== "all";
            const result = hasFilters ? trees.map(node => this._filterNode(node, term)).filter(Boolean) : trees;
            // Top-level Firefox folders are always visible (even when empty),
            // so nothing outside the Saves root is hidden.
            return result;
        }

        async _rootGuid() {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            let guid = "";
            try { guid = Services.prefs.getStringPref(ZenLibraryBookmarks.ROOT_PREF, ""); } catch (e) { }
            if (!guid) {
                guid = PlacesUtils.bookmarks.toolbarGuid;
                this._setStoredRootGuid(guid);
            }
            this._rootFolderGuid = guid;
            return guid;
        }

        _setStoredRootGuid(guid) {
            try { Services.prefs.setStringPref(ZenLibraryBookmarks.ROOT_PREF, guid); } catch (e) { }
            this._rootFolderGuid = guid;
        }

        _rebuildFilterPanel() {
            const els = this._headerEls;
            if (!els?.panelInner?.isConnected) return;
            this._chipEls = [];
            els.panelInner.replaceChildren(
                this._renderFilterGroup("space", "Which space?", this._spaceOptions()),
                this._renderFilterGroup("tag", "Which tag?", this._tagOptions())
            );
            this._syncChips();
            this._applyFiltersOpen();
        }

        async _bookmarkWorkspaceMap() {
            try {
                const storage = window.ZenWorkspaceBookmarksStorage || window.ZenSpaceBookmarksStorage;
                if (!storage?.getBookmarkGuidsByWorkspace) return null;
                const byWorkspace = await storage.getBookmarkGuidsByWorkspace();
                const byBookmark = new Map();
                for (const [workspaceGuid, bookmarkGuids] of Object.entries(byWorkspace || {})) {
                    for (const bookmarkGuid of bookmarkGuids || []) {
                        if (!byBookmark.has(bookmarkGuid)) byBookmark.set(bookmarkGuid, []);
                        byBookmark.get(bookmarkGuid).push(workspaceGuid);
                    }
                }
                return byBookmark;
            } catch (e) { return null; }
        }

        async _normalizeNode(node, parentGuid, workspaceMap) {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            const nodeType = node.type ?? node.itemType;
            const fetched = node.guid ? await PlacesUtils.bookmarks.fetch(node.guid).catch(() => null) : null;
            const type = fetched?.type ?? nodeType;
            const looksLikeSeparator = !fetched && !node.uri && !node.title && !(node.children || []).length;
            const isSeparator = type === PlacesUtils.bookmarks.TYPE_SEPARATOR || type === "separator" || looksLikeSeparator;
            const isFolder = !isSeparator && (type === PlacesUtils.bookmarks.TYPE_FOLDER || type === "folder" || Array.isArray(node.children));
            const url = node.uri || fetched?.url?.href || fetched?.url || "";
            const item = {
                guid: node.guid,
                parentGuid,
                index: node.index ?? PlacesUtils.bookmarks.DEFAULT_INDEX,
                title: isSeparator ? "" : (node.title || this._rootTitle(node.guid)),
                url: url ? String(url) : "",
                isFolder,
                isSeparator,
                children: []
            };
            if (item.url && !item.isSeparator) {
                try { item.tags = PlacesUtils.tagging.getTagsForURI(Services.io.newURI(item.url)); } catch (e) { item.tags = []; }
                item.icon = `page-icon:${item.url}`;
                item.spaceGuids = workspaceMap?.get(item.guid) || await this._bookmarkSpaceGuids(item.guid);
            }
            for (const child of node.children || []) {
                const normalized = await this._normalizeNode(child, item.guid, workspaceMap);
                if (normalized) item.children.push(normalized);
            }
            return item;
        }

        async _bookmarkSpaceGuids(guid) {
            try {
                const storage = window.ZenWorkspaceBookmarksStorage || window.ZenSpaceBookmarksStorage;
                if (storage?.getWorkspacesForBookmark) return await storage.getWorkspacesForBookmark(guid);
                if (storage?.getBookmarkWorkspaces) return await storage.getBookmarkWorkspaces(guid);
                if (storage?.getBookmarkWorkspaceIds) return await storage.getBookmarkWorkspaceIds(guid);
            } catch (e) { }
            return [];
        }

        _rootTitle(guid) {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            if (guid === PlacesUtils.bookmarks.toolbarGuid) return "Bookmarks Toolbar";
            if (guid === PlacesUtils.bookmarks.menuGuid) return "Bookmarks Menu";
            if (guid === PlacesUtils.bookmarks.unfiledGuid) return "Other Bookmarks";
            if (guid === PlacesUtils.bookmarks.mobileGuid) return "Mobile Bookmarks";
            return "Folder";
        }

        _filterNode(node, term) {
            const title = (node.title || "").toLowerCase();
            const url = (node.url || "").toLowerCase();
            const tags = (node.tags || []).join(" ").toLowerCase();
            const children = (node.children || []).map(child => this._filterNode(child, term)).filter(Boolean);
            const matchesSearch = !term || title.includes(term) || url.includes(term) || tags.includes(term);
            const matchesTag = this._activeTags.size === 0 || (node.tags || []).some(tag => this._activeTags.has(tag));
            const matchesSpace = this._activeSpace === "all" || (node.spaceGuids || []).includes(this._activeSpace);
            const filterActive = this._activeTags.size > 0 || this._activeSpace !== "all";
            const matches = node.isFolder ? (!filterActive && matchesSearch) : !node.isSeparator && matchesSearch && matchesTag && matchesSpace;
            if (matches || children.length) {
                return { ...node, children };
            }
            return null;
        }

        _renderNode(node, parent, depth) {
            if (node.isSeparator) {
                const row = this.el("div", {
                    className: "bookmark-separator-row",
                    style: `--bookmark-depth: ${Math.min(depth, 12)};`
                }, [this.el("div", { className: "bookmark-separator-line" })]);
                row.dataset.guid = node.guid;
                row.dataset.depth = String(depth);
                row.oncontextmenu = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this._openContextMenu(event, node);
                };
                parent.appendChild(row);
                return;
            }
            const icon = node.isFolder
                ? this.el("div", { className: "bookmark-row-icon folder" })
                : this.el("img", {
                    className: "bookmark-row-favicon",
                    src: node.icon || "chrome://browser/skin/zen-icons/globe.svg",
                    alt: "",
                    onerror: (event) => {
                        event.currentTarget.removeAttribute("src");
                        event.currentTarget.className = "bookmark-row-icon page";
                    }
                });
            const row = this.el("div", {
                className: `library-list-item bookmark-row ${node.isFolder ? "bookmark-folder-row" : "bookmark-item-row"}`,
                tabindex: 0,
                style: `--bookmark-depth: ${Math.min(depth, 12)};`,
                title: node.url || node.title,
                onclick: (event) => this._onRowClick(event, node)
            }, [
                icon,
                this.el("div", { className: "bookmark-row-text" }, [
                    this._renderTitleLine(node),
                    this.el("div", { className: "bookmark-row-subtitle", textContent: node.isFolder ? `${node.children.length} items` : node.url })
                ]),
                this._renderRowActions(node)
            ]);
            row.dataset.guid = node.guid;
            row.dataset.depth = String(depth);
            row.draggable = true;
            row.addEventListener("dragstart", (event) => this._onDragStart(event, node));
            row.addEventListener("dragend", () => this._clearDragState());
            row.addEventListener("dragover", (event) => this._onDragOver(event, row, node));
            row.addEventListener("dragleave", (event) => this._onDragLeave(event, row));
            row.addEventListener("drop", (event) => this._onDrop(event, row, node));
            row.oncontextmenu = (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._openContextMenu(event, node);
            };
            parent.appendChild(row);

            if (!node.isFolder) return;
            const open = this._openFolders.has(node.guid) || depth === 0 || this._searchTerm;
            row.toggleAttribute("open", open);
            if (!open) return;
            for (const child of node.children) this._renderNode(child, parent, depth + 1);
        }

        _renderTitleLine(node) {
            const children = [this.el("div", { className: "bookmark-row-title", textContent: node.title || node.url || "Untitled" })];
            if (!node.isFolder && (node.tags || []).length) {
                const openTags = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this._showTagMenu(event, node);
                };
                children.push(this.el("div", { className: "bookmark-tags" },
                    (node.tags || []).map(tag => this.el("button", {
                        className: "bookmark-tag",
                        textContent: tag,
                        title: tag,
                        onclick: openTags
                    }))));
            }
            return this.el("div", { className: "bookmark-row-title-line" }, children);
        }

        _renderRowActions(node) {
            if (node.isFolder) return null;
            return this.el("div", { className: "bookmark-row-actions" }, [
                this.el("button", {
                    className: "bookmark-more-button download-row-action download-row-more",
                    title: "More actions",
                    "aria-label": "More actions",
                    onclick: (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        this._openContextMenu(event, node);
                    }
                }, [this.el("span", { className: "download-row-action-icon more-icon", "aria-hidden": "true" })])
            ]);
        }

        _onRowClick(event, node) {
            event.stopPropagation();
            if (node.isFolder) {
                this._toggleFolder(event.currentTarget, node);
                return;
            }
            if (!this._openBookmarkUrl(node.url)) return;
            try { window.gZenLibraryBookmarksIntegration?._closeLibraryAfterOpen?.(); } catch (e) { }
            try { window.gZenLibrary?.close?.(); } catch (e) { }
        }

        _openBookmarkUrl(url) {
            if (!this._isSafeBookmarkUrl(url)) return false;
            try {
                if (typeof window.openWebLinkIn === "function") {
                    window.openWebLinkIn(url, "tab", { inBackground: false });
                    return true;
                }
                if (typeof window.openTrustedLinkIn === "function") {
                    window.openTrustedLinkIn(url, "tab", { inBackground: false });
                    return true;
                }
                if (window.gBrowser?.addTrustedTab) {
                    window.gBrowser.selectedTab = window.gBrowser.addTrustedTab(url, { inBackground: false });
                    return true;
                }
            } catch (e) {
                console.error("[ZenLibrary Bookmarks] open bookmark failed:", e);
            }
            return false;
        }

        _isSafeBookmarkUrl(url) {
            try {
                const uri = Services.io.newURI(url);
                return ["http", "https", "about", "chrome", "file"].includes(uri.scheme);
            } catch (e) {
                return false;
            }
        }

        _toggleFolder(row, node) {
            if (!row || !node?.isFolder || this._searchTerm) {
                if (this._openFolders.has(node.guid)) this._openFolders.delete(node.guid);
                else this._openFolders.add(node.guid);
                this.renderList();
                return;
            }
            const depth = Number(row.dataset.depth || 0);
            if (row.hasAttribute("open")) {
                this._openFolders.delete(node.guid);
                row.removeAttribute("open");
                let next = row.nextElementSibling;
                while (next && Number(next.dataset.depth || 0) > depth) {
                    const remove = next;
                    next = next.nextElementSibling;
                    remove.remove();
                }
                return;
            }
            this._openFolders.add(node.guid);
            row.setAttribute("open", "");
            const frag = document.createDocumentFragment();
            for (const child of node.children || []) this._renderNode(child, frag, depth + 1);
            row.after(...Array.from(frag.childNodes));
        }

        _onDragStart(event, node) {
            if (node.isSeparator) {
                event.preventDefault();
                return;
            }
            this._draggedNode = node;
            event.currentTarget.setAttribute("dragged", "true");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-zen-library-bookmark", node.guid);
            event.dataTransfer.setData("text/plain", node.url || node.title || "");
        }

        _onDragOver(event, row, node) {
            if (!this._canDropOn(node)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = row.getBoundingClientRect();
            const after = !node.isFolder && event.clientY > rect.top + rect.height / 2;
            row.toggleAttribute("drop-after", after);
            row.toggleAttribute("drop-before", !node.isFolder && !after);
            row.toggleAttribute("drop-into", node.isFolder);
            if (node.isFolder && !row.hasAttribute("open")) {
                clearTimeout(this._folderHoverTimer);
                this._folderHoverTimer = setTimeout(() => {
                    this._folderHoverTimer = null;
                    if (this._draggedNode && row.isConnected && !row.hasAttribute("open")) this._toggleFolder(row, node);
                }, 450);
            }
        }

        _onDragLeave(event, row) {
            if (row.contains(event.relatedTarget)) return;
            row.removeAttribute("drop-before");
            row.removeAttribute("drop-after");
            row.removeAttribute("drop-into");
        }

        async _onDrop(event, row, node) {
            if (!this._canDropOn(node)) return;
            event.preventDefault();
            event.stopPropagation();
            const dragged = this._draggedNode;
            const after = row.hasAttribute("drop-after");
            this._clearDragState();
            this._lastDragAt = Date.now();
            this._markSelfMutating();
            try {
                if (node.isFolder) {
                    await this._moveBookmark(dragged, node.guid, node.children.length);
                    this._openFolders.add(node.guid);
                }
                else await this._dropOntoBookmark(dragged, node, after);
                await this.renderList();
                // Keep keyboard focus on the moved row without scrolling.
                try {
                    this._container?.querySelector?.(`[data-guid="${dragged?.guid}"]`)?.focus?.({ preventScroll: true });
                } catch (e) { }
            } catch (e) {
                console.error("[ZenLibrary Bookmarks] drag/drop failed:", e);
            }
        }

        _canDropOn(target) {
            const dragged = this._draggedNode;
            if (!dragged || !target || dragged.guid === target.guid || target.isSeparator) return false;
            return !this._containsGuid(dragged, target.guid);
        }

        _containsGuid(node, guid) {
            if (!node?.children?.length) return false;
            for (const child of node.children) {
                if (child.guid === guid || this._containsGuid(child, guid)) return true;
            }
            return false;
        }

        _clearDragState() {
            clearTimeout(this._folderHoverTimer);
            this._folderHoverTimer = null;
            this._draggedNode = null;
            this._container?.querySelectorAll?.("[dragged], [drop-before], [drop-after], [drop-into]").forEach(row => {
                row.removeAttribute("dragged");
                row.removeAttribute("drop-before");
                row.removeAttribute("drop-after");
                row.removeAttribute("drop-into");
            });
        }

        async _dropOntoBookmark(dragged, target, after) {
            if (!dragged || !target?.parentGuid) return;
            // Reorder only: dropping before/after a bookmark moves there.
            // (Previously a drop on the top half created a new folder.)
            await this._moveBookmark(dragged, target.parentGuid, after ? target.index + 1 : target.index);
        }

        async _moveBookmark(node, parentGuid, index) {
            this._markSelfMutating();
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            await PlacesUtils.bookmarks.update({ guid: node.guid, parentGuid, index });
        }

        _openContextMenu(event, node) {
            document.getElementById("zen-bookmarks-context-menu")?.remove();
            const popup = document.createXULElement("menupopup");
            popup.id = "zen-bookmarks-context-menu";
            const addItem = (label, command, disabled = false) => {
                const item = document.createXULElement("menuitem");
                item.setAttribute("label", label);
                if (disabled) item.setAttribute("disabled", "true");
                item.addEventListener("command", command, { once: true });
                popup.appendChild(item);
            };
            if (!node.isSeparator) addItem(node.isFolder ? "Edit folder" : "Edit bookmark", () => this._editBookmark(node));
            if (node.isFolder && node.guid !== this._rootFolderGuid) {
                addItem("Set as root", () => this._setRootFolder(node));
            }
            addItem("Add folder", () => this._addFolder(node));
            addItem("Add separator below", () => this._addSeparatorBelow(node));
            // System roots have no parent to absorb into, so no ungroup there.
            if (node.isFolder && node.parentGuid) addItem("Ungroup folder", () => this._ungroupFolder(node));
            popup.appendChild(document.createXULElement("menuseparator"));
            addItem("Delete", () => this._delete(node));
            popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
            (document.getElementById("mainPopupSet") || document.body).appendChild(popup);
            popup.openPopupAtScreen(event.screenX, event.screenY, true);
        }

        async _setRootFolder(node) {
            if (!node?.isFolder || !node.guid) return;
            this._setStoredRootGuid(node.guid);
            this._openFolders.clear();
            await this.renderList();
        }

        async _editBookmark(node) {
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                const bookmark = await PlacesUtils.bookmarks.fetch(node.guid);
                if (!bookmark || bookmark.type === PlacesUtils.bookmarks.TYPE_SEPARATOR) return;
                const isFolder = bookmark.type === PlacesUtils.bookmarks.TYPE_FOLDER;
                const nodeLike = await this._nodeLikeFromBookmark(bookmark);
                // Native editBookmark.js _setPaneInfo does
                // Services.io.newURI(node.uri) for RESULT_TYPE_URI nodes.
                // An empty/malformed uri always fails there with
                // NS_ERROR_MALFORMED_URI, so validate here where we still
                // know the guid/title instead of opening a doomed dialog.
                if (!isFolder) {
                    try {
                        Services.io.newURI(nodeLike.uri);
                    } catch (e) {
                        console.error("[ZenLibrary Bookmarks] refusing to open edit dialog with invalid uri:",
                            JSON.stringify({ guid: nodeLike.bookmarkGuid, title: nodeLike.title, uri: nodeLike.uri }), e);
                        return;
                    }
                }
                const info = {
                    action: "edit",
                    type: isFolder ? "folder" : "bookmark",
                    node: nodeLike
                };
                // The edit dialog overlays the open panel via gDialogBox, so the
                // Library stays open behind it (closing first felt jarring and
                // lost the user's place in the list).
                if (window.gDialogBox) await window.gDialogBox.open("chrome://browser/content/places/bookmarkProperties.xhtml", info);
                else window.openDialog("chrome://browser/content/places/bookmarkProperties.xhtml", "", "centerscreen,chrome,modal,resizable=no", info);
                // Native showBookmarkDialog() awaits bookmarkState.save() after
                // the dialog closes (autosave is off outside Places:Organizer).
                // We open the dialog directly, so commit here or edits are lost.
                if (info.bookmarkState) {
                    try { this._markSelfMutating(); await info.bookmarkState.save(); }
                    catch (e) { console.error("[ZenLibrary Bookmarks] save failed:", e); }
                }
                if (this._container?.isConnected) setTimeout(() => this.renderList(), 0);
            } catch (e) {
                console.error("[ZenLibrary Bookmarks] edit bookmark failed:", e);
            }
        }

        async _nodeLikeFromBookmark(bookmark) {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            const itemId = await this._bookmarkIdFromGuid(bookmark.guid);
            const parentItemId = await this._bookmarkIdFromGuid(bookmark.parentGuid);
            // fetch() returns url as URL, but accept nsIURI (.spec) and raw
            // strings too. String(nsIURI) is not guaranteed to be the spec,
            // so prefer .spec, then .href, then the raw value.
            const rawUrl = bookmark.url;
            const uri = rawUrl
                ? String(rawUrl.spec || rawUrl.href || rawUrl).trim()
                : "";
            const isFolder = bookmark.type === PlacesUtils.bookmarks.TYPE_FOLDER;
            const resultType = isFolder
                ? Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER
                : Ci.nsINavHistoryResultNode.RESULT_TYPE_URI;
            return {
                QueryInterface: ChromeUtils.generateQI(["nsINavHistoryResultNode"]),
                itemId,
                _id: itemId,
                bookmarkGuid: bookmark.guid,
                itemGuid: bookmark.guid,
                parent: {
                    itemId: parentItemId,
                    _id: parentItemId,
                    bookmarkGuid: bookmark.parentGuid,
                    itemGuid: bookmark.parentGuid,
                    type: Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER
                },
                parentGuid: bookmark.parentGuid,
                title: bookmark.title || "",
                uri,
                type: resultType,
                index: bookmark.index
            };
        }

        async _bookmarkIdFromGuid(guid) {
            if (!guid) return -1;
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            const db = await PlacesUtils.promiseDBConnection();
            const rows = await db.executeCached("SELECT id FROM moz_bookmarks WHERE guid = :guid", { guid });
            return rows.length ? rows[0].getResultByName("id") : -1;
        }

        _isRectVisible(rect) {
            if (!rect) return false;
            return !(rect.bottom < 1 || rect.right < 1 ||
                rect.top > window.innerHeight || rect.left > window.innerWidth ||
                rect.width <= 0 || rect.height <= 0);
        }

        async _onExternalBookmarkAdded(guid) {
            try {
                // Tab-drop inserts celebrate manually (pulse + toast); never
                // fly the site-panel arc for them. The drop and this observer
                // can live on different windows, so every open browser window
                // is checked — a same-window flag alone misses that case.
                try {
                    let quietUntil = window._zenLibrarySuppressCelebrationUntil || 0;
                    const wins = Services.wm.getEnumerator("navigator:browser");
                    while (wins.hasMoreElements()) {
                        const t = wins.getNext()?._zenLibrarySuppressCelebrationUntil || 0;
                        if (t > quietUntil) quietUntil = t;
                    }
                    if (Date.now() < quietUntil) return;
                } catch (e) { }
                // Only the foreground window celebrates; background windows stay quiet.
                try {
                    const recent = Services.wm.getMostRecentWindow("navigator:browser");
                    if (recent && recent !== window) return;
                } catch (e) { }
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                const bookmark = await PlacesUtils.bookmarks.fetch(guid).catch(() => null);
                if (!bookmark || bookmark.type !== PlacesUtils.bookmarks.TYPE_BOOKMARK) return;
                const rawUrl = bookmark.url;
                const url = rawUrl ? String(rawUrl.spec || rawUrl.href || rawUrl) : "";
                if (!url) return;
                const originEl = document.getElementById("zen-site-data-icon-button") ||
                    document.getElementById("identity-box");
                const fromRect = originEl?.getBoundingClientRect?.();
                // A freshly dragged tab's own URL-bar icon beats the Places
                // page-icon lookup — it is the exact image, not a guess.
                const iconSrcs = [];
                try {
                    const dropped = window._zenLibraryDroppedTabIcon;
                    if (dropped?.icon && Date.now() - dropped.at < 5000) iconSrcs.push(dropped.icon);
                } catch (e) { }
                iconSrcs.push(`page-icon:${url}`);
                try {
                    const tab = window.gBrowser?.selectedTab;
                    const tabURL = tab?.linkedBrowser?.currentURI?.spec;
                    if (tab?.image && (!tabURL || tabURL === url)) iconSrcs.push(tab.image);
                } catch (e) { }
                iconSrcs.push("chrome://browser/skin/bookmark.svg");
                let reduceMotion = false;
                try { reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; } catch (e) { }
                const dest = document.getElementById("zen-library-button");
                const canFly = !reduceMotion && fromRect && dest &&
                    this._isRectVisible(fromRect) && this._isRectVisible(dest.getBoundingClientRect());
                if (canFly) {
                    this._flyBookmarkToLibrary({
                        fromRect,
                        iconSrcs,
                        onComplete: () => this._showBookmarkSavedToast(guid)
                    });
                } else {
                    this._showBookmarkSavedToast(guid);
                }
            } catch (e) { }
        }

        // Mirrors the native download arc (ZenDownloadAnimation.mjs): 1s,
        // easeInOutQuad arc with a perpendicular bow, scale 0.5 -> 1.8 -> 0.45,
        // fade in/out, cubic-bezier(0.37, 0, 0.63, 1). The ghost lives inside
        // the real <zen-download-animation> host with the native arc classes,
        // so its background matches the downloads one exactly.
        _flyBookmarkToLibrary({ fromRect, iconSrc, iconSrcs, onComplete }) {
            const done = () => { try { onComplete?.(); } catch (e) { } };
            try {
                const dest = document.getElementById("zen-library-button");
                if (!dest) { done(); return; }
                const toRect = dest.getBoundingClientRect();
                if (!this._isRectVisible(toRect)) { done(); return; }
                const srcs = [...(Array.isArray(iconSrcs) ? iconSrcs : []),
                    ...(typeof iconSrc === "string" ? [iconSrc] : []),
                    "chrome://browser/skin/bookmark.svg"].filter((s, i, a) => s && a.indexOf(s) === i);
                const fromCx = fromRect.left + fromRect.width / 2;
                const fromCy = fromRect.top + fromRect.height / 2;
                const toCx = toRect.left + toRect.width / 2;
                const toCy = toRect.top + toRect.height / 2;
                const size = 40;
                // Native host carries zen-download-arc-animation.css in its
                // shadow root; appending there picks up the exact styling.
                // (Created on demand by the downloader too.)
                let host = null;
                try { host = document.querySelector("zen-download-animation"); } catch (e) { host = null; }
                if (!host) {
                    try {
                        host = document.createElement("zen-download-animation");
                        document.body.appendChild(host);
                    } catch (e) { host = null; }
                }
                const shadow = host?.shadowRoot || null;
                const ghost = document.createElement("div");
                ghost.setAttribute("role", "presentation");
                ghost.setAttribute("aria-hidden", "true");
                if (shadow) {
                    ghost.className = "zen-download-arc-animation";
                    ghost.style.left = `${fromCx - size / 2}px`;
                    ghost.style.top = `${fromCy - size / 2}px`;
                    ghost.style.width = `${size}px`;
                    ghost.style.height = `${size}px`;
                } else {
                    // Host unavailable: same look, hand-rolled.
                    ghost.style.cssText = [
                        "position:fixed",
                        `left:${fromCx - size / 2}px`,
                        `top:${fromCy - size / 2}px`,
                        `width:${size}px`,
                        `height:${size}px`,
                        "margin:0",
                        "padding:2px",
                        "pointer-events:none",
                        "z-index:2147483646",
                        "display:flex",
                        "align-items:center",
                        "justify-content:center",
                        "border-radius:50%",
                        "box-sizing:border-box",
                        "background-color:var(--zen-colors-hover-bg)",
                        "box-shadow:var(--zen-big-shadow)",
                        "will-change:transform, opacity"
                    ].join(";");
                }
                const inner = document.createElement("div");
                if (shadow) {
                    inner.className = "zen-download-arc-animation-inner-circle";
                } else {
                    inner.style.cssText = [
                        "position:relative",
                        "width:100%",
                        "height:100%",
                        "border-radius:50%",
                        "background-color:var(--toolbar-color)",
                        "display:flex",
                        "align-items:center",
                        "justify-content:center",
                        "pointer-events:none"
                    ].join(";");
                }
                const icon = document.createElement("img");
                icon.alt = "";
                if (shadow) {
                    // Native icon is an absolutely-positioned masked layer;
                    // ours is the page favicon, centered at the same 70%.
                    icon.style.cssText = "position:absolute;inset:0;margin:auto;width:70%;height:70%;pointer-events:none;";
                } else {
                    icon.style.cssText = "width:70%;height:70%;flex:0 0 auto;pointer-events:none;";
                }
                let srcIndex = 0;
                icon.addEventListener("error", () => {
                    srcIndex += 1;
                    if (srcIndex < srcs.length) {
                        icon.src = srcs[srcIndex];
                    }
                });
                icon.src = srcs[0];
                inner.appendChild(icon);
                ghost.appendChild(inner);
                // White disc, or black when the page icon itself is very dark.
                // Sampled before launch (favicon is cached); falls back to white.
                const startFlight = () => {
                const dx = toCx - fromCx;
                const dy = toCy - fromCy;
                const distance = Math.sqrt(dx * dx + dy * dy);
                // Bow perpendicular to travel, toward whichever vertical half
                // has more room — same rule as the download animation.
                const availableTop = Math.min(fromCy, toCy);
                const availableBottom = window.innerHeight - Math.max(fromCy, toCy);
                const arcDir = availableBottom > availableTop ? 1 : -1;
                const arcHeight = Math.min(
                    distance * 0.8,
                    1200,
                    Math.max(availableBottom, availableTop) * 0.8
                );
                const easeInOutQuad = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
                const frames = [];
                for (let i = 0; i <= 60; i++) {
                    const progress = i / 60;
                    const eased = easeInOutQuad(progress);
                    let opacity;
                    if (progress < 0.3) opacity = 0.3 + (progress / 0.3) * 0.6;
                    else if (progress < 0.98) opacity = 0.9 + ((progress - 0.3) / 0.6) * 0.1;
                    else opacity = 1 - ((progress - 0.9) / 0.1);
                    let scale;
                    if (progress < 0.5) scale = 0.5 + (progress / 0.5) * 1.3;
                    else scale = 1.8 - ((progress - 0.5) / 0.5) * (1.8 - 0.45);
                    const x = dx * eased;
                    const y = dy * eased + arcDir * arcHeight * (1 - Math.pow(2 * eased - 1, 2));
                    frames.push({
                        offset: progress,
                        opacity,
                        transform: `translate(${x}px, ${y}px) scale(${scale})`
                    });
                }
                let finished = false;
                const finish = () => {
                    if (finished) return;
                    finished = true;
                    try { ghost.remove(); } catch (e) { }
                    try { this._pulseLibraryButton(); } catch (e) { }
                    done();
                };
                // motion.animate() takes Motion-One column keyframes
                // ({offset:[], opacity:[], transform:[]}) — the per-frame
                // {offset, ...} rows are WAAPI-only and freeze it solid.
                const motion = window.gZenUIManager?.motion;
                const driveMotion = () => {
                    const sequence = { offset: [], opacity: [], transform: [] };
                    for (const f of frames) {
                        sequence.offset.push(f.offset);
                        sequence.opacity.push(f.opacity);
                        sequence.transform.push(f.transform);
                    }
                    let controls = null;
                    try {
                        controls = motion.animate(ghost, sequence, {
                            duration: 0.8,
                            easing: "cubic-bezier(0.37, 0, 0.63, 1)",
                            fill: "forwards"
                        });
                    } catch (e) { controls = null; }
                    const awaitable = controls?.finished ??
                        (typeof controls?.then === "function" ? controls : null);
                    return awaitable && typeof awaitable.then === "function" ? awaitable : null;
                };
                const driveWaapi = () => {
                    const anim = ghost.animate(frames, {
                        duration: 800,
                        easing: "cubic-bezier(0.37, 0, 0.63, 1)",
                        fill: "forwards"
                    });
                    anim.onfinish = finish;
                    anim.oncancel = finish;
                };
                try {
                    if (motion?.animate) {
                        const pending = driveMotion();
                        if (pending) pending.then(finish, finish);
                        else driveWaapi();
                    } else {
                        driveWaapi();
                    }
                    setTimeout(finish, 1300);
                } catch (e) { finish(); }
                }; // startFlight
                this._sampleDiscColor(srcs[0], (discColor) => {
                    try { inner.style.backgroundColor = discColor; } catch (e) { }
                    (shadow || document.body).appendChild(ghost);
                    startFlight();
                });
            } catch (e) { done(); }
        }

        // Resolved value of a theme custom property (getComputedStyle already
        // substitutes var()/light-dark()), or the fallback when unavailable.
        _themeColor(name, fallback) {
            try {
                const value = getComputedStyle(document.documentElement).getPropertyValue(name)?.trim();
                return value || fallback;
            } catch (e) {
                return fallback;
            }
        }

        // Readable foreground for a background color: white on dark, black on
        // light. Unparseable values resolve to white (previous behavior).
        _foregroundOn(cssColor) {
            try {
                let r, g, b;
                const hex = cssColor.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
                if (hex) {
                    const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex;
                    r = parseInt(full.slice(0, 2), 16);
                    g = parseInt(full.slice(2, 4), 16);
                    b = parseInt(full.slice(4, 6), 16);
                } else {
                    const rgb = cssColor.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
                    if (!rgb) return "#fff";
                    [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
                }
                if ([r, g, b].some(v => !Number.isFinite(v))) return "#fff";
                return (0.299 * r + 0.587 * g + 0.114 * b) < 127 ? "#fff" : "#000";
            } catch (e) {
                return "#fff";
            }
        }

        // White disc, black only when the page icon itself is very dark.
        // Samples the cached favicon; any failure (tainted canvas, missing
        // icon, timeout) resolves white.
        _sampleDiscColor(src, callback) {
            let settled = false;
            const resolve = (color) => {
                if (settled) return;
                settled = true;
                try { callback(color); } catch (e) { }
            };
            const timer = setTimeout(() => resolve("#fff"), 250);
            try {
                if (!src || src === "chrome://browser/skin/bookmark.svg") {
                    clearTimeout(timer);
                    resolve("#fff");
                    return;
                }
                const probe = new Image();
                probe.addEventListener("load", () => {
                    try {
                        const size = 16;
                        const canvas = document.createElement("canvas");
                        canvas.width = size;
                        canvas.height = size;
                        const ctx = canvas.getContext("2d", { willReadFrequently: true });
                        ctx.drawImage(probe, 0, 0, size, size);
                        const data = ctx.getImageData(0, 0, size, size).data;
                        let total = 0;
                        let count = 0;
                        for (let i = 0; i < data.length; i += 4) {
                            if (data[i + 3] < 32) continue;
                            total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                            count += 1;
                        }
                        clearTimeout(timer);
                        resolve(count > 0 && total / count < 90 ? "#000" : "#fff");
                    } catch (e) {
                        clearTimeout(timer);
                        resolve("#fff");
                    }
                });
                probe.addEventListener("error", () => {
                    clearTimeout(timer);
                    resolve("#fff");
                });
                probe.src = src;
            } catch (e) {
                clearTimeout(timer);
                resolve("#fff");
            }
        }

        // Landing celebration: replays the button's own hover animation by
        // toggling .arrive (hover start), then removing it (hover stop replays
        // the unhover frames). No WAAPI transform — scaling the host fought
        // the sprite animation.
        _pulseLibraryButton() {
            const btn = document.getElementById("zen-library-button");
            if (!btn?.classList) return;
            try {
                clearTimeout(this._libraryPulseTimer);
                // Re-adding the same class is a no-op without a restyle flush.
                btn.classList.remove("arrive");
                void btn.offsetWidth;
                btn.classList.add("arrive");
                this._libraryPulseTimer = setTimeout(() => {
                    this._libraryPulseTimer = null;
                    try { btn.classList.remove("arrive"); } catch (e) { }
                }, 700);
            } catch (e) { }
        }

        _showBookmarkSavedToast(guid, count = 1, options = {}) {
            try {
                const container = document.getElementById("zen-toast-container");
                if (!container) return;
                const wrapper = document.createXULElement("hbox");
                wrapper.classList.add("zen-toast");
                wrapper.style.cssText = "align-items:center;gap:10px;padding:10px 12px;cursor:pointer;";
                const texts = document.createXULElement("vbox");
                texts.style.cssText = "flex:1;min-width:0;";
                const title = document.createXULElement("label");
                title.textContent = options.titleText || (count > 1 ? `${count} tabs saved` : "Tab saved");
                title.setAttribute("crop", "end");
                title.style.cssText = "font-weight:600;font-size:1.05em;margin:0;max-width:280px;";
                const body = document.createXULElement("label");
                body.textContent = options.bodyText || "Open library to easily view your bookmarks";
                body.setAttribute("crop", "end");
                body.style.cssText = "opacity:0.75;font-size:0.9em;margin:0;max-width:280px;";
                texts.appendChild(title);
                texts.appendChild(body);
                wrapper.appendChild(texts);
                const edit = document.createElement("div");
                edit.title = "Edit bookmark";
                edit.setAttribute("aria-label", "Edit bookmark");
                // Foreground follows the theme: white icon on dark primary,
                // black icon on light primary (never hardcoded).
                edit.style.color = this._foregroundOn(
                    this._themeColor("--zen-primary-color", "#0060df"));
                edit.style.cssText += "background:var(--zen-primary-color, #0060df);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;";
                // Same paintbrush glyph the Spaces section uses for its edit
                // buttons (spaces.css .library-workspace-edit-button div).
                const editIcon = document.createElement("div");
                editIcon.style.cssText = "width:14px;height:14px;background-color:currentColor;" +
                    "mask:url(\"chrome://browser/skin/zen-icons/paintbrush-fill.svg\") no-repeat center / contain;" +
                    "pointer-events:none;";
                edit.appendChild(editIcon);
                wrapper.appendChild(edit);
                let dismissed = false;
                let timeoutId = null;
                const dismiss = () => {
                    if (dismissed) return;
                    dismissed = true;
                    if (timeoutId) clearTimeout(timeoutId);
                    const remove = () => {
                        try { wrapper.remove(); } catch (e) { }
                        try { if (!container.children.length) container.setAttribute("hidden", "true"); } catch (e) { }
                    };
                    try {
                        if (window.gZenUIManager?.motion?.animate) {
                            window.gZenUIManager.motion.animate(wrapper,
                                { opacity: [1, 0], scale: [1, 0.5] }, { duration: 0.2, bounce: 0 })
                                .then(remove, remove);
                        } else {
                            remove();
                        }
                    } catch (e) { remove(); }
                };
                edit.addEventListener("click", (e) => {
                    e.stopPropagation();
                    dismiss();
                    try { this._editBookmark({ guid }); } catch (err) { }
                });
                wrapper.addEventListener("click", () => {
                    dismiss();
                    try {
                        const integration = window.gZenLibraryBookmarksIntegration;
                        if (integration?._isNativeLibrary?.()) integration._scheduleOpenNativeBookmarks?.();
                        else window.gZenLibrary?.openTab?.("bookmarks");
                    } catch (e) { }
                });
                container.removeAttribute("hidden");
                container.appendChild(wrapper);
                try {
                    if (window.gZenUIManager?.motion?.animate) {
                        wrapper.style.transform = "scale(0)";
                        window.gZenUIManager.motion.animate(wrapper, { scale: 1 }, { type: "spring", bounce: 0.2, duration: 0.5 });
                    }
                } catch (e) { }
                timeoutId = setTimeout(dismiss, 5000);
                wrapper.addEventListener("mouseover", () => { if (timeoutId) clearTimeout(timeoutId); });
                wrapper.addEventListener("mouseout", () => {
                    if (!dismissed) timeoutId = setTimeout(dismiss, 5000);
                });
            } catch (e) { }
        }

        _showFilterTagContextMenu(event, tag) {
            document.getElementById("zen-bookmarks-filter-tag-menu")?.remove();
            const popup = document.createXULElement("menupopup");
            popup.id = "zen-bookmarks-filter-tag-menu";
            const rename = document.createXULElement("menuitem");
            rename.setAttribute("label", "Rename tag...");
            rename.addEventListener("command", () => this._renameTagEverywhere(tag), { once: true });
            popup.appendChild(rename);
            const del = document.createXULElement("menuitem");
            del.setAttribute("label", "Delete tag");
            del.addEventListener("command", () => this._deleteTagEverywhere(tag), { once: true });
            popup.appendChild(del);
            popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
            (document.getElementById("mainPopupSet") || document.body).appendChild(popup);
            popup.openPopupAtScreen(event.screenX, event.screenY, true);
        }

        async _renameTagEverywhere(oldTag) {
            const input = { value: oldTag };
            const ok = Services.prompt.prompt(window, "Rename tag", "New tag name:", input, null, {});
            if (!ok) return;
            const newTag = this._normalizeTag(input.value || "");
            if (!newTag || newTag === oldTag) return;
            await this._retagEverywhere(oldTag, newTag);
        }

        async _deleteTagEverywhere(tag) {
            const ok = Services.prompt.confirm(window, "Delete tag", `Remove "${tag}" from all bookmarks?`);
            if (!ok) return;
            await this._retagEverywhere(tag, null);
        }

        async _retagEverywhere(oldTag, newTag) {
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                const uris = await this._urisForTag(oldTag);
                this._markSelfMutating();
                for (const uri of uris) {
                    try {
                        const current = PlacesUtils.tagging.getTagsForURI(uri) || [];
                        const next = [];
                        for (const tag of current) {
                            if (tag === oldTag) {
                                if (newTag && !next.includes(newTag)) next.push(newTag);
                            } else if (!next.includes(tag)) {
                                next.push(tag);
                            }
                        }
                        PlacesUtils.tagging.untagURI(uri, null);
                        if (next.length) PlacesUtils.tagging.tagURI(uri, next);
                    } catch (e) { }
                }
                if (this._activeTags.has(oldTag)) {
                    this._activeTags.delete(oldTag);
                    if (newTag) this._activeTags.add(newTag);
                }
                await this.renderList();
            } catch (e) {
                console.error("[ZenLibrary Bookmarks] tag rename/delete failed:", e);
            }
        }

        async _urisForTag(tag) {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            const roots = [
                PlacesUtils.bookmarks.toolbarGuid,
                PlacesUtils.bookmarks.menuGuid,
                PlacesUtils.bookmarks.unfiledGuid,
                PlacesUtils.bookmarks.mobileGuid
            ];
            const urls = new Set();
            const walk = (node) => {
                const url = node?.uri || node?.url?.href || node?.url || "";
                if (url) urls.add(String(url));
                for (const child of node?.children || []) walk(child);
            };
            for (const root of roots) {
                const tree = await PlacesUtils.promiseBookmarksTree(root, { includeItemIds: true }).catch(() => null);
                if (tree) walk(tree);
            }
            const uris = [];
            for (const url of urls) {
                try {
                    const uri = Services.io.newURI(url);
                    const tags = PlacesUtils.tagging.getTagsForURI(uri) || [];
                    if (tags.includes(tag)) uris.push(uri);
                } catch (e) { }
            }
            return uris;
        }

        _showTagMenu(event, node) {
            document.getElementById("zen-bookmarks-tag-menu")?.remove();
            if (!node?.url) return;
            const popup = document.createXULElement("menupopup");
            popup.id = "zen-bookmarks-tag-menu";
            const known = new Set(this._knownTags || []);
            for (const tag of node.tags || []) known.add(tag);
            for (const tag of Array.from(known).sort((a, b) => a.localeCompare(b))) {
                const item = document.createXULElement("menuitem");
                item.setAttribute("label", tag);
                item.setAttribute("type", "checkbox");
                if ((node.tags || []).includes(tag)) item.setAttribute("checked", "true");
                item.addEventListener("command", () => {
                    const current = new Set(node.tags || []);
                    if (current.has(tag)) current.delete(tag);
                    else current.add(tag);
                    this._writeTags(node, Array.from(current));
                }, { once: true });
                popup.appendChild(item);
            }
            if (popup.childElementCount) popup.appendChild(document.createXULElement("menuseparator"));
            const edit = document.createXULElement("menuitem");
            edit.setAttribute("label", "Edit bookmark...");
            edit.addEventListener("command", () => this._editBookmark(node), { once: true });
            popup.appendChild(edit);
            popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
            (document.getElementById("mainPopupSet") || document.body).appendChild(popup);
            popup.openPopup(event.currentTarget, "after_start");
        }

        async _writeTags(node, tags) {
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                const uri = Services.io.newURI(node.url);
                PlacesUtils.tagging.untagURI(uri, null);
                const clean = Array.from(new Set(tags.map(tag => tag.trim()).filter(Boolean)));
                if (clean.length) PlacesUtils.tagging.tagURI(uri, clean);
                this._markSelfMutating();
                this.renderList();
            } catch (e) { console.error("[ZenLibrary Bookmarks] tag edit failed:", e); }
        }

        async _addFolder(node) {
            try {
                const title = prompt("Folder name", "New Folder");
                if (title == null) return;
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                const parentGuid = node.isFolder ? node.guid : node.parentGuid;
                const index = node.isFolder ? PlacesUtils.bookmarks.DEFAULT_INDEX : node.index + 1;
                this._markSelfMutating();
                await PlacesUtils.bookmarks.insert({ type: PlacesUtils.bookmarks.TYPE_FOLDER, parentGuid, index, title });
                this.renderList();
            } catch (e) { console.error("[ZenLibrary Bookmarks] add folder failed:", e); }
        }

        async _addSeparatorBelow(node) {
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                const parentGuid = node.isFolder ? node.guid : node.parentGuid;
                const index = node.isFolder ? PlacesUtils.bookmarks.DEFAULT_INDEX : node.index + 1;
                this._markSelfMutating();
                await PlacesUtils.bookmarks.insert({ type: PlacesUtils.bookmarks.TYPE_SEPARATOR, parentGuid, index });
                this.renderList();
            } catch (e) { console.error("[ZenLibrary Bookmarks] add separator failed:", e); }
        }

        // Moves every child up into the folder's parent (in order, where the
        // folder sat) and removes the now-empty folder. An empty folder is
        // just deleted. System roots parent to the Places root and refuse.
        async _ungroupFolder(node) {
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                if (!node?.isFolder || !node.parentGuid || node.parentGuid === PlacesUtils.bookmarks.rootGuid) return;
                const tree = await PlacesUtils.promiseBookmarksTree(node.guid, { includeItemIds: true });
                const children = tree?.children || [];
                this._markSelfMutating();
                let index = Number.isFinite(node.index) ? node.index : PlacesUtils.bookmarks.DEFAULT_INDEX;
                for (const child of children) {
                    if (!child?.guid) continue;
                    await PlacesUtils.bookmarks.update({ guid: child.guid, parentGuid: node.parentGuid, index });
                    index += 1;
                }
                await PlacesUtils.bookmarks.remove(node.guid);
                this.renderList();
            } catch (e) { console.error("[ZenLibrary Bookmarks] ungroup folder failed:", e); }
        }

        async _delete(node) {
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                this._markSelfMutating();
                await PlacesUtils.bookmarks.remove(node.guid);
                this.renderList();
            } catch (e) { console.error("[ZenLibrary Bookmarks] delete failed:", e); }
        }

        destroy() {
            this._unwatchPlaces();
            this._unwatchAdded();
            this._unwatchLibraryDrop();
            this._clearSmartSaveTooltip();
            try { clearTimeout(this._libraryPulseTimer); } catch (e) { }
            this._libraryPulseTimer = null;
            this._searchDebounce?.cancel();
            clearTimeout(this._searchDebounce);
            this._searchDebounce = null;
            this.library?.style?.setProperty("--zen-library-filter-height", "0px");
            document.getElementById("zen-bookmarks-context-menu")?.remove();
            document.getElementById("zen-bookmarks-tag-menu")?.remove();
            this._clearDragState();
            this._container = null;
        }
    }

    class ZenLibraryBookmarksIntegration {
        static MASTER_PREF = "zen.bookmarks.enabled";

        constructor() {
            this._registered = false;
            this._retryTimer = null;
            this._sidebarBoxObserver = null;
            this._nativeLibraryObserver = null;
            this._nativeHostObservers = new Map();
            this._nativeReady = false;
            this._nativeOpenTimer = null;
            this._nativeCommandObserver = null;
            this._lastSidebarKeyAt = 0;
            this._showAllBookmarksCommand = null;
            this._addBookmarkCommands = new Set();
            this._bookmarksModule = null;
            this._initialized = false;
            this._masterPrefObserver = null;
            this._onKeyDown = this._onKeyDown.bind(this);
            this._onShowAllBookmarksCommand = this._onShowAllBookmarksCommand.bind(this);
            this._onAddBookmarkCommand = this._onAddBookmarkCommand.bind(this);
            this._onUnload = this._onUnload.bind(this);
            this._onLibraryReady = this._registerWhenReady.bind(this);
            this._watchMasterPref();
            if (!this._anyFeatureEnabled()) {
                this._debug("all features off; integration dormant");
                return;
            }
            this.init();
        }

        // True when at least one Library Tweaks feature wants to run. The easels
        // half arrives via a later script, so its check is optional-chained.
        _anyFeatureEnabled() {
            if (this._isMasterEnabled()) return true;
            try {
                if (typeof this._isEaselsEnabled === "function" && this._isEaselsEnabled()) return true;
                if (typeof this._isMediaEnabled === "function" && this._isMediaEnabled()) return true;
            } catch (e) { }
            return false;
        }

        _isMasterEnabled() {
            try {
                return Services.prefs.getBoolPref(
                    ZenLibraryBookmarksIntegration.MASTER_PREF, true);
            } catch (e) {
                return true;
            }
        }

        _watchMasterPref() {
            if (this._masterPrefObserver) return;
            this._masterPrefObserver = {
                observe: () => this._onMasterPrefChanged(),
            };
            try {
                Services.prefs.addObserver(
                    ZenLibraryBookmarksIntegration.MASTER_PREF, this._masterPrefObserver);
            } catch (e) {
                this._masterPrefObserver = null;
            }
        }

        _unwatchMasterPref() {
            if (!this._masterPrefObserver) return;
            try {
                Services.prefs.removeObserver(
                    ZenLibraryBookmarksIntegration.MASTER_PREF, this._masterPrefObserver);
            } catch (e) { }
            this._masterPrefObserver = null;
        }

        _onMasterPrefChanged() {
            if (this._isMasterEnabled()) {
                this._debug("saves toggle on");
                if (!this._initialized) {
                    this.init();
                    return;
                }
                this._registerWhenReady();
                this._watchAddBookmarkCommands();
                this._ensureUrlbarProvider();
                for (const host of Array.from(this._nativeHostObservers.keys())) {
                    try { this._registerNativeSections(host); } catch (e) { }
                }
                return;
            }
            this._debug("saves toggle off; unregistering saves");
            this._unregisterSavesSections();
            if (!this._anyFeatureEnabled()) {
                this._unregisterAllSections();
                this._shutdown();
            }
        }

        // Removes our tabs from both libraries without dropping the pref watchers,
        // so re-enabling re-registers from a clean slate.
        _unregisterAllSections() {
            this._unregisterSavesSections();
            try { this._easelsUnregister?.(); } catch (e) { }
            try { this._mediaUnregister?.(); } catch (e) { }
        }

        _unregisterSavesSections() {
            try {
                if (this._registered) {
                    window.ZenLibrarySections?.unregister?.("bookmarks");
                }
            } catch (e) { }
            this._registered = false;
            for (const host of Array.from(this._nativeHostObservers.keys())) {
                try {
                    const sections = host?.zenLibrarySections;
                    if (sections?.bookmarks &&
                        sections.bookmarks === window.ZenLibraryBookmarksSection) {
                        delete sections.bookmarks;
                    }
                    if (host?.activeTab === "bookmarks") host.activeTab = "history";
                } catch (e) { }
                try { host?.requestUpdate?.(); } catch (e) { }
            }
        }

        _debug(...args) {
            try {
                const enabled = Services.prefs.getBoolPref("zen.bookmarks.debug", true);
                if (enabled) console.log("[ZenLibraryBookmarks]", ...args);
            } catch (e) {
                console.log("[ZenLibraryBookmarks]", ...args);
            }
        }

        init() {
            if (this._initialized) return;
            this._initialized = true;
            this._debug("integration init", {
                hasZenLibrarySections: !!window.ZenLibrarySections?.register,
                hasNativeElement: !!customElements.get("zen-library"),
                hasLibraryButton: !!document.getElementById("zen-library-button"),
            });
            window.addEventListener("unload", this._onUnload, { once: true });
            window.addEventListener("keydown", this._onKeyDown, true);
            window.addEventListener("ZenLibrarySectionsReady", this._onLibraryReady);
            this._watchShowAllBookmarksCommand();
            this._watchNativeLibraryCommandNodes();
            this._watchBookmarksSidebar();
            if (this._isMasterEnabled()) {
                this._registerWhenReady();
                this._watchAddBookmarkCommands();
                this._ensureUrlbarProvider();
            }
            this._registerNativeWhenReady();
            try { this._easelsInit?.(); } catch (e) { }
            try { this._mediaInit?.(); } catch (e) { }
        }

        // Fallback registration for the NL urlbar provider: Sine imports
        // background/*.sys.mjs once per process, but if that import ever misses,
        // importing the module here runs its top-level install (module evaluation
        // is cached per URL, so this is a no-op when already installed).
        _ensureUrlbarProvider() {
            try {
                ChromeUtils.importESModule("chrome://sine/content/library-tweaks/background/urlbar.sys.mjs");
            } catch (e) {
                console.error("[ZenLibraryBookmarks] urlbar provider fallback failed:", e);
            }
        }

        _registerWhenReady() {
            if (!this._isMasterEnabled()) return;
            if (window.ZenLibrarySections?.register) {
                this._debug("legacy ZenLibrarySections register path");
                if (this._retryTimer) {
                    clearTimeout(this._retryTimer);
                    this._retryTimer = null;
                }
                this._registered = true;
                window.ZenLibrarySections.register("bookmarks", {
                    global: "ZenLibraryBookmarks",
                    label: "Saves",
                    hidden: false,
                    containerSelector: ".library-list-container",
                    iconSvg: this._bookmarksIconSvg(),
                    styles: ["chrome://sine/content/library-tweaks/features/saves.css"]
                });
                this._ensureBookmarksModule();
                this._watchAddBookmarkCommands();
                return;
            }
            if (this._retryTimer) return;
            // The custom library mod is disabled in most setups, so this path can
            // never succeed: retry briefly, then stop instead of spinning forever.
            this._legacyRetries = (this._legacyRetries || 0) + 1;
            if (this._legacyRetries > 40) {
                this._debug("legacy ZenLibrarySections absent; giving up");
                return;
            }
            this._debug("legacy ZenLibrarySections not ready; retrying");
            this._retryTimer = setTimeout(() => {
                this._retryTimer = null;
                this._registerWhenReady();
            }, 250);
        }

        _registerNativeWhenReady() {
            if (!this._anyFeatureEnabled()) return false;
            if (this._nativeReady) {
                this._debug("native library already ready");
                return true;
            }
            const ctor = customElements.get("zen-library");
            if (!ctor) {
                this._debug("native zen-library custom element not defined yet");
                if (!this._nativeWhenDefinedHooked) {
                    this._nativeWhenDefinedHooked = true;
                    try {
                        customElements.whenDefined("zen-library")
                            .then(() => {
                                this._debug("native zen-library custom element defined");
                                this._registerNativeWhenReady();
                            })
                            .catch(err => this._debug("native whenDefined failed", err));
                    } catch (e) {}
                }
                return false;
            }
            this._nativeReady = true;
            this._debug("native library ready", {
                ctorName: ctor.name,
                hasGetInstance: typeof ctor.getInstance === "function",
                hasToggle: typeof ctor.toggle === "function",
            });
            this._patchNativeGetInstance();
            this._watchNativeLibraries();
            return true;
        }

        _watchNativeLibraries() {
            this._connectExistingNativeLibraries();
            if (this._nativeLibraryObserver) return;
            this._nativeLibraryObserver = new MutationObserver(() => this._connectExistingNativeLibraries());
            try {
                this._nativeLibraryObserver.observe(document.documentElement, { childList: true, subtree: true });
                this._debug("watching document for native zen-library hosts");
            } catch (e) {
                this._debug("failed to observe native library hosts", e);
                this._nativeLibraryObserver = null;
            }
        }

        _connectExistingNativeLibraries() {
            const hosts = Array.from(document.querySelectorAll?.("zen-library") || []);
            if (hosts.length) this._debug("connect existing native libraries", { count: hosts.length });
            for (const host of hosts) {
                this._connectNativeLibrary(host);
            }
        }

        _connectNativeLibrary(host) {
            if (!host || this._nativeHostObservers.has(host)) {
                if (host) {
                    this._debug("sync existing native host", this._describeNativeHost(host));
                    this._registerNativeSections(host);
                    this._syncNativeLibrary(host);
                }
                return;
            }
            this._debug("connect native host", this._describeNativeHost(host));
            this._registerNativeSections(host);
            const sync = () => this._syncNativeLibrary(host);
            const observer = new MutationObserver(() => {
                if (host._zenBookmarksSyncPending) return;
                host._zenBookmarksSyncPending = true;
                requestAnimationFrame(() => {
                    host._zenBookmarksSyncPending = false;
                    sync();
                });
            });
            this._nativeHostObservers.set(host, observer);
            try {
                observer.observe(host.shadowRoot || host, { childList: true, subtree: true });
            } catch (e) {
                this._debug("failed to observe native host", e);
                this._nativeHostObservers.delete(host);
            }
            sync();
        }

        _describeNativeHost(host) {
            const root = this._nativeRoot(host);
            return {
                isConnected: !!host?.isConnected,
                hasShadowRoot: !!host?.shadowRoot,
                activeTab: host?.activeTab || host?.getAttribute?.("active-tab") || "",
                sectionKeys: Object.keys(host?.zenLibrarySections || {}),
                rootChildren: root ? Array.from(root.children || []).map(el => el.localName || el.tagName).slice(0, 8) : [],
                sidebarCount: root?.querySelectorAll?.("[class*='sidebar'], .sidebar-button")?.length || 0,
                contentCount: root?.querySelectorAll?.("[class*='content'], #zen-library-main-panel")?.length || 0,
            };
        }

        // Native contract (moz-src:///zen/library/ZenLibrary.mjs): zenLibrarySections
        // maps id -> Section CLASS. Native renders the sidebar from
        // `Object.values(sections).map(Section => Section.id / Section.label)` and the
        // content via `this.activeSection.render(this)` (a STATIC method returning a
        // lit TemplateResult). A metadata-only object without render() crashes every
        // Lit update with "this.activeSection.render is not a function", so what is
        // registered here must be a class shaped exactly like the built-ins
        // (ZenLibraryHistorySection & co).
        _nativeHtml() {
            if (this._nativeHtmlTag !== undefined) return this._nativeHtmlTag;
            let tag = null;
            try {
                const lit = ChromeUtils.importESModule("chrome://global/content/vendor/lit.all.mjs");
                if (lit && typeof lit.html === "function") tag = lit.html;
            } catch (e) {
                tag = null;
            }
            this._nativeHtmlTag = tag;
            return tag;
        }

        _defineNativeSectionElement() {
            if (customElements.get("zen-library-bookmarks-section")) return true;
            const integration = this;
            class ZenLibraryBookmarksSectionElement extends HTMLElement {
                constructor() {
                    super();
                    this._zenBookmarksMounted = false;
                    this._zenBookmarksLibrary = null;
                }
                set library(value) { this._zenBookmarksLibrary = value; }
                get library() { return this._zenBookmarksLibrary; }
                connectedCallback() {
                    if (this._zenBookmarksMounted) return;
                    this._zenBookmarksMounted = true;
                    try { this.classList.add("zen-library-section"); } catch (e) { }
                    try { this.dataset.section = "bookmarks"; } catch (e) { }
                    const module = integration._ensureBookmarksModule();
                    if (!module) {
                        this.replaceChildren(document.createTextNode("Bookmarks unavailable"));
                        return;
                    }
                    try {
                        module.library = integration._nativeModuleShell(this);
                        this.replaceChildren();
                        let header = null;
                        try { header = module.renderHeaderControls(); }
                        catch (e) { console.error("[ZenLibraryBookmarks] header failed:", e); }
                        if (header) this.appendChild(header);
                        let list = null;
                        try { list = module.render(); }
                        catch (e) { console.error("[ZenLibraryBookmarks] list failed:", e); }
                        if (list) {
                            try { list.classList.add("zen-library-search-results"); } catch (e) { }
                            this.appendChild(list);
                        }
                    } catch (e) {
                        console.error("[ZenLibraryBookmarks] native mount failed:", e);
                    }
                }
                disconnectedCallback() {
                    // Abort any in-flight list render so it cannot clobber the next mount.
                    try {
                        const module = integration._bookmarksModule;
                        if (module) module._renderToken = {};
                    } catch (e) { }
                }
            }
            try {
                customElements.define("zen-library-bookmarks-section", ZenLibraryBookmarksSectionElement);
                return true;
            } catch (e) {
                this._debug("failed to define bookmarks section element", e);
                return !!customElements.get("zen-library-bookmarks-section");
            }
        }

        _nativeSectionClass() {
            if (window.ZenLibraryBookmarksSection &&
                typeof window.ZenLibraryBookmarksSection.render === "function") {
                return window.ZenLibraryBookmarksSection;
            }
            const integration = this;
            class ZenLibraryBookmarksSection {
                static render(library) {
                    const html = integration._nativeHtml();
                    if (html) {
                        return html`<zen-library-bookmarks-section class="zen-library-section" data-section="bookmarks" .library=${library}></zen-library-bookmarks-section>`;
                    }
                    // Fallback: Lit can insert a plain Node in a child expression.
                    const el = document.createElement("zen-library-bookmarks-section");
                    try { el.library = library; } catch (e) { }
                    return el;
                }
            }
            ZenLibraryBookmarksSection.id = "bookmarks";
            // No upstream Fluent string exists for Saves; the sidebar label element is
            // patched to text post-render (see _patchNativeSidebarLabel).
            ZenLibraryBookmarksSection.label = "zen-library-bookmarks-section-title";
            window.ZenLibraryBookmarksSection = ZenLibraryBookmarksSection;
            return ZenLibraryBookmarksSection;
        }

        // Registers every enabled feature section on a native host. Per-feature
        // methods are optional-chained: the easels/media halves load later.
        _registerNativeSections(host) {
            try { this._registerNativeSectionObject(host); } catch (e) { }
            try { this._easelsRegister?.(host); } catch (e) { }
            try { this._mediaRegister?.(host); } catch (e) { }
            try { if (this._applySidebarOrder(host)) host.requestUpdate?.(); } catch (e) { }
        }

        /* --------------------------------------- sidebar drag-to-reorder */

        static SIDEBAR_REORDER_PREF = "zen.library.tweaks.sidebar.reorder";
        static SIDEBAR_ORDER_PREF = "zen.library.tweaks.sidebar.order";

        _isReorderEnabled() {
            try {
                return Services.prefs.getBoolPref(
                    ZenLibraryBookmarksIntegration.SIDEBAR_REORDER_PREF, true);
            } catch (e) {
                return true;
            }
        }

        _readSidebarOrder() {
            try {
                const raw = Services.prefs.getStringPref(
                    ZenLibraryBookmarksIntegration.SIDEBAR_ORDER_PREF, "");
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) return null;
                const ids = parsed.filter(id => typeof id === "string" && id);
                return ids.length ? ids : null;
            } catch (e) {
                return null;
            }
        }

        _saveSidebarOrder(ids) {
            try {
                Services.prefs.setStringPref(
                    ZenLibraryBookmarksIntegration.SIDEBAR_ORDER_PREF,
                    JSON.stringify(ids));
            } catch (e) { }
        }

        // Native renders tabs in zenLibrarySections insertion order, so arranging
        // is re-inserting the keys in order: saved ids first, anything new
        // appended. Unknown saved ids (a disabled feature) are skipped, never
        // resurrected. The map object itself is MUTATED, never replaced — native
        // internals may hold the original reference.
        _applySidebarOrder(host) {
            const sections = host?.zenLibrarySections;
            if (!sections || typeof sections !== "object") return false;
            const saved = this._readSidebarOrder();
            if (!saved?.length) return false;
            const current = Object.keys(sections);
            const ordered = [
                ...saved.filter(id => id in sections),
                ...current.filter(id => !saved.includes(id)),
            ];
            if (ordered.join("\n") === current.join("\n")) return false;
            const refs = {};
            for (const id of ordered) refs[id] = sections[id];
            for (const id of current) delete sections[id];
            for (const id of ordered) sections[id] = refs[id];
            return true;
        }

        _moveSidebarSection(host, draggedId, targetId, before) {
            const sections = host?.zenLibrarySections;
            if (!sections || !sections[draggedId] || !sections[targetId]) return false;
            if (draggedId === targetId) return false;
            const ids = Object.keys(sections).filter(id => id !== draggedId);
            let index = ids.indexOf(targetId);
            if (index === -1) index = ids.length;
            else if (!before) index += 1;
            ids.splice(index, 0, draggedId);
            const refs = {};
            for (const id of ids) refs[id] = sections[id];
            for (const id of Object.keys(sections)) delete sections[id];
            for (const id of ids) sections[id] = refs[id];
            this._saveSidebarOrder(ids);
            try { host.requestUpdate?.(); } catch (e) { }
            return true;
        }

        _syncSidebarDnD(host) {
            try { this._ensureSidebarDnD(host); } catch (e) { }
            // Lit may recreate tabs and the pref may have flipped: keep flags true.
            try {
                const on = this._isReorderEnabled();
                for (const tab of this._nativeRoot(host)?.querySelectorAll?.(".zen-library-tab") || []) {
                    if (!!tab.draggable !== on) tab.draggable = on;
                }
            } catch (e) { }
        }

        _ensureSidebarDnD(host) {
            if (!host || host._zenSidebarDndHook) return;
            const root = this._nativeRoot(host);
            const container = root?.querySelector?.("#zen-library-sidebar-tabs") ||
                root?.querySelector?.(".zen-library-tab")?.parentNode || null;
            if (!container) return;
            host._zenSidebarDndHook = true;
            const tabOf = (event) => {
                try { return event.target?.closest?.(".zen-library-tab") || null; }
                catch (e) { return null; }
            };
            const clearIndicators = () => {
                try {
                    for (const t of container.querySelectorAll(
                        ".zen-library-tab[drop-before], .zen-library-tab[drop-after], .zen-library-tab[dragging-tab]"
                    )) {
                        t.removeAttribute("drop-before");
                        t.removeAttribute("drop-after");
                        t.removeAttribute("dragging-tab");
                    }
                } catch (e) { }
                host._zenTabDropTarget = null;
            };
            container.addEventListener("dragstart", (event) => {
                if (!this._isReorderEnabled()) return;
                const id = tabOf(event)?.dataset?.section;
                if (!id || !host.zenLibrarySections?.[id]) return;
                host._zenTabDragId = id;
                try {
                    event.dataTransfer.setData("application/x-zen-library-tab", id);
                    event.dataTransfer.effectAllowed = "move";
                } catch (e) { }
                try { tabOf(event)?.setAttribute?.("dragging-tab", ""); } catch (e) { }
            });
            container.addEventListener("dragover", (event) => {
                if (!this._isReorderEnabled() || !host._zenTabDragId) return;
                const tab = tabOf(event);
                if (!tab) return;
                event.preventDefault();
                try { event.dataTransfer.dropEffect = "move"; } catch (e) { }
                const targetId = tab.dataset?.section;
                if (!targetId || targetId === host._zenTabDragId) {
                    clearIndicators();
                    return;
                }
                const rect = tab.getBoundingClientRect();
                const before = event.clientY < rect.top + rect.height / 2;
                clearIndicators();
                try { tab.toggleAttribute(before ? "drop-before" : "drop-after", true); } catch (e) { }
                host._zenTabDropTarget = { id: targetId, before };
            });
            container.addEventListener("dragleave", (event) => {
                try {
                    if (!container.contains(event.relatedTarget)) clearIndicators();
                } catch (e) { }
            });
            container.addEventListener("drop", (event) => {
                const dragId = host._zenTabDragId;
                const target = host._zenTabDropTarget;
                if (!this._isReorderEnabled() || !dragId || !target) return;
                event.preventDefault();
                event.stopPropagation();
                host._zenTabJustDroppedAt = Date.now();
                clearIndicators();
                host._zenTabDragId = null;
                host._zenTabDropTarget = null;
                this._moveSidebarSection(host, dragId, target.id, target.before);
            });
            container.addEventListener("dragend", () => {
                clearIndicators();
                host._zenTabDragId = null;
                host._zenTabDropTarget = null;
            });
            // A drop is usually followed by a click that Lit would read as a tab
            // switch; swallow it when it immediately follows a reorder.
            container.addEventListener("click", (event) => {
                if (Date.now() - (host._zenTabJustDroppedAt || 0) < 400) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }, true);
        }

        _registerNativeSectionObject(host) {
            if (!this._isMasterEnabled()) return false;
            if (!host) return false;
            this._defineNativeSectionElement();
            const sections = host.zenLibrarySections;
            if (!sections || typeof sections !== "object") {
                this._debug("native host has no zenLibrarySections; skipping registration", this._describeNativeHost(host));
                return false;
            }
            const SectionClass = this._nativeSectionClass();
            let changed = false;
            if (sections.bookmarks !== SectionClass) {
                if (sections.bookmarks) {
                    this._debug("replacing native bookmarks section without valid render");
                }
                sections.bookmarks = SectionClass;
                changed = true;
            }
            if (this._sanitizeNativeTab(host)) changed = true;
            this._patchNativeSidebarLabel(host);
            // Only nudge Lit when something actually changed; otherwise the
            // host observer below would ping-pong updates forever.
            if (changed) {
                this._debug("registered native bookmarks section", { keys: Object.keys(sections) });
                try { host.requestUpdate?.(); } catch (e) { }
            }
            return true;
        }

        // Returns true when it moved the tab. Native crashes inside render() when
        // activeTab names a section without render() — e.g. a "bookmarks" value
        // persisted by an earlier build on an instance that lost our key — so an
        // unrenderable tab is always folded back to one that renders.
        _sanitizeNativeTab(host) {
            try {
                const sections = host?.zenLibrarySections;
                if (!sections) return false;
                const tab = host.activeTab;
                const section = tab && sections[tab];
                if (section && typeof section.render === "function") return false;
                const fallback = sections.history && typeof sections.history.render === "function"
                    ? "history"
                    : Object.keys(sections)[0];
                if (fallback && tab !== fallback) {
                    this._debug("sanitizing native activeTab", { from: tab, to: fallback });
                    host.activeTab = fallback;
                    return true;
                }
            } catch (e) {
                this._debug("sanitize native tab failed", e);
            }
            return false;
        }

        // Old-mod Saves glyph: the sprite box is hidden and the folder+ribbon SVG
        // (same markup as the custom library sidebar) is injected in its place.
        // Bounce/ribbon keyframes are carried over from the custom mod's core.css;
        // native marks the selected tab with [active] instead of .active.
        _nativeBookmarksTabIcon() {
            try {
                const parser = new DOMParser();
                const doc = parser.parseFromString(this._bookmarksIconSvg(), "image/svg+xml");
                const node = doc.documentElement;
                if (!node || node.localName !== "svg") return null;
                node.removeAttribute("xmlns");
                return node;
            } catch (e) {
                return null;
            }
        }

        // Native tabs use a 36-frame sprite; Saves ships a static glyph, and its
        // Fluent id does not exist upstream, so fix the rendered tab in place.
        // Lit skips rewriting unchanged bindings, so removing data-l10n-id sticks.
        _patchNativeSidebarLabel(host) {
            try {
                const root = this._nativeRoot(host);
                const tab = root?.querySelector?.('.zen-library-tab[data-section="bookmarks"]');
                if (!tab) return false;
                const label = tab.querySelector?.("label");
                if (!label) return false;
                let touched = false;
                if (label.textContent !== "Saves") {
                    label.textContent = "Saves";
                    touched = true;
                }
                if (label.hasAttribute("data-l10n-id")) {
                    label.removeAttribute("data-l10n-id");
                    touched = true;
                }
                // Same folder+ribbon glyph the custom library sidebar used.
                const iconBox = tab.querySelector?.(".zen-library-tab-icon");
                if (iconBox && !iconBox.querySelector(".zen-bookmarks-icon")) {
                    const icon = this._nativeBookmarksTabIcon();
                    if (icon) iconBox.replaceChildren(icon);
                }
                return touched;
            } catch (e) {
                return false;
            }
        }

        // Every native instance builds its own zenLibrarySections map in the
        // constructor, and idle cleanup destroys the instance entirely — so a
        // per-instance assignment alone never survives. Wrapping getInstance
        // registers (and re-applies a persisted Saves tab) synchronously on every
        // instance before its first Lit render.
        _patchNativeGetInstance() {
            let Ctor = null;
            try { Ctor = customElements.get("zen-library"); } catch (e) { return false; }
            if (!Ctor || Ctor._zenBookmarksPatched) return !!Ctor;
            const integration = this;
            try {
                const origGetInstance = Ctor.getInstance;
                if (typeof origGetInstance !== "function") return true;
                Ctor._zenBookmarksOrigGetInstance = origGetInstance;
                Ctor.getInstance = function (...args) {
                    const instance = origGetInstance.apply(this, args);
                    try {
                        integration._registerNativeSections(instance);
                        try {
                            const want = Services.prefs.getStringPref("zen.library.last-tab", "");
                            if (want && want !== instance.activeTab &&
                                instance.zenLibrarySections?.[want]?.render) {
                                instance.activeTab = want;
                            }
                        } catch (e) { }
                    } catch (e) { }
                    return instance;
                };
                Ctor._zenBookmarksPatched = true;
                this._debug("patched native getInstance");
                return true;
            } catch (e) {
                this._debug("failed to patch native getInstance", e);
                return false;
            }
        }

        _unpatchNativeGetInstance() {
            try {
                const Ctor = customElements.get("zen-library");
                if (Ctor && Ctor._zenBookmarksPatched && Ctor._zenBookmarksOrigGetInstance) {
                    Ctor.getInstance = Ctor._zenBookmarksOrigGetInstance;
                }
                if (Ctor) {
                    Ctor._zenBookmarksPatched = false;
                    Ctor._zenBookmarksOrigGetInstance = null;
                }
            } catch (e) { }
        }

        _nativeRoot(host) {
            return host?.shadowRoot || host || null;
        }

        // Light touch only: native renders its own sidebar (including our tab, once
        // registered) and its own content via the Section class. This just
        // re-asserts registration on fresh instances, keeps styles present, and
        // repairs the Saves label after Lit commits. It must never replace Lit's
        // DOM behind its back — that corrupts Lit's child parts and fights every
        // subsequent update.
        _syncNativeLibrary(host) {
            if (!host?.isConnected) return;
            this._registerNativeSections(host);
            this._syncSidebarDnD(host);
            // Only media/spaces ever set the wide-panel var (and both clear it
            // on leave). Anything left behind on another tab is stale — drop it
            // so a leaked width can't wedge the panel.
            try {
                const tab = host.activeTab;
                if (tab !== "media" && tab !== "spaces") {
                    host.style?.removeProperty?.("--zen-library-content-width");
                }
            } catch (e) { }
            const root = this._nativeRoot(host);
            if (root) this._ensureNativeStyles(root);
        }

        _ensureNativeStyles(root) {
            if (!root?.querySelector) return;
            const css = `
@import url("chrome://sine/content/library-tweaks/features/saves.css");
/* Sidebar drag-to-reorder drop indicators. */
.zen-library-tab[drop-before] {
  box-shadow: 0 -2px 0 var(--zen-primary-color, currentColor);
}
.zen-library-tab[drop-after] {
  box-shadow: 0 2px 0 var(--zen-primary-color, currentColor);
}
.zen-library-tab[dragging-tab] {
  opacity: 0.5;
}
/* Old-mod Saves glyph: the injected folder+ribbon SVG replaces the sprite box. */
.zen-library-tab[data-section="bookmarks"] .zen-library-tab-icon-image {
  display: none;
}
.zen-library-tab[data-section="bookmarks"] .zen-bookmarks-icon {
  width: 28px;
  height: 28px;
  display: block;
}
/* Same fill system as the native sprite tabs (zen-library.css): a theme-aware
   stroke token, transparent fill when idle, and a stroke-mixed fill when
   selected. !important outranks the SVG rects' inline styles. */
.zen-library-tab[data-section="bookmarks"] .zen-bookmarks-icon {
  --stroke: light-dark(var(--zen-colors-primary, currentColor), var(--zen-accent-button-color, currentColor));
}
.zen-library-tab[data-section="bookmarks"] .zen-bookmarks-border {
  stroke: var(--stroke) !important;
}
.zen-library-tab[data-section="bookmarks"] .zen-bookmarks-ribbon path {
  fill: var(--stroke) !important;
}
.zen-library-tab[data-section="bookmarks"] :is(.zen-bookmarks-bg, .zen-bookmarks-gradient) {
  fill-opacity: 0 !important;
}
.zen-library-tab[data-section="bookmarks"]:not([active]) .zen-bookmarks-bg {
  fill: transparent !important;
}
.zen-library-tab[data-section="bookmarks"][active] .zen-bookmarks-bg {
  fill: color-mix(in srgb, var(--stroke), light-dark(white, black) 70%) !important;
  fill-opacity: 1 !important;
}
@media (prefers-reduced-motion: no-preference) {
  :is(.zen-library-tab[data-section="bookmarks"][active],
      .zen-library-tab[data-section="bookmarks"][animate]) .zen-bookmarks-bounce {
    animation: zenBookmarksBounce 0.583s forwards;
  }
  :is(.zen-library-tab[data-section="bookmarks"][active],
      .zen-library-tab[data-section="bookmarks"][animate]) .zen-bookmarks-ribbon {
    animation: zenBookmarksRibbon 0.583s forwards;
  }
}
@keyframes zenBookmarksBounce {
  0% {
    transform: translateY(0px) rotate(0deg);
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
  }
  25% {
    transform: translateY(2px) rotate(0deg);
    animation-timing-function: cubic-bezier(0.4, 0, 0.64, 1);
  }
  55% {
    transform: translateY(-9px) rotate(-5deg);
    animation-timing-function: cubic-bezier(0.25, 0, 0.75, 1);
  }
  85%, 100% {
    transform: translateY(0px) rotate(0deg);
  }
}
@keyframes zenBookmarksRibbon {
  0% {
    transform: translateY(-14px);
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
  }
  35% {
    transform: translateY(3px);
    animation-timing-function: cubic-bezier(0.4, 0, 0.64, 1);
  }
  60% {
    transform: translateY(-3px);
    animation-timing-function: cubic-bezier(0.25, 0, 0.75, 1);
  }
  85%, 100% {
    transform: translateY(0px);
  }
}
/* The module renders .library-list-container (a custom-mod class). Behave like
   native's .zen-library-search-results scroll viewport, including the filter
   panel push-down. */
zen-library-bookmarks-section {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  /* Size from layout, never from contents, so the list below gets a bounded
     box to scroll in. */
  contain: size;
}
zen-library-bookmarks-section .library-list-container {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 10px;
  scrollbar-width: thin;
  transition: transform 0.3s ease;
  /* The open panel is window-draggable; without this the scrollbar drags it. */
  -moz-window-dragging: no-drag;
}
zen-library-bookmarks-section .zen-library-search-top[open] + .library-list-container {
  transform: translateY(var(--zen-library-filter-height, 0px));
}
/* Row parity with the custom library: rows are .library-list-item.bookmark-row,
   and the more button borrows .download-row-action from the downloads section.
   None of those stylesheets load under native, so the row base, the more
   button and the empty states are ported here, scoped to our section so native
   sections are untouched. */
zen-library-bookmarks-section .library-list-container .library-list-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 12px;
  height: 48px;
  border-radius: 16px;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
  user-select: none;
  flex-shrink: 0;
  opacity: 0.9;
  box-sizing: border-box;
  -moz-window-dragging: no-drag;
}
zen-library-bookmarks-section .library-list-container .library-list-item:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
zen-library-bookmarks-section .library-list-container .library-list-item:active {
  transform: scale(0.98);
}
zen-library-bookmarks-section .bookmark-row-actions .download-row-action {
  appearance: none;
  border: 0;
  display: flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.72;
}
zen-library-bookmarks-section .bookmark-row-actions .download-row-action:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
zen-library-bookmarks-section .bookmark-row-actions .download-row-action-icon {
  display: block;
  width: 14px;
  height: 14px;
  background-color: currentColor;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
}
zen-library-bookmarks-section .bookmark-row-actions .download-row-action-icon.more-icon {
  mask-image: url("chrome://browser/skin/zen-icons/menu.svg");
}
zen-library-bookmarks-section .empty-state {
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
zen-library-bookmarks-section .empty-state h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  opacity: 0.9;
}
zen-library-bookmarks-section .empty-state p {
  margin: 0;
  font-size: 13px;
  opacity: 0.6;
  max-width: 250px;
}
zen-library-bookmarks-section .empty-state .empty-icon {
  width: 64px;
  height: 64px;
  background-color: currentColor;
  opacity: 0.2;
  margin-bottom: 8px;
  mask-size: contain;
  mask-repeat: no-repeat;
  mask-position: center;
}
`;
            const existing = root.querySelector(":scope > #zen-bookmarks-native-style") ||
                root.querySelector("#zen-bookmarks-native-style");
            if (existing) {
                if (existing.textContent !== css) existing.textContent = css;
                return;
            }
            const style = document.createElement("style");
            style.id = "zen-bookmarks-native-style";
            style.textContent = css;
            try { root.appendChild(style); } catch (e) { }
        }

        _nativeModuleShell(sectionEl) {
            const base = this._moduleShell();
            const hostFor = () => {
                try { return sectionEl?.closest?.("zen-library") || null; }
                catch (e) { return null; }
            };
            return {
                ...base,
                style: sectionEl?.style || base.style,
                store: base.store || null,
                enterContent: (node) => node,
                get activeTab() {
                    try { return hostFor()?.activeTab; }
                    catch (e) { return undefined; }
                },
                update: () => {
                    try { hostFor()?.requestUpdate?.(); } catch (e) { }
                },
                svg: (svgString) => {
                    try {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(svgString, "image/svg+xml");
                        const node = doc.documentElement;
                        if (!node) return null;
                        node.removeAttribute("xmlns");
                        return node;
                    } catch (e) {
                        return null;
                    }
                },
            };
        }

        _isNativeLibrary() {
            try {
                const Ctor = customElements.get("zen-library");
                return !!Ctor && typeof Ctor.toggle === "function" && typeof Ctor.getInstance === "function";
            } catch (e) {
                return false;
            }
        }

        // Row opens (and the save toast) target the custom controller; under native
        // that element never opened, so close the native panel instead and only
        // fall back to the custom close otherwise.
        _closeLibraryAfterOpen() {
            try {
                const Ctor = customElements.get("zen-library");
                const isNative = !!Ctor && typeof Ctor.animateProgress === "function";
                const host = (typeof Ctor?.getInstance === "function" && Ctor.getInstance(false)) ||
                    document.querySelector("zen-library");
                const open = !!host?.hasAttribute?.("open") ||
                    document.documentElement.hasAttribute("zen-library-open");
                if (isNative && open) {
                    Ctor.animateProgress(0);
                    return;
                }
                if (isNative && host) return;
            } catch (e) { }
            try { window.gZenLibrary?.close?.(); } catch (e) { }
        }

        _showNativeBookmarks(host) {            if (!host) return false;
            this._connectNativeLibrary(host);
            const section = host.zenLibrarySections?.bookmarks;
            if (!section || typeof section.render !== "function") {
                this._debug("cannot show Saves: native section unavailable");
                return false;
            }
            // Property assignment, not setAttribute: this runs native's setter
            // (pref persist + Lit reactivity) so the following render finds a
            // section with render().
            try {
                if (host.activeTab !== "bookmarks") host.activeTab = "bookmarks";
            } catch (e) {
                this._debug("failed to set native activeTab", e);
                return false;
            }
            try { host.requestUpdate?.(); } catch (e) { }
            return true;
        }

        _openNativeBookmarks({ openIfMissing = true } = {}) {
            if (!this._isMasterEnabled()) return false;
            this._registerNativeWhenReady();
            const Ctor = customElements.get("zen-library");
            // Preferred path: native's own toggle opens on the tab, switches to it
            // when open elsewhere, and closes when already on it. The getInstance
            // patch above guarantees the section exists before toggle reads it.
            if (Ctor && typeof Ctor.toggle === "function") {
                try {
                    this._patchNativeGetInstance();
                    try {
                        const existing = typeof Ctor.getInstance === "function"
                            ? Ctor.getInstance(false)
                            : document.querySelector("zen-library");
                        if (existing) this._registerNativeSections(existing);
                    } catch (e) { }
                    Ctor.toggle("bookmarks");
                    return true;
                } catch (e) {
                    this._debug("native toggle failed", e);
                }
            }
            // Fallback for builds without the static toggle API.
            let host = document.querySelector("zen-library");
            this._debug("open native Saves start", {
                openIfMissing,
                hasHost: !!host,
                hasCtor: !!Ctor,
                hasGetInstance: typeof Ctor?.getInstance === "function",
                hasButton: !!document.getElementById("zen-library-button"),
            });
            if (!host && openIfMissing && typeof Ctor?.getInstance === "function") {
                try {
                    host = Ctor.getInstance(true);
                    this._debug("native getInstance result", { hasHost: !!host });
                } catch (e) {
                    this._debug("native getInstance failed", e);
                    host = null;
                }
            }
            if (!host && openIfMissing) {
                try {
                    document.getElementById("zen-library-button")?.click?.();
                    this._debug("clicked native library button fallback");
                } catch (e) {
                    this._debug("native library button fallback failed", e);
                }
                host = document.querySelector("zen-library");
            }
            if (!host) {
                this._debug("open native Saves failed: no host");
                return false;
            }
            this._connectNativeLibrary(host);
            requestAnimationFrame(() => this._showNativeBookmarks(host));
            return true;
        }

        _scheduleOpenNativeBookmarks() {
            clearTimeout(this._nativeOpenTimer);
            let attempts = 0;
            const tick = () => {
                attempts += 1;
                this._debug("open native Saves attempt", { attempts });
                if (this._openNativeBookmarks({ openIfMissing: attempts === 1 }) || attempts >= 20) {
                    this._nativeOpenTimer = null;
                    if (attempts >= 20) this._debug("open native Saves giving up");
                    return;
                }
                this._nativeOpenTimer = setTimeout(tick, 100);
            };
            tick();
        }

        _bookmarksIconSvg() {
            return `
<svg class="zen-bookmarks-icon" width="28" height="28" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <mask id="zen-bookmarks-mask">
      <rect x="-10" y="-10" width="148" height="148" fill="white" />
      <rect x="30" y="18" width="68" height="92" rx="12" fill="black" />
    </mask>
    <linearGradient gradientUnits="userSpaceOnUse" x1="64" y1="10" x2="64" y2="118" id="zen-bookmarks-grad-back">
      <stop offset="0" style="stop-color: rgb(255, 255, 255)"/>
      <stop offset="1" style="stop-color: rgb(0, 0, 0)"/>
    </linearGradient>
    <linearGradient gradientUnits="userSpaceOnUse" x1="64" y1="10" x2="64" y2="118" id="zen-bookmarks-grad-front">
      <stop offset="0" style="stop-color: rgb(255, 255, 255)"/>
      <stop offset="1" style="stop-color: rgb(0, 0, 0)"/>
    </linearGradient>
  </defs>
  <g class="zen-bookmarks-bounce" style="transform-origin: 64px 64px;">
    <g class="zen-bookmarks-back-card" mask="url(#zen-bookmarks-mask)">
      <g transform="rotate(-8 64 64)">
        <rect class="zen-bookmarks-bg" x="37.55" y="25.55" width="52.9" height="76.9" rx="6.45"
              style="fill: var(--zen-folder-front-bgcolor); fill-opacity: 0;" />
        <rect class="zen-bookmarks-gradient" x="37.55" y="25.55" width="52.9" height="76.9" rx="6.45"
              style="fill: url(#zen-bookmarks-grad-back); fill-opacity: 0;" />
        <rect class="zen-bookmarks-border" x="37.55" y="25.55" width="52.9" height="76.9" rx="6.45"
              style="fill: none; stroke: var(--zen-folder-stroke); stroke-width: 7.1px;" />
      </g>
    </g>
    <g class="zen-bookmarks-front-card">
      <rect class="zen-bookmarks-bg" x="37.55" y="25.55" width="52.9" height="76.9" rx="6.45"
            style="fill: var(--zen-folder-front-bgcolor); fill-opacity: 0;" />
      <rect class="zen-bookmarks-gradient" x="37.55" y="25.55" width="52.9" height="76.9" rx="6.45"
            style="fill: url(#zen-bookmarks-grad-front); fill-opacity: 0;" />
      <rect class="zen-bookmarks-border" x="37.55" y="25.55" width="52.9" height="76.9" rx="6.45"
            style="fill: none; stroke: var(--zen-folder-stroke); stroke-width: 7.1px;" />
      <g class="zen-bookmarks-ribbon">
        <path d="M 51 22 L 77 22 L 77 70 L 64 60 L 51 70 Z"
              style="fill: var(--zen-folder-stroke);" />
      </g>
    </g>
  </g>
</svg>`;
        }

        _moduleShell() {
            const controller = window.gZenLibrary;
            if (controller && typeof controller._createModuleShell === "function") {
                return controller._createModuleShell();
            }
            const makeEl = (tag, props = {}, children = []) => {
                const util = window.ZenLibraryUtil;
                if (util?.el) return util.el(tag, props, children);
                const node = document.createElement(tag);
                for (const [key, value] of Object.entries(props || {})) {
                    if (key === "className") node.className = value;
                    else if (key === "textContent") node.textContent = value;
                    else if (key === "innerHTML") node.innerHTML = value;
                    else if (key === "style") node.setAttribute("style", value);
                    else if (key === "dataset" && value && typeof value === "object") {
                        for (const [dataKey, dataValue] of Object.entries(value)) {
                            try { node.dataset[dataKey] = dataValue; } catch (e) { }
                        }
                    }
                    else if (key.startsWith("on") && typeof value === "function") {
                        node.addEventListener(key.slice(2), value);
                    } else if (value !== false && value != null) {
                        node.setAttribute(key, value === true ? "true" : String(value));
                    }
                }
                for (const child of Array.isArray(children) ? children : [children]) {
                    if (child) node.appendChild(child);
                }
                return node;
            };
            return {
                el: makeEl,
                enterContent: (node) => node,
                style: { getPropertyValue: () => "" },
                store: controller?.store || null
            };
        }

        _ensureBookmarksModule() {
            if (this._bookmarksModule) return this._bookmarksModule;
            try {
                this._bookmarksModule = new ZenLibraryBookmarks(this._moduleShell());
                this._bookmarksModule.init();
                if (window.gZenLibrary?._modules) {
                    window.gZenLibrary._modules.bookmarks = this._bookmarksModule;
                }
            } catch (e) {
                console.error("[ZenLibraryBookmarks] Failed to initialize background module:", e);
            }
            return this._bookmarksModule;
        }

        _openBookmarks(event) {
            if (!this._isMasterEnabled()) return false;
            try {
                if (!Services.prefs.getBoolPref("zen.library.shortcut.bookmarks-sidebar", true)) return false;
            } catch (e) { }
            event?.preventDefault?.();
            event?.stopPropagation?.();
            event?.stopImmediatePropagation?.();
            // When the native `zen-library` owns the tag, the custom-mod controller
            // cannot drive it (its element class lost the define race), so route to
            // native. Otherwise prefer the custom mod's openTab.
            if (this._isNativeLibrary()) {
                this._scheduleOpenNativeBookmarks();
            } else if (window.gZenLibrary?.openTab && window.ZenLibrarySections?.has?.("bookmarks")) {
                window.gZenLibrary.openTab("bookmarks");
            } else {
                this._scheduleOpenNativeBookmarks();
            }
            return true;
        }

        _saveCurrentPage(event) {
            if (!this._isMasterEnabled()) return false;
            const module = this._ensureBookmarksModule();
            if (!module?.saveCurrentPageWithSmartTags) return false;
            event?.preventDefault?.();
            event?.stopPropagation?.();
            event?.stopImmediatePropagation?.();
            module.saveCurrentPageWithSmartTags();
            return true;
        }

        _watchShowAllBookmarksCommand() {
            try {
                const command = document.getElementById("Browser:ShowAllBookmarks");
                if (!command || this._showAllBookmarksCommand === command) return;
                this._unwatchShowAllBookmarksCommand();
                this._showAllBookmarksCommand = command;
                command.addEventListener("command", this._onShowAllBookmarksCommand, true);
            } catch (e) {
                console.error("[ZenLibraryBookmarks] Failed to watch Show All Bookmarks command:", e);
            }
        }

        _watchNativeLibraryCommandNodes() {
            if (this._nativeCommandObserver) return;
            this._nativeCommandObserver = new MutationObserver(() => {
                this._watchShowAllBookmarksCommand();
                this._watchAddBookmarkCommands();
            });
            try {
                this._nativeCommandObserver.observe(document.documentElement, { childList: true, subtree: true });
            } catch (e) {
                this._nativeCommandObserver = null;
            }
        }

        _unwatchShowAllBookmarksCommand() {
            if (!this._showAllBookmarksCommand) return;
            try {
                this._showAllBookmarksCommand.removeEventListener("command", this._onShowAllBookmarksCommand, true);
            } catch (e) { }
            this._showAllBookmarksCommand = null;
        }

        _onShowAllBookmarksCommand(event) {
            this._openBookmarks(event);
        }

        _watchAddBookmarkCommands() {
            for (const id of ["Browser:AddBookmarkAs", "Browser:AddBookmark"]) {
                try {
                    const command = document.getElementById(id);
                    if (!command || this._addBookmarkCommands.has(command)) continue;
                    command.addEventListener("command", this._onAddBookmarkCommand, true);
                    this._addBookmarkCommands.add(command);
                } catch (e) { }
            }
        }

        _unwatchAddBookmarkCommands() {
            for (const command of this._addBookmarkCommands) {
                try { command.removeEventListener("command", this._onAddBookmarkCommand, true); } catch (e) { }
            }
            this._addBookmarkCommands.clear();
        }

        _onAddBookmarkCommand(event) {
            if (!this._isSaveShortcutEnabled()) return;
            this._saveCurrentPage(event);
        }

        _watchBookmarksSidebar() {
            if (this._sidebarBoxObserver) return;
            const box = document.getElementById("sidebar-box");
            if (!box) return;
            this._sidebarBoxObserver = new MutationObserver(() => {
                try {
                    if (box.getAttribute("sidebarcommand") !== "viewBookmarksSidebar") return;
                    if (box.hidden) return;
                    if (Date.now() - this._lastSidebarKeyAt < 500) return;
                    try {
                        if (!Services.prefs.getBoolPref("zen.library.shortcut.bookmarks-sidebar", true)) return;
                    } catch (e) { }
                    try {
                        if (window.SidebarUI?.hide) window.SidebarUI.hide();
                        else box.setAttribute("hidden", "true");
                    } catch (e) { }
                    this._openBookmarks();
                } catch (e) { }
            });
            try {
                this._sidebarBoxObserver.observe(box, { attributes: true, attributeFilter: ["sidebarcommand", "hidden"] });
            } catch (e) {
                this._sidebarBoxObserver = null;
            }
        }

        _unwatchBookmarksSidebar() {
            try { this._sidebarBoxObserver?.disconnect(); } catch (e) { }
            this._sidebarBoxObserver = null;
        }

        _onKeyDown(e) {
            if (e.defaultPrevented) return;
            const isMac = Services.appinfo.OS === "Darwin";
            const target = e.composedPath ? e.composedPath()[0] : e.target;
            const name = target && target.localName ? target.localName.toLowerCase() : "";
            if (name === "input" || name === "textarea" || (target && target.isContentEditable)) return;

            const isSidebarShortcut = e.code === "KeyB" && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey;
            const isBookmarksShortcut = e.code === "KeyB" && (isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey;
            const isSaveShortcut = e.code === "KeyJ" && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey;
            const isHistoryShortcut = e.code === "KeyH" && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey;
            if (isSaveShortcut) {
                if (!this._isSaveShortcutEnabled()) return;
                this._saveCurrentPage(e);
                return;
            }
            if (isHistoryShortcut) {
                if (!this._isHistoryShortcutEnabled()) return;
                this._openHistory(e);
                return;
            }
            if (isSidebarShortcut || isBookmarksShortcut) {
                this._lastSidebarKeyAt = Date.now();
                this._openBookmarks(e);
            }
        }

        _isSaveShortcutEnabled() {
            try { return Services.prefs.getBoolPref("zen.library.tweaks.shortcut.save", true); }
            catch (e) { return true; }
        }

        _isHistoryShortcutEnabled() {
            try { return Services.prefs.getBoolPref("zen.library.tweaks.shortcut.history", true); }
            catch (e) { return true; }
        }

        _openHistory(event) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            event?.stopImmediatePropagation?.();
            try {
                const Ctor = customElements.get("zen-library");
                if (Ctor && typeof Ctor.toggle === "function") {
                    this._registerNativeWhenReady();
                    Ctor.toggle("history");
                    return true;
                }
            } catch (e) { }
            try {
                if (window.gZenLibrary?.openTab) {
                    window.gZenLibrary.openTab("history");
                    return true;
                }
            } catch (e) { }
            return false;
        }

        _onUnload() {
            this.destroy();
        }

        destroy() {
            this._shutdown();
            this._unwatchMasterPref();
            try { this._unwatchEaselsPref?.(); } catch (e) { }
            try { this._unwatchMediaPref?.(); } catch (e) { }
        }

        // Full teardown minus the master pref watcher, so the toggle-off path
        // can later re-init() without a restart.
        _shutdown() {
            window.removeEventListener("keydown", this._onKeyDown, true);
            window.removeEventListener("unload", this._onUnload);
            window.removeEventListener("ZenLibrarySectionsReady", this._onLibraryReady);
            this._unpatchNativeGetInstance();
            this._nativeHtmlTag = undefined;
            this._nativeReady = false;
            this._initialized = false;
            try { this._nativeLibraryObserver?.disconnect(); } catch (e) { }
            this._nativeLibraryObserver = null;
            try { this._nativeCommandObserver?.disconnect(); } catch (e) { }
            this._nativeCommandObserver = null;
            clearTimeout(this._nativeOpenTimer);
            this._nativeOpenTimer = null;
            for (const observer of this._nativeHostObservers.values()) {
                try { observer.disconnect(); } catch (e) { }
            }
            this._nativeHostObservers.clear();
            this._unwatchShowAllBookmarksCommand();
            this._unwatchAddBookmarkCommands();
            this._unwatchBookmarksSidebar();
            if (this._retryTimer) {
                clearTimeout(this._retryTimer);
                this._retryTimer = null;
            }
            if (window.gZenLibrary?._modules?.bookmarks === this._bookmarksModule) {
                window.gZenLibrary._modules.bookmarks = null;
            }
            try { this._bookmarksModule?.destroy?.(); } catch (e) { }
            this._bookmarksModule = null;
        }
    }

    window.ZenLibraryBookmarks = ZenLibraryBookmarks;
    if (window.gZenLibraryBookmarksIntegration?.destroy) {
        window.gZenLibraryBookmarksIntegration.destroy();
    }
    window.gZenLibraryBookmarksIntegration = new ZenLibraryBookmarksIntegration();
    // Picks the feature halves back up when they loaded earlier (normal boot)
    // without depending on script load order.
    try { window._libraryTweaksAttachEasels?.(window.gZenLibraryBookmarksIntegration); } catch (e) { }
    try { window._libraryTweaksAttachMedia?.(window.gZenLibraryBookmarksIntegration); } catch (e) { }
})();
