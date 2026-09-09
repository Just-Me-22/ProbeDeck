/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** The lenses that answer a typed question. Everything here reads Discord's own
 *  modules and Vencord's patch bookkeeping, so none of it needs the console. */

import { Settings } from "@api/Settings";
import { fluxStores, wreq } from "@webpack";
import { getFactoryPatchedSource, patches } from "@webpack/patcher";

const SPAN = 900;
const HITS = 4;
const MODULES = 2;

function source(id: PropertyKey): string {
    try { return String(wreq.m[id as any]); } catch { return ""; }
}

/** String(factory) hands back the ORIGINAL source: Vencord keeps toString pointing at
 *  the unpatched code so other plugins' find strings still match. The rewritten code
 *  only exists under the patched-source symbol. */
function patched(id: PropertyKey): string {
    try { return String(getFactoryPatchedSource(id) ?? ""); } catch { return ""; }
}

function matching(needles: string[]): string[] {
    const hits: string[] = [];
    for (const id of Object.keys(wreq.m)) {
        const src = source(id);
        if (src && needles.every(n => src.includes(n))) hits.push(id);
    }
    return hits;
}

/** a module whose whole body is `e.exports={key:"name_hash",...}` is a css class map,
 *  and printing the mapping is far more use than printing the source */
const CSS_MAP = /exports\s*=\s*\{((?:\s*\w+\s*:\s*"[\w-]+_[0-9a-z]+",?)+)\s*\}/;

function cssMapLines(src: string): string[] | null {
    const m = src.match(CSS_MAP);
    if (!m) return null;
    return [...m[1].matchAll(/(\w+)\s*:\s*"([\w-]+_[0-9a-z]+)"/g)]
        .map(([, key, cls]) => `  ${key.padEnd(6)} .${cls}`);
}

export function findLines(query: string): string[] {
    if (!query.trim()) {
        return [
            "type words that must ALL appear in a module's source, separated by spaces.",
            "",
            "the first word is also used as the keyword to print context around.",
            "a module that turns out to be a css class map is printed as a mapping instead.",
            "",
            "examples",
            "  favoriteStickers            find the sticker favourites",
            "  stickerNode visibleRowIndex two needles, narrows to one module"
        ];
    }

    const needles = query.trim().split(/\s+/);
    const ids = matching(needles);
    const out: string[] = [
        `find     ${needles.join(" + ")}`,
        `matched  ${ids.length} module(s)${ids.length ? `: ${ids.join(", ")}` : ""}`,
        ""
    ];
    if (!ids.length) return [...out, "nothing. drop a needle or try a different spelling."];
    if (ids.length > 40) return [...out, "too many to be an anchor. add another needle."];

    for (const id of ids.slice(0, MODULES)) {
        const src = source(id);
        const map = cssMapLines(src);
        const total = src.split(needles[0]).length - 1;

        out.push("=".repeat(74), `  module ${id}   ${src.length} chars   "${needles[0]}" x${total}`, "=".repeat(74), "");

        if (map) {
            out.push("css class map:", ...map, "");
            continue;
        }

        let i = -1;
        for (let n = 0; n < HITS && (i = src.indexOf(needles[0], i + 1)) !== -1; n++) {
            out.push(`--- @${i} ---`, src.slice(Math.max(0, i - SPAN), i + SPAN), "");
        }
    }
    return out;
}

