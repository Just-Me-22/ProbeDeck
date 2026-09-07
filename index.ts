/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

import { audit, overlaps } from "./audit";
import { covering, layout, react, selectors, winners } from "./inspect";
import { restLines, startTap, stopTap } from "./rest";
import { costLines, diffLines, findLines, patchLines, regexLines, storeLines } from "./tools";

const PANEL_ID = "probe-deck";

const MILESTONES: [string, string][] = [
    ["guild rail", '[class*="guilds_"]'],
    ["sidebar list", '[class*="sidebarList"]'],
    ["dm list", '[class*="privateChannels_"]'],
    ["channel list", '[class*="containerDefault"]'],
    ["user panel", '[class*="panels_"]'],
    ["message list", '[class*="messagesWrapper"], [class*="scrollerInner"]'],
    ["member list", '[class*="membersWrap"]']
];

const settings = definePluginSettings({
    longTaskFloor: {
        type: OptionType.NUMBER,
        description: "Only record main-thread blocks longer than this many milliseconds",
        default: 50,
        isValid: (v: number) => (Number.isFinite(v) && v >= 16) || "Must be at least 16"
    },
    openOnStart: {
        type: OptionType.BOOLEAN,
        description: "Show the panel as soon as Discord loads, instead of waiting for the hotkey",
        default: false
    },
    fontSize: {
        type: OptionType.NUMBER,
        description: "Panel text size in pixels. Raise it if the panel is hard to read or you are screenshotting it",
        default: 14,
        isValid: (v: number) => (Number.isFinite(v) && v >= 9 && v <= 28) || "Must be between 9 and 28"
    },
    panelWidth: {
        type: OptionType.NUMBER,
        description: "Panel width in pixels",
        default: 860,
        isValid: (v: number) => (Number.isFinite(v) && v >= 400) || "Must be at least 400"
    }
});

// ---------------------------------------------------------------- collectors
// These run from plugin start and are cheap enough to leave on: a PerformanceObserver
// costs nothing until an entry fires, and the milestone observer disconnects itself.

const boot: string[] = [];
const longTasks: { at: number; ms: number; }[] = [];
const bootAt = performance.now();

let taskObs: PerformanceObserver | null = null;
let msObs: MutationObserver | null = null;

function startCollectors() {
    for (const entry of performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]) {
        boot.push(`domContentLoaded ${entry.domContentLoadedEventEnd.toFixed(0)}ms`);
        boot.push(`load            ${entry.loadEventEnd.toFixed(0)}ms`);
    }
    for (const p of performance.getEntriesByType("paint")) {
        boot.push(`${p.name.padEnd(15)} ${p.startTime.toFixed(0)}ms`);
    }

    try {
        taskObs = new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
                if (e.duration < settings.store.longTaskFloor) continue;
                longTasks.push({ at: e.startTime, ms: e.duration });
                if (longTasks.length > 400) longTasks.shift();
            }
        });
        taskObs.observe({ type: "longtask", buffered: true });
    } catch { /* not every build exposes longtask */ }

    const pending = new Map(MILESTONES);
    msObs = new MutationObserver(() => {
        for (const [name, sel] of [...pending]) {
            if (!document.querySelector(sel)) continue;
            boot.push(`${name.padEnd(15)} ${(performance.now()).toFixed(0)}ms`);
            pending.delete(name);
        }
        if (pending.size === 0) { msObs?.disconnect(); msObs = null; }
    });
    msObs.observe(document.documentElement, { childList: true, subtree: true });
}

// ------------------------------------------------------------------ lenses

type Lens = "perf" | "boot" | "tasks" | "churn" | "inspect" | "css" | "audit"
    | "find" | "regex" | "rest" | "patches" | "stores" | "cost" | "diff";
const LENSES: Lens[] = ["perf", "boot", "tasks", "churn", "inspect", "css", "audit",
    "find", "regex", "rest", "patches", "stores", "cost", "diff"];
let lens: Lens = "perf";

let frames: number[] = [];
let rafId = 0;
let inspectLines: string[] = ["click any element to dump its box chain", "", "its own subtree prints below every click"];

