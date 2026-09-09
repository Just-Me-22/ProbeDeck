/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** the default buffer is 250 entries and boot fills it with scripts, so images that
 *  arrive later never make it in. raised once, at start. */
export function widenTimingBuffer() {
    performance.setResourceTimingBufferSize?.(1500);
}

type Entry = PerformanceResourceTiming;

const MEDIA_TYPES = new Set(["img", "image", "video", "audio", "imageset", "input"]);
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|apng|webm|mp4|mov|svg)(\?|$)/i;

const isMedia = (entry: Entry) =>
    MEDIA_TYPES.has(entry.initiatorType) || MEDIA_EXT.test(entry.name);

/** cross origin replies without Timing-Allow-Origin hide every stage and every size,
 *  leaving only how long the whole thing took */
const opaque = (entry: Entry) => entry.responseStart === 0 && entry.requestStart === 0;

const host = (url: string) => {
    try {
        return new URL(url).host;
    } catch {
        return "?";
    }
};

const kind = (url: string) => {
    if (/\/avatar-decoration-presets\/|\/avatar-decorations\//.test(url)) return "decoration";
    if (/\/banners\//.test(url)) return "banner";
    if (/\/avatars\//.test(url)) return "avatar";
    if (/\/icons\//.test(url)) return "server icon";
    if (/\/profile-effects\//.test(url)) return "effect";
    if (/nameplate/i.test(url)) return "nameplate";
    if (/\/emojis\//.test(url)) return "emoji";
    if (/\/attachments\//.test(url)) return "attachment";
    return "other";
};

const ms = (value: number) => `${value.toFixed(0)}ms`;

const bytes = (value: number) =>
    value >= 1048576 ? `${(value / 1048576).toFixed(1)}MB`
        : value >= 1024 ? `${Math.round(value / 1024)}KB`
            : `${value}B`;

function quantile(sorted: number[], at: number) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))];
}

function column(rows: [string, number, number][], title: string, total: number) {
    const out = [title, "-".repeat(74)];

    for (const [name, count, sum] of rows.sort((a, b) => b[2] - a[2])) {
        const share = total ? Math.round(sum / total * 100) : 0;
        out.push(`  ${name.padEnd(22)} ${String(count).padStart(4)}  ${bytes(sum).padStart(8)}  ${String(share).padStart(3)}%`);
    }

    return out;
}

function group(entries: Entry[], of: (url: string) => string): [string, number, number][] {
    const seen = new Map<string, [number, number]>();

    for (const entry of entries) {
        const key = of(entry.name);
        const [count, sum] = seen.get(key) ?? [0, 0];
        seen.set(key, [count + 1, sum + entry.encodedBodySize]);
    }

    return [...seen].map(([name, [count, sum]]) => [name, count, sum]);
}

export function mediaLines(filter: string): string[] {
    const all = performance.getEntriesByType("resource") as Entry[];
    const wanted = filter.trim().toLowerCase();

    const media = all
        .filter(isMedia)
        .filter(entry => !wanted || entry.name.toLowerCase().includes(wanted));

    if (!media.length) {
        return [
            "nothing yet",
            "",
            "reload, let the client settle, then come back. the buffer holds 1500",
            "requests and boot alone uses a few hundred of them."
        ];
    }

    const readable = media.filter(entry => !opaque(entry));
    const hidden = media.length - readable.length;

    const durations = media.map(entry => entry.duration).sort((a, b) => a - b);
    const transferred = readable.reduce((sum, entry) => sum + entry.transferSize, 0);
    const decoded = readable.reduce((sum, entry) => sum + entry.decodedBodySize, 0);

    // a served-from-disk reply carries a body but crosses no wire
    const cached = readable.filter(entry => entry.transferSize === 0 && entry.decodedBodySize > 0).length;
    const fresh = readable.length - cached;

    const stalls = readable.map(entry => entry.requestStart - entry.startTime).sort((a, b) => a - b);
    const waits = readable.map(entry => entry.responseStart - entry.requestStart).sort((a, b) => a - b);
    const reads = readable.map(entry => entry.responseEnd - entry.responseStart).sort((a, b) => a - b);

    const protocols = new Set(readable.map(entry => entry.nextHopProtocol).filter(Boolean));

    const out = [
        `${media.length} media requests since the last reload${wanted ? `, filtered by "${wanted}"` : ""}`,
        "",
        `slowest 5%       ${ms(quantile(durations, 0.95))}`,
        `middle one       ${ms(quantile(durations, 0.5))}`,
        `worst            ${ms(durations[durations.length - 1])}`,
        ""
    ];

    if (!readable.length) {
        out.push(
            "every one of these is cross origin without Timing-Allow-Origin, so only",
            "the total time is readable. no stage breakdown and no sizes.",
            ""
        );
    } else {
        out.push(
            `off the disk      ${cached} of ${readable.length}${hidden ? ` (${hidden} more unreadable)` : ""}`,
            `off the wire      ${fresh}, ${bytes(transferred)} transferred for ${bytes(decoded)} of content`,
            `protocol          ${[...protocols].join(", ") || "?"}`,
            "",
            "where the middle request spent its time",
            `  queued          ${ms(quantile(stalls, 0.5))}     waiting for a connection or a slot`,
            `  server          ${ms(quantile(waits, 0.5))}     asked, waiting for the first byte`,
            `  download        ${ms(quantile(reads, 0.5))}     first byte to last`,
            "",
            "and for the slowest 5%",
            `  queued          ${ms(quantile(stalls, 0.95))}`,
            `  server          ${ms(quantile(waits, 0.95))}`,
            `  download        ${ms(quantile(reads, 0.95))}`,
            ""
        );
    }

    out.push(
        ...column(group(media, kind), "by kind                 count     bytes  share", decoded || 1),
        "",
        ...column(group(media, host), "by host                 count     bytes  share", decoded || 1),
        "",
        "slowest 12",
        "-".repeat(74)
    );

    for (const entry of [...media].sort((a, b) => b.duration - a.duration).slice(0, 12)) {
        const name = entry.name.replace(/^https?:\/\//, "").slice(0, 66);
        const stage = opaque(entry)
            ? "no breakdown"
            : `queued ${ms(entry.requestStart - entry.startTime)}, server ${ms(entry.responseStart - entry.requestStart)}, download ${ms(entry.responseEnd - entry.responseStart)}`;

        out.push(
            `  ${ms(entry.duration).padStart(8)}  ${bytes(entry.encodedBodySize).padStart(7)}  ${name}`,
            `            ${stage}`
        );
    }

    out.push(
        "",
        "reading this: high queued means the client is the bottleneck, too many",
        "requests at once. high server means the network or Discord's cdn. a low",
        "off-the-disk count on a second reload of the same screen means nothing",
        "is being cached, so everything is fetched again every time."
    );

    return out;
}
