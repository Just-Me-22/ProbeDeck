/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Where a rounded box meets a square one and something shows through the gap.
 *
 *  Several theme bugs turned out to be the same bug wearing different clothes: a square
 *  child sitting in a rounded parent, so the child's corner cuts across the curve, or a
 *  child rounding a corner it does not share with its parent, so the curve bites into a
 *  flat edge and lets whatever is behind it through. Both leave a small wedge of the
 *  wrong colour at one corner. Easy to see, slow to find by clicking.
 *
 *  The number that matters is the parent's INNER curve, not the radius you wrote. A card
 *  with a 16px radius and a 3px border curves at 13px inside that border, and 13 is what
 *  a child has to match. Getting that wrong is what produced most of them. */

/** how far apart two corners can sit and still count as the same corner */
const TOUCH = 1.5;

/** a difference in radius smaller than this is not worth looking at */
const SLOP = 1;

/** boxes smaller than this are dividers and hairlines, not surfaces */
const TINY = 8;

interface Corner {
    name: string;
    radius: string;
    /** the two borders that inset this corner */
    borders: [string, string];
    at(r: DOMRect): [number, number];
    /** the two insets a positioned pseudo element sets to sit in this corner */
    insets: [string, string];
}

const CORNERS: Corner[] = [
    {
        name: "top left", radius: "border-top-left-radius",
        borders: ["border-top-width", "border-left-width"],
        at: r => [r.left, r.top], insets: ["top", "left"]
    },
    {
        name: "top right", radius: "border-top-right-radius",
        borders: ["border-top-width", "border-right-width"],
        at: r => [r.right, r.top], insets: ["top", "right"]
    },
    {
        name: "bottom right", radius: "border-bottom-right-radius",
        borders: ["border-bottom-width", "border-right-width"],
        at: r => [r.right, r.bottom], insets: ["bottom", "right"]
    },
    {
        name: "bottom left", radius: "border-bottom-left-radius",
        borders: ["border-bottom-width", "border-left-width"],
        at: r => [r.left, r.bottom], insets: ["bottom", "left"]
    }
];

function px(cs: CSSStyleDeclaration, prop: string): number {
    return parseFloat(cs.getPropertyValue(prop)) || 0;
}

/** radius in pixels. percentages resolve against the box, and an elliptical radius
 *  reports its horizontal half, which is the one that shows at a corner. */
function radius(cs: CSSStyleDeclaration, prop: string, w: number, h: number): number {
    const raw = cs.getPropertyValue(prop).trim();
    if (!raw) return 0;
    const first = raw.split(/\s+/)[0];
    if (first.endsWith("%")) return (parseFloat(first) / 100) * Math.min(w, h);
    return parseFloat(first) || 0;
}

function alphaOf(colour: string): number {
    const m = /rgba?\(([^)]+)\)/.exec(colour);
    if (!m) return colour === "transparent" ? 0 : 1;
    const parts = m[1].split(/[,/]/).map(s => parseFloat(s));
    return parts.length > 3 ? (isNaN(parts[3]) ? 1 : parts[3]) : 1;
}

/** does this box put ink on the screen at all */
function paints(cs: CSSStyleDeclaration): boolean {
    return alphaOf(cs.backgroundColor) > 0.02 || cs.backgroundImage !== "none";
}

/** the surface a notch would expose: the nearest ancestor that paints something */
function backdrop(el: Element): { el: Element; colour: string; } | null {
    for (let n = el.parentElement; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (paints(cs)) return { el: n, colour: cs.backgroundImage !== "none" ? "image" : cs.backgroundColor };
    }
    return null;
}

const HASHED = /_{1,2}[0-9a-z]{4,7}$/;

function nameOf(el: Element): string {
    const cls = typeof el.className === "string" ? el.className : "";
    const named = cls.split(/\s+/).filter(Boolean);
    const hashed = named.find(c => HASHED.test(c));
    return hashed ?? named[0] ?? el.tagName.toLowerCase();
}

interface Finding {
    kind: "spill" | "notch" | "mismatch";
    child: string;
    parent: string;
    corner: string;
    detail: string;
    /** whether the two surfaces differ enough for the wedge to be visible */
    visible: boolean;
}

/** the parent's curve where a child meets it, which is the radius minus the border
 *  it sits inside. this is the number children keep failing to match. */
function innerRadius(cs: CSSStyleDeclaration, c: Corner, w: number, h: number): number {
    const r = radius(cs, c.radius, w, h);
    if (!r) return 0;
    return Math.max(0, r - Math.max(px(cs, c.borders[0]), px(cs, c.borders[1])));
}

