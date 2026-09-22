/* ============================================================
   Dragon Hunter Backend
   - PeerJS signaling
   - Static files (Sprite Editor tại /editor.html)
   - Room Registry (in-memory, TTL 5 phút)
   ============================================================ */

const express = require('express');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();

/* ============================================================
   CONFIG
   ============================================================ */
const MAX_PLAYERS = 5;
const ROOM_TTL = 5 * 60 * 1000;   // 5 phút

/* ============================================================
   CORS — whitelist domain GitHub Pages
   ============================================================ */
const ALLOWED_ORIGINS = [
  'https://dragon.dragonhunter.gamer.free',
  // dev local
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':')))
      return cb(null, true);
    console.log('CORS blocked:', origin);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json({ limit: '15mb' }));

/* ============================================================
   STATIC FILES — serve public/ folder
   Truy cập: https://game-sinhton.onrender.com/editor.html
   ============================================================ */
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   HEALTH
   ============================================================ */
app.get('/', (_, res) => res.send(
  '<h1>Dragon Hunter Backend</h1>' +
  '<ul>' +
  '<li><a href="/health">/health</a> — kiểm tra server</li>' +
  '<li><a href="/rooms">/rooms</a> — danh sách phòng PvP</li>' +
  '<li><a href="/editor.html">/editor.html</a> — Sprite Sheet Editor</li>' +
  '<li>PeerJS signaling: <code>/peerjs/myapp/*</code></li>' +
  '</ul>'
));
app.get('/health', (_, res) => res.json({
  ok: true,
  ts: Date.now(),
  rooms: rooms.size,
  maxPlayers: MAX_PLAYERS
}));

/* ============================================================
   🆕 ROOM REGISTRY (in-memory, TTL 5 phút)
   ============================================================
   POST   /rooms                 — đăng ký phòng mới { code, name }
   POST   /rooms/:code/count     — cập nhật số người { count }
   GET    /rooms                 — danh sách phòng (mới nhất trước)
   DELETE /rooms/:code           — xoá phòng
   ============================================================ */
const rooms = new Map();

function cleanupRooms(){
  const now = Date.now();
  let removed = 0;
  for (const [code, r] of rooms){
    if (now - r.ts > ROOM_TTL){
      rooms.delete(code);
      removed++;
    }
  }
  if (removed) console.log('🧹 Cleaned', removed, 'stale rooms');
}
setInterval(cleanupRooms, 60000);

/* --- POST /rooms : tạo phòng --- */
app.post('/rooms', (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name){
    return res.status(400).json({ error: 'missing fields', need: ['code', 'name'] });
  }
  if (typeof code !== 'string' || code.length < 4 || code.length > 8){
    return res.status(400).json({ error: 'invalid code' });
  }
  rooms.set(code, {
    code,
    name: String(name).slice(0, 24),
    count: 1,
    max: MAX_PLAYERS,
    ts: Date.now()
  });
  console.log('🏠 Room +', code, 'by', name, '(' + rooms.size + ' rooms total)');
  res.json({ ok: true, code, max: MAX_PLAYERS });
});

/* --- POST /rooms/:code/count : cập nhật số người --- */
app.post('/rooms/:code/count', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room){
    return res.status(404).json({ error: 'room not found' });
  }
  const rawCount = parseInt(req.body && req.body.count);
  const count = isNaN(rawCount) ? 1 : Math.max(1, Math.min(MAX_PLAYERS, rawCount));
  room.count = count;
  room.ts = Date.now();
  res.json({ ok: true, count, max: MAX_PLAYERS });
});

/* --- GET /rooms : danh sách phòng --- */
app.get('/rooms', (req, res) => {
  cleanupRooms();
  const list = [...rooms.values()]
    .sort((a, b) => b.ts - a.ts)   // mới nhất trước
    .slice(0, 20);                 // tối đa 20 phòng
  res.json({
    rooms: list,
    total: list.length,
    maxPlayers: MAX_PLAYERS
  });
});

/* --- DELETE /rooms/:code : xoá phòng --- */
app.delete('/rooms/:code', (req, res) => {
  const existed = rooms.delete(req.params.code);
  if (existed){
    console.log('🗑  Room -', req.params.code, '(' + rooms.size + ' rooms left)');
  }
  res.json({ ok: true, existed });
});

/* ============================================================
   PeerJS signaling
   ============================================================ */
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log('🌐 Listening on', PORT));

const peerServer = ExpressPeerServer(server, {
  path: '/myapp',
  proxied: true,             // BẮT BUỘC trên Render (reverse proxy)
  allow_discovery: false,
  alive_timeout: 60000
});
app.use('/peerjs', peerServer);

peerServer.on('connection', c => console.log('Peer +', c.getId()));
peerServer.on('disconnect', c => console.log('Peer -', c.getId()));

/* ============================================================
   404 fallback
   ============================================================ */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    hint: 'Trang chủ: / · Health: /health · Rooms: /rooms · Editor: /editor.html'
  });
});