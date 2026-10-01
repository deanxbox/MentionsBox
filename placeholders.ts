/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ReplyPlaceholderDefinition {
    key: string;
    label: string;
    description: string;
}

export interface ReplyPlaceholderSuggestion extends ReplyPlaceholderDefinition {
    token: string;
    resolvedValue: string;
    value: string;
}

export interface ReplyPlaceholderMatch {
    query: string;
    startIndex: number;
    endIndex: number;
}

export const REPLY_PLACEHOLDERS: ReplyPlaceholderDefinition[] = [
    { key: "author.name", label: "Author name", description: "Best available name for the person who mentioned you" },
    { key: "author.nickname", label: "Author nickname", description: "Their server/DM nickname when Discord provides one" },
    { key: "author.servernickname", label: "Server nickname", description: "Their nickname in this server when available" },
    { key: "author.displayname", label: "Author display name", description: "Their profile display name" },
    { key: "author.username", label: "Author username", description: "Their Discord username" },
    { key: "author.id", label: "Author ID", description: "Their Discord user ID" },
    { key: "message.content", label: "Message content", description: "The text from the mention" },
    { key: "message.link", label: "Message link", description: "A direct jump link to the mention" },
    { key: "message.id", label: "Message ID", description: "The Discord message ID" },
    { key: "channel.name", label: "Channel name", description: "The channel or DM name" },
    { key: "channel.id", label: "Channel ID", description: "The Discord channel ID" },
    { key: "server.name", label: "Server name", description: "The server name, or Direct Messages" },
    { key: "reply.content", label: "Replied content", description: "The message this mention replied to, when available" },
    { key: "reply.author.name", label: "Replied author", description: "The author of the replied-to message, when available" },
    { key: "me.name", label: "Your name", description: "Your best available name" },
    { key: "me.nickname", label: "Your nickname", description: "Your nickname when Discord provides one" },
    { key: "me.servernickname", label: "Your server nickname", description: "Your nickname in this server when available" },
    { key: "me.displayname", label: "Your display name", description: "Your profile display name" },
    { key: "me.username", label: "Your username", description: "Your Discord username" },
    { key: "me.id", label: "Your ID", description: "Your Discord user ID" }
];

export const PLACEHOLDER_HELP = REPLY_PLACEHOLDERS.map(placeholder => `{${placeholder.key}}`);
const PLACEHOLDERS_BY_KEY = new Map(REPLY_PLACEHOLDERS.map(placeholder => [placeholder.key, placeholder]));

function formatPlaceholderPreview(value: string) {
    const preview = value.replace(/\s+/g, " ").trim();
    if (!preview) return "(empty)";
    return preview.length > 72 ? `${preview.slice(0, 72)}…` : preview;
}

export function getReplyPlaceholderMatch(content: string, cursorPos: number): ReplyPlaceholderMatch | null {
    const text = content.slice(0, cursorPos);
    const openMatch = text.match(/\{([a-z0-9_.-]*)$/i);
    if (openMatch) {
        return {
            query: openMatch[1],
            startIndex: text.length - openMatch[0].length,
            endIndex: cursorPos
        };
    }

    if (text.endsWith("{}")) {
        return {
            query: "",
            startIndex: text.length - 2,
            endIndex: cursorPos
        };
    }

    return null;
}

export function getReplyPlaceholderSuggestions(replacements: Record<string, string>, query: string, orderedKeys?: string[]): ReplyPlaceholderSuggestion[] {
    const normalizedQuery = query.trim().toLowerCase();
    const placeholders = orderedKeys
        ? orderedKeys.map(key => PLACEHOLDERS_BY_KEY.get(key)).filter(Boolean) as ReplyPlaceholderDefinition[]
        : REPLY_PLACEHOLDERS;

    return placeholders
        .map(placeholder => {
            const resolvedValue = replacements[placeholder.key] ?? "";

            return {
                ...placeholder,
                token: `{${placeholder.key}}`,
                resolvedValue,
                value: formatPlaceholderPreview(resolvedValue)
            };
        })
        .filter(placeholder => !normalizedQuery
            || placeholder.key.includes(normalizedQuery)
            || placeholder.label.toLowerCase().includes(normalizedQuery)
            || placeholder.description.toLowerCase().includes(normalizedQuery)
            || placeholder.value.toLowerCase().includes(normalizedQuery)
        )
        .slice(0, 8);
}

export function resolveReplyPlaceholders(content: string, replacements: Record<string, string>) {
    return content.replace(/\{([^}]+)\}/g, (match, key: string) => replacements[key] ?? match);
}

export function usesMessageContentPlaceholder(content: string) {
    return content.includes("{message.content}");
}

export function getReplyStickerId(content: string, selectedStickerId?: string | null, originalStickerId?: string | null) {
    return usesMessageContentPlaceholder(content) && originalStickerId ? originalStickerId : selectedStickerId;
}

export function getNativeFavoriteStickerIds(frecency: unknown): string[] {
    if (!frecency || typeof frecency !== "object") return [];
    const ids = (frecency as { stickerIds?: unknown }).stickerIds;
    return Array.isArray(ids) ? ids.map(String) : [];
}
