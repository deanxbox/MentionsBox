# MentionsBox

MentionsBox is a simple Vencord user plugin that shows recent mentions in a clean notification stack at the top of Discord.

## Features

- Shows a top-screen notification when someone mentions you.
- Works across servers, DMs, and group DMs.
- Click a notification to jump directly to the mentioned message.
- Dismiss notifications without jumping by clicking the `x`.
- Keeps a queue of recent mentions so older pings are not lost when more arrive than can be shown.
- Lets you choose how many recent mention notifications are displayed at once.
- Lets you choose how many recent mention notifications are stored in the queue.
- Lets you choose how long notifications stay queued before expiring.
- Includes a Never Expire toggle that disables automatic expiration.
- Uses Discord-style dark theme surfaces and high-contrast text.

## Settings

MentionsBox adds three settings to the Vencord plugin settings page:

- `visibleMentions`: choose how many recent mentions to show at once.
- `storedMentions`: enter how many recent mentions to keep in the queue.
- `neverExpire`: keep notifications until you click or dismiss them.
- `expirationMinutes`: choose how many minutes notifications stay queued before expiring. This setting is disabled while Never Expire is enabled.

## Queue Behavior

MentionsBox stores queued mentions according to your stored mention count. The newest notifications are displayed according to your visible mention count. When a visible notification is clicked or dismissed, the next queued mention appears automatically.

By default, notifications expire after 10 minutes. If Never Expire is enabled, notifications are only removed when clicked, dismissed, or when the plugin is disabled or reloaded.

## Files

- `index.tsx` contains the mention detection, queue logic, and React notification UI.
- `styles.css` contains the Discord-themed notification styling.

## Verification

Run:

```sh
pnpm eslint src/userplugins/MentionsBox
```

The full repo TypeScript check may fail if other local user plugins have unrelated type errors.
