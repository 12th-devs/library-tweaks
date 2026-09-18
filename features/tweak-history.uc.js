"use strict";

// Library Tweaks — History context menu for the native Zen Library.
//
// Mirrors the reference mod's history menu (Copy / Forget About This Site /
// Delete) on top of the native history section. Native rows expose no item
// data, so the visit is resolved through PlacesQuery.searchHistory matched
// against the row's title and visible URL. Native auto-refreshes on Places
// changes, so no manual list refresh is needed after forget/delete.

(function () {
    const PREF = "zen.library.tweaks.history.menu";
    const POPUP_ID = "lt-history-context-menu";

    const isOn = () => {
        try { return Services.prefs.getBoolPref(PREF, true); }
        catch (e) { return true; }
    };

    const stripUrl = (url) => String(url || "")
        .replace(/^https?:\/\/(www\.)?/i, "")
        .replace(/\/$/, "");

    // Exact URLs cached from native drag payloads (no Places dependency).
    const dragUrls = new WeakMap();
    // In-flight / finished background resolutions per row.
    const pendingRows = new WeakSet();

    async function queryPlaces(text, limit = 30) {
        const { PlacesQuery } = ChromeUtils.importESModule("resource://gre/modules/PlacesQuery.sys.mjs");
        const query = new PlacesQuery();
        try {
            // searchHistory reads lazily-initialized query options; native always
            // calls observeHistory() first, and skipping it throws
            // "this.cachedHistoryOptions is null". No-op observer is enough.
            try { query.observeHistory(() => { }); } catch (e) { }
            const found = await query.searchHistory(text, limit);
            if (Array.isArray(found)) return found;
            if (found?.values) return [...found.values()].flat();
            return [];
        } finally {
            try { query.close(); } catch (e) { }
        }
    }

    function scoreVisit(visit, title, want) {
        if (!visit?.url) return 0;
        const stripped = stripUrl(visit.url).toLowerCase();
        let score = 0;
        if (stripped === want) score += 10;
        else if (stripped.includes(want) || want.includes(stripped)) score += 4;
        else return 0;
        if (title && String(visit.title || "").toLowerCase() === title.toLowerCase()) score += 5;
        return score;
    }

    // Best-match visit for a row, or null with a logged reason. Tries the title
    // query first, then falls back to the visible URL as the query.
    async function resolveVisit(row, why = "menu") {
        try {
            const title = (row.querySelector(".zen-library-row-title")?.textContent || "").trim();
            const shown = (row.querySelector(".zen-library-row-subtitle")?.textContent || "").trim();
            if (!shown) {
                console.warn("[LibraryTweaks] history resolve: no subtitle in row (" + why + ")");
                return null;
            }
            const want = stripUrl(shown).toLowerCase();
            const queries = [];
            if (title) queries.push(title);
            if (shown !== title) queries.push(shown);
            for (const text of queries) {
                let visits = [];
                try { visits = await queryPlaces(text); }
                catch (e) {
                    console.warn("[LibraryTweaks] history resolve: search failed:", e);
                    continue;
                }
                let best = null;
                let bestScore = 0;
                for (const visit of visits) {
                    const score = scoreVisit(visit, title, want);
                    if (score > bestScore) {
                        bestScore = score;
                        best = visit;
                    }
                }
                if (best) return best;
            }
            console.warn("[LibraryTweaks] history resolve: no match for", JSON.stringify(shown.slice(0, 80)), "(" + why + ")");
            return null;
        } catch (e) {
            console.warn("[LibraryTweaks] history resolve failed:", e);
            return null;
        }
    }

    function copyString(text) {
        try {
            Cc["@mozilla.org/widget/clipboardhelper;1"]
                .getService(Ci.nsIClipboardHelper)
                .copyString(text);
        } catch (e) { }
    }

    async function placesApi() {
        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
        return PlacesUtils;
    }

    function ensurePopup() {
        let popup = document.getElementById(POPUP_ID);
        if (popup) return popup;
        popup = document.createXULElement("menupopup");
        popup.id = POPUP_ID;

        const copyItem = document.createXULElement("menuitem");
        copyItem.id = "lt-history-ctx-copy";
        copyItem.setAttribute("label", "Copy");
        const forgetItem = document.createXULElement("menuitem");
        forgetItem.id = "lt-history-ctx-forget-site";
        forgetItem.setAttribute("label", "Forget About This Site");
        const deleteItem = document.createXULElement("menuitem");
        deleteItem.id = "lt-history-ctx-delete";
        deleteItem.setAttribute("label", "Delete");

        popup.appendChild(copyItem);
        popup.appendChild(forgetItem);
        popup.appendChild(document.createXULElement("menuseparator"));
        popup.appendChild(deleteItem);
        (document.getElementById("mainPopupSet") || document.body).appendChild(popup);
        return popup;
    }

    function removePopup() {
        try { document.getElementById(POPUP_ID)?.remove(); } catch (e) { }
    }

    async function showMenu(event, row) {
        // Exact URL when this row was dragged before; otherwise resolve.
        const dragged = dragUrls.get(row);
        const visit = dragged ? { url: dragged } : await resolveVisit(row);
        showMenuWithVisit(event, visit);
    }

    function showMenuWithVisit(event, visit) {
        const popup = ensurePopup();
        const url = visit?.url || null;
        for (const id of ["lt-history-ctx-copy", "lt-history-ctx-forget-site", "lt-history-ctx-delete"]) {
            const item = document.getElementById(id);
            if (item) item.disabled = !url;
        }
        if (!url) {
            popup.openPopupAtScreen(event.screenX, event.screenY, true);
            return;
        }
        for (const id of ["lt-history-ctx-copy", "lt-history-ctx-forget-site", "lt-history-ctx-delete"]) {
            const item = document.getElementById(id);
            if (item) item.replaceWith(item.cloneNode(true));
        }
        const on = (id, handler) => {
            document.getElementById(id)?.addEventListener("command", async () => {
                try { await handler(); } catch (e) { console.error("[LibraryTweaks]", e); }
            });
        };
        on("lt-history-ctx-copy", () => copyString(url));
        on("lt-history-ctx-forget-site", async () => {
            let host = "";
            try { host = new URL(url).hostname; } catch (e) { return; }
            if (!host || host === ".") return;
            (await placesApi()).history.removeByFilter({ host });
        });
        on("lt-history-ctx-delete", async () => {
            (await placesApi()).history.remove(url);
        });
        popup.openPopupAtScreen(event.screenX, event.screenY, true);
    }

    const state = {
        sections: new Map(),
        docObserver: null,
        prefObserver: null,
    };

    function attachSection(section) {
        if (!section || state.sections.has(section)) return;
        // Native rows drag with the full URL in text/x-moz-url: cache it per row
        // so the menu never needs Places for previously dragged rows.
        const onDragStart = (event) => {
            try {
                const row = event.target?.closest?.(".zen-library-row");
                if (!row || !section.contains(row)) return;
                const payload = event.dataTransfer?.getData?.("text/x-moz-url") || "";
                const url = payload.split("\n")[0].trim();
                if (url) dragUrls.set(row, url);
            } catch (e) { }
        };
        // Prefetch in the background on hover so right-click usually hits cache.
        const onMouseOver = (event) => {
            try {
                if (!isOn()) return;
                const row = event.target?.closest?.(".zen-library-row");
                if (!row || !section.contains(row)) return;
                if (dragUrls.has(row) || row._ltVisit !== undefined || pendingRows.has(row)) return;
                pendingRows.add(row);
                resolveVisit(row, "prefetch").then(visit => {
                    row._ltVisit = visit || null;
                }).catch(() => {
                    row._ltVisit = null;
                }).finally(() => {
                    pendingRows.delete(row);
                });
            } catch (e) { }
        };
        const handler = (event) => {
            if (!isOn()) return;
            const row = event.target?.closest?.(".zen-library-row");
            if (!row || !section.contains(row)) return;
            event.preventDefault();
            event.stopPropagation();
            if (row._ltVisit) {
                showMenuWithVisit(event, row._ltVisit);
                return;
            }
            showMenu(event, row);
        };
        section.addEventListener("dragstart", onDragStart, true);
        section.addEventListener("mouseover", onMouseOver);
        section.addEventListener("contextmenu", handler);
        state.sections.set(section, { onDragStart, onMouseOver, handler });
    }

    function detachSection(section) {
        const handlers = state.sections.get(section);
        if (handlers) {
            try { section.removeEventListener("dragstart", handlers.onDragStart, true); } catch (e) { }
            try { section.removeEventListener("mouseover", handlers.onMouseOver); } catch (e) { }
            try { section.removeEventListener("contextmenu", handlers.handler); } catch (e) { }
            state.sections.delete(section);
        }
    }

    function scanDocument() {
        for (const section of document.querySelectorAll?.("zen-library-history-section") || []) {
            if (isOn()) attachSection(section);
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
        if (!state.prefObserver) {
            state.prefObserver = { observe: () => scanDocument() };
            try { Services.prefs.addObserver(PREF, state.prefObserver); } catch (e) { state.prefObserver = null; }
        }
    }

    init();
})();