function route(): string {
    const p = location.pathname;
    if (p.startsWith("/channels/@me")) return "DMs";
    if (p.startsWith("/channels/")) return "server";
    return p.slice(0, 28);
}

function sampleFrames() {
    let prev = performance.now();
    const tick = () => {
        const now = performance.now();
        frames.push(now - prev);
        if (frames.length > 120) frames.shift();
        prev = now;
        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
}

function perfLines(): string[] {
    if (frames.length < 5) return ["sampling..."];
    const sorted = [...frames].sort((a, b) => a - b);
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    const recent = longTasks.filter(t => t.at > performance.now() - 10_000);
    const blocked = recent.reduce((a, b) => a + b.ms, 0);
    return [
        `route            ${route()}`,
        `fps              ${(1000 / avg).toFixed(1)}   (avg frame ${avg.toFixed(1)}ms)`,
        `p95 frame        ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)}ms`,
        `worst frame      ${sorted[sorted.length - 1].toFixed(1)}ms`,
        "",
        `long tasks /10s  ${recent.length}`,
        `blocked /10s     ${blocked.toFixed(0)}ms`,
        "",
        "switch between a DM and a server and watch these."
    ];
}

function taskLines(): string[] {
    if (!longTasks.length) return ["no long tasks recorded yet"];

    const now = performance.now();
    const window = 30_000;
    const recent = longTasks.filter(t => t.at > now - window);

    // an even spacing between blocks means something periodic is firing, not steady render cost
    const gaps: number[] = [];
    for (let i = 1; i < recent.length; i++) gaps.push(recent[i].at - recent[i - 1].at);
    const median = gaps.length
        ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
        : 0;
    const spread = gaps.length
        ? Math.max(...gaps) - Math.min(...gaps)
        : 0;

    // 60 cells over 30s, so one cell is 500ms
    const cells = new Array(60).fill(0);
    for (const t of recent) {
        const i = Math.floor((t.at - (now - window)) / (window / 60));
        if (i >= 0 && i < 60) cells[i] += t.ms;
    }
    const glyph = (ms: number) => ms === 0 ? "." : ms < 100 ? "-" : ms < 250 ? "=" : ms < 500 ? "#" : "@";

    const worst = [...recent].sort((a, b) => b.ms - a.ms).slice(0, 8);

    return [
        `route            ${route()}`,
        `blocks /30s      ${recent.length}`,
        `blocked /30s     ${recent.reduce((a, b) => a + b.ms, 0).toFixed(0)}ms`,
        "",
        `median gap       ${median.toFixed(0)}ms`,
        `gap spread       ${spread.toFixed(0)}ms   ${gaps.length > 3 && spread < median * 0.5
            ? "<- evenly spaced, points at a timer/interval"
            : "<- irregular, points at event-driven work"}`,
        "",
        "last 30s   (. none  - <100  = <250  # <500  @ 500+)",
        "  " + cells.map(glyph).join(""),
        "  -30s" + "now".padStart(59),
        "",
        "worst blocks:",
        ...worst.map(t => `  ${t.ms.toFixed(0).padStart(5)}ms  ${((now - t.at) / 1000).toFixed(1)}s ago`)
    ];
}

// ---------------------------------------------------------------- churn lens
// Only runs while its lens is selected. Counts DOM mutations under the DM list and
// tallies them by class, which names whatever keeps re-rendering the rows.

let churnObs: MutationObserver | null = null;
let churnHits: { at: number; key: string; }[] = [];

function churnKey(n: Node): string {
    for (let e: Node | null = n; e; e = e.parentElement) {
        if (!(e instanceof Element)) continue;
        const c = typeof e.className === "string" ? e.className : "";
        if (!c) continue;
        const token = c.split(/\s+/).find(t => t.length > 3) ?? c;
        return token.replace(/_+[a-z0-9]{5,7}$/i, "_");
    }
    return "(unknown)";
}

function startChurn() {
    if (churnObs) return;
    // whole app: the point is to find out what churns, not to assume where
    const root = document.querySelector("#app-mount") ?? document.body;
    if (!root) return;
    churnObs = new MutationObserver(records => {
        const now = performance.now();
        for (const r of records) {
            churnHits.push({ at: now, key: churnKey(r.target) });
        }
        if (churnHits.length > 6000) churnHits = churnHits.slice(-3000);
    });
    churnObs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
}

function stopChurn() {
    churnObs?.disconnect();
    churnObs = null;
    churnHits = [];
}

function churnLines(): string[] {
    if (!churnObs) return ["attaching..."];
    const now = performance.now();
    const win = 10_000;
    const recent = churnHits.filter(h => h.at > now - win);
    if (!recent.length) return ["watching the whole app", "", "0 mutations in the last 10s"];

    const tally = new Map<string, number>();
    for (const h of recent) tally.set(h.key, (tally.get(h.key) ?? 0) + 1);
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 12);

    const blocks = longTasks.filter(t => t.at > now - win);
    return [
        `route            ${route()}`,
        `mutations /10s   ${recent.length}   (${(recent.length / 10).toFixed(0)}/s)`,
        `blocks /10s      ${blocks.length}`,
        "",
        "what is mutating (top 12):",
        ...top.map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`),
        "",
        "whatever tops this list is what is doing the work."
    ];
}

// ------------------------------------------------------------- typed lenses
// Searching every webpack module is far too heavy for the repaint timer, so each of
// these is cached against the query that produced it and only re-runs when it changes.

/** the text in the panel's query box, kept per lens so switching does not lose it */
const queries: Partial<Record<Lens, string>> = {};

const lensCache = new Map<string, string[]>();

/** set when a lens with a query box is opened, so the box takes focus once */
let pendingFocus = false;

function cached(key: string, run: () => string[]): string[] {
    const hit = lensCache.get(key);
    if (hit) return hit;
    const lines = run();
    lensCache.set(key, lines);
    return lines;
}

function typedLines(which: Lens): string[] {
    const q = queries[which] ?? "";
    switch (which) {
        case "find": return cached(`find:${q}`, () => findLines(q));
        case "regex": return cached(`regex:${q}`, () => regexLines(q));
        case "stores": return cached(`stores:${q}`, () => storeLines(q));
        case "cost": return cached(`cost:${q}`, () => costLines(q));
        case "css": return cssLines(q);
        case "rest": return restLines(q);
        case "patches": return cached("patches", () => patchLines());
        case "diff": return cached("diff", () => diffLines(MILESTONES));
        default: return [];
    }
}

/** which lenses take a typed question, and what the box should say when it is empty */
const PROMPTS: Partial<Record<Lens, string>> = {
    css: "css to try, applied the moment you press ctrl+enter",
    find: "words a module must all contain",
    regex: "<find> | <regex> | <replacement, optional>",
    rest: "filter by method or path",
    stores: "part of a store name",
    cost: "a css selector"
};

const SCRATCH_ID = "probe-deck-scratch";

/** the scratchpad writes straight into a style tag, so a rule is live the moment you
 *  send it. nothing survives a reload, which is the point: somewhere to try things,
 *  not somewhere to keep them. */
function cssLines(css: string): string[] {
    let tag = document.getElementById(SCRATCH_ID) as HTMLStyleElement | null;

    if (!css.trim()) {
        tag?.remove();
        return [
            "nothing applied",
            "",
            "type a rule and send it with ctrl+enter and it is live immediately,",
            "no build and no reload. clear the box and send again to take it away.",
            "",
            "the inspect lens hands you ready made selectors to paste in here"
        ];
    }

    if (!tag) {
        tag = document.createElement("style");
        tag.id = SCRATCH_ID;
        document.documentElement.appendChild(tag);
    }
    tag.textContent = css;

    const rules = tag.sheet?.cssRules;
    const out = ["applied, and it stays until you reload or clear the box", ""];

    if (!rules?.length) {
        out.push("the browser parsed no rules out of that, so check the braces");
        return out;
    }

    for (const rule of [...rules]) {
        const selector = (rule as CSSStyleRule).selectorText;
        if (!selector) { out.push(rule.cssText); continue; }

        let hits: string;
        try {
            hits = `${document.querySelectorAll(selector).length} matches`;
        } catch {
            hits = "not a selector the browser accepts";
        }
        out.push(`${selector}   ->   ${hits}`);
    }

    out.push("", "copy takes the whole panel, so paste it into the theme when it looks right");
    return out;
}

let auditCache: string[] = [];

/** the sweep touches every theme selector, so it runs on demand rather than on the
 *  repaint timer. ctrl+alt+r re-runs it. */
function auditLines(): string[] {
    if (!auditCache.length) {
        auditCache = [
            "OVERLAPPING PANELS", "",
            ...overlaps(),
            "", "=".repeat(74), "",
            ...audit()
        ];
    }
    return auditCache;
}

function bootLines(): string[] {
    return [
        `plugin started at ${bootAt.toFixed(0)}ms`,
        "",
        ...(boot.length ? boot : ["nothing recorded"])
    ];
}

function describe(el: Element, depth: number): string {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el as HTMLElement);
    const name = (typeof el.className === "string" ? el.className : "").slice(0, 40) || "(none)";

    // inline styles are javascript-owned and beat the stylesheet, important ones beat
    // even !important rules - exactly the values a box hunt needs to see. "!" marks
    // an important one.
    const st = (el as HTMLElement).style;
    const inline = st?.length
        ? ` [inline ${Array.from(st).slice(0, 4).map(prop =>
            `${prop}:${st.getPropertyValue(prop)}${st.getPropertyPriority(prop) ? "!" : ""}`).join(" ")}${st.length > 4 ? ` +${st.length - 4} more` : ""}]`
        : "";

    // text sizing: the computed px, the x-height normaliser when one is set, and the
    // first family. a name rendering "too small" is almost always one of these three.
    const adj = cs.fontSizeAdjust && cs.fontSizeAdjust !== "none" ? `/adj ${cs.fontSizeAdjust}` : "";
    const fam = (cs.fontFamily.split(",")[0] || "").replace(/["']/g, "").slice(0, 16);
    const font = ` font=${cs.fontSize}${adj} ${fam}`;

    return `${"  ".repeat(depth)}<${el.tagName.toLowerCase()}> ${r.width.toFixed(0)}x${r.height.toFixed(0)} ` +
        `x=${r.left.toFixed(0)}..${r.right.toFixed(0)} y=${r.top.toFixed(0)}..${r.bottom.toFixed(0)} ` +
        `min=${cs.minWidth} max=${cs.maxWidth}${font}${inline} .${name}`;
}

/** what is INSIDE the thing that was clicked. children often carry pointer-events:
 *  none, so the chain alone never reaches them */
function subtree(el: Element, depth: number, out: string[]): string[] {
    if (depth > 7) return out;
    const cls = (typeof el.className === "string" ? el.className : "") || "(none)";
    const text = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent?.trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 24);
    const r = el.getBoundingClientRect();
    const box = `h=${r.height.toFixed(0).padStart(3)} y=${r.top.toFixed(0)}`;
    // an inline size means javascript is driving it and no css rule will win
    const s = (el as HTMLElement).style;
    const inline = [s?.height && `height:${s.height}`, s?.width && `width:${s.width}`]
        .filter(Boolean).join(" ");
    out.push(`${"  ".repeat(depth)}<${el.tagName.toLowerCase()}> ${box} ` +
        `${inline ? `[inline ${inline}] ` : ""}.${cls.slice(0, 34)}${text ? `  "${text}"` : ""}`);
    // avatar and decoration svgs are a dozen lines of masks that never matter here
    if (el.tagName.toLowerCase() === "svg") return out;
    for (const child of Array.from(el.children)) subtree(child, depth + 1, out);
    return out;
}

function onInspectClick(e: MouseEvent) {
    if (lens !== "inspect") return;
    const el = e.target as Element;
    if (!el || (el as HTMLElement).closest?.(`#${PANEL_ID}`)) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    const chain: string[] = [];
    let depth = 0;
    for (let n: Element | null = el; n && n !== document.body && depth < 10; n = n.parentElement) {
        chain.push(describe(n, depth++));
    }
    const rule = (title: string) => ["", "=".repeat(74), `  ${title}`, "=".repeat(74), ""];

    inspectLines = [
        ...rule("BOX CHAIN  (clicked element first, outermost last)"),
        ...chain,
        ...rule("SELECTORS  (paste one of these straight into the theme)"),
        ...selectors(el),
        ...rule("LAYOUT  (how the parent is placing it)"),
        ...layout(el),
        ...rule("WINNING RULES  (what is actually setting each property)"),
        ...winners(el),
        ...rule("REACT PROPS  (what a patch actually has to work with)"),
        ...react(el),
        ...rule("PAINTING HERE  (including what a click cannot reach)"),
        ...covering(e.clientX, e.clientY),
        ...rule("SUBTREE  (what is inside it)"),
        ...subtree(el, 0, [])
    ];
    render();
}

// ------------------------------------------------------------------- panel

const INK = {
    base: "#e6edf6",
    dim: "#7d8ea6",
    tag: "#7cd7ff",
    cls: "#9fe6a0",
    num: "#f3c96b",
    str: "#f5a3c7",
    token: "#c4a7ff",
    warn: "#ff9b9b",
    accent: "#8fb0ff"
};

// a class has to start the piece, or x=155..500 colours ".500" as one
const PIECES = /(<\/?[a-z][\w-]*>|"[^"]*"|!important|--[\w-]+|(?<=^|[\s(>])\.[A-Za-z][\w-]*|\b\d+(?:\.\d+)?(?:px|ms|%|s)?\b)/g;

function inkFor(piece: string): string {
    if (piece[0] === "<") return INK.tag;
    if (piece[0] === "\"") return INK.str;
    if (piece === "!important") return INK.warn;
    if (piece.startsWith("--")) return INK.token;
    if (piece[0] === ".") return INK.cls;
    return INK.num;
}

function lineEl(text: string): HTMLElement {
    const div = document.createElement("div");
    div.style.cssText = "white-space:pre";
    if (!text) { div.textContent = " "; return div; }

    const base =
        /PINNED|SUBGRID|INLINE - |could not be read|no matching rules|cannot /.test(text) ? INK.warn :
        /^\s{2}(won by|from|beat|token)\s/.test(text) ? INK.dim :
        INK.base;

    text.split(PIECES).forEach((piece, i) => {
        if (!piece) return;
        const span = document.createElement("span");
        span.textContent = piece;
        span.style.color = i % 2 ? inkFor(piece) : base;
        div.appendChild(span);
    });
    return div;
}

function headingEl(title: string): HTMLElement {
    const div = document.createElement("div");
    div.style.cssText = "margin:26px 0 12px;padding-bottom:6px;border-bottom:1px solid #ffffff14;" +
        `color:${INK.dim};font-size:0.82em;font-weight:700;letter-spacing:1.6px;text-transform:uppercase`;
    div.textContent = title.trim();
    return div;
}

/** the ==== rules read as a heading on paper but as noise on screen, so they are
 *  dropped here and the title they wrap is promoted into a real one */
function bodyEl(lines: string[]): HTMLElement {
    const wrap = document.createElement("div");
    let heading = false;
    for (const line of lines) {
        if (/^=+$/.test(line)) { heading = true; continue; }
        if (heading) {
            heading = false;
            if (line.trim()) { wrap.appendChild(headingEl(line)); continue; }
        }
        wrap.appendChild(lineEl(line));
    }
    return wrap;
}

function chip(text: Lens, active: boolean): HTMLElement {
    const s = document.createElement("span");
    s.textContent = text;
    s.className = "pd-chip";
    // the panel is pointer-events:none so the inspect lens can see through it;
    // a tab has to opt itself back in, the way the copy button already does
    s.style.cssText = "padding:2px 8px;border-radius:5px;font-size:0.86em;letter-spacing:0.4px;" +
        "pointer-events:auto;cursor:pointer;user-select:none;" +
        (active
            ? "background:#4c7dff;color:#0a0d13;font-weight:700"
            : `background:transparent;color:${INK.dim};font-weight:500`);

    s.addEventListener("pointerdown", e => {
        // without this the bar's drag handler starts a drag on every tab press
        e.preventDefault();
        e.stopPropagation();
    });

    s.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        if (text !== lens) show(text);
    });

    return s;
}

