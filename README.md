# MentionsBox

MentionsBox is a simple Vencord user plugin that shows recent mentions in a clean notification stack at the top of Discord.

## Features

- Shows a top-screen notification when someone mentions you.
- Works across servers, DMs, and group DMs.
- Click a notification to jump directly to the mentioned message.
- Dismiss notifications without jumping by clicking the `x`.
- Keeps a queue of recent mentions so older pings are not lost when more than five arrive.
- Displays only the latest five notifications at once for a cleaner UI.
- Uses Discord-style dark theme surfaces and high-contrast text.

## Queue Behavior

MentionsBox stores up to 50 recent mentions in memory. The newest five are displayed. When a visible notification is clicked or dismissed, the next queued mention appears automatically.

Notifications expire after 10 minutes and are cleared when the plugin is disabled or reloaded.

## Files

- `index.tsx` contains the mention detection, queue logic, and React notification UI.
- `styles.css` contains the Discord-themed notification styling.

## Verification

Run:

```sh
pnpm eslint src/userplugins/MentionsBox
```

The full repo TypeScript check may fail if other local user plugins have unrelated type errors.
