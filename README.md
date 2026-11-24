# Random Touch Picker

A minimal, real-time multiplayer touch picker. Friends open the same website on separate devices and join with a room code. Every finger/pointer is an independent contestant, so one device can contribute several simultaneous touches while another contributes one or more. The host gives each active touch a distinct color from a ten-color palette; colors repeat only when all ten are in use. Five seconds after the most recent new touch, the host randomly selects one of the touches still being held. Every device sees a result popup naming the winning color and whether its device won. Devices mark themselves ready, and the next round begins when all connected devices are ready.

## Files

- `index.html` — page structure, favicon, and result dialog
- `style.css` — branding, room controls, touch circles, and result dialog
- `script.js` — Supabase Realtime, touch/color tracking, selection, and device readiness
- `logo.svg` — app icon used in the browser tab and room screens

## Backend

The app uses Supabase Realtime Presence and Broadcast. It does not require custom database tables, Edge Functions, or user accounts.

The current deployment is configured to use the Supabase project `unfippysnnhlftzzjwka`. The `sb_publishable_...` key in `script.js` is a public client key intended for browser use. Never put a Supabase `service_role` key or database password in client-side files.

## Run locally

Serve this directory with any static web server, then open the local URL in a browser. For example:

```bash
python -m http.server 8000
```

Open `http://localhost:8000` on devices on the same network, or deploy the files to a static host.

## How a round works

1. One device creates a room and shares its six-character code.
2. Other devices join using that code.
3. Everyone enters the play area and touches/holds the screen.
4. The host starts or restarts a five-second timer whenever a new touch is detected.
5. When the timer expires, the host chooses randomly from the active touches and broadcasts the selected touch and its color.
6. Every device gets a result popup showing whether its touch won. The popup names the winning color, so a device with several simultaneous fingers can identify the selected one.
7. Each device marks itself ready. The popup lists connected devices and their readiness; the next round begins automatically when every connected device is ready.

Touch colors are assigned by the host from a shared ten-color palette. Active touches use different colors until all ten are in use; only then can a color repeat. Released touches free their color for a later touch.

The host device must remain connected while the round is running because it owns the selection timer and coordinates the next round.