/** the bar is the only part of the panel that takes the pointer, so it doubles as the
 *  drag handle. starting a drag anywhere else would swallow the clicks the inspect
 *  lens needs. */
function startDrag(e: PointerEvent) {
    const el = document.getElementById(PANEL_ID);
    if (!el || e.button !== 0) return;

    const box = el.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    e.preventDefault();

    const move = (ev: PointerEvent) => {
        const x = Math.min(Math.max(0, ev.clientX - dx), innerWidth - box.width);
        const y = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 40);
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    };

    const up = () => {
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", up, true);
        savePos(parseFloat(el.style.left), parseFloat(el.style.top));
    };

    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
}

function chromeEl(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "pd-grip";
    bar.style.cssText = "position:sticky;top:0;z-index:1;margin:-14px -18px 14px;padding:12px 18px 11px;" +
        "background:#0d1017;border-bottom:1px solid #ffffff1a;" +
        "pointer-events:auto;user-select:none;" +
        "display:flex;flex-wrap:wrap;align-items:center;gap:6px";
    bar.addEventListener("pointerdown", startDrag);

    const title = document.createElement("span");
    title.textContent = "PROBE DECK";
    title.style.cssText = `font-weight:700;letter-spacing:1.4px;color:${INK.accent};margin-right:4px`;
    bar.appendChild(title);

    for (const l of LENSES) bar.appendChild(chip(l, l === lens));

    // the only interactive thing in here - the panel is pointer-events:none so
    // this has to opt itself back in. onInspectClick already skips panel clicks
    const copy = document.createElement("button");
    copy.className = "pd-copy";
    copy.textContent = "copy";
    copy.style.cssText = "pointer-events:auto;cursor:pointer;margin-left:4px;padding:1px 10px;" +
        `border:0;border-radius:999px;font:inherit;font-weight:600;background:#ffffff1a;color:${INK.base}`;
    copy.addEventListener("pointerdown", e => e.stopPropagation());
    copy.addEventListener("click", e => { e.stopPropagation(); copyPanel(); });
    bar.appendChild(copy);

    const keys = document.createElement("span");
    keys.textContent = "drag to move    click a tab or press 1-9    ← → lens    f9 hide  f10 reset";
    keys.style.cssText = `color:${INK.dim};margin-left:auto`;
    bar.appendChild(keys);

    const prompt = PROMPTS[lens];
    if (prompt) {
        // css needs more than one line; every other lens is a single question
        const multiline = lens === "css";
        const box = document.createElement(multiline ? "textarea" : "input") as HTMLInputElement & HTMLTextAreaElement;
        box.className = "pd-query";
        box.placeholder = prompt;
        box.value = queries[lens] ?? "";
        box.spellcheck = false;
        box.style.cssText = "flex:0 0 100%;margin-top:8px;padding:6px 10px;pointer-events:auto;" +
            (multiline ? "min-height:84px;resize:vertical;" : "") +
            `border:1px solid #ffffff26;border-radius:7px;font:inherit;background:#ffffff0d;color:${INK.base};outline:none`;

        // the arrows change lens and discord's composer eats the rest, so while this
        // has focus every key belongs to it and nothing else
        box.addEventListener("keydown", e => {
            e.stopPropagation();
            // plain enter has to stay a newline in the textarea, so ctrl or shift sends
            if (e.key !== "Enter" || (multiline && !e.ctrlKey && !e.shiftKey)) return;
            e.preventDefault();
            queries[lens] = box.value;
            lastPaint = "";
            render();
        });
        box.addEventListener("pointerdown", e => e.stopPropagation());
        bar.appendChild(box);

        // replaceChildren throws the focused node away on every repaint, so put it back
        if (pendingFocus) {
            queueMicrotask(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); });
            pendingFocus = false;
        }
    }

    if (copyNote) {
        const note = document.createElement("span");
        note.textContent = copyNote;
        note.style.cssText = `flex:0 0 100%;color:${INK.cls}`;
        bar.appendChild(note);
    }
    return bar;
}

