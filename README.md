# Random Touch Picker

A minimal, real-time multiplayer touch picker. Friends open the same website, join a room code, and hold a touch on the black play area. Each touch gets its own colored circle. Five seconds after the most recent new touch, the host randomly selects one of the touches still being held. The selected circle remains highlighted.

## Files

- `index.html` — page structure and Supabase client loader
- `style.css` — black screen, room controls, and touch circles
- `script.js` — room handling, touch tracking, timer, and random selection

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
5. When the timer expires, the host chooses randomly from the active touches and broadcasts the winner.
6. The selected circle stays highlighted until a new touch starts the next round.

The host device must remain connected while the round is running because it owns the selection timer.
