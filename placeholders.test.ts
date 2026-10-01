/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getNativeFavoriteStickerIds, getReplyPlaceholderMatch, getReplyPlaceholderSuggestions, getReplyStickerId, resolveReplyPlaceholders, usesMessageContentPlaceholder } from "./placeholders";

test("only copying message content explicitly opts into its sticker", () => {
    assert.equal(usesMessageContentPlaceholder("Thanks for the ping!"), false);
    assert.equal(usesMessageContentPlaceholder("{message.link} {reply.content}"), false);
    assert.equal(usesMessageContentPlaceholder("{message.content}"), true);
    assert.equal(usesMessageContentPlaceholder("Copied: {message.content}"), true);
    assert.equal(resolveReplyPlaceholders("{message.content}", { "message.content": "" }), "");
});

test("the message-content placeholder remains selectable from partial autocomplete input", () => {
    const match = getReplyPlaceholderMatch("{message.con", 12);
    assert.deepEqual(match, { query: "message.con", startIndex: 0, endIndex: 12 });
    assert.equal(getReplyPlaceholderSuggestions({}, match!.query, ["message.content"])[0].key, "message.content");
});

test("the message-content placeholder prefers the original sticker when present", () => {
    assert.equal(getReplyStickerId("{message.content}", "different-selected-sticker", "original-sticker"), "original-sticker");
    assert.equal(getReplyStickerId("ordinary reply", "selected-sticker", "original-sticker"), "selected-sticker");
    assert.equal(getReplyStickerId("{message.content}", "selected-sticker"), "selected-sticker", "manual selection survives when this notice has no sticker");
    assert.equal(getReplyStickerId("{message.content}", null, null), null);
});

test("native favorite sticker IDs are read without writing Discord settings", () => {
    assert.deepEqual(getNativeFavoriteStickerIds({ stickerIds: ["123", 456n] }), ["123", "456"]);
    assert.deepEqual(getNativeFavoriteStickerIds(undefined), []);
    assert.deepEqual(getNativeFavoriteStickerIds({}), []);
});
