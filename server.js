const express = require('express');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();
const MAX_PLAYERS = 5;

app.use(express.json({ limit: '15mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

app.post('/rooms', function (req, res) {
  const body = req.body || {};
  if (!body.code || !body.name) {
    return res.status(400).json({ error: 'missing fields' });
  }
  rooms.set(body.code, {
    code: body.code,
    name: String(body.name).slice(0, 24),
    count: 1,
    max: MAX_PLAYERS,
    ts: Date.now()
  });
  console.log('Room +', body.code);
  return res.json({ ok: true, code: body.code, max: MAX_PLAYERS });
});

app.post('/rooms/:code/count', function (req, res) {
  const room = rooms.get(req.params.code);
  if (!room) {
    return res.status(404).json({ error: 'not found' });
  }
  const n = parseInt(req.body && req.body.count, 10) || 1;
  room.count = Math.max(1, Math.min(MAX_PLAYERS, n));
  room.ts = Date.now();
  return res.json({ ok: true, count: room.count, max: MAX_PLAYERS });
});

app.get('/rooms', function (req, res) {
  const now = Date.now();
  const list = [];
  rooms.forEach(function (r, code) {
    if (now - r.ts > 300000) {
      rooms.delete(code);
    } else {
      list.push(r);
    }
  });
  list.sort(function (a, b) { return b.ts - a.ts; });
  return res.json({ rooms: list.slice(0, 20), maxPlayers: MAX_PLAYERS });
});

app.delete('/rooms/:code', function (req, res) {
  const existed = rooms.delete(req.params.code);
  return res.json({ ok: true, existed: existed });
});

app.get('/', function (req, res) {
  return res.send('<h1>Dragon Hunter Backend</h1>');
});

app.get('/health', function (req, res) {
  return res.json({ ok: true, ts: Date.now(), rooms: rooms.size, maxPlayers: MAX_PLAYERS });
});

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, function () {
  console.log('Listening on port ' + PORT);
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
  return res.status(404).json({ error: 'Not found', path: req.path });
});