export function regexLines(query: string): string[] {
    if (!query.trim()) {
        return [
            "test a patch regex before shipping it. format:",
            "",
            "  <find string> | <regex>",
            "  <find string> | <regex> | <replacement>",
            "",
            "the find string picks the modules, the regex is run against each one.",
            "a match count of 0 or 2+ is the reason most patches fail.",
            "add a third part and it shows what the rewritten source would say,",
            "which is the half you otherwise only find out by rebuilding.",
            "",
            "example",
            "  rowCountBySection | \\i\\.favoriteStickers\\?\\.stickerIds\\?\\?\\i",
            "",
            "\\i is expanded to Vencord's own identifier pattern before the test."
        ];
    }

    const [rawFind, rawPattern0, ...tail] = query.split("|");
    const find = rawFind.trim();
    const rawPattern = (rawPattern0 ?? "").trim();
    // the replacement can itself contain a pipe, so whatever is left is all of it
    const replacement = tail.length ? tail.join("|").trim() : null;
    if (!find || !rawPattern) return ["need at least: <find string> | <regex>"];

    // the same expansion Vencord does, so a pattern can be pasted straight into a patch
    const expanded = rawPattern.replace(/\\i/g, "[A-Za-z_$][\\w$]*");
    let re: RegExp;
    try {
        re = new RegExp(expanded, "g");
    } catch (err) {
        return [`that regex does not compile: ${err}`];
    }

    const ids = matching([find]);
    const out: string[] = [
        `find     ${find}`,
        `regex    ${rawPattern}`,
        `expanded ${expanded}`,
        ...(replacement ? [`replace  ${replacement}`] : []),
        `modules  ${ids.length}${ids.length ? `: ${ids.join(", ")}` : ""}`,
        ""
    ];
    if (!ids.length) return [...out, "the find string matches no module, so the patch would never run."];

    for (const id of ids.slice(0, 4)) {
        const src = source(id);
        const found = [...src.matchAll(re)];
        const verdict = found.length === 0
            ? "NO MATCH - the patch would log 'had no effect'"
            : found.length === 1
                ? "one match, which is what a patch wants"
                : `${found.length} matches - a patch rewrites the FIRST one only`;

        out.push("=".repeat(74), `  module ${id}   ${verdict}`, "=".repeat(74), "");
        for (const m of found.slice(0, 3)) {
            const at = m.index ?? 0;
            out.push(`--- @${at} ---`, `matched: ${m[0]}`, "");
            m.slice(1).forEach((g, i) => out.push(`  $${i + 1} = ${g}`));

            if (replacement != null) {
                // Vencord swaps $self for the plugin object before it rewrites anything,
                // so stand something readable in its place rather than leaving it literal
                const applied = m[0].replace(new RegExp(expanded), replacement)
                    .replace(/\$self/g, "Vencord.Plugins.plugins.YourPlugin");
                out.push("", "becomes:", applied, "");
            }

            out.push("context:", src.slice(Math.max(0, at - 200), at + 200), "");
        }
    }
    return out;
}

export function patchLines(): string[] {
    // Vencord splices a patch out of the array the moment its find matches a module,
    // so what is left is only what has NOT been applied yet. That is not the same as
    // broken: Discord loads modules lazily, so a patch for a screen you have not
    // opened this session is simply still waiting.
    const landed = new Map<string, Set<string>>();
    for (const id of Object.keys(wreq.m)) {
        for (const [, plugin] of patched(id).matchAll(/Vencord\.Plugins\.plugins\.(\w+)/g)) {
            if (!landed.has(plugin)) landed.set(plugin, new Set());
            landed.get(plugin)!.add(id);
        }
    }

    const gone: string[] = [];
    const waiting: string[] = [];

    for (const patch of patches) {
        const { find } = patch;
        const findStr = typeof find === "string" ? find : String(find);
        const matches = typeof find === "string"
            ? matching([find]).length > 0
            : Object.keys(wreq.m).some(id => (find as RegExp).test(source(id)));

        const row = `  ${patch.plugin.padEnd(22)} ${findStr.slice(0, 90)}`;
        (matches ? gone : waiting).push(row);
    }

    const landedRows = [...landed.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([plugin, ids]) => `  ${plugin.padEnd(22)} ${[...ids].slice(0, 6).join(", ")}`);

    return [
        `still unapplied   ${patches.length} patch(es)`,
        `rewrote a module  ${landed.size} plugin(s)`,
        "",
        "=".repeat(74),
        "  THE FIND MATCHES A LOADED MODULE BUT THE PATCH NEVER RAN",
        "=".repeat(74),
        "",
        ...(gone.length ? gone : ["  none"]),
        "",
        "these are the real suspects. the module is here and the patch is still queued,",
        "which usually means an `all` patch, or a find that matches after another patch",
        "already rewrote the same module.",
        "",
        "=".repeat(74),
        "  WAITING ON A MODULE DISCORD HAS NOT LOADED YET",
        "=".repeat(74),
        "",
        ...(waiting.length ? waiting : ["  none"]),
        "",
        "not failures. open the screen each one belongs to and check again.",
        "",
        "=".repeat(74),
        "  PLUGINS WHOSE CODE IS IN A PATCHED MODULE",
        "=".repeat(74),
        "",
        ...(landedRows.length ? landedRows : ["  none"]),
        "",
        "read from the patched source, not from String(factory), which returns the",
        "ORIGINAL code. a patch that only rewrites discord's own code without calling",
        "back into the plugin will not appear here even though it worked."
    ];
}

