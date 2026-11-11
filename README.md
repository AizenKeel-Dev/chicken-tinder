# Chicken Tinder

Two people swipe on nearby restaurants. The first place you both say yes to is dinner.

- No accounts. One person starts a round from their location or an address, then texts the invite link.
- Restaurants come from OpenStreetMap (Nominatim for the address, Overpass for the list, with Nominatim as a fallback when Overpass is down).
- Rounds live in memory for six hours. Nothing is written to disk and the starting location is never sent to other players.

## Run

    node server.js        # Node 20 or newer, no dependencies
    open http://localhost:3000

## Deploy

Live at https://chicken-tinder-4qw6.onrender.com, auto-deployed from `main`.

`render.yaml` describes a single free Render web service. Push this folder to a Git repo and open
`https://dashboard.render.com/blueprint/new?repo=<your repo URL>`.

On Render's free plan the service sleeps after about 15 minutes idle; the first visit after that takes
up to a minute to wake, and any round in progress is lost.
