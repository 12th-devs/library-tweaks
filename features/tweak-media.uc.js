"use strict";

// Library Tweaks - Native Media tweaks for the native Zen Library.
//
// THE single media file: panel width, grid sizing and context-menu actions
// for Zen's own Media section (zen-library-media-section). Nothing here
// replaces native rendering — the section stays 100% native.
//
// 1. Wider panel (zen.library.tweaks.media.wide, default on): grows the
//    Library to 794px — 1.9x the 418px of the other sections — while the
//    native Media tab shows, lifts the section's 308px cap (inline style, so
//    it always wins) and swaps in a roomier auto-fill grid like the old
//    custom tab. Off keeps native sizing. Applies immediately.
// 2. Rename/Delete (zen.library.tweaks.media.menu, default on): appends both
//    to the native .zen-library-media-menu, acting on the file on disk and
//    refreshing the grid in place (see below).

(function () {
    const PREF_WIDE = "zen.library.tweaks.media.wide";
    const PREF_MENU = "zen.library.tweaks.media.menu";
    const WIDE_PX = "794px";
    const STYLE_ID = "lt-media-wide-style";
    const STALE_STYLE_ID = "zen-media-native-style";
    const LOG_PREFIX = "[LibraryTweaks Media]";

    const wideOn = () => {
        try { return Services.prefs.getBoolPref(PREF_WIDE, true); }
        catch (e) { return true; }
    };
    const menuOn = () => {
        try { return Services.prefs.getBoolPref(PREF_MENU, true); }
        catch (e) { return true; }
    };

    function warn(...args) {
        try { console.warn(LOG_PREFIX, ...args); } catch (e) { }
    }

    function nsFile(path) {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        return file;
    }

    function fileExists(path) {
        try {
            if (!path) return false;
            return nsFile(path).exists();
        } catch (e) {
            return false;
        }
    }

    function nativeRoot(host) {
        try { return host?.shadowRoot || host || null; }
        catch (e) { return null; }
    }

    function mediaSection(root) {
        try {
            return root?.querySelector?.('zen-library-media-section[data-section="media"]')
                || root?.querySelector?.('.zen-library-section[data-section="media"]')
                || null;
        } catch (e) {
            return null;
        }
    }

    /* ------------------------------------------------- width + sizing */

    function ensureStyles(root) {
        if (!root?.querySelector) return;
        // Leftover from the retired custom Media section: its @import points
        // at a deleted file, so drop it wherever it lingers.
        try { root.querySelector("#" + STALE_STYLE_ID)?.remove(); } catch (e) { }
        // Roomier grid/cards while the 1.9x panel is on, closer to the old
        // masonry tab. Wide-only: at the default 308px cap these minimums
        // would collapse the grid to a single column.
        let wideCss = "";
        try {
            if (wideOn()) {
                wideCss = `
/* Native Media at 1.9x: roomier auto-fill grid and cards. */
zen-library-media-section.zen-library-section[data-section="media"] .zen-library-media-grid {
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
  padding: 12px 16px 16px;
}
zen-library-media-section.zen-library-section[data-section="media"] .zen-library-media-item {
  padding: 12px;
}`;
            }
        } catch (e) { }
        const css = `
/* Native Media at 1.9x: exempt from the 308px non-spaces cap so the section
   fills the grown panel. Tag-qualified, so it outranks the native rule whatever the order. */
zen-library-media-section.zen-library-section[data-section="media"] {
  max-width: none;
}${wideCss}`;
        const existing = root.querySelector(":scope > #" + STYLE_ID) ||
            root.querySelector("#" + STYLE_ID);
        if (existing) {
            if (existing.textContent !== css) existing.textContent = css;
            return;
        }
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = css;
        try { root.appendChild(style); } catch (e) { }
    }

    // Enforces the wide (or native) state on one library host. Every write is
    // diffed first, so this is cheap enough to run on host mutations. Mirrors
    // native Spaces: the wide panel belongs to the Media tab only.
    function syncHost(host) {
        if (!host?.isConnected) return;
        try {
            const tab = host.activeTab;
            const root = nativeRoot(host);
            if (tab === "media" && wideOn()) {
                try {
                    if (host.style.getPropertyValue("--zen-library-content-width") !== WIDE_PX) {
                        host.style.setProperty("--zen-library-content-width", WIDE_PX);
                    }
                } catch (e) { }
                // Inline style beats the native 308px cap regardless of
                // stylesheet order. The section element is recreated per tab
                // switch, so it is re-asserted here.
                try {
                    const section = mediaSection(root);
                    if (section && section.style.getPropertyValue("max-width") !== "none") {
                        section.style.setProperty("max-width", "none");
                    }
                } catch (e) { }
            } else if (tab !== "spaces") {
                // Leaving Media (or wide off): drop our width so other sections
                // render at their native size. Spaces manages its own width.
                try { host.style?.removeProperty?.("--zen-library-content-width"); } catch (e) { }
                try { mediaSection(root)?.style?.removeProperty?.("max-width"); } catch (e) { }
            }
        } catch (e) { }
        try { ensureStyles(nativeRoot(host)); } catch (e) { }
    }

    /* ------------------------------------------- rename/delete menu */

    const RENAME_ID = "lt-media-ctx-rename";
    const DELETE_ID = "lt-media-ctx-delete";
    const SEP_ID = "lt-media-ctx-sep";

    // Cards only carry the file name in `title`; the item objects live on the
    // section's public `items` state. Names can repeat across folders, so a
    // repeated name resolves by card order: the Nth same-named card maps to
    // the Nth same-named item, mirroring layout order.
    function resolveItem(section, card) {
        try {
            const name = (card?.title || "").trim();
            if (!name || !Array.isArray(section?.items)) return null;
            const matches = section.items.filter(item => item?.name === name);
            if (matches.length === 1) return matches[0];
            if (!matches.length) return null;
            const siblings = [...section.querySelectorAll(".zen-library-media-item")]
                .filter(c => (c.title || "").trim() === name);
            const index = siblings.indexOf(card);
            if (index < 0) return matches[0];
            return matches[Math.min(index, matches.length - 1)];
        } catch (e) {
            return null;
        }
    }

    function refreshSection(section) {
        try {
            if (Array.isArray(section.items)) section.items = [...section.items];
        } catch (e) { }
        try { section.requestUpdate?.(); } catch (e) { }
    }

    async function renameItem(section, item) {
        if (!item?.path) return;
        let file = null;
        try {
            file = nsFile(item.path);
            if (!file.exists()) return;
        } catch (e) {
            return;
        }
        const input = { value: item.name };
        let ok = false;
        try {
            ok = Services.prompt.prompt(window, "Rename File", null, input, null, { value: false });
        } catch (e) {
            return;
        }
        const name = ok ? String(input.value || "").trim() : "";
        if (!name || name === item.name) return;
        try {
            file.moveTo(file.parent, name);
        } catch (e) {
            warn("rename failed", e);
            return;
        }
        // Everything native derives (title lookup, thumb url) follows the path.
        try {
            item.name = name;
            item.path = file.path;
            try { item.url = PathUtils.toFileURI(file.path); } catch (e) { item.url = file.path; }
        } catch (e) { }
        refreshSection(section);
    }

    async function deleteItem(section, item) {
        if (!item?.path) return;
        let confirmed = false;
        try {
            confirmed = Services.prompt.confirm(window, "Delete File", `Delete "${item.name}"? This cannot be undone.`);
        } catch (e) {
            return;
        }
        if (!confirmed) return;
        try {
            const file = nsFile(item.path);
            try { if (file.exists()) file.remove(false); } catch (e) { }
        } catch (e) {
            return;
        }
        try {
            if (Array.isArray(section.items)) section.items = section.items.filter(i => i !== item);
        } catch (e) { }
        try { section.requestUpdate?.(); } catch (e) { }
    }

    function ensureMenuItems(popup) {
        let sep = popup.querySelector("#" + SEP_ID);
        let renameEl = popup.querySelector("#" + RENAME_ID);
        let deleteEl = popup.querySelector("#" + DELETE_ID);
        if (sep && renameEl && deleteEl) return { sep, renameEl, deleteEl };
        sep?.remove();
        renameEl?.remove();
        deleteEl?.remove();
        sep = document.createXULElement("menuseparator");
        sep.id = SEP_ID;
        renameEl = document.createXULElement("menuitem");
        renameEl.id = RENAME_ID;
        renameEl.setAttribute("label", "Rename file");
        deleteEl = document.createXULElement("menuitem");
        deleteEl.id = DELETE_ID;
        deleteEl.setAttribute("label", "Delete file");
        renameEl.addEventListener("command", () => {
            try {
                const { section, item } = popup._ltTarget || {};
                if (section?.isConnected && item) renameItem(section, item);
            } catch (e) { warn(e); }
        });
        deleteEl.addEventListener("command", () => {
            try {
                const { section, item } = popup._ltTarget || {};
                if (section?.isConnected && item) deleteItem(section, item);
            } catch (e) { warn(e); }
        });
        popup.append(sep, renameEl, deleteEl);
        return { sep, renameEl, deleteEl };
    }

    function removeMenuItems(popup) {
        try { popup._ltTarget = null; } catch (e) { }
        for (const id of [SEP_ID, RENAME_ID, DELETE_ID]) {
            try { popup.querySelector("#" + id)?.remove(); } catch (e) { }
        }
    }

    // Capture runs before native's own card listener and never prevents the
    // native menu — it only records which card the menu is for.
    function onContextMenu(event) {
        state.pending = null;
        if (!menuOn()) return;
        try {
            const card = event.target?.closest?.(".zen-library-media-item") || null;
            const section = card?.closest?.("zen-library-media-section") || null;
            if (card && section) state.pending = { card, section };
        } catch (e) { }
    }

    function onPopupShowing(event) {
        let popup = null;
        try {
            popup = event.target?.closest?.("menupopup") || event.target;
            if (!popup?.classList?.contains?.("zen-library-media-menu")) return;
        } catch (e) {
            return;
        }
        if (!menuOn()) {
            removeMenuItems(popup);
            return;
        }
        const pending = state.pending;
        state.pending = null;
        let section = null;
        let item = null;
        try {
            if (pending?.card?.isConnected && pending?.section?.isConnected) {
                section = pending.section;
                item = resolveItem(section, pending.card);
            }
        } catch (e) { }
        const { sep, renameEl, deleteEl } = ensureMenuItems(popup);
        try { popup._ltTarget = section && item ? { section, item } : null; } catch (e) { }
        // Missing files (moved outside the browser) offer no file actions,
        // mirroring the downloads tweak.
        const usable = !!(item?.path && fileExists(item.path));
        try {
            renameEl.disabled = !usable;
            deleteEl.disabled = !usable;
            sep.hidden = false;
        } catch (e) { }
    }

    /* ------------------------------------------------------- watching */

    const state = {
        // host -> last seen activeTab. WeakMap: hosts come and go with idle
        // cleanup, and entries vanish with them.
        tabs: new WeakMap(),
        pending: null,
        docObserver: null,
        wideObserver: null,
    };

    // One document observer drives everything: any DOM mutation re-checks
    // open libraries, but a host is only synced when its tab changed (or it
    // is new), and every write inside syncHost is diffed — so scrolling,
    // typing and thumbnail loads stay untouched.
    function scanDocument() {
        let hosts = [];
        try { hosts = [...document.querySelectorAll?.("zen-library") || []]; }
        catch (e) { return; }
        for (const host of hosts) {
            let tab = "";
            try { tab = host.activeTab; } catch (e) { continue; }
            if (state.tabs.get(host) === tab) continue;
            state.tabs.set(host, tab);
            try { syncHost(host); } catch (e) { warn("host sync failed", e); }
        }
    }

    // The wide toggle mutates no DOM, so push it out to Media tabs directly.
    function resyncMediaHosts() {
        try {
            for (const host of document.querySelectorAll?.("zen-library") || []) {
                if (host?.activeTab !== "media") continue;
                try { state.tabs.set(host, "media"); } catch (e) { }
                try { syncHost(host); } catch (e) { }
            }
        } catch (e) { }
    }

    function init() {
        try { scanDocument(); } catch (e) { }
        if (!state.docObserver) {
            state.docObserver = new MutationObserver(() => scanDocument());
            try {
                // Attributes too: switching between two already-mounted tabs
                // only flips hidden/showing/active, with no node changes.
                state.docObserver.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ["active", "hidden", "showing"],
                });
            } catch (e) {
                state.docObserver = null;
            }
        }
        if (!state.wideObserver) {
            state.wideObserver = { observe: () => resyncMediaHosts() };
            try { Services.prefs.addObserver(PREF_WIDE, state.wideObserver); }
            catch (e) { state.wideObserver = null; }
        }
        try { document.addEventListener("contextmenu", onContextMenu, true); } catch (e) { }
        try { document.addEventListener("popupshowing", onPopupShowing, true); } catch (e) { }
    }

    init();
    try { console.log(LOG_PREFIX, "tweak loaded"); } catch (e) { }
})();
