// Zen Bookmarks — natural-language urlbar suggestions for saved bookmarks (and open tabs).
//
// Type a question like "what was that article I bookmarked about sourdough"
// and this provider surfaces the best matching bookmark as a urlbar suggestion.
// Local keyword scoring answers instantly; when a Tidy Downloads AI provider is
// configured (same prefs the Saves smart-save uses), the AI re-ranks candidates.
//
// Process-global for the same reason about:easel is: ProvidersManager is
// per-process, and a window script registering it would race every other window.
// Sine imports .sys.mjs entries in theme.json exactly once per process, so
// importing this module registers the provider a single time.
//
// Pattern follows zen-easel/background/urlbar.sys.mjs: UrlbarProvider imported
// from the same moz-src specifier the manager uses (so registerProvider's
// instanceof check sees one class), UrlbarResult from the content URL, and
// RESULT_TYPE / RESULT_SOURCE from UrlbarShared.

import {
    UrlbarProvider,
    UrlbarUtils
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { ProvidersManager } from "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs";
// System-module scope has no setTimeout/clearTimeout globals (hence the
// ReferenceError); Timer.sys.mjs is what UrlbarUtils itself uses.
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
    UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
    // RESULT_TYPE / RESULT_SOURCE historically lived on UrlbarUtils, but current
    // docs type the provider against UrlbarShared.PROVIDER_TYPE — and this Zen
    // build no longer exposes PROVIDER_TYPE on UrlbarUtils at all (see the
    // registration TypeError). Resolve every enum from UrlbarShared first.
    UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
    BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
    UrlUtils: "resource://gre/modules/UrlUtils.sys.mjs",
    PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

// Enum lookups with numeric fallbacks taken from upstream UrlbarUtils.sys.mjs
// (PROVIDER_TYPE PROFILE=2, RESULT_TYPE URL=3/TAB_SWITCH=1,
// RESULT_SOURCE BOOKMARKS=1/TABS=4/OTHER_LOCAL=5, MAX_TEXT_LENGTH=255).
function providerProfileType() {
    try {
        const t = lazy.UrlbarShared?.PROVIDER_TYPE ?? UrlbarUtils?.PROVIDER_TYPE;
        if (t?.PROFILE !== undefined) return t.PROFILE;
    } catch (e) { }
    return 2;
}

function maxTextLength() {
    try {
        const v = UrlbarUtils?.MAX_TEXT_LENGTH ?? lazy.UrlbarShared?.MAX_TEXT_LENGTH;
        if (typeof v === "number" && v > 0) return v;
    } catch (e) { }
    return 255;
}

const PROVIDER_NAME = "ZenUrlbarProviderBookmarksNL";
const DYNAMIC_TYPE_NAME = "zen-bookmark";
const SAVES_NOTE = "We found this in your saves!";
const MAX_RESULTS = 3;
const MIN_QUERY_LENGTH = 1;
const CACHE_TTL_MS = 15000;
const AI_TIMEOUT_MS = 3500;
const DEBUG_PREF = "zen.bookmarks.urlbar.debug";

function debugLog(...args) {
    try {
        if (Services.prefs.getBoolPref(DEBUG_PREF, false)) {
            console.log("[zen-bookmarks] urlbar", ...args);
        }
    } catch (e) { }
}

// Words that carry the question framing rather than the topic. Stripped when
// extracting the searchable topic from "what was that article I bookmarked about X".
const META_WORDS = new Set(
    "what,whats,what's,was,were,is,are,that,this,those,these,the,a,an,my,i,me,you,we,of,about,on,for,to,from,with,by,at,in,into,and,or,again,please,find,show,give,open,get,bring,back,up,look,search,saved,save,bookmarked,bookmark,bookmarks,article,articles,post,posts,page,pages,site,sites,link,links,video,videos,read,later".split(",")
);
const STOP_WORDS = new Set(
    "about,after,also,and,are,can,from,have,into,more,page,that,the,this,with,your,you,for,not,but,was,were,has,its,use,using,how,what,when,where,why,which,who,whom,does,did,there,their,they".split(",")
);
const BOOKMARK_SIGNALS = [
    "bookmark", "bookmarked", "bookmarks", "saved", "save", "read later",
    "what was", "what is", "what's", "where is", "where's", "find", "show me",
];
const QUESTION_STARTS = ["what", "when", "where", "which", "how", "why", "who", "find", "show", "get", "open"];

let _candidateCache = { at: 0, list: [] };

function isUrlLike(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (/^\s*(about|chrome|resource|place|file|moz-extension):/i.test(t)) return true;
    if (/^[a-z0-9+.-]+:\/\//i.test(t)) return true;
    if (/^[\w-]+(\.[\w-]+)+\//.test(t) && !t.includes(" ")) return true;
    return false;
}

function parseNaturalQuery(raw) {
    const trimmed = String(raw || "").trim();
    const lower = trimmed.toLowerCase();
    let forced = false;
    let query = trimmed;
    const bmPrefix = lower.match(/^(bm|bms|bookmark|bookmarks)\s+/);
    if (bmPrefix) {
        forced = true;
        query = trimmed.slice(bmPrefix[0].length).trim();
    }
    if (!query) return { eligible: false, nlLike: false, topic: "", forced, query: "" };
    const words = query.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
    const hasSignal = BOOKMARK_SIGNALS.some(s => lower.includes(s));
    const startsQuestion = QUESTION_STARTS.some(w => lower.startsWith(w + " ") || lower.startsWith(w + "'"));
    const endsQuestion = /\?\s*$/.test(trimmed);
    const multiWord = words.length >= 3;
    // nlLike gates the AI re-rank (question framing). Local scoring runs for
    // any query — even 1-2 words — with the score threshold gating noise.
    const nlLike = forced || hasSignal || startsQuestion || endsQuestion || multiWord;
    // "a"/"i" framing is covered by META_WORDS, so keeping 1-char words lets
    // single-char tags like "x" match without adding noise.
    const topicWords = words.filter(w => !META_WORDS.has(w) && !STOP_WORDS.has(w));
    const topic = (topicWords.length ? topicWords.join(" ") : query).slice(0, 200);
    return { eligible: true, nlLike, topic, forced, query };
}

function topicTokens(topic) {
    // 1+ chars so short tags ("ai", "x") can match; single chars only score on
    // exact tag matches (see scoreCandidate).
    return (String(topic || "").toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || [])
        .filter(t => !STOP_WORDS.has(t));
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordBoundary(text, token) {
    try {
        return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(text);
    } catch (e) {
        return String(text).includes(token);
    }
}

function scoreCandidate(candidate, tokens) {
    if (!tokens.length) return 0;
    const title = String(candidate.title || "").toLowerCase();
    const url = String(candidate.url || "").toLowerCase();
    const tags = (candidate.tags || []).map(t => String(t).toLowerCase());
    const host = (() => {
        try { return new URL(candidate.url).hostname.replace(/^www\./, "").toLowerCase(); }
        catch (e) { return ""; }
    })();
    let score = 0;
    for (const token of tokens) {
        // Single chars ("x") only score on exact tag matches — anything else
        // is noise ("a" in every other word).
        if (token.length < 2) {
            if (tags.some(tag => tag === token)) score += 8;
            continue;
        }
        // Short tokens ("ai") match substrings everywhere ("said", "rain"),
        // so require word boundaries / exact tags for them.
        const short = token.length < 3;
        const inTitle = short ? hasWordBoundary(title, token) : title.includes(token);
        if (inTitle) score += (title.startsWith(token) ? 6 : 4);
        if (tags.some(tag => tag === token)) score += 8;
        else if (!short && tags.some(tag => tag.includes(token))) score += 4;
        if (host) {
            const inHost = short ? hasWordBoundary(host, token) : host.includes(token);
            if (inHost) score += 5;
            else if (!short && url.includes(token)) score += 2;
        } else if (!short && url.includes(token)) {
            score += 2;
        } else if (short && hasWordBoundary(url, token)) {
            score += 2;
        }
    }
    // Phrase bonus: whole topic appears in the title.
    const phrase = tokens.join(" ");
    if (phrase.length > 4 && title.includes(phrase)) score += 10;
    // Kind boost: bookmarks outrank open tabs for "bookmarked/saved" questions.
    if (candidate.kind === "bookmark") score += 1;
    return score;
}

async function collectBookmarkCandidates() {
    const now = Date.now();
    if (_candidateCache.list.length && now - _candidateCache.at < CACHE_TTL_MS) {
        return _candidateCache.list;
    }
    const out = [];
    try {
        const { PlacesUtils } = lazy;
        const roots = [
            PlacesUtils.bookmarks.toolbarGuid,
            PlacesUtils.bookmarks.menuGuid,
            PlacesUtils.bookmarks.unfiledGuid,
            PlacesUtils.bookmarks.mobileGuid,
        ];
        const walk = (node) => {
            const type = node?.type ?? node?.itemType;
            const url = node?.uri || node?.url?.href || node?.url || "";
            const isBookmark =
                type === PlacesUtils.bookmarks.TYPE_BOOKMARK || type === "bookmark" || !!url;
            if (isBookmark && node?.guid && url && !String(url).startsWith("place:")) {
                let tags = [];
                try { tags = PlacesUtils.tagging.getTagsForURI(Services.io.newURI(String(url))) || []; }
                catch (e) { tags = []; }
                out.push({
                    id: `bookmark:${node.guid}`,
                    kind: "bookmark",
                    guid: node.guid,
                    title: node.title || String(url),
                    url: String(url),
                    tags,
                });
            }
            for (const child of node?.children || []) walk(child);
        };
        for (const guid of roots) {
            try {
                const tree = await PlacesUtils.promiseBookmarksTree(guid);
                if (tree) walk(tree);
            } catch (e) { }
            if (out.length > 1500) break;
        }
    } catch (e) { }
    _candidateCache = { at: now, list: out.slice(0, 1500) };
    return _candidateCache.list;
}

function collectTabCandidates() {
    const out = [];
    try {
        const enumerator = Services.wm.getEnumerator("navigator:browser");
        while (enumerator.hasMoreElements()) {
            const win = enumerator.getNext();
            if (win?.closed) continue;
            let tabs = [];
            try { tabs = win.gBrowser?.tabs || []; }
            catch (e) { continue; }
            for (const tab of tabs) {
                try {
                    const url = tab?.linkedBrowser?.currentURI?.spec || "";
                    if (!url || url === "about:blank") continue;
                    if (/^(about|chrome|resource|moz-extension):/.test(url)) continue;
                    let title = url;
                    try { title = tab.label || url; }
                    catch (e) { }
                    out.push({ id: `tab:${url}`, kind: "tab", title, url, tags: [] });
                } catch (e) { }
                if (out.length >= 60) return out;
            }
        }
    } catch (e) { }
    return out;
}

function getAiConfig() {
    const get = (name, fallback = "") => {
        try { return Services.prefs.getStringPref(name, fallback); }
        catch (e) { return fallback; }
    };
    // Same prefs the Saves smart-save labels use (see Bookmarks.uc.js _aiProviderConfig).
    const provider = get("extensions.downloads.ai_provider", "").trim().toLowerCase();
    const openAiBody = (model) => (systemPrompt, userPrompt) => ({
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 120,
    });
    const readOpenAi = (data) => data?.choices?.[0]?.message?.content || "";
    if (provider === "openai") {
        const apiKey = get("extensions.downloads.openai_api_key", "").trim();
        if (!apiKey) return null;
        return {
            url: "https://api.openai.com/v1/chat/completions",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: openAiBody(get("extensions.downloads.openai_model", "gpt-4o-mini")),
            read: readOpenAi,
        };
    }
    if (provider === "openrouter") {
        const apiKey = get("extensions.downloads.openrouter_api_key", "").trim();
        if (!apiKey) return null;
        return {
            url: "https://openrouter.ai/api/v1/chat/completions",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: openAiBody(get("extensions.downloads.openrouter_model", "openai/gpt-4o-mini")),
            read: readOpenAi,
        };
    }
    if (provider === "openai_compat") {
        const apiKey = get("extensions.downloads.openai_compat_api_key", "").trim();
        const base = get("extensions.downloads.openai_compat_base_url", "https://openrouter.ai/api/v1")
            .trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
        if (!base) return null;
        const headers = { "Content-Type": "application/json" };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        return {
            url: `${base}/chat/completions`,
            headers,
            body: openAiBody(get("extensions.downloads.openai_compat_model", "gpt-4o-mini")),
            read: readOpenAi,
        };
    }
    if (provider === "ollama") {
        const host = get("extensions.downloads.ollama_base_url", "http://localhost:11434").replace(/\/+$/, "");
        return {
            url: `${host}/v1/chat/completions`,
            headers: { "Content-Type": "application/json" },
            body: openAiBody(get("extensions.downloads.ollama_model", "llama3.1")),
            read: readOpenAi,
        };
    }
    return null;
}

async function aiPickCandidate(question, candidates, signal) {
    const provider = getAiConfig();
    if (!provider || !candidates.length) return null;
    const compact = candidates.slice(0, 20).map(c => ({
        id: c.id, title: c.title, url: c.url, tags: c.tags, kind: c.kind,
    }));
    const systemPrompt = "You match a natural-language question to the user's saved bookmarks. Return strict JSON only.";
    const userPrompt = [
        "Choose the saved item that best answers the question.",
        "Prefer matching topic, page type, site, and tags.",
        'Return JSON like {"id":"bookmark:abc"}. Return {"id":null} when nothing matches.',
        "",
        `Question: ${question}`,
        `Saved items: ${JSON.stringify(compact)}`,
    ].join("\n").slice(0, 6000);
    const controller = new AbortController();
    const onAbort = () => { try { controller.abort(); } catch (e) { } };
    try { signal?.addEventListener?.("abort", onAbort, { once: true }); } catch (e) { }
    const timeout = setTimeout(onAbort, AI_TIMEOUT_MS);
    try {
        const response = await fetch(provider.url, {
            method: "POST",
            signal: controller.signal,
            headers: provider.headers,
            body: JSON.stringify(provider.body(systemPrompt, userPrompt)),
        });
        if (!response.ok) return null;
        const data = await response.json();
        const content = provider.read(data);
        const jsonText = String(content || "").match(/\{[\s\S]*\}/)?.[0] || "";
        if (!jsonText) return null;
        const parsed = JSON.parse(jsonText);
        const id = parsed?.id == null ? null : String(parsed.id);
        if (!id) return null;
        return candidates.find(c => c.id === id) || null;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timeout);
        try { signal?.removeEventListener?.("abort", onAbort); } catch (e) { }
    }
}

function resolveTypes() {
    const Shared = lazy.UrlbarShared;
    const fallback = (obj, key, value) => (obj && obj[key] !== undefined ? obj[key] : value);
    const otherLocal = fallback(Shared?.RESULT_SOURCE, "OTHER_LOCAL", 1);
    return {
        URL: fallback(Shared?.RESULT_TYPE, "URL", 3),
        TAB_SWITCH: fallback(Shared?.RESULT_TYPE, "TAB_SWITCH", 1),
        DYNAMIC: fallback(Shared?.RESULT_TYPE, "DYNAMIC", 8),
        // Fall back to OTHER_LOCAL (proven by the Easel provider) when the
        // named source is absent, so rows survive the manager's source filter.
        BOOKMARKS: fallback(Shared?.RESULT_SOURCE, "BOOKMARKS", otherLocal),
        TABS: fallback(Shared?.RESULT_SOURCE, "TABS", otherLocal),
        OTHER_LOCAL: otherLocal,
    };
}

// Saves rows are DYNAMIC with a custom template (icon + title + saves note),
// so the row shows "We found this in your saves!" instead of the raw URL.
// Picking still navigates via payload.url (built-in URL navigation).
// Source must be OTHER_LOCAL, not BOOKMARKS: this build's view checks source
// first, and BOOKMARKS rows take the native bookmark branch (which looks up a
// "favicon" element our template doesn't build) instead of the dynamic path.
function makeBookmarkResult(candidate, { suggestedIndex } = {}) {
    const T = resolveTypes();
    const resultInit = {
        type: T.DYNAMIC,
        source: T.OTHER_LOCAL,
        payload: {
            dynamicType: DYNAMIC_TYPE_NAME,
            url: candidate.url,
            title: candidate.title,
            bookmarkId: candidate.guid || candidate.id,
        },
    };
    if (suggestedIndex !== undefined) resultInit.suggestedIndex = suggestedIndex;
    try {
        return new lazy.UrlbarResult(resultInit);
    } catch (e) {
        return null;
    }
}

// Open tabs keep the native tab-switch row (title + URL + switch behavior).
function makeTabResult(candidate, { suggestedIndex } = {}) {
    const T = resolveTypes();
    const resultInit = {
        type: T.TAB_SWITCH,
        source: T.TABS,
        payload: { url: candidate.url },
    };
    if (suggestedIndex !== undefined) resultInit.suggestedIndex = suggestedIndex;
    try {
        return new lazy.UrlbarResult(resultInit);
    } catch (e) {
        return null;
    }
}

function makeResult(candidate, opts = {}) {
    return candidate.kind === "tab"
        ? makeTabResult(candidate, opts)
        : makeBookmarkResult(candidate, opts);
}

export class ZenUrlbarProviderBookmarksNL extends UrlbarProvider {
    constructor() {
        super();
        this._queries = new Map();
    }

    get name() {
        return PROVIDER_NAME;
    }

    get type() {
        return providerProfileType();
    }

    getPriority() {
        return 0;
    }

    async isActive(queryContext) {
        try {
            const searchString = queryContext?.searchString || "";
            if (!searchString || searchString.length < MIN_QUERY_LENGTH) return false;
            if (searchString.length >= maxTextLength()) return false;
            if (lazy.UrlUtils?.REGEXP_LIKE_PROTOCOL?.test(searchString)) return false;
            if (queryContext.isPrivate) return false;
            // A search mode narrows sources to that mode; our BOOKMARKS/TABS rows
            // would be dropped by the manager's source filter anyway.
            if (queryContext.searchMode) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    async startQuery(queryContext, addCallback) {
        const raw = queryContext?.searchString || "";
        const { eligible, nlLike, topic, forced } = parseNaturalQuery(raw);
        debugLog("query", JSON.stringify(raw), "eligible:", eligible, "topic:", JSON.stringify(topic));
        if (!eligible || !topic) return;
        if (isUrlLike(raw) && !forced) {
            debugLog("skip url-like query");
            return;
        }

        const state = { cancelled: false, abort: null };
        this._queries.set(queryContext, state);
        try {
            const tokens = topicTokens(topic);
            debugLog("tokens:", tokens.join(",") || "(none)");
            if (!tokens.length) return;
            const [bookmarks, tabs] = await Promise.all([
                collectBookmarkCandidates(),
                Promise.resolve(collectTabCandidates()),
            ]);
            debugLog("candidates:", bookmarks.length, "bookmarks,", tabs.length, "tabs");
            if (state.cancelled) return;
            const pool = [...bookmarks, ...tabs];
            if (!pool.length) return;
            const scored = pool
                .map(c => ({ candidate: c, score: scoreCandidate(c, tokens) }))
                .filter(e => e.score > 0)
                .sort((a, b) => b.score - a.score);
            debugLog("scored:", scored.length, "top:", scored[0]?.candidate?.title, scored[0]?.score);
            if (!scored.length) return;

            const seen = new Set();
            let added = 0;
            // Instant local answers: surface up to MAX_RESULTS strong matches so
            // multiple good candidates are all visible. The threshold keeps weak
            // matches from duplicating the built-in bookmark provider.
            const instantThreshold = forced ? 2 : 6;
            for (const { candidate, score } of scored) {
                if (added >= MAX_RESULTS) break;
                if (score < instantThreshold) {
                    debugLog("top score", score, "below threshold", instantThreshold);
                    break;
                }
                if (seen.has(candidate.url)) continue;
                const result = makeResult(candidate, forced && added === 0 ? { suggestedIndex: 1 } : {});
                if (!result) continue;
                seen.add(candidate.url);
                added += 1;
                debugLog("adding local result:", candidate.title, candidate.url);
                addCallback(this, result);
            }
            if (state.cancelled) return;

            // AI re-rank only for question-framed queries ("about X" phrasing
            // rarely matches titles word-for-word). Short keyword queries keep
            // the instant local answer only, so every keystroke doesn't fan out
            // AI calls. Adds the AI pick when it is confident and not shown.
            if (!nlLike) return;
            const aiController = new AbortController();
            state.abort = aiController;
            try {
                const top = scored.slice(0, 20).map(e => e.candidate);
                const pick = await aiPickCandidate(raw.trim(), top, aiController.signal);
                if (state.cancelled) return;
                if (pick && !seen.has(pick.url) && added < MAX_RESULTS) {
                    const result = makeResult(pick, { suggestedIndex: 1 });
                    if (result) {
                        seen.add(pick.url);
                        addCallback(this, result);
                    }
                }
            } finally {
                state.abort = null;
            }
        } finally {
            this._queries.delete(queryContext);
        }
    }

    cancelQuery(queryContext) {
        const state = this._queries.get(queryContext);
        if (!state) return;
        state.cancelled = true;
        try { state.abort?.abort(); }
        catch (e) { }
        this._queries.delete(queryContext);
    }

    // Custom row for saves: bookmark icon + title + "We found this in your
    // saves!" (same element pattern as the Easel provider's template).
    getViewTemplate() {
        return {
            attributes: { selectable: true },
            children: [
                {
                    name: "icon",
                    tag: "img",
                    classList: ["urlbarView-favicon"],
                },
                {
                    name: "title",
                    tag: "span",
                    classList: ["urlbarView-title"],
                    children: [
                        {
                            name: "titleStrong",
                            tag: "strong",
                        },
                    ],
                },
                {
                    name: "savesNote",
                    tag: "span",
                    classList: ["urlbarView-prettyName"],
                    children: [
                        {
                            name: "savesNoteTitle",
                            tag: "span",
                        },
                    ],
                },
            ],
        };
    }

    getViewUpdate(result) {
        return {
            icon: {
                attributes: {
                    src: `page-icon:${result.payload.url}`,
                },
            },
            titleStrong: {
                textContent: result.payload.title || result.payload.url,
                attributes: { dir: "ltr" },
            },
            savesNoteTitle: {
                textContent: SAVES_NOTE,
                attributes: { dir: "ltr" },
            },
        };
    }
}

// Idempotent: getInstanceForSap builds the manager on demand, and the instanceof
// check in registerProvider sees one class because UrlbarProvider is imported
// from the same moz-src specifier the manager uses.
export function installUrlbarProvider() {
    const instance = ProvidersManager.getInstanceForSap("urlbar");
    if (instance.getProvider(PROVIDER_NAME)) {
        debugLog("provider already registered");
        return false;
    }
    instance.registerProvider(new ZenUrlbarProviderBookmarksNL());
    console.log("[zen-bookmarks] urlbar provider installed:", PROVIDER_NAME);
    return true;
}

try {
    installUrlbarProvider();
} catch (e) {
    console.error("[zen-bookmarks] urlbar provider registration failed:", e);
}
