"use strict";

// Library Tweaks — Space Routing section for the native Zen Library.
//
// Ported from JustAdumbPrsn/ZenLibraryTweaks (main branch,
// Modules/LibraryTweaksSpaceRoutingSection.mjs). It lists Zen's space-routing
// rules (link pattern → space, contains/equal/regex) with search, create,
// edit and remove, plus the default route for links from other apps. Placed
// after the Spaces tab; skipped in private windows. Everything else about the
// Library stays as Zen made it.
//
// Differences from upstream:
// - Self-contained: shared strings are inlined, and the enable pref follows
//   this mod's `zen.library.tweaks.*` convention (default on). Unregistering
//   deletes the tab (Zen ships no native one) and folds its tab back.
// - Registered through this mod's integration (`_routingSectionRegister`),
//   like the history-section half, instead of upstream's loader.

(function () {
    const SEARCH_SECTION_URL =
        "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
    const LIT_URL = "chrome://global/content/vendor/lit.all.mjs";
    const PREF = "zen.library.tweaks.routing.enabled";
    const STYLE_ID = "zen-routing-native-style";

    // English text for the ids this section renders. They have no Fluent
    // resource upstream either, so the text is applied directly instead.
    const STRINGS = {
        "library-space-routing": "Routing",
        "library-space-routing-search-placeholder": "Search routes",
        "library-space-routing-filter-title": "Filter routes",
        "library-space-routing-new": "New",
        "library-space-routing-routes": "Routes",
        "library-space-routing-external": "Links from other apps (Mail, Slack…)",
        "library-space-routing-empty": "No routes yet. Add one to open a site in a space every time, like work sites in Work.",
        "library-space-routing-no-results": "No routes match your search.",
        "library-space-routing-new-title": "New route",
        "library-space-routing-edit-title": "Edit route",
        "library-space-routing-when": "When the link",
        "library-space-routing-open-in": "Open it in",
        "library-space-routing-add": "Add route",
        "library-space-routing-most-recent": "Most recent space",
        "library-space-routing-missing": "Space was deleted",
        "library-space-routing-remove": "Remove route",
        "library-space-routing-save": "Save",
        "library-space-routing-cancel": "Cancel",
        "library-space-routing-contains": "Contains",
        "library-space-routing-equal-to": "Is Exactly",
        "library-space-routing-regex": "RegEx",
        "library-space-routing-invalid": "Invalid RegEx",
    };

    const isEnabled = () => {
        try { return Services.prefs.getBoolPref(PREF, true); }
        catch (e) { return true; }
    };

    // Skipped in private windows, like upstream (routes reference spaces the
    // private window must not resolve).
    const isPrivate = () => {
        try { return !!window.gZenWorkspaces?.privateWindowOrDisabled; }
        catch (e) { return false; }
    };

    let NativeSearch = null;
    try {
        ({ ZenLibrarySearchSection: NativeSearch } =
            ChromeUtils.importESModule(SEARCH_SECTION_URL, { global: "current" }));
    } catch (e) {
        console.error("[LibraryTweaks] native search section unavailable:", e);
    }
    let html = null;
    let nothing = null;
    let repeat = null;
    try {
        ({ html, nothing, repeat } = ChromeUtils.importESModule(LIT_URL, { global: "current" }));
    } catch (e) {
        console.error("[LibraryTweaks] lit unavailable for routing section:", e);
    }
    if (!NativeSearch || !html) return;

    const lazy = {};
    try {
        ChromeUtils.defineESModuleGetters(lazy, {
            gZenSpaceRoutingManager: "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs",
            PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
        });
    } catch (e) { }

    const WORKSPACE_EVENTS = ["ZenWorkspaceDataChanged", "ZenWorkspacesUIUpdate"];
    const MOST_RECENT_SPACE = "most-recent-space";
    const MATCH_TYPES = ["contains", "equal-to", "regex"];
    const LINK_ICON = "chrome://browser/skin/zen-icons/link.svg";

    const ICONS = {
        remove: "chrome://browser/skin/zen-icons/trash.svg",
        arrow: "chrome://browser/skin/zen-icons/arrow-corner-down-right.svg",
        chevron: "chrome://global/skin/icons/arrow-down-12.svg",
    };

    class ZenLibrarySpaceRoutingSection extends NativeSearch {
        static id = "space-routing";
        static label = "library-space-routing";

        static render(library) {
            return html`<zen-library-space-routing-section class="zen-library-section" data-section="space-routing" .library=${library}></zen-library-space-routing-section>`;
        }

        static properties = {
            routes: { state: true },
            external: { state: true },
            editing: { state: true },
        };

        #spaces = [];
        #favicons = new Map();
        #spaceMenu = null;
        #onSpacePicked = null;

        constructor() {
            super();
            this.routes = [];
            this.external = MOST_RECENT_SPACE;
            this.editing = null;
        }

        connectedCallback() {
            super.connectedCallback();
            this.#refresh();
            for (const type of WORKSPACE_EVENTS) window.addEventListener(type, this.#refresh);
        }

        disconnectedCallback() {
            super.disconnectedCallback();
            this.#spaceMenu?.remove();
            this.#spaceMenu = null;
            for (const type of WORKSPACE_EVENTS) window.removeEventListener(type, this.#refresh);
        }

        get searchPlaceholderL10nId() { return "library-space-routing-search-placeholder"; }
        get filterTitleL10nId() { return "library-space-routing-filter-title"; }

        onShown() {
            try { super.onShown?.(); } catch (e) { }
            this.#refresh();
        }

        onHidden() {
            try { super.onHidden?.(); } catch (e) { }
            this.#closeEditor();
        }

        onLibraryClosing() {
            try { super.onLibraryClosing?.(); } catch (e) { }
            this.#closeEditor();
        }

        #closeEditor() {
            try { this.#spaceMenu?.hidePopup(); } catch (e) { }
            this.editing = null;
        }

        onSearchChanged() { this.requestUpdate(); }

        updated(changedProperties) {
            this.#applyStrings();
            try { super.updated(changedProperties); } catch (e) { }
        }

        #ensureNewRouteButton() {
            const header = this.querySelector(".zen-library-search-header");
            if (!header || header.querySelector(".zen-library-route-new")) return;
            const button = document.createElement("button");
            button.className = "zen-library-filter-button zen-library-route-new";
            button.setAttribute("data-l10n-id", "library-space-routing-new");
            button.addEventListener("click", () => this.#startEditing());
            header.append(button);
        }

        #applyStrings() {
            try { this.#ensureNewRouteButton(); } catch (e) { }
            for (const element of this.querySelectorAll("[data-l10n-id]")) {
                const text = STRINGS[element.getAttribute("data-l10n-id")];
                if (text === undefined) continue;
                if (element.localName === "input") element.placeholder = text;
                else if (element.textContent !== text) element.textContent = text;
            }
        }

        #refresh = () => {
            try {
                const manager = lazy.gZenSpaceRoutingManager;
                this.#spaces = window.gZenWorkspaces?.getWorkspaces() ?? [];
                this.external = manager.getDefaultExternalRoute();
                this.routes = manager.getAllRoutes();
            } catch (ex) {
                console.error("Failed to read space routes", ex);
            }
        };

        #spaceName(id) {
            if (id === MOST_RECENT_SPACE) return STRINGS["library-space-routing-most-recent"];
            return this.#spaces.find(space => space.uuid === id)?.name ?? STRINGS["library-space-routing-missing"];
        }

        #spaceExists(id) {
            return id === MOST_RECENT_SPACE || this.#spaces.some(space => space.uuid === id);
        }

        #iconFor({ reference, matchType }) {
            if (matchType !== "regex") {
                try {
                    const { hostname } = new URL(reference.includes("://") ? reference : `https://${reference}`);
                    if (hostname.includes(".") && this.#hasFavicon(hostname)) {
                        return `page-icon:https://${hostname}`;
                    }
                } catch (e) { }
            }
            return LINK_ICON;
        }

        /**
         * Whether Places knows a favicon for the host. The first call starts the
         * lookup and answers false; the row re-renders once an icon turns up.
         */
        #hasFavicon(hostname) {
            if (!this.#favicons.has(hostname)) {
                this.#favicons.set(hostname, false);
                try {
                    lazy.PlacesUtils.favicons
                        .getFaviconForPage(Services.io.newURI(`https://${hostname}`))
                        .then(
                            icon => {
                                if (icon) {
                                    this.#favicons.set(hostname, true);
                                    this.requestUpdate();
                                }
                            },
                            () => {}
                        );
                } catch (e) { }
            }
            return this.#favicons.get(hostname);
        }

        #placeholderFor(matchType) {
            return matchType === "regex" ? "zen-browser\\.app" : "zen-browser.app";
        }

        #visibleRoutes() {
            const query = this.searchQuery?.trim().toLowerCase();
            return this.routes.filter(route =>
                route.reference.trim() &&
                (!query || route.reference.toLowerCase().includes(query) || this.#spaceName(route.openIn).toLowerCase().includes(query))
            );
        }

        #startEditing(route) {
            if (route) {
                this.editing = { ...route, isNew: false };
            } else {
                let host = "";
                try {
                    const { currentURI } = window.gBrowser.selectedBrowser;
                    host = currentURI.schemeIs("http") || currentURI.schemeIs("https") ? currentURI.host : "";
                } catch (e) { }
                this.editing = {
                    id: crypto.randomUUID(),
                    reference: host, matchType: "contains",
                    openIn: window.gZenWorkspaces?.activeWorkspace ?? MOST_RECENT_SPACE,
                    isNew: true,
                };
            }
            try {
                this.updateComplete.then(() => {
                    const input = this.querySelector(".zen-library-route-input");
                    input?.focus();
                    input?.select();
                    this.querySelector(".zen-library-route-editor")?.scrollIntoView({ block: "nearest" });
                });
            } catch (e) { }
        }

        #update(changes) { this.editing = { ...this.editing, ...changes }; }

        #regexError({ reference, matchType }) {
            if (matchType !== "regex" || !reference.trim()) return "";
            try { new RegExp(reference); } catch (ex) { return ex.message; }
            return "";
        }

        #isValid(route) { return !!route.reference.trim() && !this.#regexError(route); }

        #save() {
            if (!this.editing || !this.#isValid(this.editing)) return;
            try {
                const manager = lazy.gZenSpaceRoutingManager;
                const { isNew, id, reference, matchType, openIn } = this.editing;
                const base = isNew ? manager.createNewRoute() : { id };
                manager.updateRoute({ ...base, reference: reference.trim(), matchType, openIn });
                manager.saveRoutes();
            } catch (ex) {
                console.error("Failed to save space route", ex);
                return;
            }
            this.editing = null;
            this.#refresh();
        }

        #remove(id) {
            try {
                const manager = lazy.gZenSpaceRoutingManager;
                manager.removeRoute(id);
                manager.saveRoutes();
            } catch (ex) {
                console.error("Failed to remove space route", ex);
                return;
            }
            this.editing = null;
            this.#refresh();
        }

        #setExternal(value) {
            try {
                const manager = lazy.gZenSpaceRoutingManager;
                manager.setDefaultExternalRoute(value);
                manager.saveRoutes();
                this.external = value;
            } catch (ex) {
                console.error("Failed to set external route", ex);
            }
        }

        #onEditorKeyDown(event) {
            if (event.key === "Escape") {
                event.stopPropagation();
                this.editing = null;
            } else if (event.key === "Enter" && event.target.localName === "input") {
                this.#save();
            }
        }

        #renderSpaceIcon(id) {
            const icon = this.#spaces.find(space => space.uuid === id)?.icon;
            if (!icon) return nothing;
            return icon.startsWith("chrome://")
                ? html`<img class="zen-library-route-space-icon" src=${icon} alt="" />`
                : html`<span class="zen-library-route-space-icon">${icon}</span>`;
        }

        #renderChips(options, selected, onPick) {
            return html`
      <div class="zen-library-filter-options">
        ${options.map(({ id, label }) => html`
          <div class="zen-library-filter-chip" role="button" tabindex="0" ?active=${selected === id}
            @click=${() => onPick(id)}
            @keydown=${event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(id); } }}>
            <span>${label}</span>
          </div>
        `)}
      </div>
    `;
        }

        #renderSpaceMenu(selected, onPick) {
            const id = this.#spaceExists(selected) ? selected : MOST_RECENT_SPACE;
            return html`
      <button class="zen-library-filter-button zen-library-route-select" aria-haspopup="menu"
        @click=${event => this.#openSpaceMenu(event.currentTarget, onPick)}>
        ${this.#renderSpaceIcon(id)}
        <span class="zen-library-route-select-label">${this.#spaceName(id)}</span>
        <img class="zen-library-route-select-chevron" src=${ICONS.chevron} alt="" />
      </button>
    `;
        }

        #openSpaceMenu(anchor, onPick) {
            if (!this.#spaceMenu) {
                this.#spaceMenu = window.MozXULElement.parseXULToFragment(`<menupopup class="zen-library-route-menu"/>`).firstElementChild;
                this.#spaceMenu.addEventListener("command", event => this.#onSpacePicked?.(event.target.value));
                document.getElementById("mainPopupSet").appendChild(this.#spaceMenu);
            }
            this.#onSpacePicked = onPick;
            this.#spaceMenu.replaceChildren(
                this.#createSpaceItem(MOST_RECENT_SPACE, STRINGS["library-space-routing-most-recent"]),
                document.createXULElement("menuseparator"),
                ...this.#spaces.map(({ uuid, name, icon }) => this.#createSpaceItem(uuid, name, icon))
            );
            try { this.#spaceMenu.style.minWidth = `${anchor.getBoundingClientRect().width}px`; } catch (e) { }
            this.#spaceMenu.openPopup(anchor, "after_start", 0, 4);
        }

        #createSpaceItem(id, name, icon) {
            const item = document.createXULElement("menuitem");
            item.setAttribute("value", id);
            if (icon?.startsWith("chrome://")) {
                item.className = "menuitem-iconic";
                item.setAttribute("image", icon);
                item.setAttribute("label", name);
            } else {
                item.setAttribute("label", icon ? `${icon} ${name}` : name);
            }
            return item;
        }

        #renderRoute(route) {
            const spaceName = this.#spaceName(route.openIn);
            const icon = this.#iconFor(route);
            return html`
      <div class="zen-library-row" role="button" tabindex="0" ?missing=${!this.#spaceExists(route.openIn)}
        @click=${() => this.#startEditing(route)}
        @keydown=${event => { if (event.target === event.currentTarget && event.key === "Enter") this.#startEditing(route); }}>
        <img class="zen-library-row-icon" ?symbolic=${icon === LINK_ICON} src=${icon} alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${route.reference}</span>
          <span class="zen-library-row-subtitle"><img class="zen-library-route-arrow" src=${ICONS.arrow} alt="" />${this.#renderSpaceIcon(route.openIn)}${spaceName}</span>
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton class="toolbarbutton-1 zen-library-route-kind">
            <span class="zen-library-route-kind-label">${STRINGS[`library-space-routing-${route.matchType}`]}</span>
          </toolbarbutton>
          <toolbarbutton class="toolbarbutton-1" tooltiptext=${STRINGS["library-space-routing-remove"]}
            @click=${event => { event.stopPropagation(); this.#remove(route.id); }}
            @auxclick=${event => event.stopPropagation()}>
            <img class="toolbarbutton-icon" src=${ICONS.remove} alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
        }

        #renderEditor() {
            const edit = this.editing;
            const error = this.#regexError(edit);
            return html`
      <div class="zen-library-route-editor" @keydown=${event => this.#onEditorKeyDown(event)}>
        <h4 data-l10n-id=${edit.isNew ? "library-space-routing-new-title" : "library-space-routing-edit-title"}></h4>
        <div class="zen-library-route-field">
          <label data-l10n-id="library-space-routing-when"></label>
          ${this.#renderChips(MATCH_TYPES.map(id => ({ id, label: STRINGS[`library-space-routing-${id}`] })), edit.matchType, matchType => this.#update({ matchType }))}
          <input class="zen-library-route-input" ?invalid=${!!error} aria-invalid=${error ? "true" : nothing} type="text" spellcheck="false" placeholder=${this.#placeholderFor(edit.matchType)} .value=${edit.reference} @input=${event => this.#update({ reference: event.target.value })} />
          ${error ? html`<div class="zen-library-route-error" role="alert">${STRINGS["library-space-routing-invalid"]}: ${error}</div>` : nothing}
        </div>
        <div class="zen-library-route-field">
          <label data-l10n-id="library-space-routing-open-in"></label>
          ${this.#renderSpaceMenu(edit.openIn, openIn => this.#update({ openIn }))}
        </div>
        <div class="zen-library-route-buttons">
          <button data-l10n-id="library-space-routing-cancel" @click=${() => { this.editing = null; }}></button>
          <button primary data-l10n-id=${edit.isNew ? "library-space-routing-add" : "library-space-routing-save"} ?disabled=${!this.#isValid(edit)} @click=${() => this.#save()}></button>
        </div>
      </div>
    `;
        }

        #renderExternal() {
            return html`
      <div class="zen-library-group zen-library-route-external">
        <h3 data-l10n-id="library-space-routing-external"></h3>
        ${this.#renderSpaceMenu(this.external, id => this.#setExternal(id))}
      </div>
    `;
        }

        renderItems() {
            const searching = !!this.searchQuery?.trim();
            const routes = this.#visibleRoutes();
            return html`
      <div class="zen-library-group">
        <h3 data-l10n-id="library-space-routing-routes"></h3>
        ${this.editing?.isNew ? this.#renderEditor() : nothing}
        ${repeat(routes, route => route.id, route => route.id === this.editing?.id ? this.#renderEditor() : this.#renderRoute(route))}
        ${!routes.length && !this.editing && searching ? html`<div class="zen-library-empty" data-l10n-id="library-space-routing-no-results"></div>` : nothing}
        ${!routes.length && !this.editing && !searching ? html`<div class="zen-library-empty" data-l10n-id="library-space-routing-empty"></div>` : nothing}
      </div>
      ${searching ? nothing : this.#renderExternal()}
    `;
        }
    }

    if (!customElements.get("zen-library-space-routing-section")) {
        try {
            customElements.define("zen-library-space-routing-section", ZenLibrarySpaceRoutingSection);
        } catch (e) {
            console.error("[LibraryTweaks] failed to define routing section element:", e);
        }
    }
    window.ZenLibrarySpaceRoutingSection = ZenLibrarySpaceRoutingSection;

    /* --------------------------------------- integration feature mixin */

    const RoutingIntegration = {
        _isRoutingEnabled() {
            try {
                return Services.prefs.getBoolPref(PREF, true);
            } catch (e) {
                return true;
            }
        },

        _isRoutingAllowed() {
            try { return !window.gZenWorkspaces?.privateWindowOrDisabled; }
            catch (e) { return true; }
        },

        _watchRoutingPref() {
            if (this._routingPrefObserver) return;
            this._routingPrefObserver = {
                observe: () => this._onRoutingPrefChanged(),
            };
            try {
                Services.prefs.addObserver(PREF, this._routingPrefObserver);
            } catch (e) {
                this._routingPrefObserver = null;
            }
        },

        _unwatchRoutingPref() {
            if (!this._routingPrefObserver) return;
            try { Services.prefs.removeObserver(PREF, this._routingPrefObserver); } catch (e) { }
            this._routingPrefObserver = null;
        },

        // Called from the shared init() and once at file load (this file loads
        // after saves.uc.js, so a normal boot reaches here with init() done).
        _routingInit() {
            try { this._watchRoutingPref(); } catch (e) { }
            if (!this._isRoutingEnabled()) return;
            if (!this._initialized) {
                try { this.init(); } catch (e) { }
                return;
            }
            try { this._registerNativeWhenReady(); } catch (e) { }
            try { this._connectExistingNativeLibraries(); } catch (e) { }
        },

        _onRoutingPrefChanged() {
            if (this._isRoutingEnabled()) {
                if (!this._initialized) {
                    try { this.init(); } catch (e) { }
                    return;
                }
                try { this._registerNativeWhenReady(); } catch (e) { }
                try { this._connectExistingNativeLibraries(); } catch (e) { }
                return;
            }
            try { this._routingUnregister(); } catch (e) { }
            if (!this._anyFeatureEnabled?.()) {
                try { this._unregisterAllSections(); } catch (e) { }
                try { this._shutdown(); } catch (e) { }
            }
        },

        // Inserts after Spaces (mirrors upstream placement). The sidebar-order
        // feature may move it per saved arrangement afterwards.
        _routingSectionRegister(host) {
            if (!host) return false;
            if (!this._isRoutingEnabled?.() || !this._isRoutingAllowed?.()) return false;
            if (!customElements.get("zen-library-space-routing-section")) return false;
            const sections = host.zenLibrarySections;
            if (!sections || typeof sections !== "object") return false;
            let changed = false;
            if (sections["space-routing"] !== window.ZenLibrarySpaceRoutingSection) {
                const entries = Object.entries(sections).filter(([id]) => id !== "space-routing");
                const anchor = entries.findIndex(([id]) => id === "spaces");
                const pair = ["space-routing", window.ZenLibrarySpaceRoutingSection];
                if (anchor === -1) entries.push(pair);
                else entries.splice(anchor + 1, 0, pair);
                for (const id of Object.keys(sections)) delete sections[id];
                for (const [id, cls] of entries) sections[id] = cls;
                changed = true;
            }
            try { if (this._sanitizeNativeTab?.(host)) changed = true; } catch (e) { }
            try { this._routingTabPatch?.(host); } catch (e) { }
            try {
                const root = this._nativeRoot?.(host);
                if (root) this._ensureRoutingStyles(root);
            } catch (e) { }
            if (changed) {
                try { host.requestUpdate?.(); } catch (e) { }
            }
            return true;
        },

        _routingUnregister() {
            for (const host of Array.from(this._nativeHostObservers?.keys?.() || [])) {
                try {
                    const sections = host?.zenLibrarySections;
                    if (sections?.["space-routing"] && sections["space-routing"] === window.ZenLibrarySpaceRoutingSection) {
                        delete sections["space-routing"];
                    }
                    // Zen ships no routing tab: fold it away when leaving.
                    if (host?.activeTab === "space-routing") host.activeTab = "history";
                } catch (e) { }
                try { host?.requestUpdate?.(); } catch (e) { }
            }
        },

        // No upstream Fluent string exists for Routing; the sidebar label is
        // patched to text post-render (Lit skips unchanged bindings, so the
        // patch sticks until the tab node is recreated).
        _routingTabPatch(host) {
            let root = null;
            try { root = this._nativeRoot?.(host); } catch (e) { }
            const tab = root?.querySelector?.('.zen-library-tab[data-section="space-routing"]');
            if (!tab) return false;
            const label = tab.querySelector?.("label");
            if (!label) return false;
            let touched = false;
            if (label.textContent !== "Routing") {
                label.textContent = "Routing";
                touched = true;
            }
            if (label.hasAttribute("data-l10n-id")) {
                label.removeAttribute("data-l10n-id");
                touched = true;
            }
            return touched;
        },

        _ensureRoutingStyles(root) {
            if (!root?.querySelector) return;
            const css = `/* Space Routing section (ported improvement). */
zen-library-space-routing-section {
  --zen-library-route-danger: light-dark(#9d2222, #d03535);
}
zen-library-space-routing-section .zen-library-row {
  contain: none;
  content-visibility: visible;
  cursor: default;
}
zen-library-space-routing-section .zen-library-route-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-block: 4px 8px;
  padding: 14px;
  border-radius: 16px;
  background: var(--zen-library-pill-bg);
  -moz-window-dragging: no-drag;
}
zen-library-space-routing-section .zen-library-route-editor h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
zen-library-space-routing-section .zen-library-route-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
zen-library-space-routing-section .zen-library-route-field label {
  font-size: 12px;
  font-weight: 700;
  opacity: 0.6;
}
zen-library-space-routing-section .zen-library-route-space-icon {
  flex: none;
  width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  -moz-context-properties: fill;
  fill: currentColor;
}
zen-library-space-routing-section .zen-library-row-icon[symbolic] {
  -moz-context-properties: fill;
  fill: currentColor;
  opacity: 0.7;
}
zen-library-space-routing-section .zen-library-row-subtitle {
  margin-inline-start: 6px;
}
zen-library-space-routing-section .zen-library-route-arrow {
  width: 12px;
  height: 12px;
  margin-inline-end: 4px;
  vertical-align: -2px;
  opacity: 0.7;
  -moz-context-properties: fill;
  fill: currentColor;
}
zen-library-space-routing-section .zen-library-route-kind-label {
  display: block;
  padding: 8px 6px;
  border-radius: var(--zen-library-radius);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  opacity: 0.7;
}
zen-library-space-routing-section .zen-library-route-kind:hover .zen-library-route-kind-label {
  background-color: var(--toolbarbutton-background-color-hover);
}
zen-library-space-routing-section .zen-library-row-subtitle .zen-library-route-space-icon {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-inline-end: 4px;
  line-height: 12px;
  font-size: 11px;
  vertical-align: -1px;
}
zen-library-space-routing-section .zen-library-route-input {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  margin: 0;
  padding: 0 12px;
  border: none;
  border-radius: var(--zen-library-radius);
  background: color-mix(in srgb, currentColor 8%, transparent);
  color: inherit;
  font: inherit;
}
zen-library-space-routing-section .zen-library-route-input:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--zen-primary-color) 60%, transparent);
}
zen-library-space-routing-section .zen-library-route-select {
  width: 100%;
  margin: 0;
  background: color-mix(in srgb, currentColor 8%, transparent);
  text-align: start;
}
zen-library-space-routing-section .zen-library-route-select:hover {
  background: color-mix(in srgb, currentColor 14%, transparent);
}
zen-library-space-routing-section .zen-library-route-editor .zen-library-filter-chip {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
zen-library-space-routing-section .zen-library-route-editor .zen-library-filter-chip[active] {
  background: color-mix(in srgb, currentColor 20%, transparent);
}
zen-library-space-routing-section .zen-library-route-input[invalid] {
  color: var(--zen-library-route-danger) !important;
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-thickness: 1px;
  text-decoration-color: var(--zen-library-route-danger);
}
zen-library-space-routing-section .zen-library-route-error {
  padding-inline: 4px;
  color: var(--zen-library-route-danger);
  font-size: 12px;
}
zen-library-space-routing-section .zen-library-route-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
zen-library-space-routing-section .zen-library-route-buttons button {
  appearance: none;
  margin: 0;
  padding: 8px 14px;
  border: none;
  border-radius: var(--zen-library-radius);
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: inherit;
  font: inherit;
  font-weight: 600;
}
zen-library-space-routing-section .zen-library-route-buttons button[primary] {
  background: var(--zen-primary-color);
  color: var(--zen-primary-color-contrast, white);
}
zen-library-space-routing-section .zen-library-route-buttons button[disabled] {
  opacity: 0.5;
}
.zen-library-route-menu :is(.menu-icon, .menu-iconic-icon) {
  width: 16px;
  height: 16px;
  -moz-context-properties: fill;
  fill: currentColor;
}
.zen-library-route-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.zen-library-route-new::before {
  content: "";
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  background-color: currentColor;
  -moz-context-properties: fill, stroke;
  mask: url("chrome://sine/content/library-tweaks/icons/airplane.svg") center / contain no-repeat;
}`;
            const existing = root.querySelector(":scope > #zen-routing-native-style") ||
                root.querySelector("#zen-routing-native-style");
            if (existing) {
                if (existing.textContent !== css) existing.textContent = css;
                return;
            }
            const style = document.createElement("style");
            style.id = "zen-routing-native-style";
            style.textContent = css;
            try { root.appendChild(style); } catch (e) { }
        },
    };

    // Global attach so a saves-only Sine reload (which rebuilds the integration
    // without re-running this file) still picks the routing half back up.
    window._libraryTweaksAttachRouting = (integration) => {
        if (!integration) return;
        Object.assign(integration, RoutingIntegration);
        try { integration._routingInit?.(); } catch (e) { console.error("[LibraryTweaks] _routingInit failed:", e); }
    };

    try {
        window._libraryTweaksAttachRouting(window.gZenLibraryBookmarksIntegration);
    } catch (e) { }
})();
