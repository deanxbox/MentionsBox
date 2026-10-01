# MentionsBox

MentionsBox is a simple Vencord user plugin that shows recent mentions in a clean notification stack at the top of Discord.

## Features

- Shows a top-screen notification when someone mentions you.
- Can instead appear as a button above the server/channel section, opening a scrollable MentionsBox manager.
- The manager can search and filter mentions, reverse their order, select individual cards, refresh unread mentions, and clear selected or all cards.
- After replying to or dismissing a managed card, focus advances to the next visible mention.
- Works across servers, DMs, and group DMs.
- Shows the server and channel for server mentions.
- Click a notification to jump directly to the mentioned message.
- Dismiss notifications without jumping by clicking the `x`.
- React to the mentioned message from the notification with your five most-used reaction emojis.
- Reply to the mentioned message directly from the notification.
- Restore the most recently dismissed mention with Ctrl+Z outside text-entry fields; undoing a sent reply restores its draft and edits the same message on resend.
- Render Unicode emoji, custom emoji, and mentions as atomic inline items in the reply editor.
- Show Discord's native favourite stickers in the reply picker; the Favourites tab is selected by default and stays read-only.
- Selecting `{message.content}` explicitly sends the notice's exact original sticker when it contains one. Sticker sending follows Discord's normal availability rules; the optional clone fallback applies only when enabled and configured with a writable staging server.
- Expand notifications to preview reply chains and new replies.
- Renders Discord emoji, custom emoji, stickers, GIFs, and image previews inside mention notifications.
- Adds Read more controls for longer message previews.
- Optionally jump to the mentioned message after replying from the notification.
- Keeps a queue of recent mentions so older pings are not lost when more arrive than can be shown.
- Lets you choose how many recent mention notifications are displayed at once.
- Lets you choose how many recent mention notifications are stored in the queue.
- Lets you choose whether notifications are shown newest-first or oldest-first.
- Lets you choose how long notifications stay queued before expiring.
- Includes a Never Expire toggle that disables automatic expiration.
- Uses Discord-style dark theme surfaces and high-contrast text.

## Settings

MentionsBox adds several settings to the Vencord plugin settings page:

- `displayLocation`: choose between the existing top-screen notification stack and the channels-section button.
- `visibleMentions`: choose how many recent mentions to show at once.
- `storedMentions`: enter how many recent mentions to keep in the queue.
- `sortOrder`: choose whether the notification stack shows newest mentions first or oldest mentions first.
- `jumpOnReply`: jump to the mentioned message after replying from the notification.
- `neverExpire`: keep notifications until you click or dismiss them.
- `expirationMinutes`: choose how many minutes notifications stay queued before expiring. This setting is disabled while Never Expire is enabled.

## Queue Behavior

MentionsBox stores queued mentions according to your stored mention count. The newest notifications are displayed according to your visible mention count. When a visible notification is clicked or dismissed, the next queued mention appears automatically.

Notifications are also removed when you reply to or react to the mentioned message from Discord's normal chat UI.

By default, notifications expire after 10 minutes. If Never Expire is enabled, notifications are only removed when clicked, dismissed, responded to, or when the plugin is disabled or reloaded.

## Files

- `index.tsx` contains the mention detection, queue logic, and React notification UI.
- `styles.css` contains the Discord-themed notification styling.

## Quick Reactions

Each notification shows up to five of your most-used reaction emojis, matching Discord's quick reaction behavior. The buttons use Discord-rendered emoji images. Clicking one reacts to the mentioned message and highlights it in the notification; clicking it again removes that reaction and clears the highlight.

## Reply Bar

Each notification includes a compact reply bar for sending a reply to the mentioned message without leaving the current channel. Replies mention the original author. If `jumpOnReply` is enabled, MentionsBox jumps to the mentioned message after the reply sends.

## Reply Chains

When a mentioned message is part of a reply chain, MentionsBox walks the linked replies until there are no more referenced messages and stores a compact preview of the full available chain. If new replies arrive while the notification is still queued, replies linked anywhere in that chain are stored too. Use the Show replies toggle on the notification to expand or collapse this context; expanded messages include author avatars.

## Rich Previews

Mention content is rendered through Discord's parser so Discord emoji and custom emoji display inline instead of falling back to plain text. Supported stickers, GIF embeds, and image or GIF attachments render as compact media previews beneath the message text. MentionsBox also refreshes tracked messages in the background so late-loaded embeds, stickers, and GIF previews can populate without navigating to the message.

The sticker picker reads Discord's locally available favorite sticker IDs from `UserSettingsProtoStore` without modifying Discord settings. If favorites have not loaded or cannot be resolved to previewable stickers, the tab is empty; favorite stickers in Discord's own picker to populate it. Original notice stickers are selected only by an explicit `{message.content}` reply action, never merely by opening a notice.

## Verification

Run the focused static and unit checks from the Vencord repository root:

```sh
npx eslint src/userplugins/MentionsBox/index.tsx src/userplugins/MentionsBox/placeholders.ts src/userplugins/MentionsBox/PlaceholderAutocomplete.tsx src/userplugins/MentionsBox/manager.ts src/userplugins/MentionsBox/placeholders.test.ts src/userplugins/MentionsBox/replyHistory.ts src/userplugins/MentionsBox/replyHistory.test.ts
npx tsx --test src/userplugins/MentionsBox/placeholders.test.ts src/userplugins/MentionsBox/replyHistory.test.ts
node src/userplugins/MentionsBox/replyLifecycle.test.cjs
node src/userplugins/MentionsBox/replyEditor.browser.test.cjs
node src/userplugins/MentionsBox/replyEditor.component.test.cjs
npx tsc --noEmit -p .
pnpm build
```

The browser regression script extracts the production editor helpers from `index.tsx` with the installed TypeScript compiler and launches cached Playwright Chromium. The component regression script bundles the real `MentionCard` with esbuild and React 19, stubbing only Discord/Vencord dependencies; `--before` disables the caret and styling fixes in memory and is expected to fail. It saves before/after PNGs in the system temp directory. Override the cache defaults with `PLAYWRIGHT_MODULE_PATH`, `CHROMIUM_EXECUTABLE_PATH`, and (for the component script) `REACT_MODULES_PATH` pointing to a directory containing React 19 and react-dom. No authenticated Discord session is required; live message/sticker interactions still need client validation. The editor segments Unicode emoji by grapheme cluster, renders them with Discord's emoji URL utility, and serializes their exact Unicode sequence. Clone fallback for unavailable guild stickers additionally requires enabling the setting and configuring a writable staging guild. The full repo TypeScript check may report unrelated local user-plugin errors.
