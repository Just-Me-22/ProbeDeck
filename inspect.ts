/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Everything the inspect lens reports beyond the plain box chain: which rule wins
 *  for a property and where it came from, which --* token feeds it, and how the
 *  parent is laying the element out. A screenshot cannot show any of these. */

/** properties worth resolving. sizing first, because that is what usually lies. */
const TRACKED = [
    "display", "position",
    "width", "min-width", "max-width",
    "height", "min-height", "max-height",
    "flex", "order", "grid-area",
    "margin-top", "margin-bottom", "margin-left", "margin-right",
    "padding-top", "padding-bottom", "padding-left", "padding-right",
    "background-color", "background-image", "color",
    "border-top", "border-bottom", "border-left", "border-right",
    "box-shadow", "mask-image", "opacity", "filter",
    "overflow", "z-index"
];

/** rough CSS specificity. exact enough to rank two rules that both match. */
function specificity(sel: string): number {
    const ids = (sel.match(/#[\w-]+/g) ?? []).length;
    const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
    const els = (sel.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
    return ids * 10000 + cls * 100 + els;
}

/** the stylesheet a rule came from, named the way a person would recognise it */
function sourceOf(sheet: CSSStyleSheet | null): string {
    if (!sheet) return "(inline)";
    const node = sheet.ownerNode as HTMLElement | null;
    if (node?.id) return `<style #${node.id}>`;
    if (sheet.href) return sheet.href.split("/").pop() ?? sheet.href;
    // vencord injects themes and quickcss as bare style elements; the first
    // selector is the only thing that distinguishes them
    try {
        const first = (sheet.cssRules[0] as CSSStyleRule)?.selectorText;
        if (first) return `<style> starting "${first.slice(0, 24)}"`;
    } catch { /* cross-origin */ }
    return "<style>";
}

/** a nested rule's selectorText is relative: "&:hover" tested on its own matches
 *  every hovered element, whatever its parent rule was. folding the parent in is
 *  what stops an unrelated block being reported as the winner. */
function resolve(sel: string, scope: string): string {
    return sel.split(",").map(part => {
        const p = part.trim();
        return p.includes("&") ? p.replace(/&/g, `:is(${scope})`) : `:is(${scope}) ${p}`;
    }).join(", ");
}

interface Hit {
    value: string;
    important: boolean;
    spec: number;
    order: number;
    sel: string;
    src: string;
}

function collect(el: Element, out: Map<string, Hit[]>): { blocked: number; } {
    let order = 0;
    let blocked = 0;

    const visit = (rules: CSSRuleList, sheet: CSSStyleSheet, scope: string) => {
        for (const rule of Array.from(rules)) {
            const styleRule = rule as CSSStyleRule;
            const selector = styleRule.selectorText && scope
                ? resolve(styleRule.selectorText, scope)
                : styleRule.selectorText;

            if (selector) {
                let best = -1;
                for (const part of selector.split(",")) {
                    const sel = part.trim();
                    try { if (el.matches(sel)) best = Math.max(best, specificity(sel)); } catch { /* & and other relative selectors */ }
                }
                if (best >= 0) {
                    order++;
                    for (const prop of TRACKED) {
                        const value = styleRule.style.getPropertyValue(prop);
                        if (!value) continue;
                        const list = out.get(prop) ?? [];
                        list.push({
                            value,
                            important: styleRule.style.getPropertyPriority(prop) === "important",
                            spec: best,
                            order,
                            sel: selector,
                            src: sourceOf(sheet)
                        });
                        out.set(prop, list);
                    }
                }
            }

            // an imported sheet is not in document.styleSheets and is reachable only
            // here. vencord loads every theme through @import, so skipping this hides
            // the theme's own rules from the whole report.
            const imported = (rule as CSSImportRule).styleSheet;
            if (imported) {
                try { visit(imported.cssRules, imported, scope); } catch { blocked++; }
                continue;
            }

            // media, supports, layer and nested blocks each hold rules of their own.
            // this runs after the rule above rather than instead of it: since css
            // nesting, a plain style rule reports an empty cssRules list too, and
            // treating that as "this is a grouping rule" skipped every rule there is.
            const nested = (rule as CSSGroupingRule).cssRules;
            if (nested?.length) visit(nested, sheet, selector || scope);
        }
    };

    for (const sheet of Array.from(document.styleSheets)) {
        try { visit(sheet.cssRules, sheet as CSSStyleSheet, ""); } catch { blocked++; }
    }

    // an inline style beats every rule, and means javascript is driving the value
    const inline = (el as HTMLElement).style;
    for (const prop of TRACKED) {
        const value = inline?.getPropertyValue(prop);
        if (!value) continue;
        const list = out.get(prop) ?? [];
        list.push({
            value,
            important: inline.getPropertyPriority(prop) === "important",
            spec: 1_000_000,
            order: 1_000_000,
            sel: "(element style attribute)",
            src: "INLINE - set by javascript"
        });
        out.set(prop, list);
    }

    return { blocked };
}

/** which rule actually wins for each tracked property, and what feeds it */
export function winners(el: Element): string[] {
    const map = new Map<string, Hit[]>();
    const { blocked } = collect(el, map);
    const note = blocked ? [`${blocked} stylesheet${blocked > 1 ? "s" : ""} could not be read`] : [];
    if (!map.size) return ["no matching rules found", ...note];

    const cs = getComputedStyle(el as HTMLElement);
    const out: string[] = [];

    for (const prop of TRACKED) {
        const hits = map.get(prop);
        if (!hits?.length) continue;
        hits.sort((a, b) =>
            (+b.important - +a.important) || (b.spec - a.spec) || (b.order - a.order));
        const win = hits[0];

        out.push(`${prop.padEnd(17)}${cs.getPropertyValue(prop) || "(empty)"}`);
        out.push(`  won by  ${win.sel.slice(0, 58)}${win.important ? "  !important" : ""}`);
        out.push(`  from    ${win.src}`);

        // naming the rules that lost is the point: "beat 3 others" tells you a fight
        // happened, not who you are fighting, and the loser is usually your own line
        for (const lost of hits.slice(1, 5)) {
            const why = lost.important === win.important
                ? (lost.spec === win.spec ? "came earlier" : "less specific")
                : "not important";
            out.push(`  beat    ${lost.sel.slice(0, 48)}   ${lost.value.trim().slice(0, 20)}   ${why}`);
        }
        if (hits.length > 5) out.push(`  beat    and ${hits.length - 5} more`);

        // a var() in the winning declaration names the token to edit
        for (const token of win.value.match(/--[\w-]+/g) ?? []) {
            out.push(`  token   ${token} = ${cs.getPropertyValue(token).trim() || "(unset here)"}`);
        }
        out.push("");
    }
    out.push(...note);
    return out.length ? out : ["nothing tracked is set on this element"];
}

/** how the parent is laying this element out. grid and flex fail in ways the box
 *  numbers alone never explain - a pinned track, a gap, an order. */
export function layout(el: Element): string[] {
    const parent = el.parentElement;
    if (!parent) return ["no parent"];

    const p = getComputedStyle(parent);
    const c = getComputedStyle(el as HTMLElement);
    const name = (typeof parent.className === "string" ? parent.className : "").slice(0, 46) || "(none)";

    const out = [
        `parent  .${name}`,
        `        display: ${p.display}`
    ];

    if (p.display.includes("grid")) {
        out.push(`        grid-template-columns: ${p.gridTemplateColumns}`);
        if (p.gridTemplateAreas !== "none") out.push(`        grid-template-areas:   ${p.gridTemplateAreas}`);
        out.push(`        gap: ${p.rowGap} ${p.columnGap}`);
        out.push("", `this element  grid-area: ${c.gridArea}`);
        if (p.gridTemplateColumns === "subgrid") {
            out.push("", "parent is a SUBGRID - it cannot grow a track for an extra child.");
        }
    } else if (p.display.includes("flex")) {
        out.push(`        flex-direction: ${p.flexDirection}   gap: ${p.rowGap} ${p.columnGap}`);
        out.push("", `this element  flex: ${c.flexGrow} ${c.flexShrink} ${c.flexBasis}   order: ${c.order}`);
    }

    // a matching min and max is a hard pin, and no amount of sizing a child moves it
    if (p.minWidth !== "0px" && p.minWidth === p.maxWidth) {
        out.push("", `parent is PINNED at ${p.minWidth} (min-width === max-width). it cannot widen.`);
    }
    if (c.minWidth !== "0px" && c.minWidth === c.maxWidth) {
        out.push("", `this element is PINNED at ${c.minWidth}. sizing it will do nothing.`);
    }
    return out;
}

/** Everything painting at a point, whether or not a click can reach it.
 *
 *  A click reports one element: the topmost thing that accepts hit testing. An overlay
 *  with pointer-events:none, and every ::before and ::after, are invisible to it. This
 *  walks the whole document instead and keeps anything whose box contains the point and
 *  that actually paints - which is what finds a gradient nobody can click on. */
const PAINTS = ["background-image", "mask-image", "-webkit-mask-image", "backdrop-filter", "filter", "box-shadow"];

function paintsOf(el: Element, pseudo: string | null): string[] {
    const cs = getComputedStyle(el as HTMLElement, pseudo);
    if (pseudo && cs.content === "none") return [];

    const found: string[] = [];
    for (const prop of PAINTS) {
        const value = cs.getPropertyValue(prop);
        if (value && value !== "none") found.push(`${prop}: ${value.slice(0, 90)}`);
    }
    const bg = cs.backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") found.push(`background-color: ${bg}`);
    if (cs.opacity && cs.opacity !== "1") found.push(`opacity: ${cs.opacity}`);
    return found;
}

export function covering(x: number, y: number): string[] {
    const out: string[] = [`everything painting at ${x.toFixed(0)}, ${y.toFixed(0)}`, ""];
    let scanned = 0;

    for (const el of Array.from(document.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        scanned++;

        for (const pseudo of [null, "::before", "::after"]) {
            const paints = paintsOf(el, pseudo);
            if (!paints.length) continue;
            const cls = (typeof el.className === "string" ? el.className : "").slice(0, 44) || el.tagName.toLowerCase();
            out.push(`.${cls}${pseudo ?? ""}   ${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
            for (const p of paints) out.push(`    ${p}`);
        }
    }

    out.push("", `${scanned} boxes contain this point`);
    return out;
}

/** React puts its fibre on the DOM node under a hashed key. The props on the nearest
 *  named component are what a patch actually has to work with, which the box chain
 *  and the css rules never show. */
export function react(el: Element): string[] {
    let node: any = null;
    for (const key of Object.keys(el)) {
        if (key.startsWith("__reactFiber$")) { node = (el as any)[key]; break; }
    }
    if (!node) return ["no react fibre on this node. it is plain dom, or discord rendered it outside react."];

    const out: string[] = [];
    let depth = 0;

    for (; node && depth < 12; node = node.return, depth++) {
        const { type } = node;
        const name = typeof type === "string"
            ? type
            : type?.displayName || type?.name || (type ? "(anonymous)" : null);
        if (!name) continue;

        const props = node.memoizedProps;
        if (!props || typeof props !== "object") continue;

        const keys = Object.keys(props).filter(k => k !== "children");
        if (!keys.length) continue;

        out.push(`${"  ".repeat(Math.min(depth, 6))}<${name}>`);
        for (const key of keys.slice(0, 14)) {
            const value = props[key];
            const shown =
                typeof value === "function" ? "fn()" :
                typeof value === "string" ? JSON.stringify(value.slice(0, 60)) :
                typeof value === "object" && value !== null
                    ? (Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).slice(0, 6).join(",")}}`)
                    : String(value);
            out.push(`${"  ".repeat(Math.min(depth, 6))}   ${key.padEnd(18)} ${shown}`);
        }
        if (keys.length > 14) out.push(`${"  ".repeat(Math.min(depth, 6))}   ...${keys.length - 14} more`);
        out.push("");
    }

    return out.length ? out : ["a fibre is here but no component up the tree carries props worth showing."];
}

/** Discord class names are name_hash or name__hash and the hash changes on every
 *  build, so the only durable half is the part before it. keeping the trailing
 *  underscore matters: [class*="wrapper"] also matches wrapperInner, ["wrapper_"]
 *  does not. */
const stable = (cls: string) => {
    const cut = cls.match(/^(.+?_{1,2})[0-9a-f]{4,}$/i);
    return cut ? cut[1] : null;
};

function selectorFor(el: Element): string | null {
    const parts = [...el.classList].map(stable).filter(Boolean) as string[];
    if (!parts.length) return null;

    // one prefix is usually enough; a second only earns its place when the first
    // matches more than one thing on screen
    const first = `[class*="${parts[0]}"]`;
    if (document.querySelectorAll(first).length === 1 || parts.length === 1) return first;

    return parts.slice(0, 2).map(p => `[class*="${p}"]`).join("");
}

/** ready to paste selectors for the clicked element and the ancestors worth naming */
export function selectors(el: Element): string[] {
    const out: string[] = [];
    let depth = 0;

    for (let n: Element | null = el; n && n !== document.body && depth < 6; n = n.parentElement, depth++) {
        const sel = selectorFor(n);
        if (!sel) continue;

        const hits = document.querySelectorAll(sel).length;
        const label = depth === 0 ? "clicked" : `parent ${depth}`;
        out.push(`${label.padEnd(10)} ${sel}${" ".repeat(Math.max(1, 46 - sel.length))}matches ${hits}`);
    }

    if (!out.length) return ["nothing here carries a hashed class, so there is no stable hook"];

    const own = selectorFor(el);
    const parent = el.parentElement && selectorFor(el.parentElement);
    if (own && parent && document.querySelectorAll(own).length > 1) {
        out.push("", `narrowed    ${parent} ${own}${" ".repeat(2)}matches ${document.querySelectorAll(`${parent} ${own}`).length}`);
    }

    out.push("", "the trailing underscore is deliberate, dropping it also matches longer names");
    return out;
}

/** Discord themes are mostly variables, and there is nowhere in the client that shows
 *  you which ones actually reach a given element. this walks the stylesheets for every
 *  custom property declared on this element or anything above it, then asks the
 *  computed style what each one resolves to here. */
export function vars(el: Element): string[] {
    const names = new Set<string>();
    let blocked = 0;

    const chain: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);

    for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
            rules = sheet.cssRules;
        } catch {
            blocked++;
            continue;
        }

        for (const rule of Array.from(rules)) {
            const styleRule = rule as CSSStyleRule;
            const selector = styleRule.selectorText;
            if (!selector || !styleRule.style) continue;

            // :root and html reach everything, so they count without a match test
            const global = /^\s*(:root|html)\b/.test(selector);
            let reaches = global;

            if (!reaches) {
                for (const part of selector.split(",")) {
                    const sel = part.trim();
                    try {
                        if (chain.some(node => node.matches(sel))) { reaches = true; break; }
                    } catch { /* relative selectors the browser will not test standalone */ }
                }
            }
            if (!reaches) continue;

            for (let i = 0; i < styleRule.style.length; i++) {
                const prop = styleRule.style[i];
                if (prop.startsWith("--")) names.add(prop);
            }
        }
    }

    if (!names.size) {
        return ["nothing declares a custom property that reaches this element", ...(blocked ? [`${blocked} stylesheets could not be read`] : [])];
    }

    const cs = getComputedStyle(el as HTMLElement);
    const rows: string[] = [];
    const empty: string[] = [];

    for (const name of [...names].sort()) {
        const value = cs.getPropertyValue(name).trim();
        if (value) rows.push(`${name.padEnd(38)}${value}`);
        else empty.push(name);
    }

    const out = [`${rows.length} resolve here, out of ${names.size} that reach it`, ""];
    out.push(...rows);

    if (empty.length) {
        out.push("", `declared somewhere above but empty here: ${empty.slice(0, 12).join(", ")}${empty.length > 12 ? ` and ${empty.length - 12} more` : ""}`);
    }
    if (blocked) out.push("", `${blocked} stylesheets could not be read, so this may be short`);

    out.push("", "paste one into the css lens to try a different value without a rebuild");
    return out;
}

/** box and layout first, because that is what people are actually asking about when
 *  two things that should look the same do not */
const DIFF_FIRST = [
    "display", "position", "width", "height", "min-width", "min-height",
    "max-width", "max-height", "flex", "flex-grow", "flex-shrink", "flex-basis",
    "align-self", "order", "margin-top", "margin-bottom", "margin-left", "margin-right",
    "padding-top", "padding-bottom", "padding-left", "padding-right",
    "font-size", "font-weight", "line-height", "color", "background-color",
    "opacity", "transform", "overflow", "z-index"
];

const SKIP = /^(--|perspective-origin|transform-origin|-webkit-)/;

/** every class one has and the other does not, which is often the whole answer */
function classDiff(a: Element, b: Element) {
    const left = [...a.classList];
    const right = [...b.classList];
    return {
        onlyA: left.filter(c => !right.includes(c)),
        onlyB: right.filter(c => !left.includes(c))
    };
}

export function compare(a: Element, b: Element): string[] {
    const ca = getComputedStyle(a as HTMLElement);
    const cb = getComputedStyle(b as HTMLElement);

    const differing: [string, string, string][] = [];
    for (let i = 0; i < ca.length; i++) {
        const prop = ca[i];
        if (SKIP.test(prop)) continue;

        const va = ca.getPropertyValue(prop);
        const vb = cb.getPropertyValue(prop);
        if (va !== vb) differing.push([prop, va, vb]);
    }

    differing.sort((x, y) => {
        const ix = DIFF_FIRST.indexOf(x[0]);
        const iy = DIFF_FIRST.indexOf(y[0]);
        if (ix !== iy) return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy);
        return x[0].localeCompare(y[0]);
    });

    const { onlyA, onlyB } = classDiff(a, b);
    const out: string[] = [];

    out.push("first click   " + (describeShort(a) || "(no classes)"));
    out.push("second click  " + (describeShort(b) || "(no classes)"), "");

    if (onlyA.length || onlyB.length) {
        if (onlyA.length) out.push(`only on the first    ${onlyA.join(" ")}`);
        if (onlyB.length) out.push(`only on the second   ${onlyB.join(" ")}`);
        out.push("");
    }

    if (!differing.length) return [...out, "every computed property matches, so the difference is not in css"];

    out.push(`${differing.length} computed properties differ, box and layout first`, "");
    for (const [prop, va, vb] of differing.slice(0, 60)) {
        out.push(`${prop.padEnd(24)}${va.slice(0, 22).padEnd(24)}${vb.slice(0, 22)}`);
    }
    if (differing.length > 60) out.push("", `and ${differing.length - 60} more`);

    return out;
}

