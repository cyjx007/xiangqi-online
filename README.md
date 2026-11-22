# Xiangqi Online

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Two-player Chinese chess on Cloudflare Workers. Create a room and play — no sign-up.**

English · [中文](README.zh-CN.md)

The frontend is a static page. Opening `index.html` gives you a local two-player
board with no network; deploying it adds online play over WebSocket. Every move
is validated by a Durable Object on the server, so a client cannot play an
illegal move or forge the board state.

This is a small hobby project, not a ranked or tournament platform. Room codes
are the only access control; there are no accounts, ratings or persistent user
profiles.

## Features

- **Local and online in one page** — `index.html` works offline; the same
  frontend switches to online mode when a Worker is available.
- **Complete move rules** — horse-leg blocking, elephant-eye blocking, cannon
  screens, soldiers before/after the river, the two generals facing each other,
  and advisors/elephants confined to the palace.
- **Check and mate detection** — check, checkmate and stalemate (no legal move)
  are recognised.
- **Chinese move notation** — each move is recorded in the traditional form
  (for example `炮八平五`, `马2进3`) and synchronised to both players.
- **Server-authoritative validation** — the Durable Object rejects illegal
  moves; the client only renders state.
- **Seat protection** — a second connection using the same identity takes over
  the old one, so two tabs cannot control the same side.
- **Automatic reconnect** — exponential backoff, with a visible connection
  status while reconnecting.
- **Canvas board** — touch-friendly on phones.

## Requirements

- A modern browser (Canvas and WebSocket).
- Node.js 20 or newer and npm for deployment.
- A Cloudflare account with Workers and Durable Objects enabled. The free plan
  is sufficient for casual games.
- No API keys or secrets are stored in the repository.

## Run locally

Open `index.html` directly. Moving, check detection, notation, undo and restart
all work in local mode.

Local mode additionally supports **undo** and **restart**. These are not
available online, because they would need agreement from both players.

To serve the page over HTTP instead of `file://`:

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Online play needs the Worker; use `wrangler dev` for that.

## Deploy to Cloudflare Workers

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler prints the deployed URL, typically
`https://xiangqi.<your-subdomain>.workers.dev`.

Why Workers rather than Pages: room state depends on Durable Objects, and Pages
Functions cannot bind Durable Objects. Workers Static Assets serves the page and
the WebSocket endpoint from the same Worker.

For local development with real Durable Objects:

```bash
npx wrangler dev
```

## How to play

1. One player chooses **Create room** and gets a room code.
2. Copy the invite link, or send the code to the other player.
3. The other player enters the code and joins.
4. The room creator plays red and moves first; the joiner plays black.

There is no spectator seat. Once both seats are occupied, a third player is
rejected.

## Rules implementation

The move rules live in `rules.js`, shared by the browser and the Worker (UMD,
loadable in both). Local and server validation therefore use the same code.

- `legalMovesFor(board, r, c)` — all legal destinations for a piece, excluding
  moves that leave the mover in check.
- `gameStatus(board, side)` — whether that side is in check and whether it has
  any legal move (checkmate or stalemate).
- `formatMove(...)` — generate Chinese move notation.

Coordinates are `[row, col]` on a 10 × 9 board. Red starts at the bottom
(row 9) and moves first.

## Rooms and seats

| Rule | Value | Notes |
| --- | --- | --- |
| Idle room cleanup | 24 hours | A room with both players offline and no activity for 24 h is removed with its move log. |
| Seat takeover | 5 minutes | If a side has been offline for more than 5 minutes with no active connection, a new player may take that seat. |
| Message rate limit | 120 per minute | Above that the server replies "too many operations". |
| Message size limit | 2000 characters | Larger messages are rejected. |

Player identity is stored in `sessionStorage`: a page refresh keeps the seat, but
closing the tab loses it. If both seats are occupied, reopening requires waiting
up to 5 minutes for seat takeover.

The server also checks the `Origin` header and accepts only same-origin
connections, so another website cannot connect directly and occupy a room.

## Implementation

- **Room isolation** — one room code maps to one Durable Object (`GameRoom`),
  giving strongly consistent state per room.
- **Persistence** — the full game state is stored in Durable Object storage and
  restored after the object is evicted.
- **Realtime** — WebSocket Hibernation API; idle rooms do not consume CPU time.
- **Broadcasts** — every move broadcasts the complete board and move log; the
  frontend only renders.
- **Static assets** — Workers Static Assets, with backend files excluded by
  `.assetsignore`.

### Project layout

```text
index.html       page markup
app.js           frontend logic (local and online modes)
rules.js         xiangqi rules engine (shared by browser and Worker)
worker.js        Worker entry point + GameRoom Durable Object
wrangler.toml    deployment configuration
.assetsignore    files excluded from static assets
```

## Limitations

- Online mode has no undo, restart or draw offer; create a new room instead.
- No spectators.
- No accounts, ratings, matchmaking or persistent history.
- No automated tests or CI workflow yet.
- Room codes are 4–8 alphanumeric characters; anyone with the code can join.
- Free-plan Durable Object quotas apply.

## License

[MIT](LICENSE).
