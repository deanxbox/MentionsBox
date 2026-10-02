/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { appendReplyImageUrls, getNativeFavoriteStickerIds, getReplyImageUrls, getReplyPlaceholderMatch, getReplyPlaceholderSuggestions, getReplyStickerId, resolveReplyPlaceholders, usesMessageContentPlaceholder } from "./placeholders";

test("message content copies only unique image and GIF URLs and preserves existing URLs", () => {
    const media = [
        { kind: "image", url: "https://cdn.test/a.png?ex=1" },
        { kind: "gif", url: "https://cdn.test/a.png?ex=1" },
        { kind: "video", url: "https://cdn.test/movie.mp4" }
    ];
    assert.deepEqual(getReplyImageUrls("{message.content}", media), ["https://cdn.test/a.png?ex=1"]);
    assert.deepEqual(getReplyImageUrls("{message.content} https://cdn.test/a.png?ex=1", media), []);
    assert.deepEqual(getReplyImageUrls("ordinary content", media), []);
    const urls = getReplyImageUrls("{message.content}", media);
    const replacements = { "message.content": "" };
    assert.equal(appendReplyImageUrls(resolveReplyPlaceholders("{message.content}", replacements), urls), "https://cdn.test/a.png?ex=1", "image-only notices still produce sendable content");
    assert.equal(appendReplyImageUrls(resolveReplyPlaceholders("Copied: {message.content}", { "message.content": "original text" }), urls), "Copied: original text https://cdn.test/a.png?ex=1", "typed placeholders and button drafts append image URLs");
    assert.equal(appendReplyImageUrls("original text", getReplyImageUrls("{message.content}", media)), "original text https://cdn.test/a.png?ex=1", "autocomplete value retains its explicit placeholder media");
    assert.equal(appendReplyImageUrls("ordinary reply", getReplyImageUrls("ordinary reply", media)), "ordinary reply", "passive and non-placeholder replies do not copy images");
    assert.equal(appendReplyImageUrls("original text", urls.filter(url => url !== "https://cdn.test/a.png?ex=1")), "original text", "removed image chips omit their URLs");
    assert.equal(appendReplyImageUrls("", ["https://cdn.test/a.png?ex=1"]), "https://cdn.test/a.png?ex=1");
    assert.equal(appendReplyImageUrls("text https://cdn.test/a.png?ex=1", ["https://cdn.test/a.png?ex=1"]), "text https://cdn.test/a.png?ex=1");
});

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
