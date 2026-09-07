/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Which class prefixes name more than one Discord module on the current screen.
 *
 *  This deliberately reads the DOM rather than the theme. Vencord loads a local theme
 *  through @import from a custom protocol, so CSSImportRule.styleSheet comes back null
 *  and the theme's rules cannot be reached through CSSOM at all - only QuickCSS can.
 *  Checking a prefix list against this output offline is the way round that. */

const HASHED = /_{1,2}[0-9a-z]{4,7}$/;

/** the first few ancestors by name, which is what says whether two modules sharing a
 *  prefix are in the same part of the app or somewhere completely unrelated */
function pathOf(el: Element): string {
    const hops: string[] = [];
    for (let n = el.parentElement; n && hops.length < 4; n = n.parentElement) {
        const cls = typeof n.className === "string" ? n.className : "";
        const named = cls.split(/\s+/).find(c => HASHED.test(c));
        if (named) hops.push(named);
    }
    return hops.join(" < ") || "(no named ancestor)";
}

export function audit(): string[] {
    const byBase = new Map<string, Map<string, number>>();
    const where = new Map<string, string>();
    let elements = 0;

    for (const el of Array.from(document.querySelectorAll("*"))) {
        const cls = typeof el.className === "string" ? el.className : "";
        if (!cls) continue;
        elements++;
        for (const name of cls.split(/\s+/)) {
            if (!name || !HASHED.test(name)) continue;
            const base = name.replace(HASHED, "");
            const seen = byBase.get(base) ?? new Map<string, number>();
            seen.set(name, (seen.get(name) ?? 0) + 1);
            byBase.set(base, seen);
            if (!where.has(name)) where.set(name, pathOf(el));
        }
    }

    // two hashed names under one prefix are only a real collision if they sit on
    // DIFFERENT elements. one element wearing both - a module class plus a variant
    // class - looks identical by name and is harmless, so the element count decides.
    const spread = (base: string) => {
        try { return document.querySelectorAll(`[class*="${base}"]`).length; } catch { return 0; }
    };

    const ambiguous = [...byBase]
        .filter(([base, names]) => names.size > 1 && spread(base) > 1)
        .sort((a, b) => b[1].size - a[1].size);

    const out = [
        `${elements} classed elements, ${byBase.size} distinct prefixes on this screen`,
        "",
        "a prefix listed here names more than one module right now, so a bare",
        "[class*=\"prefix\"] rule hits all of them. this is one screen only - open",
        "another view and press ctrl+alt+r to re-run.",
        "",
        `AMBIGUOUS PREFIXES   (${ambiguous.length})`,
        ""
    ];

    for (const [base, names] of ambiguous) {
        const list = [...names].sort((a, b) => b[1] - a[1]);
        const els = spread(base);
        const sum = [...names.values()].reduce((a, b) => a + b, 0);
        const verdict = els < sum ? "SHARED ELEMENTS - likely one component" : "separate elements";
        out.push(`${base}   ${names.size} names over ${els} elements   ${verdict}`);
        for (const [name, n] of list) {
            out.push(`    ${name.padEnd(36)} x${n}`);
            out.push(`      in  ${where.get(name) ?? "?"}`);
        }
        out.push("");
    }
    if (!ambiguous.length) out.push("  none on this screen", "");

    return out;
}

/** Which of the theme's own panels overlap each other.
 *
 *  Discord positions several of these boxes so they intentionally overlap by a few
 *  pixels, and whichever paints last wins. That is invisible until something changes
 *  paint order, so it is worth being able to list them on demand. */
/** how wide a space between two panels still counts as a seam worth reporting */
const SEAM = 12;

const PANELS = [
    ["guild rail", '[class*="guilds_"]'],
    ["channel column", '[class*="sidebarList"]'],
    ["dm list", '[class*="privateChannels_"]'],
    ["chat", '[class*="page__"] > * > [class*="chat_"]'],
    ["title bar", '[class*="base__"] > [class*="bar_"]'],
    ["member column", '[class*="membersWrap_"]'],
    ["user panel", 'section[class*="panels_"]'],
    ["thread", '[class*="chatLayerWrapper_"]']
];

export function overlaps(): string[] {
    const found = PANELS.map(([name, sel]) => ({ name, el: document.querySelector(sel) }));
    const boxes = found
        .filter(f => f.el)
        .map(f => ({ name: f.name, r: f.el!.getBoundingClientRect() }));

    const out = [`${boxes.length} of ${PANELS.length} panels on screen`, ""];
    for (const { name, el } of found) {
        out.push(`  ${name.padEnd(16)}${el ? "in the dom" : "NOT IN THE DOM"}`);
    }
    out.push("");

    let pairs = 0;
    const seams: string[] = [];

    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
            const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);

            if (x >= 1 && y >= 1) {
                pairs++;
                out.push(`${a.name} x ${b.name}`);
                out.push(`   ${x.toFixed(0)}px wide by ${y.toFixed(0)}px tall`);
                continue;
            }

            // side by side or stacked, and close enough that the space between them is
            // a seam rather than two unrelated panels. a hairline here is what reads
            // as the theme failing to join up.
            if (y >= 1 && x < 0 && x > -SEAM) seams.push(`${a.name} | ${b.name}   ${(-x).toFixed(1)}px apart, side by side`);
            if (x >= 1 && y < 0 && y > -SEAM) seams.push(`${a.name} | ${b.name}   ${(-y).toFixed(1)}px apart, stacked`);
        }
    }
    if (!pairs) out.push("no panel overlaps another");

    out.push("", `SEAMS UNDER ${SEAM}px`, "");
    out.push(...(seams.length ? seams : ["  every panel meets its neighbour flush"]));

    return out;
}
