const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const filename = path.join(__dirname, "index.tsx");
const text = fs.readFileSync(filename, "utf8");
const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const managerPath = path.join(__dirname, "manager.ts");
const managerAst = ts.createSourceFile(managerPath, fs.readFileSync(managerPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const sortNode = managerAst.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "filterAndSortNotices");
assert.ok(sortNode, "production display ordering function found");
const sortCode = ts.transpileModule(sortNode.getText(managerAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^export\s+/, "");
const filterAndSortNotices = new Function(`${sortCode}; return filterAndSortNotices;`)();
function getFunction(name) {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, `production ${name} function found`);
    return ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function getCallback(name) {
    let declaration;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(declaration?.initializer && ts.isCallExpression(declaration.initializer), `production ${name} callback found`);
    const code = ts.transpileModule(declaration.initializer.arguments[0].getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return code.replace(/^"use strict";\s*/, "").trim().replace(/;$/, "");
}
function createNoticeState(initialNotices, recorded) {
    const declarations = `${getFunction("setNotices")}\n${getFunction("removeNotice")}\n${getFunction("addNotice")}\n${getFunction("removeNoticeForMessage")}\n${getFunction("removeNoticeForReply")}`;
    return new Function("initialNotices", "recorded", `
        let notices = initialNotices;
        const discardedNoticeHistory = recorded;
        const restoredReplyEntries = new Map();
        const dismissedNoticeIds = new Set();
        const pendingReplyNoticeRemovalIds = new Set();
        const emitChange = () => {};
        const markNoticeRead = () => {};
        const pushReplyHistory = (list, entry) => { list.push(entry); if (list.length > 100) list.splice(0, list.length - 100); };
        const getStoredMentionsLimit = () => 100;
        ${declarations}
        return { setNotices, removeNotice, addNotice, removeNoticeForReply, discardedNoticeHistory, restoredReplyEntries,
            dismissedNoticeIds, get notices() { return notices; }, set notices(value) { notices = value; } };
    `)(initialNotices, recorded);
}

async function testLifecyclePreservesSentIdentity() {
    const notice = { id: "mention-1", timestamp: 1 };
    const state = createNoticeState([notice], []);
    const sentEntry = state.removeNotice(notice.id, "reply draft", [], []);
    sentEntry.sentMessageId = "sent-99";
    state.restoredReplyEntries.set(notice.id, sentEntry);
    state.addNotice({ ...notice, timestamp: 2 }, false); // global undo restoration
    state.removeNotice(notice.id); // dismiss restored card
    const secondUndo = state.discardedNoticeHistory.at(-1);
    assert.equal(secondUndo.replyContent, "reply draft");
    assert.equal(secondUndo.sentMessageId, "sent-99");
}

function testHistoryCapacityAndUnsentRestoration() {
    const entries = [];
    const state = createNoticeState(Array.from({ length: 101 }, (_, id) => ({ id: String(id) })), entries);
    state.setNotices([]);
    assert.equal(entries.length, 100);
    assert.equal(entries[0].notice.id, "1");
    const unsent = createNoticeState([{ id: "unsent" }], []);
    const saved = unsent.removeNotice("unsent", "draft", [], []);
    unsent.restoredReplyEntries.set("unsent", saved);
    unsent.addNotice({ id: "unsent" }, false);
    const removedAgain = unsent.removeNotice("unsent");
    assert.equal(removedAgain.replyContent, "draft");
    assert.equal(Boolean(removedAgain.sentMessageId || removedAgain.sendPromise), false);
}

function testOpeningStickerNoticeDoesNotSelectItsSticker() {
    const code = getFunction("getRestoredNoticeSticker");
    const getRestoredNoticeSticker = new Function("restoredReplyEntries", "StickersStore", `${code}; return getRestoredNoticeSticker;`)(new Map(), { getStickerById: () => undefined });
    assert.equal(getRestoredNoticeSticker({ id: "notice", originalSticker: { id: "original-id", name: "sticker" } }), null);
}

function testTextMessagesKeepTheirOriginalSticker() {
    const code = ["getOriginalSticker", "getStickerName", "getStickerFormatType"].map(getFunction).join("\n");
    const getOriginalSticker = new Function("StickersStore", `${code}; return getOriginalSticker;`)({ getStickerById: () => undefined });
    const sticker = { id: "s1", name: "Wave", format_type: 1 };
    const expected = { id: "s1", name: "Wave", formatType: 1 };
    assert.deepEqual(getOriginalSticker({ content: "hello", sticker_items: [sticker] }), expected);
    assert.deepEqual(getOriginalSticker({ content: "hi", stickerItems: [sticker] }), expected);
    assert.equal(getOriginalSticker({ content: "hello" }), null);
}

function testStickerUpdatesPreserveOrClearTheOriginalSticker() {
    const code = ["updateNoticeMessage", "getOriginalSticker", "getStickerName", "getStickerFormatType"].map(getFunction).join("\n");
    const originalSticker = { id: "s1", name: "Wave", formatType: 1 };
    const state = new Function("originalSticker", `
        let notices = [{ id: "notice", channelId: "channel", content: "hello", media: [], originalSticker }];
        const MessageStore = { getMessage: () => ({ sticker_items: [{ id: "s1", name: "Wave", format_type: 1 }] }) };
        const StickersStore = { getStickerById: () => undefined };
        const formatContent = message => message.content;
        const collectMessageMedia = () => [];
        const setNotices = value => { notices = value; };
        ${code}
        return { updateNoticeMessage, get notice() { return notices[0]; } };
    `)(originalSticker);
    state.updateNoticeMessage({ id: "notice", channel_id: "channel", content: "edited" });
    assert.equal(state.notice.originalSticker, originalSticker, "text-only edits preserve the existing sticker object");
    for (const key of ["sticker_items", "stickerItems", "stickers"]) {
        state.updateNoticeMessage({ id: "notice", channel_id: "channel", [key]: [{ id: "s2", name: "New", format_type: 1 }] });
        assert.equal(state.notice.originalSticker.id, "s2");
        state.updateNoticeMessage({ id: "notice", channel_id: "channel", [key]: [] });
        assert.equal(state.notice.originalSticker, null, "explicit empty sticker updates clear even when the store is stale");
    }
}

function testAutocompleteTokenAndValuePathsSelectTheOriginalSticker() {
    const callback = getCallback("insertAutocompletedPlaceholder");
    for (const mode of ["token", "value"]) {
        const calls = { insert: [], update: [], selected: [] };
        const input = { focus() {} };
        const imageState = [];
        const action = new Function("placeholderMatch", "replyContent", "replyInputRef", "insertReplyContent", "updateReplyFromEditor", "setSelectedSticker", "notice", "requestAnimationFrame", "getReplyImageUrls", "setCopiedReplyImageUrls", "setRemovedReplyImageUrls", `return ${callback};`)(
            { startIndex: 0, endIndex: 4 }, "{mes", { current: input }, (...args) => { calls.insert.push(args); return true; },
            value => calls.update.push(value), value => calls.selected.push(value),
            { originalSticker: { id: "original", name: "Sticker" }, media: [{ kind: "image", url: "https://cdn.test/a.png" }] }, fn => fn(),
            (_token, media) => media.map(item => item.url), value => imageState.push(value), value => imageState.push(value)
        );
        action({ key: "message.content", token: "{message.content}", resolvedValue: "the original text" }, mode);
        assert.deepEqual(calls.insert[0].slice(0, 3), [input, 0, 4]);
        assert.equal(calls.insert[0][3], mode === "token" ? "{message.content}" : "the original text");
        assert.equal(calls.selected[0].id, "original");
        assert.equal(calls.update[0], input);
        assert.deepEqual(imageState, [["https://cdn.test/a.png"], []], "explicit placeholder insertion previews original image attachments");
    }
    const untouched = [];
    const noStickerAction = new Function("placeholderMatch", "replyContent", "replyInputRef", "insertReplyContent", "updateReplyFromEditor", "setSelectedSticker", "notice", "requestAnimationFrame", "getReplyImageUrls", "setCopiedReplyImageUrls", "setRemovedReplyImageUrls", `return ${callback};`)(
        { startIndex: 0, endIndex: 4 }, "{mes", { current: { focus() {} } }, () => true, () => {}, value => untouched.push(value), {}, () => {}, () => [], () => {}, () => {}
    );
    noStickerAction({ key: "message.content", token: "{message.content}", resolvedValue: "text" }, "token");
    assert.deepEqual(untouched, [], "autocomplete leaves any manually selected sticker unchanged when notice has none");
}

function testDialogueSendAndDraftUseOriginalStickerExplicitly() {
    const callback = getCallback("useInteractionReply");
    const sent = [];
    const send = new Function("dialogueButtonMode", "dispatchReply", "notice", "settings", "replyInputRef", "replyContent", "insertReplyContent", "updateReplyFromEditor", "setSelectedSticker", "requestAnimationFrame", "getReplyImageUrls", "appendReplyImageUrls", "setCopiedReplyImageUrls", "setRemovedReplyImageUrls", `const DialogueButtonMode = { Send: "send", Draft: "draft" }; return ${callback};`)(
        "send", (...args) => sent.push(args), { originalSticker: { id: "original", name: "Sticker" }, media: [] },
        { store: { jumpOnReply: false } }, { current: null }, "", () => true, () => {}, () => {}, () => {}, () => [], (content, urls) => urls.length ? `${content} ${urls.join(" ")}` : content, () => {}, () => {}
    );
    send({ preventDefault() {}, stopPropagation() {} }, "resolved message", true);
    assert.deepEqual(sent[0].slice(0, 3), ["resolved message", ["original"], []]);

    const draft = [];
    const insertCalls = [];
    const useDraft = new Function("dialogueButtonMode", "dispatchReply", "notice", "settings", "replyInputRef", "replyContent", "insertReplyContent", "updateReplyFromEditor", "setSelectedSticker", "requestAnimationFrame", "getReplyImageUrls", "appendReplyImageUrls", "setCopiedReplyImageUrls", "setRemovedReplyImageUrls", `const DialogueButtonMode = { Send: "send", Draft: "draft" }; return ${callback};`)(
        "draft", () => {}, { originalSticker: { id: "original", name: "Sticker" }, media: [] }, { store: {} },
        { current: { focus() {} } }, "draft", (...args) => { insertCalls.push(args); return true; }, () => {}, value => draft.push(value), fn => fn(), () => [], (content, urls) => urls.length ? `${content} ${urls.join(" ")}` : content, () => {}, () => {}
    );
    useDraft({ preventDefault() {}, stopPropagation() {} }, "resolved message", true);
    assert.deepEqual(insertCalls[0].slice(1), [0, 5, "resolved message"]);
    assert.equal(draft[0].id, "original");
}

function testUndoKeepsNewestFirstQueueAndDisplaysBothSortOrders() {
    const state = createNoticeState([{ id: "newer", timestamp: 30 }, { id: "older", timestamp: 10 }], []);
    state.addNotice({ id: "restored", timestamp: 40 }, false);
    assert.deepEqual(state.notices.map(notice => notice.id), ["restored", "newer", "older"]);
    assert.deepEqual(filterAndSortNotices(state.notices, "newest", "all", "").map(notice => notice.id), ["restored", "newer", "older"]);
    assert.deepEqual(filterAndSortNotices(state.notices, "oldest", "all", "").map(notice => notice.id), ["older", "newer", "restored"]);

    const full = createNoticeState(Array.from({ length: 100 }, (_, index) => ({ id: `notice-${index}`, timestamp: 99 - index })), []);
    full.addNotice({ id: "restored", timestamp: 100 }, false);
    assert.equal(full.notices.length, 100);
    assert.equal(full.notices[0].id, "restored");
    assert.equal(full.notices.some(notice => notice.id === "notice-99"), false);
    assert.equal(filterAndSortNotices(full.notices, "oldest", "all", "").at(-1).id, "restored");
}

async function testExternalDiscordReplyRemovalRecordsIdentity() {
    const mention = { id: "mention-2", channelId: "channel-2", timestamp: 1 };
    const state = createNoticeState([mention], []);
    assert.equal(state.removeNoticeForReply({
        id: "external-reply-1",
        content: "reply text",
        message_reference: { message_id: "mention-2", channel_id: "channel-2" }
    }), true);
    const entry = state.discardedNoticeHistory.at(-1);
    assert.equal(entry.sentMessageId, "external-reply-1");
    assert.equal(entry.replyContent, "reply text");
    const patchCalls = [];
    const editDeclaration = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "editReplyToNotice");
    const editCode = ts.transpileModule(editDeclaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const edit = new Function("RestAPI", `${editCode}; return editReplyToNotice;`)({ patch: async request => patchCalls.push(request) });
    await edit({ channelId: mention.channelId }, "edited reply", entry);
    assert.equal(patchCalls[0].url, "/channels/channel-2/messages/external-reply-1");

    state.restoredReplyEntries.set(mention.id, { ...entry, sentMessageId: "existing-identity", replyContent: "kept" });
    state.notices = [mention];
    state.removeNoticeForReply({ id: "external-reply-2", content: "new content", message_reference: { message_id: mention.id } });
    const preserved = state.discardedNoticeHistory.at(-1);
    assert.equal(preserved.sentMessageId, "existing-identity");
    assert.equal(preserved.replyContent, "kept");
}

function testGlobalUndoLeavesTextInputCtrlZAlone() {
    const typing = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "isTypingTarget");
    const listener = ast.statements.find(item => ts.isVariableStatement(item)
        && item.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "globalKeydownListener"));
    assert.ok(typing && listener, "production keybind helpers found");
    class MockHTMLElement {
        constructor(isTextbox) { this.isContentEditable = false; this.isTextbox = isTextbox; }
        closest() { return this.isTextbox ? {} : null; }
    }
    const typingCode = ts.transpileModule(typing.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const isTypingTarget = new Function("HTMLElement", `${typingCode}; return isTypingTarget;`)(MockHTMLElement);
    const history = [{ notice: { id: "undo-me", externalReactionDismissStartedAt: 123, externalReactionDismissDurationMs: 4000 } }];
    const restored = new Map();
    const noticeAdds = [];
    const listenerCode = ts.transpileModule(listener.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const keydown = new Function("isRecordingKeybind", "discardedNoticeHistory", "dismissedNoticeIds", "restoredReplyEntries", "addNotice", "isTypingTarget", "shouldHandleGlobalKeybind", "settings", "consumeGlobalKeybind", "toggleNotificationsHidden", "toggleDialogueButtonMode", "toggleJumpOnReply", "toggleSourceFilter", `${listenerCode}; return globalKeydownListener;`)(
        false, history, new Set(), restored, (...args) => noticeAdds.push(args), isTypingTarget, () => false, { store: {} }, () => {}, () => {}, () => {}, () => {}, () => {}
    );
    const textInputEvent = { target: new MockHTMLElement(true), key: "z", ctrlKey: true, metaKey: false, shiftKey: false, repeat: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    keydown(textInputEvent);
    assert.equal(textInputEvent.prevented, undefined);
    assert.equal(history.length, 1);
    const outsideEvent = { ...textInputEvent, target: new MockHTMLElement(false), prevented: false, preventDefault() { this.prevented = true; } };
    keydown(outsideEvent);
    assert.equal(outsideEvent.prevented, true);
    assert.equal(noticeAdds.length, 1);
    assert.equal(restored.get("undo-me").notice.id, "undo-me");
    assert.equal(noticeAdds[0][0].externalReactionDismissStartedAt, undefined);
    assert.equal(noticeAdds[0][0].externalReactionDismissDurationMs, undefined);
}

async function testEditFailureNeverFallsThroughToPost() {
    const patchCalls = [];
    const postCalls = [];
    const restApi = {
        patch: async request => { patchCalls.push(request); throw new Error("PATCH failed"); },
        post: async request => { postCalls.push(request); return {}; }
    };
    const fn = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "editReplyToNotice");
    assert.ok(fn, "production editReplyToNotice function found");
    const code = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const edit = new Function("RestAPI", `${code}; return editReplyToNotice;`)(restApi);
    await assert.rejects(edit({ channelId: "channel-1" }, "draft", { sentMessageId: "sent-99" }));
    assert.equal(patchCalls.length, 1);
    assert.equal(postCalls.length, 0);
}

async function testPendingSendIdentityIsAwaitedBeforePatch() {
    let resolveSend;
    const sendPromise = new Promise(resolve => { resolveSend = resolve; });
    const patchCalls = [];
    const restApi = { patch: async request => { patchCalls.push(request); } };
    const fn = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "editReplyToNotice");
    const code = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const edit = new Function("RestAPI", `${code}; return editReplyToNotice;`)(restApi);
    const entry = { sendPromise };
    const pendingEdit = edit({ channelId: "channel-2" }, "draft", entry);
    await Promise.resolve();
    assert.equal(patchCalls.length, 0);
    resolveSend("sent-123");
    assert.equal(await pendingEdit, "sent-123");
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].url, "/channels/channel-2/messages/sent-123");
}

