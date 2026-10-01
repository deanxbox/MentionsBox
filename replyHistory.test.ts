/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import { pushReplyHistory, replyMediaUnchanged, shouldEditReply } from "./replyHistory";

test("history retains only its newest 100 entries", () => {
    const history = Array.from({ length: 100 }, (_, i) => i);
    pushReplyHistory(history, 100);
    assert.equal(history.length, 100);
    assert.equal(history[0], 1);
    assert.equal(history.at(-1), 100);
});

test("only pending or successful sends have edit identity", () => {
    assert.equal(shouldEditReply(undefined), false);
    assert.equal(shouldEditReply({}), false);
    assert.equal(shouldEditReply({ sentMessageId: "m1" }), true);
    assert.equal(shouldEditReply({ sendPromise: Promise.resolve("m1") }), true);
    assert.equal(shouldEditReply({ sendFailed: true, sendPromise: Promise.resolve("") }), false);
    assert.equal(shouldEditReply({ sentMessageId: "m1", sendFailed: true }), true);
});

test("content-only reply edits retain unchanged stickers and files", () => {
    const file = { name: "voice.ogg", type: "audio/ogg", size: 8, lastModified: 12 };
    assert.equal(replyMediaUnchanged(["sticker-1"], ["sticker-1"], [file], [{ ...file }]), true);
    assert.equal(replyMediaUnchanged(["sticker-1"], [], [file], [file]), false);
    assert.equal(replyMediaUnchanged([], [], [file], []), false);
});
