const express = require('express');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();

const MAX_PLAYERS = 5;
const ROOM_TTL = 5 * 60 * 1000;

const ALLOWED_ORIGINS = [
  'https://dragon.dragonhunter.gamer.free',
  'https://sukidepzai.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    for (let i = 0; i < ALLOWED_ORIGINS.length; i++) {
      const o = ALLOWED_ORIGINS[i];
      if (origin === o || origin.indexOf(o + ':') === 0) return cb(null, true);
    }
    console.log('CORS blocked:', origin);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json({ limit: '15mb' }));

app.use('/rooms', cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

setInterval(function () {
  const now = Date.now();
  rooms.forEach(function (r, code) {
    if (now - r.ts > ROOM_TTL) {
      rooms.delete(code);
      console.log('Cleaned room', code);
    }
  });
}, 60000);

app.post('/rooms', function (req, res) {
  const body = req.body || {};
  const code = body.code;
  const name = body.name;
  if (!code || !name) {
    res.status(400).json({ error: 'missing fields' });
    return;
  }
  if (typeof code !== 'string' || code.length < 4 || code.length > 8) {
    res.status(400).json({ error: 'invalid code' });
    return;
  }
  rooms.set(code, {
    code: code,
    name: String(name).slice(0, 24),
    count: 1,
    max: MAX_PLAYERS,
    ts: Date.now()
  });
  console.log('Room +', code, 'by', name);
  res.json({ ok: true, code: code, max: MAX_PLAYERS });
});

app.post('/rooms/:code/count', function (req, res) {
  const room = rooms.get(req.params.code);
  if (!room) {
    res.status(404).json({ error: 'room not found' });
    return;
  }
  const raw = parseInt(req.body && req.body.count, 10);
  const count = isNaN(raw) ? 1 : Math.max(1, Math.min(MAX_PLAYERS, raw));
  room.count = count;
  room.ts = Date.now();
  res.json({ ok: true, count: count, max: MAX_PLAYERS });
});

app.get('/rooms', function (req, res) {
  const list = [];
  rooms.forEach(function (r) { list.push(r); });
  list.sort(function (a, b) { return b.ts - a.ts; });
  res.json({
    rooms: list.slice(0, 20),
    total: list.length,
    maxPlayers: MAX_PLAYERS
  });
});

app.delete('/rooms/:code', function (req, res) {
  const existed = rooms.delete(req.params.code);
  if (existed) console.log('Room -', req.params.code);
  res.json({ ok: true, existed: existed });
});

app.get('/', function (req, res) {
  res.send(
    '<h1>Dragon Hunter Backend</h1>' +
    '<ul>' +
    '<li><a href="/health">/health</a></li>' +
    '<li><a href="/rooms">/rooms</a></li>' +
    '<li><a href="/editor.html">/editor.html</a></li>' +
    '</ul>'
  );
});

app.get('/health', function (req, res) {
  res.json({
    ok: true,
    ts: Date.now(),
    rooms: rooms.size,
    maxPlayers: MAX_PLAYERS
  });
});

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, function () {
  console.log('Listening on', PORT);
});

const peerServer = ExpressPeerServer(server, {
  path: '/myapp',
  proxied: true,
  allow_discovery: false,
  alive_timeout: 60000
});

app.use('/peerjs', peerServer);

peerServer.on('connection', function (c) {
  console.log('Peer +', c.getId());
});

peerServer.on('disconnect', function (c) {
  console.log('Peer -', c.getId());
});

app.use(function (req, res) {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});ice(0, 20);
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
   PeerJS signaling
   ============================================================ */
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log('🌐 Listening on', PORT));

const peerServer = ExpressPeerServer(server, {
  path: '/myapp',
  proxied: true,
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
});   error: 'Not found',
    path: req.path,
    hint: 'Trang chủ: / · Health: /health · Rooms: /rooms · Editor: /editor.html'
  });
});