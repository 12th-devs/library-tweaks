"use strict";

// Library Tweaks — Downloads enhancements for the native Zen Library.
//
// 1. System-wide downloads (toggle, default off, like the reference mod):
//    an appended "On this device" group lists top-level files/folders from the
//    OS Downloads folder that have no download-history entry. Append-only: it
//    never touches Lit-managed nodes, re-applies after native re-renders, and
//    mirrors the native search text plus type/when filters.
// 2. Rename in the native context menu (toggle, default on): a "Rename file"
//    item is appended to the native downloads popup, resolved against the
//    live Downloads list, and applied on disk.
// Native already resolves icons via moz-icon:// exactly like the reference
// mod's fileIconUrl, so no icon work is needed.

(function () {
    const PREF_SYSTEM = "zen.library.tweaks.downloads.system";
    const PREF_RENAME = "zen.library.tweaks.downloads.rename";
    const PREF_DIM = "zen.library.tweaks.downloads.dim-missing";
    const FABRICATED_PREF = "zen.library.tweaks.downloads.fabricated";

    // One-time cleanup: an earlier build published disk files as history
    // entries; pull those back out and forget the list.
    (async () => {
        let urls = [];
        try {
            const parsed = JSON.parse(Services.prefs.getStringPref(FABRICATED_PREF, "[]"));
            if (Array.isArray(parsed)) urls = parsed.filter(u => typeof u === "string" && u);
        } catch (e) { }
        if (!urls.length) return;
        try {
            const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
            for (const url of urls) {
                try { await PlacesUtils.history.remove(url); } catch (e) { }
            }
        } catch (e) { }
        try { Services.prefs.setStringPref(FABRICATED_PREF, "[]"); } catch (e) { }
    })();
    const DIM_STYLE_ID = "lt-downloads-dim-style";
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

    function clearMissingMarks() {
        try {
            document.querySelectorAll?.("zen-library-downloads-section .zen-library-row[lt-missing]")
                .forEach(n => n.removeAttribute("lt-missing"));
        } catch (e) { }
    }

    // Grey out moved/missing files. Debounced per section and resolved against
    // one unified snapshot per pass, so native re-render bursts stay cheap.
    const markTimers = new WeakMap();
    function scheduleMarkMissing(section) {
        if (!dimOn() || markTimers.get(section)) return;
        markTimers.set(section, window.setTimeout(() => {
            markTimers.delete(section);
            markMissingRows(section);
        }, 750));
    }

    async function markMissingRows(section) {
        if (!dimOn() || !section?.isConnected) return;
        let rows = [];
        try {
            for (const row of section.querySelectorAll(".zen-library-row")) {
                if (row.closest("." + GROUP_CLASS)) continue;
                if (row._ltMissingChecked) continue;
                rows.push(row);
            }
        } catch (e) { return; }
        if (!rows.length) return;
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
                    byName.get(name).push(download);
                }
            }
        } catch (e) { return; }
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
        for (const row of rows) {
            if (!row.isConnected) continue;
            row._ltMissingChecked = true;
            const filename = (row.querySelector(".zen-library-row-title")?.textContent || "").trim();
            const urlText = (row.querySelector(".zen-library-download-url")?.textContent || "").trim();
            const cands = (byName.get(filename) || []).filter(d => {
                try { return !urlText || String(d.source?.url || "").includes(urlText); }
                catch (e) { return true; }
            });
            if (cands.length !== 1) continue;
            try {
                if (await isMissing(cands[0])) row.setAttribute("lt-missing", "");
                else row.removeAttribute("lt-missing");
            } catch (e) { }
        }
    }

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

    function clearHistCache() {
        histCache = null;
    }

    function clearAllCaches() {
        scanCache = null;
        histCache = null;
    }

    // Force the visible Downloads sections to re-render with the new name.
    // Mutating download.target.path + refresh() notifies native views, but the
    // row title is also patched directly so the change is visible even if a
    // list instance is not shared with native. Mirrors how the native section
    // re-renders on onDownloadChanged -> requestUpdate (see
    // ZenLibraryDownloadsSection in the reference library sources).
    function refreshDownloadsSections(newName) {
        try {
            const sections = [...(document.querySelectorAll?.("zen-library-downloads-section") || [])];
            for (const section of sections) {
                try {
                    // Drop the dim verdict so the renamed row is re-checked.
                    section.querySelectorAll?.(".zen-library-row").forEach(row => {
                        try { delete row._ltMissingChecked; } catch (e) { }
                    });
                } catch (e) { }
                if (newName) {
                    try {
                        const openRow = section._ltMenuRow?.isConnected ? section._ltMenuRow :
                            section.querySelector?.(".zen-library-row[menu-open]");
                        const titleEl = openRow?.querySelector?.(".zen-library-row-title");
                        if (titleEl) titleEl.textContent = newName;
                    } catch (e) { }
                }
                try { section.requestUpdate?.(); } catch (e) { }
            }
        } catch (e) { }
        try { document.querySelector("zen-library")?.requestUpdate?.(); } catch (e) { }
    }

    /* ------------------------------------------- native filter mirroring */

    // Same file-type vocabulary as the native Downloads section
    // (ZenLibraryDownloadsSection): the on-device rows filter identically.
    const MS_PER_DAY = 86400000;
    const DISK_FILE_TYPES = {
        images: "png jpg jpeg gif webp svg bmp tif tiff heic heif avif ico",
        video: "mp4 mkv mov avi webm m4v wmv flv mpg mpeg",
        audio: "mp3 wav flac aac ogg oga m4a opus wma aiff",
        documents: "pdf doc docx xls xlsx ppt pptx txt md rtf odt ods odp csv epub pages numbers key",
        archives: "zip rar 7z tar gz bz2 xz tgz zst",
        apps: "dmg pkg exe msi app deb rpm appimage apk jar",
    };
    const DISK_EXT_TO_TYPE = new Map();
    for (const [type, exts] of Object.entries(DISK_FILE_TYPES)) {
        for (const ext of exts.split(" ")) DISK_EXT_TO_TYPE.set(ext, type);
    }
    const DISK_WHEN_DAYS = { today: 1, week: 7, month: 30 };

    // Read straight off the native section instance (plain fields, so no Lit
    // update is triggered by looking). Missing on older builds → no filtering.
    function diskActiveTypes(section) {
        try {
            const set = section?.activeFilters;
            if (!set) return [];
            const types = [];
            for (const key of set) {
                if (typeof key === "string" && key.startsWith("type:")) types.push(key.slice(5));
            }
            return types;
        } catch (e) { return []; }
    }

    function diskActiveWhenDays(section) {
        try {
            const set = section?.activeFilters;
            if (!set) return null;
            let days = null;
            for (const key of set) {
                if (typeof key !== "string" || !key.startsWith("when:")) continue;
                const d = DISK_WHEN_DAYS[key.slice(5)];
                if (d && (days === null || d > days)) days = d;
            }
            return days;
        } catch (e) { return null; }
    }

    function diskFileType(item) {
        if (!item || item.isFolder) return undefined;
        const m = String(item.filename || "").match(/\.([^.]+)$/);
        return m ? DISK_EXT_TO_TYPE.get(m[1].toLowerCase()) : undefined;
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
                clearAllCaches();
                await applyGroup(section);
            } catch (e) { console.error("[LibraryTweaks] disk rename failed:", e); }
        });
        on("lt-disk-ctx-delete", async () => {
            const confirmed = Services.prompt.confirm(window, "Delete File", `Delete "${item.filename}"? This cannot be undone.`);
            if (!confirmed) return;
            try {
                const file = nsFile(item.targetPath);
                if (file.exists()) file.remove(false);
                clearAllCaches();
                await applyGroup(section);
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

    // Coalesced re-apply: native re-render bursts and chip clicks collapse
    // into one trailing pass instead of overlapping scans.
    function scheduleApply(section) {
        if (!section || section._ltScheduled) return;
        section._ltScheduled = true;
        window.setTimeout(() => {
            section._ltScheduled = false;
            try { applyGroup(section); } catch (e) { }
        }, 0);
    }

    // Append-only group at the end of native results. Signature-guarded so our
    // own insertions never retrigger the observer loop. Applies the same
    // search text, type pills and when-filters native does, so the group
    // reads as part of the section rather than an unfiltered appendix.
    async function applyGroup(section) {
        let results = section.querySelector?.(".zen-library-search-results");
        if (!results) return;
        if (!systemOn()) {
            results.querySelector(":scope > ." + GROUP_CLASS)?.remove();
            return;
        }
        if (section._ltApplying) {
            section._ltQueued = true;
            return;
        }
        section._ltApplying = true;
        try {
            do {
                section._ltQueued = false;
                const filter = (section.querySelector?.(".zen-library-search-box input")?.value || "").trim().toLowerCase();
                const types = diskActiveTypes(section);
                const whenDays = diskActiveWhenDays(section);
                const cutoff = whenDays ? Date.now() - whenDays * MS_PER_DAY : 0;
                const items = await scanDisk();
                if (!section.isConnected) return;
                results = section.querySelector?.(".zen-library-search-results");
                if (!results || !results.isConnected) return;
                const visible = items.filter(i => {
                    if (filter && !i.filename.toLowerCase().includes(filter)) return false;
                    if (types.length && !types.includes(diskFileType(i))) return false;
                    if (cutoff && !(i.timestamp >= cutoff)) return false;
                    return true;
                });
                const sig = filter + "\n" + types.join(",") + "\n" + (whenDays || "") + "\n" + visible.map(i => i.id).join("\n");
                const existing = results.querySelector(":scope > ." + GROUP_CLASS);
                if (existing?.dataset.sig === sig) {
                    if (!section._ltQueued) return;
                    continue;
                }
                existing?.remove();
                if (!visible.length) {
                    if (!section._ltQueued) return;
                    continue;
                }
                const group = document.createElement("div");
                group.className = "zen-library-group " + GROUP_CLASS;
                group.dataset.sig = sig;
                const header = document.createElement("h3");
                header.textContent = "On this device";
                group.appendChild(header);
                for (const item of visible) group.appendChild(diskRow(item, section));
                results.appendChild(group);
            } while (section._ltQueued);
        } finally {
            section._ltApplying = false;
            section._ltQueued = false;
        }
    }

    /* ------------------------------------------------------- native rename */

    // Resolved against BOTH the live session lists (Downloads.getList, what the
    // native ZenLibraryDownloadsSection renders from via DownloadsCommon.getData)
    // and the history lists (DownloadHistory.getList, previous sessions), so
    // fresh and older rows match. Mutating every match + refresh() notifies
    // native's views directly, and refreshDownloadsSections() re-renders.
    async function unifiedLists() {
        const lists = [];
        try {
            const { DownloadHistory } = ChromeUtils.importESModule("resource://gre/modules/DownloadHistory.sys.mjs");
            const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
            try { lists.push(await Downloads.getList(Downloads.PUBLIC)); } catch (e) { }
            try { lists.push(await DownloadHistory.getList({ type: Downloads.PUBLIC })); } catch (e) { }
            try {
                const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
                if (PrivateBrowsingUtils.isWindowPrivate(window)) {
                    try { lists.push(await Downloads.getList(Downloads.ALL)); } catch (e) { }
                    try { lists.push(await DownloadHistory.getList({ type: Downloads.ALL })); } catch (e) { }
                }
            } catch (e) { }
        } catch (e) {
            console.warn("[LibraryTweaks] rename: download lists unavailable:", e);
        }
        return lists;
    }

    function downloadMatches(download, filename, urlText) {
        try {
            const name = download.target?.path ? PathUtils.filename(download.target.path) : "";
            if (name !== filename) return false;
            if (urlText) {
                const source = String(download.source?.url || "");
                if (!source.includes(urlText)) return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async function resolveAllNativeDownloads(filename, urlText) {
        const cands = [];
        for (const list of await unifiedLists()) {
            let all = [];
            try { all = await list.getAll(); } catch (e) { continue; }
            for (const download of all) {
                if (!downloadMatches(download, filename, urlText)) continue;
                if (!cands.includes(download)) cands.push(download);
            }
        }
        return cands;
    }

    async function resolveNativeDownload(row) {
        try {
            const filename = (row.querySelector(".zen-library-row-title")?.textContent || "").trim();
            const urlText = (row.querySelector(".zen-library-download-url")?.textContent || "").trim();
            if (!filename) {
                console.warn("[LibraryTweaks] rename: no title in row");
                return null;
            }
            const cands = await resolveAllNativeDownloads(filename, urlText);
            if (!cands.length) {
                console.warn("[LibraryTweaks] rename: no download matches", JSON.stringify(filename));
                return null;
            }
            // Same file tracked by both the session and history lists: return the
            // first for menu gating, the rename handler updates every match.
            if (cands.length > 1) {
                console.debug("[LibraryTweaks] rename: " + cands.length + " matches for " + JSON.stringify(filename) + ", using first");
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
        separator.hidden = true;
        item.addEventListener("command", async () => {
            const download = item._ltDownload;
            if (!download?.target?.path) return;
            // Prefer the row the menu opened from for identity: same filename
            // from different sites shares the name but not the URL text, so the
            // row disambiguates which file's session+history entries to update.
            let rowForName = null;
            try {
                rowForName = item._ltRow?.isConnected ? item._ltRow :
                    document.querySelector("zen-library-downloads-section .zen-library-row[menu-open]");
            } catch (e) { }
            const filename = (() => {
                try {
                    const t = (rowForName?.querySelector?.(".zen-library-row-title")?.textContent || "").trim();
                    if (t) return t;
                } catch (e) { }
                try { return PathUtils.filename(download.target.path); } catch (e) { return ""; }
            })();
            const urlText = (() => {
                try { return (rowForName?.querySelector?.(".zen-library-download-url")?.textContent || "").trim(); } catch (e) { return ""; }
            })();
            if (!filename) return;
            const input = { value: filename };
            const ok = Services.prompt.prompt(window, "Rename File", null, input, null, { value: false });
            const name = ok ? input.value.trim() : "";
            if (!name || name === filename) return;
            try {
                const file = nsFile(download.target.path);
                if (!file.exists()) return;
                file.moveTo(file.parent, name);
                const newPath = file.path;
                // Update every list instance tracking this file (session + history):
                // each refresh() notifies its own views, so the native section
                // re-renders with the new name by itself.
                let updated = 0;
                let stuck = false;
                try {
                    const matches = await resolveAllNativeDownloads(filename, urlText);
                    const targets = matches.length ? matches : [download];
                    for (const match of targets) {
                        try {
                            match.target.path = newPath;
                            if (match.target.path === newPath) {
                                stuck = true;
                                updated++;
                            }
                        } catch (e) {
                            console.warn("[LibraryTweaks] rename: target.path not writable:", e);
                        }
                        try { await match.refresh?.(); } catch (e) {
                            console.warn("[LibraryTweaks] rename: refresh failed:", e);
                        }
                    }
                } catch (e) {
                    console.warn("[LibraryTweaks] rename: multi-list update failed:", e);
                }
                if (!stuck) console.warn("[LibraryTweaks] rename: name applied to row but may revert on next data refresh");
                clearAllCaches();
                // Patch the open row immediately, then re-render the section so
                // the new name survives the next Lit update and is visible.
                refreshDownloadsSections(name);
                if (!updated) {
                    try {
                        const titleEl = rowForName?.querySelector?.(".zen-library-row-title");
                        if (titleEl) titleEl.textContent = name;
                    } catch (e) { }
                }
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
            item._ltRow = null;
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
            item._ltRow = row;
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
        const observer = new MutationObserver(() => {
            scheduleApply(section);
            scheduleMarkMissing(section);
        });
        // Filter chips don't always mutate the results DOM (e.g. when native
        // has nothing to show either way), so watch section events too: the
        // trailing pass reads the chips' settled state. Input also makes the
        // group filter live while typing, ahead of native's debounce.
        const onSectionEvent = () => scheduleApply(section);
        try {
            section.addEventListener("contextmenu", onContextMenu, true);
            section.addEventListener("click", onSectionEvent, true);
            section.addEventListener("input", onSectionEvent, true);
            const results = section.querySelector?.(".zen-library-search-results") || section;
            observer.observe(results, { childList: true, subtree: true });
        } catch (e) { return; }
        state.sections.set(section, { observer, onContextMenu, onSectionEvent });
        scheduleMarkMissing(section);
    }

    function detachSection(section) {
        const record = state.sections.get(section);
        if (record) {
            try { record.observer?.disconnect?.(); } catch (e) { }
            try {
                if (record.onContextMenu) section.removeEventListener("contextmenu", record.onContextMenu, true);
                if (record.onSectionEvent) {
                    section.removeEventListener("click", record.onSectionEvent, true);
                    section.removeEventListener("input", record.onSectionEvent, true);
                }
            } catch (e) { }
            state.sections.delete(section);
        }
        try {
            section.querySelectorAll?.("." + GROUP_CLASS).forEach(n => n.remove());
        } catch (e) { }
    }

    function scanDocument() {
        ensureNativeMenuItem();
        if (dimOn()) ensureDimStyle();
        else {
            removeDimStyle();
            clearMissingMarks();
        }
        for (const section of document.querySelectorAll?.("zen-library-downloads-section") || []) {
            if (systemOn()) attachSection(section);
            else detachSection(section);
        }
        if (!renameOn()) {
            try { document.getElementById(MENU_ITEM_ID)?.remove(); } catch (e) { }
        }
    }

    // Checked flags pin verdicts onto live nodes; reset them only when the dim
    // toggle itself flips, never on the mutation path.
    function refreshDimMarks() {
        if (!dimOn()) return;
        try {
            for (const section of document.querySelectorAll?.("zen-library-downloads-section") || []) {
                try {
                    section.querySelectorAll?.(".zen-library-row")
                        .forEach(row => { delete row._ltMissingChecked; });
                } catch (e) { }
                scheduleMarkMissing(section);
            }
        } catch (e) { }
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
        const dimObserver = {
            observe: () => {
                scanDocument();
                refreshDimMarks();
            },
        };
        try {
            Services.prefs.addObserver(PREF_DIM, dimObserver);
            state.prefObservers.push([PREF_DIM, dimObserver]);
        } catch (e) { }
    }

    init();
})();
