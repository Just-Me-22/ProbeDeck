/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** The lenses that answer a typed question. Everything here reads Discord's own
 *  modules and Vencord's patch bookkeeping, so none of it needs the console. */

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

export function costLines(query: string): string[] {
    if (!query.trim()) {
        return [
            "paste a css selector to see what it costs before you ship it.",
            "",
            "reports how many elements it matches and how long the browser takes",
            "to run it, plus the parts that make a selector expensive on a hover",
            "or scroll path.",
            "",
            "example",
            "  :root:has(#vc-spotify-player)",
            "  [class*=\"panels_\"] [class*=\"container_\"]"
        ];
    }

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
