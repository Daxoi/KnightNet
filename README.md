# ♞ KnightNet — Self-Hosted Chess Server

Chess.com-inspired chess platform to be hosted on Raspberry Pi (i chose the pi 5 16gb).

## Features
- **User accounts** — register/login with username & password
- **Matchmaking** — auto-match by ELO rating
- **Friend system** — send/accept requests, see online status, challenge friends
- **Full chess rules** — castling, en passant, promotion, check/checkmate/stalemate detection
- **20-minute timers** per player (server-enforced)
- **ELO ratings** — auto-updated after every game
- **Game history** — view past results in your profile
- **Real-time** — Socket.io, no polling

## Full setup on Raspberry Pi 5

```bash
# 1. Copy the chess folder to your Pi, then:
cd chess
npm install

# 2. Start the server
node server.js

# 3. Open in browser
# From the Pi:       http://localhost:3000
# From the network:  http://<pi-ip-address>:3000
```

## Run on boot (optional)

```bash
# Install pm2
npm install -g pm2

# Start and save
pm2 start server.js --name chess
pm2 startup
pm2 save
```

## Find your Pi's IP

```bash
hostname -I
```

## Data

All data is stored in `data.json` in the project folder.
To reset everything, delete `data.json` and restart.

## Port

Default is **3000**. Change with:
```bash
PORT=8080 node server.js
```
