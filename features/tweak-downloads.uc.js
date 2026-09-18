"use strict";

// Library Tweaks — Downloads enhancements for the native Zen Library.
//
// 1. System-wide downloads (toggle, default off, like the reference mod):
//    an appended "On this device" group lists top-level files/folders from the
//    OS Downloads folder that have no download-history entry. Append-only: it
//    never touches Lit-managed nodes, and re-applies after native re-renders.
// 2. Rename in the native context menu (toggle, default on): a "Rename file"
//    item is appended to the native downloads popup, resolved against the
//    live Downloads list, and applied on disk.
// Native already resolves icons via moz-icon:// exactly like the reference
// mod's fileIconUrl, so no icon work is needed.

(function () {
    const PREF_SYSTEM = "zen.library.tweaks.downloads.system";
    const PREF_RENAME = "zen.library.tweaks.downloads.rename";
    const SCAN_CACHE_TTL_MS = 30000;
    const SCAN_CHUNK_SIZE = 25;
    const HIST_CACHE_TTL_MS = 300000;
    const MENU_ITEM_ID = "lt-downloads-ctx-rename";
    const DISK_MENU_ID = "lt-disk-context-menu";
    const GROUP_CLASS = "lt-disk-group";

    const getBool = (name, fallback) => {
        try { return Services.prefs.getBoolPref(name, fallback); }
        catch (e) { return fallback; }
    };
    const systemOn = () => getBool(PREF_SYSTEM, false);
    const renameOn = () => getBool(PREF_RENAME, true);

    const normPath = (path) => String(path || "").replace(/\\/g, "/").toLowerCase();

    function nsFile(path) {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        return file;
    }

    // Same construction as the reference mod: moz-icon over the file: URI so
    // special characters cannot swallow the ?size= parameter.
    function fileIconUrl(path, size = 32) {
        if (!path) return "";
        try {
            return "moz-icon://" + Services.io.newFileURI(nsFile(path)).spec + "?size=" + size;
        } catch (e) {
            return "";
        }
    }

    function formatSize(bytes) {
        const n = Number(bytes) || 0;
        if (n <= 0) return "0 Bytes";
        const units = ["Bytes", "KB", "MB", "GB", "TB"];
        const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
        return `${parseFloat((n / Math.pow(1024, i)).toFixed(1))} ${units[i]}`;
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
            return items;
        })().finally(() => { scanPromise = null; });
        return scanPromise;
    }

    function clearScanCache() {
        scanCache = null;
    }

    /* ------------------------------------------------------- disk group UI */

    function openDiskItem(item) {
        try {
            const file = nsFile(item.targetPath);
            if (!file.exists()) return;
            if (item.isFolder) file.reveal();
            else file.launch();
        } catch (e) { }
    }

    function ensureDiskMenu() {
        let popup = document.getElementById(DISK_MENU_ID);
        if (popup) return popup;
        popup = document.createXULElement("menupopup");
        popup.id = DISK_MENU_ID;
        for (const [id, label] of [
            ["lt-disk-ctx-open", "Open"],
            ["lt-disk-ctx-show", "Show in Folder"],
            ["lt-disk-ctx-rename", "Rename file"],
            ["lt-disk-ctx-delete", "Delete"],
        ]) {
            const item = document.createXULElement("menuitem");
            item.id = id;
            item.setAttribute("label", label);
            popup.appendChild(item);
            if (id === "lt-disk-ctx-show") popup.appendChild(document.createXULElement("menuseparator"));
        }
        (document.getElementById("mainPopupSet") || document.body).appendChild(popup);
        return popup;
    }

    function showDiskMenu(event, item, section) {
        const popup = ensureDiskMenu();
        for (const id of ["lt-disk-ctx-open", "lt-disk-ctx-show", "lt-disk-ctx-rename", "lt-disk-ctx-delete"]) {
            const el = document.getElementById(id);
            if (el) el.replaceWith(el.cloneNode(true));
        }
        const on = (id, handler) => {
            document.getElementById(id)?.addEventListener("command", async () => {
                try { await handler(); } catch (e) { console.error("[LibraryTweaks]", e); }
            });
        };
        on("lt-disk-ctx-open", () => openDiskItem(item));
        on("lt-disk-ctx-show", () => {
            try { nsFile(item.targetPath).reveal(); } catch (e) { }
        });
        const fileOnly = !item.isFolder;
        const renameEl = document.getElementById("lt-disk-ctx-rename");
        const deleteEl = document.getElementById("lt-disk-ctx-delete");
        if (renameEl) renameEl.hidden = !fileOnly;
        if (deleteEl) deleteEl.hidden = !fileOnly;
        on("lt-disk-ctx-rename", async () => {
            const input = { value: item.filename };
            const ok = Services.prompt.prompt(window, "Rename File", null, input, null, { value: false });
            const name = ok ? input.value.trim() : "";
            if (!name || name === item.filename) return;
            try {
                const file = nsFile(item.targetPath);
                if (!file.exists()) return;
                file.moveTo(file.parent, name);
                item.filename = name;
                item.targetPath = file.path;
                item.id = "disk|" + normPath(file.path);
                clearScanCache();
                applyGroup(section);
            } catch (e) { console.error("[LibraryTweaks] disk rename failed:", e); }
        });
        on("lt-disk-ctx-delete", async () => {
            const confirmed = Services.prompt.confirm(window, "Delete File", `Delete "${item.filename}"? This cannot be undone.`);
            if (!confirmed) return;
            try {
                const file = nsFile(item.targetPath);
                if (file.exists()) file.remove(false);
                clearScanCache();
                applyGroup(section);
            } catch (e) { console.error("[LibraryTweaks] disk delete failed:", e); }
        });
        popup.openPopupAtScreen(event.screenX, event.screenY, true);
    }

    function diskRow(item, section) {
        const row = document.createElement("div");
        row.className = "zen-library-row lt-disk-row";
        row.tabIndex = 0;
        row.title = item.targetPath;
        const icon = document.createElement("img");
        icon.className = "zen-library-row-icon";
        icon.alt = "";
        icon.src = fileIconUrl(item.targetPath);
        const text = document.createElement("div");
        text.className = "zen-library-row-text";
        const title = document.createElement("span");
        title.className = "zen-library-row-title";
        title.textContent = item.filename;
        const sub = document.createElement("span");
        sub.className = "zen-library-row-subtitle";
        sub.textContent = item.isFolder ? "Folder" : formatSize(item.size);
        text.append(title, sub);
        row.append(icon, text);
        row.addEventListener("click", () => openDiskItem(item));
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter") openDiskItem(item);
        });
        row.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
            showDiskMenu(event, item, section);
        });
        return row;
    }

    // Append-only group at the end of native results. Signature-guarded so our
    // own insertions never retrigger the observer loop.
    async function applyGroup(section) {
        const results = section.querySelector?.(".zen-library-search-results");
        if (!results) return;
        if (!systemOn()) {
            results.querySelector(":scope > ." + GROUP_CLASS)?.remove();
            return;
        }
        if (section._ltApplying) return;
        section._ltApplying = true;
        try {
            const filter = (section.querySelector?.(".zen-library-search-box input")?.value || "").trim().toLowerCase();
            const items = await scanDisk();
            if (!results.isConnected) return;
            const visible = filter ? items.filter(i => i.filename.toLowerCase().includes(filter)) : items;
            const sig = filter + "\n" + visible.map(i => i.id).join("\n");
            const existing = results.querySelector(":scope > ." + GROUP_CLASS);
            if (existing?.dataset.sig === sig) return;
            existing?.remove();
            if (!visible.length) return;
            const group = document.createElement("div");
            group.className = "zen-library-group " + GROUP_CLASS;
            group.dataset.sig = sig;
            const header = document.createElement("h3");
            header.textContent = "On this device";
            group.appendChild(header);
            for (const item of visible) group.appendChild(diskRow(item, section));
            results.appendChild(group);
        } finally {
            section._ltApplying = false;
        }
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
            const filename = (row.querySelector(".zen-library-row-title")?.textContent || "").trim();
            const urlText = (row.querySelector(".zen-library-download-url")?.textContent || "").trim();
            if (!filename) {
                console.warn("[LibraryTweaks] rename: no title in row");
                return null;
            }
            const cands = [];
            for (const list of await unifiedLists()) {
                let all = [];
                try { all = await list.getAll(); } catch (e) { continue; }
                for (const download of all) {
                    let name = "";
                    let source = "";
                    try {
                        name = download.target?.path ? PathUtils.filename(download.target.path) : "";
                        source = String(download.source?.url || "");
                    } catch (e) { continue; }
                    if (name !== filename) continue;
                    if (urlText && !source.includes(urlText)) continue;
                    if (!cands.includes(download)) cands.push(download);
                }
            }
            if (!cands.length) {
                console.warn("[LibraryTweaks] rename: no download matches", JSON.stringify(filename));
                return null;
            }
            if (cands.length > 1) {
                console.warn("[LibraryTweaks] rename: ambiguous (" + cands.length + " matches for " + JSON.stringify(filename) + ")");
                return null;
            }
            return cands[0];
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
        menu.addEventListener("popupshowing", async () => {
            item.hidden = true;
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
            // Moved or missing files are not renamable.
            if (!(await downloadExists(download))) {
                console.warn("[LibraryTweaks] rename: file missing, hiding");
                return;
            }
            item._ltDownload = download;
            item.hidden = false;
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
        applyGroup(section);
        if (state.sections.has(section)) return;
        // Record the row on the way in: the native [menu-open] marker is set by
        // native code we don't control, so keep our own reference as primary.
        const onContextMenu = (event) => {
            try {
                const row = event.target?.closest?.(".zen-library-row");
                section._ltMenuRow = row && section.contains(row) ? row : null;
            } catch (e) { }
        };
        const observer = new MutationObserver(() => applyGroup(section));
        try {
            section.addEventListener("contextmenu", onContextMenu, true);
            const results = section.querySelector?.(".zen-library-search-results") || section;
            observer.observe(results, { childList: true, subtree: true });
        } catch (e) { return; }
        state.sections.set(section, { observer, onContextMenu });
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
        try {
            section.querySelectorAll?.("." + GROUP_CLASS).forEach(n => n.remove());
        } catch (e) { }
    }

    function scanDocument() {
        ensureNativeMenuItem();
        for (const section of document.querySelectorAll?.("zen-library-downloads-section") || []) {
            if (systemOn()) attachSection(section);
            else detachSection(section);
        }
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
        for (const pref of [PREF_SYSTEM, PREF_RENAME]) {
            const observer = { observe: () => scanDocument() };
            try {
                Services.prefs.addObserver(pref, observer);
                state.prefObservers.push([pref, observer]);
            } catch (e) { }
        }
    }

    init();
})();
