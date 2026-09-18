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

    // Best-match visit for a row, or null. History URLs are unique enough that
    // title + stripped-URL scoring resolves the right visit in practice.
    async function resolveVisit(row) {
        try {
            const title = (row.querySelector(".zen-library-row-title")?.textContent || "").trim();
            const shown = (row.querySelector(".zen-library-row-subtitle")?.textContent || "").trim();
            if (!shown) return null;
            const want = stripUrl(shown).toLowerCase();
            const { PlacesQuery } = ChromeUtils.importESModule("resource://gre/modules/PlacesQuery.sys.mjs");
            const query = new PlacesQuery();
            let visits = [];
            try {
                const found = await query.searchHistory(title || shown, 30);
                if (Array.isArray(found)) visits = found;
                else if (found?.values) visits = [...found.values()].flat();
            } finally {
                try { query.close(); } catch (e) { }
            }
            let best = null;
            let bestScore = 0;
            for (const visit of visits) {
                if (!visit?.url) continue;
                const stripped = stripUrl(visit.url).toLowerCase();
                let score = 0;
                if (stripped === want) score += 10;
                else if (stripped.includes(want) || want.includes(stripped)) score += 4;
                else continue;
                if (title && String(visit.title || "").toLowerCase() === title.toLowerCase()) score += 5;
                if (score > bestScore) {
                    bestScore = score;
                    best = visit;
                }
            }
            return best;
        } catch (e) {
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
        const popup = ensurePopup();
        const visit = await resolveVisit(row);
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
        const handler = (event) => {
            if (!isOn()) return;
            const row = event.target?.closest?.(".zen-library-row");
            if (!row || !section.contains(row)) return;
            event.preventDefault();
            event.stopPropagation();
            showMenu(event, row);
        };
        section.addEventListener("contextmenu", handler);
        state.sections.set(section, handler);
    }

    function detachSection(section) {
        const handler = state.sections.get(section);
        if (handler) {
            try { section.removeEventListener("contextmenu", handler); } catch (e) { }
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
