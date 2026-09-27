# StrikeZone

**A real-time multiplayer first-person shooter that runs in the browser.**

Team Deathmatch · 2 teams (Alpha vs Bravo) · up to 20 players per match · first to 50 kills or 10 minutes wins.

StrikeZone uses a **client/server, server-authoritative architecture**: a Node.js server owns all
game state (positions, shooting, damage, health, deaths, respawns, ammo, score, match state) and
browser clients send only inputs. Nothing important is decided by the client — the browser cannot
tell the server "I killed him"; the server raycasts the shot itself.

```
strikezone/
├── client/          Browser game (Three.js), bundled to static files
│   ├── src/main.js  Game client: rendering, prediction, HUD, audio
│   ├── index.html   UI shell (menus, lobby, HUD, overlays)
│   ├── build.js     esbuild production build
│   └── dist/        Build output (served by the server)
├── server/
│   └── src/
│       ├── index.js HTTP + WebSocket server, static hosting, room manager
│       └── room.js  Authoritative match engine (per-room simulation)
├── shared/          Code shared by BOTH sides (single source of truth)
│   ├── map.js       Arena geometry + spawns + validation
│   ├── physics.js   Deterministic player physics + raycasting
│   ├── weapons.js   Weapon definitions
│   └── constants.js Match/network tuning
└── test/
    └── multiplayer_test.js  End-to-end test: 3 real WebSocket clients
```

Because `shared/` is imported by both the server and the client bundle, client-side prediction and
the server simulation run **exactly the same physics code** — that is what makes reconciliation work.

---

## 1. Requirements

* **Node.js 18+** (20+ recommended)
* npm (comes with Node)
* A modern desktop browser (Chrome/Edge/Firefox) — mouse + keyboard

## 2. Install

```bash
npm install          # installs server + client deps (npm workspaces)
```

## 3. Run locally (server + frontend together)

```bash
npm run build        # bundles the client into client/dist
npm start            # starts the server on http://localhost:3000
```

Open **http://localhost:3000** in your browser. The Node server serves both the game files and the
WebSocket endpoint (`/ws`) — one process, nothing else to configure.

## 4. Play with multiple players on your LAN

1. Run the server on one machine (steps above).
2. Find that machine's LAN IP (e.g. `192.168.1.50`).
3. Every player opens `http://192.168.1.50:3000`.
4. Player 1: enter a name → **Play Online** → **Create Match**.
5. Others: **Play Online** → join the room from the server browser.
6. Host picks teams balance, presses **Start Match** (needs 2+ players, one per team).

You can also test on a single computer: open two or three browser windows (or one normal window +
incognito windows) pointed at `http://localhost:3000`. They will see each other move, shoot, take
damage, die, respawn and score — in real time.

## 5. Production build

```bash
npm run build
```

Output lands in `client/dist` (`index.html` + `game.js`, ~515 KB total, no CDN needed).
Optionally bake the server address into the client at build time (only needed when the frontend is
hosted on a **different** origin than the server):

```bash
STRIKEZONE_SERVER_URL="wss://game.example.com/ws" npm run build
```

Resolution order at runtime: `?server=ws://...` query param → baked URL → **same origin** (default).

## 6. Deploy online

The whole game is **one deployable Node.js app** — the server hosts the built client and the
WebSocket on the same port. Any host that runs Node and allows WebSocket connections works
(Render, Railway, Fly.io, a VPS, …).

### Any VPS / generic host

```bash
git clone <your repo> && cd strikezone
npm install
npm run build
PORT=8080 npm start
```

Put nginx/caddy in front for TLS if you like — WebSockets just need `Upgrade` headers proxied and
the `/ws` path forwarded.

### Docker

```bash
docker build -t strikezone .
docker run -p 3000:3000 strikezone
```

### Render / Railway / Fly.io

* **Build command:** `npm install && npm run build`
* **Start command:** `npm start`
* **Env:** `PORT` is provided by the platform automatically.
* WebSockets are supported on all three. On Render use a *Web Service* (Background Workers don't
  accept inbound connections). Free tiers that sleep on idle will drop matches — expected.

### Split hosting (frontend on Netlify/Vercel, server elsewhere)

1. Deploy the server (`server/` + `shared/`) anywhere Node runs.
2. Build the client with the server's URL baked in:
   `STRIKEZONE_SERVER_URL="wss://YOUR-SERVER/ws" npm run build`
3. Deploy `client/dist` as a static site.
4. Set `CORS_ORIGIN=https://your-frontend.example` on the server.

> **TLS matters:** a page served over HTTPS can only open `wss://` (secure) sockets. If your
> frontend is HTTPS, the game server must be reachable over HTTPS/WSS too.

### Publishing the client on itch.io

itch.io hosts static files only — it **cannot run the game server**. Deploy the server first
(any of the options above), then:

1. Build with your server's secure WebSocket URL baked in (itch pages are HTTPS, so it
   **must** be `wss://`):
   ```bash
   STRIKEZONE_SERVER_URL="wss://your-server.example/ws" npm run build
   ```
