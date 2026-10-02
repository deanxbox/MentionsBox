const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const vencordRequire = createRequire(path.resolve(__dirname, "../../../package.json"));
const esbuild = vencordRequire("esbuild");
assert.match(esbuild.version, /^0\.28\./);
const reactModules = process.env.REACT_MODULES_PATH || "C:/Users/deanm/Coding Projects/Sparkle/node_modules/.pnpm/react-dom@19.2.4_react@19.2.4/node_modules";
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "C:/Users/deanm/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright");
const before = process.argv.includes("--before");
const emojiUrl = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="8" fill="#ffd54f"/><path d="M5 7h2m4 0h2M6 12q3 2 6 0" stroke="#333" fill="none"/></svg>');
const common = `
    import React from 'react';
    import * as ReactDOM from 'react-dom';
    export { ReactDOM };
    export { createRoot } from 'react-dom/client';
    export { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
    export const emoji = { type: 0, name: 'sob', uniqueName: 'sob', surrogates: '😭', url: ${JSON.stringify(emojiUrl)} };
    export const UserStore = { getUser: () => ({ username: 'Mason Plebanek' }), getCurrentUser: () => ({ id: '456', username: 'dean' }) };
    export const GuildMemberStore = { getMember: () => null };
    export const RelationshipStore = { getNickname: () => null };
    export const EmojiStore = { searchWithoutFetchingLatest: () => [emoji], getDisambiguatedEmojiContext: () => ({ getFrequentlyUsedReactionEmojisWithoutFetchingLatest: () => [], getFrequentlyUsedEmojis: () => [], getFavoriteEmojis: () => [] }) };
    export const StickersStore = { getStickerById: () => null };
    export const SelectedChannelStore = { getChannelId: () => 'channel' };
    export const Parser = { parse: content => content.split(/(<@!?\\d+>|😭)/).map((part, key) => part.startsWith('<@')
        ? React.createElement('span', { key, className: 'mention wrapper_f61d60 interactive' }, React.createElement('img', { className: 'vc-mentionAvatars-icon', src: ${JSON.stringify(emojiUrl)} }), '@Mason Plebanek')
        : part === '😭' ? React.createElement('img', { key, className: 'emoji', src: ${JSON.stringify(emojiUrl)}, alt: part }) : part) };
    export const useStateFromStores = (_stores, callback) => callback();
    export const UserProfileActions = { openUserProfileModal: () => { window.profileOpened = true; } };
    export const ChannelStore = { getChannel: () => null }, GuildStore = {}, MessageStore = {}, ReadStateStore = {}, UserSettingsProtoStore = {};
    export const FluxDispatcher = { dispatch: () => {} }, Forms = {}, Menu = {}, Modal = {}, NavigationRouter = {}, Constants = { GLOBAL_ENV: { MEDIA_PROXY_ENDPOINT: 'https://media.discordapp.net', CDN_HOST: 'cdn.discordapp.com' }, Endpoints: { MESSAGES: id => '/channels/' + id + '/messages' } }, RestAPI = { post: options => { window.sentBodies.push(options.body); return Promise.resolve({ body: { id: 'sent' } }); } };
    export const PermissionsBits = {}, PermissionStore = {}, Select = () => null;
    export const openMediaModal = () => {}, openModal = () => {};
`;
const stubs = {
    "@webpack/common": common,
    "@webpack": `import { emoji } from '@webpack/common';
        export const findByPropsLazy = key => key === 'convertSurrogateToName'
            ? { convertSurrogateToName: value => value === '😭' ? 'sob' : null, getByName: name => name === 'sob' ? emoji : null }
            : { getURL: () => emoji.url };
        export const findCssClassesLazy = () => ({}), findLazy = () => null, findByCodeLazy = () => null;`,
    "@api/Settings": `export const definePluginSettings = definitions => {
        const store = Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, value.default ?? value.options?.find(option => option.default)?.value]));
        Object.assign(store, { dialogueButtonMode: 'draft', preselectedDialogues: [{ id: 'copy', label: 'Copy message', content: '{message.content}' }], preloadMentionContext: false });
        return { store, use: () => store };
    };`,
    "@api/index": "export const DataStore = {};",
    "@api/ServerList": "export const addServerListElement = () => {}, removeServerListElement = () => {}, ServerListRenderPosition = {};",
    "@components/ErrorBoundary": "const ErrorBoundary = ({ children }) => children; ErrorBoundary.wrap = component => component; export default ErrorBoundary;",
    "@plugins/voiceMessages": "export const VoiceMessage = () => null;",
    "@utils/discord": "export const hasGuildFeature = () => false;",
    "@utils/types": "export default plugin => plugin; export const OptionType = {};",
    "@vencord/discord-types": "export {};",
    "@vencord/discord-types/enums": "export const ChannelType = {}, CloudUploadPlatform = {}, MessageFlags = {}, MessageType = {}, StickerFormatType = { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 };"
};
const discordCss = `
    body { user-select: none; line-height: 1; font-family: Arial, sans-serif; background: #313338; color: #dbdee1; }
    :root { --mention-background: rgba(88,101,242,.3); --mention-foreground: #c9cdfb; --font-weight-medium: 500; --brand-500: #5865f2; --white: #fff; --text-normal: #dbdee1; --text-muted: #aaa; --background-primary: #313338; --background-tertiary: #1e1f22; --custom-emoji-size-emoji: 22px; }
    .wrapper_f61d60 { background: var(--mention-background); border-radius: 3px; color: var(--mention-foreground); font-weight: var(--font-weight-medium); padding: 0 2px; unicode-bidi: plaintext; }
    .interactive { cursor: pointer; transition: background-color 50ms ease-out,color 50ms ease-out; }
    .interactive:hover { background: var(--brand-500); color: var(--white); }
    .emoji { height: var(--custom-emoji-size-emoji); width: var(--custom-emoji-size-emoji); object-fit: contain; vertical-align: bottom; }
    ${fs.readFileSync(path.resolve(__dirname, "../../plugins/mentionAvatars/styles.css"), "utf8")}
    #mount { width: 640px; margin: 30px; }
`;

