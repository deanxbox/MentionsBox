/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, type PluginAuthor } from "@utils/types";
import type { Emoji, MessageJSON } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import {
    ChannelStore,
    Constants,
    createRoot,
    EmojiStore,
    IconUtils,
    NavigationRouter,
    RelationshipStore,
    RestAPI,
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

interface MessageReactionPayload {
    channelId?: string;
    channel_id?: string;
    messageId?: string;
    message_id?: string;
    userId?: string;
    user_id?: string;
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
    reactedEmojiKeys: string[];
    timestamp: number;
}

interface ReplyMessageReference {
    channel_id: string;
    message_id: string;
    guild_id?: string;
}

const Dean: PluginAuthor = {
    name: ".dean",
    id: 285021062578700289n
};

const ROOT_ID = "vc-mentions-box-root";
const DEFAULT_EXPIRATION_MINUTES = 10;
const DEFAULT_STORED_MENTIONS = 50;
const QUICK_REACTION_COUNT = 5;
const MENTION_BOX_REACTION_SUPPRESSION_MS = 2_000;

const EmojiUtils = findByPropsLazy("getURL", "getEmojiColors");

const enum SortOrder {
    Newest = "newest",
    Oldest = "oldest"
}

const settings = definePluginSettings({
    visibleMentions: {
        type: OptionType.SLIDER,
        description: "How many recent mention notifications to show at once",
        markers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        default: 5,
        stickToMarkers: true,
        restartNeeded: false
    },
    storedMentions: {
        type: OptionType.NUMBER,
        description: "How many recent mention notifications to keep in the queue",
        default: DEFAULT_STORED_MENTIONS,
        restartNeeded: false,
        componentProps: {
            min: 1,
            step: 1
        },
        onChange: trimStoredNotices,
        isValid(value: number | string) {
            const limit = Number(value);

            if (!Number.isInteger(limit) || limit < 1) return "Use a whole number greater than 0";
            return true;
        }
    },
    sortOrder: {
        type: OptionType.SELECT,
        description: "Which mentions appear first in the notification stack",
        options: [
            { label: "Newest first", value: SortOrder.Newest, default: true },
            { label: "Oldest first", value: SortOrder.Oldest }
        ],
        restartNeeded: false
    },
    jumpOnReply: {
        type: OptionType.BOOLEAN,
        description: "Jump to the mentioned message after replying from the notification",
        default: false,
        restartNeeded: false
    },
    neverExpire: {
        type: OptionType.BOOLEAN,
        description: "Never expire mention notifications automatically",
        default: false,
        restartNeeded: false,
        onChange(isEnabled: boolean) {
            if (!isEnabled) clearExpiredNotices();
        }
    },
    expirationMinutes: {
        type: OptionType.NUMBER,
        description: "How many minutes mention notifications stay queued before expiring",
        default: DEFAULT_EXPIRATION_MINUTES,
        placeholder: `${DEFAULT_EXPIRATION_MINUTES}`,
        restartNeeded: false,
        componentProps: {
            min: 1,
            step: 1
        },
        onChange: clearExpiredNotices,
        isValid(value: number | string) {
            const minutes = Number(value);

            if (!Number.isInteger(minutes) || minutes < 1) return "Use a whole number of minutes greater than 0";
            return true;
        }
    }
}, {
    expirationMinutes: {
        disabled() { return this.store.neverExpire; }
    }
});

let root: ReturnType<typeof createRoot> | null = null;
let notices: MentionNotice[] = [];
let pruneInterval: ReturnType<typeof setInterval> | null = null;

const listeners = new Set<() => void>();
const mentionBoxReactionMessageIds = new Set<string>();

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

function removeNoticeForMessage(messageId?: string, channelId?: string) {
    if (!messageId) return false;

    const nextNotices = notices.filter(notice => {
        if (notice.id !== messageId) return true;
        return channelId ? notice.channelId !== channelId : false;
    });

    if (nextNotices.length === notices.length) return false;
    setNotices(nextNotices);
    return true;
}

function removeNoticeForReply(message: MessageJSON) {
    const reference = message.message_reference;

    return removeNoticeForMessage(reference?.message_id, reference?.channel_id);
}

function jumpToNotice(notice: MentionNotice) {
    NavigationRouter.transitionTo(`/channels/${notice.guildId ?? "@me"}/${notice.channelId}/${notice.id}`);
}

function getReactionPayloadMessageId(payload: MessageReactionPayload) {
    return payload.messageId ?? payload.message_id;
}

function getReactionPayloadChannelId(payload: MessageReactionPayload) {
    return payload.channelId ?? payload.channel_id;
}

function getReactionPayloadUserId(payload: MessageReactionPayload) {
    return payload.userId ?? payload.user_id;
}

function shouldIgnoreMentionBoxReaction(messageId: string) {
    return mentionBoxReactionMessageIds.has(messageId);
}

function markMentionBoxReaction(messageId: string) {
    mentionBoxReactionMessageIds.add(messageId);
    setTimeout(() => mentionBoxReactionMessageIds.delete(messageId), MENTION_BOX_REACTION_SUPPRESSION_MS);
}

function setNoticeReactionState(noticeId: string, emojiKey: string, isReacted: boolean) {
    setNotices(notices.map(notice => {
        if (notice.id !== noticeId) return notice;

        const reactedEmojiKeys = new Set(notice.reactedEmojiKeys);
        if (isReacted) reactedEmojiKeys.add(emojiKey);
        else reactedEmojiKeys.delete(emojiKey);

        return {
            ...notice,
            reactedEmojiKeys: [...reactedEmojiKeys]
        };
    }));
}

function clearExpiredNotices() {
    if (settings.store.neverExpire) return;

    const expirationMinutes = Number(settings.store.expirationMinutes) || DEFAULT_EXPIRATION_MINUTES;
    const cutoff = Date.now() - expirationMinutes * 60_000;
    const nextNotices = notices.filter(notice => notice.timestamp >= cutoff);

    if (nextNotices.length !== notices.length) setNotices(nextNotices);
}

function getStoredMentionsLimit() {
    return Math.max(1, Math.floor(Number(settings.store.storedMentions) || DEFAULT_STORED_MENTIONS));
}

function trimStoredNotices() {
    const nextNotices = notices.slice(0, getStoredMentionsLimit());

    if (nextNotices.length !== notices.length) setNotices(nextNotices);
}

function addNotice(notice: MentionNotice) {
    setNotices([
        notice,
        ...notices.filter(existing => existing.id !== notice.id)
    ].slice(0, getStoredMentionsLimit()));
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

function getEmojiLabel(emoji: Emoji) {
    return emoji.id ? `:${emoji.name}:` : emoji.name;
}

function getEmojiKey(emoji: Emoji) {
    return emoji.id ?? emoji.name;
}

function getEmojiImageUrl(emoji: Emoji) {
    if (!emoji.id) return EmojiUtils.getURL(getUnicodeEmojiSurrogates(emoji));

    return IconUtils.getEmojiURL({
        id: emoji.id,
        animated: emoji.animated,
        size: 32
    });
}

function getUnicodeEmojiSurrogates(emoji: Emoji) {
    return "surrogates" in emoji ? emoji.surrogates : emoji.name;
}

function getReactionKey(emoji: Emoji) {
    return emoji.id
        ? `${emoji.name}:${emoji.id}`
        : getUnicodeEmojiSurrogates(emoji);
}

function getQuickReactionEmojis(guildId: string | null) {
    return EmojiStore
        .getDisambiguatedEmojiContext(guildId)
        .getFrequentlyUsedReactionEmojisWithoutFetchingLatest()
        .slice(0, QUICK_REACTION_COUNT);
}

async function setReactionOnNotice(notice: MentionNotice, emoji: Emoji, isReacted: boolean) {
    const emojiKey = getReactionKey(emoji);
    const url = `${Constants.Endpoints.REACTIONS(notice.channelId, notice.id, emojiKey)}/@me`;
    const request = {
        url,
        query: {
            location: "Message",
            type: 0
        },
        oldFormErrors: true
    };

    markMentionBoxReaction(notice.id);
    setNoticeReactionState(notice.id, emojiKey, isReacted);

    try {
        if (isReacted) await RestAPI.put(request);
        else await RestAPI.del(request);
    } catch (error) {
        setNoticeReactionState(notice.id, emojiKey, !isReacted);
        console.error("[MentionsBox] Failed to update reaction", error);
    }
}

async function sendReplyToNotice(notice: MentionNotice, content: string) {
    const messageReference: ReplyMessageReference = {
        channel_id: notice.channelId,
        message_id: notice.id
    };
    if (notice.guildId) messageReference.guild_id = notice.guildId;

    await RestAPI.post({
        url: Constants.Endpoints.MESSAGES(notice.channelId),
        body: {
            allowed_mentions: {
                parse: [],
                replied_user: true
            },
            channel_id: notice.channelId,
            content,
            flags: 0,
            message_reference: messageReference,
            nonce: `${Date.now()}`,
            tts: false,
            type: 0
        }
    });
}

function useNotices() {
    const [currentNotices, setCurrentNotices] = useState(getSnapshot);

    useEffect(() => subscribe(() => setCurrentNotices([...getSnapshot()])), []);

    return currentNotices;
}

function MentionCard({ notice }: { notice: MentionNotice; }) {
    const [replyContent, setReplyContent] = useState("");
    const [isSendingReply, setIsSendingReply] = useState(false);
    const quickReactionEmojis = useMemo(
        () => getQuickReactionEmojis(notice.guildId),
        [notice.guildId]
    );

    const jumpToMention = useCallback(() => {
        removeNotice(notice.id);
        jumpToNotice(notice);
    }, [notice]);

    const dismissNotice = useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        removeNotice(notice.id);
    }, [notice.id]);

    const handleReplyChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        setReplyContent(event.currentTarget.value);
    }, []);

    const submitReply = useCallback(async (event: React.FormEvent) => {
        event.preventDefault();
        event.stopPropagation();

        const content = replyContent.trim();
        if (!content || isSendingReply) return;

        setIsSendingReply(true);
        try {
            await sendReplyToNotice(notice, content);
            setReplyContent("");
            removeNotice(notice.id);
            if (settings.store.jumpOnReply) jumpToNotice(notice);
        } catch (error) {
            console.error("[MentionsBox] Failed to send reply", error);
        } finally {
            setIsSendingReply(false);
        }
    }, [isSendingReply, notice, replyContent]);

    const reactToMention = useCallback((event: React.MouseEvent, emoji: Emoji, isReacted: boolean) => {
        event.preventDefault();
        event.stopPropagation();
        void setReactionOnNotice(notice, emoji, !isReacted);
    }, [notice]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;

        event.preventDefault();
        jumpToMention();
    }, [jumpToMention]);

    return (
        <div className="vc-mentions-box-card">
            <div className="vc-mentions-box-accent" />
            <div className="vc-mentions-box-body">
                <div
                    className="vc-mentions-box-main"
                    onClick={jumpToMention}
                    onKeyDown={handleKeyDown}
                    role="button"
                    tabIndex={0}
                >
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
                    <div className="vc-mentions-box-actions">
                        {quickReactionEmojis.length > 0 && (
                            <div className="vc-mentions-box-reactions" aria-label="Quick reactions">
                                {quickReactionEmojis.map(emoji => {
                                    const imageUrl = getEmojiImageUrl(emoji);
                                    const label = getEmojiLabel(emoji);
                                    const isReacted = notice.reactedEmojiKeys.includes(getReactionKey(emoji));

                                    return (
                                        <button
                                            key={getEmojiKey(emoji)}
                                            type="button"
                                            className={`vc-mentions-box-reaction${isReacted ? " vc-mentions-box-reaction-selected" : ""}`}
                                            onClick={event => reactToMention(event, emoji, isReacted)}
                                            aria-label={`${isReacted ? "Remove" : "React with"} ${label}`}
                                            aria-pressed={isReacted}
                                            title={`${isReacted ? "Remove" : "React with"} ${label}`}
                                        >
                                            {imageUrl ? (
                                                <img className="vc-mentions-box-reaction-img" src={imageUrl} alt="" />
                                            ) : (
                                                <span className="vc-mentions-box-reaction-unicode">{getEmojiLabel(emoji)}</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        <span className="vc-mentions-box-jump">Jump</span>
                        <button className="vc-mentions-box-dismiss" type="button" onClick={dismissNotice} aria-label="Dismiss mention">
                            x
                        </button>
                    </div>
                </div>
                <form className="vc-mentions-box-reply" onSubmit={submitReply} onClick={event => event.stopPropagation()}>
                    <input
                        className="vc-mentions-box-reply-input"
                        value={replyContent}
                        onChange={handleReplyChange}
                        placeholder={`Reply to ${notice.authorName}`}
                        disabled={isSendingReply}
                    />
                    <button
                        className="vc-mentions-box-reply-send"
                        disabled={!replyContent.trim() || isSendingReply}
                        type="submit"
                    >
                        Reply
                    </button>
                </form>
            </div>
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
    const { sortOrder, visibleMentions } = settings.use(["sortOrder", "visibleMentions"]);
    const visibleLimit = Math.max(1, Math.floor(Number(visibleMentions) || 5));
    const sortedNotices = useMemo(
        () => sortOrder === SortOrder.Oldest ? [...currentNotices].reverse() : currentNotices,
        [currentNotices, sortOrder]
    );
    const visibleNotices = useMemo(
        () => currentChannelId ? sortedNotices.slice(0, visibleLimit) : [],
        [currentChannelId, sortedNotices, visibleLimit]
    );
    const queuedCount = currentChannelId
        ? Math.max(currentNotices.length - visibleLimit, 0)
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
    settings,

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
            const currentUser = UserStore.getCurrentUser();

            if (message?.author?.id === currentUser?.id && removeNoticeForReply(message)) return;
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
                reactedEmojiKeys: [],
                timestamp: Date.now()
            });
        },

        MESSAGE_REACTION_ADD(payload: MessageReactionPayload) {
            const currentUser = UserStore.getCurrentUser();
            const messageId = getReactionPayloadMessageId(payload);

            if (!messageId || getReactionPayloadUserId(payload) !== currentUser?.id) return;
            if (shouldIgnoreMentionBoxReaction(messageId)) return;

            removeNoticeForMessage(messageId, getReactionPayloadChannelId(payload));
        }
    }
});
