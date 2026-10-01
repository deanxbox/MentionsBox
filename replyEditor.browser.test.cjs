const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const pluginPath = path.join(__dirname, "index.tsx");
const source = fs.readFileSync(pluginPath, "utf8");
const ast = ts.createSourceFile(pluginPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wanted = new Set([
    "getReplyNodeRawText", "serializeReplyContent", "getUnicodeEmoji", "appendReplyText", "buildReplyEditorDom", "getReplyCursorOffset",
    "setReplyCaretOffset", "getReplyDomPoint", "setReplySelectionOffsets", "getReplyEditorHtml",
    "insertReplyEditorHtml", "insertReplyContent", "insertReplyContentAtSelection", "replaceReplyEditorContent",
    "hasUnrenderedReplyToken", "emojiToInsertText", "translateEmojiShortcodes"
]);
const declarations = ast.statements
    .filter(node => ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.text))
    .map(node => ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
    .join("\n");
assert.equal(wanted.size, new Set(ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.text)).map(node => node.name.text)).size, "production helper extraction incomplete");
const placeholdersPath = path.join(__dirname, "placeholders.ts");
const placeholdersAst = ts.createSourceFile(placeholdersPath, fs.readFileSync(placeholdersPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const wantedPlaceholders = new Set(["getReplyPlaceholderMatch", "resolveReplyPlaceholders"]);
const placeholderFunctions = placeholdersAst.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && wantedPlaceholders.has(node.name.text));
assert.equal(placeholderFunctions.length, wantedPlaceholders.size, "production placeholder helper extraction incomplete");
const placeholderDeclarations = placeholderFunctions
    .map(node => ts.transpileModule(node.getText(placeholdersAst).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
    .join("\n");
let updateDeclaration;
function findUpdateDeclaration(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "updateReplyFromEditor") updateDeclaration = node;
    ts.forEachChild(node, findUpdateDeclaration);
}
findUpdateDeclaration(ast);
assert.ok(updateDeclaration && ts.isCallExpression(updateDeclaration.initializer), "production editor update callback found");
const updateCallback = ts.transpileModule(updateDeclaration.initializer.arguments[0].getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const updateCallbackExpression = updateCallback.replace(/^"use strict";\s*/, "").trim().replace(/;$/, "");

const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH || "C:/Users/deanm/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright";
const { chromium } = require(playwrightPath);

(async() => {
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "C:/Users/deanm/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe"
    });
    try {
        const page = await browser.newPage();
        await page.setContent('<style>body{user-select:none;line-height:1}</style><div id="editor" class="vc-mentions-box-reply-input" contenteditable="true"></div>');
        await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, "styles.css"), "utf8") });
        await page.addScriptTag({ content: `
            const MENTION_OR_EMOJI_TOKEN_REGEX = /<@!?\\d+>|<a?:\\w+:\\d+>/g;
            const UserStore = { getUser: id => ({ username: id }) };
            const GuildMemberStore = { getMember: () => null };
            const RelationshipStore = { getNickname: () => null };
            const unicodeFixtures = new Map([
                ['😀', 'grinning'], ['👨‍👩‍👧‍👦', 'family_mwgb'], ['🇬🇧', 'flag_gb'],
                ['👍🏽', 'thumbsup_tone3'], ['1️⃣', 'one'], ['❤', 'heart'], ['❤️', 'heart'],
                ['©', 'copyright'], ['™', 'tm']
            ]);
            const emojisByName = new Map(Array.from(unicodeFixtures, ([surrogates, name]) => [name, { type: 0, surrogates, name }]));
            const EmojiParser = {
                convertSurrogateToName: (surrogate, colons = true) => {
                    const name = unicodeFixtures.get(surrogate);
                    return colons ? ':' + (name ?? '') + ':' : (name ?? '');
                },
                getByName: name => emojisByName.get(name)
            };
            const EmojiStore = { getDisambiguatedEmojiContext: () => { throw new Error('Unicode emoji must use EmojiParser.getByName'); } };
            const getEmojiImageUrl = ({ id, name, surrogates }) => ['©', '™'].includes(surrogates) ? '' : id ? 'https://cdn.example/' + id : 'https://cdn.example/unicode/' + encodeURIComponent(name);
            const findExactEmojiByName = name => name === 'smile' ? { id: '123', name: 'smile', animated: false } : null;
            const isVoiceReplyFile = () => false;
            const replyFiles = [];
            const notice = { guildId: null };
            const pendingCaretOffsetRef = { current: null };
            const isLocalEditRef = { current: false };
            let nextReplyContent = '';
            let replyContent = '';
            let nextCursorPos = 0;
            const setReplyContent = value => { nextReplyContent = replyContent = value; };
            const setCursorPos = value => { nextCursorPos = value; };
            const setReplyFiles = () => {};
            ${declarations}
            ${placeholderDeclarations}
            const updateReplyFromEditor = (${updateCallbackExpression});
            window.replyEditor = { serializeReplyContent, buildReplyEditorDom, getReplyCursorOffset, setReplySelectionOffsets,
                setReplyCaretOffset, getReplyDomPoint, insertReplyContent, insertReplyContentAtSelection, replaceReplyEditorContent, updateReplyFromEditor,
                getReplyPlaceholderMatch, resolveReplyPlaceholders,
                hasUnrenderedReplyToken, getContent: () => nextReplyContent, getCursorPos: () => nextCursorPos };
        ` });
        const result = await page.evaluate(() => {
            const editor = document.querySelector("#editor");
            const unicode = "😀👨‍👩‍👧‍👦🇬🇧👍🏽1️⃣❤❤️©™1";
            editor.textContent = unicode;
            updateReplyFromEditor(editor);
            const unicodeSerialized = serializeReplyContent(editor);
            const unicodeImageSources = Array.from(editor.querySelectorAll("img"), image => image.src);
            const unicodeAtomicRaw = Array.from(editor.querySelectorAll("[data-raw]"), token => token.dataset.raw);
            const unicodeAtomicOffsets = [0, 2, 13, 17, 21, 24, 25, 27, unicode.length].map(offset => {
                setReplyCaretOffset(editor, offset);
                return getReplyCursorOffset(editor);
            });
            const nonEmojiRemainder = Array.from(editor.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("");
            editor.innerHTML = 'first<div>second<span class="vc-mentions-box-reply-token" contenteditable="false" data-raw="<:smile:123>"><img alt=":smile:"></span>end</div><p>third</p>';
            const helpers = window.replyEditor;
            const serialized = helpers.serializeReplyContent(editor);
            const roundTripOffsets = [];
            for (let offset = 0; offset <= serialized.length; offset++) {
                if (offset > 12 && offset < 24) continue; // no caret stops inside an atomic emoji token
                helpers.setReplyCaretOffset(editor, offset);
                roundTripOffsets.push([offset, helpers.getReplyCursorOffset(editor)]);
            }
            const secondLinePoint = helpers.getReplyDomPoint(editor, 6);
            const thirdLinePoint = helpers.getReplyDomPoint(editor, 28);
            const nestedRawToken = document.createElement('p');
            nestedRawToken.appendChild(document.createTextNode('typed <:smile:123>'));
            const rawTokenDetected = helpers.hasUnrenderedReplyToken(nestedRawToken);
            nestedRawToken.innerHTML = '<span data-raw="<:smile:123>"><img></span>';
            const renderedTokenIgnored = helpers.hasUnrenderedReplyToken(nestedRawToken);
            helpers.setReplySelectionOffsets(editor, 2, 24);
            const selection = getSelection();
            const selected = helpers.serializeReplyContent(selection.getRangeAt(0).cloneContents());
            selection.collapse(editor.querySelector("p").firstChild, 2);
            const nestedCursor = helpers.getReplyCursorOffset(editor);
            getSelection().setBaseAndExtent(editor.querySelector("p").firstChild, 2, editor.firstChild, 2);
            const reverseSelectionAnchor = helpers.getReplyCursorOffset(editor);
            helpers.setReplyCaretOffset(editor, 7);
            const caretRaw = helpers.getReplyCursorOffset(editor);
            editor.focus();
            helpers.setReplySelectionOffsets(editor, 0, helpers.serializeReplyContent(editor).length);
            document.execCommand("insertHTML", false, '<b>replacement</b>');
            const afterInsert = editor.innerText;
            document.execCommand("undo");
            const afterUndo = helpers.serializeReplyContent(editor);
            document.execCommand("redo");
            const afterRedo = editor.innerText;
            editor.innerHTML = 'first<div>second<span class="vc-mentions-box-reply-token" contenteditable="false" data-raw="<:smile:123>"><img></span>end</div><p>third</p>';
            helpers.setReplySelectionOffsets(editor, 2, 24);
            document.execCommand("insertText", false, "X");
            const multilineReplace = helpers.serializeReplyContent(editor);
            document.execCommand("undo");
            const multilineUndo = helpers.serializeReplyContent(editor);
            editor.innerHTML = 'abc';
            helpers.setReplyCaretOffset(editor, 1);
            helpers.insertReplyContentAtSelection(editor, '<:smile:123>\n<@456>');
            const inserted = helpers.serializeReplyContent(editor);
            const atomicToken = editor.querySelector('[data-raw="<:smile:123>"]')?.contentEditable;
            document.execCommand("undo");
            const insertionUndo = helpers.serializeReplyContent(editor);
            document.execCommand("redo");
            const insertionRedo = helpers.serializeReplyContent(editor);
            helpers.setReplySelectionOffsets(editor, 1, 13);
            document.execCommand("delete");
            const tokenDelete = helpers.serializeReplyContent(editor);
            document.execCommand("undo");
            const tokenDeleteUndo = helpers.serializeReplyContent(editor);
            document.execCommand("redo");
            const tokenDeleteRedo = helpers.serializeReplyContent(editor);
            editor.innerHTML = 'start :smile: end';
            helpers.setReplyCaretOffset(editor, 12);
            helpers.updateReplyFromEditor(editor);
            const normalizedContent = helpers.serializeReplyContent(editor);
            const normalizedState = helpers.getContent();
            const normalizedCaret = helpers.getReplyCursorOffset(editor);
            document.execCommand('insertText', false, 'X');
            const typedAfterNormalize = helpers.serializeReplyContent(editor);
            return { unicodeSerialized, unicodeImageSources, unicodeAtomicRaw, unicodeAtomicOffsets, nonEmojiRemainder, serialized, roundTripOffsets, secondLineParent: secondLinePoint.node.parentElement?.tagName, thirdLineParent: thirdLinePoint.node.parentElement?.tagName, rawTokenDetected, renderedTokenIgnored, selected, nestedCursor, reverseSelectionAnchor, caretRaw, afterInsert, afterUndo, afterRedo, multilineReplace, multilineUndo, inserted, atomicToken, insertionUndo, insertionRedo, tokenDelete, tokenDeleteUndo, tokenDeleteRedo, normalizedContent, normalizedState, normalizedCaret, typedAfterNormalize };
        });
        assert.equal(result.unicodeSerialized, "😀👨‍👩‍👧‍👦🇬🇧👍🏽1️⃣❤❤️©™1");
        assert.deepEqual(result.unicodeAtomicRaw, ["😀", "👨‍👩‍👧‍👦", "🇬🇧", "👍🏽", "1️⃣", "❤", "❤️"]);
        assert.equal(result.unicodeImageSources.length, 7, "single/multicodepoint emoji use Discord's renderer, while symbols and digits remain plain text");
        assert.equal(result.nonEmojiRemainder, "©™1");
        assert.deepEqual(result.unicodeAtomicOffsets, [0, 2, 13, 17, 21, 24, 25, 27, 30]);
        assert.equal(result.serialized, "first\nsecond<:smile:123>end\nthird");
        assert.ok(result.roundTripOffsets.every(([wanted, actual]) => wanted === actual), "every valid raw offset round-trips through a DOM point");
        assert.equal(result.secondLineParent, "DIV");
        assert.equal(result.thirdLineParent, "P");
        assert.equal(result.rawTokenDetected, true);
        assert.equal(result.renderedTokenIgnored, false);
        assert.equal(result.selected, "rst\nsecond<:smile:123>");
        assert.equal(result.nestedCursor, 30);
        assert.equal(result.reverseSelectionAnchor, 30);
        assert.equal(result.caretRaw, 7);
        assert.equal(result.afterInsert, "replacement");
        assert.equal(result.afterUndo, result.serialized);
        assert.equal(result.afterRedo, "replacement");
        assert.equal(result.multilineReplace, "fiXend\nthird");
        assert.equal(result.multilineUndo, result.serialized);
        assert.equal(result.inserted, "a<:smile:123>\n<@456>bc");
        assert.equal(result.atomicToken, "false");
        assert.equal(result.insertionUndo, "abc");
        assert.equal(result.insertionRedo, result.inserted);
        assert.equal(result.tokenDelete, "a\n<@456>bc");
        assert.equal(result.tokenDeleteUndo, result.inserted);
        assert.equal(result.tokenDeleteRedo, result.tokenDelete);
        assert.equal(result.normalizedContent, "start <:smile:123> end");
        assert.equal(result.normalizedState, result.normalizedContent);
        assert.equal(result.normalizedCaret, 18);
        assert.equal(result.typedAfterNormalize, "start <:smile:123>X end");
        // Use the production whitespace and atomic-token layout for real keyboard input.
        await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, "styles.css"), "utf8") });
        await page.locator("#editor").evaluate(editor => { editor.className = "vc-mentions-box-reply-input"; });
        let insertionChecks = 0;
        for (const value of ["<@456>", "<:smile:123>", "😀", "hi <@456> and <:smile:123> 😀", "plain text"]) {
            for (const scenario of [
                { flow: "autocomplete/Tab", content: "x {mess", cursor: 7 },
                { flow: "autocomplete/mid-text", content: "pre {messpost", cursor: 9 },
                { flow: "autocomplete/trailing-brace", content: "pre {mess}post", cursor: 9 },
                { flow: "interaction-button draft", content: "old draft", cursor: 3 },
                { flow: "paste/selection", content: "ab", cursor: 1 },
                { flow: "replace/normalisation", content: "old draft", cursor: 3 }
            ]) {
                const inserted = await page.evaluate(({ value, scenario }) => {
                    const helpers = window.replyEditor;
                    const editor = document.querySelector("#editor");
                    const { content, cursor, flow } = scenario;
                    helpers.buildReplyEditorDom(content, editor);
                    editor.focus();
                    helpers.setReplyCaretOffset(editor, cursor);
                    helpers.updateReplyFromEditor(editor);
                    let start = 0;
                    let end = content.length;
                    let success;
                    if (flow.startsWith("autocomplete/")) {
                        const match = helpers.getReplyPlaceholderMatch(content, cursor);
                        if (!match) throw new Error("production placeholder match not found");
                        const trailingBrace = content[match.endIndex] === "}" ? 1 : 0;
                        start = match.startIndex;
                        end = match.endIndex + trailingBrace;
                        success = helpers.insertReplyContent(editor, start, end, value);
                    } else if (flow === "interaction-button draft") {
                        const resolved = helpers.resolveReplyPlaceholders("{message.content}", { "message.content": value });
                        success = helpers.insertReplyContent(editor, 0, content.length, resolved);
                    } else if (flow === "paste/selection") {
                        start = end = cursor;
                        success = helpers.insertReplyContentAtSelection(editor, value);
                    } else {
                        success = helpers.replaceReplyEditorContent(editor, value);
                    }
                    helpers.updateReplyFromEditor(editor);
                    const anchor = getSelection().anchorNode;
                    const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
                    return {
                        success, expected: content.slice(0, start) + value + "XY" + content.slice(end),
                        expectedCursor: start + value.length, cursor: helpers.getReplyCursorOffset(editor),
                        stateCursor: helpers.getCursorPos(), anchorInsideToken: !!anchorElement?.closest("[data-raw]")
                    };
                }, { value, scenario });
                const label = `${scenario.flow}: ${JSON.stringify(value)}`;
                assert.equal(inserted.success, true, `${label}: insertHTML succeeds`);
                await page.keyboard.type("XY");
                const typed = await page.evaluate(() => {
                    const editor = document.querySelector("#editor");
                    window.replyEditor.updateReplyFromEditor(editor);
                    return window.replyEditor.serializeReplyContent(editor);
                });
                assert.equal(typed, inserted.expected, `${label}: keyboard input lands immediately after the inserted value`);
                assert.equal(inserted.cursor, inserted.expectedCursor, `${label}: raw caret offset after insertion`);
                assert.equal(inserted.stateCursor, inserted.expectedCursor, `${label}: state caret offset after insertion`);
                assert.equal(inserted.anchorInsideToken, false, `${label}: selection anchor stays outside atomic tokens`);
                insertionChecks++;
            }
        }
        console.log(`Chromium real-keyboard insertion checks passed (${insertionChecks} scenarios)`);
        console.log("Chromium production editor helper checks passed", result);
    } finally {
        await browser.close();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