async function bundle() {
    const result = await esbuild.build({
        stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
            import { MentionCard, serializeReplyContent, setReplySelectionOffsets } from './index.tsx';
            window.GLOBAL_ENV = { MEDIA_PROXY_ENDPOINT: 'https://media.discordapp.net' };
            window.sentBodies = [];
            const notice = { id: 'notice', kind: 'mention', channelId: 'channel', guildId: null, channelName: 'test', authorId: '123', authorName: 'Mason Plebanek', authorUsername: 'Mason Plebanek', authorDisplayName: 'Mason Plebanek', content: '<@123> test 😭', messageText: '<@123> test 😭', timestamp: Date.now(), media: [{ id: 'image', kind: 'image', url: ${JSON.stringify(emojiUrl)}, label: 'Image' }], replyChain: [{ id: 'reply', authorName: 'Mason Plebanek', content: 'Reply chain 😭', media: [] }], originalSticker: { id: '789', name: 'Wave', formatType: 1 } };
            const root = createRoot(document.getElementById('mount'));
            let key = 0;
            window.mountCard = () => root.render(React.createElement(MentionCard, { key: ++key, notice }));
            window.editorRaw = () => serializeReplyContent(document.querySelector('.vc-mentions-box-reply-input'));
            window.selectRaw = (start, end, reverse = false) => { const el = document.querySelector('.vc-mentions-box-reply-input'); el.focus(); setReplySelectionOffsets(el, start, end); if (reverse) { const s = getSelection(); s.setBaseAndExtent(s.focusNode, s.focusOffset, s.anchorNode, s.anchorOffset); } };
            window.mountCard();`, resolveDir: __dirname, loader: "tsx" },
        bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", jsxImportSource: "react",
        tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
        plugins: [{ name: "discord-stubs", setup(build) {
            build.onResolve({ filter: /^react(?:\/.*)?$|^react-dom(?:\/.*)?$/ }, args => ({ path: createRequire(path.join(reactModules, "react-dom/package.json")).resolve(args.path) }));
            build.onResolve({ filter: /^@/ }, args => {
                assert.ok(stubs[args.path], `missing stub: ${args.path}`);
                return { path: args.path, namespace: "stub" };
            });
            build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: stubs[args.path], loader: "js", resolveDir: __dirname }));
            build.onLoad({ filter: /index\.tsx$/ }, args => {
                let source = fs.readFileSync(args.path, "utf8");
                if (before) {
                    // Toggle only our insertion fix in memory; never revert the working tree.
                    source = source.replace(/function insertReplyEditorHtml\(container: HTMLElement, raw: string\) \{[\s\S]*?\n\}/, `function insertReplyEditorHtml(container: HTMLElement, raw: string) {
                        const inserted = document.execCommand('insertHTML', false, getReplyEditorHtml(raw, container.dataset.guildId ?? '', container.dataset.channelId ?? ''));
                        if (inserted) setReplyCaretOffset(container, getReplyCursorOffset(container));
                        return inserted;
                    }`).replace('mention interactive vc-mentions-box-reply-token vc-mentions-box-reply-token-mention', 'vc-mentions-box-reply-token vc-mentions-box-reply-token-mention')
                        .replace('isLocalEditRef.current = translated.content !== replyContent;', 'isLocalEditRef.current = true;');
                }
                // Observe the real hook ref without adding a production test API.
                source = source.replace('const isLocalEditRef = useRef(false);', 'const isLocalEditRef = useRef(false); window.localEditPending = () => isLocalEditRef.current;');
                return { contents: source + '\nexport { MentionCard, serializeReplyContent, setReplySelectionOffsets };', loader: "tsx", resolveDir: __dirname };
            });
            build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
        } }]
    });
    return result.outputFiles[0].text;
}

async function frames(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

(async() => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "C:/Users/deanm/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe" });
    let page;
    let clipboardBefore;
    try {
        page = await browser.newPage({ viewport: { width: 900, height: 700 }, permissions: ["clipboard-read", "clipboard-write"] });
        const errors = [];
        page.on("pageerror", error => { errors.push(error.message); console.error("Browser error:", error.message); });
        // An intercepted secure origin enables Chromium's real clipboard keyboard path.
        await page.route("https://mentionsbox.test/**", route => route.fulfill({ contentType: "text/html", body: '<div id="mount"></div>' }));
        await page.route("https://media.discordapp.net/**", route => route.abort());
        await page.goto("https://mentionsbox.test/");
        clipboardBefore = await page.evaluate(() => navigator.clipboard.readText());
        await page.addStyleTag({ content: discordCss + fs.readFileSync(path.join(__dirname, "styles.css"), "utf8") + (before ? `
            .vc-mentions-box-reply-input { user-select: none; -webkit-user-select: none; }
            .vc-mentions-box-reply-token { display: inline-flex; align-items: center; vertical-align: middle; border-radius: 3px; }
            .vc-mentions-box-reply-token-mention { color: var(--text-link, #00a8fc); font-weight: 500; background: var(--background-modifier-accent); unicode-bidi: normal; }
            .vc-mentions-box-content img.emoji, .vc-mentions-box-thread-content img.emoji,
            .vc-mentions-box-content img, .vc-mentions-box-thread-content img { width: 18px; height: 18px; vertical-align: -4px; }
            .vc-mentions-box-reply-token-emoji { width: 18px; height: 18px; vertical-align: -4px; }
        ` : "") });
        await page.addScriptTag({ content: await bundle() });
        await frames(page);
        assert.deepEqual(errors, [], "component runtime errors");
        const editor = page.locator(".vc-mentions-box-reply-input");
        const failures = [];
        for (const flow of ["Tab", "Enter", "mousedown", "mid-text Tab", "multi-line Tab", "Draft", "emoji", "paste", "reverse paste", "same draft", "normalisation"]) {
            await page.evaluate(() => window.mountCard());
            await frames(page);
            await editor.click();
            let value = "<@123> test 😭";
            if (["Tab", "Enter", "mousedown", "mid-text Tab", "multi-line Tab"].includes(flow)) {
                if (flow === "mid-text Tab") {
                    await editor.pressSequentially("pre  post");
                    await page.evaluate(() => window.selectRaw(4, 4));
                } else if (flow === "multi-line Tab") {
                    await editor.pressSequentially("pre");
                    await editor.press("Shift+Enter");
                }
                await editor.pressSequentially("{mess");
                const option = page.locator("#vc-mentions-box-placeholder-autocomplete-message-content");
                await option.waitFor();
                if (flow === "mousedown") {
                    await option.hover();
                    await page.mouse.down();
                    await page.mouse.up();
                } else await editor.press(flow === "Enter" ? "Enter" : "Tab");
            } else if (flow === "Draft" || flow === "same draft") {
                await page.getByRole("button", { name: "View interaction", exact: true }).click();
                await page.getByRole("button", { name: "Copy message", exact: true }).click();
                if (flow === "same draft") {
                    await page.getByRole("button", { name: "Copy message", exact: true }).click();
                    await frames(page);
                    const stale = await page.evaluate(() => window.localEditPending());
                    console.log(`Unchanged draft local-edit flag: ${stale}`);
                    if (!before) assert.equal(stale, false, "unchanged state must not leave a stale local-edit flag");
                }
            } else if (flow === "emoji") {
                value = "😭";
                await editor.pressSequentially(":so");
                await page.locator(".vc-mentions-box-autocomplete-item").waitFor();
                await editor.press("Tab");
            } else if (flow === "normalisation") {
                value = "😭";
                await editor.pressSequentially(":sob:");
            } else {
                if (flow === "reverse paste") {
                    await editor.pressSequentially("pre REPLACE post");
                    await page.evaluate(() => window.selectRaw(4, 11, true));
                }
                await page.evaluate(text => navigator.clipboard.writeText(text), value);
                await editor.press("Control+V");
            }
            await frames(page);
            if (["Tab", "Enter", "mousedown", "mid-text Tab", "multi-line Tab", "Draft", "same draft"].includes(flow)) {
                const sticker = await page.locator(".vc-mentions-box-selected-sticker-name").allTextContents();
                if (sticker[0] !== "Wave") failures.push({ flow, sticker, raw: await page.evaluate(() => window.editorRaw()) });
            }
            await editor.evaluate(el => { window.insertedTokens = Array.from(el.querySelectorAll('[data-raw]')); });
            await page.keyboard.type("XY");
            await frames(page);
            const expected = ["reverse paste", "mid-text Tab"].includes(flow) ? `pre ${value}XY post` : flow === "multi-line Tab" ? `pre\n${value}XY` : `${value}XY`;
            const actual = await page.evaluate(() => window.editorRaw());
            if (actual !== expected) failures.push({ flow, expected, actual });
            if (!before) assert.equal(await editor.evaluate(el => window.insertedTokens.every(token => el.contains(token))), true, `${flow}: local React update must preserve token DOM`);
            console.log(`${flow}: ${actual === expected ? "PASS" : "FAIL"} ${JSON.stringify(actual)}`);
        }
        await page.evaluate(() => window.mountCard());
        await frames(page);
        await page.getByRole("button", { name: "View interaction", exact: true }).click();
        await page.getByRole("button", { name: "Copy message", exact: true }).click();
        await page.getByRole("button", { name: "View reply chain", exact: true }).click();
        await frames(page);
        await page.evaluate(() => document.activeElement.blur());
        const screenshot = path.join(os.tmpdir(), `mentionsbox-${before ? "before" : "after"}.png`);
        await page.screenshot({ path: screenshot });
        console.log(`Screenshot: ${screenshot}`);
        if (!before) {
            await page.getByRole("button", { name: "Reply", exact: true }).click();
            await page.waitForFunction(() => window.sentBodies.length === 1, null, { timeout: 3000 });
            const copiedContent = await page.evaluate(() => window.sentBodies[0].content);
            assert.ok(copiedContent.includes(emojiUrl), "message-content button draft sends the image URL");
            await page.getByRole("button", { name: "Remove copied image", exact: true }).click();
            assert.equal(await page.locator(".vc-mentions-box-reply-image-chip").count(), 0, "removed image chip disappears");
            await page.getByRole("button", { name: "Reply", exact: true }).click();
            await page.waitForFunction(() => window.sentBodies.length === 2, null, { timeout: 3000 });
            assert.equal(await page.evaluate(url => window.sentBodies[1].content.includes(url), emojiUrl), false, "removed image is omitted from outgoing content");
        }
        assert.equal(await page.locator(".vc-mentions-box-reply-image-chip").count(), 0, "removing an image chip omits its URL");
        const measurements = await page.evaluate(() => {
            const measure = (selector, textNeedle) => {
                const el = document.querySelector(selector);
                const mention = el.querySelector('[data-raw^="<@"], .mention');
                const emoji = el.querySelector('img.emoji, .vc-mentions-box-reply-token-emoji');
                const text = [el, ...el.querySelectorAll('*')].flatMap(node => Array.from(node.childNodes)).find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes(textNeedle));
                const textRange = document.createRange(); textRange.selectNodeContents(text);
                const pillRange = document.createRange();
                if (mention) pillRange.selectNodeContents(mention.lastChild);
                const centre = rect => rect.top + rect.height / 2;
                const avatar = el.querySelector('.vc-mentionAvatars-icon');
                const css = getComputedStyle(el);
                // Compare auto-sized line boxes against the same native mention without emoji.
                // MentionAvatars' own bottom margin can exceed the nominal notice line-height.
                const clone = el.cloneNode(true);
                Object.assign(clone.style, { position: 'absolute', visibility: 'hidden', height: 'auto', minHeight: '0', width: '600px' });
                document.body.appendChild(clone);
                const lineBox = clone.getBoundingClientRect().height;
                clone.querySelectorAll('img.emoji, .vc-mentions-box-reply-token-emoji').forEach(img => img.replaceWith(document.createTextNode('x')));
                const plainLineBox = clone.getBoundingClientRect().height;
                clone.remove();
                const emojiStyle = getComputedStyle(emoji);
                return { text: centre(textRange.getBoundingClientRect()), pill: mention ? centre(pillRange.getBoundingClientRect()) : null, emoji: centre(emoji.getBoundingClientRect()), emojiWidth: emoji.getBoundingClientRect().width, emojiHeight: emoji.getBoundingClientRect().height, emojiFontSize: parseFloat(emojiStyle.fontSize), lineHeight: css.lineHeight, lineBox, plainLineBox, avatarHeight: avatar?.getBoundingClientRect().height, tokenDisplay: mention ? getComputedStyle(mention).display : null, tokenRaw: mention?.dataset.raw };
            };
            const reference = document.createElement('div');
            reference.className = 'vc-mentions-box-content';
            reference.style.cssText = 'position:absolute;visibility:hidden;font-size:16px;line-height:20px';
            reference.innerHTML = 'reference <img class="emoji" src="' + document.querySelector('.vc-mentions-box-content img.emoji').src + '">';
            document.body.appendChild(reference);
            const image = reference.querySelector('img');
            const referenceSize = { width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(image).fontSize) };
            reference.remove();
            return {
                notice: measure('.vc-mentions-box-content', 'test'),
                chain: measure('.vc-mentions-box-thread-content', 'Reply chain'),
                editor: measure('.vc-mentions-box-reply-input', 'test'),
                referenceSize
            };
        });
        console.log("Measurements:", JSON.stringify(measurements));
        if (!before) for (const [name, rects] of Object.entries(measurements).filter(([name]) => name !== "referenceSize")) {
            if (rects.pill !== null) assert.ok(Math.abs(rects.text - rects.pill) <= 1, `${name}: pill baseline ${JSON.stringify(rects)}`);
            assert.ok(Math.abs(rects.text - rects.emoji) <= 1.5, `${name}: emoji baseline ${JSON.stringify(rects)}`);
            assert.ok(Math.abs(rects.emojiWidth - rects.emojiFontSize * 1.375) <= 0.1, `${name}: emoji width is 1.375em ${JSON.stringify(rects)}`);
            assert.ok(Math.abs(rects.emojiHeight - rects.emojiFontSize * 1.375) <= 0.1, `${name}: emoji height is 1.375em ${JSON.stringify(rects)}`);
            if (rects.tokenDisplay !== null) assert.equal(rects.tokenDisplay, "inline");
            assert.equal(rects.lineBox, rects.plainLineBox, `${name}: emoji must not grow the line box`);
        }
        if (!before) {
            assert.ok(Math.abs(measurements.referenceSize.width - 22) <= 0.1, "16px inline emoji width is 22px");
            assert.ok(Math.abs(measurements.referenceSize.height - 22) <= 0.1, "16px inline emoji height is 22px");
        }
        if (!before) {
            assert.equal(measurements.notice.avatarHeight, 13, "notice rule must not override MentionAvatars sizing");
            assert.equal(measurements.editor.tokenRaw, "<@123>");
            const mention = editor.locator('.mention.interactive[data-raw="<@123>"]');
            assert.equal(await mention.getAttribute("contenteditable"), "false");
            await mention.click();
            assert.equal(await page.evaluate(() => window.profileOpened), true, "mention still opens the profile");
            assert.equal(await page.getByRole("button", { name: "Copy sticker to reply", exact: true }).count(), 0);
        }
        assert.deepEqual(errors, [], "component runtime errors");
        assert.deepEqual(failures, [], "real MentionCard insertion regressions");
        console.log("Real MentionCard component checks passed");
    } finally {
        if (page && clipboardBefore !== undefined) await page.evaluate(text => navigator.clipboard.writeText(text), clipboardBefore);
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