const POS_KEY = "probe-deck-pos";

/** where the panel was left. top right by default, which is where it always used to sit */
function loadPos(): { x: number; y: number; } {
    const fallback = { x: Math.max(10, innerWidth - settings.store.panelWidth - 10), y: 10 };
    try {
        const raw = localStorage.getItem(POS_KEY);
        if (!raw) return fallback;
        const p = JSON.parse(raw);
        if (typeof p?.x !== "number" || typeof p?.y !== "number") return fallback;
        return p;
    } catch {
        return fallback;
    }
}

function savePos(x: number, y: number) {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); } catch { /* private window, not worth reporting */ }
}

function resetPos() {
    try { localStorage.removeItem(POS_KEY); } catch { /* nothing to clear */ }
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const { x, y } = loadPos();
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
}

const CSS_ID = "probe-deck-css";

/** the panel is built from inline styles, but a scrollbar and a :hover cannot be
 *  expressed inline, so those two live here */
function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
#${PANEL_ID}{scrollbar-width:thin;scrollbar-color:#ffffff2e transparent}
#${PANEL_ID}::-webkit-scrollbar{width:10px}
#${PANEL_ID}::-webkit-scrollbar-track{background:transparent}
#${PANEL_ID}::-webkit-scrollbar-thumb{background:#ffffff24;border:3px solid transparent;background-clip:content-box;border-radius:999px}
#${PANEL_ID}::-webkit-scrollbar-thumb:hover{background:#ffffff45;background-clip:content-box}
#${PANEL_ID} .pd-grip{cursor:grab}
#${PANEL_ID} .pd-grip:active{cursor:grabbing}
#${PANEL_ID} .pd-copy:hover{background:#ffffff2e}
#${PANEL_ID} .pd-query:focus{border-color:#4c7dff;background:#4c7dff14}
#${PANEL_ID} .pd-query::placeholder{color:#5d6d82}`;
    document.documentElement.appendChild(style);
}

