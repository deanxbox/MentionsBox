/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { openMediaModal } from "@utils/modal";
import definePlugin, { OptionType, type PluginAuthor } from "@utils/types";
import type { Emoji, MessageJSON } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import {
    ChannelStore,
    Constants,
    createRoot,
    EmojiStore,
    FluxDispatcher,
    GuildStore,
    IconUtils,
    Menu,
    MessageStore,
    NavigationRouter,
    Parser,
    ReadStateStore,
    RelationshipStore,
    RestAPI,
    SelectedChannelStore,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    UserProfileActions,
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

interface ReplyPreview {
    id: string;
    authorName: string;
    avatarUrl?: string;
    content: string;
    channelId?: string;
    media: MessageMediaPreview[];
}

interface MessageMediaPreview {
    id: string;
    kind: "image" | "video" | "gif" | "sticker";
    url: string;
    originalUrl?: string;
    filename?: string;
    label: string;
    width?: number;
    height?: number;
    animated?: boolean;
}

interface MentionNotice {
    id: string;
    channelId: string;
    guildId: string | null;
    authorId: string;
    authorName: string;
    authorUsername: string;
    authorDisplayName: string;
    authorBot?: boolean;
    avatarUrl?: string;
    channelName: string;
    guildName?: string;
    content: string;
    referencedContent?: string;
    referencedAuthorName?: string;
    replyChain: ReplyPreview[];
    media: MessageMediaPreview[];
    reactedEmojiKeys: string[];
    timestamp: number;
    externalReactionDismissStartedAt?: number;
    externalReactionDismissDurationMs?: number;
}

interface PreselectedDialogue {
    id: string;
    label: string;
    content: string;
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
const RECENT_MENTIONS_ENDPOINT = "/users/@me/mentions";
const DEFAULT_EXPIRATION_MINUTES = 10;
const DEFAULT_STORED_MENTIONS = 50;
const QUICK_REACTION_COUNT = 5;
const MENTION_BOX_REACTION_SUPPRESSION_MS = 2_000;
const CONTENT_TRUNCATE_LENGTH = 120;
const REF_CONTENT_TRUNCATE_LENGTH = 80;
const DEFAULT_HIDE_TOGGLE_KEYBIND = "CTRL+SHIFT+M";
const DEFAULT_DIALOGUE_MODE_TOGGLE_KEYBIND = "CTRL+SHIFT+B";
const DEFAULT_JUMP_TOGGLE_KEYBIND = "CTRL+SHIFT+J";
const DEFAULT_EXTERNAL_REACTION_DISMISS_SECONDS = 8;
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i;
const VIDEO_EXTENSIONS = /\.(?:mp4|webm|mov)(?:[?#].*)?$/i;
const STICKER_FORMAT_EXTENSIONS: Record<number, string> = {
    1: "png",
    2: "png",
    3: "json",
    4: "gif"
};
const DEFAULT_PRESELECTED_DIALOGUES: PreselectedDialogue[] = [
    { id: "thanks", label: "Thanks", content: "Thanks for the ping, {author.name}!" },
    { id: "looking", label: "Looking now", content: "I'm looking now." },
    { id: "got-it", label: "Got it", content: "Got it — thanks." }
];
const PLACEHOLDER_HELP = [
    "{server.name}",
    "{channel.name}",
    "{channel.id}",
    "{message.id}",
    "{message.link}",
    "{message.content}",
    "{replied-user.name}",
    "{replied-user.username}",
    "{replied-user.display-name}",
    "{replied-user.id}",
    "{author.name}",
    "{author.username}",
    "{author.display-name}",
    "{author.id}",
    "{me.name}",
    "{me.username}",
    "{me.display-name}",
    "{me.id}"
];

const EmojiUtils = findByPropsLazy("getURL", "getEmojiColors");

const enum SortOrder {
    Newest = "newest",
    Oldest = "oldest"
}

const enum DialogueButtonMode {
    Send = "send",
    Draft = "draft"
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
    jumpToMentionOnClick: {
        type: OptionType.BOOLEAN,
        description: "Clicking a MentionsBox card jumps to that message",
        default: true,
        restartNeeded: false
    },
    hideBotMentions: {
        type: OptionType.BOOLEAN,
        description: "Hide mentions from bot users",
        default: false,
        restartNeeded: false,
        onChange(isEnabled: boolean) {
            if (isEnabled) setNotices(notices.filter(notice => !isBotNotice(notice)));
        }
    },
    hideDmMentions: {
        type: OptionType.BOOLEAN,
        description: "Hide one-to-one DM mentions (group chats are still shown)",
        default: false,
        restartNeeded: false,
        onChange(isEnabled: boolean) {
            if (isEnabled) setNotices(notices.filter(notice => !isDmNotice(notice)));
        }
    },
    hideToggleKeybind: {
        type: OptionType.STRING,
        description: "Keybind to toggle hiding MentionsBox notifications. Leave empty to disable.",
        default: DEFAULT_HIDE_TOGGLE_KEYBIND,
        placeholder: DEFAULT_HIDE_TOGGLE_KEYBIND,
        hidden: true,
        restartNeeded: false
    },
    dialogueModeToggleKeybind: {
        type: OptionType.STRING,
        description: "Keybind to toggle interaction buttons between sending immediately and pre-writing the reply. Leave empty to disable.",
        default: DEFAULT_DIALOGUE_MODE_TOGGLE_KEYBIND,
        placeholder: DEFAULT_DIALOGUE_MODE_TOGGLE_KEYBIND,
        hidden: true,
        restartNeeded: false
    },
    jumpToggleKeybind: {
        type: OptionType.STRING,
        description: "Keybind to toggle clicking MentionsBox cards to jump to messages. Leave empty to disable.",
        default: DEFAULT_JUMP_TOGGLE_KEYBIND,
        placeholder: DEFAULT_JUMP_TOGGLE_KEYBIND,
        hidden: true,
        restartNeeded: false
    },
    keybindSettings: {
        type: OptionType.COMPONENT,
        description: "MentionsBox keybinds",
        component: KeybindSettings,
        restartNeeded: false
    },
    dialogueButtonMode: {
        type: OptionType.SELECT,
        description: "What happens when clicking a pre-selected interaction button",
        options: [
            { label: "Pre-write the reply", value: DialogueButtonMode.Draft, default: true },
            { label: "Send immediately", value: DialogueButtonMode.Send }
        ],
        restartNeeded: false
    },
    preselectedDialogueSettings: {
        type: OptionType.COMPONENT,
        component: PreselectedDialogueSettings
    },
    preselectedDialogues: {
        type: OptionType.CUSTOM,
        default: DEFAULT_PRESELECTED_DIALOGUES
    },
    externalReactionDismissSeconds: {
        type: OptionType.NUMBER,
        description: "How many seconds a mention stays visible after you react to it from normal chat",
        default: DEFAULT_EXTERNAL_REACTION_DISMISS_SECONDS,
        placeholder: `${DEFAULT_EXTERNAL_REACTION_DISMISS_SECONDS}`,
        restartNeeded: false,
        componentProps: {
            min: 1,
            step: 1
        },
        isValid(value: number | string) {
            const seconds = Number(value);

            if (!Number.isInteger(seconds) || seconds < 1) return "Use a whole number of seconds greater than 0";
            return true;
        }
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
let unreadLoadTimeout: ReturnType<typeof setTimeout> | null = null;
let isLoadingUnreadMentions = false;
let isUnreadMentionsLoadRunning = false;
let areNotificationsHidden = false;
let isRecordingKeybind = false;

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

function setNotificationsHidden(isHidden: boolean) {
    if (areNotificationsHidden === isHidden) return;

    areNotificationsHidden = isHidden;
    emitChange();
}

function toggleNotificationsHidden() {
    setNotificationsHidden(!areNotificationsHidden);
}

function toggleDialogueButtonMode() {
    settings.store.dialogueButtonMode = settings.store.dialogueButtonMode === DialogueButtonMode.Send
        ? DialogueButtonMode.Draft
        : DialogueButtonMode.Send;
    emitChange();
}

function toggleJumpToMentionOnClick() {
    settings.store.jumpToMentionOnClick = !settings.store.jumpToMentionOnClick;
    emitChange();
}

function setUnreadMentionsLoading(isLoading: boolean) {
    if (isLoadingUnreadMentions === isLoading) return;

    isLoadingUnreadMentions = isLoading;
    emitChange();
}

function sortNoticesNewestFirst(nextNotices: MentionNotice[]) {
    return [...nextNotices].sort((a, b) => b.timestamp - a.timestamp);
}

function removeNotice(id: string) {
    setNotices(notices.filter(notice => notice.id !== id));
}

function removeNoticeForMessage(messageId?: string, channelId?: string, shouldMarkRead = false) {
    if (!messageId) return false;

    if (shouldMarkRead) {
        for (const notice of notices) {
            if (notice.id === messageId && (!channelId || notice.channelId === channelId)) markNoticeRead(notice);
        }
    }

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

    return removeNoticeForMessage(reference?.message_id, reference?.channel_id, true);
}

function jumpToNotice(notice: MentionNotice) {
    NavigationRouter.transitionTo(`/channels/${notice.guildId ?? "@me"}/${notice.channelId}/${notice.id}`);
}

function markNoticeRead(notice: MentionNotice) {
    FluxDispatcher.dispatch({
        type: "BULK_ACK",
        context: "APP",
        channels: [{
            channelId: notice.channelId,
            messageId: notice.id,
            readStateType: 0
        }]
    });
}

function compareSnowflakeIds(a?: string | null, b?: string | null) {
    if (!a || !b) return 0;

    try {
        const left = BigInt(a);
        const right = BigInt(b);
        if (left === right) return 0;
        return left > right ? 1 : -1;
    } catch {
        return a.localeCompare(b);
    }
}

function getMessageTimestamp(message: any) {
    const parsedTimestamp = Date.parse(message?.timestamp ?? "");
    if (!Number.isNaN(parsedTimestamp)) return parsedTimestamp;

    try {
        return Number((BigInt(message.id) >> 22n) + 1420070400000n);
    } catch {
        return Date.now();
    }
}

function formatSentTime(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        day: "numeric",
        month: "short"
    }).format(new Date(timestamp));
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

function startExternalReactionDismiss(messageId?: string, channelId?: string) {
    if (!messageId) return false;

    const dismissDurationMs = Math.max(
        1,
        Math.floor(Number(settings.store.externalReactionDismissSeconds) || DEFAULT_EXTERNAL_REACTION_DISMISS_SECONDS)
    ) * 1000;
    let didStartDismiss = false;

    const nextNotices = notices.map(notice => {
        if (notice.id !== messageId || (channelId && notice.channelId !== channelId)) return notice;

        didStartDismiss = true;
        markNoticeRead(notice);

        return {
            ...notice,
            externalReactionDismissStartedAt: Date.now(),
            externalReactionDismissDurationMs: dismissDurationMs
        };
    });

    if (didStartDismiss) setNotices(nextNotices);

    return didStartDismiss;
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

function isNoticePendingExternalReactionDismiss(notice: MentionNotice) {
    return Boolean(notice.externalReactionDismissStartedAt && notice.externalReactionDismissDurationMs);
}

function isBotNotice(notice: MentionNotice) {
    return Boolean(notice.authorBot ?? UserStore.getUser(notice.authorId)?.bot);
}

function isDmNotice(notice: MentionNotice) {
    return ChannelStore.getChannel(notice.channelId)?.type === ChannelType.DM;
}

function syncUnreadNotices(unreadNotices: MentionNotice[]) {
    const mergedById = new Map<string, MentionNotice>();
    const pendingExternalDismisses = new Map(
        notices
            .filter(isNoticePendingExternalReactionDismiss)
            .map(notice => [notice.id, notice] as const)
    );

    for (const notice of sortNoticesNewestFirst([
        ...unreadNotices,
        ...notices
    ])) {
        if (settings.store.hideBotMentions && isBotNotice(notice)) continue;
        if (settings.store.hideDmMentions && isDmNotice(notice)) continue;

        const pendingDismissNotice = pendingExternalDismisses.get(notice.id);
        const mergedNotice = pendingDismissNotice
            ? {
                ...notice,
                externalReactionDismissStartedAt: pendingDismissNotice.externalReactionDismissStartedAt,
                externalReactionDismissDurationMs: pendingDismissNotice.externalReactionDismissDurationMs
            }
            : notice;

        if (!mergedById.has(notice.id) || pendingDismissNotice) mergedById.set(notice.id, mergedNotice);
    }

    setNotices([...mergedById.values()].slice(0, getStoredMentionsLimit()));
}

function getAuthorName(message: MessageJSON | any) {
    const { author } = message;

    return RelationshipStore.getNickname(author.id)
        ?? author.globalName
        ?? author.global_name
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

    if (THREAD_CHANNEL_TYPES.has(channel.type)) {
        const parent = channel.parent_id ? ChannelStore.getChannel(channel.parent_id) : null;
        const threadName = channel.name || "Thread";
        return parent?.name ? `#${parent.name} › ${threadName}` : threadName;
    }

    return channel.name ? `#${channel.name}` : "Channel";
}

function formatContent(message: MessageJSON | any) {
    let content = message.content?.trim() || "";

    for (const user of message.mentions ?? []) {
        const displayName = RelationshipStore.getNickname(user.id) ?? (user as any).globalName ?? (user as any).global_name ?? user.username;
        content = content.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${displayName}`);
    }

    return content || "Mentioned you";
}

function getMessageReference(message: any) {
    return message?.message_reference ?? message?.messageReference ?? message?.reference;
}

function getAttachmentContentType(attachment: any) {
    return attachment?.content_type ?? attachment?.contentType ?? "";
}

function getAttachmentUrl(attachment: any) {
    return attachment?.proxy_url ?? attachment?.proxyURL ?? attachment?.proxyUrl ?? attachment?.url;
}

function getAttachmentOriginalUrl(attachment: any) {
    return attachment?.url ?? getAttachmentUrl(attachment);
}

function getStickerMediaUrl(sticker: any, size = 160) {
    const id = sticker?.id;
    const formatType = sticker?.format_type ?? sticker?.formatType;
    const ext = STICKER_FORMAT_EXTENSIONS[formatType] ?? "png";
    if (!id || ext === "json") return null;

    return `${window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT}/stickers/${id}.${ext}?size=${size}&lossless=true&animated=true`;
}

function collectMessageMedia(message: any): MessageMediaPreview[] {
    const media: MessageMediaPreview[] = [];
    const seen = new Set<string>();

    function addMedia(item: MessageMediaPreview | null | undefined) {
        if (!item?.url || seen.has(item.url)) return;
        seen.add(item.url);
        media.push(item);
    }

    for (const attachment of message?.attachments ?? []) {
        const url = getAttachmentUrl(attachment);
        const originalUrl = getAttachmentOriginalUrl(attachment);
        const contentType = getAttachmentContentType(attachment);
        const filename = attachment.filename ?? attachment.name ?? "Attachment";
        const { width } = attachment;
        const { height } = attachment;

        if (contentType.startsWith("image/") || IMAGE_EXTENSIONS.test(filename) || IMAGE_EXTENSIONS.test(url ?? "")) {
            addMedia({
                id: attachment.id ?? url,
                kind: contentType.includes("gif") || /\.gif(?:[?#].*)?$/i.test(filename) ? "gif" : "image",
                url,
                originalUrl,
                filename,
                label: contentType.includes("gif") || /\.gif(?:[?#].*)?$/i.test(filename) ? "GIF" : "Image",
                width,
                height,
                animated: contentType.includes("gif") || /\.gif(?:[?#].*)?$/i.test(filename)
            });
        } else if (contentType.startsWith("video/") || VIDEO_EXTENSIONS.test(filename) || VIDEO_EXTENSIONS.test(url ?? "")) {
            addMedia({
                id: attachment.id ?? url,
                kind: "video",
                url,
                originalUrl,
                filename,
                label: "Video",
                width,
                height
            });
        }
    }

    for (const embed of message?.embeds ?? []) {
        const image = embed.image ?? embed.thumbnail;
        const { video } = embed;
        const imageUrl = image?.proxy_url ?? image?.proxyURL ?? image?.url;
        const videoUrl = video?.proxy_url ?? video?.proxyURL ?? video?.url;
        const { type } = embed;

        if (imageUrl) {
            addMedia({
                id: imageUrl,
                kind: type === "gifv" ? "gif" : "image",
                url: imageUrl,
                originalUrl: image?.url ?? embed.url ?? imageUrl,
                label: type === "gifv" ? "GIF" : "Embed",
                width: image?.width,
                height: image?.height,
                animated: type === "gifv"
            });
        } else if (videoUrl) {
            addMedia({
                id: videoUrl,
                kind: type === "gifv" ? "gif" : "video",
                url: videoUrl,
                originalUrl: embed.url ?? videoUrl,
                label: type === "gifv" ? "GIF" : "Video",
                width: video?.width,
                height: video?.height,
                animated: type === "gifv"
            });
        }
    }

    for (const sticker of [...(message?.stickerItems ?? message?.sticker_items ?? []), ...(message?.stickers ?? [])]) {
        const url = getStickerMediaUrl(sticker);
        if (!url) continue;

        addMedia({
            id: sticker.id,
            kind: "sticker",
            url,
            originalUrl: url,
            filename: sticker.name,
            label: "Sticker",
            width: 160,
            height: 160,
            animated: (sticker.format_type ?? sticker.formatType) === 4
        });
    }

    return media;
}

function renderMessageContent(content: string, channelId?: string, messageId?: string) {
    if (!content) return null;

    return Parser.parse(content, true, {
        channelId,
        messageId,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: SelectedChannelStore.getChannelId()
    });
}

function openMentionMedia(media: MessageMediaPreview) {
    openMediaModal({
        location: "MentionsBox",
        items: [{
            type: media.kind === "video" ? "VIDEO" : "IMAGE",
            url: media.url,
            original: media.originalUrl ?? media.url,
            alt: media.filename,
            width: media.width ?? 640,
            height: media.height ?? 360,
            animated: media.animated
        }],
        shouldHideMediaOptions: false
    });
}

function MessageMedia({ media, compact = false }: { media: MessageMediaPreview[]; compact?: boolean; }) {
    if (!media.length) return null;

    return (
        <div className={`vc-mentions-box-media${compact ? " vc-mentions-box-media-compact" : ""}`}>
            {media.map(item => (
                <button
                    className={`vc-mentions-box-media-item${item.kind === "sticker" ? " vc-mentions-box-media-sticker" : ""}`}
                    key={`${item.kind}-${item.id}`}
                    type="button"
                    onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        openMentionMedia(item);
                    }}
                    title={`Open ${item.filename ?? item.label}`}
                >
                    {item.kind === "video" ? (
                        <video className="vc-mentions-box-media-img" src={item.url} muted preload="metadata" />
                    ) : (
                        <img className="vc-mentions-box-media-img" src={item.url} alt={item.filename ?? item.label} />
                    )}
                    <span className="vc-mentions-box-media-label">{item.label}</span>
                </button>
            ))}
        </div>
    );
}

function getReferencedMessage(message: any) {
    const direct = message?.referenced_message ?? message?.referencedMessage;
    if (direct) return direct;

    const reference = getMessageReference(message);
    const channelId = reference?.channel_id ?? reference?.channelId ?? message?.channel_id ?? message?.channelId;
    const messageId = reference?.message_id ?? reference?.messageId;
    if (!channelId || !messageId) return null;

    return MessageStore.getMessage(channelId, messageId) ?? null;
}

function makeReplyPreview(message: any): ReplyPreview | null {
    const id = message?.id;
    const author = message?.author;
    const authorId = author?.id ?? message?.authorId;
    if (!id || !authorId) return null;

    const user = UserStore.getUser(authorId);
    const authorName = RelationshipStore.getNickname(authorId)
        ?? (author as any)?.globalName
        ?? (author as any)?.global_name
        ?? user?.globalName
        ?? author?.username
        ?? user?.username
        ?? "Unknown User";
    const rawContent = (message?.content ?? "").trim();
    const content = rawContent
        ? formatContent(message as MessageJSON)
        : "(no text)";
    const channelId = message?.channel_id ?? message?.channelId;

    return {
        id,
        authorName,
        avatarUrl: user?.getAvatarURL?.(undefined, 32),
        content: content.length > REF_CONTENT_TRUNCATE_LENGTH
            ? `${content.slice(0, REF_CONTENT_TRUNCATE_LENGTH)}…`
            : content,
        channelId,
        media: collectMessageMedia(message)
    };
}

function collectReplyChain(message: MessageJSON | any) {
    const chain: ReplyPreview[] = [];
    const seen = new Set<string>();
    let current = getReferencedMessage(message);

    while (current && chain.length < 8) {
        const preview = makeReplyPreview(current);
        if (!preview || seen.has(preview.id)) break;

        seen.add(preview.id);
        chain.unshift(preview);
        current = getReferencedMessage(current);
    }

    return chain;
}

function ReplyChain({ replies }: { replies: ReplyPreview[]; }) {
    if (!replies.length) return null;

    return (
        <div className="vc-mentions-box-thread vc-mentions-box-reply-chain">
            <div className="vc-mentions-box-thread-heading">Reply chain</div>
            {replies.map(reply => (
                <div className="vc-mentions-box-thread-item" key={reply.id}>
                    {reply.avatarUrl ? (
                        <img className="vc-mentions-box-thread-avatar" src={reply.avatarUrl} alt="" />
                    ) : (
                        <div className="vc-mentions-box-thread-avatar vc-mentions-box-thread-avatar-fallback">
                            {reply.authorName.slice(0, 1).toUpperCase()}
                        </div>
                    )}
                    <div className="vc-mentions-box-thread-copy">
                        <div className="vc-mentions-box-thread-author">{reply.authorName}</div>
                        <div className="vc-mentions-box-thread-content">{renderMessageContent(reply.content, reply.channelId, reply.id)}</div>
                        <MessageMedia media={reply.media ?? []} compact />
                    </div>
                </div>
            ))}
        </div>
    );
}

function isRelevantMention(message: MessageJSON | any) {
    const currentUser = UserStore.getCurrentUser();

    if (!currentUser || !message.author || message.author.id === currentUser.id) return false;
    if (settings.store.hideBotMentions && message.author.bot) return false;

    return message.mentions?.some(user => user.id === currentUser.id) ?? false;
}

function buildNoticeFromMessage(message: MessageJSON | any, fallbackChannelId?: string, fallbackGuildId?: string): MentionNotice | null {
    if (!message?.id || !message?.author?.id || !isRelevantMention(message)) return null;

    const resolvedChannelId = message.channel_id ?? message.channelId ?? fallbackChannelId;
    if (!resolvedChannelId) return null;

    const channel = ChannelStore.getChannel(resolvedChannelId);
    if (!channel) return null;
    if (settings.store.hideDmMentions && channel.type === ChannelType.DM) return null;

    const guildId = channel.guild_id ?? fallbackGuildId ?? null;
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const author = UserStore.getUser(message.author.id);
    const authorName = getAuthorName(message);
    const replyChain = collectReplyChain(message);
    const refMsg = (message as any).referenced_message ?? (message as any).referencedMessage;
    let referencedContent = replyChain.at(-1)?.content;
    let referencedAuthorName = replyChain.at(-1)?.authorName;

    if (!referencedAuthorName && refMsg?.author) {
        referencedAuthorName = RelationshipStore.getNickname(refMsg.author.id)
            ?? (refMsg.author as any).globalName
            ?? (refMsg.author as any).global_name
            ?? refMsg.author.username
            ?? "Unknown User";
        const refRaw = refMsg.content?.trim() ?? "";
        referencedContent = refRaw.length > REF_CONTENT_TRUNCATE_LENGTH
            ? `${refRaw.slice(0, REF_CONTENT_TRUNCATE_LENGTH)}…`
            : refRaw || "(no text)";
    }

    return {
        id: message.id,
        channelId: resolvedChannelId,
        guildId,
        authorId: message.author.id,
        authorName,
        authorUsername: message.author.username ?? authorName,
        authorDisplayName: (message.author as any).globalName
            ?? (message.author as any).global_name
            ?? message.author.username
            ?? authorName,
        authorBot: Boolean(message.author.bot ?? author?.bot),
        avatarUrl: author?.getAvatarURL?.(undefined, 64),
        channelName: getChannelName(channel),
        guildName: guild?.name,
        content: formatContent(message),
        referencedContent,
        referencedAuthorName,
        replyChain,
        media: collectMessageMedia(message),
        reactedEmojiKeys: [],
        timestamp: getMessageTimestamp(message)
    };
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
        markNoticeRead(notice);
        startExternalReactionDismiss(notice.id, notice.channelId);
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

function receiveMessage(channelId: string, rawMessage: any) {
    try {
        return MessageStore.getMessages(channelId).receiveMessage(rawMessage).get(rawMessage.id) ?? rawMessage;
    } catch {
        return rawMessage;
    }
}

function isMessageAfterAck(message: any, channelId: string) {
    const ackMessageId = ReadStateStore.ackMessageId(channelId);
    return !ackMessageId || compareSnowflakeIds(message.id, ackMessageId) > 0;
}

function isUnreadMentionMessage(message: any, channelId = message?.channel_id ?? message?.channelId) {
    if (!message?.id || !channelId) return false;
    return ReadStateStore.getMentionCount(channelId) > 0 && isMessageAfterAck(message, channelId);
}

async function fetchRecentMentionMessages() {
    const foundMessages: any[] = [];
    let before: string | undefined;

    for (let page = 0; page < 5 && foundMessages.length < getStoredMentionsLimit(); page++) {
        const response = await RestAPI.get({
            url: RECENT_MENTIONS_ENDPOINT,
            query: {
                limit: 100,
                roles: false,
                everyone: false,
                ...(before ? { before } : {})
            },
            retries: 1
        }).catch(() => null);
        const batch = Array.isArray(response?.body) ? response.body : [];
        if (!batch.length) break;

        for (const rawMessage of batch) {
            const channelId = rawMessage.channel_id ?? rawMessage.channelId;
            if (!isUnreadMentionMessage(rawMessage, channelId)) continue;

            const message = receiveMessage(channelId, rawMessage);
            if (isRelevantMention(message)) foundMessages.push(message);
        }

        const oldestFetched = batch.at(-1);
        if (!oldestFetched || batch.length < 100) break;
        before = oldestFetched.id;
    }

    return foundMessages;
}

async function fetchUnreadMentionMessages(channelId: string, mentionCount: number) {
    const foundMessages: any[] = [];
    const oldestUnreadId = ReadStateStore.getOldestUnreadMessageId(channelId);
    let before: string | undefined;

    for (let page = 0; page < 5; page++) {
        const response = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: before ? { limit: 100, before } : { limit: 100 },
            retries: 1
        }).catch(() => null);
        const batch = Array.isArray(response?.body) ? response.body : [];
        if (!batch.length) break;

        for (const rawMessage of batch) {
            if (!isUnreadMentionMessage(rawMessage, channelId)) continue;

            const message = receiveMessage(channelId, rawMessage);
            if (isRelevantMention(message)) foundMessages.push(message);
        }

        if (foundMessages.length >= mentionCount) break;

        const oldestFetched = batch.at(-1);
        if (!oldestFetched || batch.length < 100) break;
        if (oldestUnreadId && compareSnowflakeIds(oldestFetched.id, oldestUnreadId) <= 0) break;

        before = oldestFetched.id;
    }

    return foundMessages;
}

async function loadUnreadMentions() {
    if (isUnreadMentionsLoadRunning) return;
    isUnreadMentionsLoadRunning = true;
    setUnreadMentionsLoading(true);

    const channelIds = new Set<string>();
    const unreadNotices: MentionNotice[] = [];

    try {
        for (const message of await fetchRecentMentionMessages()) {
            const channelId = message.channel_id ?? message.channelId;
            const channel = channelId ? ChannelStore.getChannel(channelId) : null;
            const notice = buildNoticeFromMessage(message, channelId, channel?.guild_id ?? undefined);
            if (notice) unreadNotices.push(notice);
        }

        for (const channelId of ReadStateStore.getMentionChannelIds?.() ?? []) {
            if (ReadStateStore.getMentionCount(channelId) > 0) channelIds.add(channelId);
        }

        for (const readState of ReadStateStore.getAllReadStates?.(true) ?? []) {
            if (readState?._mentionCount > 0 && readState.channelId) channelIds.add(readState.channelId);
        }

        for (const channelId of channelIds) {
            const channel = ChannelStore.getChannel(channelId);
            const mentionCount = ReadStateStore.getMentionCount(channelId);
            if (!channel || mentionCount <= 0) continue;

            try {
                const messages = await fetchUnreadMentionMessages(channelId, mentionCount);
                for (const message of messages) {
                    const notice = buildNoticeFromMessage(message, channelId, channel.guild_id ?? undefined);
                    if (notice) unreadNotices.push(notice);
                }
            } catch (error) {
                console.error("[MentionsBox] Failed to load unread mention channel", channelId, error);
            }
        }

        syncUnreadNotices(unreadNotices);
    } catch (error) {
        console.error("[MentionsBox] Failed to load unread mentions", error);
    } finally {
        isUnreadMentionsLoadRunning = false;
        setUnreadMentionsLoading(false);
    }
}

function scheduleUnreadMentionsLoad(delay = 500, showLoading = false) {
    if (showLoading) setUnreadMentionsLoading(true);

    if (unreadLoadTimeout) clearTimeout(unreadLoadTimeout);
    unreadLoadTimeout = setTimeout(() => {
        unreadLoadTimeout = null;
        void loadUnreadMentions();
    }, delay);
}

function matchesKeybind(event: KeyboardEvent, keybind: string) {
    const parts = keybind.trim().toUpperCase().split("+").filter(Boolean);
    if (parts.length === 0) return false;

    const hasCtrl = parts.includes("CTRL");
    const hasShift = parts.includes("SHIFT");
    const hasAlt = parts.includes("ALT");
    const mainKey = parts[parts.length - 1].toLowerCase();

    const ctrlPressed = event.ctrlKey || event.metaKey;
    const shiftPressed = event.shiftKey;
    const altPressed = event.altKey;
    const keyPressed = event.key.toLowerCase();

    if (mainKey === "tab") {
        return hasCtrl === ctrlPressed && hasShift === shiftPressed && hasAlt === altPressed && keyPressed === "tab";
    }

    if (mainKey === "space") {
        return hasCtrl === ctrlPressed && hasShift === shiftPressed && hasAlt === altPressed && keyPressed === " ";
    }

    return hasCtrl === ctrlPressed && hasShift === shiftPressed && hasAlt === altPressed && keyPressed === mainKey;
}

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;

    if (target.isContentEditable) return true;
    return Boolean(target.closest("[contenteditable='true'], textarea, input, [role='textbox']"));
}

function keybindHasModifier(keybind: string) {
    const parts = keybind.toUpperCase().split("+");
    return parts.includes("CTRL") || parts.includes("SHIFT") || parts.includes("ALT");
}

function shouldHandleGlobalKeybind(event: KeyboardEvent, keybind: string) {
    return Boolean(keybind)
        && !event.repeat
        && (keybindHasModifier(keybind) || !isTypingTarget(event.target))
        && matchesKeybind(event, keybind);
}

function consumeGlobalKeybind(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
}

const globalKeydownListener = (event: KeyboardEvent) => {
    if (isRecordingKeybind) return;

    if (shouldHandleGlobalKeybind(event, settings.store.hideToggleKeybind)) {
        consumeGlobalKeybind(event);
        toggleNotificationsHidden();
        return;
    }

    if (shouldHandleGlobalKeybind(event, settings.store.dialogueModeToggleKeybind)) {
        consumeGlobalKeybind(event);
        toggleDialogueButtonMode();
        return;
    }

    if (shouldHandleGlobalKeybind(event, settings.store.jumpToggleKeybind)) {
        consumeGlobalKeybind(event);
        toggleJumpToMentionOnClick();
    }
};

function useNotices() {
    const [currentNotices, setCurrentNotices] = useState(getSnapshot);

    useEffect(() => subscribe(() => setCurrentNotices([...getSnapshot()])), []);

    return currentNotices;
}

function useNotificationsHidden() {
    const [isHidden, setIsHidden] = useState(areNotificationsHidden);

    useEffect(() => subscribe(() => setIsHidden(areNotificationsHidden)), []);

    return isHidden;
}

function useUnreadMentionsLoading() {
    const [isLoading, setIsLoading] = useState(isLoadingUnreadMentions);

    useEffect(() => subscribe(() => setIsLoading(isLoadingUnreadMentions)), []);

    return isLoading;
}

function getEmojiSearchResults(searchResult: any): Emoji[] {
    if (Array.isArray(searchResult)) return searchResult as Emoji[];
    if (Array.isArray(searchResult?.emojis)) return searchResult.emojis as Emoji[];
    if (Array.isArray(searchResult?.results?.emojis)) return searchResult.results.emojis as Emoji[];
    if (Array.isArray(searchResult?.unlocked) || Array.isArray(searchResult?.locked)) {
        return [...(searchResult.unlocked ?? []), ...(searchResult.locked ?? [])] as Emoji[];
    }
    return [];
}

function searchEmojis(query: string, guildId: string | null, count: number): Emoji[] {
    const trimmedQuery = query.trim().replace(/^:/, "").replace(/:$/, "");
    if (!trimmedQuery) return [];

    try {
        return getEmojiSearchResults((EmojiStore as any).searchWithoutFetchingLatest?.({
            query: trimmedQuery,
            count,
            guildId: guildId ?? undefined
        })).slice(0, count);
    } catch {
        return [];
    }
}

function resolveInteractionReply(content: string, notice: MentionNotice) {
    const me = UserStore.getCurrentUser();
    const meName = RelationshipStore.getNickname(me?.id) ?? (me as any)?.globalName ?? me?.username ?? "me";
    const messageLink = `https://discord.com/channels/${notice.guildId ?? "@me"}/${notice.channelId}/${notice.id}`;
    const replacements: Record<string, string> = {
        "server.name": notice.guildName ?? "Direct Messages",
        "channel.name": notice.channelName,
        "channel.id": notice.channelId,
        "message.id": notice.id,
        "message.link": messageLink,
        "message.content": notice.content,
        "replied-user.name": notice.authorName,
        "replied-user.username": notice.authorUsername,
        "replied-user.display-name": notice.authorDisplayName,
        "replied-user.id": notice.authorId,
        "author.name": notice.authorName,
        "author.username": notice.authorUsername,
        "author.display-name": notice.authorDisplayName,
        "author.id": notice.authorId,
        "me.name": meName,
        "me.username": me?.username ?? meName,
        "me.display-name": meName,
        "me.id": me?.id ?? ""
    };

    return content.replace(/\{([^}]+)\}/g, (match, key: string) => replacements[key] ?? match);
}

function makeEmptyDialogue(): PreselectedDialogue {
    return {
        id: crypto.randomUUID(),
        label: "New reply",
        content: "Thanks, {author.name}!"
    };
}

function normalizeDialogue(dialogue: Partial<PreselectedDialogue> & { name?: string; }, index: number): PreselectedDialogue {
    return {
        id: dialogue.id || crypto.randomUUID?.() || `dialogue-${index}`,
        label: dialogue.label || dialogue.name || `Reply ${index + 1}`,
        content: dialogue.content || ""
    };
}

function getPreselectedDialogues(): PreselectedDialogue[] {
    const saved = settings.store.preselectedDialogues;
    if (!Array.isArray(saved)) return DEFAULT_PRESELECTED_DIALOGUES;

    return saved.map(normalizeDialogue);
}

type KeybindSetting = "hideToggleKeybind" | "dialogueModeToggleKeybind" | "jumpToggleKeybind";

function normalizeRecordedKey(key: string) {
    if (key === " ") return "SPACE";
    if (key === "Esc") return "ESCAPE";
    return key.length === 1 ? key.toUpperCase() : key.toUpperCase();
}

function recordKeybind(event: KeyboardEvent) {
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;

    const keys: string[] = [];
    if (event.ctrlKey || event.metaKey) keys.push("CTRL");
    if (event.shiftKey) keys.push("SHIFT");
    if (event.altKey) keys.push("ALT");
    keys.push(normalizeRecordedKey(event.key));

    return keys.join("+");
}

function KeybindInput({ label, settingKey, defaultKeybind }: {
    label: string;
    settingKey: KeybindSetting;
    defaultKeybind: string;
}) {
    const currentKeybind = settings.use([settingKey])[settingKey];
    const [isListening, setIsListening] = useState(false);

    useEffect(() => {
        if (!isListening) return;

        isRecordingKeybind = true;

        const handleKeyDown = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();

            if (event.key === "Escape") {
                setIsListening(false);
                return;
            }

            const nextKeybind = recordKeybind(event);
            if (!nextKeybind) return;

            settings.store[settingKey] = nextKeybind;
            setIsListening(false);
        };

        const handleBlur = () => setIsListening(false);

        document.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("blur", handleBlur);

        return () => {
            isRecordingKeybind = false;
            document.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("blur", handleBlur);
        };
    }, [isListening, settingKey]);

    return (
        <div className="vc-mentions-box-settings-keybind">
            <div>
                <div className="vc-mentions-box-settings-keybind-label">{label}</div>
                <div className="vc-mentions-box-settings-keybind-hint">Click the keybind, then press your shortcut.</div>
            </div>
            <button
                className={`vc-mentions-box-settings-keybind-button${isListening ? " vc-mentions-box-settings-keybind-button-listening" : ""}`}
                type="button"
                onClick={() => setIsListening(true)}
            >
                {isListening ? "Press keys…" : currentKeybind || "Disabled"}
            </button>
            <button
                className="vc-mentions-box-settings-move"
                type="button"
                onClick={() => settings.store[settingKey] = defaultKeybind}
            >
                Reset
            </button>
            <button
                className="vc-mentions-box-settings-move"
                type="button"
                onClick={() => settings.store[settingKey] = ""}
            >
                Disable
            </button>
        </div>
    );
}

function KeybindSettings() {
    return (
        <div className="vc-mentions-box-settings-keybinds">
            <KeybindInput label="Toggle hiding MentionsBox" settingKey="hideToggleKeybind" defaultKeybind={DEFAULT_HIDE_TOGGLE_KEYBIND} />
            <KeybindInput label="Toggle interaction button mode" settingKey="dialogueModeToggleKeybind" defaultKeybind={DEFAULT_DIALOGUE_MODE_TOGGLE_KEYBIND} />
            <KeybindInput label="Toggle card click jumping" settingKey="jumpToggleKeybind" defaultKeybind={DEFAULT_JUMP_TOGGLE_KEYBIND} />
        </div>
    );
}

function PreselectedDialogueSettings() {
    const [, forceUpdate] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const dialogues = getPreselectedDialogues();
    const selectedIndex = Math.max(0, dialogues.findIndex(dialogue => dialogue.id === selectedId));
    const selectedDialogue = dialogues[selectedIndex];

    function setDialogues(next: PreselectedDialogue[]) {
        settings.store.preselectedDialogues = next;
        if (next.length && (!selectedId || !next.some(dialogue => dialogue.id === selectedId))) {
            setSelectedId(next[Math.min(selectedIndex, next.length - 1)].id);
        }
        forceUpdate(version => version + 1);
    }

    function updateDialogue(index: number, patch: Partial<PreselectedDialogue>) {
        setDialogues(dialogues.map((dialogue, idx) => idx === index ? { ...dialogue, ...patch } : dialogue));
    }

    function moveDialogue(index: number, direction: -1 | 1) {
        const target = index + direction;
        if (target < 0 || target >= dialogues.length) return;

        const next = [...dialogues];
        [next[index], next[target]] = [next[target], next[index]];
        setDialogues(next);
    }

    function addDialogue() {
        const dialogue = makeEmptyDialogue();
        setDialogues([...dialogues, dialogue]);
        setSelectedId(dialogue.id);
    }

    function removeSelectedDialogue() {
        if (!selectedDialogue) return;

        const next = dialogues.filter(dialogue => dialogue.id !== selectedDialogue.id);
        setDialogues(next);
        setSelectedId(next[Math.min(selectedIndex, next.length - 1)]?.id ?? null);
    }

    return (
        <div className="vc-mentions-box-settings">
            <div>
                <div className="vc-mentions-box-settings-heading">Pre-selected interaction buttons</div>
                <div className="vc-mentions-box-settings-description">
                    These are your saved interaction buttons. They appear under View interaction on each MentionsBox card.
                </div>
            </div>
            <div className="vc-mentions-box-settings-subheading">Placeholders</div>
            <div className="vc-mentions-box-settings-placeholder-list">
                {PLACEHOLDER_HELP.map(placeholder => <code key={placeholder}>{placeholder}</code>)}
            </div>
            <div className="vc-mentions-box-settings-subheading">Button preview and order</div>
            <div className="vc-mentions-box-settings-preview" aria-label="Pre-selected interaction preview">
                {dialogues.length ? dialogues.map(dialogue => (
                    <button
                        className={`vc-mentions-box-settings-preview-button${dialogue.id === selectedDialogue?.id ? " vc-mentions-box-settings-preview-button-selected" : ""}`}
                        key={dialogue.id}
                        type="button"
                        onClick={() => setSelectedId(dialogue.id)}
                    >
                        {dialogue.label || "Untitled"}
                    </button>
                )) : (
                    <div className="vc-mentions-box-settings-empty">No interaction buttons yet.</div>
                )}
            </div>
            <button
                className="vc-mentions-box-settings-add"
                type="button"
                onClick={addDialogue}
            >
                Add dialogue
            </button>
            {selectedDialogue && (
                <div className="vc-mentions-box-settings-editor">
                    <div className="vc-mentions-box-settings-dialogue">
                        <input
                            className="vc-mentions-box-settings-input"
                            value={selectedDialogue.label}
                            onChange={event => updateDialogue(selectedIndex, { label: event.currentTarget.value })}
                            placeholder="Button label"
                        />
                        <textarea
                            className="vc-mentions-box-settings-textarea"
                            value={selectedDialogue.content}
                            onChange={event => updateDialogue(selectedIndex, { content: event.currentTarget.value })}
                            placeholder="Reply content"
                        />
                    </div>
                    <div className="vc-mentions-box-settings-editor-actions">
                        <button
                            className="vc-mentions-box-settings-move"
                            type="button"
                            disabled={selectedIndex === 0}
                            onClick={() => moveDialogue(selectedIndex, -1)}
                        >
                            Move left
                        </button>
                        <button
                            className="vc-mentions-box-settings-move"
                            type="button"
                            disabled={selectedIndex === dialogues.length - 1}
                            onClick={() => moveDialogue(selectedIndex, 1)}
                        >
                            Move right
                        </button>
                        <button
                            className="vc-mentions-box-settings-remove"
                            type="button"
                            onClick={removeSelectedDialogue}
                        >
                            Remove selected
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
function emojiToInsertText(emoji: Emoji) {
    if (emoji.id) {
        return emoji.animated
            ? `<a:${emoji.name}:${emoji.id}>`
            : `<:${emoji.name}:${emoji.id}>`;
    }
    return getUnicodeEmojiSurrogates(emoji);
}

function findExactEmojiByName(name: string, guildId: string | null) {
    const normalizedName = name.toLowerCase();

    return searchEmojis(name, guildId, 25).find(emoji =>
        getEmojiLabel(emoji).toLowerCase() === normalizedName
        || emoji.name?.toLowerCase() === normalizedName
    );
}

function translateEmojiShortcodes(content: string, guildId: string | null, cursorPos: number) {
    let nextContent = "";
    let nextCursorPos = cursorPos;
    let lastIndex = 0;

    for (const match of content.matchAll(/:([a-z0-9_+-]{2,64}):/gi)) {
        const index = match.index ?? 0;
        const shortcode = match[0];
        const name = match[1];

        if (content[index - 1] === "<" || (content[index - 2] === "<" && content[index - 1] === "a")) continue;

        const emoji = findExactEmojiByName(name, guildId);
        if (!emoji) continue;

        const replacement = emojiToInsertText(emoji);
        nextContent += content.slice(lastIndex, index) + replacement;

        if (index + shortcode.length <= cursorPos) {
            nextCursorPos += replacement.length - shortcode.length;
        }

        lastIndex = index + shortcode.length;
    }

    if (lastIndex === 0) return { content, cursorPos };

    return {
        content: nextContent + content.slice(lastIndex),
        cursorPos: Math.max(0, nextCursorPos)
    };
}

function hasCustomEmojiMarkup(content: string) {
    return /<a?:[a-z0-9_+-]+:\d+>/i.test(content);
}

function MentionCard({ notice }: { notice: MentionNotice; }) {
    const [replyContent, setReplyContent] = useState("");
    const [isSendingReply, setIsSendingReply] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isReplyExpanded, setIsReplyExpanded] = useState(false);
    const [isInteractionExpanded, setIsInteractionExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isFocusedWithin, setIsFocusedWithin] = useState(false);
    const [externalReactionDismissProgress, setExternalReactionDismissProgress] = useState(0);
    const [interactionSearch, setInteractionSearch] = useState("");
    const [cursorPos, setCursorPos] = useState(0);
    const [autocompleteIndex, setAutocompleteIndex] = useState(0);
    const replyInputRef = useRef<HTMLInputElement>(null);
    const isLong = notice.content.length > CONTENT_TRUNCATE_LENGTH;
    const displayContent = isExpanded || !isLong
        ? notice.content
        : `${notice.content.slice(0, CONTENT_TRUNCATE_LENGTH)}…`;
    const replyChain = notice.replyChain ?? [];
    const hasReplyPreview = replyChain.length > 0 || Boolean(notice.referencedAuthorName);
    const { dialogueButtonMode, jumpToMentionOnClick, preselectedDialogues } = settings.use(["dialogueButtonMode", "jumpToMentionOnClick", "preselectedDialogues"]);
    const interactionReplies = (Array.isArray(preselectedDialogues) ? preselectedDialogues : DEFAULT_PRESELECTED_DIALOGUES)
        .map(normalizeDialogue)
        .filter(dialogue => dialogue.label.trim() && dialogue.content.trim())
        .map(dialogue => ({
            ...dialogue,
            content: resolveInteractionReply(dialogue.content, notice)
        }));
    const filteredInteractionReplies = useMemo(() => {
        const query = interactionSearch.trim().toLowerCase();
        if (!query) return interactionReplies;

        return interactionReplies.filter(reply =>
            reply.label.toLowerCase().includes(query)
            || reply.content.toLowerCase().includes(query)
        );
    }, [interactionReplies, interactionSearch]);
    const isTall = isExpanded || isLong || isReplyExpanded || isInteractionExpanded;
    const isExternalReactionDismissing = Boolean(notice.externalReactionDismissStartedAt && notice.externalReactionDismissDurationMs);
    const isExternalReactionDismissPaused = isHovered || isFocusedWithin;

    const emojiMatch = useMemo(() => {
        const text = replyContent.slice(0, cursorPos);
        const m = text.match(/:([a-z0-9_+-]{1,})$/i);
        if (!m) return null;
        return { query: m[1], startIndex: text.length - m[0].length };
    }, [replyContent, cursorPos]);

    const autocompleteSuggestions = useMemo<Emoji[]>(
        () => emojiMatch ? searchEmojis(emojiMatch.query, notice.guildId, 8) : [],
        [emojiMatch, notice.guildId]
    );
    const showRenderedReplyPreview = hasCustomEmojiMarkup(replyContent);

    useEffect(() => { setAutocompleteIndex(0); }, [autocompleteSuggestions.length]);
    useEffect(() => {
        if (!isInteractionExpanded && interactionSearch) setInteractionSearch("");
    }, [isInteractionExpanded, interactionSearch]);

    useEffect(() => {
        if (!isExternalReactionDismissing || !notice.externalReactionDismissDurationMs) {
            setExternalReactionDismissProgress(0);
            return;
        }

        let animationFrame = 0;
        let progress = 0;
        let lastTick = performance.now();

        setExternalReactionDismissProgress(0);

        const tick = (now: number) => {
            if (isExternalReactionDismissPaused) {
                if (progress !== 0) {
                    progress = 0;
                    setExternalReactionDismissProgress(0);
                }

                lastTick = now;
                animationFrame = requestAnimationFrame(tick);
                return;
            }

            progress = Math.min(1, progress + (now - lastTick) / notice.externalReactionDismissDurationMs!);
            lastTick = now;
            setExternalReactionDismissProgress(progress);

            if (progress >= 1) {
                removeNotice(notice.id);
                return;
            }

            animationFrame = requestAnimationFrame(tick);
        };

        animationFrame = requestAnimationFrame(tick);

        return () => cancelAnimationFrame(animationFrame);
    }, [
        isExternalReactionDismissing,
        isExternalReactionDismissPaused,
        notice.externalReactionDismissDurationMs,
        notice.externalReactionDismissStartedAt,
        notice.id
    ]);

    const quickReactionEmojis = useMemo(
        () => getQuickReactionEmojis(notice.guildId),
        [notice.guildId]
    );

    const jumpToMention = useCallback(() => {
        markNoticeRead(notice);
        removeNotice(notice.id);
        jumpToNotice(notice);
    }, [notice]);

    const clickToMention = useCallback(() => {
        if (jumpToMentionOnClick) jumpToMention();
    }, [jumpToMention, jumpToMentionOnClick]);

    const clickJumpButton = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        jumpToMention();
    }, [jumpToMention]);

    const openAuthorProfile = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        UserProfileActions.openUserProfileModal({
            userId: notice.authorId,
            guildId: notice.guildId ?? undefined,
            channelId: notice.channelId,
            analyticsLocation: {
                page: notice.guildId ? "Guild Channel" : "DM Channel",
                section: "MentionsBox"
            }
        });
    }, [notice]);

    const dismissNotice = useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        markNoticeRead(notice);
        removeNotice(notice.id);
    }, [notice]);

    const handleReplyChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const rawContent = event.currentTarget.value;
        const rawCursorPos = event.currentTarget.selectionStart ?? rawContent.length;
        const translated = translateEmojiShortcodes(rawContent, notice.guildId, rawCursorPos);

        setReplyContent(translated.content);
        setCursorPos(translated.cursorPos);

        if (translated.content !== rawContent) {
            requestAnimationFrame(() => {
                replyInputRef.current?.setSelectionRange(translated.cursorPos, translated.cursorPos);
            });
        }
    }, [notice.guildId]);

    const submitReply = useCallback(async (event: React.FormEvent) => {
        event.preventDefault();
        event.stopPropagation();

        const content = replyContent.trim();
        if (!content || isSendingReply) return;

        setIsSendingReply(true);
        try {
            await sendReplyToNotice(notice, content);
            setReplyContent("");
            markNoticeRead(notice);
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
        if (!jumpToMentionOnClick) return;
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;

        event.preventDefault();
        jumpToMention();
    }, [jumpToMention, jumpToMentionOnClick]);

    const toggleExpand = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsExpanded(prev => !prev);
    }, []);

    const toggleReply = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsReplyExpanded(prev => !prev);
    }, []);

    const toggleInteraction = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsInteractionExpanded(prev => !prev);
    }, []);

    const useInteractionReply = useCallback(async (event: React.MouseEvent, content: string) => {
        event.preventDefault();
        event.stopPropagation();

        if (dialogueButtonMode === DialogueButtonMode.Send) {
            if (!content.trim() || isSendingReply) return;

            setIsSendingReply(true);
            try {
                await sendReplyToNotice(notice, content.trim());
                markNoticeRead(notice);
                removeNotice(notice.id);
                if (settings.store.jumpOnReply) jumpToNotice(notice);
            } catch (error) {
                console.error("[MentionsBox] Failed to send interaction reply", error);
            } finally {
                setIsSendingReply(false);
            }
            return;
        }

        setReplyContent(content);
        setCursorPos(content.length);
        requestAnimationFrame(() => {
            replyInputRef.current?.focus();
            replyInputRef.current?.setSelectionRange(content.length, content.length);
        });
    }, [dialogueButtonMode, isSendingReply, notice]);

    const deleteInteractionReply = useCallback((event: React.MouseEvent, id: string) => {
        event.preventDefault();
        event.stopPropagation();
        settings.store.preselectedDialogues = getPreselectedDialogues().filter(dialogue => dialogue.id !== id);
    }, []);

    const handleReplySelect = useCallback((event: React.SyntheticEvent<HTMLInputElement>) => {
        setCursorPos((event.target as HTMLInputElement).selectionStart ?? 0);
    }, []);

    const insertAutocompletedEmoji = useCallback((emoji: Emoji) => {
        if (!emojiMatch) return;
        const text = emojiToInsertText(emoji);
        const before = replyContent.slice(0, emojiMatch.startIndex);
        const after = replyContent.slice(cursorPos);
        const next = before + text + after;
        const nextCursor = before.length + text.length;
        setReplyContent(next);
        setCursorPos(nextCursor);
        requestAnimationFrame(() => {
            replyInputRef.current?.focus();
            replyInputRef.current?.setSelectionRange(nextCursor, nextCursor);
        });
    }, [replyContent, cursorPos, emojiMatch]);

    const appendEmojiToReply = useCallback((emoji: Emoji) => {
        setReplyContent(prev => prev + emojiToInsertText(emoji));
        requestAnimationFrame(() => replyInputRef.current?.focus());
    }, []);

    const handleReplyKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (!autocompleteSuggestions.length) return;
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setAutocompleteIndex(i => (i + 1) % autocompleteSuggestions.length);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setAutocompleteIndex(i => (i - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length);
        } else if (event.key === "Tab" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            insertAutocompletedEmoji(autocompleteSuggestions[autocompleteIndex]);
        }
    }, [autocompleteSuggestions, autocompleteIndex, insertAutocompletedEmoji]);

    const handleCardBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;

        setIsFocusedWithin(false);
    }, []);

    return (
        <div
            className="vc-mentions-box-card"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onFocusCapture={() => setIsFocusedWithin(true)}
            onBlurCapture={handleCardBlurCapture}
        >
            {isExternalReactionDismissing && (
                <div
                    className="vc-mentions-box-expire-bar"
                    style={{ transform: `scaleX(${externalReactionDismissProgress})` }}
                    aria-hidden
                />
            )}
            <div className="vc-mentions-box-accent" />
            <div className="vc-mentions-box-body">
                <div
                    className={`vc-mentions-box-main${isTall ? " vc-mentions-box-main--tall" : ""}${jumpToMentionOnClick ? "" : " vc-mentions-box-main--jump-disabled"}`}
                    onClick={clickToMention}
                    onKeyDown={handleKeyDown}
                    role={jumpToMentionOnClick ? "button" : undefined}
                    tabIndex={jumpToMentionOnClick ? 0 : undefined}
                >
                    <button
                        className="vc-mentions-box-avatar-button"
                        type="button"
                        onClick={openAuthorProfile}
                        aria-label={`Open ${notice.authorName}'s profile`}
                        title={`Open ${notice.authorName}'s profile`}
                    >
                        {notice.avatarUrl ? (
                            <img className="vc-mentions-box-avatar" src={notice.avatarUrl} alt="" />
                        ) : (
                            <span className="vc-mentions-box-avatar vc-mentions-box-avatar-fallback">
                                {notice.authorName.slice(0, 1).toUpperCase()}
                            </span>
                        )}
                    </button>
                    <div className="vc-mentions-box-copy">
                        <div className="vc-mentions-box-meta">
                            <span className="vc-mentions-box-author">{notice.authorName}</span>
                            {notice.guildName && <span className="vc-mentions-box-guild">{notice.guildName}</span>}
                            <span className="vc-mentions-box-channel">{notice.channelName}</span>
                            <span className="vc-mentions-box-time" title={new Date(notice.timestamp).toLocaleString()}>
                                {formatSentTime(notice.timestamp)}
                            </span>
                        </div>
                        <div className={`vc-mentions-box-content${isExpanded ? " vc-mentions-box-content--expanded" : ""}`}>
                            {renderMessageContent(displayContent, notice.channelId, notice.id)}
                        </div>
                        <MessageMedia media={notice.media ?? []} />
                        {isLong && (
                            <button
                                className="vc-mentions-box-read-more"
                                type="button"
                                onClick={toggleExpand}
                            >
                                {isExpanded ? "Show less" : "Read more"}
                            </button>
                        )}
                        <div className="vc-mentions-box-card-controls">
                            {hasReplyPreview && (
                                <button
                                    className="vc-mentions-box-card-control"
                                    type="button"
                                    onClick={toggleReply}
                                    aria-expanded={isReplyExpanded}
                                >
                                    {isReplyExpanded ? "Hide reply chain" : `View reply chain${replyChain.length > 1 ? ` (${replyChain.length})` : ""}`}
                                </button>
                            )}
                            {interactionReplies.length > 0 && (
                                <button
                                    className="vc-mentions-box-card-control vc-mentions-box-card-control-primary"
                                    type="button"
                                    onClick={toggleInteraction}
                                    aria-expanded={isInteractionExpanded}
                                >
                                    {isInteractionExpanded ? "Hide interaction" : "View interaction"}
                                </button>
                            )}
                        </div>
                        {isReplyExpanded && replyChain.length > 0 && <ReplyChain replies={replyChain} />}
                        {isReplyExpanded && !replyChain.length && notice.referencedAuthorName && (
                            <div className="vc-mentions-box-ref">
                                ↩ <span className="vc-mentions-box-ref-author">{notice.referencedAuthorName}</span>: {notice.referencedContent}
                            </div>
                        )}
                        {isInteractionExpanded && (
                            <div className="vc-mentions-box-interaction-panel" onClick={event => event.stopPropagation()}>
                                <input
                                    className="vc-mentions-box-interaction-search"
                                    value={interactionSearch}
                                    onChange={event => setInteractionSearch(event.currentTarget.value)}
                                    onKeyDown={event => event.stopPropagation()}
                                    placeholder="Search interactions…"
                                    aria-label="Search interaction replies"
                                />
                                <div className="vc-mentions-box-dialogues" aria-label="Interaction replies">
                                    {filteredInteractionReplies.length ? filteredInteractionReplies.map(reply => (
                                        <button
                                            key={reply.id}
                                            className="vc-mentions-box-dialogue-button"
                                            type="button"
                                            disabled={isSendingReply}
                                            onClick={event => useInteractionReply(event, reply.content)}
                                            onContextMenu={event => deleteInteractionReply(event, reply.id)}
                                            title={`${reply.content}
Right-click to delete this response`}
                                        >
                                            {reply.label}
                                        </button>
                                    )) : (
                                        <div className="vc-mentions-box-dialogue-empty">
                                            No interactions match “{interactionSearch.trim()}”
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="vc-mentions-box-actions">
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
                        <button
                            className="vc-mentions-box-jump"
                            type="button"
                            onClick={clickJumpButton}
                        >
                            Jump
                        </button>
                        <button className="vc-mentions-box-dismiss" type="button" onClick={dismissNotice} aria-label="Dismiss mention">
                            x
                        </button>
                    </div>
                </div>
                <form className="vc-mentions-box-reply" onSubmit={submitReply} onClick={event => event.stopPropagation()}>
                    {autocompleteSuggestions.length > 0 && (
                        <div className="vc-mentions-box-autocomplete">
                            {autocompleteSuggestions.map((emoji, idx) => {
                                const imgUrl = getEmojiImageUrl(emoji);
                                return (
                                    <button
                                        key={getEmojiKey(emoji)}
                                        type="button"
                                        className={`vc-mentions-box-autocomplete-item${idx === autocompleteIndex ? " vc-mentions-box-autocomplete-item--active" : ""}`}
                                        onMouseDown={e => {
                                            e.preventDefault();
                                            insertAutocompletedEmoji(emoji);
                                        }}
                                        aria-selected={idx === autocompleteIndex}
                                    >
                                        {imgUrl
                                            ? <img className="vc-mentions-box-autocomplete-img" src={imgUrl} alt="" />
                                            : <span className="vc-mentions-box-emoji-unicode">{getUnicodeEmojiSurrogates(emoji)}</span>
                                        }
                                        <span className="vc-mentions-box-autocomplete-name">{getEmojiLabel(emoji)}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <input
                        ref={replyInputRef}
                        className="vc-mentions-box-reply-input"
                        value={replyContent}
                        onChange={handleReplyChange}
                        onSelect={handleReplySelect}
                        onKeyDown={handleReplyKeyDown}
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
                    {showRenderedReplyPreview && (
                        <div className="vc-mentions-box-reply-preview" aria-label="Rendered reply preview">
                            {renderMessageContent(replyContent, notice.channelId, notice.id)}
                        </div>
                    )}
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
    const notificationsHidden = useNotificationsHidden();
    const unreadMentionsLoading = useUnreadMentionsLoading();
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

    if (notificationsHidden || (!visibleNotices.length && !unreadMentionsLoading)) return null;

    return (
        <div className="vc-mentions-box" role="region" aria-label="Recent mentions">
            {unreadMentionsLoading && (
                <div className="vc-mentions-box-loading" role="status" aria-live="polite">
                    <div className="vc-mentions-box-loading-bar" />
                    <span>Loading unread mentions…</span>
                </div>
            )}
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

    toolboxActions() {
        const notificationsHidden = useNotificationsHidden();
        const { dialogueButtonMode, jumpToMentionOnClick } = settings.use(["dialogueButtonMode", "jumpToMentionOnClick"]);
        const sendsInteractionReplies = dialogueButtonMode === DialogueButtonMode.Send;

        return (
            <>
                <Menu.MenuCheckboxItem
                    id="mentions-box-hide-notifications"
                    label="Hide MentionsBox notifications"
                    checked={notificationsHidden}
                    action={toggleNotificationsHidden}
                />
                <Menu.MenuCheckboxItem
                    id="mentions-box-send-interactions"
                    label="Interaction buttons send immediately"
                    checked={sendsInteractionReplies}
                    action={toggleDialogueButtonMode}
                />
                <Menu.MenuCheckboxItem
                    id="mentions-box-jump-on-card-click"
                    label="Click MentionsBox cards to jump"
                    checked={jumpToMentionOnClick}
                    action={toggleJumpToMentionOnClick}
                />
            </>
        );
    },

    start() {
        mountRoot();
        document.addEventListener("keydown", globalKeydownListener, true);
        pruneInterval = setInterval(clearExpiredNotices, 30_000);
        scheduleUnreadMentionsLoad(1_500, true);
    },

    stop() {
        document.removeEventListener("keydown", globalKeydownListener, true);
        if (pruneInterval) clearInterval(pruneInterval);
        if (unreadLoadTimeout) clearTimeout(unreadLoadTimeout);
        pruneInterval = null;
        unreadLoadTimeout = null;
        setUnreadMentionsLoading(false);
        setNotices([]);
        unmountRoot();
    },

    flux: {
        CONNECTION_OPEN() {
            scheduleUnreadMentionsLoad(1_500, true);
        },

        CHANNEL_ACK() {
            scheduleUnreadMentionsLoad();
        },

        CHANNEL_LOCAL_ACK() {
            scheduleUnreadMentionsLoad();
        },

        RECOMPUTE_READ_STATES() {
            scheduleUnreadMentionsLoad();
        },

        READ_STATE_UPDATE() {
            scheduleUnreadMentionsLoad(250);
        },

        READ_STATE_UPDATES() {
            scheduleUnreadMentionsLoad(250);
        },

        CLEAR_OLDEST_UNREAD_MESSAGE() {
            scheduleUnreadMentionsLoad(250);
        },

        SET_RECENT_MENTIONS_STALE() {
            scheduleUnreadMentionsLoad(250);
        },

        MESSAGE_CREATE({ message, channelId, guildId }: MessageCreatePayload) {
            const currentUser = UserStore.getCurrentUser();

            if (message?.author?.id === currentUser?.id && removeNoticeForReply(message)) return;
            if (!message?.id || message.state === "SENDING" || !isRelevantMention(message)) return;

            const notice = buildNoticeFromMessage(message, channelId, guildId);
            if (notice) addNotice({
                ...notice,
                timestamp: Date.now()
            });
        },

        MESSAGE_REACTION_ADD(payload: MessageReactionPayload) {
            const currentUser = UserStore.getCurrentUser();
            const messageId = getReactionPayloadMessageId(payload);

            if (!messageId || getReactionPayloadUserId(payload) !== currentUser?.id) return;
            if (shouldIgnoreMentionBoxReaction(messageId)) return;

            startExternalReactionDismiss(messageId, getReactionPayloadChannelId(payload));
        }
    }
});


