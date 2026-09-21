/* ============================================================
   Dragon Hunter Backend
   - PeerJS signaling
   - Static files (Sprite Editor tại /editor.html)
   ============================================================ */

const express = require('express');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();

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
  methods: ['GET', 'POST', 'OPTIONS'],
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
  '<li><a href="/editor.html">/editor.html</a> — Sprite Sheet Editor</li>' +
  '<li>PeerJS signaling: <code>/peerjs/myapp/*</code></li>' +
  '</ul>'
));
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

/* ============================================================
   PeerJS signaling
   ============================================================ */
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log('Listening on', PORT));

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
    hint: 'Trang chủ: / · Health: /health · Editor: /editor.html'
  });
});