export function storeLines(query: string): string[] {
    const names = [...fluxStores.keys()].sort();

    if (!query.trim()) {
        return [
            "type part of a store name to open it, or a property name to find the",
            "store that has it. this is also how you check a lazy find resolved.",
            "",
            `${names.length} flux stores loaded:`,
            "",
            ...chunk(names, 4)
        ];
    }

    const q = query.trim().toLowerCase();
    const hits = names.filter(n => n.toLowerCase().includes(q));
    if (!hits.length) return [`no store name contains "${query.trim()}"`, "", "loaded stores:", "", ...chunk(names, 4)];

    const out: string[] = [];
    for (const name of hits.slice(0, 3)) {
        const store: any = fluxStores.get(name);
        const methods: string[] = [];
        for (let o = store; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
            for (const key of Object.getOwnPropertyNames(o)) {
                if (key.startsWith("_") || key === "constructor") continue;
                if (typeof store[key] === "function" && !methods.includes(key)) methods.push(key);
            }
        }
        out.push("=".repeat(74), `  ${name}`, "=".repeat(74), "", `${methods.length} methods:`, "", ...chunk(methods.sort(), 3), "");
    }
    return out;
}

function chunk(items: string[], perRow: number): string[] {
    const width = Math.max(0, ...items.map(i => i.length)) + 2;
    const rows: string[] = [];
    for (let i = 0; i < items.length; i += perRow) {
        rows.push("  " + items.slice(i, i + perRow).map(s => s.padEnd(width)).join("").trimEnd());
    }
    return rows;
}

