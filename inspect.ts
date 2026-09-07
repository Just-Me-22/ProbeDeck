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
        if (hits.length > 1) out.push(`  beat    ${hits.length - 1} other rule${hits.length > 2 ? "s" : ""}`);

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
