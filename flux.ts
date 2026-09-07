/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher } from "@webpack/common";

const LIMIT = 400;
const SHAPE_CAP = 260;

interface Seen {
    at: number;
    type: string;
    keys: string;
    shape: string;
}

const events: Seen[] = [];
const counts = new Map<string, number>();
let tapping = false;

/** the payload matters far more than the fact an event fired, but printing a whole
 *  message object is useless. this keeps the key names and a short sample of each. */
function shapeOf(action: Record<string, any>): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(action)) {
        if (key === "type") continue;

        let sample: string;
        if (value == null) sample = String(value);
        else if (Array.isArray(value)) sample = `[${value.length}]`;
        else if (typeof value === "object") sample = `{${Object.keys(value).slice(0, 6).join(",")}}`;
        else sample = String(value).slice(0, 40);

        parts.push(`${key}=${sample}`);
    }

    const line = parts.join("  ");
    return line.length > SHAPE_CAP ? `${line.slice(0, SHAPE_CAP)} ...` : line;
}

function intercept(action: Record<string, any>) {
    const type = String(action?.type ?? "?");
    counts.set(type, (counts.get(type) ?? 0) + 1);

    events.push({
        at: Date.now(),
        type,
        keys: Object.keys(action).filter(k => k !== "type").join(", "),
        shape: shapeOf(action)
    });
    if (events.length > LIMIT) events.splice(0, events.length - LIMIT);

    // an interceptor that returns true cancels the action, so never return anything
    return false;
}

export function startFluxTap() {
    if (tapping) return;
    tapping = true;
    FluxDispatcher.addInterceptor(intercept);
}

/** Discord has no way to remove an interceptor, so the flag is what stops the work */
export function stopFluxTap() {
    tapping = false;
    events.length = 0;
    counts.clear();
}

export function fluxLines(query: string): string[] {
    if (!tapping) return ["the tap is not running"];

    const wanted = query.trim().toUpperCase();

    if (!wanted) {
        const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40);
        return [
            `${counts.size} kinds of event seen, ${events.length} held`,
            "",
            "type part of a name to see the payloads for it. this is the fastest way",
            "to find which event to subscribe to, and what its fields are called.",
            "",
            "most seen first:",
            "",
            ...ranked.map(([type, n]) => `${String(n).padStart(6)}  ${type}`)
        ];
    }

    const shown = events.filter(e => e.type.includes(wanted)).slice(-40).reverse();
    if (!shown.length) return [`nothing matching ${wanted} has fired since the tap started`];

    const out = [`${shown.length} most recent of ${counts.get(wanted) ?? "some"} matching ${wanted}`, ""];

    for (const event of shown) {
        out.push(`${new Date(event.at).toLocaleTimeString()}  ${event.type}`);
        if (event.keys) out.push(`        keys  ${event.keys}`);
        if (event.shape) out.push(`        ${event.shape}`);
        out.push("");
    }

    return out;
}