function panel(): HTMLElement {
    let el = document.getElementById(PANEL_ID);
    if (!el) {
        ensureCss();
        el = document.createElement("div");
        el.id = PANEL_ID;
        // focusable so opening the panel can take focus off discord's composer.
        // without that the arrows never reach us: discord keeps the message box
        // focused almost all the time, and an arrow there belongs to the caret.
        el.tabIndex = -1;
        const pos = loadPos();
        el.style.cssText = [
            "position:fixed", "z-index:99999", `top:${pos.y}px`, `left:${pos.x}px`,
            `width:${settings.store.panelWidth}px`,
            "max-height:92vh", "overflow:auto", "padding:14px 18px 18px",
            "background:#0d1017",
            `color:${INK.base}`,
            `font:500 ${settings.store.fontSize}px/1.6 ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,monospace`,
            "pointer-events:none", "border:1px solid #ffffff1a", "border-radius:10px",
            "box-shadow:0 24px 64px #000e",
            "outline:none"
        ].join(";");
        document.documentElement.appendChild(el);
    }
    return el;
}

function render() {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const body =
        lens === "perf" ? perfLines() :
        lens === "boot" ? bootLines() :
        lens === "tasks" ? taskLines() :
        lens === "churn" ? churnLines() :
        lens === "audit" ? auditLines() :
        lens === "inspect" ? inspectLines :
        typedLines(lens);
    lastText = [
        `PROBE DECK  [${LENSES.map(l => (l === lens ? `(${l})` : l)).join(" ")}]`,
        "left/right arrow lens   ctrl+alt+p hide   ctrl+alt+r reset   copy button in the header",
        "-".repeat(74),
        ...body
    ].join("\n");

    // perf and churn repaint twice a second; the inspect output never changes
    // between clicks, so painting it once is the difference between free and not
    const key = `${lastText} ${copyNote}`;
    if (key === lastPaint) return;
    lastPaint = key;

    const top = el.scrollTop;
    el.replaceChildren(chromeEl(), bodyEl(body));
    el.scrollTop = top;
}

