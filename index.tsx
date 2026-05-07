/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, type PluginAuthor } from "@utils/types";
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
const DEFAULT_EXPIRATION_MINUTES = 10;
const DEFAULT_STORED_MENTIONS = 50;

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
    const { visibleMentions } = settings.use(["visibleMentions"]);
    const visibleLimit = Math.max(1, Math.floor(Number(visibleMentions) || 5));
    const visibleNotices = useMemo(
        () => currentChannelId ? currentNotices.slice(0, visibleLimit) : [],
        [currentChannelId, currentNotices, visibleLimit]
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
