"use strict";

// Library Tweaks — Downloads enhancements for the native Zen Library.
//
// 1. System-wide downloads (toggle, default off, like the reference mod):
//    top-level files from the OS Downloads folder that have no download-history
//    entry are published as real history entries, so native lists them itself —
//    chronologically, with working open/menus/rename — instead of a separate
//    group. Folders are skipped (history holds files, not folders).
// 2. Rename in the native context menu (toggle, default on): a "Rename file"
//    item is appended to the native downloads popup, resolved against the
//    live Downloads list, and applied on disk.
// Native already resolves icons via moz-icon:// exactly like the reference
// mod's fileIconUrl, so no icon work is needed.

(function () {
    const PREF_SYSTEM = "zen.library.tweaks.downloads.system";
    const PREF_RENAME = "zen.library.tweaks.downloads.rename";
    const PREF_DIM = "zen.library.tweaks.downloads.dim-missing";
    const DIM_STYLE_ID = "lt-downloads-dim-style";
    const SCAN_CACHE_TTL_MS = 30000;
    const SCAN_CHUNK_SIZE = 25;
    const HIST_CACHE_TTL_MS = 300000;
    const MENU_ITEM_ID = "lt-downloads-ctx-rename";
    const FABRICATED_PREF = "zen.library.tweaks.downloads.fabricated";
    const DESTINATION_ANNO = "downloads/destinationFileURI";

    const getBool = (name, fallback) => {
        try { return Services.prefs.getBoolPref(name, fallback); }
        catch (e) { return fallback; }
    };
    const systemOn = () => getBool(PREF_SYSTEM, false);
    const renameOn = () => getBool(PREF_RENAME, true);
    const dimOn = () => getBool(PREF_DIM, true);

    const DIM_CSS = `zen-library-downloads-section .zen-library-row[lt-missing] { opacity: 0.45; }`;

    function ensureDimStyle() {
        if (document.getElementById(DIM_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = DIM_STYLE_ID;
        style.textContent = DIM_CSS;
        try { document.documentElement.appendChild(style); } catch (e) { }
    }

    function removeDimStyle() {
        try { document.getElementById(DIM_STYLE_ID)?.remove(); } catch (e) { }
    }

    function clearRowOverrides() {
        try {
            document.querySelectorAll?.("zen-library-downloads-section .zen-library-row[lt-missing]")
                .forEach(n => n.removeAttribute("lt-missing"));
        } catch (e) { }
    }

    // Periodic publish driver: a fresh scan (at most every 30s) picks up files
    // copied in while the tab sits open. Runs only while sections are mounted.
    let publishTimer = 0;
    function ensurePublishTimer() {
        if (publishTimer || !systemOn()) return;
        publishTimer = window.setInterval(() => {
            if (!systemOn() || isPrivateWindow()) return;
            try { scanDisk(); } catch (e) { }
        }, 45000);
    }

    function clearPublishTimer() {
        clearInterval(publishTimer);
        publishTimer = 0;
    }

    // Filename index over the unified session+history snapshot, shared by one
    // pass so rename/menu/sync never fan out into repeated full reads.
    let unifiedCache = null;
    async function downloadIndex(maxAgeMs = 30000) {
        const now = Date.now();
        if (unifiedCache && now - unifiedCache.at < maxAgeMs) return unifiedCache.byName;
        const byName = new Map();
        try {
            for (const list of await unifiedLists()) {
                let all = [];
                try { all = await list.getAll(); } catch (e) { continue; }
                for (const download of all) {
                    let name = "";
                    try { name = download.target?.path ? PathUtils.filename(download.target.path) : ""; }
                    catch (e) { continue; }
                    if (!name) continue;
                    if (!byName.has(name)) byName.set(name, []);
                    const arr = byName.get(name);
                    if (!arr.includes(download)) arr.push(download);
                }
            }
        } catch (e) { }
        unifiedCache = { at: now, byName };
        return byName;
    }

    function matchRowDownload(byName, row) {
        const filename = (row.querySelector(".zen-library-row-title")?.textContent || "").trim();
        if (!filename) return null;
        const urlText = (row.querySelector(".zen-library-download-url")?.textContent || "").trim();
        const cands = (byName.get(filename) || []).filter(d => {
            try { return !urlText || String(d.source?.url || "").includes(urlText); }
            catch (e) { return true; }
        });
        return cands.length === 1 ? cands[0] : null;
    }

    function rowIsLive(row) {
        try {
            return row.hasAttribute("pending") || row.hasAttribute("indeterminate") ||
                row.hasAttribute("paused") || row.hasAttribute("opening");
        } catch (e) {
            return false;
        }
    }

    // One debounced pass per section that dims moved/missing files (dim pref).
    // Attribute-only changes on Lit-owned nodes: Lit never binds lt-missing,
    // so updates never fight these back.
    const syncTimers = new WeakMap();
    function scheduleSyncRows(section) {
        if (!dimOn() || syncTimers.get(section)) return;
        syncTimers.set(section, window.setTimeout(() => {
            syncTimers.delete(section);
            syncNativeRows(section);
        }, 750));
    }

    async function syncNativeRows(section) {
        if (!dimOn() || !section?.isConnected) return;
        const byName = await downloadIndex();
        if (!section.isConnected) return;
        const statCache = new Map();
        const isMissing = async (download) => {
            try {
                if (download.deleted) return true;
                const path = download.target?.path;
                if (!path) return true;
                if (download.target?.exists === false) return true;
                if (statCache.has(path)) return statCache.get(path);
                let missing = false;
                try { await IOUtils.stat(path); }
                catch (e) { missing = true; }
                statCache.set(path, missing);
                return missing;
            } catch (e) {
                return false;
            }
        };
        try {
            for (const row of section.querySelectorAll(".zen-library-row")) {
                if (!row.isConnected) continue;
                if (rowIsLive(row)) {
                    row.removeAttribute("lt-missing");
                    continue;
                }
                const download = matchRowDownload(byName, row);
                if (dimOn() && download) {
                    try {
                        if (await isMissing(download)) row.setAttribute("lt-missing", "");
                    } catch (e) { }
                } else {
                    row.removeAttribute("lt-missing");
                }
            }
        } catch (e) { }
    }

    const normPath = (path) => String(path || "").replace(/\\/g, "/").toLowerCase();

    function nsFile(path) {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        return file;
    }



    /* ------------------------------------------------------- disk scan */

    let scanCache = null;
    let scanPromise = null;
    let histCache = null;

    async function historyPaths() {
        const now = Date.now();
        if (histCache && now - histCache.at < HIST_CACHE_TTL_MS) return histCache.paths;
        const paths = new Set();
        try {
            const { DownloadHistory } = ChromeUtils.importESModule("resource://gre/modules/DownloadHistory.sys.mjs");
            const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
            const list = await DownloadHistory.getList({ type: Downloads.ALL });
            const all = await list.getAll();
            for (const d of all) {
                try { if (d?.target?.path) paths.add(normPath(d.target.path)); } catch (e) { }
            }
        } catch (e) { }
        histCache = { at: now, paths };
        return paths;
    }

    async function scanDisk() {
        const now = Date.now();
        if (scanCache && now - scanCache.at < SCAN_CACHE_TTL_MS && scanCache.items) {
            return scanCache.items;
        }
        if (scanPromise) return scanPromise;
        scanPromise = (async () => {
            const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
            let folder = "";
            try { folder = await Downloads.getPreferredDownloadsDirectory(); } catch (e) { }
            if (!folder) {
                try { folder = await Downloads.getSystemDownloadsDirectory(); } catch (e) { }
            }
            if (!folder) return [];
            const known = await historyPaths();
            let children = [];
            try { children = await IOUtils.getChildren(folder); } catch (e) { return []; }
            let isWin = false;
            try { isWin = Services.appinfo.OS === "WINNT"; } catch (e) { }
            const items = [];
            for (let i = 0; i < children.length; i += SCAN_CHUNK_SIZE) {
                const batch = await Promise.all(children.slice(i, i + SCAN_CHUNK_SIZE).map(async (path) => {
                    try {
                        const leaf = PathUtils.filename(path);
                        if (!leaf || leaf.startsWith(".") || leaf.endsWith(".part")) return null;
                        if (isWin) {
                            try {
                                const attrs = await IOUtils.getWindowsAttributes(path);
                                if (attrs.hidden || attrs.system) return null;
                            } catch (e) { }
                        }
                        const info = await IOUtils.stat(path);
                        if (info.type !== "regular" && info.type !== "directory") return null;
                        if (known.has(normPath(path))) return null;
                        return {
                            id: "disk|" + normPath(path),
                            filename: leaf,
                            targetPath: path,
                            size: info.type === "directory" ? 0 : (info.size || 0),
                            timestamp: info.lastModified || 0,
                            isFolder: info.type === "directory",
                        };
                    } catch (e) {
                        return null;
                    }
                }));
                for (const item of batch) if (item) items.push(item);
                await new Promise(r => window.setTimeout(r, 0));
            }
            items.sort((a, b) => b.timestamp - a.timestamp);
            scanCache = { folder, at: Date.now(), items };
            try { await publishDiskEntries(items); } catch (e) { }
            return items;
        })().finally(() => { scanPromise = null; });
        return scanPromise;
    }

    function clearScanCache() {
        scanCache = null;
    }

    function fabricatedUrls() {
        try {
            const parsed = JSON.parse(Services.prefs.getStringPref(FABRICATED_PREF, "[]"));
            if (Array.isArray(parsed)) return new Set(parsed.filter(u => typeof u === "string" && u));
        } catch (e) { }
        return new Set();
    }

    function rememberFabricated(url) {
        try {
            const set = fabricatedUrls();
            set.add(url);
            Services.prefs.setStringPref(FABRICATED_PREF, JSON.stringify([...set]));
        } catch (e) { }
    }

    function forgetFabricated(url) {
        try {
            const set = fabricatedUrls();
            if (set.delete(url)) Services.prefs.setStringPref(FABRICATED_PREF, JSON.stringify([...set]));
        } catch (e) { }
    }

    function isPrivateWindow() {
        try {
            const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
            return PrivateBrowsingUtils.isWindowPrivate(window);
        } catch (e) {
            return false;
        }
    }

    // Publishes disk files as real download-history entries (visit + metadata
    // annotations), so native lists them chronologically with full behavior.
    // Skips folders (history holds files), private windows (never write shared
    // history from one), and anything already recorded.
    async function publishDiskEntries(items) {
        if (!systemOn() || isPrivateWindow()) return;
        const fabricated = fabricatedUrls();
        let changed = false;
        const { DownloadHistory } = ChromeUtils.importESModule("resource://gre/modules/DownloadHistory.sys.mjs");
        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
        let n = 0;
        for (const item of items) {
            if (item.isFolder) continue;
            let fileURI = "";
            try { fileURI = Services.io.newFileURI(nsFile(item.targetPath)).spec; }
            catch (e) { continue; }
            if (fabricated.has(fileURI)) continue;
            const download = {
                source: { url: fileURI, originalUrl: fileURI, isPrivate: false },
                target: { path: item.targetPath, size: item.size },
                startTime: item.timestamp,
                endTime: item.timestamp,
                stopped: true,
                succeeded: true,
                deleted: false,
                error: null,
            };
            try {
                await DownloadHistory.addDownloadToHistory(download);
                await DownloadHistory.updateMetaData(download);
                let ok = false;
                try { ok = !!(await PlacesUtils.history.fetch(fileURI)); }
                catch (e) { }
                if (ok) {
                    rememberFabricated(fileURI);
                    fabricated.add(fileURI);
                    changed = true;
                } else {
                    console.warn("[LibraryTweaks] system: store rejected", item.filename);
                }
            } catch (e) {
                console.warn("[LibraryTweaks] system: publish failed for", item.filename, e);
            }
            if (++n % 25 === 0) await new Promise(r => window.setTimeout(r, 0));
        }
        if (changed) {
            histCache = null;
            unifiedCache = null;
        }
    }

    // Removes everything we published. Best effort: entries stay gone because
    // the Places result observer drops their rows automatically.
    async function unpublishDiskEntries() {
        const fabricated = fabricatedUrls();
        if (!fabricated.size) return;
        try {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            for (const url of fabricated) {
                try { await PlacesUtils.history.remove(url); } catch (e) { }
            }
        } catch (e) { }
        try { Services.prefs.setStringPref(FABRICATED_PREF, "[]"); } catch (e) { }
        histCache = null;
        unifiedCache = null;
        clearScanCache();
    }

    /* ------------------------------------------------------- native rename */

    // Resolved against the UNIFIED session+history list (DownloadHistoryList),
    // so both fresh and previous-session rows match. HistoryDownload objects
    // expose the same target.path/source.url shape and a refresh() mimic.
    // Resolved against the SAME unified list instance native renders from
    // (DownloadHistory.getList({type: PUBLIC}) is singleton-cached), so mutations
    // land on native's own objects and refresh() notifies its views directly.
    async function unifiedLists() {
        const lists = [];
        try {
            const { DownloadHistory } = ChromeUtils.importESModule("resource://gre/modules/DownloadHistory.sys.mjs");
            const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
            lists.push(await DownloadHistory.getList({ type: Downloads.PUBLIC }));
            try {
                const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
                if (PrivateBrowsingUtils.isWindowPrivate(window)) {
                    lists.push(await DownloadHistory.getList({ type: Downloads.ALL }));
                }
            } catch (e) { }
        } catch (e) {
            console.warn("[LibraryTweaks] rename: download lists unavailable:", e);
        }
        return lists;
    }

    async function resolveNativeDownload(row) {
        try {
            const byName = await downloadIndex(10000);
            const download = matchRowDownload(byName, row);
            if (!download) {
                const filename = (row.querySelector(".zen-library-row-title")?.textContent || "").trim();
                console.warn("[LibraryTweaks] rename: no unique download matches", JSON.stringify(filename));
                return null;
            }
            return download;
        } catch (e) {
            console.warn("[LibraryTweaks] rename: resolve failed:", e);
            return null;
        }
    }

    async function downloadExists(download) {
        try {
            if (!download?.target?.path) return false;
            await IOUtils.stat(download.target.path);
            return true;
        } catch (e) {
            return false;
        }
    }

    function ensureNativeMenuItem() {
        const menu = document.querySelector?.(".zen-library-downloads-menu");
        if (!menu || menu.querySelector("#" + MENU_ITEM_ID)) return;
        if (!renameOn()) return;
        const separator = document.createXULElement("menuseparator");
        const item = document.createXULElement("menuitem");
        item.id = MENU_ITEM_ID;
        item.setAttribute("label", "Rename file");
        item.hidden = true;
        separator.hidden = true;
        item.addEventListener("command", async () => {
            const download = item._ltDownload;
            if (!download?.target?.path) return;
            const filename = PathUtils.filename(download.target.path);
            const input = { value: filename };
            const ok = Services.prompt.prompt(window, "Rename File", null, input, null, { value: false });
            const name = ok ? input.value.trim() : "";
            if (!name || name === filename) return;
            try {
                const file = nsFile(download.target.path);
                if (!file.exists()) return;
                const oldNorm = normPath(download.target.path);
                const sourceUrl = String(download.source?.url || "");
                const wasFabricated = !!sourceUrl && fabricatedUrls().has(sourceUrl);
                file.moveTo(file.parent, name);
                // Point the (shared, native-rendered) object at the new path and
                // verify the write stuck; refresh() then notifies native's views
                // so the section re-renders with the new name by itself.
                let stuck = false;
                try {
                    download.target.path = file.path;
                    stuck = download.target.path === file.path;
                } catch (e) {
                    console.warn("[LibraryTweaks] rename: target.path not writable:", e);
                }
                // Fabricated entries persist in Places: move the destination
                // annotation too or the old path resurrects on reopen.
                if (wasFabricated) {
                    try {
                        const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                        const newFileURI = Services.io.newFileURI(file).spec;
                        let guid = null;
                        try { guid = (await PlacesUtils.history.fetch(sourceUrl))?.guid || null; }
                        catch (e) { }
                        await PlacesUtils.history.update({
                            annotations: new Map([[DESTINATION_ANNO, newFileURI]]),
                            ...(guid ? { guid } : {}),
                            url: sourceUrl,
                        });
                    } catch (e) {
                        console.warn("[LibraryTweaks] rename: annotation update failed:", e);
                    }
                    try {
                        histCache?.paths?.delete(oldNorm);
                        histCache?.paths?.add(normPath(file.path));
                    } catch (e) { }
                }
                try { await download.refresh?.(); } catch (e) {
                    console.warn("[LibraryTweaks] rename: refresh failed:", e);
                }
                try {
                    const row = document.querySelector("zen-library-downloads-section .zen-library-row[menu-open]");
                    const titleEl = row?.querySelector(".zen-library-row-title");
                    if (titleEl) titleEl.textContent = name;
                } catch (e) { }
                document.querySelector("zen-library")?.requestUpdate?.();
                if (!stuck) console.warn("[LibraryTweaks] rename: name applied to row but may revert on next data refresh");
                clearScanCache();
            } catch (e) {
                console.error("[LibraryTweaks] rename failed:", e);
            }
        });
        menu.append(separator, item);
        menu._ltRenameItem = item;
        menu._ltRenameSeparator = separator;
        menu.addEventListener("popupshowing", async () => {
            item.hidden = true;
            separator.hidden = true;
            item._ltDownload = null;
            if (!renameOn()) return;
            // Our capture-phase record first, native [menu-open] marker second.
            let row = null;
            for (const section of document.querySelectorAll?.("zen-library-downloads-section") || []) {
                if (section._ltMenuRow?.isConnected) {
                    row = section._ltMenuRow;
                    break;
                }
            }
            row ||= document.querySelector("zen-library-downloads-section .zen-library-row[menu-open]");
            if (!row) {
                console.warn("[LibraryTweaks] rename: no row for menu");
                return;
            }
            const download = await resolveNativeDownload(row);
            if (!download || !row.isConnected) return;
            // Moved or missing files are not renamable (no dangling divider).
            if (!(await downloadExists(download))) {
                console.warn("[LibraryTweaks] rename: file missing, hiding");
                return;
            }
            item._ltDownload = download;
            item.hidden = false;
            menu._ltRenameSeparator.hidden = false;
        });
    }

    /* ------------------------------------------------------- watching */

    const state = {
        sections: new Map(),
        docObserver: null,
        prefObservers: [],
    };

    function attachSection(section) {
        if (!section) return;
        // Publishing happens through the scan cache: first mount scans (and
        // publishes), later mounts reuse it until the TTL lapses.
        if (systemOn()) {
            try { scanDisk(); } catch (e) { }
            ensurePublishTimer();
        }
        if (state.sections.has(section)) return;
        // Record the row on the way in: the native [menu-open] marker is set by
        // native code we don't control, so keep our own reference as primary.
        const onContextMenu = (event) => {
            try {
                const row = event.target?.closest?.(".zen-library-row");
                section._ltMenuRow = row && section.contains(row) ? row : null;
            } catch (e) { }
        };
        const observer = new MutationObserver(() => {
            scheduleSyncRows(section);
        });
        try {
            section.addEventListener("contextmenu", onContextMenu, true);
            const results = section.querySelector?.(".zen-library-search-results") || section;
            observer.observe(results, { childList: true, subtree: true });
        } catch (e) { return; }
        state.sections.set(section, { observer, onContextMenu });
        scheduleSyncRows(section);
    }

    function detachSection(section) {
        const record = state.sections.get(section);
        if (record) {
            try { record.observer?.disconnect?.(); } catch (e) { }
            try {
                if (record.onContextMenu) section.removeEventListener("contextmenu", record.onContextMenu, true);
            } catch (e) { }
            state.sections.delete(section);
        }
        if (!state.sections.size) clearPublishTimer();
    }

    // Toggling system-wide off pulls everything we published back out of
    // history (native drops those rows itself via its Places observer).
    let lastSystemState = null;

    function scanDocument() {
        ensureNativeMenuItem();
        if (dimOn()) ensureDimStyle();
        else removeDimStyle();
        const watching = systemOn();
        if (lastSystemState === null) lastSystemState = watching;
        if (lastSystemState && !watching) {
            try { unpublishDiskEntries(); } catch (e) { }
            clearScanCache();
        }
        lastSystemState = watching;
        const watchRows = dimOn() || watching;
        for (const section of document.querySelectorAll?.("zen-library-downloads-section") || []) {
            if (watchRows) attachSection(section);
            else detachSection(section);
        }
        if (!watchRows) clearRowOverrides();
        if (!renameOn()) {
            try { document.getElementById(MENU_ITEM_ID)?.remove(); } catch (e) { }
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
        for (const pref of [PREF_SYSTEM, PREF_RENAME, PREF_DIM]) {
            const observer = { observe: () => scanDocument() };
            try {
                Services.prefs.addObserver(pref, observer);
                state.prefObservers.push([pref, observer]);
            } catch (e) { }
        }
    }

    init();
})();
