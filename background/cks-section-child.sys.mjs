// Library Tweaks — Keyboard Shortcuts section child actor.
//
// Runs inside about:preferences (see cks-bootstrap.sys.mjs) and groups the
// Library shortcuts under one "Library" header in Zen's keyboard-shortcuts
// settings, instead of leaving them scattered across the native groups.
//
// Only already-rendered DOM nodes are relocated — the same row elements, so
// bindings, labels, listeners and conflict markers keep working untouched.
// Nothing in the shortcut records themselves is modified.

const ROW_KEY_IDS = [
  "addBookmarkAsKb",
  "showAllHistoryKb",
  "key_openDownloads",
  "manBookmarkKb",
];
const HEADER_TEXT = "Library";
const HEADER_GROUP = "zenCKSOption-group-zen-library";
const WRAPPER_ID = "zenCKSOption-wrapper";
const ROW_CLASS = "zenCKSOption";
const PREF = "zen.library.tweaks.shortcut.section";

function sectionEnabled() {
  try {
    return Services.prefs.getBoolPref(PREF, true);
  } catch (e) {
    return true;
  }
}

function findRows(doc) {
  const rows = [];
  for (const id of ROW_KEY_IDS) {
    let row = null;
    try {
      const input = doc.querySelector(`#${WRAPPER_ID} input[key="${id}"]`);
      row = input?.closest(`hbox.${ROW_CLASS}`) || null;
    } catch (e) {
      row = null;
    }
    if (row) rows.push(row);
  }
  return rows;
}

function findHeader(doc) {
  try {
    return doc.querySelector(`#${WRAPPER_ID} > h2[data-group="${HEADER_GROUP}"]`);
  } catch (e) {
    return null;
  }
}

// True when the header sits right after the History & Bookmarks group (or at
// the end as fallback) with our rows directly behind it in order. Checked
// before every placement so our own moves never re-trigger the observer.
function isSettled(doc, wrapper, header, rows) {
  try {
    if (!header?.isConnected) return false;
    for (const row of rows) {
      if (!row.isConnected) return false;
    }
    const anchor = findAnchor(wrapper, rows);
    if (anchor) {
      if (anchor.nextElementSibling !== header) return false;
      let prev = header;
      for (const row of rows) {
        if (prev.nextElementSibling !== row) return false;
        prev = row;
      }
      return true;
    }
    // No anchor: the block must be the trailing run.
    const kids = [...wrapper.children];
    const start = kids.length - (rows.length + 1);
    if (start < 0 || kids[start] !== header) return false;
    for (let i = 0; i < rows.length; i++) {
      if (kids[start + 1 + i] !== rows[i]) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Anchor: last *native* History & Bookmarks row. Our relocated rows keep
// their native data-group, so they are skipped here.
function findAnchor(wrapper, rows) {
  try {
    const kids = [...wrapper.children];
    for (let i = kids.length - 1; i >= 0; i--) {
      let input = null;
      try {
        input = kids[i].querySelector?.('input[data-group="historyAndBookmarks"]') || null;
      } catch (e) {
        input = null;
      }
      if (input && !rows.includes(kids[i])) return kids[i];
    }
  } catch (e) {}
  return null;
}

function placeRows(doc, wrapper, rows) {
  let header = findHeader(doc);
  if (!header) {
    header = doc.createElement("h2");
    header.textContent = HEADER_TEXT;
    header.setAttribute("data-group", HEADER_GROUP);
  }
  const anchor = findAnchor(wrapper, rows);
  if (isSettled(wrapper, anchor, header, rows)) return;
  // Anchor after the native History & Bookmarks group; end of list fallback
  // (mirrors the settled check above, so placement always converges).
  try {
    if (anchor && anchor.isConnected) anchor.after(header);
    else wrapper.appendChild(header);
    let prev = header;
    for (const row of rows) {
      prev.after(row);
      prev = row;
    }
  } catch (e) {}
}

// Best-effort restore toward native positions (exact intra-group order heals
// on the next CKS rebuild, which re-renders from scratch on every pane visit).
function restoreNative(doc, wrapper, rows) {
  try {
    findHeader(doc)?.remove();
  } catch (e) {}
  try {
    const byGroup = new Map();
    for (const row of rows) {
      if (!row.isConnected) continue;
      const g =
        row.querySelector("input")?.getAttribute("data-group") || "";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(row);
    }
    for (const [g, list] of byGroup) {
      if (!g) continue;
      const h2 = wrapper.querySelector(`h2[data-group="zenCKSOption-group-${g}"]`);
      if (!h2) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        try {
          h2.after(list[i]);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

function ensureGrouping(doc) {
  const wrapper = doc.getElementById(WRAPPER_ID);
  if (!wrapper) return false;
  const rows = findRows(doc);
  if (!sectionEnabled()) {
    // Only touch the DOM if our header is present (proof we placed these
    // rows); otherwise leave the native layout exactly as built.
    if (findHeader(doc)) restoreNative(doc, wrapper, rows);
    return true;
  }
  if (!rows.length) return true;
  placeRows(doc, wrapper, rows);
  return true;
}

export class LibraryTweaksCKSSectionChild extends JSWindowActorChild {
  handleEvent() {
    // DOMContentLoaded (see bootstrap): the CKS pane builds lazily, so watch
    // for the wrapper first, then for its rebuilds.
    try {
      this._mo?.disconnect();
    } catch (e) {}
    try {
      this._mo = new this.contentWindow.MutationObserver(() => {
        try {
          ensureGrouping(this.document);
        } catch (e) {}
      });
      this._mo.observe(this.document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {
      this._mo = null;
    }
    try {
      ensureGrouping(this.document);
    } catch (e) {}
    if (!this._prefObserver) {
      this._prefObserver = {
        observe: () => {
          try {
            ensureGrouping(this.document);
          } catch (e) {}
        },
      };
      try {
        Services.prefs.addObserver(PREF, this._prefObserver);
      } catch (e) {
        this._prefObserver = null;
      }
    }
  }

  didDestroy() {
    try {
      this._mo?.disconnect();
    } catch (e) {}
    this._mo = null;
    try {
      if (this._prefObserver) {
        Services.prefs.removeObserver(PREF, this._prefObserver);
      }
    } catch (e) {}
    this._prefObserver = null;
  }
}
