# Random Touch Picker

A minimal real-time multiplayer touch picker. Friends open the same website on separate devices and join with a six-character room code. Every finger is an independent contestant, including several fingers on one device.

## How a round works

1. Create a room, enter a display name, and share the six-character code.
2. Other devices enter the same name-and-code screen and join.
3. Hold one or more fingers on the play area. Each active finger gets a color. The ten-color palette stays unique until all ten colors are in use; after that, repeats are balanced across the least-used colors.
4. The host selects randomly from the fingers still held, five seconds after the latest new touch.
5. Every device sees the result. The selected device sees **YOU'RE CHOSEN!**; other devices see **NOT CHOSEN**. The result identifies both the player's name and the winning color, and the selected circle stays highlighted.
6. Each connected device marks Ready. A Ready state becomes cancellable after five seconds and locks after ten seconds. Cancelling starts a five-second wait before Ready can be pressed again. The next round begins only when every currently connected device has completed the ten-second lock-in.
7. Use the leave icon to exit. Other devices are notified when someone leaves.

## Backend and synchronization

The app uses Supabase Realtime Presence and Broadcast. It does not require custom database tables, Edge Functions, or user accounts.

Presence is tracked once when a device joins and is used only to identify connected devices. Touch starts/ends, batched touch movement, color assignments, Ready/cancel events, winner results, and round changes use Broadcast. This keeps frequently changing game state out of Presence and avoids the per-client Presence update limit.

The app batches finger movement updates to reduce Realtime message volume. It also sends the host's current touch and round snapshot to devices that join an active room.

The current deployment uses the Supabase project `unfippysnnhlftzzjwka`. The `sb_publishable_...` key in `script.js` is a public browser key. Never put a Supabase secret or service-role key in client-side files.

## Files

- `index.html` — room setup, display name, result dialog, leave controls, and favicon
- `style.css` — app branding, touch circles, result dialog, and mobile layout
- `script.js` — Supabase Realtime, touch/color tracking, winner selection, readiness, and leave notifications
- `logo.svg` — browser tab icon and app header logo

## Run locally

Serve this directory with any static web server, then open the local URL in a browser. For example:

```bash
python -m http.server 8000
```

Open `http://localhost:8000` on devices on the same network, or deploy the files to a static host.

The host device must stay connected while a round is running because it owns the selection timer and coordinates the next round.
