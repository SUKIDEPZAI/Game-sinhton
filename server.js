/* ============================================================
   Dragon Hunter Backend v2.0
   - PeerJS signaling
   - Static files
   - Room Registry (Postgres hoặc in-memory fallback)
   - Weapon Tuning Storage (Postgres)
   ============================================================ */

const express = require('express');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();
const MAX_PLAYERS = 5;
const ROOM_TTL = 5 * 60 * 1000;

/* ============================================================
   MIDDLEWARE
   ============================================================ */
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   🆕 POSTGRES — optional, fallback in-memory
   ============================================================ */
let db = null;
let dbReady = false;

async function initDB(){
  const url = process.env.DATABASE_URL;
  if (!url){
    console.log('[DB] No DATABASE_URL → using in-memory');
    dbReady = true;
    return;
  }
  try {
    const { Pool } = require('pg');
    db = new Pool({
      connectionString: url,
      ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000
    });

    await db.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        count INT NOT NULL DEFAULT 1,
        max_players INT NOT NULL DEFAULT 5,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS weapon_tuning (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        config JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_rooms_updated ON rooms(updated_at DESC)
    `);

    console.log('[DB] ✓ Postgres connected');
    dbReady = true;
  } catch(e){
    console.error('[DB] Init fail:', e.message);
    console.log('[DB] → Falling back to in-memory');
    db = null;
    dbReady = true;
  }
}

/* ============================================================
   ROOMS — in-memory fallback
   ============================================================ */
const memRooms = new Map();

function cleanupMemRooms(){
  const now = Date.now();
  for (const [code, r] of memRooms){
    if (now - r.ts > ROOM_TTL) memRooms.delete(code);
  }
}
setInterval(cleanupMemRooms, 60000);

/* ============================================================
   ROUTES: ROOMS
   ============================================================ */
app.post('/rooms', async (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'missing fields' });
  if (typeof code !== 'string' || code.length < 4 || code.length > 8)
    return res.status(400).json({ error: 'invalid code' });

  try {
    if (db){
      await db.query(`
        INSERT INTO rooms (code, name, count, max_players, updated_at)
        VALUES ($1, $2, 1, $3, NOW())
        ON CONFLICT (code) DO UPDATE
        SET name = EXCLUDED.name, count = 1, updated_at = NOW()
      `, [code, String(name).slice(0, 24), MAX_PLAYERS]);
    } else {
      memRooms.set(code, {
        code, name: String(name).slice(0, 24),
        count: 1, max: MAX_PLAYERS, ts: Date.now()
      });
    }
    console.log('🏠 Room +', code, 'by', name);
    res.json({ ok: true, code, max: MAX_PLAYERS });
  } catch(e){
    console.error('POST /rooms error:', e.message);
    res.status(500).json({ error: 'db error' });
  }
});

app.post('/rooms/:code/count', async (req, res) => {
  const { code } = req.params;
  const raw = parseInt(req.body && req.body.count, 10);
  const count = isNaN(raw) ? 1 : Math.max(1, Math.min(MAX_PLAYERS, raw));

  try {
    if (db){
      const r = await db.query(
        `UPDATE rooms SET count = $1, updated_at = NOW() WHERE code = $2 RETURNING code`,
        [count, code]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    } else {
      const room = memRooms.get(code);
      if (!room) return res.status(404).json({ error: 'not found' });
      room.count = count;
      room.ts = Date.now();
    }
    res.json({ ok: true, count, max: MAX_PLAYERS });
  } catch(e){
    res.status(500).json({ error: 'db error' });
  }
});

app.get('/rooms', async (req, res) => {
  try {
    let list = [];
    if (db){
      /* Xoá phòng cũ > 5 phút */
      await db.query(`DELETE FROM rooms WHERE updated_at < NOW() - INTERVAL '5 minutes'`);
      const r = await db.query(
        `SELECT code, name, count, max_players AS max,
                EXTRACT(EPOCH FROM updated_at) * 1000 AS ts
         FROM rooms ORDER BY updated_at DESC LIMIT 20`
      );
      list = r.rows.map(row => ({ ...row, ts: Number(row.ts) }));
    } else {
      cleanupMemRooms();
      list = [...memRooms.values()].sort((a, b) => b.ts - a.ts).slice(0, 20);
    }
    res.json({ rooms: list, total: list.length, maxPlayers: MAX_PLAYERS });
  } catch(e){
    console.error('GET /rooms error:', e.message);
    res.json({ rooms: [], total: 0, maxPlayers: MAX_PLAYERS });
  }
});

app.delete('/rooms/:code', async (req, res) => {
  try {
    let existed = false;
    if (db){
      const r = await db.query(`DELETE FROM rooms WHERE code = $1`, [req.params.code]);
      existed = r.rowCount > 0;
    } else {
      existed = memRooms.delete(req.params.code);
    }
    if (existed) console.log('🗑 Room -', req.params.code);
    res.json({ ok: true, existed });
  } catch(e){
    res.status(500).json({ error: 'db error' });
  }
});

/* ============================================================
   🆕 ROUTES: WEAPON TUNING
   ============================================================ */
app.post('/tuning', async (req, res) => {
  const { name, config } = req.body || {};
  if (!name || !config) return res.status(400).json({ error: 'missing name/config' });
  if (typeof name !== 'string' || name.length > 64)
    return res.status(400).json({ error: 'invalid name' });

  try {
    if (db){
      await db.query(`
        INSERT INTO weapon_tuning (name, config, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (name) DO UPDATE
        SET config = EXCLUDED.config, updated_at = NOW()
      `, [name, config]);
    } else {
      if (!global.__memTuning) global.__memTuning = new Map();
      global.__memTuning.set(name, { name, config, ts: Date.now() });
    }
    console.log('🎯 Tuning saved:', name);
    res.json({ ok: true, name });
  } catch(e){
    console.error('POST /tuning error:', e.message);
    res.status(500).json({ error: 'db error', detail: e.message });
  }
});

app.get('/tuning/:name', async (req, res) => {
  try {
    if (db){
      const r = await db.query(
        `SELECT config, updated_at FROM weapon_tuning WHERE name = $1`,
        [req.params.name]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, name: req.params.name, config: r.rows[0].config });
    } else {
      const item = global.__memTuning && global.__memTuning.get(req.params.name);
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, name: item.name, config: item.config });
    }
  } catch(e){
    res.status(500).json({ error: 'db error' });
  }
});

app.get('/tuning', async (req, res) => {
  try {
    let list = [];
    if (db){
      const r = await db.query(
        `SELECT name, updated_at FROM weapon_tuning ORDER BY updated_at DESC`
      );
      list = r.rows.map(row => ({ name: row.name, updatedAt: row.updated_at }));
    } else {
      if (global.__memTuning){
        list = [...global.__memTuning.values()].map(x => ({ name: x.name, updatedAt: x.ts }));
      }
    }
    res.json({ tunings: list, count: list.length });
  } catch(e){
    res.json({ tunings: [], count: 0 });
  }
});

app.delete('/tuning/:name', async (req, res) => {
  try {
    let existed = false;
    if (db){
      const r = await db.query(`DELETE FROM weapon_tuning WHERE name = $1`, [req.params.name]);
      existed = r.rowCount > 0;
    } else if (global.__memTuning){
      existed = global.__memTuning.delete(req.params.name);
    }
    res.json({ ok: true, existed });
  } catch(e){
    res.status(500).json({ error: 'db error' });
  }
});

/* ============================================================
   HEALTH & ROOT
   ============================================================ */
app.get('/', (req, res) => res.send(`
  <h1>🐉 Dragon Hunter Backend v2</h1>
  <ul>
    <li><a href="/health">/health</a></li>
    <li><a href="/rooms">/rooms</a> — room list</li>
    <li><a href="/tuning">/tuning</a> — weapon tuning list</li>
    <li><a href="/weapon-tuner.html">/weapon-tuner.html</a> — Weapon Tuner</li>
    <li><a href="/editor.html">/editor.html</a> — Sprite Editor</li>
  </ul>
`));

app.get('/health', async (req, res) => {
  let dbOk = false;
  if (db){
    try { await db.query('SELECT 1'); dbOk = true; } catch(e){}
  }
  res.json({
    ok: true,
    ts: Date.now(),
    db: db ? (dbOk ? 'connected' : 'error') : 'memory',
    maxPlayers: MAX_PLAYERS
  });
});

/* ============================================================
   PEERJS
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
   404
   ============================================================ */
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

/* ============================================================
   INIT DB
   ============================================================ */
initDB();