async function testOriginalStickerUsesSharedSendAndOptionalCloneFallback() {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "sendReplyToNoticeWithCooldownRetry");
    assert.ok(node, "production sticker send choke point found");
    const code = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const originalCalls = [];
    const sent = [];
    const cleaned = [];
    let stagingEnabled = false;
    const prepareCloneFallback = async(_channelId, content, stickerIds, _guildId, assets) => {
        originalCalls.push([...stickerIds]);
        if (stagingEnabled) {
            assets.push({ type: "sticker", id: "staged-id", guildId: "staging" });
            return { sendContent: content, stickerIds: stickerIds.map(id => id === "original-id" ? "staged-id" : id) };
        }
        return { sendContent: content, stickerIds };
    };
    const sendReplyToNotice = async(_notice, content, stickerIds) => { sent.push({ content, stickerIds }); return "sent"; };
    const send = new Function("settings", "uploadReplyAttachment", "prepareCloneFallback", "sendReplyToNotice", "deleteClonedEmoji", "deleteClonedSticker", "isSendCooldownError", "SLOWMODE_REPLY_RETRY_DELAY_MS", "wait", `${code}; return sendReplyToNoticeWithCooldownRetry;`)(
        { store: { enableCloneFallback: false, cloneServerGuildId: "staging" } }, async() => null, prepareCloneFallback, sendReplyToNotice,
        async asset => cleaned.push(asset.id), async asset => cleaned.push(asset.id), () => false, 1, async() => {}
    );
    const notice = { channelId: "channel" };
    await send(notice, "reply", ["original-id"]);
    assert.deepEqual(sent[0].stickerIds, ["original-id"], "normal send preserves the notice's exact sticker ID");
    assert.equal(originalCalls.length, 0, "the user's disabled fallback setting is respected");

    stagingEnabled = true;
    const withFallback = new Function("settings", "uploadReplyAttachment", "prepareCloneFallback", "sendReplyToNotice", "deleteClonedEmoji", "deleteClonedSticker", "isSendCooldownError", "SLOWMODE_REPLY_RETRY_DELAY_MS", "wait", `${code}; return sendReplyToNoticeWithCooldownRetry;`)(
        { store: { enableCloneFallback: true, cloneServerGuildId: "staging" } }, async() => null, prepareCloneFallback, sendReplyToNotice,
        async asset => cleaned.push(asset.id), async asset => cleaned.push(asset.id), () => false, 1, async() => {}
    );
    await withFallback(notice, "reply", ["original-id"]);
    assert.deepEqual(originalCalls[0], ["original-id"], "fallback receives the exact original sticker before any remapping");
    assert.deepEqual(sent[1].stickerIds, ["staged-id"]);
    assert.deepEqual(cleaned, ["staged-id"]);
}

(async() => {
    await testLifecyclePreservesSentIdentity();
    testHistoryCapacityAndUnsentRestoration();
    testOpeningStickerNoticeDoesNotSelectItsSticker();
    testTextMessagesKeepTheirOriginalSticker();
    testStickerUpdatesPreserveOrClearTheOriginalSticker();
    testAutocompleteTokenAndValuePathsSelectTheOriginalSticker();
    testDialogueSendAndDraftUseOriginalStickerExplicitly();
    testUndoKeepsNewestFirstQueueAndDisplaysBothSortOrders();
    await testExternalDiscordReplyRemovalRecordsIdentity();
    testGlobalUndoLeavesTextInputCtrlZAlone();
    await testEditFailureNeverFallsThroughToPost();
    await testPendingSendIdentityIsAwaitedBeforePatch();
    await testOriginalStickerUsesSharedSendAndOptionalCloneFallback();
    console.log("MentionsBox production notice lifecycle checks passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
