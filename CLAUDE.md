# Chicken Tinder: handoff notes

Two people swipe on nearby restaurants; the first mutual yes is dinner. Built in a Claude chat session, handed to Claude Code to publish.

## State
- `server.js`: dependency-free Node (>=20) HTTP server. Rounds live in memory for 6 hours, keyed by a four-letter code.
- `public/`: `index.html`, `app.css`, `app.js`. Strict CSP, so no inline scripts or inline style attributes.
- `render.yaml`: one free Render web service, health check at `/healthz`. `CONTACT_UA` is prompted for at blueprint creation.
- Deployed: https://chicken-tinder-4qw6.onrender.com (Render Blueprint `chicken-tinder`, auto-syncs on push to main). Source: https://github.com/AizenKeel-Dev/chicken-tinder (public).
- Restaurants: Nominatim geocodes a typed address; Overpass lists `amenity=restaurant` (optionally `fast_food`) within 1 to 15 miles. Up to 40 per round.
  - All Overpass mirrors are queried at once (first good answer wins, 18 s cap). If none answers, the server falls back to Nominatim's bounded amenity search (50 per kind), reshaped to look like Overpass elements so one parser serves both.
  - Every Nominatim call goes through `nominatim()`, which keeps the whole server under one request per second (their usage policy).
- Privacy rules to keep: the round's center point never leaves the server, players see only their own picks plus mutual matches, nothing is logged or written to disk.

## Verified (2026-11-11)
- Full two-player round (create, join, swipe, match) and error cases, against mocked map services.
- Live round near Acworth, GA 30102: 40 sensible cards with addresses, via both the Overpass path and the Nominatim fallback (Overpass was down that day; every public mirror timed out or returned 502).
- Browser pane at desktop and 375px phone width: start form, card stack, button and drag swipes, partner progress chips, match overlay, matches list. No console errors.

## Not verified yet
- Safari iOS specifically (geolocation prompt, swipe feel). Geolocation needs HTTPS, which Render provides.
- The Overpass path on a day when Overpass is actually up.

## To do
1. Run a real two-phone round on the live URL and fix what breaks.

## Local test
    node server.js   # http://localhost:3000
Env overrides for mocking: `NOMINATIM_URL`, `OVERPASS_URLS` (comma-separated). Point `OVERPASS_URLS` at a dead port (e.g. `http://127.0.0.1:9`) to exercise the Nominatim fallback.
