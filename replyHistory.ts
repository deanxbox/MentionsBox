/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ReplyHistoryIdentity {
    sentMessageId?: string;
    sendPromise?: Promise<string>;
    sendFailed?: boolean;
}

export function shouldEditReply(entry: ReplyHistoryIdentity | undefined) {
    return Boolean(entry && (entry.sentMessageId || entry.sendPromise) && !(entry.sendFailed && !entry.sentMessageId));
}

export function replyMediaUnchanged(previousStickerIds: string[] = [], nextStickerIds: string[] = [], previousFiles: Array<{ name: string; type: string; size: number; lastModified: number; }> = [], nextFiles: Array<{ name: string; type: string; size: number; lastModified: number; }> = []) {
    const fileKey = (file: { name: string; type: string; size: number; lastModified: number; }) => `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    return previousStickerIds.join() === nextStickerIds.join()
        && previousFiles.map(fileKey).join("\n") === nextFiles.map(fileKey).join("\n");
}

export function pushReplyHistory<T>(history: T[], entry: T, limit = 100) {
    history.push(entry);
    if (history.length > limit) history.splice(0, history.length - limit);
}
