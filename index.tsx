/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { DataStore } from "@api/index";
import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { VoiceMessage } from "@plugins/voiceMessages";
import { hasGuildFeature } from "@utils/discord";
import definePlugin, { OptionType, type PluginAuthor } from "@utils/types";
import type { CloudUpload as TCloudUpload, Emoji, Guild, GuildSticker, MessageJSON, RenderModalProps, Sticker } from "@vencord/discord-types";
import { ChannelType, CloudUploadPlatform, MessageFlags, MessageType, StickerFormatType } from "@vencord/discord-types/enums";
import { findByCodeLazy, findByPropsLazy, findCssClassesLazy, findLazy } from "@webpack";
import {
    ChannelStore,
    Constants,
    createRoot,
    EmojiStore,
    FluxDispatcher,
    Forms,
    GuildMemberStore,
    GuildStore,
    Menu,
    MessageStore,
    Modal,
    NavigationRouter,
    openMediaModal,
    openModal,
    Parser,
    PermissionsBits,
    PermissionStore,
    PresenceStore,
    ReactDOM,
    ReadStateStore,
    RelationshipStore,
    RestAPI,
    Select,
    SelectedChannelStore,
    StickersStore,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    UserSettingsProtoStore,
    UserStore,
    useState,
    useStateFromStores,
    UserUtils
} from "@webpack/common";

import { filterAndSortNotices, getNextNoticeId, type MentionFilter } from "./manager";
import { getPlaceholderAutocompleteOptionId, PLACEHOLDER_AUTOCOMPLETE_ID, PlaceholderAutocomplete, type ReplyAutocompletePosition } from "./PlaceholderAutocomplete";
import {
    appendReplyImageUrls,
    getNativeFavoriteStickerIds,
    getReplyImageUrls,
    getReplyPlaceholderMatch,
    getReplyPlaceholderSuggestions,
    getReplyStickerId,
    PLACEHOLDER_HELP,
    REPLY_PLACEHOLDERS,
    type ReplyPlaceholderMatch,
    type ReplyPlaceholderSuggestion,
    resolveReplyPlaceholders,
    usesMessageContentPlaceholder
} from "./placeholders";
import { pushReplyHistory, replyMediaUnchanged, shouldEditReply } from "./replyHistory";

interface MessageCreatePayload {
    channelId: string;
    guildId?: string;
    message: MessageJSON;
}

interface MessageReactionPayload {
    channelId?: string;
    channel_id?: string;
    guildId?: string;
    guild_id?: string;
    messageId?: string;
    message_id?: string;
    userId?: string;
    user_id?: string;
    emoji?: {
        id?: string | null;
        name?: string;
        animated?: boolean;
    };
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
    kind: "image" | "video" | "gif" | "sticker" | "audio";
    url: string;
    originalUrl?: string;
    filename?: string;
    label: string;
    width?: number;
    height?: number;
    animated?: boolean;
    waveform?: string;
    durationSecs?: number;
}

type ReplyFile = File & {
    waveform?: string;
    durationSecs?: number;
};

interface StoredReaction {
    count: number;
    me: boolean;
    emoji: {
        id: string | null;
        name: string;
        animated?: boolean;
    };
}

interface TypingStartPayload {
    channelId?: string;
    channel_id?: string;
    userId?: string;
    user_id?: string;
}

type SelectedReplySticker = {
    id: string;
    name: string;
    formatType?: StickerFormatType;
} | null;

type MentionNoticeKind = "reaction" | "reply-to-mention" | "typing";

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
    messageText?: string;
    originalSticker?: SelectedReplySticker;
    originalContent?: string;
    referencedContent?: string;
    referencedAuthorName?: string;
    replyChain: ReplyPreview[];
    media: MessageMediaPreview[];
    reactedEmojiKeys: string[];
    reactions: StoredReaction[];
    timestamp: number;
    kind?: MentionNoticeKind;
    deleted?: boolean;
    externalReactionDismissStartedAt?: number;
    externalReactionDismissDurationMs?: number;
}

interface NoticeUndoEntry {
    notice: MentionNotice;
    replyContent?: string;
    stickerIds?: string[];
    files?: ReplyFile[];
    sentMessageId?: string;
    sendFailed?: boolean;
    sendPromise?: Promise<string>;
    isEditing?: boolean;
}

interface MentionSourceOption {
    value: string;
    label: string;
    count: number;
}

interface PreselectedDialogue {
    id: string;
    label: string;
    content: string;
}

interface MessageCopyingRule {
    id: string;
    pattern: string;
    flags: string;
    replacement: string;
}

interface ReplyMessageReference {
    channel_id: string;
    message_id: string;
    guild_id?: string;
}

interface LoadedRecentMentionMessage {
    processed: any;
    raw: any;
}

const Dean: PluginAuthor = {
    name: ".dean",
    id: 285021062578700289n
};

const ROOT_ID = "vc-mentions-box-root";
const RECENT_MENTIONS_ENDPOINT = "/users/@me/mentions";
const KEYWORD_NOTIFIER_LOG_KEY = "KeywordNotify_log";
const RECENT_MENTIONS_PAGE_LIMIT = 100;
const RECENT_MENTIONS_MAX_PAGES = 10;
const DEFAULT_EXPIRATION_MINUTES = 10;
const DEFAULT_STORED_MENTIONS = 50;
const SLOWMODE_REPLY_RETRY_DELAY_MS = 1_000;
const QUICK_REACTION_COUNT = 5;
const MENTION_BOX_REACTION_SUPPRESSION_MS = 2_000;
const PRELOAD_MESSAGE_LIMIT = 50;
const REF_CONTENT_TRUNCATE_LENGTH = 80;
const DEFAULT_HIDE_TOGGLE_KEYBIND = "CTRL+SHIFT+M";
const DEFAULT_DIALOGUE_MODE_TOGGLE_KEYBIND = "CTRL+SHIFT+B";
const DEFAULT_JUMP_ON_REPLY_TOGGLE_KEYBIND = "F3";
const DEFAULT_SOURCE_FILTER_TOGGLE_KEYBIND = "F4";
const DEFAULT_REPLY_CHAIN_TOGGLE_KEYBIND = "CTRL+SHIFT+Y";
const DEFAULT_EXTERNAL_REACTION_DISMISS_SECONDS = 8;
const DEFAULT_PLACEHOLDER_ORDER = REPLY_PLACEHOLDERS.map(placeholder => placeholder.key);
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
const DEFAULT_MESSAGE_COPYING_RULES: MessageCopyingRule[] = [];

const EmojiUtils = findByPropsLazy("getURL", "getEmojiColors");
const EmojiParser = findByPropsLazy("convertSurrogateToName");
const CloudUpload: typeof TCloudUpload = findLazy(module => module.prototype?.trackUploadFinished);
const MessageClasses = findCssClassesLazy("edited", "communicationDisabled", "isSystemMessage");

const enum SortOrder {
    Newest = "newest",
    Oldest = "oldest"
}

const enum DisplayLocation {
    Top = "top",
    Channels = "channels"
}

const enum DialogueButtonMode {
    Send = "send",
    Draft = "draft"
}

const uploadEmoji = findByCodeLazy(".GUILD_EMOJIS(", "EMOJI_UPLOAD_START");
const MAX_EMOJI_SIZE_BYTES = 256 * 1024;
const MAX_STICKER_SIZE_BYTES = 512 * 1024;
const PremiumTierStickerLimitMap = { 0: 5, 1: 15, 2: 30, 3: 60 } as const;
const StickerExtMap = {
    [StickerFormatType.PNG]: "png",
    [StickerFormatType.APNG]: "png",
    [StickerFormatType.LOTTIE]: "json",
    [StickerFormatType.GIF]: "gif"
} as const;
type ClonedAsset = { type: "emoji" | "sticker"; id: string; guildId: string; };

function getGuildMaxEmojiSlots(guild: Guild) {
    return Math.max(
        hasGuildFeature(guild, "MORE_EMOJI") ? 200 : 50,
        50 + (guild.premiumFeatures?.additionalEmojiSlots ?? 0)
    );
}
function getGuildMaxStickerSlots(guild: Guild) {
    if (guild.features.has("MORE_STICKERS") && guild.premiumTier === 3) return 120;
    return PremiumTierStickerLimitMap[guild.premiumTier] ?? PremiumTierStickerLimitMap[0];
}
function canCreateGuildExpressions(guild: Guild) {
    const userId = UserStore.getCurrentUser()?.id;
    return !!userId && (guild.ownerId === userId ||
        (PermissionStore.getGuildPermissions({ id: guild.id }) & PermissionsBits.CREATE_GUILD_EXPRESSIONS) === PermissionsBits.CREATE_GUILD_EXPRESSIONS);
}
function hasEmojiCapacity(guild: Guild, count: number) {
    return count < getGuildMaxEmojiSlots(guild);
}
function hasStickerCapacity(guild: Guild, count: number) {
    return count < getGuildMaxStickerSlots(guild);
}
function CloneServerPicker({ setValue }: { setValue(newValue: string): void; }) {
    settings.use(["cloneServerGuildId"]);
    const selectedId = settings.store.cloneServerGuildId;
    const options = Object.values(GuildStore.getGuilds())
        .filter(canCreateGuildExpressions)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(guild => ({ label: guild.name, value: guild.id }));
    return (
        <div>
            <Forms.FormTitle tag="h5">Clone Emojis &amp; Stickers Server</Forms.FormTitle>
            <Select
                options={options}
                placeholder={options.length ? "Choose a server" : "No writable servers found"}
                maxVisibleItems={8}
                closeOnSelect={true}
                select={(guildId: string) => {
                    settings.store.cloneServerGuildId = guildId;
                    setValue(guildId);
                }}
                isSelected={(guildId: string) => guildId === selectedId}
                serialize={String}
            />
        </div>
    );
}
function canUseExternal(channelId: string, permission: bigint) {
    const channel = ChannelStore.getChannel(channelId);
    return !channel || channel.isPrivate() || PermissionStore.can(permission, channel);
}
function canUseEmoteHere(guildId: string | undefined, animated: boolean, channelId: string, available = true) {
    if (!guildId || !available) return false;
    const channel = ChannelStore.getChannel(channelId);
    const destinationGuildId = channel?.guild_id;
    const hasNitro = (UserStore.getCurrentUser()?.premiumType ?? 0) > 0;
    return (guildId === destinationGuildId && (!animated || hasNitro)) ||
        (hasNitro && !!GuildStore.getGuild(guildId) && canUseExternal(channelId, PermissionsBits.USE_EXTERNAL_EMOJIS));
}
function canUseStickerHere(guildId: string | undefined, channelId: string, available = true) {
    if (!guildId || !available) return false;
    const destinationGuildId = ChannelStore.getChannel(channelId)?.guild_id;
    return guildId === destinationGuildId ||
        ((UserStore.getCurrentUser()?.premiumType ?? 0) > 1 && !!GuildStore.getGuild(guildId) && canUseExternal(channelId, PermissionsBits.USE_EXTERNAL_STICKERS));
}
async function fetchCloneBlob(urlForSize: (size: number) => string, maxBytes: number) {
    for (let size = 4096; size >= 16; size /= 2) {
        const response = await fetch(urlForSize(size));
        if (!response.ok) throw new Error(`Failed to download expression: ${response.status}`);
        const blob = await response.blob();
        if (blob.size <= maxBytes) return blob;
    }
    throw new Error(`Expression exceeds upload limit of ${maxBytes} bytes`);
}
async function cloneEmojiToStaging(guildId: string, id: string, name: string) {
    const blob = await fetchCloneBlob(
        size => `${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/emojis/${id}.webp?size=${size}&lossless=true&animated=true`,
        MAX_EMOJI_SIZE_BYTES
    );
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
    const previousIds = new Set(EmojiStore.getGuildEmoji(guildId).map(emoji => emoji.id));
    const result = await uploadEmoji({ guildId, name: name.split("~")[0], image: dataUrl });
    const newId = result?.body?.id ?? result?.id ??
        EmojiStore.getGuildEmoji(guildId).find(emoji => !previousIds.has(emoji.id) && emoji.name === name.split("~")[0])?.id;
    if (!newId) throw new Error(`Emoji upload returned no id for ${name}`);
    return String(newId);
}
async function cloneStickerToStaging(guildId: string, sticker: GuildSticker) {
    const blob = await fetchCloneBlob(
        size => `${window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT}/stickers/${sticker.id}.${StickerExtMap[sticker.format_type]}?size=${size}&lossless=true&animated=true`,
        MAX_STICKER_SIZE_BYTES
    );
    const data = new FormData();
    data.append("name", sticker.name);
    data.append("tags", sticker.tags);
    data.append("description", sticker.description);
    data.append("file", blob);
    const { body } = await RestAPI.post({ url: Constants.Endpoints.GUILD_STICKER_PACKS(guildId), body: data });
    if (!body?.id) throw new Error(`Sticker upload returned no id for ${sticker.name}`);
    try {
        FluxDispatcher.dispatch({ type: "GUILD_STICKERS_CREATE_SUCCESS", guildId, sticker: { ...body, user: UserStore.getCurrentUser() } });
    } catch (err) {
        console.error("[MentionsBox] Sticker created, but local store update failed", err);
    }
    return String(body.id);
}
async function deleteClonedEmoji({ guildId, id }: ClonedAsset) {
    await RestAPI.del({ url: `/guilds/${guildId}/emojis/${id}` });
}
async function deleteClonedSticker({ guildId, id }: ClonedAsset) {
    await RestAPI.del({ url: `/guilds/${guildId}/stickers/${id}` });
    FluxDispatcher.dispatch({ type: "GUILD_STICKERS_DELETE_SUCCESS", guildId, stickerId: id });
}
async function prepareCloneFallback(channelId: string, content: string, stickerIds: string[], guildId: string, clonedAssets: ClonedAsset[]) {
    const guild = GuildStore.getGuild(guildId);
    if (!guild || !canCreateGuildExpressions(guild)) throw new Error("Cannot create expressions in the configured staging server");

    let sendContent = content;
    const sendStickerIds = [...stickerIds];
    const clonedEmojis = new Map<string, string>();
    const clonedStickers = new Map<string, string>();
    const originalEmojis = EmojiStore.getGuildEmoji(guildId);
    const staticCount = originalEmojis.filter(emoji => !emoji.animated && !emoji.managed).length;
    const animatedCount = originalEmojis.filter(emoji => emoji.animated && !emoji.managed).length;
    const stickerCount = StickersStore.getStickersByGuildId(guildId)?.length ?? 0;
    let staticReserved = 0;
    let animatedReserved = 0;
    let stickerReserved = 0;

    for (const match of content.matchAll(/(?<!\\)<(a?):(\w+):(\d+)>/ig)) {
        const [, animatedMarker, name, id] = match;
        const existingId = clonedEmojis.get(id);
        if (existingId) {
            sendContent = sendContent.replaceAll(match[0], `<${animatedMarker ? "a" : ""}:${name}:${existingId}>`);
            continue;
        }
        const emoji = EmojiStore.getCustomEmojiById(id);
        const animated = emoji?.animated ?? animatedMarker === "a";
        if (canUseEmoteHere(emoji?.guildId, animated, channelId, emoji?.available)) continue;
        if (!canUseEmoteHere(guildId, animated, channelId)) {
            console.error("[MentionsBox] Staging server emojis are not usable in this channel");
            continue;
        }
        if (!hasEmojiCapacity(guild, animated ? animatedCount + animatedReserved : staticCount + staticReserved)) {
            console.error("[MentionsBox] No staging server emoji slots available", animated ? "animated" : "static");
            continue;
        }

        try {
            const clonedId = await cloneEmojiToStaging(guildId, id, name);
            clonedAssets.push({ type: "emoji", id: clonedId, guildId });
            clonedEmojis.set(id, clonedId);
            if (animated) animatedReserved++;
            else staticReserved++;
            sendContent = sendContent.replaceAll(match[0], `<${animated ? "a" : ""}:${name}:${clonedId}>`);
        } catch (err) {
            console.error("[MentionsBox] Failed to clone emoji", id, err);
        }
    }

    for (const [index, id] of stickerIds.entries()) {
        const existingId = clonedStickers.get(id);
        if (existingId) {
            sendStickerIds[index] = existingId;
            continue;
        }
        try {
            const sticker = StickersStore.getStickerById(id) ?? (await RestAPI.get({ url: Constants.Endpoints.STICKER(id) })).body as Sticker;
            if ("pack_id" in sticker || canUseStickerHere(sticker.guild_id, channelId, sticker.available)) continue;
            if (!canUseStickerHere(guildId, channelId)) {
                console.error("[MentionsBox] Staging server stickers are not usable in this channel");
                continue;
            }
            if (!hasStickerCapacity(guild, stickerCount + stickerReserved)) {
                console.error("[MentionsBox] No staging server sticker slots available");
                continue;
            }

            const clonedId = await cloneStickerToStaging(guildId, sticker as GuildSticker);
            clonedAssets.push({ type: "sticker", id: clonedId, guildId });
            clonedStickers.set(id, clonedId);
            sendStickerIds[index] = clonedId;
            stickerReserved++;
        } catch (err) {
            console.error("[MentionsBox] Failed to clone sticker", id, err);
        }
    }
    return { sendContent, stickerIds: sendStickerIds };
}

