"use strict";

// Library Tweaks - History context menu for the native Zen Library.
//
// Adds Copy / Forget About This Site / Delete to native History rows. Rows do
// not always expose a URL, so the menu resolves the visible row text through
// Places when needed.

(function () {
    const PREF = "zen.library.tweaks.history.menu";
    const POPUP_ID = "lt-history-context-menu";
    const LOG_PREFIX = "[LibraryTweaks History]";

    const isOn = () => {
        try { return Services.prefs.getBoolPref(PREF, true); }
        catch (e) { return true; }
    };

    function warn(...args) {
        try { console.warn(LOG_PREFIX, ...args); } catch (e) { }
    }

    const stripUrl = (url) => String(url || "")
        .replace(/^https?:\/\/(www\.)?/i, "")
        .replace(/\/$/, "");

    const dragUrls = new WeakMap();

    const state = {
        sections: new Map(),
        prefObserver: null,
        nativeMenuHosts: new WeakMap(),
    };

    function visibleRowTitle(row) {
        try {
            return (row?.querySelector?.(".zen-library-row-title, .item-title, [class*='title']")?.textContent || "").trim();
        } catch (e) {
            return "";
        }
    }

    function visibleRowUrl(row) {
        try {
            const subtitle = row?.querySelector?.(".item-url, .zen-library-row-subtitle, [class*='url'], [class*='subtitle']");
            return (subtitle?.firstChild?.textContent || subtitle?.textContent || "").trim();
        } catch (e) {
            return "";
        }
    }

    function nativeHistoryRoot(host) {
        if (!host?.querySelector) return null;
        return host.querySelector("#zen-library-content") ||
            host.querySelector(".zen-library-content") ||
            host;
    }

    async function placesApi() {
        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
        return PlacesUtils;
    }

    async function queryPlaces(text, limit = 30) {
        const { PlacesQuery } = ChromeUtils.importESModule("resource://gre/modules/PlacesQuery.sys.mjs");
        const query = new PlacesQuery();
        const result = await query.searchHistory(text || "", { limit });
        if (Array.isArray(result)) return result;
        if (Array.isArray(result?.values)) return result.values;
        if (result instanceof Map) return [...result.values()].flat();
        return [];
    }

    function scoreVisit(visit, title, want) {
        const url = visit?.uri || visit?.url || visit?.page_url || visit?.pageUrl || "";
        if (!url) return 0;
        const stripped = stripUrl(url).toLowerCase();
        let score = 0;
        if (stripped === want) score += 10;
        else if (stripped.includes(want) || want.includes(stripped)) score += 4;
        const titleMatches = title && String(visit.title || "").toLowerCase() === title.toLowerCase();
        if (!score && !titleMatches) return 0;
        if (titleMatches) score += 7;
        return score;
    }

    function visibleUrlCandidates(row) {
        const shown = row?.getAttribute?.("subtitle") || visibleRowUrl(row);
        if (!shown) return [];
        const candidates = [shown];
        if (!/^[a-z][a-z0-9+.-]*:/i.test(shown)) {
            candidates.push(`https://${shown}`);
            candidates.push(`http://${shown}`);
        }
        return [...new Set(candidates)];
    }

    async function fetchExactVisitForRow(row) {
        const PlacesUtils = await placesApi();
        for (const url of visibleUrlCandidates(row)) {
            try {
                const page = await PlacesUtils.history.fetch(url, { includeVisits: true });
                if (!page) continue;
                return {
                    url: page.url?.href || page.url || url,
                    title: page.title || visibleRowTitle(row),
                };
            } catch (e) { }
        }
        return null;
    }

    async function resolveVisit(row) {
        try {
            const title = visibleRowTitle(row);
            const shown = row?.getAttribute?.("subtitle") || visibleRowUrl(row);
            if (!shown) return null;
            const exact = await fetchExactVisitForRow(row);
            if (exact) return exact;
            const want = stripUrl(shown).toLowerCase();
            const queries = [];
            if (title) queries.push(title);
            if (shown !== title) queries.push(shown);
            for (const text of queries) {
                let visits = [];
                try { visits = await queryPlaces(text); }
                catch (e) {
                    warn("history resolve search failed", e);
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
        } catch (e) {
            warn("history resolve failed", e);
        }
        return null;
    }

    function visitUrl(visit) {
        return visit?.uri || visit?.url || visit?.page_url || visit?.pageUrl || "";
    }

    function copyString(text) {
        try {
            Cc["@mozilla.org/widget/clipboardhelper;1"]
                .getService(Ci.nsIClipboardHelper)
                .copyString(text);
        } catch (e) { }
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

    async function showMenu(event, row) {
        const dragged = dragUrls.get(row);
        const dataUrl = row?.data?.uri || row?._item?.uri || row?.data?.url || row?._item?.url || "";
        const visit = dragged ? { url: dragged } : dataUrl ? { url: dataUrl } : await resolveVisit(row);
        showMenuWithVisit(event, visit);
    }

    function showMenuWithVisit(event, visit) {
        const popup = ensurePopup();
        const url = visitUrl(visit);
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
                try { await handler(); } catch (e) { warn(e); }
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

    function attachNativeHistoryMenu(host) {
        const root = nativeHistoryRoot(host);
        if (!root || state.nativeMenuHosts.has(root)) return;
        const handler = (event) => {
            if (!isOn() || host.activeTab !== "history") return;
            const row = event.target?.closest?.("zen-library-item, .zen-library-row, .library-list-item");
            if (!row || !root.contains(row)) return;
            event.preventDefault();
            event.stopPropagation();
            showMenu(event, row);
        };
        root.addEventListener("contextmenu", handler, true);
        state.nativeMenuHosts.set(root, handler);
    }

    function attachSection(section) {
        if (!section || state.sections.has(section)) return;
        const onDragStart = (event) => {
            try {
                const row = event.target?.closest?.(".zen-library-row, zen-library-item, .library-list-item");
                if (!row || !section.contains(row)) return;
                const payload = event.dataTransfer?.getData?.("text/x-moz-url") || "";
                const url = payload.split("\n")[0].trim();
                if (url) dragUrls.set(row, url);
            } catch (e) { }
        };
        const handler = (event) => {
            if (!isOn()) return;
            const row = event.target?.closest?.(".zen-library-row, zen-library-item, .library-list-item");
            if (!row || !section.contains(row)) return;
            event.preventDefault();
            event.stopPropagation();
            showMenu(event, row);
        };
        section.addEventListener("dragstart", onDragStart, true);
        section.addEventListener("contextmenu", handler, true);
        state.sections.set(section, { onDragStart, handler });
    }

    function detachSection(section) {
        const handlers = state.sections.get(section);
        if (!handlers) return;
        try { section.removeEventListener("dragstart", handlers.onDragStart, true); } catch (e) { }
        try { section.removeEventListener("contextmenu", handlers.handler, true); } catch (e) { }
        state.sections.delete(section);
    }

    function scanDocument() {
        for (const host of document.querySelectorAll?.("zen-library") || []) {
            try { attachNativeHistoryMenu(host); } catch (e) { warn("history host scan failed", e); }
        }
        // Covers both the native section and the history-tweaks replacement
        // (Recently closed tabs), whose rows share the same shape.
        for (const section of document.querySelectorAll?.("zen-library-history-section, zen-library-history-tweaks-section") || []) {
            if (isOn()) attachSection(section);
            else detachSection(section);
        }
    }

    function init() {
        setTimeout(scanDocument, 1500);
        if (!state.prefObserver) {
            state.prefObserver = { observe: () => scanDocument() };
            try { Services.prefs.addObserver(PREF, state.prefObserver); } catch (e) { state.prefObserver = null; }
        }
    }

    init();
})();
