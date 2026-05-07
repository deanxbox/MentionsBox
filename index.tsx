/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { type PluginAuthor } from "@utils/types";
import type { MessageJSON } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import {
    ChannelStore,
    createRoot,
    NavigationRouter,
    RelationshipStore,
    SelectedChannelStore,
    useCallback,
    useEffect,
    useMemo,
    UserStore,
    useState,
    useStateFromStores
} from "@webpack/common";

interface MessageCreatePayload {
    channelId: string;
    guildId?: string;
    message: MessageJSON;
}

interface MentionNotice {
    id: string;
    channelId: string;
    guildId: string | null;
    authorId: string;
    authorName: string;
    avatarUrl?: string;
    channelName: string;
    content: string;
    timestamp: number;
}

const Dean: PluginAuthor = {
    name: ".dean",
    id: 285021062578700289n
};

const ROOT_ID = "vc-mentions-box-root";
const MAX_VISIBLE_NOTICES = 5;
const MAX_QUEUED_NOTICES = 50;
const NOTICE_TTL = 1000 * 60 * 10;

let root: ReturnType<typeof createRoot> | null = null;
let notices: MentionNotice[] = [];
let pruneInterval: ReturnType<typeof setInterval> | null = null;

const listeners = new Set<() => void>();

function emitChange() {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot() {
    return notices;
}

function setNotices(nextNotices: MentionNotice[]) {
    notices = nextNotices;
    emitChange();
}

function removeNotice(id: string) {
    setNotices(notices.filter(notice => notice.id !== id));
}

function clearExpiredNotices() {
    const cutoff = Date.now() - NOTICE_TTL;
    const nextNotices = notices.filter(notice => notice.timestamp >= cutoff);

    if (nextNotices.length !== notices.length) setNotices(nextNotices);
}

function addNotice(notice: MentionNotice) {
    setNotices([
        notice,
        ...notices.filter(existing => existing.id !== notice.id)
    ].slice(0, MAX_QUEUED_NOTICES));
}

function getAuthorName(message: MessageJSON) {
    const { author } = message;

    return RelationshipStore.getNickname(author.id)
        ?? author.globalName
        ?? author.username
        ?? "Unknown User";
}

function getChannelName(channel: any) {
    if (channel.type === ChannelType.DM) {
        const recipientId = channel.getRecipientId?.() ?? channel.recipients?.[0];
        const recipient = recipientId ? UserStore.getUser(recipientId) : null;

        return recipient
            ? RelationshipStore.getNickname(recipient.id) ?? recipient.globalName ?? recipient.username
            : "Direct Message";
    }

    if (channel.type === ChannelType.GROUP_DM) return channel.name || "Group DM";

    return channel.name ? `#${channel.name}` : "Channel";
}

function formatContent(message: MessageJSON) {
    let content = message.content?.trim() || "Mentioned you";

    for (const user of message.mentions ?? []) {
        const displayName = RelationshipStore.getNickname(user.id) ?? user.globalName ?? user.username;
        content = content.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${displayName}`);
    }

    return content.length > 140 ? `${content.slice(0, 137)}...` : content;
}

function isRelevantMention(message: MessageJSON) {
    const currentUser = UserStore.getCurrentUser();

    if (!currentUser || !message.author || message.author.id === currentUser.id) return false;
    return message.mentions?.some(user => user.id === currentUser.id) ?? false;
}

function useNotices() {
    const [currentNotices, setCurrentNotices] = useState(getSnapshot);

    useEffect(() => subscribe(() => setCurrentNotices([...getSnapshot()])), []);

    return currentNotices;
}

function MentionCard({ notice }: { notice: MentionNotice; }) {
    const jumpToMention = useCallback(() => {
        removeNotice(notice.id);
        NavigationRouter.transitionTo(`/channels/${notice.guildId ?? "@me"}/${notice.channelId}/${notice.id}`);
    }, [notice]);

    const dismissNotice = useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        removeNotice(notice.id);
    }, [notice.id]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;

        event.preventDefault();
        jumpToMention();
    }, [jumpToMention]);

    return (
        <div
            className="vc-mentions-box-card"
            onClick={jumpToMention}
            onKeyDown={handleKeyDown}
            role="button"
            tabIndex={0}
        >
            <div className="vc-mentions-box-accent" />
            {notice.avatarUrl ? (
                <img className="vc-mentions-box-avatar" src={notice.avatarUrl} alt="" />
            ) : (
                <div className="vc-mentions-box-avatar vc-mentions-box-avatar-fallback">
                    {notice.authorName.slice(0, 1).toUpperCase()}
                </div>
            )}
            <div className="vc-mentions-box-copy">
                <div className="vc-mentions-box-meta">
                    <span className="vc-mentions-box-author">{notice.authorName}</span>
                    <span className="vc-mentions-box-channel">{notice.channelName}</span>
                </div>
                <div className="vc-mentions-box-content">{notice.content}</div>
            </div>
            <span className="vc-mentions-box-jump">Jump</span>
            <button className="vc-mentions-box-dismiss" onClick={dismissNotice} aria-label="Dismiss mention">
                x
            </button>
        </div>
    );
}

function MentionsBox() {
    const currentChannelId = useStateFromStores(
        [SelectedChannelStore],
        () => SelectedChannelStore.getChannelId(),
        []
    );
    const currentNotices = useNotices();
    const visibleNotices = useMemo(
        () => currentChannelId ? currentNotices.slice(0, MAX_VISIBLE_NOTICES) : [],
        [currentChannelId, currentNotices]
    );
    const queuedCount = currentChannelId
        ? Math.max(currentNotices.length - MAX_VISIBLE_NOTICES, 0)
        : 0;

    if (!visibleNotices.length) return null;

    return (
        <div className="vc-mentions-box" role="region" aria-label="Recent mentions">
            {visibleNotices.map(notice => (
                <MentionCard key={notice.id} notice={notice} />
            ))}
            {queuedCount > 0 && (
                <div className="vc-mentions-box-queued">
                    {queuedCount} more mention{queuedCount === 1 ? "" : "s"} queued
                </div>
            )}
        </div>
    );
}

function mountRoot() {
    unmountRoot();

    const container = document.createElement("div");
    container.id = ROOT_ID;
    document.body.append(container);

    root = createRoot(container);
    root.render(
        <ErrorBoundary noop>
            <MentionsBox />
        </ErrorBoundary>
    );
}

function unmountRoot() {
    root?.unmount();
    root = null;
    document.getElementById(ROOT_ID)?.remove();
}

export default definePlugin({
    name: "MentionsBox",
    description: "Shows clickable top-screen cards for recent mentions and jumps to the message when clicked.",
    tags: ["Chat", "Notifications"],
    authors: [Dean],

    start() {
        mountRoot();
        pruneInterval = setInterval(clearExpiredNotices, 30_000);
    },

    stop() {
        if (pruneInterval) clearInterval(pruneInterval);
        pruneInterval = null;
        setNotices([]);
        unmountRoot();
    },

    flux: {
        MESSAGE_CREATE({ message, channelId, guildId }: MessageCreatePayload) {
            if (!message?.id || message.state === "SENDING" || !isRelevantMention(message)) return;

            const resolvedChannelId = message.channel_id ?? channelId;
            const channel = ChannelStore.getChannel(resolvedChannelId);
            const author = UserStore.getUser(message.author.id);
            if (!channel) return;

            addNotice({
                id: message.id,
                channelId: resolvedChannelId,
                guildId: channel.guild_id ?? guildId ?? null,
                authorId: message.author.id,
                authorName: getAuthorName(message),
                avatarUrl: author?.getAvatarURL?.(undefined, 64),
                channelName: getChannelName(channel),
                content: formatContent(message),
                timestamp: Date.now()
            });
        }
    }
});