const settings = definePluginSettings({
    displayLocation: {
        type: OptionType.SELECT,
        description: "Where MentionsBox appears",
        options: [
            { label: "Appear at top", value: DisplayLocation.Top, default: true },
            { label: "Appear in channels section", value: DisplayLocation.Channels }
        ],
        restartNeeded: false,
        onChange: applyDisplayLocation
    },
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
    preloadMentionContext: {
        type: OptionType.BOOLEAN,
        description: "Preload message context in the background to make jumping to mentions smoother",
        default: false,
        restartNeeded: false
    },
    showReactionMentions: {
        type: OptionType.BOOLEAN,
        description: "Show a MentionsBox card when someone reacts to one of your messages",
        default: true,
        restartNeeded: false
    },
    showDmTypingMentions: {
        type: OptionType.BOOLEAN,
        description: "Show a MentionsBox card when someone starts typing in your DMs",
        default: false,
        restartNeeded: false
    },
    showRepliesToMentionedMessages: {
        type: OptionType.BOOLEAN,
        description: "Show a MentionsBox card when someone replies to a message that mentions you",
        default: false,
        restartNeeded: false
    },
    autoViewReplyChain: {
        type: OptionType.BOOLEAN,
        description: "Automatically expand reply chains on MentionsBox cards",
        default: false,
        restartNeeded: false
    },
    autoExpandReadMore: {
        type: OptionType.BOOLEAN,
        description: "Automatically expand long messages on MentionsBox cards",
        default: false,
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
    autoReadBotMentions: {
        type: OptionType.BOOLEAN,
        description: "Automatically mark bot mentions as read and hide them from MentionsBox",
        default: false,
        restartNeeded: false,
        onChange(isEnabled: boolean) {
            if (isEnabled) removeNotices(notices.filter(isBotNotice));
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
    jumpOnReplyToggleKeybind: {
        type: OptionType.STRING,
        description: "Keybind to toggle jumping to a mention after replying. Leave empty to disable.",
        default: DEFAULT_JUMP_ON_REPLY_TOGGLE_KEYBIND,
        placeholder: DEFAULT_JUMP_ON_REPLY_TOGGLE_KEYBIND,
        hidden: true,
        restartNeeded: false
    },
    sourceFilterToggleKeybind: {
        type: OptionType.STRING,
        description: "Keybind to show or hide the server and DM filter. Leave empty to disable.",
        default: DEFAULT_SOURCE_FILTER_TOGGLE_KEYBIND,
        placeholder: DEFAULT_SOURCE_FILTER_TOGGLE_KEYBIND,
        hidden: true,
        restartNeeded: false
    },
    replyChainToggleKeybind: {
        type: OptionType.STRING,
        description: "Keybind to toggle the focused MentionsBox reply chain. Leave empty to disable.",
        default: DEFAULT_REPLY_CHAIN_TOGGLE_KEYBIND,
        placeholder: DEFAULT_REPLY_CHAIN_TOGGLE_KEYBIND,
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
    persistInteractionSearch: {
        type: OptionType.BOOLEAN,
        description: "Keep the interaction search query when switching between cards",
        default: false,
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
    messageCopyingSettings: {
        type: OptionType.COMPONENT,
        component: MessageCopyingSettings
    },
    messageCopyingRules: {
        type: OptionType.CUSTOM,
        default: DEFAULT_MESSAGE_COPYING_RULES
    },
    cloneServerGuildId: {
        type: OptionType.COMPONENT,
        description: "Server used to temporarily clone inaccessible emojis and stickers",
        default: "",
        component: props => <CloneServerPicker setValue={props.setValue} />
    },
    enableCloneFallback: {
        type: OptionType.BOOLEAN,
        description: "Clone inaccessible emojis/stickers into the staging server before sending a copied message, then delete them after sending",
        default: false
    },
    placeholderOrderSettings: {
        type: OptionType.COMPONENT,
        description: "Manage tab placeholder autocomplete order",
        component: PlaceholderOrderSettings,
        restartNeeded: false
    },
    placeholderOrder: {
        type: OptionType.CUSTOM,
        default: DEFAULT_PLACEHOLDER_ORDER,
        restartNeeded: false
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
    },
}, {
    expirationMinutes: {
        disabled() { return this.store.neverExpire; }
    }
});

let root: ReturnType<typeof createRoot> | null = null;
let pluginStarted = false;
let notices: MentionNotice[] = [];
const discardedNoticeHistory: NoticeUndoEntry[] = [];
const restoredReplyEntries = new Map<string, NoticeUndoEntry>();
// Unsent reply text/media per notice: survives hiding the box and is attached to the Ctrl+Z entry if the notice is discarded.
const replyDrafts = new Map<string, Pick<NoticeUndoEntry, "replyContent" | "stickerIds" | "files">>();
let pruneInterval: ReturnType<typeof setInterval> | null = null;
let unreadLoadTimeout: ReturnType<typeof setTimeout> | null = null;
let isLoadingUnreadMentions = false;
let unreadMentionsLoadingLabel = "Loading unread mentions…";
let isUnreadMentionsLoadRunning = false;
let shouldRunUnreadMentionsLoadAgain = false;
let areNotificationsHidden = false;
let isSourceFilterVisible = false;
let isRecordingKeybind = false;
let keybindToast: KeybindToastState | null = null;
let keybindToastTimeout: ReturnType<typeof setTimeout> | null = null;
let keybindToastId = 0;
let keywordNotifierMentionIds = new Set<string>();

function getPlaceholderOrder(rawOrder = settings.store.placeholderOrder) {
    const validKeys = new Set(REPLY_PLACEHOLDERS.map(placeholder => placeholder.key));
    const seen = new Set<string>();
    const keys = Array.isArray(rawOrder)
        ? rawOrder
        : String(rawOrder ?? DEFAULT_PLACEHOLDER_ORDER.join(",")).split(/[\s,]+/);

    return keys
        .map(key => key.trim())
        .filter(key => validKeys.has(key) && !seen.has(key) && Boolean(seen.add(key)));
}

function parseKeywordNotifierLogEntry(entry: any) {
    if (!entry) return null;
    if (typeof entry !== "string") return entry;

    try {
        return JSON.parse(entry);
    } catch {
        return null;
    }
}

async function getKeywordNotifierMessages() {
    const log = await DataStore.get(KEYWORD_NOTIFIER_LOG_KEY).catch(() => []);
    return (Array.isArray(log) ? log : [])
        .map(parseKeywordNotifierLogEntry)
        .filter(Boolean);
}

async function refreshKeywordNotifierMentionIds() {
    keywordNotifierMentionIds = new Set(
        (await getKeywordNotifierMessages())
            .map(message => message.id ?? message.message_id ?? message.messageId)
            .filter(Boolean)
    );
}

const listeners = new Set<() => void>();
const notificationVisibilityListeners = new Set<() => void>();
const sourceFilterVisibilityListeners = new Set<() => void>();
const keybindToastListeners = new Set<() => void>();
const unreadMentionsLoadingListeners = new Set<() => void>();
const interactionSearchListeners = new Set<() => void>();
const mentionBoxReactionMessageIds = new Set<string>();
const dismissedNoticeIds = new Set<string>();
const preloadedNoticeContexts = new Set<string>();
const pendingReplyNoticeRemovalIds = new Set<string>();
const sentReplyChains = new Map<string, ReplyPreview[]>();
let sharedInteractionSearch = "";

function emitChange(target = listeners) {
    for (const listener of target) listener();
}

function subscribe(target: Set<() => void>, listener: () => void) {
    target.add(listener);
    return () => {
        target.delete(listener);
    };
}

function getSnapshot() {
    return notices;
}

function setNotices(nextNotices: MentionNotice[], recordUndo = true) {
    if (notices === nextNotices) return [];
    const nextIds = new Set(nextNotices.map(notice => notice.id));
    const removedEntries: NoticeUndoEntry[] = [];
    for (const notice of notices) {
        if (!nextIds.has(notice.id)) {
            const restored = restoredReplyEntries.get(notice.id);
            if (restored) restoredReplyEntries.delete(notice.id);
            const draft = replyDrafts.get(notice.id);
            replyDrafts.delete(notice.id);
            const entry = { ...restored, ...draft, notice };
            if (recordUndo) {
                pushReplyHistory(discardedNoticeHistory, entry);
                removedEntries.push(entry);
            }
        }
    }
    notices = nextNotices;
    emitChange();
    return removedEntries;
}

function setNotificationsHidden(isHidden: boolean) {
    if (areNotificationsHidden === isHidden) return;

    areNotificationsHidden = isHidden;
    emitChange(notificationVisibilityListeners);
}

function setSharedInteractionSearch(value: string) {
    if (sharedInteractionSearch === value) return;

    sharedInteractionSearch = value;
    emitChange(interactionSearchListeners);
}

interface KeybindToastState {
    id: number;
    message: string;
}

function showKeybindSettingToast(message: string) {
    if (keybindToastTimeout) clearTimeout(keybindToastTimeout);

    keybindToast = {
        id: ++keybindToastId,
        message
    };
    emitChange(keybindToastListeners);

    keybindToastTimeout = setTimeout(() => {
        keybindToast = null;
        keybindToastTimeout = null;
        emitChange(keybindToastListeners);
    }, 1700);
}

function toggleNotificationsHidden(showToast = false) {
    const nextHidden = !areNotificationsHidden;
    setNotificationsHidden(nextHidden);
    if (showToast) showKeybindSettingToast(`Mention cards ${nextHidden ? "hidden" : "shown"}`);
}

function toggleDialogueButtonMode(showToast = false) {
    const nextMode = settings.store.dialogueButtonMode === DialogueButtonMode.Send
        ? DialogueButtonMode.Draft
        : DialogueButtonMode.Send;
    settings.store.dialogueButtonMode = nextMode;
    emitChange();
    if (showToast) {
        showKeybindSettingToast(nextMode === DialogueButtonMode.Send
            ? "Interaction buttons: Send"
            : "Interaction buttons: Draft"
        );
    }
}

function toggleJumpToMentionOnClick(showToast = false) {
    const nextEnabled = !settings.store.jumpToMentionOnClick;
    settings.store.jumpToMentionOnClick = nextEnabled;
    emitChange();
    if (showToast) showKeybindSettingToast(`Card click jump: ${nextEnabled ? "On" : "Off"}`);
}

function setUnreadMentionsLoading(isLoading: boolean, label = unreadMentionsLoadingLabel) {
    if (isLoadingUnreadMentions === isLoading && unreadMentionsLoadingLabel === label) return;

    isLoadingUnreadMentions = isLoading;
    unreadMentionsLoadingLabel = label;
    emitChange(unreadMentionsLoadingListeners);
}

function sortNoticesNewestFirst(nextNotices: MentionNotice[]) {
    return [...nextNotices].sort((a, b) => b.timestamp - a.timestamp);
}

function removeNotice(id: string, replyContent?: string, stickerIds?: string[], files?: ReplyFile[]) {
    dismissedNoticeIds.add(id);
    pendingReplyNoticeRemovalIds.delete(id);
    const entry = setNotices(notices.filter(notice => notice.id !== id)).find(item => item.notice.id === id);
    if (entry && replyContent !== undefined) entry.replyContent = replyContent;
    if (entry && stickerIds !== undefined) entry.stickerIds = stickerIds;
    if (entry && files !== undefined) entry.files = files;
    return entry;
}

function toggleSourceFilter() {
    isSourceFilterVisible = !isSourceFilterVisible;
    emitChange(sourceFilterVisibilityListeners);
}

function toggleJumpOnReply(showToast = false) {
    const nextEnabled = !settings.store.jumpOnReply;
    settings.store.jumpOnReply = nextEnabled;
    emitChange();
    if (showToast) showKeybindSettingToast(`Jump on reply: ${nextEnabled ? "On" : "Off"}`);
}

function removeNotices(noticesToRemove: readonly MentionNotice[]) {
    if (!noticesToRemove.length) return;

    const ids = new Set(noticesToRemove.map(notice => notice.id));
    noticesToRemove.forEach(notice => {
        dismissedNoticeIds.add(notice.id);
        pendingReplyNoticeRemovalIds.delete(notice.id);
        markNoticeRead(notice);
    });
    setNotices(notices.filter(notice => !ids.has(notice.id)));
}

function removeNoticeForMessage(messageId?: string, channelId?: string, shouldMarkRead = false, sentReply?: { id: string; content: string; }) {
    if (!messageId) return false;

    dismissedNoticeIds.add(messageId);
    pendingReplyNoticeRemovalIds.delete(messageId);

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
    const removedEntries = setNotices(nextNotices);
    if (sentReply) {
        for (const entry of removedEntries) {
            if (!entry.sentMessageId) {
                entry.sentMessageId = sentReply.id;
                entry.replyContent = sentReply.content;
            }
        }
    }
    return true;
}

function removeNoticeForReply(message: MessageJSON) {
    const reference = message.message_reference;
    const messageId = reference?.message_id;
    if (messageId && pendingReplyNoticeRemovalIds.has(messageId)) {
        for (const notice of notices) {
            if (notice.id === messageId && (!reference?.channel_id || notice.channelId === reference.channel_id)) markNoticeRead(notice);
        }
        return true;
    }

    return removeNoticeForMessage(messageId, reference?.channel_id, true, { id: message.id, content: message.content ?? "" });
}

function markNoticeDeleted(messageId?: string, channelId?: string) {
    if (!messageId) return false;

    let changed = false;
    const nextNotices = notices.map(notice => {
        const matches = notice.id === messageId && (!channelId || notice.channelId === channelId);
        if (!matches || notice.deleted) return notice;

        changed = true;
        return {
            ...notice,
            deleted: true
        };
    });

    if (!changed) return false;
    setNotices(nextNotices);
    return true;
}

function getDeletedMessageIds(payload: any): string[] {
    const directId = payload?.id ?? payload?.messageId ?? payload?.message_id;
    if (directId) return [directId];

    const ids = payload?.ids ?? payload?.messageIds ?? payload?.message_ids;
    if (Array.isArray(ids)) return ids.filter(Boolean);

    const messages = payload?.messages;
    if (Array.isArray(messages)) {
        return messages
            .map(message => message?.id ?? message?.messageId ?? message?.message_id)
            .filter(Boolean);
    }

    return [];
}

function jumpToNotice(notice: MentionNotice) {
    if (notice.kind === "typing") {
        NavigationRouter.transitionTo(`/channels/@me/${notice.channelId}`);
        return;
    }

    NavigationRouter.transitionTo(`/channels/${notice.guildId ?? "@me"}/${notice.channelId}/${notice.id}`);
}

function preloadNoticeContext(notice: MentionNotice) {
    if (!settings.store.preloadMentionContext) return;

    const preloadKey = `${notice.channelId}:${notice.id}`;
    if (preloadedNoticeContexts.has(preloadKey)) return;
    preloadedNoticeContexts.add(preloadKey);

    void RestAPI.get({
        url: Constants.Endpoints.MESSAGES(notice.channelId),
        query: {
            around: notice.id,
            limit: PRELOAD_MESSAGE_LIMIT
        },
        retries: 1
    }).then(response => {
        const messages = Array.isArray(response?.body) ? response.body : [];
        for (const rawMessage of messages) {
            const channelId = rawMessage.channel_id ?? rawMessage.channelId ?? notice.channelId;
            if (channelId === notice.channelId) receiveMessage(notice.channelId, rawMessage);
        }
    }).catch(error => {
        console.warn("[MentionsBox] Failed to preload mention context", error);
    });
}

function markMessageRead(channelId?: string, messageId?: string) {
    if (!channelId || !messageId) return;

    FluxDispatcher.dispatch({
        type: "BULK_ACK",
        context: "APP",
        channels: [{
            channelId,
            messageId,
            readStateType: 0
        }]
    });
}

function markNoticeRead(notice: MentionNotice) {
    if (notice.kind === "typing") return;
    markMessageRead(notice.channelId, notice.id);
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
        second: "2-digit",
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

function getReactionPayloadGuildId(payload: MessageReactionPayload) {
    return payload.guildId ?? payload.guild_id;
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

function getStoredReactionKey(reaction: StoredReaction) {
    return reaction.emoji.id
        ? `${reaction.emoji.name}:${reaction.emoji.id}`
        : reaction.emoji.name;
}

function getStoredReactionEmoji(emoji: Emoji): StoredReaction["emoji"] {
    return {
        id: emoji.id ?? null,
        name: emoji.id ? emoji.name : getUnicodeEmojiSurrogates(emoji),
        animated: emoji.animated
    };
}

function getNextStoredReactions(reactions: StoredReaction[] | undefined, emojiKey: string, isReacted: boolean, emoji?: Emoji) {
    const nextReactions = [...(reactions ?? [])];
    const existingIndex = nextReactions.findIndex(reaction => getStoredReactionKey(reaction) === emojiKey);

    if (isReacted) {
        if (existingIndex === -1) {
            if (emoji) {
                nextReactions.push({
                    count: 1,
                    me: true,
                    emoji: getStoredReactionEmoji(emoji)
                });
            }
        } else {
            const reaction = nextReactions[existingIndex];
            nextReactions[existingIndex] = {
                ...reaction,
                count: reaction.count + (reaction.me ? 0 : 1),
                me: true
            };
        }
    } else if (existingIndex !== -1) {
        const reaction = nextReactions[existingIndex];
        const count = Math.max(0, reaction.count - (reaction.me ? 1 : 0));

        if (count === 0) nextReactions.splice(existingIndex, 1);
        else nextReactions[existingIndex] = {
            ...reaction,
            count,
            me: false
        };
    }

    return nextReactions;
}

function setNoticeReactionState(noticeId: string, emojiKey: string, isReacted: boolean, emoji?: Emoji) {
    setNotices(notices.map(notice => {
        if (notice.id !== noticeId) return notice;

        const reactedEmojiKeys = new Set(notice.reactedEmojiKeys);
        if (isReacted) reactedEmojiKeys.add(emojiKey);
        else reactedEmojiKeys.delete(emojiKey);

        return {
            ...notice,
            reactedEmojiKeys: [...reactedEmojiKeys],
            reactions: getNextStoredReactions(notice.reactions, emojiKey, isReacted, emoji)
        };
    }));
}

function updateNoticeExternalReaction(messageId: string | undefined, channelId: string | undefined, emoji: any, delta: 1 | -1) {
    if (!messageId || !emoji) return;

    const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : (emoji.name ?? "");
    if (!emojiKey) return;

    setNotices(notices.map(notice => {
        if (notice.id !== messageId) return notice;
        if (channelId && notice.channelId !== channelId) return notice;

        const reactions = [...(notice.reactions ?? [])];
        const idx = reactions.findIndex(reaction => getStoredReactionKey(reaction) === emojiKey);

        if (delta === 1) {
            if (idx === -1) {
                reactions.push({
                    count: 1,
                    me: false,
                    emoji: {
                        id: emoji.id ?? null,
                        name: emoji.name,
                        animated: emoji.animated
                    }
                });
            } else {
                reactions[idx] = {
                    ...reactions[idx],
                    count: reactions[idx].count + 1
                };
            }
        } else if (idx !== -1) {
            const count = reactions[idx].count - 1;

            if (count <= 0) reactions.splice(idx, 1);
            else reactions[idx] = {
                ...reactions[idx],
                count
            };
        }

        return { ...notice, reactions };
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
        dismissedNoticeIds.add(messageId);
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

function addNotice(notice: MentionNotice, recordEvictions = true) {
    setNotices([
        notice,
        ...notices.filter(existing => existing.id !== notice.id)
    ].slice(0, getStoredMentionsLimit()), recordEvictions);
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
    const existingById = new Map(notices.map(notice => [notice.id, notice] as const));
    const pendingExternalDismisses = new Map(
        notices
            .filter(isNoticePendingExternalReactionDismiss)
            .map(notice => [notice.id, notice] as const)
    );

    for (const notice of sortNoticesNewestFirst([
        ...unreadNotices,
        ...notices
    ])) {
        if (dismissedNoticeIds.has(notice.id)) continue;
        if (settings.store.hideBotMentions && isBotNotice(notice)) continue;
        if (settings.store.hideDmMentions && isDmNotice(notice)) continue;

        const existingNotice = existingById.get(notice.id);
        const pendingDismissNotice = pendingExternalDismisses.get(notice.id);
        const replyChain = existingNotice && existingNotice.replyChain.length > notice.replyChain.length
            ? existingNotice.replyChain
            : notice.replyChain;
        const immediateReply = replyChain.at(-1);
        const mergedNotice = {
            ...notice,
            replyChain,
            ...(immediateReply ? {
                referencedContent: immediateReply.content,
                referencedAuthorName: immediateReply.authorName
            } : {}),
            reactedEmojiKeys: existingNotice?.reactedEmojiKeys ?? notice.reactedEmojiKeys,
            reactions: existingNotice?.reactions ?? notice.reactions
        };
        const mergedDismissNotice = pendingDismissNotice
            ? {
                ...mergedNotice,
                externalReactionDismissStartedAt: pendingDismissNotice.externalReactionDismissStartedAt,
                externalReactionDismissDurationMs: pendingDismissNotice.externalReactionDismissDurationMs
            }
            : mergedNotice;

        if (!mergedById.has(notice.id) || pendingDismissNotice) mergedById.set(notice.id, mergedDismissNotice);
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

// Vencord's UserProfileActions finder also requires closeUserProfileModal, which Discord moved out of this module.
const UserProfileModal = findByPropsLazy("openUserProfileModal");

async function openProfile(userId: string, notice: { guildId?: string | null; channelId: string; }) {
    // Like Vencord's openUserProfile: ensure the user is in UserStore before opening the modal.
    await UserUtils.getUser(userId).catch(() => { });
    UserProfileModal.openUserProfileModal({
        userId,
        guildId: notice.guildId ?? undefined,
        channelId: notice.channelId,
        sourceAnalyticsLocations: ["MentionsBox"]
    });
}

function buildRawAvatarUrl(rawAuthor: any, size = 64): string | undefined {
    return buildRawAvatarUrlImpl(rawAuthor, size);
}

const STATUS_COLORS: Record<string, string> = {
    online: "var(--status-online, #23a55a)",
    idle: "var(--status-idle, #f0b232)",
    dnd: "var(--status-dnd, #f23f43)",
    offline: "var(--status-offline, #80848e)"
};
const DEVICE_ICONS: Record<string, string> = {
    desktop: "M4 2.5c-1.103 0-2 .897-2 2v11c0 1.104.897 2 2 2h7v2H7v2h10v-2h-4v-2h7c1.103 0 2-.896 2-2v-11c0-1.103-.897-2-2-2H4Zm16 2v9H4v-9h16Z",
    web: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93Zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39Z",
    mobile: "M7 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H7Zm0 2h10v14H7V4Zm5 15.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z"
};

function usePresence(userId: string) {
    const status: string = useStateFromStores([PresenceStore], () => PresenceStore.getStatus(userId)) ?? "offline";
    const devices = useStateFromStores(
        [PresenceStore],
        () => JSON.stringify(PresenceStore.getClientStatus(userId) ?? {})
    );
    return { status, devices: JSON.parse(devices) as Record<string, string> };
}

function StatusDot({ userId }: { userId: string; }) {
    const { status } = usePresence(userId);
    return <span className="vc-mentions-box-status-dot" title={status === "dnd" ? "Do Not Disturb" : status[0].toUpperCase() + status.slice(1)} style={{ background: STATUS_COLORS[status] ?? STATUS_COLORS.offline }} />;
}

function DeviceIcons({ userId }: { userId: string; }) {
    const { devices } = usePresence(userId);
    return <>{Object.entries(devices).map(([platform, status]) => (
        <svg key={platform} className="vc-mentions-box-device" viewBox="0 0 24 24" width="14" height="14" fill={STATUS_COLORS[status] ?? STATUS_COLORS.offline}>
            <title>{platform[0].toUpperCase() + platform.slice(1)}</title>
            <path d={DEVICE_ICONS[platform] ?? DEVICE_ICONS.desktop} />
        </svg>
    ))}</>;
}

function buildRawAvatarUrlImpl(rawAuthor: any, size = 64): string | undefined {
    if (!rawAuthor?.id) return undefined;

    if (rawAuthor.avatar) {
        const ext = rawAuthor.avatar.startsWith("a_") ? "gif" : "webp";
        return `https://cdn.discordapp.com/avatars/${rawAuthor.id}/${rawAuthor.avatar}.${ext}?size=${size}`;
    }

    try {
        return `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(rawAuthor.id) >> 22n) % 6}.png`;
    } catch {
        return "https://cdn.discordapp.com/embed/avatars/0.png";
    }
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
    return message.content?.trim() || "Mentioned you";
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
    const formatType = getStickerFormatType(sticker);
    const ext = STICKER_FORMAT_EXTENSIONS[formatType ?? 0];
    if (!id || !ext || ext === "json") return null;

    return `${window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT}/stickers/${id}.${ext}?size=${size}&lossless=true&animated=true`;
}

function getStickerFormatType(sticker: any): StickerFormatType | undefined {
    return (sticker?.format_type
        ?? sticker?.formatType
        ?? (sticker?.id ? StickersStore.getStickerById(sticker.id)?.format_type : undefined)) as StickerFormatType | undefined;
}

function PreviewImage({ url, imageClass, fallbackClass, fallback, alt = "" }: {
    url: string | null;
    imageClass: string;
    fallbackClass: string;
    fallback: string;
    alt?: string;
}) {
    const [failed, setFailed] = useState(false);
    return url && !failed
        ? <img className={imageClass} src={url} alt={alt} onError={() => setFailed(true)} />
        : <span className={fallbackClass}>{fallback}</span>;
}

function isPreviewableSticker(sticker: any) {
    return Boolean(sticker?.id);
}

function getStickerName(sticker: any) {
    return sticker?.name ?? "Sticker";
}

function getRestoredNoticeSticker(notice: MentionNotice): SelectedReplySticker {
    const id = (restoredReplyEntries.get(notice.id) ?? replyDrafts.get(notice.id))?.stickerIds?.[0];
    if (!id) return null;
    if (notice.originalSticker?.id === id) return notice.originalSticker;
    const sticker = StickersStore.getStickerById(id);
    return { id, name: getStickerName(sticker), formatType: getStickerFormatType(sticker) };
}

function getOriginalSticker(...messages: any[]): SelectedReplySticker {
    const sticker = messages.flatMap(message => [
        ...(message?.stickerItems ?? message?.sticker_items ?? []),
        ...(message?.stickers ?? [])
    ])[0];
    return sticker?.id ? {
        id: sticker.id,
        name: getStickerName(sticker),
        formatType: getStickerFormatType(sticker)
    } : null;
}

function getStickerSearchText(sticker: any) {
    return [
        sticker?.name,
        sticker?.description,
        sticker?.tags
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
}

function matchesStickerSearch(sticker: any, query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return true;

    const searchText = getStickerSearchText(sticker);
    return q.split(/\s+/).every(part => searchText.includes(part));
}

function getDefaultReplyStickers(): Sticker[] {
    const byId = new Map<string, Sticker>();

    StickersStore.getPremiumPacks?.()?.forEach(pack => {
        pack.stickers?.forEach(sticker => {
            if (isPreviewableSticker(sticker)) byId.set(sticker.id, sticker);
        });
    });

    StickersStore.getAllPackStickers?.()?.forEach(stickers => {
        stickers.forEach(sticker => {
            if (isPreviewableSticker(sticker)) byId.set(sticker.id, sticker);
        });
    });

    return [...byId.values()];
}

async function fetchDefaultReplyStickerPacks() {
    const response = await RestAPI.get({ url: "/sticker-packs" });
    const packs = response.body?.sticker_packs ?? response.body?.stickerPacks ?? response.body ?? [];
    if (!Array.isArray(packs)) return [];

    const byId = new Map<string, Sticker>();
    for (const pack of packs) {
        for (const sticker of pack.stickers ?? []) {
            if (isPreviewableSticker(sticker)) byId.set(sticker.id, sticker);
        }
    }

    return [...byId.values()];
}

function collectMessageMedia(...messages: any[]): MessageMediaPreview[] {
    const media: MessageMediaPreview[] = [];
    const seen = new Set<string>();

    function addMedia(item: MessageMediaPreview | null | undefined) {
        if (!item || (!item.url && item.kind !== "sticker")) return;
        const key = item.url || `sticker:${item.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        media.push(item);
    }

    for (const message of messages) {
        const isVoiceMessage = message?.hasFlag?.(MessageFlags.IS_VOICE_MESSAGE)
            ?? Boolean(Number(message?.flags ?? 0) & MessageFlags.IS_VOICE_MESSAGE);

        for (const attachment of message?.attachments ?? []) {
            const url = getAttachmentUrl(attachment);
            const originalUrl = getAttachmentOriginalUrl(attachment);
            const contentType = getAttachmentContentType(attachment);
            const filename = attachment.filename ?? attachment.name ?? "Attachment";
            const { width } = attachment;
            const { height } = attachment;

            if (isVoiceMessage) {
                addMedia({
                    id: attachment.id ?? url,
                    kind: "audio",
                    url,
                    originalUrl,
                    filename,
                    label: "Voice note",
                    waveform: attachment.waveform,
                    durationSecs: attachment.duration_secs ?? attachment.durationSecs
                });
            } else if (contentType.startsWith("image/") || IMAGE_EXTENSIONS.test(filename) || IMAGE_EXTENSIONS.test(url ?? "")) {
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
    }

    for (const embed of messages.flatMap(message => message?.embeds ?? [])) {
        const images = embed.images?.length ? embed.images : [embed.image ?? embed.thumbnail].filter(Boolean);
        const { video } = embed;
        const videoUrl = video?.proxy_url ?? video?.proxyURL ?? video?.url;
        const { type } = embed;

        if (type === "gifv" && videoUrl) {
            addMedia({
                id: videoUrl,
                kind: "video",
                url: videoUrl,
                originalUrl: embed.url ?? videoUrl,
                label: "GIF",
                width: video?.width,
                height: video?.height,
                animated: true
            });
            continue;
        }

        for (const image of images) {
            const imageUrl = image?.proxy_url ?? image?.proxyURL ?? image?.url;
            if (!imageUrl) continue;

            addMedia({
                id: imageUrl,
                kind: "image",
                url: imageUrl,
                originalUrl: image?.url ?? embed.url ?? imageUrl,
                label: "Embed",
                width: image?.width,
                height: image?.height
            });
        }

        if (!images.length && videoUrl) {
            addMedia({
                id: videoUrl,
                kind: "video",
                url: videoUrl,
                originalUrl: embed.url ?? videoUrl,
                label: "Video",
                width: video?.width,
                height: video?.height
            });
        }
    }

    for (const sticker of messages.flatMap(message => [
        ...(message?.stickerItems ?? message?.sticker_items ?? []),
        ...(message?.stickers ?? [])
    ])) {
        if (!sticker?.id) continue;
        const url = getStickerMediaUrl(sticker) ?? "";

        addMedia({
            id: sticker.id,
            kind: "sticker",
            url,
            originalUrl: url,
            filename: sticker.name,
            label: "Sticker",
            width: 160,
            height: 160,
            animated: getStickerFormatType(sticker) === StickerFormatType.GIF
        });
    }

    return media;
}

function updateNoticeMessage(message: any, fallbackChannelId?: string) {
    const messageId = message?.id ?? message?.message_id ?? message?.messageId;
    const channelId = message?.channel_id ?? message?.channelId ?? fallbackChannelId;
    if (!messageId || !channelId || !notices.some(notice => notice.id === messageId && notice.channelId === channelId)) return;

    const storedMessage = MessageStore.getMessage(channelId, messageId);
    const content = typeof message.content === "string" ? formatContent(message) : undefined;
    const freshMedia = collectMessageMedia(message, storedMessage);
    const hasStickerUpdate = [message.sticker_items, message.stickerItems, message.stickers].some(Array.isArray);
    if (content === undefined && !freshMedia.length && !hasStickerUpdate) return;

    const originalSticker = getOriginalSticker(message);
    setNotices(notices.map(notice => {
        if (notice.id !== messageId || notice.channelId !== channelId) return notice;

        const media = [...notice.media, ...freshMedia].filter((item, index, items) =>
            items.findIndex(candidate => item.url ? candidate.url === item.url : candidate.kind === item.kind && candidate.id === item.id) === index
        );
        const contentChanged = content !== undefined && content !== notice.content;
        return {
            ...notice,
            ...(contentChanged ? {
                content,
                originalContent: notice.originalContent ?? notice.content
            } : {}),
            ...(typeof message.content === "string" ? { messageText: message.content.trim() } : {}),
            originalSticker: hasStickerUpdate ? originalSticker : notice.originalSticker,
            media
        };
    }));
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
    if (media.kind === "audio" || !media.url) return;

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
            {media.map(item => item.kind === "audio" ? (
                <div
                    className="vc-mentions-box-media-audio"
                    key={`${item.kind}-${item.id}`}
                    onClick={event => event.stopPropagation()}
                >
                    <VoiceMessage src={item.url} waveform={item.waveform ?? "AAAAAAAAAAAA"} />
                </div>
            ) : (
                <button
                    className={`vc-mentions-box-media-item${item.kind === "sticker" ? " vc-mentions-box-media-sticker" : ""}`}
                    key={`${item.kind}-${item.id}`}
                    type="button"
                    disabled={!item.url}
                    onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        openMentionMedia(item);
                    }}
                    title={item.url ? `Open ${item.filename ?? item.label}` : item.filename ?? item.label}
                >
                    {item.kind === "video" ? (
                        <video
                            className="vc-mentions-box-media-img"
                            src={item.url}
                            muted
                            preload="metadata"
                            autoPlay={item.label === "GIF"}
                            loop={item.label === "GIF"}
                            playsInline
                        />
                    ) : item.kind === "sticker" ? (
                        <PreviewImage
                            key={item.url}
                            url={item.url}
                            imageClass="vc-mentions-box-media-img"
                            fallbackClass="vc-mentions-box-sticker-fallback"
                            fallback={item.filename ?? "Sticker"}
                            alt={item.filename ?? item.label}
                        />
                    ) : item.url ? (
                        <img className="vc-mentions-box-media-img" src={item.url} alt={item.filename ?? item.label} />
                    ) : (
                        <span className="vc-mentions-box-sticker-fallback">{item.filename ?? "Sticker"}</span>
                    )}
                    <span className="vc-mentions-box-media-label">{item.label}</span>
                </button>
            ))}
        </div>
    );
}

function StickerPickerTab({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode; }) {
    return (
        <button
            type="button"
            className={`vc-mentions-box-sticker-tab${active ? " vc-mentions-box-sticker-tab-active" : ""}`}
            onClick={onClick}
            title={typeof children === "string" ? children : undefined}
        >
            {children}
        </button>
    );
}

function MentionStickerPicker({ selectedId, onSelect, closePopout }: { selectedId: string | null; onSelect(sticker: SelectedReplySticker): void; closePopout(): void; }) {
    const [search, setSearch] = useState("");
    const [selectedGroupId, setSelectedGroupId] = useState("favorites");
    const [loadedDefaultStickers, setLoadedDefaultStickers] = useState<Sticker[]>(getDefaultReplyStickers());
    const favoriteStickers = useStateFromStores([UserSettingsProtoStore, StickersStore], () => {
        const ids = getNativeFavoriteStickerIds(UserSettingsProtoStore.frecencyWithoutFetchingLatest?.favoriteStickers);
        return ids
            .map(id => StickersStore.getStickerById(id))
            .filter((sticker): sticker is Sticker => Boolean(sticker && isPreviewableSticker(sticker)));
    });

    useEffect(() => {
        if (loadedDefaultStickers.length > 0) return;

        let cancelled = false;
        void fetchDefaultReplyStickerPacks()
            .then(stickers => {
                if (!cancelled && stickers.length > 0) setLoadedDefaultStickers(stickers);
            })
            .catch(error => console.error("[MentionsBox] Failed to fetch default sticker packs", error));

        return () => {
            cancelled = true;
        };
    }, [loadedDefaultStickers.length]);

    const defaultStickers = loadedDefaultStickers.length > 0 ? loadedDefaultStickers : getDefaultReplyStickers();
    const stickerMap = StickersStore.getAllGuildStickers?.();
    const stickerGroups: Array<{ id: string; name: string; stickers: Sticker[]; }> = [
        { id: "default", name: "Default", stickers: defaultStickers }
    ];

    stickerMap?.forEach((stickers: Sticker[], guildId: string) => {
        const previewableStickers = stickers.filter(isPreviewableSticker);
        if (!previewableStickers.length) return;

        stickerGroups.push({
            id: guildId,
            name: GuildStore.getGuild(guildId)?.name ?? "Unknown Server",
            stickers: previewableStickers
        });
    });

    const allStickers = stickerGroups.flatMap(group => group.stickers);
    const visibleStickers = selectedGroupId === "favorites"
        ? favoriteStickers
        : selectedGroupId === "all"
        ? allStickers
        : stickerGroups.find(group => group.id === selectedGroupId)?.stickers ?? [];
    const filteredStickers = visibleStickers
        .filter(sticker => matchesStickerSearch(sticker, search))
        .slice(0, 120);

    return (
        <>
            <div className="vc-mentions-box-sticker-header">
                <div className="vc-mentions-box-emoji-search-wrap">
                    <span className="vc-mentions-box-emoji-search-icon">🔍</span>
                    <input
                        className="vc-mentions-box-emoji-search"
                        placeholder="Search stickers..."
                        value={search}
                        onChange={event => setSearch(event.currentTarget.value)}
                        onKeyDown={event => event.stopPropagation()}
                        autoFocus
                    />
                </div>
            </div>
            <div className="vc-mentions-box-sticker-tabs">
                <StickerPickerTab active={selectedGroupId === "favorites"} onClick={() => setSelectedGroupId("favorites")}>
                    Favourites ({favoriteStickers.length})
                </StickerPickerTab>
                <StickerPickerTab active={selectedGroupId === "default"} onClick={() => setSelectedGroupId("default")}>
                    Default ({defaultStickers.length})
                </StickerPickerTab>
                <StickerPickerTab active={selectedGroupId === "all"} onClick={() => setSelectedGroupId("all")}>
                    All ({allStickers.length})
                </StickerPickerTab>
                {stickerGroups.slice(1).map(group => (
                    <StickerPickerTab key={group.id} active={selectedGroupId === group.id} onClick={() => setSelectedGroupId(group.id)}>
                        {group.name}
                    </StickerPickerTab>
                ))}
            </div>
            <div className="vc-mentions-box-sticker-grid">
                {allStickers.length === 0 ? (
                    <div className="vc-mentions-box-sticker-empty">Loading stickers...</div>
                ) : filteredStickers.length === 0 ? (
                    <div className="vc-mentions-box-sticker-empty">
                        {search.trim() ? `No results for "${search}".` : selectedGroupId === "favorites" ? "No available favorites. Favorite stickers in Discord's picker to show them here." : "No stickers in this tab."}
                    </div>
                ) : filteredStickers.map(sticker => {
                    const formatType = getStickerFormatType(sticker);
                    const stickerUrl = getStickerMediaUrl(sticker, 96);
                    const selected = selectedId === sticker.id;
                    return (
                        <div
                            key={sticker.id}
                            className="vc-mentions-box-sticker-card"
                        >
                            <button type="button" className="vc-mentions-box-sticker-select" onClick={() => {
                                onSelect(selected ? null : {
                                    id: sticker.id,
                                    name: getStickerName(sticker),
                                    formatType
                                });
                                closePopout();
                            }}
                            title={getStickerName(sticker)}
                            aria-pressed={selected}
                            >
                                <PreviewImage key={stickerUrl} url={stickerUrl} imageClass="vc-mentions-box-sticker-img" fallbackClass="vc-mentions-box-sticker-fallback" fallback={getStickerName(sticker)} alt={getStickerName(sticker)} />
                                <span className="vc-mentions-box-sticker-name">{getStickerName(sticker)}</span>
                            </button>
                        </div>
                    );
                })}
            </div>
        </>
    );
}

function getReferencedMessage(message: any) {
    const direct = message?.referenced_message ?? message?.referencedMessage;
    if (direct) {
        const channelId = direct.channel_id ?? direct.channelId ?? message?.channel_id ?? message?.channelId;
        return (channelId && direct.id ? MessageStore.getMessage(channelId, direct.id) : null) ?? direct;
    }

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
        avatarUrl: user?.getAvatarURL?.(undefined, 32) ?? buildRawAvatarUrl(message?.author, 32),
        content: content.length > REF_CONTENT_TRUNCATE_LENGTH
            ? `${content.slice(0, REF_CONTENT_TRUNCATE_LENGTH)}…`
            : content,
        channelId,
        media: collectMessageMedia(message)
    };
}

function makeNoticeReplyPreview(notice: MentionNotice): ReplyPreview {
    return {
        id: notice.id,
        authorName: notice.authorName,
        avatarUrl: notice.avatarUrl,
        content: notice.content.length > REF_CONTENT_TRUNCATE_LENGTH
            ? `${notice.content.slice(0, REF_CONTENT_TRUNCATE_LENGTH)}…`
            : notice.content,
        channelId: notice.channelId,
        media: notice.media
    };
}

function rememberSentReplyChain(notice: MentionNotice, sentMessage: any) {
    const sentPreview = makeReplyPreview(sentMessage);
    if (!sentPreview) return;

    sentReplyChains.set(sentPreview.id, [
        ...(notice.kind === "typing" ? [] : [...notice.replyChain, makeNoticeReplyPreview(notice)]),
        sentPreview
    ]);

    if (sentReplyChains.size > 100) sentReplyChains.delete(sentReplyChains.keys().next().value!);
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

async function hydrateNoticeReplyChain(notice: MentionNotice, sourceMessage?: any, updateStore = true): Promise<MentionNotice> {
    if (notice.kind === "reaction" || notice.kind === "typing") return notice;

    const root = sourceMessage ?? MessageStore.getMessage(notice.channelId, notice.id);
    if (!root || !getMessageReference(root)) return notice;

    const seen = new Set<string>();
    let current = root;

    while (seen.size < 8) {
        const reference = getMessageReference(current);
        const channelId = reference?.channel_id ?? reference?.channelId ?? current?.channel_id ?? current?.channelId ?? notice.channelId;
        const messageId = reference?.message_id ?? reference?.messageId;
        if (!channelId || !messageId || seen.has(messageId)) break;
        seen.add(messageId);

        const direct = current?.referenced_message ?? current?.referencedMessage;
        let referenced = MessageStore.getMessage(channelId, messageId) ?? direct;

        if (!referenced || (referenced.type === MessageType.REPLY && !getMessageReference(referenced))) {
            const response = await RestAPI.get({
                url: Constants.Endpoints.MESSAGE(channelId, messageId),
                retries: 1
            }).catch(error => {
                console.warn("[MentionsBox] Failed to load reply chain message", error);
                return null;
            });

            if (response?.body) referenced = receiveMessage(channelId, response.body);
        }

        if (!referenced) break;
        current = referenced;
    }

    const replyChain = collectReplyChain(root);
    const immediateReply = replyChain.at(-1);
    if (!immediateReply) return notice;

    const hydratedNotice = {
        ...notice,
        replyChain,
        referencedContent: immediateReply.content,
        referencedAuthorName: immediateReply.authorName
    };
    if (!updateStore) return hydratedNotice;

    const existingNotice = notices.find(currentNotice => currentNotice.id === notice.id && currentNotice.channelId === notice.channelId);
    if (existingNotice && existingNotice.replyChain.length >= replyChain.length) return existingNotice;

    setNotices(notices.map(currentNotice => currentNotice.id === notice.id && currentNotice.channelId === notice.channelId
        ? {
            ...currentNotice,
            replyChain,
            referencedContent: immediateReply.content,
            referencedAuthorName: immediateReply.authorName
        }
        : currentNotice));

    return hydratedNotice;
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

function messageMentionsUser(message: MessageJSON | any, userId: string) {
    if (userId === UserStore.getCurrentUser()?.id) {
        const messageId = message?.id ?? message?.message_id ?? message?.messageId;
        if (messageId && keywordNotifierMentionIds.has(messageId)) return true;
    }

    const { mentions } = message;
    if (Array.isArray(mentions)) {
        return mentions.some(user => (typeof user === "string" ? user : user?.id) === userId);
    }

    if (mentions instanceof Set) {
        return mentions.has(userId)
            || [...mentions].some(user => (typeof user === "string" ? user : (user as any)?.id) === userId);
    }

    return Boolean(mentions?.[userId]);
}

function isReplyToRememberedChain(message: MessageJSON | any) {
    const reference = getMessageReference(message);
    const referenceId = reference?.message_id ?? reference?.messageId;
    return Boolean(referenceId && sentReplyChains.has(referenceId));
}

function isReplyToMessageMentioningUser(message: MessageJSON | any, userId: string) {
    if (!settings.store.showRepliesToMentionedMessages) return false;

    const seen = new Set<string>();
    const reference = getMessageReference(message);
    const referenceId = reference?.message_id ?? reference?.messageId;
    if (userId === UserStore.getCurrentUser()?.id && referenceId && keywordNotifierMentionIds.has(referenceId)) return true;

    let current = getReferencedMessage(message);

    while (current && seen.size < 8) {
        const id = current.id ?? current.message_id ?? current.messageId;
        if (id) {
            if (seen.has(id)) break;
            seen.add(id);
        } else {
            seen.add(`${seen.size}`);
        }

        if (messageMentionsUser(current, userId)) return true;
        current = getReferencedMessage(current);
    }

    return false;
}

function shouldAutoReadBotMention(message: MessageJSON | any) {
    const currentUser = UserStore.getCurrentUser();

    return Boolean(
        settings.store.autoReadBotMentions
        && currentUser
        && message?.id
        && message?.author?.bot
        && message.author.id !== currentUser.id
        && messageMentionsUser(message, currentUser.id)
    );
}

function isRelevantMention(message: MessageJSON | any) {
    const currentUser = UserStore.getCurrentUser();

    if (!currentUser || !message.author || message.author.id === currentUser.id) return false;
    if (settings.store.hideBotMentions && message.author.bot) return false;

    return messageMentionsUser(message, currentUser.id)
        || isReplyToRememberedChain(message)
        || isReplyToMessageMentioningUser(message, currentUser.id);
}

function buildNoticeFromMessage(
    message: MessageJSON | any,
    fallbackChannelId?: string,
    fallbackGuildId?: string,
    knownRelevantMention = false,
    rawMessage?: any
): MentionNotice | null {
    const displayMessage = rawMessage ?? message;
    const displayAuthor = displayMessage?.author ?? message?.author;
    const messageId = displayMessage?.id ?? message?.id;
    if (!messageId || !displayAuthor?.id || (!knownRelevantMention && !isRelevantMention(displayMessage))) return null;

    const resolvedChannelId = displayMessage.channel_id ?? displayMessage.channelId ?? message.channel_id ?? message.channelId ?? fallbackChannelId;
    if (!resolvedChannelId) return null;

    const channel = ChannelStore.getChannel(resolvedChannelId);
    const guildId = channel?.guild_id ?? displayMessage.guild_id ?? message.guild_id ?? fallbackGuildId ?? null;

    if (!channel) {
        if (settings.store.hideDmMentions && !guildId) return null;
    } else if (settings.store.hideDmMentions && channel.type === ChannelType.DM) {
        return null;
    }

    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const author = UserStore.getUser(displayAuthor.id);
    const currentUser = UserStore.getCurrentUser();
    const isReplyToMentionedMessage = Boolean(
        currentUser
        && !messageMentionsUser(displayMessage, currentUser.id)
        && (isReplyToRememberedChain(displayMessage) || isReplyToMessageMentioningUser(displayMessage, currentUser.id))
    );
    const authorName = getAuthorName({
        ...displayMessage,
        author: displayAuthor
    });
    const reference = getMessageReference(displayMessage);
    const referenceId = reference?.message_id ?? reference?.messageId;
    const replyChain = (referenceId && sentReplyChains.get(referenceId)) ?? collectReplyChain(displayMessage);
    const refMsg = (displayMessage as any).referenced_message ?? (displayMessage as any).referencedMessage;
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

    const reactions = (displayMessage.reactions ?? message.reactions ?? []).map((reaction: any) => ({
        count: reaction.count ?? 0,
        me: Boolean(reaction.me || reaction.me_burst),
        emoji: reaction.emoji ?? { id: null, name: "?" }
    }));

    return {
        id: messageId,
        channelId: resolvedChannelId,
        guildId,
        authorId: displayAuthor.id,
        authorName,
        authorUsername: displayAuthor.username ?? authorName,
        authorDisplayName: (displayAuthor as any).globalName
            ?? (displayAuthor as any).global_name
            ?? displayAuthor.username
            ?? authorName,
        authorBot: Boolean(displayAuthor.bot ?? author?.bot),
        avatarUrl: author?.getAvatarURL?.(undefined, 64) ?? buildRawAvatarUrl(displayAuthor, 64),
        channelName: channel ? getChannelName(channel) : `<#${resolvedChannelId}>`,
        guildName: guild?.name,
        content: formatContent(displayMessage),
        messageText: (displayMessage.content ?? message.content ?? "").trim(),
        originalSticker: getOriginalSticker(displayMessage, message),
        referencedContent,
        referencedAuthorName,
        replyChain,
        media: collectMessageMedia(displayMessage, message),
        reactedEmojiKeys: reactions.filter(reaction => reaction.me).map(getStoredReactionKey),
        reactions,
        timestamp: getMessageTimestamp(displayMessage),
        ...(isReplyToMentionedMessage ? { kind: "reply-to-mention" as const } : {})
    };
}

function buildNoticeFromReaction(payload: MessageReactionPayload): MentionNotice | null {
    if (!settings.store.showReactionMentions) return null;

    const currentUser = UserStore.getCurrentUser();
    const reactorId = getReactionPayloadUserId(payload);
    const channelId = getReactionPayloadChannelId(payload);
    const messageId = getReactionPayloadMessageId(payload);
    if (!currentUser || !reactorId || !channelId || !messageId || reactorId === currentUser.id) return null;

    const message = MessageStore.getMessage(channelId, messageId) as any;
    const messageAuthorId = message?.author?.id ?? message?.authorId;
    if (messageAuthorId !== currentUser.id) return null;

    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id ?? getReactionPayloadGuildId(payload) ?? message?.guild_id ?? message?.guildId ?? null;
    if (settings.store.hideDmMentions && (!channel || channel.type === ChannelType.DM)) return null;

    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const reactor = UserStore.getUser(reactorId);
    if (settings.store.hideBotMentions && reactor?.bot) return null;

    const authorName = RelationshipStore.getNickname(reactorId)
        ?? (reactor as any)?.globalName
        ?? (reactor as any)?.global_name
        ?? reactor?.username
        ?? "Someone";
    const originalContent = formatContent(message as MessageJSON);
    const originalSticker = getOriginalSticker(message);
    const reactions = (message.reactions ?? []).map((reaction: any) => ({
        count: reaction.count ?? 0,
        me: Boolean(reaction.me || reaction.me_burst),
        emoji: {
            id: reaction.emoji?.id ?? null,
            name: reaction.emoji?.name ?? "?",
            animated: reaction.emoji?.animated
        }
    }));

    return {
        id: messageId,
        channelId,
        guildId,
        authorId: reactorId,
        authorName,
        authorUsername: reactor?.username ?? authorName,
        authorDisplayName: (reactor as any)?.globalName
            ?? (reactor as any)?.global_name
            ?? reactor?.username
            ?? authorName,
        authorBot: Boolean(reactor?.bot),
        avatarUrl: reactor?.getAvatarURL?.(undefined, 64),
        channelName: channel ? getChannelName(channel) : `<#${channelId}>`,
        guildName: guild?.name,
        content: "reacted to your message",
        ...(originalSticker ? { messageText: "", originalSticker } : {}),
        referencedContent: originalContent,
        referencedAuthorName: "You",
        replyChain: [],
        media: collectMessageMedia(message),
        reactedEmojiKeys: [],
        reactions,
        timestamp: Date.now(),
        kind: "reaction"
    };
}

function buildNoticeFromTyping(payload: TypingStartPayload): MentionNotice | null {
    if (!settings.store.showDmTypingMentions) return null;

    const channelId = payload.channelId ?? payload.channel_id;
    const userId = payload.userId ?? payload.user_id;
    const currentUser = UserStore.getCurrentUser();
    if (!channelId || !userId || !currentUser || userId === currentUser.id) return null;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel || channel.type !== ChannelType.DM) return null;

    const user = UserStore.getUser(userId);
    if (settings.store.hideBotMentions && user?.bot) return null;

    const authorName = RelationshipStore.getNickname(userId)
        ?? user?.globalName
        ?? user?.username
        ?? "Someone";

    return {
        id: `typing:${channelId}:${userId}`,
        channelId,
        guildId: null,
        authorId: userId,
        authorName,
        authorUsername: user?.username ?? authorName,
        authorDisplayName: user?.globalName ?? user?.username ?? authorName,
        authorBot: Boolean(user?.bot),
        avatarUrl: user?.getAvatarURL?.(undefined, 64),
        channelName: getChannelName(channel),
        content: "is typing in your DMs…",
        replyChain: [],
        media: [],
        reactedEmojiKeys: [],
        reactions: [],
        timestamp: Date.now(),
        kind: "typing"
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

    return `${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/emojis/${emoji.id}.webp?size=32&animated=true`;
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
    setNoticeReactionState(notice.id, emojiKey, isReacted, emoji);

    try {
        if (isReacted) await RestAPI.put(request);
        else await RestAPI.del(request);
        markNoticeRead(notice);
        startExternalReactionDismiss(notice.id, notice.channelId);
    } catch (error) {
        setNoticeReactionState(notice.id, emojiKey, !isReacted, emoji);
        console.error("[MentionsBox] Failed to update reaction", error);
    }
}

function isVoiceReplyFile(file: ReplyFile) {
    return Boolean(file.waveform) && typeof file.durationSecs === "number";
}

async function copyVoiceMessageFile(media: MessageMediaPreview): Promise<ReplyFile> {
    if (media.kind !== "audio" || !media.waveform || typeof media.durationSecs !== "number") {
        throw new Error("Voice note metadata is unavailable");
    }

    const response = await fetch(media.originalUrl ?? media.url);
    if (!response.ok) throw new Error(`Failed to download voice note (${response.status})`);

    const blob = await response.blob();
    return Object.assign(
        new File([blob], media.filename ?? "voice-message.ogg", {
            type: blob.type || "audio/ogg; codecs=opus"
        }),
        {
            waveform: media.waveform,
            durationSecs: media.durationSecs
        }
    );
}

async function uploadReplyAttachment(file: ReplyFile, channelId: string) {
    const upload = new CloudUpload({
        file,
        isThumbnail: false,
        platform: CloudUploadPlatform.WEB
    }, channelId);
    upload.waveform = file.waveform;
    upload.durationSecs = file.durationSecs;

    return new Promise<TCloudUpload>((resolve, reject) => {
        upload.on("complete", () => resolve(upload));
        upload.on("error", reject);
        upload.upload().catch(reject);
    });
}

async function sendReplyToNotice(notice: MentionNotice, content: string, stickerIds: string[] = [], uploads: TCloudUpload[] = []) {
    const isTypingNotice = notice.kind === "typing";
    const isVoiceMessage = uploads.length === 1
        && Boolean(uploads[0].waveform)
        && typeof uploads[0].durationSecs === "number";
    const messageReference: ReplyMessageReference | null = isTypingNotice ? null : {
            channel_id: notice.channelId,
            message_id: notice.id
        };
    if (notice.guildId && messageReference) messageReference.guild_id = notice.guildId;

    const response = await RestAPI.post({
        url: Constants.Endpoints.MESSAGES(notice.channelId),
        body: {
            allowed_mentions: {
                parse: [],
                replied_user: true
            },
            attachments: uploads.map((upload, index) => ({
                id: String(index),
                filename: upload.filename,
                uploaded_filename: upload.uploadedFilename,
                ...(isVoiceMessage ? {
                    waveform: upload.waveform,
                    duration_secs: upload.durationSecs
                } : {})
            })),
            channel_id: notice.channelId,
            content: isVoiceMessage ? "" : content,
            flags: isVoiceMessage ? MessageFlags.IS_VOICE_MESSAGE : 0,
            ...(messageReference ? { message_reference: messageReference } : {}),
            nonce: `${Date.now()}`,
            ...(isVoiceMessage ? { sticker_ids: [] } : stickerIds.length > 0 ? { sticker_ids: stickerIds } : {}),
            tts: false,
            type: 0
        }
    });

    rememberSentReplyChain(notice, response?.body ?? response);
    return String(response?.body?.id ?? response?.id ?? "");
}

async function editReplyToNotice(notice: MentionNotice, content: string, entry: NoticeUndoEntry) {
    const messageId = entry.sentMessageId ?? await entry.sendPromise;
    if (!messageId && entry.sendFailed) return null;
    if (!messageId) throw new Error("The original reply has no message ID");
    await RestAPI.patch({
        url: `/channels/${notice.channelId}/messages/${messageId}`,
        body: { content, allowed_mentions: { parse: [], replied_user: true } }
    });
    entry.sentMessageId = messageId;
    return messageId;
}

function wait(ms: number) {
    return new Promise<void>(resolve => window.setTimeout(resolve, ms));
}

function getRestErrorBody(error: any) {
    return error?.body ?? error?.response?.body ?? error?.data ?? null;
}

function isSendCooldownError(error: any) {
    const body = getRestErrorBody(error);
    const status = Number(error?.status ?? error?.response?.status ?? body?.status);
    const code = Number(body?.code ?? error?.code);
    const message = `${body?.message ?? error?.message ?? ""}`.toLowerCase();

    return status === 429
        || code === 20016
        || message.includes("slowmode")
        || message.includes("rate limit")
        || message.includes("rate limited");
}

async function sendReplyToNoticeWithCooldownRetry(notice: MentionNotice, content: string, stickerIds: string[] = [], files: ReplyFile[] = []) {
    const uploads = await Promise.all(files.map(file => uploadReplyAttachment(file, notice.channelId)));

    const clonedAssets: ClonedAsset[] = [];
    if (settings.store.enableCloneFallback && settings.store.cloneServerGuildId) {
        try {
            const prepared = await prepareCloneFallback(notice.channelId, content, stickerIds, settings.store.cloneServerGuildId, clonedAssets);
            content = prepared.sendContent;
            stickerIds = prepared.stickerIds;
        } catch (err) {
            console.error("[MentionsBox] Failed to prepare clone fallback", err);
        }
    }

    try {
        for (;;) {
            try {
                return await sendReplyToNotice(notice, content, stickerIds, uploads);
            } catch (error) {
                if (!isSendCooldownError(error)) throw error;
                await wait(SLOWMODE_REPLY_RETRY_DELAY_MS);
            }
        }
    } finally {
        const deleted = await Promise.allSettled(clonedAssets.map(asset =>
            asset.type === "emoji" ? deleteClonedEmoji(asset) : deleteClonedSticker(asset)
        ));
        for (const result of deleted) {
            if (result.status === "rejected") console.error("[MentionsBox] Failed to delete cloned expression", result.reason);
        }
    }
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
    return ReadStateStore.hasUnread(channelId) && isMessageAfterAck(message, channelId);
}

function getMentionLoadCutoff() {
    if (settings.store.neverExpire) return 0;
    return Date.now() - (Number(settings.store.expirationMinutes) || DEFAULT_EXPIRATION_MINUTES) * 60_000;
}

function isMessageTooOld(message: any, cutoff: number) {
    const time = Date.parse(message?.timestamp ?? "");
    return cutoff > 0 && Number.isFinite(time) && time < cutoff;
}

async function fetchRecentMentionMessages() {
    const cutoff = getMentionLoadCutoff();
    const foundMessages: LoadedRecentMentionMessage[] = [];
    let before: string | undefined;

    for (let page = 0; page < RECENT_MENTIONS_MAX_PAGES && foundMessages.length < getStoredMentionsLimit(); page++) {
        setUnreadMentionsLoading(
            true,
            foundMessages.length > 0
                ? `Scanning for unread mentions… (${foundMessages.length} found)`
                : "Scanning for unread mentions…"
        );

        const response = await RestAPI.get({
            url: RECENT_MENTIONS_ENDPOINT,
            query: {
                limit: RECENT_MENTIONS_PAGE_LIMIT,
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
            if (isMessageTooOld(rawMessage, cutoff)) continue;
            if (!isUnreadMentionMessage(rawMessage, channelId)) continue;
            if (dismissedNoticeIds.has(rawMessage.id)) continue;
            if (shouldAutoReadBotMention(rawMessage)) {
                markMessageRead(channelId, rawMessage.id);
                dismissedNoticeIds.add(rawMessage.id);
                continue;
            }
            if (!isRelevantMention(rawMessage)) continue;

            const message = receiveMessage(channelId, rawMessage);
            if (!message.reactions && rawMessage.reactions?.length) {
                (message as any).reactions = rawMessage.reactions;
            }

            foundMessages.push({
                processed: message,
                raw: rawMessage
            });
        }

        const oldestFetched = batch.at(-1);
        if (!oldestFetched || batch.length < RECENT_MENTIONS_PAGE_LIMIT || isMessageTooOld(oldestFetched, cutoff)) break;
        before = oldestFetched.id;
    }

    return foundMessages;
}

async function fetchKeywordNotifierMentionMessages() {
    const currentUser = UserStore.getCurrentUser();
    if (!currentUser) return [];

    const foundMessages: LoadedRecentMentionMessage[] = [];
    const keywordMessages = await getKeywordNotifierMessages();
    keywordNotifierMentionIds = new Set(
        keywordMessages.map(message => message.id ?? message.message_id ?? message.messageId).filter(Boolean)
    );

    const cutoff = getMentionLoadCutoff();
    for (const rawMessage of keywordMessages) {
        const channelId = rawMessage.channel_id ?? rawMessage.channelId;
        if (isMessageTooOld(rawMessage, cutoff)) continue;
        if (!channelId || !isUnreadMentionMessage(rawMessage, channelId)) continue;
        if (dismissedNoticeIds.has(rawMessage.id)) continue;
        if (shouldAutoReadBotMention(rawMessage)) {
            markMessageRead(channelId, rawMessage.id);
            dismissedNoticeIds.add(rawMessage.id);
            continue;
        }

        rawMessage.mentions ??= [];
        if (Array.isArray(rawMessage.mentions) && !rawMessage.mentions.some((mention: any) => (mention?.id ?? mention) === currentUser.id)) {
            rawMessage.mentions.push({ id: currentUser.id });
        }
        if (!isRelevantMention(rawMessage)) continue;

        foundMessages.push({
            processed: receiveMessage(channelId, rawMessage),
            raw: rawMessage
        });
    }

    return foundMessages;
}

function refreshReadStatePayload(payload: any, delay = 150) {
    scheduleUnreadMentionsLoad(delay, Boolean(payload));
}

async function loadUnreadMentions() {
    if (isUnreadMentionsLoadRunning) {
        shouldRunUnreadMentionsLoadAgain = true;
        return;
    }
    isUnreadMentionsLoadRunning = true;
    setUnreadMentionsLoading(true, "Scanning for unread mentions…");
    const unreadNotices: MentionNotice[] = [];

    try {
        const loadedMessages = [
            ...await fetchRecentMentionMessages(),
            ...await fetchKeywordNotifierMentionMessages()
        ];
        const seenMessageIds = new Set<string>();
        const sourceMessages = new Map<string, any>();

        for (const { processed, raw } of loadedMessages) {
            if (raw.id && seenMessageIds.has(raw.id)) continue;
            if (raw.id) seenMessageIds.add(raw.id);

            const channelId = raw.channel_id ?? raw.channelId ?? processed.channel_id ?? processed.channelId;
            const channel = channelId ? ChannelStore.getChannel(channelId) : null;
            const notice = buildNoticeFromMessage(
                processed,
                channelId,
                raw.guild_id ?? channel?.guild_id ?? undefined,
                true,
                raw
            );
            if (notice) {
                unreadNotices.push(notice);
                sourceMessages.set(notice.id, raw);
            }
        }

        const hydratedNotices = await Promise.all(unreadNotices.map(notice =>
            hydrateNoticeReplyChain(notice, sourceMessages.get(notice.id), false)
        ));
        syncUnreadNotices(hydratedNotices);
    } catch (error) {
        console.error("[MentionsBox] Failed to load unread mentions", error);
    } finally {
        isUnreadMentionsLoadRunning = false;
        setUnreadMentionsLoading(false);
        if (shouldRunUnreadMentionsLoadAgain) {
            shouldRunUnreadMentionsLoadAgain = false;
            scheduleUnreadMentionsLoad(250, true);
        }
    }
}

function scheduleUnreadMentionsLoad(delay = 500, showLoading = false) {
    if (showLoading) setUnreadMentionsLoading(true, "Queueing recent mentions refresh…");

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

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey && !isTypingTarget(event.target)) {
        const entry = discardedNoticeHistory.pop();
        if (entry) {
            event.preventDefault();
            event.stopPropagation();
            dismissedNoticeIds.delete(entry.notice.id);
            entry.notice = {
                ...entry.notice,
                timestamp: Date.now(),
                externalReactionDismissStartedAt: undefined,
                externalReactionDismissDurationMs: undefined
            };
            restoredReplyEntries.set(entry.notice.id, entry);
            addNotice(entry.notice, false);
        }
        return;
    }

    if (shouldHandleGlobalKeybind(event, settings.store.hideToggleKeybind)) {
        consumeGlobalKeybind(event);
        toggleNotificationsHidden(true);
        return;
    }

    if (shouldHandleGlobalKeybind(event, settings.store.dialogueModeToggleKeybind)) {
        consumeGlobalKeybind(event);
        toggleDialogueButtonMode(true);
        return;
    }

    if (shouldHandleGlobalKeybind(event, settings.store.jumpOnReplyToggleKeybind)) {
        consumeGlobalKeybind(event);
        toggleJumpOnReply(true);
        return;
    }

    if (shouldHandleGlobalKeybind(event, settings.store.sourceFilterToggleKeybind)) {
        consumeGlobalKeybind(event);
        toggleSourceFilter();
    }
};

function useNotices() {
    const [currentNotices, setCurrentNotices] = useState(getSnapshot);

    useEffect(() => subscribe(listeners, () => setCurrentNotices(getSnapshot())), []);

    return currentNotices;
}

function useNotificationsHidden() {
    const [isHidden, setIsHidden] = useState(areNotificationsHidden);

    useEffect(() => subscribe(notificationVisibilityListeners, () => setIsHidden(areNotificationsHidden)), []);

    return isHidden;
}

function useSourceFilterVisible() {
    const [isVisible, setIsVisible] = useState(isSourceFilterVisible);

    useEffect(() => subscribe(sourceFilterVisibilityListeners, () => setIsVisible(isSourceFilterVisible)), []);

    return isVisible;
}

function useKeybindToast() {
    const [toast, setToast] = useState(keybindToast);

    useEffect(() => subscribe(keybindToastListeners, () => setToast(keybindToast)), []);

    return toast;
}

function useUnreadMentionsLoading() {
    const [loadingState, setLoadingState] = useState({
        isLoading: isLoadingUnreadMentions,
        label: unreadMentionsLoadingLabel
    });

    useEffect(() => subscribe(unreadMentionsLoadingListeners, () => setLoadingState({
        isLoading: isLoadingUnreadMentions,
        label: unreadMentionsLoadingLabel
    })), []);

    return loadingState;
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
        const results = getEmojiSearchResults((EmojiStore as any).searchWithoutFetchingLatest?.({
            query: trimmedQuery,
            count,
            guildId: guildId ?? undefined,
            includeExternalGuilds: true,
            includeUnavailableGuilds: true,
            includeUnicodeEmoji: true,
            type: "CHAT"
        }));
        const globalResults = guildId
            ? getEmojiSearchResults((EmojiStore as any).searchWithoutFetchingLatest?.({
                query: trimmedQuery,
                count,
                includeExternalGuilds: true,
                includeUnavailableGuilds: true,
                includeUnicodeEmoji: true,
                type: "CHAT"
            }))
            : [];
        const seen = new Set<string>();

        return [...results, ...globalResults].filter(emoji => {
            const key = getEmojiKey(emoji);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, count);
    } catch {
        return [];
    }
}

function dedupeEmojis(emojis: Emoji[]) {
    const seen = new Set<string>();

    return emojis.filter(emoji => {
        const key = getEmojiKey(emoji);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeMessageCopyingRule(rule: Partial<MessageCopyingRule>, index: number): MessageCopyingRule {
    return {
        id: rule.id || crypto.randomUUID?.() || `message-copying-rule-${index}`,
        pattern: typeof rule.pattern === "string" ? rule.pattern : "",
        flags: typeof rule.flags === "string" ? rule.flags : "gi",
        replacement: typeof rule.replacement === "string" ? rule.replacement : ""
    };
}

function getMessageCopyingRules(): MessageCopyingRule[] {
    const saved = settings.store.messageCopyingRules;
    if (!Array.isArray(saved)) return DEFAULT_MESSAGE_COPYING_RULES;

    return saved.map(normalizeMessageCopyingRule);
}

function applyMessageCopyingRules(content: string, replacements: Record<string, string>) {
    return getMessageCopyingRules().reduce((result, rule) => {
        if (!rule.pattern) return result;

        try {
            const replacement = resolveReplyPlaceholders(rule.replacement, replacements);
            return result.replace(new RegExp(rule.pattern, rule.flags), () => replacement);
        } catch {
            return result;
        }
    }, content);
}

function getReplyPlaceholderReplacements(notice: MentionNotice): Record<string, string> {
    const me = UserStore.getCurrentUser();
    const meNickname = me?.id ? RelationshipStore.getNickname(me.id) : null;
    const authorServerNickname = notice.guildId ? GuildMemberStore.getMember(notice.guildId, notice.authorId)?.nick : null;
    const meServerNickname = notice.guildId && me?.id ? GuildMemberStore.getMember(notice.guildId, me.id)?.nick : null;
    const meDisplayName = (me as any)?.globalName ?? (me as any)?.global_name ?? me?.username ?? "me";
    const meName = meNickname ?? meDisplayName;
    const messageLink = `https://discord.com/channels/${notice.guildId ?? "@me"}/${notice.channelId}/${notice.id}`;

    const replacements: Record<string, string> = {
        "server.name": notice.guildName ?? "Direct Messages",
        "channel.name": notice.channelName,
        "channel.id": notice.channelId,
        "message.id": notice.id,
        "message.link": messageLink,
        "message.content": notice.messageText ?? notice.content,
        "reply.content": notice.referencedContent ?? "",
        "reply.author.name": notice.referencedAuthorName ?? "",
        "replied-user.name": notice.authorName,
        "replied-user.nickname": notice.authorName,
        "replied-user.servernickname": authorServerNickname ?? notice.authorName,
        "replied-user.username": notice.authorUsername,
        "replied-user.displayname": notice.authorDisplayName,
        "replied-user.display-name": notice.authorDisplayName,
        "replied-user.id": notice.authorId,
        "author.name": notice.authorName,
        "author.nickname": notice.authorName,
        "author.servernickname": authorServerNickname ?? notice.authorName,
        "author.username": notice.authorUsername,
        "author.displayname": notice.authorDisplayName,
        "author.display-name": notice.authorDisplayName,
        "author.id": notice.authorId,
        "me.name": meName,
        "me.nickname": meNickname ?? meName,
        "me.servernickname": meServerNickname ?? meName,
        "me.username": me?.username ?? meName,
        "me.displayname": meDisplayName,
        "me.display-name": meName,
        "me.id": me?.id ?? ""
    };

    replacements["message.content"] = applyMessageCopyingRules(replacements["message.content"], replacements);
    return replacements;
}

function resolveInteractionReply(content: string, notice: MentionNotice) {
    return resolveReplyPlaceholders(content, getReplyPlaceholderReplacements(notice));
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

function makeEmptyMessageCopyingRule(): MessageCopyingRule {
    return {
        id: crypto.randomUUID(),
        pattern: "",
        flags: "gi",
        replacement: ""
    };
}

type KeybindSetting = "hideToggleKeybind" | "dialogueModeToggleKeybind" | "jumpOnReplyToggleKeybind" | "sourceFilterToggleKeybind" | "replyChainToggleKeybind";

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
            <KeybindInput label="Toggle jump on reply" settingKey="jumpOnReplyToggleKeybind" defaultKeybind={DEFAULT_JUMP_ON_REPLY_TOGGLE_KEYBIND} />
            <KeybindInput label="Toggle server and DM filter" settingKey="sourceFilterToggleKeybind" defaultKeybind={DEFAULT_SOURCE_FILTER_TOGGLE_KEYBIND} />
            <KeybindInput label="Toggle focused reply chain" settingKey="replyChainToggleKeybind" defaultKeybind={DEFAULT_REPLY_CHAIN_TOGGLE_KEYBIND} />
        </div>
    );
}

function PlaceholderOrderSettings() {
    const [, forceUpdate] = useState(0);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const order = getPlaceholderOrder();
    const enabledPlaceholders = order
        .map(key => REPLY_PLACEHOLDERS.find(placeholder => placeholder.key === key))
        .filter(Boolean) as typeof REPLY_PLACEHOLDERS;
    const disabledPlaceholders = REPLY_PLACEHOLDERS.filter(placeholder => !order.includes(placeholder.key));
    const selectedIndex = order.findIndex(key => key === selectedKey);
    const selectedPlaceholder = REPLY_PLACEHOLDERS.find(placeholder => placeholder.key === selectedKey);

    function setOrder(next: string[]) {
        settings.store.placeholderOrder = next;
        if (selectedKey && !next.includes(selectedKey)) setSelectedKey(next[Math.min(selectedIndex, next.length - 1)] ?? null);
        forceUpdate(version => version + 1);
    }

    function moveSelected(direction: -1 | 1) {
        const target = selectedIndex + direction;
        if (selectedIndex < 0 || target < 0 || target >= order.length) return;

        const next = [...order];
        [next[selectedIndex], next[target]] = [next[target], next[selectedIndex]];
        setOrder(next);
    }

    return (
        <div className="vc-mentions-box-settings">
            <div>
                <div className="vc-mentions-box-settings-heading">Placeholder autocomplete order</div>
                <div className="vc-mentions-box-settings-description">
                    Move placeholders left/right to change tab-autocomplete priority. Disabled placeholders stay hidden.
                </div>
            </div>
            <div className="vc-mentions-box-settings-subheading">Enabled placeholders</div>
            <div className="vc-mentions-box-settings-preview" aria-label="Enabled placeholder order">
                {enabledPlaceholders.length ? enabledPlaceholders.map(placeholder => (
                    <button
                        className={`vc-mentions-box-settings-preview-button${placeholder.key === selectedKey ? " vc-mentions-box-settings-preview-button-selected" : ""}`}
                        key={placeholder.key}
                        type="button"
                        onClick={() => setSelectedKey(placeholder.key)}
                        title={placeholder.description}
                    >
                        {`{${placeholder.key}}`}
                    </button>
                )) : (
                    <div className="vc-mentions-box-settings-empty">No placeholders enabled.</div>
                )}
            </div>
            {selectedPlaceholder && selectedIndex !== -1 && (
                <div className="vc-mentions-box-settings-editor">
                    <div className="vc-mentions-box-settings-description">
                        <strong>{selectedPlaceholder.label}</strong> — {selectedPlaceholder.description}
                    </div>
                    <div className="vc-mentions-box-settings-editor-actions">
                        <button
                            className="vc-mentions-box-settings-move"
                            type="button"
                            disabled={selectedIndex === 0}
                            onClick={() => moveSelected(-1)}
                        >
                            Move left
                        </button>
                        <button
                            className="vc-mentions-box-settings-move"
                            type="button"
                            disabled={selectedIndex === order.length - 1}
                            onClick={() => moveSelected(1)}
                        >
                            Move right
                        </button>
                        <button
                            className="vc-mentions-box-settings-remove"
                            type="button"
                            onClick={() => setOrder(order.filter(key => key !== selectedPlaceholder.key))}
                        >
                            Disable selected
                        </button>
                    </div>
                </div>
            )}
            <div className="vc-mentions-box-settings-subheading">Disabled placeholders</div>
            <div className="vc-mentions-box-settings-preview" aria-label="Disabled placeholders">
                {disabledPlaceholders.length ? disabledPlaceholders.map(placeholder => (
                    <button
                        className="vc-mentions-box-settings-preview-button vc-mentions-box-settings-preview-button-disabled"
                        key={placeholder.key}
                        type="button"
                        onClick={() => setOrder([...order, placeholder.key])}
                        title={`Enable ${placeholder.label}`}
                    >
                        {`{${placeholder.key}}`}
                    </button>
                )) : (
                    <div className="vc-mentions-box-settings-empty">No disabled placeholders.</div>
                )}
            </div>
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

const MESSAGE_COPYING_PREVIEW_REPLACEMENTS: Record<string, string> = {
    ...Object.fromEntries(REPLY_PLACEHOLDERS.map(placeholder => [placeholder.key, placeholder.label])),
    "author.display-name": "Author display name",
    "me.display-name": "Your display name",
    "replied-user.name": "Author name",
    "replied-user.nickname": "Author nickname",
    "replied-user.servernickname": "Server nickname",
    "replied-user.username": "Author username",
    "replied-user.displayname": "Author display name",
    "replied-user.display-name": "Author display name",
    "replied-user.id": "Author ID"
};
const MESSAGE_COPYING_PLACEHOLDER_KEYS = new Set(Object.keys(MESSAGE_COPYING_PREVIEW_REPLACEMENTS));

function MessageCopyingSettings() {
    const [, forceUpdate] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [testMessage, setTestMessage] = useState("how are you dean?");
    const rules = getMessageCopyingRules();
    const selectedIndex = Math.max(0, rules.findIndex(rule => rule.id === selectedId));
    const selectedRule = rules[selectedIndex];
    const replacementPlaceholders = selectedRule
        ? Array.from(selectedRule.replacement.matchAll(/\{([^}]+)\}/g), match => ({ key: match[1], token: match[0] }))
        : [];
    const resolvedPreviewReplacement = selectedRule
        ? resolveReplyPlaceholders(selectedRule.replacement, MESSAGE_COPYING_PREVIEW_REPLACEMENTS)
        : "";
    let previewAfter = testMessage;
    let previewMatches: RegExpMatchArray[] = [];
    let previewError = "";

    if (selectedRule?.pattern) {
        try {
            const regex = new RegExp(selectedRule.pattern, selectedRule.flags);
            previewAfter = testMessage.replace(regex, () => resolvedPreviewReplacement);
            if (regex.global) {
                previewMatches = Array.from(testMessage.matchAll(regex)) as RegExpMatchArray[];
                previewMatches = previewMatches.filter(match => match[0]);
            } else {
                const match = regex.exec(testMessage);
                previewMatches = match?.[0] ? [match] : [];
            }
        } catch (error) {
            previewError = error instanceof Error ? error.message : "Invalid regular expression";
        }
    }

    function setRules(next: MessageCopyingRule[]) {
        settings.store.messageCopyingRules = next;
        if (next.length && (!selectedId || !next.some(rule => rule.id === selectedId))) {
            setSelectedId(next[Math.min(selectedIndex, next.length - 1)].id);
        }
        forceUpdate(version => version + 1);
    }

    function updateRule(index: number, patch: Partial<MessageCopyingRule>) {
        setRules(rules.map((rule, idx) => idx === index ? { ...rule, ...patch } : rule));
    }

    function moveRule(index: number, direction: -1 | 1) {
        const target = index + direction;
        if (target < 0 || target >= rules.length) return;

        const next = [...rules];
        [next[index], next[target]] = [next[target], next[index]];
        setRules(next);
    }

    function addRule() {
        const rule = makeEmptyMessageCopyingRule();
        setRules([...rules, rule]);
        setSelectedId(rule.id);
    }

    function removeSelectedRule() {
        if (!selectedRule) return;

        const next = rules.filter(rule => rule.id !== selectedRule.id);
        setRules(next);
        setSelectedId(next[Math.min(selectedIndex, next.length - 1)]?.id ?? null);
    }

    function renderHighlightedPreview() {
        if (!previewMatches.length) return testMessage;

        const parts: React.ReactNode[] = [];
        let cursor = 0;
        for (const match of previewMatches) {
            const start = match.index ?? 0;
            parts.push(testMessage.slice(cursor, start));
            parts.push(<span className="vc-mentions-box-settings-copy-highlight" key={`${start}-${match[0]}`}>{match[0]}</span>);
            cursor = start + match[0].length;
        }
        parts.push(testMessage.slice(cursor));
        return parts;
    }

    function renderHighlightedAfterPreview() {
        if (!previewMatches.length || !resolvedPreviewReplacement) return previewAfter;

        const start = previewAfter.indexOf(resolvedPreviewReplacement, previewMatches[0].index ?? 0);
        if (start === -1) return previewAfter;

        return (
            <>
                {previewAfter.slice(0, start)}
                <span className="vc-mentions-box-settings-copy-inserted">{resolvedPreviewReplacement}</span>
                {previewAfter.slice(start + resolvedPreviewReplacement.length)}
            </>
        );
    }

    return (
        <div className="vc-mentions-box-settings">
            <div>
                <div className="vc-mentions-box-settings-heading">Message Copying - Replace Custom Words</div>
                <div className="vc-mentions-box-settings-description">
                    Replace words in the original message when using the message.content placeholder.
                </div>
            </div>
            <div className="vc-mentions-box-settings-subheading">Rules and order</div>
            <div className="vc-mentions-box-settings-preview" aria-label="Message copying rules">
                {rules.length ? rules.map((rule, index) => (
                    <button
                        className={`vc-mentions-box-settings-preview-button${rule.id === selectedRule?.id ? " vc-mentions-box-settings-preview-button-selected" : ""}`}
                        key={rule.id}
                        type="button"
                        onClick={() => setSelectedId(rule.id)}
                    >
                        {rule.pattern || `Rule ${index + 1}`}
                    </button>
                )) : (
                    <div className="vc-mentions-box-settings-empty">No replacement rules yet.</div>
                )}
            </div>
            <button
                className="vc-mentions-box-settings-add"
                type="button"
                onClick={addRule}
            >
                Add rule
            </button>
            {selectedRule && (
                <div className="vc-mentions-box-settings-editor">
                    <div className="vc-mentions-box-settings-rule">
                        <input
                            className="vc-mentions-box-settings-input"
                            value={selectedRule.pattern}
                            onChange={event => updateRule(selectedIndex, { pattern: event.currentTarget.value })}
                            placeholder="Regex pattern"
                            aria-label="Regex pattern"
                        />
                        <input
                            className="vc-mentions-box-settings-input"
                            value={selectedRule.flags}
                            onChange={event => updateRule(selectedIndex, { flags: event.currentTarget.value })}
                            placeholder="Flags"
                            aria-label="Regex flags"
                        />
                        <div className="vc-mentions-box-settings-replacement">
                            <input
                                className="vc-mentions-box-settings-input"
                                value={selectedRule.replacement}
                                onChange={event => updateRule(selectedIndex, { replacement: event.currentTarget.value })}
                                placeholder="Replacement or {author.nickname}"
                                aria-label="Replacement"
                            />
                            {replacementPlaceholders.length > 0 && (
                                <div className="vc-mentions-box-settings-placeholder-badges">
                                    {replacementPlaceholders.map((placeholder, index) => (
                                        <span
                                            className={`vc-mentions-box-settings-placeholder-pill ${MESSAGE_COPYING_PLACEHOLDER_KEYS.has(placeholder.key)
                                                ? "vc-mentions-box-settings-placeholder-valid"
                                                : "vc-mentions-box-settings-error"}`}
                                            key={`${placeholder.token}-${index}`}
                                        >
                                            {placeholder.token}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    {previewError && <div className="vc-mentions-box-settings-error">{previewError}</div>}
                    <div className="vc-mentions-box-settings-editor-actions">
                        <button
                            className="vc-mentions-box-settings-move"
                            type="button"
                            disabled={selectedIndex === 0}
                            onClick={() => moveRule(selectedIndex, -1)}
                        >
                            Move left
                        </button>
                        <button
                            className="vc-mentions-box-settings-move"
                            type="button"
                            disabled={selectedIndex === rules.length - 1}
                            onClick={() => moveRule(selectedIndex, 1)}
                        >
                            Move right
                        </button>
                        <button
                            className="vc-mentions-box-settings-remove"
                            type="button"
                            onClick={removeSelectedRule}
                        >
                            Remove selected
                        </button>
                    </div>
                </div>
            )}
            <div className="vc-mentions-box-settings-subheading">Preview</div>
            <input
                className="vc-mentions-box-settings-input"
                value={testMessage}
                onChange={event => setTestMessage(event.currentTarget.value)}
                placeholder="Test message"
                aria-label="Test message"
            />
            <div className="vc-mentions-box-settings-copy-preview">
                <div>
                    <div className="vc-mentions-box-settings-subheading">Before</div>
                    <div className="vc-mentions-box-settings-copy-output">{renderHighlightedPreview()}</div>
                </div>
                <div>
                    <div className="vc-mentions-box-settings-subheading">After</div>
                    <div className="vc-mentions-box-settings-copy-output">{renderHighlightedAfterPreview()}</div>
                </div>
            </div>
        </div>
    );
}

const MENTION_OR_EMOJI_TOKEN_REGEX = /<@!?\d+>|<a?:\w+:\d+>/g;

function getReplyNodeRawText(node: ChildNode): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        return Array.from(node.childNodes, (child, index) => {
            const blockBreak = child instanceof HTMLElement && ["DIV", "P"].includes(child.tagName) && index > 0;
            return `${blockBreak ? "\n" : ""}${getReplyNodeRawText(child)}`;
        }).join("");
    }
    if (!(node instanceof HTMLElement)) return node.textContent ?? "";

    const raw = node.getAttribute("data-raw");
    if (raw !== null) return raw;
    if (node.tagName === "BR") return "\n";
    let result = "";
    for (const [index, child] of Array.from(node.childNodes).entries()) {
        if (child instanceof HTMLElement && ["DIV", "P"].includes(child.tagName) && index > 0) result += "\n";
        result += getReplyNodeRawText(child);
    }
    return result;
}

function serializeReplyContent(container: HTMLElement) {
    if (container.childNodes.length === 1 && (container.firstChild as HTMLElement)?.tagName === "BR") return "";
    return getReplyNodeRawText(container);
}

function getUnicodeEmoji(value: string) {
    const name = EmojiParser.convertSurrogateToName(value, false);
    const emoji = name ? EmojiParser.getByName(name) : null;
    return emoji?.type === 0 && getEmojiImageUrl(emoji) ? emoji : null;
}

function appendReplyText(text: string, container: HTMLElement) {
    const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
    for (const { segment } of segments) {
        const unicodeEmoji = getUnicodeEmoji(segment);
        if (!unicodeEmoji) {
            container.appendChild(document.createTextNode(segment));
            continue;
        }

        const emoji = document.createElement("span");
        emoji.contentEditable = "false";
        emoji.dataset.raw = segment;
        emoji.className = "vc-mentions-box-reply-token";
        const image = document.createElement("img");
        image.className = "vc-mentions-box-reply-token-emoji";
        image.src = getEmojiImageUrl(unicodeEmoji);
        image.alt = segment;
        image.draggable = false;
        emoji.appendChild(image);
        container.appendChild(emoji);
    }
}

function buildReplyEditorDom(raw: string, container: HTMLElement) {
    container.replaceChildren();

    const appendText = (text: string) => {
        const lines = text.split("\n");
        lines.forEach((line, index) => {
            if (line) appendReplyText(line, container);
            if (index < lines.length - 1) container.appendChild(document.createElement("br"));
        });
    };

    let lastIndex = 0;
    for (const match of raw.matchAll(MENTION_OR_EMOJI_TOKEN_REGEX)) {
        const token = match[0];
        const index = match.index ?? 0;
        appendText(raw.slice(lastIndex, index));

        if (token.startsWith("<@")) {
            const id = token.match(/\d+/)?.[0] ?? "";
            const user = UserStore.getUser(id);
            const displayName = (container.dataset.guildId ? GuildMemberStore.getMember(container.dataset.guildId, id)?.nick : null)
                ?? RelationshipStore.getNickname(id)
                ?? user?.globalName
                ?? user?.username
                ?? id;
            const mention = document.createElement("span");
            mention.contentEditable = "false";
            mention.dataset.raw = token;
            mention.className = "mention interactive vc-mentions-box-reply-token vc-mentions-box-reply-token-mention";
            mention.textContent = `@${displayName}`;
            container.appendChild(mention);
        } else {
            const [, animated, name, id] = token.match(/^<(a?):(\w+):(\d+)>$/) ?? [];
            const emoji = document.createElement("span");
            const image = document.createElement("img");
            emoji.contentEditable = "false";
            emoji.dataset.raw = token;
            emoji.className = "vc-mentions-box-reply-token";
            image.className = "vc-mentions-box-reply-token-emoji";
            image.src = getEmojiImageUrl({ id, name, animated: Boolean(animated) } as Emoji);
            image.alt = `:${name}:`;
            image.draggable = false;
            emoji.appendChild(image);
            container.appendChild(emoji);
        }

        lastIndex = index + token.length;
    }

    appendText(raw.slice(lastIndex));
}

function getReplyCursorOffset(container: HTMLElement) {
    const selection = document.getSelection();
    const anchorNode = selection?.anchorNode;
    const anchorOffset = selection?.anchorOffset ?? 0;
    if (!selection?.rangeCount || !anchorNode || (anchorNode !== container && !container.contains(anchorNode))) {
        return serializeReplyContent(container).length;
    }
    const range = document.createRange();
    range.selectNodeContents(container);
    range.setEnd(anchorNode, anchorOffset);
    return getReplyNodeRawText(range.cloneContents() as unknown as ChildNode).length;
}

function setReplyCaretOffset(container: HTMLElement, rawOffset: number) {
    const range = document.createRange();
    const point = getReplyDomPoint(container, rawOffset);
    range.setStart(point.node, point.offset);
    range.collapse(true);

    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function getReplyDomPoint(container: HTMLElement, rawOffset: number) {
    const target = Math.max(0, Math.min(rawOffset, serializeReplyContent(container).length));
    let consumed = 0;
    let result = { node: container as Node, offset: container.childNodes.length };
    const visit = (parent: Node): boolean => {
        for (const [index, child] of Array.from(parent.childNodes).entries()) {
            const before = { node: parent, offset: index };
            const after = { node: parent, offset: index + 1 };
            if (child instanceof HTMLElement && ["DIV", "P"].includes(child.tagName) && index > 0) {
                if (target <= consumed + 1) {
                    if (target === consumed) {
                        result = before;
                        return true;
                    }
                    consumed++;
                    return visit(child) || (result = { node: child, offset: 0 }, true);
                }
                consumed++;
            }
            if (child.nodeType === Node.TEXT_NODE) {
                const { length } = child.textContent ?? "";
                if (target <= consumed + length) {
                    result = { node: child, offset: target - consumed };
                    return true;
                }
                consumed += length;
            } else if (child instanceof HTMLElement && child.dataset.raw !== undefined) {
                const { length } = child.dataset.raw;
                if (target <= consumed + length) {
                    result = target === consumed ? before : after;
                    return true;
                }
                consumed += length;
            } else if (child instanceof HTMLElement && child.tagName === "BR") {
                if (target <= consumed + 1) {
                    result = target === consumed ? before : after;
                    return true;
                }
                consumed++;
            } else if (visit(child)) return true;
        }
        return false;
    };
    visit(container);
    return result;
}

function hasUnrenderedReplyToken(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        if (text.match(MENTION_OR_EMOJI_TOKEN_REGEX)) return true;
        return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text))
            .some(({ segment }) => Boolean(getUnicodeEmoji(segment)));
    }
    if (node instanceof HTMLElement && node.dataset.raw !== undefined) return false;
    return Array.from(node.childNodes).some(child => hasUnrenderedReplyToken(child));
}

function setReplySelectionOffsets(container: HTMLElement, start: number, end: number) {
    const startPoint = getReplyDomPoint(container, start);
    const endPoint = getReplyDomPoint(container, end);
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function insertReplyText(container: HTMLElement, start: number, end: number, text: string) {
    container.focus();
    setReplySelectionOffsets(container, start, end);
    if (document.execCommand("insertText", false, text)) return true;

    return false;
}

function getReplyEditorHtml(raw: string, guildId: string, channelId: string) {
    const container = document.createElement("div");
    container.dataset.guildId = guildId;
    container.dataset.channelId = channelId;
    buildReplyEditorDom(raw, container);
    return container.innerHTML;
}

function insertReplyEditorHtml(container: HTMLElement, raw: string) {
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !container.contains(range.startContainer) || !container.contains(range.endContainer)) return false;
    const prefix = document.createRange();
    prefix.selectNodeContents(container);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = getReplyNodeRawText(prefix.cloneContents() as unknown as ChildNode).length;
    const inserted = document.execCommand("insertHTML", false, getReplyEditorHtml(raw, container.dataset.guildId ?? "", container.dataset.channelId ?? ""));
    // Chromium can collapse the selection to the start when inserting atomic tokens.
    if (inserted) setReplyCaretOffset(container, start + raw.length);
    return inserted;
}

function insertReplyContent(container: HTMLElement, start: number, end: number, raw: string) {
    container.focus();
    setReplySelectionOffsets(container, start, end);
    return insertReplyEditorHtml(container, raw);
}

function insertReplyContentAtSelection(container: HTMLElement, raw: string) {
    container.focus();
    return insertReplyEditorHtml(container, raw);
}

function replaceReplyEditorContent(container: HTMLElement, raw: string) {
    container.focus();
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return insertReplyEditorHtml(container, raw);
}

function findReplyTokenAtCursor(content: string, cursorPos: number, key: "Backspace" | "Delete") {
    return Array.from(content.matchAll(MENTION_OR_EMOJI_TOKEN_REGEX)).find(match => {
        const start = match.index ?? 0;
        return key === "Backspace"
            ? start + match[0].length === cursorPos
            : start === cursorPos;
    });
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

function getClipboardFiles(data: DataTransfer) {
    const files = [...Array.from(data.files), ...Array.from(data.items)
        .filter(item => item.kind === "file")
        .map(item => item.getAsFile())
        .filter((file): file is File => file != null)];

    return [...new Map(files.map(file => [`${file.name}:${file.type}:${file.size}`, file])).values()];
}

function ReplyMediaPreview({ file, onRemove }: { file: ReplyFile; onRemove(): void; }) {
    const [previewUrl, setPreviewUrl] = useState("");
    const isImage = file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
    const isVideo = file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name);
    const isVoice = isVoiceReplyFile(file);

    useEffect(() => {
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [file]);

    return (
        <div className={`vc-mentions-box-reply-media${isVoice ? " vc-mentions-box-reply-media-voice" : ""}`}>
            {isVoice && previewUrl
                ? <div className="vc-mentions-box-reply-media-voice-player">
                    <VoiceMessage src={previewUrl} waveform={file.waveform!} />
                </div>
                : isImage && previewUrl
                ? <img src={previewUrl} alt="" />
                : isVideo && previewUrl
                    ? <video src={previewUrl} aria-hidden />
                    : <span className="vc-mentions-box-reply-media-file" aria-hidden>▧</span>}
            <span className="vc-mentions-box-reply-media-name">{file.name || "Pasted media"}</span>
            <button type="button" onClick={onRemove} aria-label={`Remove ${file.name || "pasted media"}`}>Remove</button>
        </div>
    );
}

const EMOJI_AUTOCOMPLETE_ID = "vc-mentions-box-emoji-autocomplete";

interface ReplyAutocompleteLayerProps {
    inputRef: React.RefObject<HTMLDivElement | null>;
    replyContent: string;
    placeholderMatch: ReplyPlaceholderMatch | null;
    placeholderSuggestions: ReplyPlaceholderSuggestion[];
    emojiSuggestions: Emoji[];
    selectedIndex: number;
    onSelectPlaceholder(placeholder: ReplyPlaceholderSuggestion, mode: "value" | "token"): void;
    onSelectEmoji(emoji: Emoji): void;
}

function ReplyAutocompleteLayer({
    inputRef,
    replyContent,
    placeholderMatch,
    placeholderSuggestions,
    emojiSuggestions,
    selectedIndex,
    onSelectPlaceholder,
    onSelectEmoji
}: ReplyAutocompleteLayerProps) {
    const [position, setPosition] = useState<ReplyAutocompletePosition | null>(null);

    useLayoutEffect(() => {
        let animationFrame = 0;

        function updatePosition() {
            const input = inputRef.current;
            if (!input) return;

            const rect = input.getBoundingClientRect();
            const width = Math.min(420, Math.max(320, rect.width));
            const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
            setPosition({ left, top: rect.bottom + 4, width });
        }

        function schedulePositionUpdate() {
            if (animationFrame) return;
            animationFrame = requestAnimationFrame(() => {
                animationFrame = 0;
                updatePosition();
            });
        }

        schedulePositionUpdate();
        window.addEventListener("resize", schedulePositionUpdate);
        window.addEventListener("scroll", schedulePositionUpdate, true);

        return () => {
            cancelAnimationFrame(animationFrame);
            window.removeEventListener("resize", schedulePositionUpdate);
            window.removeEventListener("scroll", schedulePositionUpdate, true);
        };
    }, [inputRef, replyContent]);

    if (placeholderMatch) {
        return (
            <PlaceholderAutocomplete
                position={position}
                query={placeholderMatch.query}
                suggestions={placeholderSuggestions}
                selectedIndex={selectedIndex}
                onSelect={onSelectPlaceholder}
            />
        );
    }

    if (!position || emojiSuggestions.length === 0) return null;

    return ReactDOM.createPortal(
        <div
            id={EMOJI_AUTOCOMPLETE_ID}
            className="vc-mentions-box-autocomplete"
            role="listbox"
            aria-label="Emoji suggestions"
            style={{ left: position.left, top: position.top, width: position.width }}
        >
            {emojiSuggestions.map((emoji, idx) => {
                const imgUrl = getEmojiImageUrl(emoji);
                return (
                    <button
                        id={`${EMOJI_AUTOCOMPLETE_ID}-${idx}`}
                        key={getEmojiKey(emoji)}
                        type="button"
                        role="option"
                        className={`vc-mentions-box-autocomplete-item${idx === selectedIndex ? " vc-mentions-box-autocomplete-item--active" : ""}`}
                        onMouseDown={event => {
                            event.preventDefault();
                            onSelectEmoji(emoji);
                        }}
                        aria-selected={idx === selectedIndex}
                    >
                        <PreviewImage
                            key={imgUrl}
                            url={imgUrl}
                            imageClass="vc-mentions-box-autocomplete-img"
                            fallbackClass={emoji.id ? "vc-mentions-box-emoji-fallback" : "vc-mentions-box-emoji-unicode"}
                            fallback={emoji.id ? getEmojiLabel(emoji) : getUnicodeEmojiSurrogates(emoji)}
                        />
                        <span className="vc-mentions-box-autocomplete-name">{getEmojiLabel(emoji)}</span>
                    </button>
                );
            })}
        </div>,
        document.body
    );
}

function ExternalReactionExpiry({ noticeId, durationMs, paused }: { noticeId: string; durationMs: number; paused: boolean; }) {
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        let animationFrame = 0;
        let currentProgress = 0;
        let lastTick = performance.now();

        const tick = (now: number) => {
            if (paused) {
                if (currentProgress !== 0) {
                    currentProgress = 0;
                    setProgress(0);
                }

                lastTick = now;
                animationFrame = requestAnimationFrame(tick);
                return;
            }

            currentProgress = Math.min(1, currentProgress + (now - lastTick) / durationMs);
            lastTick = now;
            setProgress(currentProgress);

            if (currentProgress >= 1) {
                removeNotice(noticeId);
                return;
            }

            animationFrame = requestAnimationFrame(tick);
        };

        setProgress(0);
        animationFrame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animationFrame);
    }, [durationMs, noticeId, paused]);

    return (
        <div
            className="vc-mentions-box-expire-bar"
            style={{ transform: `scaleX(${progress})` }}
            aria-hidden
        />
    );
}

function getPickerPosition(button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    const pickerW = Math.min(500, window.innerWidth <= 560 ? window.innerWidth - 28 : window.innerWidth - 48);
    const pickerH = Math.min(510, window.innerHeight - 72);
    const below = rect.bottom + 6;
    const above = rect.top - pickerH - 6;
    const top = below + pickerH + 8 <= window.innerHeight
        ? below
        : above >= 8 ? above : Math.max(8, window.innerHeight - pickerH - 8);
    const right = Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - pickerW - 8));
    return { top, right };
}

function MentionCard({ notice, onHandled }: { notice: MentionNotice; onHandled?: (id: string, focusReplyInput?: boolean, focusAfterJump?: boolean) => void; }) {
    const [replyContent, setReplyContent] = useState(() => (restoredReplyEntries.get(notice.id) ?? replyDrafts.get(notice.id))?.replyContent ?? "");
    const [isExpanded, setIsExpanded] = useState(() => settings.store.autoExpandReadMore);
    const [isReplyExpanded, setIsReplyExpanded] = useState(() => settings.store.autoViewReplyChain);
    const [isInteractionExpanded, setIsInteractionExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isFocusedWithin, setIsFocusedWithin] = useState(false);
    const [interactionSearch, setInteractionSearchRaw] = useState(
        () => settings.store.persistInteractionSearch ? sharedInteractionSearch : ""
    );
    const [cursorPos, setCursorPos] = useState(0);
    const [autocompleteIndex, setAutocompleteIndex] = useState(0);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showStickerPicker, setShowStickerPicker] = useState(false);
    const [emojiSearch, setEmojiSearch] = useState("");
    const [hoveredEmoji, setHoveredEmoji] = useState<Emoji | null>(null);
    const [selectedSticker, setSelectedSticker] = useState<SelectedReplySticker>(() => getRestoredNoticeSticker(notice));
    const [replyFiles, setReplyFiles] = useState<ReplyFile[]>(() => (restoredReplyEntries.get(notice.id) ?? replyDrafts.get(notice.id))?.files ?? []);

    useEffect(() => {
        if (!replyContent.trim() && !replyFiles.length && !selectedSticker) replyDrafts.delete(notice.id);
        else replyDrafts.set(notice.id, { replyContent, files: replyFiles, stickerIds: selectedSticker ? [selectedSticker.id] : undefined });
    }, [notice.id, replyContent, replyFiles, selectedSticker]);
    const [removedReplyImageUrls, setRemovedReplyImageUrls] = useState<string[]>([]);
    const [copiedReplyImageUrls, setCopiedReplyImageUrls] = useState<string[]>([]);
    const [isCopyingVoice, setIsCopyingVoice] = useState(false);
    const [contentOverflows, setContentOverflows] = useState(false);
    const [interactionNavIndex, setInteractionNavIndex] = useState<number | null>(null);
    const [pickerPos, setPickerPos] = useState<{ top: number; right: number; } | null>(null);
    const [stickerPickerPos, setStickerPickerPos] = useState<{ top: number; right: number; } | null>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const replyInputRef = useRef<HTMLDivElement>(null);
    const emojiPickerRef = useRef<HTMLDivElement>(null);
    const pickerTriggerRef = useRef<HTMLButtonElement>(null);
    const stickerPickerRef = useRef<HTMLDivElement>(null);
    const stickerPickerTriggerRef = useRef<HTMLButtonElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const isLocalEditRef = useRef(false);
    const pendingCaretOffsetRef = useRef<number | null>(null);
    const forceJumpOnSubmitRef = useRef(false);
    const isLong = contentOverflows || isExpanded;
    const displayContent = notice.content;
    const isTypingNotice = notice.kind === "typing";
    const replyChain = notice.replyChain ?? [];
    const voiceMessage = notice.media.find(media => media.kind === "audio");
    const hasReplayableVoiceMessage = Boolean(
        voiceMessage?.waveform
        && typeof voiceMessage.durationSecs === "number"
    );
    const hasReplyPreview = replyChain.length > 0 || Boolean(notice.referencedAuthorName);
    const { autoExpandReadMore, dialogueButtonMode, jumpToMentionOnClick, messageCopyingRules, placeholderOrder, preselectedDialogues, persistInteractionSearch, preloadMentionContext } = settings.use(["autoExpandReadMore", "dialogueButtonMode", "jumpToMentionOnClick", "messageCopyingRules", "placeholderOrder", "preselectedDialogues", "persistInteractionSearch", "preloadMentionContext"]);
    const setInteractionSearch = useCallback((value: string) => {
        if (persistInteractionSearch) setSharedInteractionSearch(value);
        setInteractionSearchRaw(value);
    }, [persistInteractionSearch]);
    const interactionReplies = (Array.isArray(preselectedDialogues) ? preselectedDialogues : DEFAULT_PRESELECTED_DIALOGUES)
        .map(normalizeDialogue)
        .filter(dialogue => dialogue.label.trim() && dialogue.content.trim())
        .map(dialogue => ({
            ...dialogue,
            copiesSticker: Boolean(notice.originalSticker && usesMessageContentPlaceholder(dialogue.content)),
            copiesImages: getReplyImageUrls(dialogue.content, notice.media).length > 0,
            content: resolveInteractionReply(dialogue.content, notice)
        }));
    const replyImageUrls = [...new Set([...getReplyImageUrls(replyContent, notice.media), ...copiedReplyImageUrls])].filter(url => !removedReplyImageUrls.includes(url));
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

    const placeholderMatch = useMemo(
        () => getReplyPlaceholderMatch(replyContent, cursorPos),
        [replyContent, cursorPos]
    );
    const placeholderReplacements = useMemo(
        () => getReplyPlaceholderReplacements(notice),
        [messageCopyingRules, notice]
    );

    const autocompleteSuggestions = useMemo<Emoji[]>(
        () => emojiMatch ? searchEmojis(emojiMatch.query, notice.guildId, 8) : [],
        [emojiMatch, notice.guildId]
    );
    const placeholderSuggestions = useMemo(
        () => placeholderMatch ? getReplyPlaceholderSuggestions(placeholderReplacements, placeholderMatch.query, getPlaceholderOrder(placeholderOrder)) : [],
        [placeholderMatch, placeholderOrder, placeholderReplacements]
    );

    useLayoutEffect(() => {
        const el = contentRef.current;
        if (!el || isExpanded) return;

        setContentOverflows(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    }, [notice.content, isExpanded]);

    useEffect(() => {
        if (preloadMentionContext) preloadNoticeContext(notice);
    }, [notice, preloadMentionContext]);
    useEffect(() => {
        if (autoExpandReadMore) setIsExpanded(true);
    }, [autoExpandReadMore]);
    useEffect(() => { setAutocompleteIndex(0); }, [autocompleteSuggestions.length, placeholderSuggestions.length]);
    useEffect(() => {
        if (!persistInteractionSearch) return;

        setInteractionSearchRaw(sharedInteractionSearch);
        return subscribe(interactionSearchListeners, () => setInteractionSearchRaw(sharedInteractionSearch));
    }, [persistInteractionSearch]);
    useEffect(() => {
        if (persistInteractionSearch) return;
        if (!isInteractionExpanded && interactionSearch) setInteractionSearch("");
    }, [isInteractionExpanded, interactionSearch, persistInteractionSearch, setInteractionSearch]);
    useLayoutEffect(() => {
        const el = replyInputRef.current;
        if (!el) return;

        if (isLocalEditRef.current) {
            isLocalEditRef.current = false;
            const pendingCaretOffset = pendingCaretOffsetRef.current;
            pendingCaretOffsetRef.current = null;
            if (pendingCaretOffset !== null) setReplyCaretOffset(el, pendingCaretOffset);
            return;
        }

        buildReplyEditorDom(replyContent, el);
        const pendingCaretOffset = pendingCaretOffsetRef.current;
        pendingCaretOffsetRef.current = null;
        if (pendingCaretOffset !== null || document.activeElement === el) {
            setReplyCaretOffset(el, pendingCaretOffset ?? replyContent.length);
        }
    }, [replyContent]);
    useEffect(() => {
        const el = replyInputRef.current;
        if (!el) return;

        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        el.style.overflowY = el.scrollHeight > 200 ? "auto" : "hidden";
    }, [replyContent]);
    useEffect(() => {
        if (!showEmojiPicker && !showStickerPicker) return;

        function handleClick(event: MouseEvent) {
            if (pickerTriggerRef.current?.contains(event.target as Node)) return;
            if (stickerPickerTriggerRef.current?.contains(event.target as Node)) return;
            if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
                setShowEmojiPicker(false);
            }
            if (stickerPickerRef.current && !stickerPickerRef.current.contains(event.target as Node)) {
                setShowStickerPicker(false);
            }
        }

        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [showEmojiPicker, showStickerPicker]);

    const quickReactionEmojis = useMemo(
        () => getQuickReactionEmojis(notice.guildId),
        [notice.guildId]
    );
    const pickerEmojis = useMemo<Emoji[]>(() => {
        const query = emojiSearch.trim();
        if (query) return searchEmojis(query, notice.guildId, 200);

        const ctx = EmojiStore.getDisambiguatedEmojiContext(notice.guildId);
        const frequent = ctx.getFrequentlyUsedReactionEmojisWithoutFetchingLatest() ?? [];
        const guildEmojis = notice.guildId ? ((EmojiStore as any).getGuildEmoji?.(notice.guildId) ?? []) : [];

        const base = dedupeEmojis([...frequent, ...guildEmojis]);
        if (base.length >= 40) return base.slice(0, 200);

        const fill = dedupeEmojis([
            ...base,
            ...searchEmojis("face", notice.guildId, 40),
            ...searchEmojis("smile", notice.guildId, 30),
            ...searchEmojis("heart", notice.guildId, 25),
            ...searchEmojis("hand", notice.guildId, 25),
            ...searchEmojis("thumbs", notice.guildId, 10),
            ...searchEmojis("fire", notice.guildId, 15),
            ...searchEmojis("star", notice.guildId, 15),
            ...searchEmojis("check", notice.guildId, 15),
            ...searchEmojis("arrow", notice.guildId, 15),
            ...searchEmojis("flag", notice.guildId, 15)
        ]);

        return fill.slice(0, 200);
    }, [emojiSearch, notice.guildId, showEmojiPicker]);

    const jumpToMention = useCallback(() => {
        markNoticeRead(notice);
        onHandled?.(notice.id);
        removeNotice(notice.id);
        jumpToNotice(notice);
    }, [notice, onHandled]);

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

        void openProfile(notice.authorId, notice);
    }, [notice]);

    const markCurrentNoticeRead = useCallback((focusNextReplyInput = false) => {
        markNoticeRead(notice);
        onHandled?.(notice.id, focusNextReplyInput);
        removeNotice(notice.id);
    }, [notice, onHandled]);

    const dismissNotice = useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        markCurrentNoticeRead();
    }, [markCurrentNoticeRead]);

    const sendReplyInBackground = useCallback((content: string, stickerIds: string[], failureMessage: string, delayMs: number, files: ReplyFile[] = [], undoEntry?: NoticeUndoEntry) => {
        const sendPromise = new Promise<string>(resolve => window.setTimeout(() => {
            void sendReplyToNoticeWithCooldownRetry(notice, content, stickerIds, files).then(messageId => {
                if (undoEntry && messageId) {
                    undoEntry.sentMessageId = messageId;
                    undoEntry.sendFailed = false;
                }
                resolve(messageId);
            }).catch(error => {
                console.error("[MentionsBox] Failed to send reply in background", error);
                if (undoEntry) {
                    undoEntry.sendFailed = true;
                    const historyIndex = discardedNoticeHistory.indexOf(undoEntry);
                    if (historyIndex !== -1) discardedNoticeHistory.splice(historyIndex, 1);
                    restoredReplyEntries.set(notice.id, undoEntry);
                }
                dismissedNoticeIds.delete(notice.id);
                addNotice({ ...notice, timestamp: Date.now() }, false);
                showKeybindSettingToast(failureMessage);
                resolve("");
            });
        }, delayMs));
        if (undoEntry) undoEntry.sendPromise = sendPromise;
    }, [notice]);

    const dispatchReply = useCallback((content: string, stickerIds: string[], files: ReplyFile[], shouldJump: boolean, failureMessage: string) => {
        const restored = restoredReplyEntries.get(notice.id);
        const sendNewReply = () => {
            markNoticeRead(notice);
            onHandled?.(notice.id, true, shouldJump);
            const undoEntry = removeNotice(notice.id, content, stickerIds, files);
            if (undoEntry) undoEntry.sendFailed = false;
            if (shouldJump) jumpToNotice(notice);
            sendReplyInBackground(content, stickerIds, failureMessage, shouldJump ? 75 : 0, files, undoEntry);
        };

        if (!restored || !shouldEditReply(restored)) {
            sendNewReply();
            return;
        }
        if (restored.isEditing) return;

        if (!replyMediaUnchanged(restored.stickerIds, stickerIds, restored.files, files)) {
            showKeybindSettingToast("Changing stickers or files is not supported while editing a restored reply. Keep its original media, or dismiss it without resending.");
            return;
        }

        if (content === restored.replyContent) {
            markNoticeRead(notice);
            onHandled?.(notice.id, true, shouldJump);
            restored.isEditing = false;
            removeNotice(notice.id, content, stickerIds, files);
            if (shouldJump) jumpToNotice(notice);
            return;
        }

        restored.isEditing = true;
        void editReplyToNotice(notice, content, restored).then(messageId => {
            if (!messageId) {
                restored.sendFailed = true;
                restored.isEditing = false;
                showKeybindSettingToast("Reply edit failed; the original message was not duplicated. Retry or dismiss to keep the draft.");
                return;
            }

            markNoticeRead(notice);
            onHandled?.(notice.id, true, shouldJump);
            restored.isEditing = false;
            const editedEntry = removeNotice(notice.id, content, stickerIds, files);
            if (editedEntry) editedEntry.sentMessageId = restored.sentMessageId;
            if (shouldJump) jumpToNotice(notice);
        }).catch(error => {
            console.error("[MentionsBox] Failed to edit restored reply", error);
            restored.isEditing = false;
            showKeybindSettingToast("Reply edit failed; your draft and original message are still here. Retry to edit the same message.");
        });
    }, [jumpToNotice, notice, onHandled, sendReplyInBackground]);

    const loadVoiceReply = useCallback(async() => {
        if (!voiceMessage || isCopyingVoice) return null;

        setIsCopyingVoice(true);
        try {
            return await copyVoiceMessageFile(voiceMessage);
        } catch (error) {
            console.error("[MentionsBox] Failed to copy voice note", error);
            showKeybindSettingToast("Failed to copy voice note.");
            return null;
        } finally {
            setIsCopyingVoice(false);
        }
    }, [isCopyingVoice, voiceMessage]);

    const copyVoiceToReply = useCallback(async() => {
        const file = await loadVoiceReply();
        if (!file) return;

        pendingCaretOffsetRef.current = 0;
        setReplyContent("");
        setCursorPos(0);
        setSelectedSticker(null);
        setReplyFiles([file]);
        requestAnimationFrame(() => replyInputRef.current?.focus());
    }, [loadVoiceReply]);

    useEffect(() => {
        setSelectedSticker(getRestoredNoticeSticker(notice));
    }, [notice.id, notice.originalSticker?.id]);

    const updateReplyFromEditor = useCallback((container: HTMLDivElement) => {
        if (container.dataset.normalizing === "true") return;
        const rawContent = serializeReplyContent(container);
        const rawCursorPos = getReplyCursorOffset(container);
        const composing = container.dataset.composing === "true";
        const translated = composing
            ? { content: rawContent, cursorPos: rawCursorPos }
            : translateEmojiShortcodes(rawContent, notice.guildId, rawCursorPos);
        if (replyFiles.some(isVoiceReplyFile)) setReplyFiles([]);
        pendingCaretOffsetRef.current = null;
        isLocalEditRef.current = translated.content !== replyContent;
        const hasUnrenderedToken = hasUnrenderedReplyToken(container);
        if (!composing && (translated.content !== rawContent || hasUnrenderedToken)) {
            const nextContent = translated.content;
            container.dataset.normalizing = "true";
            const replaced = replaceReplyEditorContent(container, nextContent);
            delete container.dataset.normalizing;
            if (replaced) {
                setReplyCaretOffset(container, translated.cursorPos);
                pendingCaretOffsetRef.current = null;
            }
        }
        setReplyContent(translated.content);
        setCursorPos(translated.cursorPos);
    }, [notice.guildId, replyContent, replyFiles]);

    const handleReplyChange = useCallback((event: React.FormEvent<HTMLDivElement>) => {
        const inputEvent = event.nativeEvent as InputEvent;
        if (inputEvent.inputType === "historyUndo" || inputEvent.inputType === "historyRedo") {
            const raw = serializeReplyContent(event.currentTarget);
            isLocalEditRef.current = raw !== replyContent;
            setReplyContent(raw);
            setCursorPos(getReplyCursorOffset(event.currentTarget));
            return;
        }
        updateReplyFromEditor(event.currentTarget);
    }, [replyContent, updateReplyFromEditor]);

    const handleReplyCompositionEnd = useCallback((event: React.CompositionEvent<HTMLDivElement>) => {
        delete event.currentTarget.dataset.composing;
        updateReplyFromEditor(event.currentTarget);
    }, [updateReplyFromEditor]);

    const handleReplyPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
        const files = getClipboardFiles(event.clipboardData);
        if (files.length) {
            event.preventDefault();
            setReplyFiles(current => {
                const kept = current.some(isVoiceReplyFile) ? [] : current;
                const existing = new Set(kept.map(file => `${file.name}:${file.type}:${file.size}`));
                return [...kept, ...files.filter(file => !existing.has(`${file.name}:${file.type}:${file.size}`))];
            });
            return;
        }

        const text = event.clipboardData.getData("text/plain");
        event.preventDefault();
        if (!text) return;

        if (!insertReplyContentAtSelection(event.currentTarget, text)) return;
        updateReplyFromEditor(event.currentTarget);
    }, [updateReplyFromEditor]);

    const submitReply = useCallback((event: React.FormEvent) => {
        event.preventDefault();
        event.stopPropagation();

        const content = appendReplyImageUrls(resolveInteractionReply(replyContent.trim(), notice).trim(), replyImageUrls);
        const stickerId = getReplyStickerId(replyContent, selectedSticker?.id, notice.originalSticker?.id);
        const stickerIds = stickerId ? [stickerId] : [];
        const shouldJumpOnReply = forceJumpOnSubmitRef.current || settings.store.jumpOnReply;
        forceJumpOnSubmitRef.current = false;
        if (!content && stickerIds.length === 0 && replyFiles.length === 0) return;

        dispatchReply(content, stickerIds, replyFiles, shouldJumpOnReply, "Reply failed in the background; mention restored.");
    }, [dispatchReply, notice, replyContent, replyFiles, replyImageUrls, selectedSticker]);

    const reactToMention = useCallback((event: React.MouseEvent, emoji: Emoji, isReacted: boolean) => {
        event.preventDefault();
        event.stopPropagation();
        void setReactionOnNotice(notice, emoji, !isReacted);
    }, [notice]);

    const toggleEmojiPicker = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setPickerPos(getPickerPosition(event.currentTarget as HTMLButtonElement));
        setEmojiSearch("");
        setHoveredEmoji(null);
        setShowStickerPicker(false);
        setShowEmojiPicker(value => !value);
    }, []);

    const toggleStickerPicker = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setStickerPickerPos(getPickerPosition(event.currentTarget as HTMLButtonElement));
        setShowEmojiPicker(false);
        setShowStickerPicker(value => !value);
    }, []);

    const reactWithPickerEmoji = useCallback((event: React.MouseEvent, emoji: Emoji, isReacted: boolean) => {
        event.preventDefault();
        event.stopPropagation();
        void setReactionOnNotice(notice, emoji, !isReacted);
        setShowEmojiPicker(false);
        setHoveredEmoji(null);
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

    const useInteractionReply = useCallback((event: React.MouseEvent, content: string, copiesSticker: boolean, copiesImages: boolean) => {
        event.preventDefault();
        event.stopPropagation();

        if (dialogueButtonMode === DialogueButtonMode.Send) {
            const imageUrls = copiesImages ? getReplyImageUrls("{message.content}", notice.media) : [];
            if (!content.trim() && !copiesSticker && !imageUrls.length) return;

            const shouldJumpOnReply = settings.store.jumpOnReply;
            dispatchReply(appendReplyImageUrls(content.trim(), imageUrls), copiesSticker && notice.originalSticker ? [notice.originalSticker.id] : [], [], shouldJumpOnReply, "Interaction reply failed in the background; mention restored.");
            return;
        }

        const input = replyInputRef.current;
        if (!input || !insertReplyContent(input, 0, replyContent.length, content)) return;
        setCopiedReplyImageUrls(copiesImages ? getReplyImageUrls("{message.content}", notice.media) : []);
        setRemovedReplyImageUrls([]);
        updateReplyFromEditor(input);
        setSelectedSticker(copiesSticker ? notice.originalSticker ?? null : null);
        requestAnimationFrame(() => replyInputRef.current?.focus());
    }, [dialogueButtonMode, dispatchReply, notice, replyContent.length, updateReplyFromEditor]);

    const useVoiceInteraction = useCallback(async(event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        if (dialogueButtonMode === DialogueButtonMode.Draft) {
            await copyVoiceToReply();
            return;
        }

        const file = await loadVoiceReply();
        if (!file) return;

        dispatchReply("", [], [file], settings.store.jumpOnReply, "Voice note reply failed in the background; mention restored.");
    }, [copyVoiceToReply, dialogueButtonMode, dispatchReply, loadVoiceReply]);

    const deleteInteractionReply = useCallback((event: React.MouseEvent, id: string) => {
        event.preventDefault();
        event.stopPropagation();
        settings.store.preselectedDialogues = getPreselectedDialogues().filter(dialogue => dialogue.id !== id);
    }, []);

    const handleReplySelect = useCallback((event: React.SyntheticEvent<HTMLDivElement>) => {
        setCursorPos(getReplyCursorOffset(event.currentTarget));
    }, []);

    const handleReplyTokenClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const token = (event.target as HTMLElement).closest<HTMLElement>(".vc-mentions-box-reply-token-mention[data-raw]");
        const userId = token?.dataset.raw?.match(/\d+/)?.[0];
        if (!userId) return;
        event.preventDefault();
        event.stopPropagation();
        void openProfile(userId, notice);
    }, [notice.channelId, notice.guildId]);

    const insertAutocompletedEmoji = useCallback((emoji: Emoji) => {
        if (!emojiMatch) return;
        const text = emojiToInsertText(emoji);
        const input = replyInputRef.current;
        if (!input || !insertReplyContent(input, emojiMatch.startIndex, cursorPos, text)) return;
        updateReplyFromEditor(input);
        requestAnimationFrame(() => replyInputRef.current?.focus());
    }, [cursorPos, emojiMatch, updateReplyFromEditor]);

    const insertAutocompletedPlaceholder = useCallback((placeholder: ReplyPlaceholderSuggestion, mode: "value" | "token" = "value") => {
        if (!placeholderMatch) return;

        const replacement = mode === "token" ? placeholder.token : placeholder.resolvedValue;
        const trailingBrace = replyContent[placeholderMatch.endIndex] === "}" ? 1 : 0;
        const input = replyInputRef.current;
        if (!input || !insertReplyContent(input, placeholderMatch.startIndex, placeholderMatch.endIndex + trailingBrace, replacement)) return;
        updateReplyFromEditor(input);
        if (placeholder.key === "message.content") {
            setCopiedReplyImageUrls(getReplyImageUrls(placeholder.token, notice.media));
            setRemovedReplyImageUrls([]);
            if (notice.originalSticker) setSelectedSticker(notice.originalSticker);
        }
        requestAnimationFrame(() => replyInputRef.current?.focus());
    }, [replyContent, placeholderMatch, notice, updateReplyFromEditor]);

    const appendEmojiToReply = useCallback((emoji: Emoji) => {
        const input = replyInputRef.current;
        if (!input || !insertReplyContent(input, replyContent.length, replyContent.length, emojiToInsertText(emoji))) return;
        updateReplyFromEditor(input);
        requestAnimationFrame(() => replyInputRef.current?.focus());
    }, [replyContent.length, updateReplyFromEditor]);

    const openPlaceholderAutocomplete = useCallback(() => {
        const input = replyInputRef.current;
        if (!input || !insertReplyContent(input, cursorPos, cursorPos, "{")) return;
        updateReplyFromEditor(input);
        requestAnimationFrame(() => replyInputRef.current?.focus());
    }, [cursorPos, updateReplyFromEditor]);

    const getInteractionActions = useCallback(() =>
        Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
            .filter(button => button.offsetParent !== null), []);

    const focusInteractionAction = useCallback((index: number) => {
        const actions = getInteractionActions();
        if (!actions.length) return;

        const nextIndex = (index + actions.length) % actions.length;
        setInteractionNavIndex(nextIndex);
        actions[nextIndex].focus({ preventScroll: true });
        actions[nextIndex].scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [getInteractionActions]);

    const handleReplyEscapeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Escape") return false;

        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation?.();
        markCurrentNoticeRead(true);
        return true;
    }, [markCurrentNoticeRead]);

    const handleReplyKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (handleReplyEscapeKeyDown(event)) return;
        if ((event.ctrlKey || event.metaKey) && event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation?.();
            focusInteractionAction(event.shiftKey ? -1 : 0);
            return;
        }

        if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && document.getSelection()?.isCollapsed) {
            const currentCursor = getReplyCursorOffset(event.currentTarget);
            const token = Array.from(replyContent.matchAll(MENTION_OR_EMOJI_TOKEN_REGEX)).find(match => {
                const start = match.index ?? 0;
                return event.key === "ArrowLeft" ? start + match[0].length === currentCursor : start === currentCursor;
            });
            if (token) {
                const nextCursor = (token.index ?? currentCursor) + (event.key === "ArrowRight" ? token[0].length : 0);
                event.preventDefault();
                setReplyCaretOffset(event.currentTarget, nextCursor);
                setCursorPos(nextCursor);
                return;
            }
        }

        if ((event.key === "Backspace" || event.key === "Delete") && document.getSelection()?.isCollapsed) {
            const currentCursor = getReplyCursorOffset(event.currentTarget);
            const token = findReplyTokenAtCursor(replyContent, currentCursor, event.key);

            if (token) {
                const tokenStart = token.index ?? currentCursor;
                event.preventDefault();
                setReplySelectionOffsets(event.currentTarget, tokenStart, tokenStart + token[0].length);
                document.execCommand("delete");
                updateReplyFromEditor(event.currentTarget);
                return;
            }
        }

        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            if (!replyContent.trim() && !selectedSticker && replyFiles.length === 0) {
                jumpToNotice(notice);
                return;
            }

            forceJumpOnSubmitRef.current = true;
            event.currentTarget.closest("form")?.requestSubmit();
            return;
        }

        if (placeholderMatch) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (placeholderSuggestions.length) setAutocompleteIndex(i => (i + 1) % placeholderSuggestions.length);
                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                if (placeholderSuggestions.length) setAutocompleteIndex(i => (i - 1 + placeholderSuggestions.length) % placeholderSuggestions.length);
                return;
            }

            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                event.stopPropagation();
                if (placeholderSuggestions.length) {
                    insertAutocompletedPlaceholder(
                        placeholderSuggestions[autocompleteIndex] ?? placeholderSuggestions[0],
                        event.shiftKey ? "token" : "value"
                    );
                }
                return;
            }
        }

        if (autocompleteSuggestions.length) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setAutocompleteIndex(i => (i + 1) % autocompleteSuggestions.length);
                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                setAutocompleteIndex(i => (i - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length);
                return;
            }

            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                event.stopPropagation();
                insertAutocompletedEmoji(autocompleteSuggestions[autocompleteIndex] ?? autocompleteSuggestions[0]);
                return;
            }
        }

        if (event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            if (hasReplayableVoiceMessage && !replyContent.trim() && !selectedSticker && replyFiles.length === 0) {
                void copyVoiceToReply();
                return;
            }
            openPlaceholderAutocomplete();
            return;
        }

        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.closest("form")?.requestSubmit();
        }
    }, [placeholderMatch, placeholderSuggestions, autocompleteSuggestions, autocompleteIndex, copyVoiceToReply, focusInteractionAction, handleReplyEscapeKeyDown, hasReplayableVoiceMessage, insertAutocompletedPlaceholder, insertAutocompletedEmoji, notice, openPlaceholderAutocomplete, replyContent, replyFiles, selectedSticker]);

    const handleCardBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;

        setIsFocusedWithin(false);
        setInteractionNavIndex(null);
    }, []);

    const handleCardKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (interactionNavIndex !== null) {
            const actions = getInteractionActions();
            const focusedIndex = actions.indexOf(document.activeElement as HTMLButtonElement);
            const currentIndex = focusedIndex < 0 ? interactionNavIndex : focusedIndex;

            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation?.();
                setInteractionNavIndex(null);
                replyInputRef.current?.focus({ preventScroll: true });
                return;
            }

            if (event.key === "Tab" || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation?.();
                const moveBack = event.key === "ArrowLeft" || event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey);
                focusInteractionAction(currentIndex + (moveBack ? -1 : 1));
                return;
            }

            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation?.();
                actions[currentIndex]?.click();
                return;
            }
        }

        if (event.target === replyInputRef.current && (event.ctrlKey || event.metaKey) && event.key === "Tab") return;
        if (!hasReplyPreview) return;
        if (!shouldHandleGlobalKeybind(event.nativeEvent, settings.store.replyChainToggleKeybind)) return;

        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation?.();
        setIsReplyExpanded(prev => !prev);
    }, [focusInteractionAction, getInteractionActions, hasReplyPreview, interactionNavIndex]);

    const replyDisabled = !replyContent.trim() && !selectedSticker && replyFiles.length === 0;
    const noticeKindClass = notice.kind ? ` vc-mentions-box-card-${notice.kind}` : "";

    return (
        <div
            ref={cardRef}
            className={`vc-mentions-box-card${noticeKindClass}${notice.deleted ? " vc-mentions-box-card-deleted" : ""}${interactionNavIndex === null ? "" : " vc-mentions-box-card--interaction-nav"}`}
            data-mention-id={notice.id}
            tabIndex={-1}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onFocusCapture={() => setIsFocusedWithin(true)}
            onBlurCapture={handleCardBlurCapture}
            onKeyDownCapture={handleCardKeyDownCapture}
        >
            {isExternalReactionDismissing && notice.externalReactionDismissDurationMs && (
                <ExternalReactionExpiry
                    noticeId={notice.id}
                    durationMs={notice.externalReactionDismissDurationMs}
                    paused={isExternalReactionDismissPaused}
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
                        <StatusDot userId={notice.authorId} />
                    </button>
                    <div className="vc-mentions-box-copy">
                        <div className="vc-mentions-box-meta">
                            <span className="vc-mentions-box-author">{notice.authorName}</span>
                            <DeviceIcons userId={notice.authorId} />
                            {notice.guildName && <span className="vc-mentions-box-guild">{notice.guildName}</span>}
                            <span className="vc-mentions-box-channel">{notice.channelName}</span>
                            <span className="vc-mentions-box-time" title={new Date(notice.timestamp).toLocaleString()}>
                                {formatSentTime(notice.timestamp)}
                            </span>
                        </div>
                        {notice.originalContent !== undefined && (
                            <div className={`vc-mentions-box-content vc-mentions-box-original-content${isExpanded ? " vc-mentions-box-content--expanded" : ""}`}>
                                {renderMessageContent(notice.originalContent, notice.channelId, notice.id)}
                            </div>
                        )}
                        <div ref={contentRef} className={`vc-mentions-box-content${isExpanded ? " vc-mentions-box-content--expanded" : ""}`}>
                            {renderMessageContent(displayContent, notice.channelId, notice.id)}
                            {notice.originalContent !== undefined && (
                                <span className={MessageClasses.edited}> (edited)</span>
                            )}
                        </div>
                        {notice.deleted && (
                            <div className="vc-mentions-box-deleted-badge">
                                Original message deleted
                            </div>
                        )}
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
                        {(notice.reactions?.length ?? 0) > 0 && (
                            <div className="vc-mentions-box-message-reactions">
                                {notice.reactions.map(reaction => {
                                    const emojiKey = getStoredReactionKey(reaction);
                                    const imgUrl = getEmojiImageUrl(reaction.emoji as any);
                                    const isReacted = notice.reactedEmojiKeys.includes(emojiKey);

                                    return (
                                        <button
                                            key={emojiKey}
                                            type="button"
                                            className={`vc-mentions-box-message-reaction${isReacted ? " vc-mentions-box-message-reaction--mine" : ""}`}
                                            onClick={event => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                void setReactionOnNotice(notice, reaction.emoji as any, !isReacted);
                                            }}
                                            aria-label={`${isReacted ? "Remove" : "React with"} ${reaction.emoji.name}`}
                                            aria-pressed={isReacted}
                                            title={reaction.emoji.name}
                                        >
                                        <PreviewImage
                                            key={imgUrl}
                                            url={imgUrl}
                                            imageClass="vc-mentions-box-message-reaction-img"
                                            fallbackClass={reaction.emoji.id ? "vc-mentions-box-emoji-fallback" : "vc-mentions-box-message-reaction-unicode"}
                                            fallback={reaction.emoji.id ? `:${reaction.emoji.name}:` : reaction.emoji.name}
                                        />
                                            <span className="vc-mentions-box-message-reaction-count">{reaction.count}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        {hasReplyPreview && notice.referencedAuthorName && (
                            <div className="vc-mentions-box-replied-item">
                                <span className="vc-mentions-box-replied-item-label">Replied item:</span>{" "}
                                <span className="vc-mentions-box-replied-item-author">{notice.referencedAuthorName}</span>: {notice.referencedContent}
                            </div>
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
                            {(interactionReplies.length > 0 || hasReplayableVoiceMessage) && (
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
                        <div className="vc-mentions-box-actions">
                                {!isTypingNotice && <div className="vc-mentions-box-reactions" aria-label="Quick reactions">
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
                                                <PreviewImage
                                                    key={imageUrl}
                                                    url={imageUrl}
                                                    imageClass="vc-mentions-box-reaction-img"
                                                    fallbackClass={emoji.id ? "vc-mentions-box-emoji-fallback" : "vc-mentions-box-reaction-unicode"}
                                                    fallback={emoji.id ? label : getUnicodeEmojiSurrogates(emoji)}
                                                />
                                            </button>
                                        );
                                    })}
                                    <>
                                        <button
                                            ref={pickerTriggerRef}
                                            type="button"
                                            className="vc-mentions-box-reaction vc-mentions-box-reaction-more"
                                            aria-label="Add reaction"
                                            title="Add reaction"
                                            onClick={toggleEmojiPicker}
                                        >
                                            ☺
                                        </button>
                                        {showEmojiPicker && pickerPos && ReactDOM.createPortal(
                                            <div
                                                ref={emojiPickerRef}
                                                className="vc-mentions-box-emoji-picker"
                                                style={{ position: "fixed", top: pickerPos.top, right: pickerPos.right, zIndex: 10000 }}
                                                onClick={event => event.stopPropagation()}
                                            >
                                                <div className="vc-mentions-box-emoji-picker-header">
                                                    <div className="vc-mentions-box-emoji-search-wrap">
                                                        <span className="vc-mentions-box-emoji-search-icon">🔍</span>
                                                        <input
                                                            className="vc-mentions-box-emoji-search"
                                                            placeholder="Find the perfect emoji"
                                                            value={emojiSearch}
                                                            onChange={event => setEmojiSearch(event.currentTarget.value)}
                                                            onKeyDown={event => event.stopPropagation()}
                                                            autoFocus
                                                        />
                                                    </div>
                                                </div>
                                                <div className="vc-mentions-box-emoji-picker-body" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                                                    <div className="vc-mentions-box-emoji-panel">
                                                        {pickerEmojis.length === 0 ? (
                                                            <div className="vc-mentions-box-emoji-empty">
                                                                {emojiSearch.trim() ? `No results for "${emojiSearch}"` : "No emoji available"}
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <div className="vc-mentions-box-emoji-heading">
                                                                    {emojiSearch.trim() ? "Search results" : "Frequently used"}
                                                                </div>
                                                                <div className="vc-mentions-box-emoji-grid">
                                                                    {pickerEmojis.map(emoji => {
                                                                const imageUrl = getEmojiImageUrl(emoji);
                                                                const label = getEmojiLabel(emoji);
                                                                const emojiKey = getReactionKey(emoji);
                                                                const isReacted = notice.reactedEmojiKeys.includes(emojiKey);

                                                                return (
                                                                    <button
                                                                        key={getEmojiKey(emoji)}
                                                                        type="button"
                                                                        className={`vc-mentions-box-emoji-button${isReacted ? " vc-mentions-box-emoji-button-selected" : ""}`}
                                                                        onClick={event => reactWithPickerEmoji(event, emoji, isReacted)}
                                                                        onMouseEnter={() => setHoveredEmoji(emoji)}
                                                                        onMouseLeave={() => setHoveredEmoji(null)}
                                                                        onFocus={() => setHoveredEmoji(emoji)}
                                                                        aria-label={`${isReacted ? "Remove" : "React with"} ${label}`}
                                                                        title={label}
                                                                    >
                                                                        <PreviewImage
                                                                            key={imageUrl}
                                                                            url={imageUrl}
                                                                            imageClass="vc-mentions-box-emoji-img"
                                                                            fallbackClass={emoji.id ? "vc-mentions-box-emoji-fallback" : "vc-mentions-box-emoji-unicode"}
                                                                            fallback={emoji.id ? label : getUnicodeEmojiSurrogates(emoji)}
                                                                        />
                                                                    </button>
                                                                );
                                                            })}
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                                {hoveredEmoji && (
                                                    <div className="vc-mentions-box-emoji-footer">
                                                        <PreviewImage
                                                            key={getEmojiImageUrl(hoveredEmoji)}
                                                            url={getEmojiImageUrl(hoveredEmoji)}
                                                            imageClass="vc-mentions-box-emoji-footer-img"
                                                            fallbackClass={hoveredEmoji.id ? "vc-mentions-box-emoji-fallback" : "vc-mentions-box-emoji-footer-unicode"}
                                                            fallback={hoveredEmoji.id ? getEmojiLabel(hoveredEmoji) : getUnicodeEmojiSurrogates(hoveredEmoji)}
                                                        />
                                                        <span className="vc-mentions-box-emoji-footer-name">
                                                            {hoveredEmoji.id ? getEmojiLabel(hoveredEmoji) : `:${getEmojiLabel(hoveredEmoji)}:`}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>,
                                            document.body
                                        )}
                                        <button
                                            ref={stickerPickerTriggerRef}
                                            type="button"
                                            className={`vc-mentions-box-reaction vc-mentions-box-reaction-more vc-mentions-box-sticker-trigger${selectedSticker || showStickerPicker ? " vc-mentions-box-reaction-selected" : ""}`}
                                            aria-label={selectedSticker ? `Selected sticker: ${selectedSticker.name}` : "Add sticker reply"}
                                            title={selectedSticker ? `Sticker: ${selectedSticker.name}` : "Add sticker reply"}
                                            aria-pressed={Boolean(selectedSticker || showStickerPicker)}
                                            onClick={toggleStickerPicker}
                                        >
                                            ▣
                                        </button>
                                        {showStickerPicker && stickerPickerPos && ReactDOM.createPortal(
                                            <div
                                                ref={stickerPickerRef}
                                                className="vc-mentions-box-sticker-picker"
                                                style={{ position: "fixed", top: stickerPickerPos.top, right: stickerPickerPos.right, zIndex: 10000 }}
                                                onClick={event => event.stopPropagation()}
                                            >
                                                <MentionStickerPicker
                                                    selectedId={selectedSticker?.id ?? null}
                                                    onSelect={setSelectedSticker}
                                                    closePopout={() => setShowStickerPicker(false)}
                                                />
                                            </div>,
                                            document.body
                                        )}
                                    </>
                                </div>}
                                <div className="vc-mentions-box-actions-right">
                                    <button
                                        className="vc-mentions-box-jump"
                                        type="button"
                                        onClick={clickJumpButton}
                                    >
                                        Jump
                                    </button>
                                    <button className="vc-mentions-box-dismiss" type="button" onClick={dismissNotice} aria-label="Mark mention as read">
                                        Mark as read
                                    </button>
                                </div>
                        </div>
                        {isInteractionExpanded && (
                            <div className="vc-mentions-box-interaction-panel" onClick={event => event.stopPropagation()}>
                                {interactionReplies.length > 0 && (
                                    <input
                                        className="vc-mentions-box-interaction-search"
                                        value={interactionSearch}
                                        onChange={event => setInteractionSearch(event.currentTarget.value)}
                                        onKeyDown={event => event.stopPropagation()}
                                        placeholder="Search interactions…"
                                        aria-label="Search interaction replies"
                                    />
                                )}
                                <div className="vc-mentions-box-dialogues" aria-label="Interaction replies">
                                    {hasReplayableVoiceMessage && (
                                        <button
                                            className="vc-mentions-box-dialogue-button"
                                            type="button"
                                            disabled={isCopyingVoice}
                                            onClick={event => void useVoiceInteraction(event)}
                                            title={dialogueButtonMode === DialogueButtonMode.Send
                                                ? "Reply with this voice note"
                                                : "Copy this voice note into the reply bar"}
                                        >
                                            {isCopyingVoice
                                                ? "Copying voice note…"
                                                : dialogueButtonMode === DialogueButtonMode.Send ? "Replay voice note" : "Copy voice note"}
                                        </button>
                                    )}
                                    {filteredInteractionReplies.map(reply => (
                                        <button
                                            key={reply.id}
                                            className="vc-mentions-box-dialogue-button"
                                            type="button"
                                            onClick={event => useInteractionReply(event, reply.content, reply.copiesSticker, reply.copiesImages)}
                                            onContextMenu={event => deleteInteractionReply(event, reply.id)}
                                            title={`${reply.content}
Right-click to delete this response`}
                                        >
                                            {reply.label}
                                        </button>
                                    ))}
                                    {!hasReplayableVoiceMessage && filteredInteractionReplies.length === 0 && (
                                        <div className="vc-mentions-box-dialogue-empty">
                                            No interactions match “{interactionSearch.trim()}”
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                        {isReplyExpanded && replyChain.length > 0 && <ReplyChain replies={replyChain} />}
                        {isReplyExpanded && !replyChain.length && notice.referencedAuthorName && (
                            <div className="vc-mentions-box-ref">
                                ↩ <span className="vc-mentions-box-ref-author">{notice.referencedAuthorName}</span>: {notice.referencedContent}
                            </div>
                        )}
                    </div>
                </div>
                <form className="vc-mentions-box-reply" onSubmit={submitReply} onClick={event => event.stopPropagation()}>
                    {(placeholderMatch || autocompleteSuggestions.length > 0) && (
                        <ReplyAutocompleteLayer
                            inputRef={replyInputRef}
                            replyContent={replyContent}
                            placeholderMatch={placeholderMatch}
                            placeholderSuggestions={placeholderSuggestions}
                            emojiSuggestions={autocompleteSuggestions}
                            selectedIndex={autocompleteIndex}
                            onSelectPlaceholder={insertAutocompletedPlaceholder}
                            onSelectEmoji={insertAutocompletedEmoji}
                        />
                    )}
                    {replyFiles.length > 0 && (
                        <div className="vc-mentions-box-reply-media-list">
                            {replyFiles.map(file => (
                                <ReplyMediaPreview
                                    key={`${file.name}:${file.type}:${file.size}`}
                                    file={file}
                                    onRemove={() => setReplyFiles(current => current.filter(item => item !== file))}
                                />
                            ))}
                        </div>
                    )}
                    {replyImageUrls.map(url => (
                        <div className="vc-mentions-box-reply-image-chip" key={url}>
                            <img src={url} alt="" />
                            <span>Image</span>
                            <button type="button" onClick={() => {
                                setRemovedReplyImageUrls(current => [...current, url]);
                                setCopiedReplyImageUrls(current => current.filter(item => item !== url));
                            }} aria-label="Remove copied image">×</button>
                        </div>
                    ))}
                    {selectedSticker && (
                        <div className="vc-mentions-box-selected-sticker" onClick={event => event.stopPropagation()}>
                            <PreviewImage
                                key={selectedSticker.id}
                                url={getStickerMediaUrl({ id: selectedSticker.id, format_type: selectedSticker.formatType }, 64)}
                                imageClass="vc-mentions-box-selected-sticker-img"
                                fallbackClass="vc-mentions-box-selected-sticker-fallback"
                                fallback={selectedSticker.name}
                                alt={selectedSticker.name}
                            />
                            <div className="vc-mentions-box-selected-sticker-copy">
                                <span className="vc-mentions-box-selected-sticker-name">{selectedSticker.name}</span>
                                <span className="vc-mentions-box-selected-sticker-hint">Sticker will be sent as a reply.</span>
                            </div>
                            <button
                                className="vc-mentions-box-selected-sticker-remove"
                                type="button"
                                onClick={() => setSelectedSticker(null)}
                            >
                                Remove
                            </button>
                        </div>
                   )}
                   <div className="vc-mentions-box-reply-input-wrap">
                       <div
                            ref={replyInputRef}
                            contentEditable
                            suppressContentEditableWarning
                            className="vc-mentions-box-reply-input"
                            role="textbox"
                            aria-multiline="true"
                            data-placeholder={`Reply to ${notice.authorName}`}
                            data-guild-id={notice.guildId ?? undefined}
                            data-channel-id={notice.channelId}
                            onInput={handleReplyChange}
                            onCompositionStart={event => { event.currentTarget.dataset.composing = "true"; }}
                            onCompositionEnd={handleReplyCompositionEnd}
                            onClick={handleReplyTokenClick}
                            onPaste={handleReplyPaste}
                            onSelect={handleReplySelect}
                            onFocus={() => setInteractionNavIndex(null)}
                            onKeyDownCapture={handleReplyEscapeKeyDown}
                            onKeyDown={handleReplyKeyDown}
                            aria-autocomplete="list"
                            aria-controls={placeholderMatch
                                ? PLACEHOLDER_AUTOCOMPLETE_ID
                                : autocompleteSuggestions.length > 0 ? EMOJI_AUTOCOMPLETE_ID : undefined}
                            aria-expanded={Boolean(placeholderMatch || autocompleteSuggestions.length > 0)}
                            aria-activedescendant={placeholderMatch && placeholderSuggestions[autocompleteIndex]
                                ? getPlaceholderAutocompleteOptionId(placeholderSuggestions[autocompleteIndex].key)
                                : autocompleteSuggestions[autocompleteIndex] ? `${EMOJI_AUTOCOMPLETE_ID}-${autocompleteIndex}` : undefined}
                        />
                    </div>
                    <button
                        className="vc-mentions-box-reply-send"
                        disabled={replyDisabled}
                        type="submit"
                    >
                        Reply
                    </button>
                </form>
            </div>
        </div>
    );
}

function KeybindToast({ toast }: { toast: KeybindToastState; }) {
    return (
        <div key={toast.id} className="vc-mentions-box-keybind-toast" role="status" aria-live="polite">
            <span className="vc-mentions-box-keybind-toast-dot" aria-hidden />
            <span>{toast.message}</span>
        </div>
    );
}

function MentionsBox({ embedded = false }: { embedded?: boolean; }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const pendingFocusId = useRef<string | null>(null);
    const pendingFocusReplyInput = useRef(false);
    const pendingFocusAfterJump = useRef(false);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<MentionFilter>("all");
    const [sourceFilter, setSourceFilter] = useState("all");
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const currentChannelId = useStateFromStores(
        [SelectedChannelStore],
        () => SelectedChannelStore.getChannelId(),
        []
    );
    const currentNotices = useNotices();
    const notificationsHidden = useNotificationsHidden();
    const sourceFilterVisible = useSourceFilterVisible();
    const currentKeybindToast = useKeybindToast();
    const unreadMentionsLoading = useUnreadMentionsLoading();
    const { sortOrder, visibleMentions } = settings.use(["sortOrder", "visibleMentions"]);
    const visibleLimit = Math.max(1, Math.floor(Number(visibleMentions) || 5));
    const sourceOptions = useMemo<MentionSourceOption[]>(() => {
        const bySource = new Map<string, MentionSourceOption>();

        for (const notice of currentNotices) {
            const value = notice.guildId ? `guild:${notice.guildId}` : `dm:${notice.channelId}`;
            const existing = bySource.get(value);
            if (existing) {
                existing.count++;
            } else {
                bySource.set(value, {
                    value,
                    label: notice.guildId
                        ? notice.guildName ?? GuildStore.getGuild(notice.guildId)?.name ?? "Unknown server"
                        : `DM · ${notice.channelName}`,
                    count: 1
                });
            }
        }

        return [
            { value: "all", label: "All", count: currentNotices.length },
            ...[...bySource.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
        ];
    }, [currentNotices]);
    const selectedSource = sourceOptions.find(option => option.value === sourceFilter) ?? sourceOptions[0];
    const managedNotices = useMemo(() => {
        const filtered = filterAndSortNotices(
            currentNotices,
            sortOrder,
            embedded ? filter : "all",
            embedded ? query : ""
        );

        if (embedded || !sourceFilterVisible || sourceFilter === "all") return filtered;
        return filtered.filter(notice => sourceFilter === (notice.guildId ? `guild:${notice.guildId}` : `dm:${notice.channelId}`));
    }, [currentNotices, embedded, filter, query, sortOrder, sourceFilter, sourceFilterVisible]);
    const visibleNotices = useMemo(
        () => embedded
            ? managedNotices
            : currentChannelId ? managedNotices.slice(0, visibleLimit) : [],
        [currentChannelId, embedded, managedNotices, visibleLimit]
    );
    const queuedCount = !embedded && currentChannelId
        ? Math.max(managedNotices.length - visibleLimit, 0)
        : 0;
    const selectedNotices = useMemo(
        () => currentNotices.filter(notice => selectedIds.has(notice.id)),
        [currentNotices, selectedIds]
    );
    const shouldShowMentions = !notificationsHidden;
    const shouldRenderBox = embedded
        || Boolean(currentKeybindToast)
        || (shouldShowMentions && sourceFilterVisible && currentNotices.length > 0)
        || (shouldShowMentions && (visibleNotices.length > 0 || unreadMentionsLoading.isLoading));

    useEffect(() => {
        if (!currentChannelId) return;

        for (const notice of currentNotices) {
            if (notice.kind === "typing" && notice.channelId === currentChannelId && !notice.externalReactionDismissStartedAt) {
                startExternalReactionDismiss(notice.id, notice.channelId);
            }
        }
    }, [currentChannelId, currentNotices]);

    useEffect(() => {
        const availableIds = new Set(currentNotices.map(notice => notice.id));
        setSelectedIds(current => {
            const next = new Set([...current].filter(id => availableIds.has(id)));
            return next.size === current.size && [...next].every(id => current.has(id)) ? current : next;
        });
    }, [currentNotices]);

    useEffect(() => {
        if (sourceFilter !== "all" && !sourceOptions.some(option => option.value === sourceFilter)) setSourceFilter(sourceOptions[1]?.value ?? "all");
    }, [sourceFilter, sourceOptions]);

    useLayoutEffect(() => {
        const focusId = pendingFocusId.current;
        if (!focusId) return;

        pendingFocusId.current = null;
        const focusReplyInput = pendingFocusReplyInput.current;
        pendingFocusReplyInput.current = false;
        const focusAfterJump = pendingFocusAfterJump.current;
        pendingFocusAfterJump.current = false;

        const focusNextMention = () => {
            const targets = rootRef.current?.querySelectorAll<HTMLElement>("[data-mention-id]");
            const target = Array.from(targets ?? [])
                .find(element => element.dataset.mentionId === focusId);
            if (!target) return;

            const focusTarget = focusReplyInput
                ? target.querySelector<HTMLDivElement>(".vc-mentions-box-reply-input")
                : null;

            if (focusTarget) {
                focusTarget.focus({ preventScroll: true });
                setReplyCaretOffset(focusTarget, serializeReplyContent(focusTarget).length);
            } else {
                target.focus({ preventScroll: true });
            }
            target.scrollIntoView({ block: "nearest" });
        };

        if (!focusAfterJump) {
            focusNextMention();
            return;
        }

        const timeout = window.setTimeout(focusNextMention, 350);
        return () => window.clearTimeout(timeout);
    }, [visibleNotices]);

    if (!shouldRenderBox) return null;

    const handleNotice = (id: string, focusReplyInput = false, focusAfterJump = false) => {
        pendingFocusId.current = getNextNoticeId(visibleNotices.map(notice => notice.id), id);
        pendingFocusReplyInput.current = focusReplyInput;
        pendingFocusAfterJump.current = focusAfterJump;
    };

    const toggleSelected = (id: string) => {
        setSelectedIds(current => {
            const next = new Set(current);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const clearSelection = () => setSelectedIds(new Set());
    const leaveSelectionMode = () => {
        clearSelection();
        setSelectionMode(false);
    };

    return (
        <div
            ref={rootRef}
            className={`vc-mentions-box${embedded ? " vc-mentions-box--embedded" : ""}`}
            role="region"
            aria-label="Recent mentions"
        >
            {!embedded && shouldShowMentions && sourceFilterVisible && currentNotices.length > 0 && (
                <details
                    className="vc-mentions-box-source-filter"
                    onKeyDown={event => {
                        if (event.key === "Escape") event.currentTarget.removeAttribute("open");
                    }}
                >
                    <summary className="vc-mentions-box-source-filter-summary">
                        <span className="vc-mentions-box-source-filter-label">Pings from</span>
                        <span className="vc-mentions-box-source-filter-selected">{selectedSource.label}</span>
                        <span
                            className="vc-mentions-box-source-filter-count"
                            aria-label={`${selectedSource.count} ping${selectedSource.count === 1 ? "" : "s"}`}
                        >
                            {selectedSource.count > 99 ? "99+" : selectedSource.count}
                        </span>
                        <span className="vc-mentions-box-source-filter-chevron" aria-hidden />
                    </summary>
                    <div className="vc-mentions-box-source-filter-menu" aria-label="Filter mentions by server or direct message">
                        {sourceOptions.map(option => (
                            <button
                                key={option.value}
                                className={`vc-mentions-box-source-filter-option${option.value === sourceFilter ? " vc-mentions-box-source-filter-option-active" : ""}`}
                                type="button"
                                aria-pressed={option.value === sourceFilter}
                                onClick={event => {
                                    setSourceFilter(option.value);
                                    event.currentTarget.closest("details")?.removeAttribute("open");
                                }}
                            >
                                <span>{option.label}</span>
                                <span className="vc-mentions-box-source-filter-count">
                                    {option.count > 99 ? "99+" : option.count}
                                </span>
                            </button>
                        ))}
                    </div>
                </details>
            )}
            {embedded && (
                <div className="vc-mentions-box-manager">
                    <div className="vc-mentions-box-manager-primary">
                        <div className="vc-mentions-box-manager-search-wrap">
                            <svg viewBox="0 0 24 24" aria-hidden>
                                <path fill="currentColor" d="m20.7 19.3-4.2-4.2a7 7 0 1 0-1.4 1.4l4.2 4.2a1 1 0 0 0 1.4-1.4ZM5 11a6 6 0 1 1 12 0 6 6 0 0 1-12 0Z" />
                            </svg>
                            <input
                                className="vc-mentions-box-manager-search"
                                value={query}
                                onChange={event => setQuery(event.currentTarget.value)}
                                placeholder="Search mentions"
                                aria-label="Search mentions"
                            />
                        </div>
                        <select
                            className="vc-mentions-box-manager-select"
                            value={filter}
                            onChange={event => setFilter(event.currentTarget.value as MentionFilter)}
                            aria-label="Filter mentions"
                        >
                            <option value="all">All mentions</option>
                            <option value="servers">Servers</option>
                            <option value="direct">Direct messages</option>
                            <option value="bots">Bots</option>
                        </select>
                        <button
                            className="vc-mentions-box-manager-button"
                            type="button"
                            onClick={() => { settings.store.sortOrder = sortOrder === SortOrder.Newest ? SortOrder.Oldest : SortOrder.Newest; }}
                            title="Reverse mention order"
                        >
                            {sortOrder === SortOrder.Newest ? "Newest first" : "Oldest first"}
                        </button>
                    </div>
                    <div className="vc-mentions-box-manager-actions">
                        {selectionMode ? (
                            <>
                                <span className="vc-mentions-box-manager-count">{selectedIds.size} selected</span>
                                <button
                                    className="vc-mentions-box-manager-button"
                                    type="button"
                                    disabled={!visibleNotices.length}
                                    onClick={() => setSelectedIds(new Set(visibleNotices.map(notice => notice.id)))}
                                >
                                    Select visible
                                </button>
                                <button
                                    className="vc-mentions-box-manager-button vc-mentions-box-manager-button--danger"
                                    type="button"
                                    disabled={!selectedNotices.length}
                                    onClick={() => {
                                        removeNotices(selectedNotices);
                                        leaveSelectionMode();
                                    }}
                                >
                                    Clear selected
                                </button>
                                <button className="vc-mentions-box-manager-button" type="button" onClick={leaveSelectionMode}>
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <>
                                <span className="vc-mentions-box-manager-count">
                                    {visibleNotices.length === currentNotices.length
                                        ? `${currentNotices.length} mention${currentNotices.length === 1 ? "" : "s"}`
                                        : `${visibleNotices.length} of ${currentNotices.length}`}
                                </span>
                                <button
                                    className="vc-mentions-box-manager-button"
                                    type="button"
                                    disabled={!visibleNotices.length}
                                    onClick={() => setSelectionMode(true)}
                                >
                                    Select
                                </button>
                                <button
                                    className="vc-mentions-box-manager-button"
                                    type="button"
                                    onClick={() => toggleNotificationsHidden()}
                                >
                                    {notificationsHidden ? "Show cards" : "Hide cards"}
                                </button>
                                <button
                                    className="vc-mentions-box-manager-button"
                                    type="button"
                                    disabled={unreadMentionsLoading.isLoading}
                                    onClick={() => scheduleUnreadMentionsLoad(0, true)}
                                >
                                    Refresh
                                </button>
                                <button
                                    className="vc-mentions-box-manager-button vc-mentions-box-manager-button--danger"
                                    type="button"
                                    disabled={!currentNotices.length}
                                    onClick={() => removeNotices(currentNotices)}
                                >
                                    Clear all
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}
            {currentKeybindToast && <KeybindToast toast={currentKeybindToast} />}
            {shouldShowMentions && unreadMentionsLoading.isLoading && (
                <div className="vc-mentions-box-loading" role="status" aria-live="polite">
                    <div className="vc-mentions-box-loading-bar" />
                    <span>{unreadMentionsLoading.label}</span>
                </div>
            )}
            {shouldShowMentions && visibleNotices.map(notice => embedded ? (
                <div
                    key={notice.id}
                    className={`vc-mentions-box-managed-card${selectionMode ? " vc-mentions-box-managed-card--selecting" : ""}${selectedIds.has(notice.id) ? " vc-mentions-box-managed-card--selected" : ""}`}
                    data-mention-id={notice.id}
                    tabIndex={-1}
                >
                    {selectionMode && (
                        <button
                            className="vc-mentions-box-selection-toggle"
                            type="button"
                            onClick={() => toggleSelected(notice.id)}
                            aria-pressed={selectedIds.has(notice.id)}
                            aria-label={`${selectedIds.has(notice.id) ? "Deselect" : "Select"} mention from ${notice.authorName}`}
                        >
                            {selectedIds.has(notice.id) ? "✓" : ""}
                        </button>
                    )}
                    <MentionCard notice={notice} onHandled={handleNotice} />
                </div>
            ) : (
                <MentionCard key={notice.id} notice={notice} onHandled={handleNotice} />
            ))}
            {embedded && !unreadMentionsLoading.isLoading && (!shouldShowMentions || visibleNotices.length === 0) && (
                <div className="vc-mentions-box-empty">
                    {!shouldShowMentions
                        ? "MentionsBox cards are currently hidden."
                        : currentNotices.length
                            ? "No mentions match the current filters."
                            : "No recent mentions."}
                </div>
            )}
            {shouldShowMentions && queuedCount > 0 && (
                <div className="vc-mentions-box-queued">
                    {queuedCount} more mention{queuedCount === 1 ? "" : "s"} queued
                </div>
            )}
        </div>
    );
}

function MentionsBoxModal(props: RenderModalProps) {
    return (
        <Modal {...props} size="lg" title="MentionsBox">
            <div className="vc-mentions-box-modal-content">
                <MentionsBox embedded />
            </div>
        </Modal>
    );
}

function MentionsSectionButton() {
    const currentNotices = useNotices();
    const count = currentNotices.length;

    return (
        <div className="vc-mentions-box-server-list-item">
            <button
                className="vc-mentions-box-server-list-button"
                type="button"
                onClick={() => openModal(props => <MentionsBoxModal {...props} />)}
                aria-label={`Open MentionsBox${count ? `, ${count} recent mention${count === 1 ? "" : "s"}` : ""}`}
                title="MentionsBox"
            >
                <svg viewBox="0 0 24 24" aria-hidden>
                    <path
                        fill="currentColor"
                        d="M12 2a8 8 0 0 0-8 8v3.17L2.59 15.3A1 1 0 0 0 3.42 17H8a4 4 0 0 0 8 0h4.58a1 1 0 0 0 .83-1.7L20 13.17V10a8 8 0 0 0-8-8Zm0 18a2 2 0 0 1-1.73-1h3.46A2 2 0 0 1 12 20Zm-6.71-5 1.54-2.31A1 1 0 0 0 7 12.13V10a5 5 0 0 1 10 0v2.13a1 1 0 0 0 .17.56L18.71 15H5.29Z"
                    />
                </svg>
                {count > 0 && (
                    <span className="vc-mentions-box-server-list-badge">
                        {count > 99 ? "99+" : count}
                    </span>
                )}
            </button>
        </div>
    );
}

const renderMentionsSectionButton = ErrorBoundary.wrap(MentionsSectionButton, { noop: true });

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

function applyDisplayLocation(location: DisplayLocation = settings.store.displayLocation) {
    unmountRoot();
    removeServerListElement(ServerListRenderPosition.Above, renderMentionsSectionButton);

    if (!pluginStarted) return;

    if (location === DisplayLocation.Channels) {
        addServerListElement(ServerListRenderPosition.Above, renderMentionsSectionButton);
    } else {
        mountRoot();
    }
}

export default definePlugin({
    name: "MentionsBox",
    description: "Shows clickable top-screen cards for recent mentions and jumps to the message when clicked.",
    tags: ["Chat", "Notifications"],
    authors: [Dean],
    dependencies: ["ServerListAPI", "VoiceMessages"],
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
                    action={() => toggleNotificationsHidden()}
                />
                <Menu.MenuCheckboxItem
                    id="mentions-box-send-interactions"
                    label="Interaction buttons send immediately"
                    checked={sendsInteractionReplies}
                    action={() => toggleDialogueButtonMode()}
                />
                <Menu.MenuCheckboxItem
                    id="mentions-box-jump-on-card-click"
                    label="Click MentionsBox cards to jump"
                    checked={jumpToMentionOnClick}
                    action={() => toggleJumpToMentionOnClick()}
                />
            </>
        );
    },

    start() {
        pluginStarted = true;
        applyDisplayLocation();
        document.addEventListener("keydown", globalKeydownListener, true);
        pruneInterval = setInterval(clearExpiredNotices, 30_000);
        void refreshKeywordNotifierMentionIds();
        scheduleUnreadMentionsLoad(1_500, true);
    },

    stop() {
        pluginStarted = false;
        document.removeEventListener("keydown", globalKeydownListener, true);
        if (pruneInterval) clearInterval(pruneInterval);
        if (unreadLoadTimeout) clearTimeout(unreadLoadTimeout);
        if (keybindToastTimeout) clearTimeout(keybindToastTimeout);
        pruneInterval = null;
        unreadLoadTimeout = null;
        keybindToastTimeout = null;
        keybindToast = null;
        isSourceFilterVisible = false;
        sharedInteractionSearch = "";
        dismissedNoticeIds.clear();
        preloadedNoticeContexts.clear();
        pendingReplyNoticeRemovalIds.clear();
        sentReplyChains.clear();
        mentionBoxReactionMessageIds.clear();
        keywordNotifierMentionIds.clear();
        setUnreadMentionsLoading(false);
        setNotices([], false);
        discardedNoticeHistory.length = 0;
        restoredReplyEntries.clear();
        replyDrafts.clear();
        removeServerListElement(ServerListRenderPosition.Above, renderMentionsSectionButton);
        unmountRoot();
    },

    flux: {
        CONNECTION_OPEN() {
            scheduleUnreadMentionsLoad(1_500, true);
        },

        CHANNEL_ACK(payload: any) {
            refreshReadStatePayload(payload);
        },

        CHANNEL_LOCAL_ACK(payload: any) {
            refreshReadStatePayload(payload);
        },

        RECOMPUTE_READ_STATES() {
            scheduleUnreadMentionsLoad(150, true);
        },

        READ_STATE_UPDATE(payload: any) {
            refreshReadStatePayload(payload);
        },

        READ_STATE_UPDATES(payload: any) {
            refreshReadStatePayload(payload);
        },

        CLEAR_OLDEST_UNREAD_MESSAGE(payload: any) {
            refreshReadStatePayload(payload);
        },

        SET_RECENT_MENTIONS_STALE() {
            scheduleUnreadMentionsLoad(150, true);
        },

        TYPING_START(payload: TypingStartPayload) {
            const notice = buildNoticeFromTyping(payload);
            if (notice) {
                addNotice(notice);
                if (SelectedChannelStore.getChannelId() === notice.channelId) startExternalReactionDismiss(notice.id, notice.channelId);
            }
        },

        MESSAGE_CREATE({ message, channelId, guildId }: MessageCreatePayload) {
            const currentUser = UserStore.getCurrentUser();

            if (message?.author?.id === currentUser?.id && removeNoticeForReply(message)) return;
            if (shouldAutoReadBotMention(message)) {
                const resolvedChannelId = message.channel_id ?? (message as any).channelId ?? channelId;
                markMessageRead(resolvedChannelId, message.id);
                dismissedNoticeIds.add(message.id);
                removeNoticeForMessage(message.id, resolvedChannelId);
                return;
            }
            if (!message?.id || message.state === "SENDING" || !isRelevantMention(message)) return;
            if (currentUser && messageMentionsUser(message, currentUser.id)) keywordNotifierMentionIds.add(message.id);

            const notice = buildNoticeFromMessage(message, channelId, guildId);
            if (notice) {
                const nextNotice = {
                    ...notice,
                    timestamp: Date.now()
                };

                addNotice(nextNotice);
                preloadNoticeContext(nextNotice);
                void hydrateNoticeReplyChain(nextNotice, message);
            }
        },

        MESSAGE_UPDATE(payload: any) {
            updateNoticeMessage(payload?.message ?? payload, payload?.channelId ?? payload?.channel_id);
        },

        MESSAGE_DELETE(payload: any) {
            for (const messageId of getDeletedMessageIds(payload)) {
                markNoticeDeleted(messageId, payload?.channelId ?? payload?.channel_id);
            }
        },

        MESSAGE_DELETE_BULK(payload: any) {
            for (const messageId of getDeletedMessageIds(payload)) {
                markNoticeDeleted(messageId, payload?.channelId ?? payload?.channel_id);
            }
        },

        MESSAGE_REACTION_ADD(payload: MessageReactionPayload) {
            const currentUser = UserStore.getCurrentUser();
            const messageId = getReactionPayloadMessageId(payload);
            const userId = getReactionPayloadUserId(payload);
            const channelId = getReactionPayloadChannelId(payload);

            if (!messageId) return;

            if (userId === currentUser?.id) {
                if (shouldIgnoreMentionBoxReaction(messageId)) return;
                startExternalReactionDismiss(messageId, channelId);
            } else {
                updateNoticeExternalReaction(messageId, channelId, (payload as any).emoji, 1);
                const notice = buildNoticeFromReaction(payload);
                if (notice) {
                    addNotice(notice);
                    preloadNoticeContext(notice);
                }
            }
        },

        MESSAGE_REACTION_REMOVE(payload: MessageReactionPayload) {
            const currentUser = UserStore.getCurrentUser();
            const messageId = getReactionPayloadMessageId(payload);
            const userId = getReactionPayloadUserId(payload);
            const channelId = getReactionPayloadChannelId(payload);

            if (!messageId) return;
            if (userId === currentUser?.id) return;

            updateNoticeExternalReaction(messageId, channelId, (payload as any).emoji, -1);
        }
    }
});