function compare(child: Element, parent: Element, out: Finding[]) {
    const cr = child.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    if (cr.width < TINY || cr.height < TINY) return;
    if (pr.width < TINY || pr.height < TINY) return;

    const ccs = getComputedStyle(child);
    const pcs = getComputedStyle(parent);
    if (!paints(ccs)) return;
    if (ccs.visibility === "hidden" || ccs.display === "none") return;

    // a parent that clips already forces its children to the curve, so nothing can
    // spill out of it and there is nothing to report
    const clipped = pcs.overflow !== "visible";

    const behind = backdrop(child);
    const differs = !behind || behind.colour === "image" || behind.colour !== ccs.backgroundColor;

    for (const c of CORNERS) {
        const [cx, cy] = c.at(cr);
        const [px_, py] = c.at(pr);
        const shares = Math.abs(cx - px_) <= TOUCH && Math.abs(cy - py) <= TOUCH;

        const kid = radius(ccs, c.radius, cr.width, cr.height);
        const dad = innerRadius(pcs, c, pr.width, pr.height);

        if (shares && dad > SLOP && kid < SLOP && !clipped) {
            out.push({
                kind: "spill", child: nameOf(child), parent: nameOf(parent), corner: c.name,
                detail: `square child in a ${dad.toFixed(0)}px curve`, visible: differs
            });
        } else if (shares && dad > SLOP && kid > SLOP && Math.abs(kid - dad) > SLOP) {
            out.push({
                kind: "mismatch", child: nameOf(child), parent: nameOf(parent), corner: c.name,
                detail: `child ${kid.toFixed(0)}px against the parent's ${dad.toFixed(0)}px inner curve`,
                visible: differs
            });
        } else if (!shares && kid > SLOP && dad < SLOP) {
            // the child curves where its parent's edge is straight, so the curve cuts a
            // wedge out of a flat run and whatever is behind shows through it
            const gap = Math.round(Math.hypot(cx - px_, cy - py));
            out.push({
                kind: "notch", child: nameOf(child), parent: nameOf(parent), corner: c.name,
                detail: `${kid.toFixed(0)}px curve ${gap}px inside a flat edge`, visible: differs
            });
        }
    }
}

/** A ::before pinned to the top of a card is how most drag strips and overlays are
 *  built, and it is the shape that goes wrong most often: the strip is a plain block, so
 *  its two top corners run straight past the card's curve. There is no box to measure for
 *  a pseudo element, but a positioned one that sets an inset to 0 is sitting in that
 *  corner, which is enough to compare radii. */
function comparePseudo(el: Element, which: "::before" | "::after", out: Finding[]) {
    const cs = getComputedStyle(el, which);
    if (!cs.content || cs.content === "none") return;
    if (cs.position !== "absolute" && cs.position !== "fixed") return;
    if (!paints(cs)) return;

    const r = el.getBoundingClientRect();
    if (r.width < TINY || r.height < TINY) return;

    const own = getComputedStyle(el);
    if (own.overflow !== "visible") return;

    for (const c of CORNERS) {
        const sits = c.insets.every(side => px(cs, side) === 0 && cs.getPropertyValue(side) !== "auto");
        if (!sits) continue;

        const kid = radius(cs, c.radius, r.width, r.height);
        const dad = innerRadius(own, c, r.width, r.height);
        if (dad > SLOP && kid < SLOP) {
            out.push({
                kind: "spill", child: `${nameOf(el)} ${which}`, parent: nameOf(el), corner: c.name,
                detail: `square strip in a ${dad.toFixed(0)}px curve`, visible: true
            });
        } else if (dad > SLOP && kid > SLOP && Math.abs(kid - dad) > SLOP) {
            out.push({
                kind: "mismatch", child: `${nameOf(el)} ${which}`, parent: nameOf(el), corner: c.name,
                detail: `strip ${kid.toFixed(0)}px against the card's ${dad.toFixed(0)}px inner curve`,
                visible: true
            });
        }
    }
}

const HEADINGS: Record<Finding["kind"], string> = {
    spill: "SQUARE CORNER IN A ROUNDED PARENT   the child's corner crosses the curve",
    notch: "CURVE ON A FLAT EDGE   the child rounds where its parent does not, so the surface behind shows through",
    mismatch: "TWO DIFFERENT CURVES AT ONE CORNER   they share the corner but not the radius"
};

export function cornerLines(query: string): string[] {
    const scope = query.trim();
    let roots: Element[];
    try {
        roots = scope ? Array.from(document.querySelectorAll(scope)) : [document.body];
    } catch {
        return [`${scope} is not a selector css understands`];
    }
    if (!roots.length) return [`nothing on screen matches ${scope}`];

    const seen = new Set<Element>();
    const found: Finding[] = [];
    let examined = 0;

    for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll("*"))) {
            if (seen.has(el)) continue;
            seen.add(el);
            if (el.closest("#probe-deck")) continue;
            const parent = el.parentElement;
            if (!parent) continue;
            examined++;
            compare(el, parent, found);
            comparePseudo(el, "::before", found);
            comparePseudo(el, "::after", found);
        }
    }

    const shown = found.filter(f => f.visible);
    const hidden = found.length - shown.length;

    const out = [
        `${examined} boxes checked${scope ? ` under ${scope}` : ""}, ${shown.length} corners worth a look`,
        "",
        "a parent's curve where a child meets it is its radius minus its border, so a card",
        "at 16px with a 3px border curves at 13px inside. that is the number listed here.",
        ""
    ];

    for (const kind of ["notch", "spill", "mismatch"] as const) {
        const group = shown.filter(f => f.kind === kind);
        if (!group.length) continue;
        out.push(`${HEADINGS[kind]}   (${group.length})`, "");
        for (const f of group) {
            out.push(`  ${f.child}`);
            out.push(`      ${f.corner.padEnd(13)}${f.detail}`);
            out.push(`      inside  ${f.parent}`);
        }
        out.push("");
    }

    if (!shown.length) out.push("  every corner here agrees with the one behind it", "");
    if (hidden) out.push(`${hidden} more where the child and the surface behind it are the same colour, so the wedge would not show`);

    return out;
}