function describeShort(el: Element): string {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 2).join(" ") : "";
    return `${el.tagName.toLowerCase()}  ${cls}`.trim();
}

const channel = (v: number) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

function luminance(rgb: string): number | null {
    const parts = rgb.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return null;

    const [r, g, b] = parts.slice(0, 3).map(n => channel(Number(n) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** the first ancestor that actually paints something, since most elements are
 *  transparent and comparing text against transparent tells you nothing */
function paintedBehind(el: Element): string {
    for (let n: Element | null = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n as HTMLElement).backgroundColor;
        if (bg && !/rgba?\([^)]*,\s*0\)$/.test(bg) && bg !== "transparent") return bg;
    }
    return "rgb(0, 0, 0)";
}

export function contrast(el: Element): string[] {
    const cs = getComputedStyle(el as HTMLElement);
    const fg = cs.color;
    const bg = paintedBehind(el);

    const lf = luminance(fg);
    const lb = luminance(bg);
    if (lf == null || lb == null) return ["could not read a colour off this element"];

    const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;

    return [
        `text        ${fg}`,
        `behind it   ${bg}`,
        `ratio       ${ratio.toFixed(2)} to 1`,
        `needs       ${need} for ${large ? "large" : "normal"} text at ${size}px${bold ? " bold" : ""}`,
        "",
        ratio >= need
            ? `passes, with ${(ratio - need).toFixed(2)} to spare`
            : `FAILS by ${(need - ratio).toFixed(2)}. this is the white on white class of bug.`
    ];
}
