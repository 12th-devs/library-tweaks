"use strict";

// Library Tweaks — Downloads enhancements for the native Zen Library.
//
// 1. Unified downloads (toggle, default off): the native download-history
//    rows are hidden and the section shows the actual top-level files and
//    folders from the OS Downloads folder instead. Files downloaded in the
//    browser keep their source URL (Copy Download Link in the menu). The
//    group never touches Lit-managed nodes, re-applies after native
//    re-renders, mirrors the native search text plus type/when filters, and
//    paints in stages on cold open (names first, then stats and links) like
//    the media tab.
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

    // Hides the native history rows (and native empty state) while the unified
    // group is shown. Our own rows and empty state live inside GROUP_CLASS,
    // which is exempt. Added/removed with the toggle, so native rendering is
    // untouched and returns immediately when turned off.
    const UNIFIED_STYLE_ID = "lt-downloads-unified-style";
    const UNIFIED_CSS =
        `zen-library-downloads-section .zen-library-search-results > .zen-library-group:not(.${GROUP_CLASS}) { display: none; }\n` +
        `zen-library-downloads-section .zen-library-search-results > .zen-library-empty { display: none; }\n` +
        `zen-library-downloads-section .${GROUP_CLASS} .zen-library-empty { display: block; }`;

    function ensureUnifiedStyle() {
        if (document.getElementById(UNIFIED_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = UNIFIED_STYLE_ID;
        style.textContent = UNIFIED_CSS;
        try { document.documentElement.appendChild(style); } catch (e) { }
    }

    function removeUnifiedStyle() {
        try { document.getElementById(UNIFIED_STYLE_ID)?.remove(); } catch (e) { }
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

    // Same shaping as the native row subtitle: scheme, "www." and trailing
    // slash go away so the source host reads like the classic library.
    function formatUrl(url) {
        return String(url || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
    }

    function copyString(text) {
        try {
            Cc["@mozilla.org/widget/clipboardhelper;1"]
                .getService(Ci.nsIClipboardHelper)
                .copyString(text);
        } catch (e) { }
    }

    /* ------------------------------------------------------- disk scan */

    let scanCache = null;
    let scanPromise = null;
    let histCache = null;

    // Normalized on-disk path -> source URL for files the browser downloaded.
    // Session lists come first so a just-finished download wins over an older
    // history row for the same path.
    async function historySources() {
        const now = Date.now();
        if (histCache && now - histCache.at < HIST_CACHE_TTL_MS) return histCache.sources;
        const sources = new Map();
        try {
            for (const list of await unifiedLists()) {
                let all = [];
                try { all = await list.getAll(); } catch (e) { continue; }
                for (const d of all) {
                    try {
                        if (!d?.target?.path) continue;
                        const key = normPath(d.target.path);
                        if (!sources.has(key) && d.source?.url) {
                            sources.set(key, String(d.source.url));
                        }
                    } catch (e) { }
                }
            }
        } catch (e) { }
        histCache = { at: now, sources };
        return sources;
    }

    async function downloadsFolder() {
        try {
            const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
            try {
                const preferred = await Downloads.getPreferredDownloadsDirectory();
                if (preferred) return preferred;
            } catch (e) { }
            try { return await Downloads.getSystemDownloadsDirectory(); } catch (e) { }
        } catch (e) { }
        return "";
    }

    function acceptLeafName(leaf) {
        return !!leaf && !leaf.startsWith(".") && !leaf.endsWith(".part");
    }

    async function isHiddenSystem(path) {
        try {
            const attrs = await IOUtils.getWindowsAttributes(path);
            return !!(attrs.hidden || attrs.system);
        } catch (e) { return false; }
    }

    // Name-only snapshot: one directory read, no per-file stat. Painted
    // immediately on cold open; the stat pass refines right after, like the
    // media tab paints seeds before the folder walk finishes.
    async function scanDiskNames() {
        const folder = await downloadsFolder();
        if (!folder) return [];
        let children = [];
        try { children = await IOUtils.getChildren(folder); } catch (e) { return []; }
        let isWin = false;
        try { isWin = Services.appinfo.OS === "WINNT"; } catch (e) { }
        const out = [];
        for (let i = 0; i < children.length; i += SCAN_CHUNK_SIZE) {
            const batch = await Promise.all(children.slice(i, i + SCAN_CHUNK_SIZE).map(async (path) => {
                try {
                    const leaf = PathUtils.filename(path);
                    if (!acceptLeafName(leaf)) return null;
                    if (isWin && await isHiddenSystem(path)) return null;
                    return { targetPath: path, filename: leaf };
                } catch (e) { return null; }
            }));
            for (const entry of batch) if (entry) out.push(entry);
        }
        return out;
    }

    async function scanDisk() {
        const now = Date.now();
        if (scanCache && now - scanCache.at < SCAN_CACHE_TTL_MS && scanCache.items) {
            return scanCache.items;
        }
        if (scanPromise) return scanPromise;
        scanPromise = (async () => {
            const folder = await downloadsFolder();
            if (!folder) return [];
            const sources = await historySources();
            let children = [];
            try { children = await IOUtils.getChildren(folder); } catch (e) { return []; }
            let isWin = false;
            try { isWin = Services.appinfo.OS === "WINNT"; } catch (e) { }
            const items = [];
            for (let i = 0; i < children.length; i += SCAN_CHUNK_SIZE) {
                const batch = await Promise.all(children.slice(i, i + SCAN_CHUNK_SIZE).map(async (path) => {
                    try {
                        const leaf = PathUtils.filename(path);
                        if (!acceptLeafName(leaf)) return null;
                        if (isWin && await isHiddenSystem(path)) return null;
                        const info = await IOUtils.stat(path);
                        if (info.type !== "regular" && info.type !== "directory") return null;
                        const key = normPath(path);
                        return {
                            id: "disk|" + key,
                            filename: leaf,
                            targetPath: path,
                            size: info.type === "directory" ? 0 : (info.size || 0),
                            timestamp: info.lastModified || 0,
                            isFolder: info.type === "directory",
                            sourceUrl: sources.get(key) || "",
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

    // Same payload native download rows carry, so files drag out to Explorer,
    // tabs, and other apps exactly like native ones.
    function onDiskDragStart(event, item) {
        let file = null;
        try { file = nsFile(item.targetPath); } catch (e) { }
        if (!file) {
            event.preventDefault();
            return;
        }
        try {
            if (!file.exists()) {
                event.preventDefault();
                return;
            }
        } catch (e) {
            event.preventDefault();
            return;
        }
        const { dataTransfer } = event;
        try {
            dataTransfer.mozSetDataAt("application/x-moz-file", file, 0);
        } catch (e) {
            event.preventDefault();
            return;
        }
        dataTransfer.effectAllowed = "copyMove";
        try { dataTransfer.setData("text/uri-list", Services.io.newFileURI(file).spec); } catch (e) { }
        try { dataTransfer.addElement(event.currentTarget); } catch (e) { }
        try { Services.zen.playHapticFeedback(); } catch (e) { }
    }

    function ensureDiskMenu() {
        let popup = document.getElementById(DISK_MENU_ID);
        if (popup) return popup;
        popup = document.createXULElement("menupopup");
        popup.id = DISK_MENU_ID;
        for (const [id, label] of [
            ["lt-disk-ctx-open", "Open"],
            ["lt-disk-ctx-show", "Show in Folder"],
            ["lt-disk-ctx-copy-link", "Copy Download Link"],
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

    // Labels follow the native downloads menu: Open carries the file name
    // (same Fluent string native passes {name} to), Show and Copy Link stay
    // generic like native, and our Rename/Delete name the file too.
    function setMenuLabel(id, l10nId, args, fallback) {
        const el = document.getElementById(id);
        if (!el) return;
        try {
            document.l10n.setAttributes(el, l10nId, args);
        } catch (e) {
            try {
                el.removeAttribute("data-l10n-id");
                el.setAttribute("label", fallback);
            } catch (_e) { }
        }
    }

    function showDiskMenu(event, item, section) {
        const popup = ensureDiskMenu();
        for (const id of ["lt-disk-ctx-open", "lt-disk-ctx-show", "lt-disk-ctx-copy-link", "lt-disk-ctx-rename", "lt-disk-ctx-delete"]) {
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
        setMenuLabel("lt-disk-ctx-open", "library-downloads-menu-open", { name: item.filename }, `Open ${item.filename}`);
        setMenuLabel("lt-disk-ctx-show", "downloads-cmd-show-menuitem-2", null, "Show in Folder");
        setMenuLabel("lt-disk-ctx-copy-link", "downloads-cmd-copy-download-link", null, "Copy Download Link");
        const copyLinkEl = document.getElementById("lt-disk-ctx-copy-link");
        if (copyLinkEl) copyLinkEl.hidden = !item.sourceUrl;
        on("lt-disk-ctx-copy-link", () => copyString(item.sourceUrl));
        const fileOnly = !item.isFolder;
        const renameEl = document.getElementById("lt-disk-ctx-rename");
        const deleteEl = document.getElementById("lt-disk-ctx-delete");
        if (renameEl) {
            try { renameEl.setAttribute("label", `Rename ${item.filename}`); } catch (e) { }
            renameEl.hidden = !fileOnly || !renameOn();
        }
        if (deleteEl) {
            try { deleteEl.setAttribute("label", `Delete ${item.filename}`); } catch (e) { }
            deleteEl.hidden = !fileOnly;
        }
        on("lt-disk-ctx-rename", async () => {
            const input = { value: item.filename };
            const ok = Services.prompt.prompt(window, "Rename File", null, input, null, { value: false });
            const name = ok ? input.value.trim() : "";
            if (!name || name === item.filename) return;
            try {
                const oldKey = normPath(item.targetPath);
                const file = nsFile(item.targetPath);
                if (!file.exists()) return;
                file.moveTo(file.parent, name);
                const newPath = file.path;
                // Point any browser download entries at the new path so the
                // source-link association (and delayed history writes) follow
                // the rename instead of going stale.
                try {
                    for (const match of await resolveDownloadsByPath(oldKey)) {
                        try { match.target.path = newPath; } catch (e) { }
                        try { await match.refresh?.(); } catch (e) { }
                    }
                } catch (e) { console.warn("[LibraryTweaks] disk rename: history sync failed:", e); }
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
        row.draggable = true;
        row.addEventListener("dragstart", (event) => onDiskDragStart(event, item));
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
        if (item.provisional) {
            sub.textContent = "…";
        } else if (item.isFolder) {
            sub.textContent = "Folder";
        } else if (item.sourceUrl) {
            const host = formatUrl(item.sourceUrl);
            sub.textContent = host ? `${formatSize(item.size)} — ${host}` : formatSize(item.size);
        } else {
            sub.textContent = formatSize(item.size);
        }
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

    // Builds (or skips, when the signature matches) the unified group. Only
    // our own group is ever touched — native nodes are left alone. The scroll
    // container itself is native and persists, so rebuilding rows never jumps
    // scroll position.
    function renderGroup(section, results, visible, sig) {
        const existing = results.querySelector(":scope > ." + GROUP_CLASS);
        if (existing?.dataset.sig === sig) return;
        existing?.remove();
        const group = document.createElement("div");
        group.className = "zen-library-group " + GROUP_CLASS;
        group.dataset.sig = sig;
        if (!visible.length) {
            const empty = document.createElement("div");
            empty.className = "zen-library-empty";
            empty.setAttribute("data-l10n-id", "library-downloads-empty");
            group.appendChild(empty);
        } else {
            for (const item of visible) group.appendChild(diskRow(item, section));
        }
        results.appendChild(group);
    }

    // Unified group replacing the native history rows (hidden via UNIFIED_CSS).
    // Signature-guarded so our own insertions never retrigger the observer
    // loop. Applies the same search text, type pills and when-filters native
    // does, so the list reads as the section itself. Always rendered while
    // the toggle is on — with our own empty state when nothing matches.
    //
    // Cold opens paint in stages, like the media tab: filenames first (one
    // directory read, no per-file stat or history lookup), then the full
    // pass refines sizes, folders, dates and source links. Name/type filters
    // already work on filenames; the date filter needs stats, so it waits
    // for the full pass instead of flashing wrong rows.
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
                const matchesNameType = (entry) => {
                    if (filter && !entry.filename.toLowerCase().includes(filter)) return false;
                    if (types.length && !types.includes(diskFileType(entry))) return false;
                    return true;
                };
                const warm = !!(scanCache && Date.now() - scanCache.at < SCAN_CACHE_TTL_MS && scanCache.items);
                if (!warm && !cutoff) {
                    const names = await scanDiskNames();
                    if (!section.isConnected) return;
                    results = section.querySelector?.(".zen-library-search-results");
                    if (!results || !results.isConnected) return;
                    const provisional = names.filter(matchesNameType).map(entry => ({
                        id: "disk|" + normPath(entry.targetPath),
                        filename: entry.filename,
                        targetPath: entry.targetPath,
                        size: 0,
                        timestamp: 0,
                        isFolder: false,
                        sourceUrl: "",
                        provisional: true,
                    }));
                    renderGroup(section, results, provisional,
                        "provisional\n" + filter + "\n" + types.join(",") + "\n" +
                        provisional.map(i => i.id).join("\n"));
                    if (!section.isConnected) return;
                    results = section.querySelector?.(".zen-library-search-results");
                    if (!results || !results.isConnected) return;
                }
                const items = await scanDisk();
                if (!section.isConnected) return;
                results = section.querySelector?.(".zen-library-search-results");
                if (!results || !results.isConnected) return;
                const visible = items.filter(i => {
                    if (!matchesNameType(i)) return false;
                    if (cutoff && !(i.timestamp >= cutoff)) return false;
                    return true;
                });
                renderGroup(section, results, visible,
                    filter + "\n" + types.join(",") + "\n" + (whenDays || "") + "\n" +
                    visible.map(i => i.id + "|" + (i.sourceUrl || "")).join("\n"));
            } while (section._ltQueued);
        } finally {
            section._ltApplying = false;
            section._ltQueued = false;
        }
    }

    // Every session/history download entry still pointing at an on-disk path
    // (for rename follow-up). Matched by exact path, so same-named files from
    // different sites never collide.
    async function resolveDownloadsByPath(pathKey) {
        const out = [];
        try {
            for (const list of await unifiedLists()) {
                let all = [];
                try { all = await list.getAll(); } catch (e) { continue; }
                for (const download of all) {
                    try {
                        if (download?.target?.path && normPath(download.target.path) === pathKey &&
                            !out.includes(download)) {
                            out.push(download);
                        }
                    } catch (e) { }
                }
            }
        } catch (e) { }
        return out;
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
        dlView: null,
    };

    // Finished downloads land on disk behind the scan TTL; invalidate on
    // completion so they show up immediately. Progress ticks (stopped=false)
    // are ignored so active downloads don't cause rescan storms.
    async function watchDownloadList() {
        if (state.dlView) return;
        try {
            const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
            const list = await Downloads.getList(Downloads.ALL);
            state.dlView = {
                onDownloadChanged: (download) => {
                    try { if (!download?.stopped) return; } catch (e) { return; }
                    clearAllCaches();
                    for (const section of state.sections.keys()) {
                        try { scheduleApply(section); } catch (e) { }
                    }
                },
            };
            await list.addView(state.dlView);
        } catch (e) {
            state.dlView = null;
        }
    }

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
        if (systemOn()) ensureUnifiedStyle();
        else removeUnifiedStyle();
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
        try { watchDownloadList(); } catch (e) { }
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