/** the panel keeps pointer-events:none so clicks reach discord underneath, which
 *  also means it cannot be scrolled. this gives back the wheel and nothing else */
function onWheel(e: WheelEvent) {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    el.scrollTop += e.deltaY;
    e.preventDefault();
}

let lastText = "";
let lastPaint = "";
let copyNote = "";

/** the panel is pointer-events:none so it cannot be selected. this is the only way
 *  its output leaves the client, and reading it off a screenshot does not work -
 *  a downscaled capture turns this text to mush. */
async function copyPanel() {
    try {
        await navigator.clipboard.writeText(lastText);
        copyNote = `copied ${lastText.length} chars to the clipboard`;
    } catch {
        const ta = document.createElement("textarea");
        ta.value = lastText;
        ta.style.cssText = "position:fixed;top:-9999px";
        document.body.appendChild(ta);
        ta.select();
        copyNote = document.execCommand("copy") ? "copied to the clipboard" : "copy failed";
        ta.remove();
    }
    render();
    setTimeout(() => { copyNote = ""; render(); }, 4000);
}

let timer = 0;

function open() {
    panel().focus({ preventScroll: true });
    sampleFrames();
    timer = window.setInterval(render, 500);
    document.addEventListener("click", onInspectClick, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    render();
}

function close() {
    stopChurn();
    cancelAnimationFrame(rafId);
    clearInterval(timer);
    frames = [];
    document.removeEventListener("click", onInspectClick, true);
    document.removeEventListener("wheel", onWheel, true);
    document.getElementById(PANEL_ID)?.remove();
    lastPaint = "";
}

const isOpen = () => !!document.getElementById(PANEL_ID);

function show(next: Lens) {
    lens = next;
    lens === "churn" ? startChurn() : stopChurn();
    pendingFocus = PROMPTS[lens] != null;
    lastPaint = "";
    render();
}

function step(dir: number) {
    const i = LENSES.indexOf(lens);
    show(LENSES[(i + dir + LENSES.length) % LENSES.length]);
}

/** the arrows are only ours while the panel is up and nothing is being typed into,
 *  so discord keeps them for the composer, the search box and channel navigation.
 *  the listener sits on window rather than document for the same reason: discord
 *  claims the arrows upstream of document, and a document listener never sees them. */
function typingInto(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
}

function reset() {
    longTasks.length = 0;
    frames = [];
    auditCache = [];
    lensCache.clear();
    resetPos();
    render();
}

/** F keys carry no character, so windows never turns them into altgr and nothing
 *  leaks into the composer. the old ctrl+alt chords still work for muscle memory. */
function onKey(e: KeyboardEvent) {
    const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;

    if (bare && e.code === "F9") { e.preventDefault(); isOpen() ? close() : open(); return; }
    if (bare && e.code === "F10" && isOpen()) { e.preventDefault(); reset(); return; }

    if (isOpen() && bare && !typingInto(e)) {
        const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (dir) {
            e.preventDefault();
            e.stopImmediatePropagation();
            step(dir);
            return;
        }

        // a digit jumps straight to a lens, 1 through 9 then 0 for the tenth
        if (/^Digit[0-9]$/.test(e.code)) {
            const n = e.code === "Digit0" ? 9 : Number(e.code.slice(5)) - 1;
            if (LENSES[n]) {
                e.preventDefault();
                e.stopImmediatePropagation();
                show(LENSES[n]);
            }
            return;
        }
    }

    if (!e.ctrlKey || !e.altKey) return;

    // e.code, not e.key: windows treats ctrl+alt as altgr, so on a polish layout
    // ctrl+alt+r arrives as a different character and never matches "r".
    // preventDefault does not stop that character reaching the composer either -
    // slate takes it on beforeinput - which is why copy is a button, not a chord.
    const k = e.code;
    if (k === "KeyP") { e.preventDefault(); isOpen() ? close() : open(); return; }
    if (!isOpen()) return;
    if (k === "KeyR") { e.preventDefault(); reset(); }
}

export default definePlugin({
    name: "ProbeDeck",
    description: "Always-on diagnostics that stay idle until you open them. F9 toggles the panel, F10 clears it, then click a tab, press a number, or use the left and right arrows to move between lenses: frame timing, startup, main-thread blocks, DOM churn and an element inspector.",
    authors: [{ name: "heart_menace", id: 281162701303185408n }],
    settings,

    start() {
        startCollectors();
        startTap();
        window.addEventListener("keydown", onKey, true);
        if (settings.store.openOnStart) setTimeout(open, 3000);
    },

    stop() {
        stopTap();
        window.removeEventListener("keydown", onKey, true);
        taskObs?.disconnect();
        msObs?.disconnect();
        close();
    }
});