/** cheap triage, so the sweep only pays to time the selectors that could be slow */
function smell(sel: string): number {
    let score = 0;
    if (sel.includes(":has(")) score += 40;
    if (/\[class\*=/.test(sel)) score += 8;
    if (/\[[^\]]*\*=/.test(sel)) score += 6;
    if (sel.includes("*")) score += 10;

    const depth = sel.trim().split(/\s+/).filter(p => p !== ">" && p !== "+" && p !== "~").length;
    if (depth >= 4) score += depth * 2;
    if (/:(hover|focus|active|not|is|where)\b/.test(sel)) score += 3;

    return score;
}

/** selectorText keeps the commas inside :is(), :not() and :has(), so a plain split
 *  hands back fragments that do not parse and get timed as n/a */
function topLevelParts(selector: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < selector.length; i++) {
        const c = selector[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth === 0) {
            parts.push(selector.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(selector.slice(start));
    return parts;
}

/** equicord imports local themes over vencord://, which is a different origin, so the
 *  browser refuses to hand back their rules. the file is readable over ipc though, and
 *  a constructed sheet built from that text is same origin and rankable. */
let themeSheets: { name: string; sheet: CSSStyleSheet; }[] | null = null;
let themesPending = false;
let onThemesRead: (() => void) | null = null;

/** the sweep costs seconds to run, so it has to stay cached. this is how the cache
 *  learns the first result was taken before the themes had arrived. */
export function whenThemesRead(fn: () => void) {
    onThemesRead = fn;
}

function loadThemeSheets() {
    if (themeSheets || themesPending) return;
    themesPending = true;

    const names: string[] = Settings.enabledThemes ?? [];
    Promise.all(names.map(async name => {
        try {
            const text = await VencordNative.themes.getThemeData(name);
            if (!text) return null;
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(text);
            return { name, sheet };
        } catch {
            return null;
        }
    })).then(loaded => {
        themeSheets = loaded.filter(entry => entry != null) as { name: string; sheet: CSSStyleSheet; }[];
        themesPending = false;
        onThemesRead?.();
    });
}

function sheetName(sheet: CSSStyleSheet): string {
    if (sheet.href) return sheet.href.split("/").pop()!.split("?")[0].slice(0, 28);
    const node = sheet.ownerNode as HTMLElement | null;
    return node?.id || node?.className || "inline style";
}

/** hands every style rule the page has loaded to `visit`, with the sheet it came from,
 *  and returns the sheets that threw. a theme that goes missing from a ranking without a
 *  word is always in that list. */
function walkStyleRules(visit: (rule: CSSStyleRule, from: string) => void): string[] {
    const unreadable: string[] = [];

    const walk = (list: CSSRuleList, from: string) => {
        for (const rule of Array.from(list)) {
            // equicord loads every theme as an @import inside one <style>, so without this
            // the whole theme is invisible here
            if (rule instanceof CSSImportRule) {
                const inner = rule.styleSheet;
                const name = inner ? sheetName(inner) : rule.href.split("/").pop()!.slice(0, 28);
                try {
                    if (inner) walk(inner.cssRules, name);
                    else unreadable.push(name);
                } catch {
                    unreadable.push(name);
                }
                continue;
            }

            // a style rule carries selectorText AND, since css nesting shipped, an empty
            // cssRules. reading cssRules first threw every rule on the page away.
            if ((rule as CSSStyleRule).selectorText) visit(rule as CSSStyleRule, from);

            const nested = (rule as CSSGroupingRule).cssRules;
            if (nested) walk(nested, from);
        }
    };

    for (const sheet of Array.from(document.styleSheets)) {
        try {
            walk(sheet.cssRules, sheetName(sheet));
        } catch {
            unreadable.push(sheetName(sheet));
        }
    }

    const readOverIpc = new Set<string>();
    for (const { name, sheet } of themeSheets ?? []) {
        const short = name.split("/").pop()!.slice(0, 28);
        readOverIpc.add(short);
        walk(sheet.cssRules, short);
    }

    return unreadable.filter(name => !readOverIpc.has(name));
}

function allSelectors(): { found: { sel: string; from: string; }[]; unreadable: string[]; } {
    const found: { sel: string; from: string; }[] = [];
    const seen = new Set<string>();

    const unreadable = walkStyleRules((rule, from) => {
        for (const part of topLevelParts(rule.selectorText)) {
            const sel = part.trim();
            if (!sel || seen.has(sel)) continue;
            seen.add(sel);
            found.push({ sel, from });
        }
    });

    return { found, unreadable };
}

function sweepLines(): string[] {
    loadThemeSheets();
    const { found: all, unreadable } = allSelectors();
    if (!all.length) {
        return [
            "no stylesheet could be read, so there is nothing to rank",
            "",
            ...(unreadable.length
                ? ["these threw when read, which means a different origin:", "", ...unreadable.map(n => `  ${n}`)]
                : ["nothing threw either, so the page reported no rules at all"])
        ];
    }

    // time only the worst smelling ones: timing thousands of selectors would itself
    // be the slowest thing on the page
    const suspects = all
        .map(entry => ({ ...entry, score: smell(entry.sel) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);

    const runs = 60;
    const timed = suspects.map(entry => {
        let each = 0;
        let count = 0;
        try {
            count = document.querySelectorAll(entry.sel).length;
            const t0 = performance.now();
            for (let i = 0; i < runs; i++) document.querySelectorAll(entry.sel);
            each = (performance.now() - t0) / runs;
        } catch {
            each = -1;
        }
        return { ...entry, each, count };
    }).sort((a, b) => b.each - a.each);

    const total = timed.reduce((sum, e) => sum + Math.max(0, e.each), 0);

    return [
        `${all.length} selectors loaded, ${suspects.length} timed`,
        `together they cost ${total.toFixed(2)}ms per full recalc`,
        "a frame has 16.7ms for everything, so anything near that is a problem",
        "",
        "type a selector to dig into one. worst first:",
        "",
        ...timed.map(e =>
            `${e.each < 0 ? "  n/a" : e.each.toFixed(3).padStart(7)}ms  ${String(e.count).padStart(5)} hits  ${e.from.padEnd(20)} ${e.sel.slice(0, 60)}`),
        "",
        "the sheet name is where to go and fix it. :has() and [class*=] are the two",
        "that usually account for most of the total.",
        ...(themeSheets
            ? []
            : ["", "your local themes are still loading over ipc. open this lens again and they will be in the ranking."]),
        ...(unreadable.length
            ? ["", `not counted, a different origin so the rules cannot be read: ${unreadable.join(", ")}`]
            : [])
    ];
}

/** a discord class carries a build hash, so .bar_c38106 becomes .bar_9f21ab on the next
 *  canary. a theme written against the old hash still parses and still ranks in the cost
 *  lens, it just matches nothing. this names those, and offers the class discord has
 *  under the same prefix now, which is almost always the rename. */
export function staleLines(query: string): string[] {
    loadThemeSheets();
    const { found } = allSelectors();
    if (!found.length) return ["no stylesheet could be read, so there is nothing to check"];

    const mine = new Set((Settings.enabledThemes ?? []).map(n => n.split("/").pop()!.slice(0, 28)));
    if (!mine.size) return ["no themes are enabled, so there is nothing to check"];
    if (!found.some(entry => mine.has(entry.from)))
        return ["the theme is not readable yet. open this lens again in a second."];

    const classesIn = (sel: string) => sel.match(/\.-?[_a-zA-Z][\w-]*/g)?.map(c => c.slice(1)) ?? [];
    const prefixOf = (name: string) => name.replace(/_{1,2}[a-f0-9]{5,7}$/i, "");
    const hashed = (name: string) => /_{1,2}[a-f0-9]{5,7}$/i.test(name);

    // everything discord itself still ships, and what it calls each prefix now
    const live = new Set<string>();
    const byPrefix = new Map<string, Set<string>>();
    for (const entry of found) {
        if (mine.has(entry.from)) continue;
        for (const name of classesIn(entry.sel)) {
            live.add(name);
            if (!hashed(name)) continue;
            const prefix = prefixOf(name);
            (byPrefix.get(prefix) ?? byPrefix.set(prefix, new Set()).get(prefix)!).add(name);
        }
    }

    const uses = new Map<string, number>();
    for (const entry of found) {
        if (!mine.has(entry.from)) continue;
        for (const name of classesIn(entry.sel)) uses.set(name, (uses.get(name) ?? 0) + 1);
    }

    // discord builds one module into one hash, so every class from a module shares a
    // suffix. the theme's classes that still work tell us which suffixes are current,
    // and a candidate carrying one of those is almost always the rename you want.
    const suffixOf = (name: string) => name.slice(prefixOf(name).length);
    const known = new Set<string>();
    for (const [name] of uses)
        if (hashed(name) && live.has(name)) known.add(suffixOf(name));

    const filter = query.trim().toLowerCase();
    const gone = [...uses]
        .filter(([name]) => hashed(name) && !live.has(name))
        .filter(([name]) => !filter || name.toLowerCase().includes(filter))
        .sort((a, b) => b[1] - a[1]);

    const rows = gone.flatMap(([name, count]) => {
        const now = [...(byPrefix.get(prefixOf(name)) ?? [])]
            .sort((a, b) => Number(known.has(suffixOf(b))) - Number(known.has(suffixOf(a))));
        const best = now[0];
        const confident = best != null && known.has(suffixOf(best));

        const head = `  ${String(count).padStart(3)}x  .${name.padEnd(30)} `;
        if (!now.length) return [head + "gone outright, nothing under that prefix"];
        if (confident) return [head + `-> ${best}   (that module is already working here)`];
        return [head + `?  ${now.slice(0, 4).join(", ")}${now.length > 4 ? ` +${now.length - 4} more` : ""}`];
    });

    const sure = gone.filter(([name]) => {
        const now = [...(byPrefix.get(prefixOf(name)) ?? [])];
        return now.some(c => known.has(suffixOf(c)));
    }).length;

    return [
        `theme classes    ${uses.size} used, ${[...uses].filter(([n]) => hashed(n)).length} of them hashed`,
        `still in discord ${[...uses].filter(([n]) => hashed(n) && live.has(n)).length}`,
        `gone             ${gone.length}   these rules parse and match nothing`,
        "",
        ...(rows.length ? rows : ["nothing stale, every hashed class the theme uses still exists."]),
        "",
        `-> is a confident rename, ${sure} of them. the class comes from a module the theme`,
        "already talks to, so the suffix is one that is known good here.",
        "?  means the prefix is shared and the module is not one the theme uses. click the",
        "element with the inspect lens rather than picking one off this list."
    ];
}

export function costLines(query: string): string[] {
    if (!query.trim()) return sweepLines();

    const sel = query.trim();
    let count: number;
    try {
        count = document.querySelectorAll(sel).length;
    } catch (err) {
        return [`that selector does not parse: ${err}`];
    }

    const runs = 200;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) document.querySelectorAll(sel);
    const each = (performance.now() - t0) / runs;

    const notes: string[] = [];
    if (sel.includes(":has(")) notes.push("  :has() re-runs on every style recalc and walks upwards. worst offender on hover paths.");
    if (/\[class\*=/.test(sel)) notes.push("  [class*=] is a substring scan on every candidate. a plain class hook is far cheaper.");
    const depth = sel.trim().split(/\s+/).filter(p => p !== ">" && p !== "+" && p !== "~").length;
    if (depth >= 4) notes.push(`  ${depth} levels deep. the browser matches right to left, so every level is another walk up.`);
    if (/\*/.test(sel)) notes.push("  the universal selector puts every element in the candidate set.");

    return [
        `selector   ${sel}`,
        `matches    ${count} element(s)`,
        `cost       ${each.toFixed(3)}ms per run   (${runs} runs)`,
        "for 60fps  a frame has 16.7ms for everything, style recalc included",
        "",
        ...(notes.length ? ["what makes this expensive:", "", ...notes] : ["nothing expensive in the shape of this selector."]),
        "",
        "this times the selector itself. a rule's real cost also depends on how often",
        "discord invalidates style, which the perf lens shows as dropped frames."
    ];
}

const DIFF_KEY = "probe-deck-classes";

/** Discord rebuilds its class hashes on every canary build. this remembers what the
 *  tracked landmarks looked like so the next update names what moved. */
export function diffLines(milestones: [string, string][]): string[] {
    const now: Record<string, string> = {};
    for (const [name, sel] of milestones) {
        const el = document.querySelector(sel);
        const cls = el && typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
        now[name] = cls || "(not on screen)";
    }

    let before: Record<string, string> = {};
    try { before = JSON.parse(localStorage.getItem(DIFF_KEY) || "{}"); } catch { /* first run */ }

    const rows: string[] = [];
    let changed = 0;
    for (const [name, cls] of Object.entries(now)) {
        const was = before[name];
        if (was === undefined) {
            rows.push(`  ${name.padEnd(15)} ${cls}   (first time seen)`);
        } else if (was !== cls) {
            changed++;
            rows.push(`  ${name.padEnd(15)} ${was}`, `  ${"".padEnd(15)} ${cls}   <- CHANGED`);
        } else {
            rows.push(`  ${name.padEnd(15)} ${cls}`);
        }
    }

    try { localStorage.setItem(DIFF_KEY, JSON.stringify(now)); } catch { /* private window */ }

    return [
        Object.keys(before).length
            ? `${changed} of ${Object.keys(now).length} landmarks changed since the last time this lens was opened`
            : "first run, nothing to compare against yet. open this again after a discord update.",
        "",
        ...rows,
        "",
        "the snapshot is rewritten every time you open this lens, so it always means",
        "'since you last looked'. a CHANGED row is a class name to fix in the registry."
    ];
}

/** every module exposing all of these property names, which is the same question
 *  findByProps answers, without having to guess in the console */
export function propsLines(query: string): string[] {
    const wanted = query.split(/[\s,]+/).map(w => w.trim()).filter(Boolean);
    if (!wanted.length) {
        return [
            "list property names a module must all have, space separated.",
            "",
            "the same question findByProps answers, so whatever this finds is what",
            "findByPropsLazy will hand you at runtime.",
            "",
            "example",
            "  open selectRole updateGuild",
            "  getMemberCount"
        ];
    }

    const hits: string[] = [];
    for (const id of Object.keys(wreq.m)) {
        let exports: any;
        try {
            exports = wreq(id as any);
        } catch {
            continue;
        }
        if (exports == null || (typeof exports !== "object" && typeof exports !== "function")) continue;

        const check = (obj: any, path: string) => {
            try {
                if (wanted.every(w => obj[w] !== undefined)) hits.push(`${id}${path}`);
            } catch { /* getters that throw when read out of context */ }
        };

        check(exports, "");
        for (const key of Object.keys(exports).slice(0, 40)) {
            const inner = exports[key];
            if (inner && (typeof inner === "object" || typeof inner === "function")) check(inner, `.${key}`);
        }
        if (hits.length > 30) break;
    }

    if (!hits.length) return [`nothing exposes all of: ${wanted.join(", ")}`];

    return [
        `${hits.length} match${hits.length > 1 ? "es" : ""} for: ${wanted.join(", ")}`,
        "",
        ...hits,
        "",
        `findByPropsLazy(${wanted.map(w => JSON.stringify(w)).join(", ")})`
    ];
}

/** Discord holds its copy in one big map. finding the key for text on screen is
 *  what you need when a patch has to match on a string. */
export function intlLines(query: string): string[] {
    const wanted = query.trim().toLowerCase();
    if (!wanted) {
        return [
            "type words you can see in discord to find the key behind them.",
            "",
            "useful when a patch has to anchor on a message, since the key is stable",
            "and the english text is not.",
            "",
            "example",
            "  members",
            "  are you sure"
        ];
    }

    const found: string[] = [];
    for (const id of Object.keys(wreq.m)) {
        const src = source(id);
        if (!src.includes("intl") && !src.includes("Messages")) continue;

        for (const m of src.matchAll(/["'`]([A-Z0-9_]{6,})["'`]\s*:\s*["'`]([^"'`]{3,120})["'`]/g)) {
            if (m[2].toLowerCase().includes(wanted)) {
                found.push(`${m[1]}\n    ${m[2]}`);
                if (found.length > 40) break;
            }
        }
        if (found.length > 40) break;
    }

    if (!found.length) return [`no message contains "${query.trim()}"`];
    return [`${found.length} message${found.length > 1 ? "s" : ""} containing "${query.trim()}"`, "", ...found];
}

// ------------------------------------------------------- invalidation lens
// What a rule costs to match is one half of CSS. The other half is how much has to be
// thrown away and worked out again when the rule's answer changes, and nothing else
// here measures that. A :root:has() setting an inherited variable cost ~5000ms of main
// thread per 30s on a ticking progress bar while every timing lens called it cheap.

/** set on an element, these reach every descendant, so recomputing one recomputes the
 *  whole subtree. custom properties are all inherited, which is what makes them the
 *  expensive thing to put behind a condition. */
const INHERITED = new Set([
    "color", "cursor", "direction", "font", "font-family", "font-feature-settings",
    "font-size", "font-stretch", "font-style", "font-variant", "font-weight",
    "letter-spacing", "line-height", "list-style", "list-style-image",
    "list-style-position", "list-style-type", "quotes", "text-align", "text-indent",
    "text-transform", "visibility", "white-space", "word-break", "word-spacing",
    "caret-color", "accent-color", "text-shadow", "-webkit-text-fill-color"
]);

const inheritedIn = (style: CSSStyleDeclaration) =>
    Array.from(style).filter(prop => prop.startsWith("--") || INHERITED.has(prop));

/** the part of a selector up to and including its first :has(), which is the element the
 *  browser has to re-check. everything after it only narrows what the rule then paints.
 *  the :has() is often nested, as in :not(:has(*)), so this closes every group it is
 *  inside rather than only the :has() itself. cutting at the inner paren left the anchor
 *  unbalanced and it matched nothing. */
function hasAnchor(selector: string): string | null {
    let depth = 0;
    let seen = false;

    for (let i = 0; i < selector.length; i++) {
        if (selector.startsWith(":has(", i)) seen = true;

        if (selector[i] === "(") depth++;
        else if (selector[i] === ")") {
            depth--;
            if (seen && depth === 0) return selector.slice(0, i + 1);
        }
    }

    return null;
}

interface Invalidation {
    from: string;
    selector: string;
    anchor: string;
    matches: number;
    blast: number;
    inherited: string[];
    hover: boolean;
}

/** how many elements have to be worked out again when this rule flips. an inherited
 *  property drags the whole subtree with it, anything else stops at the element. */
function blastOf(anchor: string, inherited: boolean): { matches: number; blast: number; } | null {
    let found: NodeListOf<Element>;
    try {
        found = document.querySelectorAll(anchor);
    } catch {
        return null;
    }

    if (!inherited) return { matches: found.length, blast: found.length };

    let blast = 0;
    for (const el of Array.from(found)) blast += el.querySelectorAll("*").length + 1;
    return { matches: found.length, blast };
}

export function invalidLines(query: string): string[] {
    loadThemeSheets();

    const rows: Invalidation[] = [];
    const filter = query.trim().toLowerCase();

    const unreadable = walkStyleRules((rule, from) => {
        for (const part of topLevelParts(rule.selectorText)) {
            const selector = part.trim();
            const anchor = hasAnchor(selector);
            if (!anchor) continue;

            const inherited = inheritedIn(rule.style);
            const reach = blastOf(anchor, inherited.length > 0);
            if (!reach) continue;

            rows.push({
                from,
                selector,
                anchor,
                matches: reach.matches,
                blast: reach.blast,
                inherited,
                hover: /:hover|:focus|:active/.test(anchor)
            });
        }
    });

    if (!rows.length) {
        return [
            "no :has() rule is loaded, so nothing here can invalidate wide",
            "",
            ...(unreadable.length ? ["these sheets threw when read, a different origin:", "", ...unreadable.map(n => `  ${n}`)] : [])
        ];
    }

    const shown = rows
        .filter(row => !filter || `${row.from} ${row.selector}`.toLowerCase().includes(filter))
        .sort((a, b) => b.blast - a.blast);

    const rooted = rows.filter(row => /^(:root|html|body)\b/.test(row.anchor));
    const onHover = rows.filter(row => row.hover);
    const worst = shown[0];

    const out = [
        `${rows.length} :has() rules loaded, ${rows.filter(r => r.inherited.length).length} of them set something inherited`,
        `${rooted.length} anchored at the document root, ${onHover.length} also keyed on hover or focus`,
        "",
        worst
            ? `worst reaches ${worst.blast} elements each time its answer changes`
            : "nothing matches that filter",
        "",
        "elements  matches  sets                        rule",
        "-".repeat(74)
    ];

    for (const row of shown.slice(0, 25)) {
        const sets = row.inherited.length
            ? `${row.inherited.slice(0, 2).join(" ")}${row.inherited.length > 2 ? ` +${row.inherited.length - 2}` : ""}`
            : "nothing inherited";

        out.push(
            `${String(row.blast).padStart(8)}  ${String(row.matches).padStart(7)}  ${sets.slice(0, 26).padEnd(26)}  ${row.from}`,
            `          ${row.anchor.slice(0, 62)}${row.hover ? "   <- rechecked on every mouse move" : ""}`
        );
    }

    out.push(
        "",
        "elements is what recomputes when the :has() answer flips. a rule setting an",
        "inherited property or a custom property drags every descendant with it, so the",
        "number is the subtree; anything else stops at the element itself.",
        "",
        "the fix for a big one is to move the :has() down onto the smallest element that",
        "can carry it, and to write the real property rather than a variable others read."
    );

    if (unreadable.length) out.push("", `not counted, a different origin: ${unreadable.join(", ")}`);

    return out;
}
