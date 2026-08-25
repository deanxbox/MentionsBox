/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type MentionFilter = "all" | "servers" | "direct" | "bots";
export type MentionSortOrder = "newest" | "oldest";

export interface ManageableMention {
    id: string;
    timestamp: number;
    guildId?: string | null;
    authorBot?: boolean;
    authorName: string;
    guildName?: string;
    channelName: string;
    content: string;
}

export function filterAndSortNotices<T extends ManageableMention>(
    notices: readonly T[],
    sortOrder: MentionSortOrder,
    filter: MentionFilter,
    query: string
): T[] {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

    const filtered = notices.filter(notice => {
        if (filter === "servers" && !notice.guildId) return false;
        if (filter === "direct" && notice.guildId) return false;
        if (filter === "bots" && !notice.authorBot) return false;

        if (!terms.length) return true;

        const haystack = [
            notice.authorName,
            notice.guildName ?? "",
            notice.channelName,
            notice.content
        ].join(" ").toLocaleLowerCase();

        return terms.every(term => haystack.includes(term));
    });

    if (sortOrder === "newest") return filtered;
    return filtered.reverse();
}

export function getNextNoticeId(noticeIds: readonly string[], handledId: string): string | null {
    const handledIndex = noticeIds.indexOf(handledId);
    if (handledIndex === -1 || noticeIds.length <= 1) return null;

    return noticeIds[handledIndex + 1] ?? noticeIds[handledIndex - 1] ?? null;
}