2. Zip the **contents** of `client/dist` (`index.html` + `game.js`) — not the folder itself.
3. Upload the zip to itch.io and tick **"This file will be played in the browser"**.
4. In the embed options set a viewport (e.g. 1280×720); the HUD scales responsively.
   Pointer lock (mouse-look) works — itch's game iframe allows it.

Notes:
* If the server is asleep/down, players get the "Connection lost" overlay with a Reconnect
  button; free hosting tiers may need a retry after waking.
* WebSocket handshakes aren't CORS-restricted, so no server changes are required for itch.

## 7. Environment variables

| Variable              | Default     | Where  | Meaning                                          |
|-----------------------|-------------|--------|--------------------------------------------------|
| `PORT`                | `3000`      | server | HTTP + WebSocket port                            |
| `HOST`                | `0.0.0.0`   | server | Bind address                                     |
| `CORS_ORIGIN`         | `*`         | server | Allowed origin for HTTP responses                |
| `SCORE_LIMIT`         | `50`        | server | Kills to win (also used by tests)                |
| `MATCH_DURATION`      | `600`       | server | Match length in seconds                          |
| `RESPAWN_DELAY`       | `3`         | server | Seconds before respawn                           |
| `MATCH_COUNTDOWN`     | `5`         | server | Pre-match countdown seconds                      |
| `STRIKEZONE_SERVER_URL` | —         | build  | Baked client WebSocket URL (split hosting only)  |

A `.env.example` is included; the server reads plain environment variables (no dotenv dependency —
use your platform's env config, or `env $(cat .env | xargs) npm start`).

## 8. Testing

```bash
npm run test:e2e
```

Boots the real server and connects **three real WebSocket clients** that create a room, join,
start a match, move, hunt each other down with server-verified kills, respawn, survive malformed
"cheat" messages, disconnect, and play a match to the score limit including host restart.
32 checks, all automated.

## 9. Troubleshooting

**"Could not reach server" in the menu**
The client couldn't open a WebSocket. Check the server is running, the port matches, and firewalls
allow it. Test with `curl http://SERVER:PORT/health` — should return `{"ok":true,...}`.

**Page loads but never connects (mixed content)**
HTTPS page + `ws://` server is blocked by browsers. Serve the server over TLS (`wss://`) or use
an HTTP origin for testing.

**Works on localhost, not from another computer**
The server binds `0.0.0.0` by default; the usual culprit is a firewall or connecting to
`127.0.0.1` from another machine. Use the host machine's LAN/public IP.

**Behind a reverse proxy (nginx/caddy/traefik)**
WebSockets need upgrade proxying. nginx example:
```nginx
location /ws {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 120s;
}
```

**Players feel laggy / rubber-banding**
Snapshots run at 30 Hz with ~110 ms client interpolation — this tolerates normal internet jitter.
If the server CPU is saturated (many rooms), reduce tick rate in `shared/constants.js`.

**Hosting platform kills idle servers**
Free tiers sleep without traffic; a sleeping server = dropped match. Use a paid/always-on dyno for
persistent matches.

## 10. How the networking works (short version)

* **Transport:** WebSocket, JSON messages, 30 Hz server tick.
* **Client → server:** input packets at 50 Hz (`{seq, dt, move, yaw, pitch, jump/sprint/crouch, fire}`)
  plus intent events (`fire`, `reload`, `switch`).
* **Server → client:** per-player snapshot each tick (others' transforms quantized to cm, your own
  authoritative state + last processed input seq, events: shots/hits/kills/respawns, scores, timer,
  periodic scoreboard).
* **Client-side prediction + reconciliation:** your player is simulated locally with the *same*
  `shared/physics.js` the server runs; on each snapshot, acknowledged inputs are dropped and the
  unacknowledged ones replayed on top of the server state — so your movement feels instant while
  the server stays in charge.
* **Interpolation:** remote players render ~110 ms in the past, lerped between snapshots.
* **Anti-cheat:** inputs are clamped, per-tick simulation time is budgeted (≈1.25× realtime max),
  queues are capped, stale inputs dropped, unknown message types ignored. Damage/kills/score exist
  only on the server.
* **Disconnects:** sockets closing removes the player, notifies everyone, and the match continues.

## 11. Controls

| Action | Key |
|---|---|
| Move | `W A S D` |
| Sprint | `Shift` (while moving forward) |
| Jump | `Space` |
| Crouch | `Ctrl` or `C` |
| Fire | Left mouse (hold for auto weapons) |
| Reload | `R` |
| Weapons | `1` rifle · `2` shotgun · `3` pistol (or mouse wheel) |
| Scoreboard | Hold `Tab` |

## 12. Extending

* **Accounts/auth:** connections are identified by an opaque id assigned on connect; add a token to
  the `hello` message and a users table server-side — the room code already keys everything by id.
* **More weapons:** add an entry to `shared/weapons.js` (server picks it up automatically).
* **New maps:** add boxes/spawns to `shared/map.js`; `validateMap()` runs at server start and
  rejects broken geometry (spawns inside walls, impassable gaps) before it ships.

## License

MIT — all assets (geometry, procedural audio, textures) are generated in code; nothing external
to license.
