/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const LIMIT = 200;
const BODY_CAP = 600;

interface Call {
    at: number;
    method: string;
    url: string;
    body?: string;
    status?: number;
    ms?: number;
}

const calls: Call[] = [];
let tapping = false;

const trim = (text: string) => text.length > BODY_CAP ? `${text.slice(0, BODY_CAP)} ... (${text.length} chars)` : text;

/** only Discord's own api, so cdn images and media do not drown the useful lines */
const interesting = (url: string) => url.includes("/api/v");

const shorten = (url: string) => {
    const cut = url.indexOf("/api/v");
    return cut < 0 ? url : url.slice(url.indexOf("/", cut + 6));
};

function push(call: Call) {
    calls.push(call);
    if (calls.length > LIMIT) calls.splice(0, calls.length - LIMIT);
}

type Tapped = XMLHttpRequest & { __pdCall?: Call; };

const realOpen = XMLHttpRequest.prototype.open;
const realSend = XMLHttpRequest.prototype.send;
const realFetch = window.fetch;

export function startTap() {
    if (tapping) return;
    tapping = true;

    XMLHttpRequest.prototype.open = function (this: Tapped, method: string, url: string, ...rest: any[]) {
        if (typeof url === "string" && interesting(url)) {
            this.__pdCall = { at: Date.now(), method: String(method).toUpperCase(), url: shorten(url) };
        }
        return (realOpen as any).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.send = function (this: Tapped, body?: any) {
        const call = this.__pdCall;
        if (call) {
            if (typeof body === "string") call.body = trim(body);
            const started = performance.now();

            this.addEventListener("loadend", () => {
                call.status = this.status;
                call.ms = Math.round(performance.now() - started);
            }, { once: true });

            push(call);
        }
        return realSend.call(this, body);
    };

    window.fetch = function (input: any, init?: any) {
        const url = typeof input === "string" ? input : input?.url;
        if (typeof url === "string" && interesting(url)) {
            const call: Call = {
                at: Date.now(),
                method: String(init?.method ?? "GET").toUpperCase(),
                url: shorten(url)
            };
            if (typeof init?.body === "string") call.body = trim(init.body);
            push(call);

            const started = performance.now();
            return realFetch.call(window, input, init).then(res => {
                call.status = res.status;
                call.ms = Math.round(performance.now() - started);
                return res;
            });
        }
        return realFetch.call(window, input, init);
    } as typeof window.fetch;
}

export function stopTap() {
    if (!tapping) return;
    tapping = false;

    XMLHttpRequest.prototype.open = realOpen;
    XMLHttpRequest.prototype.send = realSend;
    window.fetch = realFetch;
    calls.length = 0;
}

export function restLines(filter: string): string[] {
    if (!tapping) return ["the tap is not running, so there is nothing to show"];

    const wanted = filter.trim().toLowerCase();
    const shown = (wanted ? calls.filter(c => `${c.method} ${c.url}`.toLowerCase().includes(wanted)) : calls)
        .slice()
        .reverse();

    const head = [
        `${calls.length} requests held, newest first. type to filter by method or path.`,
        "this is what Discord's own client sends, which is the fastest way to find",
        "the endpoint and body shape for something you want a plugin to do.",
        "",
        "bodies can contain what you typed, so read before pasting a copy anywhere.",
        "=".repeat(74),
        ""
    ];

    if (!shown.length) return [...head, wanted ? "nothing matches that" : "nothing captured yet, go and click something"];

    const out = [...head];
    for (const call of shown.slice(0, 60)) {
        const when = new Date(call.at).toLocaleTimeString();
        const done = call.status == null ? "pending" : `${call.status} in ${call.ms}ms`;
        out.push(`${when}  ${call.method.padEnd(6)} ${call.url}`, `        ${done}`);
        if (call.body) out.push(`        body ${call.body}`);
        out.push("");
    }

    return out;
}
