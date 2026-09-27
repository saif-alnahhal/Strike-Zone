// StrikeZone — production server.
// - Authoritative game server over WebSocket (path /ws)
// - Also serves the built frontend from ../client/dist (single-app hosting)
//
// Env:
//   PORT      (default 3000)
//   HOST      (default 0.0.0.0)
//   CORS_ORIGIN (default * — set to your frontend origin in production, e.g. https://game.example.com)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, sanitizeName } from './room.js';
import { MATCH } from '../../shared/constants.js';
import { validateMap } from '../../shared/map.js';

// Fail fast on broken map data (e.g. spawn points inside walls)
const mapProblems = validateMap();
if (mapProblems.length) {
  console.error('MAP VALIDATION FAILED:');
  for (const p of mapProblems) console.error('  -', p);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../client/dist');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ---------- static frontend ----------
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { setCors(res); res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { setCors(res); res.writeHead(405); res.end('Method Not Allowed'); return; }

  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/health') {
    setCors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: totalPlayers() }));
    return;
  }

  let filePath = path.normalize(path.join(DIST, urlPath === '/' ? 'index.html' : urlPath));
  if (!filePath.startsWith(DIST)) { setCors(res); res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback
      filePath = path.join(DIST, 'index.html');
      fs.stat(filePath, (err2) => {
        if (err2) { setCors(res); res.writeHead(404); res.end('Not found. Run `npm run build` first.'); return; }
        serveFile(filePath, req, res);
      });
      return;
    }
    serveFile(filePath, req, res);
  });
});

function serveFile(filePath, req, res) {
  const ext = path.extname(filePath).toLowerCase();
  setCors(res);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(filePath).pipe(res);
}

// ---------- rooms ----------
const rooms = new Map();

function totalPlayers() {
  let n = 0;
  for (const r of rooms.values()) n += r.players.size;
  return n;
}

// destroy stale empty rooms
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (r.players.size === 0 && now - r.lastUsed > 60_000) rooms.delete(id);
  }
}, 30_000).unref();

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

let nextConnId = 1;
const conns = new Set();

wss.on('connection', (ws, req) => {
  const conn = {
    id: 'P' + (nextConnId++).toString(36),
    ws, name: 'Player', room: null,
    lastMsgTimes: [], closed: false,
    send: (data) => { if (ws.readyState === 1) ws.send(data); },
  };
  conns.add(conn);

  ws.on('message', (buf) => {
    // basic rate limit: max 120 msgs/sec
    const now = Date.now();
    conn.lastMsgTimes.push(now);
    while (conn.lastMsgTimes.length && now - conn.lastMsgTimes[0] > 1000) conn.lastMsgTimes.shift();
    if (conn.lastMsgTimes.length > 120) { ws.close(1008, 'rate limit'); return; }

    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    try { handleMessage(conn, m); } catch (e) {
      console.error('[msg error]', e.message);
    }
  });

  ws.on('close', () => {
    conn.closed = true;
    conns.delete(conn);
    leaveRoom(conn); // handles host-left → room deletion too
  });

  ws.on('error', () => { try { ws.close(); } catch { } });
  conn.send(JSON.stringify({ t: 'welcome', id: conn.id }));
});

function handleMessage(conn, m) {
  switch (m.t) {
    case 'hello': {
      conn.name = sanitizeName(m.name);
      conn.send(JSON.stringify({ t: 'helloOk', name: conn.name }));
      break;
    }
    case 'rooms': {
      const list = [...rooms.values()].map(r => r.publicInfo());
      conn.send(JSON.stringify({ t: 'rooms', rooms: list }));
      break;
    }
    case 'create': {
      if (conn.room) leaveRoom(conn);
      if (rooms.size >= 64) { conn.send(JSON.stringify({ t: 'error', msg: 'Server is full of rooms' })); return; }
      const room = new Room(m.name || conn.name, conn);
      rooms.set(room.id, room);
      conn.room = room;
      room.addPlayer(conn);
      break;
    }
    case 'join': {
      const room = rooms.get(String(m.id || '').toUpperCase());
      if (!room) { conn.send(JSON.stringify({ t: 'error', msg: 'Room not found' })); return; }
      if (room.players.size >= MATCH.MAX_PLAYERS) { conn.send(JSON.stringify({ t: 'error', msg: 'Room is full' })); return; }
      if (conn.room) leaveRoom(conn);
      conn.room = room;
      room.addPlayer(conn);
      break;
    }
    case 'leave': leaveRoom(conn); break;
    case 'team': if (conn.room) conn.room.setTeam(conn.id, m.team); break;
    case 'start': {
      if (!conn.room) return;
      const r = conn.room.tryStart(conn.id);
      if (!r.ok) conn.send(JSON.stringify({ t: 'error', msg: r.err }));
      break;
    }
    case 'restart': {
      if (!conn.room) return;
      const r = conn.room.restart(conn.id);
      if (!r.ok) conn.send(JSON.stringify({ t: 'error', msg: r.err }));
      break;
    }
    case 'input': {
      const p = conn.room && conn.room.players.get(conn.id);
      if (p) conn.room.handleInput(p, m);
      break;
    }
    case 'fire': {
      const room = conn.room; if (!room) return;
      const p = room.players.get(conn.id);
      if (p) room.tryFire(p);
      break;
    }
    case 'reload': {
      const room = conn.room; if (!room) return;
      const p = room.players.get(conn.id);
      if (p) room.tryReload(p);
      break;
    }
    case 'switch': {
      const room = conn.room; if (!room) return;
      const p = room.players.get(conn.id);
      if (p) room.trySwitch(p, m.slot);
      break;
    }
    default: break; // unknown types ignored (client can't inject game state)
  }
}

function leaveRoom(conn) {
  const room = conn.room;
  conn.room = null;
  if (room) {
    const wasHost = conn.id === room.hostId;
    room.removePlayer(conn.id);
    if (wasHost) {
      // host left → the room dies with them; everyone else is notified
      // and dropped back to the server browser
      room.close('The host left — match closed');
      rooms.delete(room.id);
      console.log(`[room ${room.id}] closed (host left)`);
    } else if (room.players.size === 0) {
      room.lastUsed = Date.now(); // idle cleanup will collect it
    }
  }
  conn.send(JSON.stringify({ t: 'leftRoom' }));
}

// ---------- main loop ----------
const TICK_MS = 1000 / MATCH.TICK_RATE;
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    try {
      room.update(now);
      room.sendSnapshots();
    } catch (e) {
      console.error('[room update error]', room.id, e);
    }
  }
}, TICK_MS);

server.listen(PORT, HOST, () => {
  console.log(`StrikeZone server listening on http://${HOST}:${PORT}`);
  console.log(`  WebSocket:  ws://<host>:${PORT}/ws`);
  console.log(`  Frontend:   ${fs.existsSync(path.join(DIST, 'index.html')) ? 'serving client/dist' : 'client/dist NOT BUILT — run: npm run build'}`);
});

process.on('uncaughtException', (e) => { console.error('[uncaught]', e); });
process.on('unhandledRejection', (e) => { console.error('[unhandled rejection]', e); });
