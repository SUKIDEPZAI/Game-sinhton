
---

## 📄 6. `server.js` full — v4.0 (WebSocket)

```js
/* ============================================================
   Dragon Hunter Backend v4.0
   - Express (REST: auth, save, rooms list, tuning)
   - WebSocket (game state, realtime)
   - PostgreSQL (persistent data)
   ============================================================ */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 5;
const ROOM_TTL = 30 * 60 * 1000;
const TOKEN_TTL_DAYS = 30;

let SEED = Date.now() & 0x7fffffff;

/* ============================================================
   MIDDLEWARE
   ============================================================ */
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   DATABASE
   ============================================================ */
let db = null;

async function initDB(){
  const url = process.env.DATABASE_URL;
  if (!url){
    console.log('[DB] No DATABASE_URL — accounts disabled');
    return;
  }
  try {
    const migrate = require('./db/migrate');
    await migrate();

    db = new Pool({
      connectionString: url,
      ssl: url.includes('localhost') || url.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000
    });
    await db.query('SELECT 1');
    console.log('[DB] ✓ Connected');
  } catch(e){
    console.error('[DB] Fail:', e.message);
    db = null;
  }
}

/* ============================================================
   HELPERS
   ============================================================ */
function hashPassword(password, salt){
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, expected){
  const hash = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function genToken(){ return crypto.randomBytes(32).toString('hex'); }
function genSalt(){ return crypto.randomBytes(16).toString('hex'); }
function genRoomCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function genPlayerId(){
  return 'p' + crypto.randomBytes(6).toString('hex');
}

/* ============================================================
   AUTH MIDDLEWARE
   ============================================================ */
async function requireAuth(req, res, next){
  if (!db) return res.status(503).json({ error: 'accounts disabled' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'missing token' });
  const token = m[1].trim();
  try {
    const r = await db.query(`
      SELECT t.user_id, t.expires_at, u.username, u.display_name
      FROM auth_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token = $1
    `, [token]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'invalid token' });
    const row = r.rows[0];
    if (new Date(row.expires_at) < new Date()){
      await db.query('DELETE FROM auth_tokens WHERE token = $1', [token]);
      return res.status(401).json({ error: 'token expired' });
    }
    req.userId = row.user_id;
    req.username = row.username;
    req.displayName = row.display_name;
    req.token = token;
    next();
  } catch(e){
    console.error('auth:', e.message);
    res.status(500).json({ error: 'auth error' });
  }
}

/* ============================================================
   AUTH ROUTES
   ============================================================ */
app.post('/auth/register', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'accounts disabled' });
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const u = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(u)) return res.status(400).json({ error: 'username 3-20 ký tự [a-z0-9_]' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password >= 6 ký tự' });
  const dn = String(displayName || u).trim().slice(0, 20) || u;
  try {
    const check = await db.query('SELECT id FROM users WHERE username = $1', [u]);
    if (check.rowCount > 0) return res.status(409).json({ error: 'username đã tồn tại' });
    const salt = genSalt();
    const hash = hashPassword(String(password), salt);
    const ins = await db.query(`
      INSERT INTO users (username, display_name, password_hash, password_salt, last_login)
      VALUES ($1, $2, $3, $4, NOW()) RETURNING id
    `, [u, dn, hash, salt]);
    const userId = ins.rows[0].id;
    await db.query(`
      INSERT INTO user_saves (user_id, data) VALUES ($1, $2)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId, JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      player: { level: 1, exp: 0, hp: 20, maxHp: 20, selected: 0 },
      inventory: { hotbar: [] },
      stats: { kills: 0, deaths: 0 }
    })]);
    const token = genToken();
    const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.query(`INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, userId, expires]);
    console.log('👤 Registered:', u);
    res.json({ ok: true, token, user: { id: userId, username: u, displayName: dn } });
  } catch(e){
    console.error('register:', e.message);
    res.status(500).json({ error: 'register failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'accounts disabled' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const u = String(username).trim().toLowerCase();
  try {
    const r = await db.query(`
      SELECT id, username, display_name, password_hash, password_salt
      FROM users WHERE username = $1
    `, [u]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'sai tài khoản hoặc mật khẩu' });
    const user = r.rows[0];
    if (!verifyPassword(String(password), user.password_salt, user.password_hash)){
      return res.status(401).json({ error: 'sai tài khoản hoặc mật khẩu' });
    }
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
    const ua = (req.headers['user-agent'] || '').substring(0, 200);
    await db.query('INSERT INTO user_sessions (user_id, ip, ua) VALUES ($1, $2, $3)',
      [user.id, String(ip).substring(0, 60), ua]);
    const token = genToken();
    const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.query(`INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, user.id, expires]);
    console.log('✓ Login:', u);
    res.json({ ok: true, token, user: { id: user.id, username: user.username, displayName: user.display_name } });
  } catch(e){
    console.error('login:', e.message);
    res.status(500).json({ error: 'login failed' });
  }
});

app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, username, display_name, created_at, last_login
      FROM users WHERE id = $1
    `, [req.userId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'user not found' });
    const row = r.rows[0];
    res.json({
      ok: true,
      user: {
        id: row.id, username: row.username, displayName: row.display_name,
        createdAt: row.created_at, lastLogin: row.last_login
      }
    });
  } catch(e){ res.status(500).json({ error: 'me failed' }); }
});

app.post('/auth/logout', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM auth_tokens WHERE token = $1', [req.token]);
    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: 'logout failed' }); }
});

/* ============================================================
   SAVE DATA
   ============================================================ */
app.get('/save', requireAuth, async (req, res) => {
  try {
    const r = await db.query(`SELECT data, updated_at FROM user_saves WHERE user_id = $1`, [req.userId]);
    if (r.rowCount === 0) return res.json({ ok: true, data: {}, updatedAt: null });
    res.json({ ok: true, data: r.rows[0].data, updatedAt: r.rows[0].updated_at });
  } catch(e){ res.status(500).json({ error: 'load failed' }); }
});

app.post('/save', requireAuth, async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'missing data' });
  const size = JSON.stringify(data).length;
  if (size > 1024 * 1024) return res.status(413).json({ error: 'save quá lớn' });
  try {
    await db.query(`
      INSERT INTO user_saves (user_id, data, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `, [req.userId, data]);
    res.json({ ok: true, updatedAt: new Date() });
  } catch(e){ res.status(500).json({ error: 'save failed' }); }
});

/* ============================================================
   ROOMS (lobby listing only — game state in-memory)
   ============================================================ */
app.get('/rooms', async (req, res) => {
  try {
    if (!db){
      /* Build from in-memory rooms */
      const list = [...rooms.values()].map(r => ({
        code: r.code,
        name: r.hostName,
        count: r.players.size,
        max: MAX_PLAYERS,
        ts: r.createdAt
      }));
      return res.json({ rooms: list, total: list.length, maxPlayers: MAX_PLAYERS });
    }
    await db.query(`DELETE FROM rooms WHERE updated_at < NOW() - INTERVAL '30 minutes'`);
    const r = await db.query(`
      SELECT code, name, count, max_players AS max,
             EXTRACT(EPOCH FROM updated_at) * 1000 AS ts
      FROM rooms WHERE status = 'open'
      ORDER BY updated_at DESC LIMIT 30
    `);
    const list = r.rows.map(row => ({ ...row, ts: Number(row.ts) }));
    res.json({ rooms: list, total: list.length, maxPlayers: MAX_PLAYERS });
  } catch(e){
    res.json({ rooms: [], total: 0, maxPlayers: MAX_PLAYERS });
  }
});

/* ============================================================
   WEAPON TUNING
   ============================================================ */
app.post('/tuning', async (req, res) => {
  const { name, config } = req.body || {};
  if (!name || !config) return res.status(400).json({ error: 'missing' });
  try {
    if (db){
      await db.query(`
        INSERT INTO weapon_tuning (name, config, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
      `, [name, config]);
    } else {
      if (!global.__memTuning) global.__memTuning = new Map();
      global.__memTuning.set(name, { name, config, ts: Date.now() });
    }
    res.json({ ok: true, name });
  } catch(e){ res.status(500).json({ error: 'db error' }); }
});

app.get('/tuning/:name', async (req, res) => {
  try {
    if (db){
      const r = await db.query(`SELECT config FROM weapon_tuning WHERE name = $1`, [req.params.name]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, config: r.rows[0].config });
    } else {
      const item = global.__memTuning && global.__memTuning.get(req.params.name);
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, config: item.config });
    }
  } catch(e){ res.status(500).json({ error: 'db error' }); }
});

app.get('/tuning', async (req, res) => {
  try {
    let list = [];
    if (db){
      const r = await db.query(`SELECT name, updated_at FROM weapon_tuning ORDER BY updated_at DESC`);
      list = r.rows.map(row => ({ name: row.name, updatedAt: row.updated_at }));
    } else if (global.__memTuning){
      list = [...global.__memTuning.values()].map(x => ({ name: x.name, updatedAt: x.ts }));
    }
    res.json({ tunings: list, count: list.length });
  } catch(e){ res.json({ tunings: [], count: 0 }); }
});

/* ============================================================
   HEALTH
   ============================================================ */
app.get('/', (req, res) => res.send(`
  <h1>🐉 Dragon Hunter Backend v4</h1>
  <ul>
    <li><a href="/health">/health</a></li>
    <li><a href="/rooms">/rooms</a></li>
    <li><a href="/tuning">/tuning</a></li>
    <li><a href="/weapon-tuner.html">/weapon-tuner.html</a></li>
    <li><a href="/editor.html">/editor.html</a></li>
  </ul>
  <p>WebSocket: <code>wss://game-sinhton.onrender.com/ws</code></p>
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
    accounts: db ? 'enabled' : 'disabled',
    wsClients: wss.clients.size,
    activeRooms: rooms.size,
    maxPlayers: MAX_PLAYERS
  });
});

/* ============================================================
   GAME STATE — IN-MEMORY
   ============================================================ */
const rooms = new Map();

class Room {
  constructor(code, hostWs, hostName){
    this.code = code;
    this.hostId = hostWs.id;
    this.hostName = hostName;
    this.players = new Map();
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }
  addPlayer(player){
    if (this.players.size >= MAX_PLAYERS) return false;
    this.players.set(player.id, player);
    this.lastActivity = Date.now();
    return true;
  }
  removePlayer(id){
    this.players.delete(id);
    this.lastActivity = Date.now();
  }
  isEmpty(){
    for (const p of this.players.values()){
      if (p.ws.readyState === 1) return false;
    }
    return true;
  }
  broadcast(data, excludeId = null){
    const msg = JSON.stringify(data);
    for (const p of this.players.values()){
      if (p.id === excludeId) continue;
      if (p.ws.readyState === 1){
        try { p.ws.send(msg); } catch(e){}
      }
    }
  }
  getPlayerList(){
    const list = [];
    for (const p of this.players.values()){
      list.push(playerToJson(p));
    }
    return list;
  }
}

function playerToJson(p){
  return {
    id: p.id,
    name: p.name,
    x: p.x, y: p.y,
    hp: p.hp, maxHp: p.maxHp,
    facing: p.facing,
    anim: p.anim,
    sitting: p.sitting,
    level: p.level
  };
}

function createPlayer(ws, name, msg){
  return {
    id: ws.id,
    ws: ws,
    name: String(name || 'Hunter').slice(0, 16),
    x: Number(msg.x) || 2048,
    y: Number(msg.y) || 2048,
    hp: 20,
    maxHp: 20,
    facing: 1,
    anim: 'idle',
    sitting: false,
    level: Number(msg.level) || 1,
    lastSeen: Date.now(),
    lastMoveTime: Date.now()
  };
}

/* ============================================================
   WEBSOCKET SERVER
   ============================================================ */
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  ws.id = genPlayerId();
  ws.roomCode = null;
  ws.isAlive = true;
  ws.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';

  console.log('[WS] +', ws.id, '·', ws.ip);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(ws, msg);
    } catch(e){
      console.warn('[WS] Bad msg:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] -', ws.id);
    handleDisconnect(ws);
  });

  ws.on('error', (e) => console.error('[WS] Error', ws.id, e.message));

  /* Welcome */
  send(ws, {
    t: 'welcome',
    id: ws.id,
    serverTime: Date.now(),
    version: 4
  });
});

function send(ws, msg){
  if (ws.readyState === 1){
    try { ws.send(JSON.stringify(msg)); } catch(e){}
  }
}

function handleMessage(ws, msg){
  switch (msg.t){
    case 'ping':
      send(ws, { t: 'pong', time: msg.time, serverTime: Date.now() });
      break;

    case 'create_room':
      handleCreateRoom(ws, msg);
      break;

    case 'join_room':
      handleJoinRoom(ws, msg);
      break;

    case 'leave_room':
      handleDisconnect(ws);
      break;

    case 'move':
      handleMove(ws, msg);
      break;

    case 'attack':
      handleAttack(ws, msg);
      break;

    case 'chat':
      handleChat(ws, msg);
      break;

    default:
      console.warn('[WS] Unknown:', msg.t);
  }
}

async function handleCreateRoom(ws, msg){
  if (ws.roomCode){
    return send(ws, { t: 'error', msg: 'already in room' });
  }

  const code = genRoomCode();
  const name = String(msg.name || 'Host').slice(0, 16);
  const room = new Room(code, ws, name);
  rooms.set(code, room);

  const player = createPlayer(ws, name, msg);
  room.addPlayer(player);
  ws.roomCode = code;

  console.log('[Room] Created', code, 'by', name);

  /* Register to DB for lobby listing */
  if (db){
    try {
      await db.query(`
        INSERT INTO rooms (code, name, count, max_players, status, updated_at)
        VALUES ($1, $2, 1, $3, 'open', NOW())
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name, count = 1, status = 'open', updated_at = NOW()
      `, [code, name, MAX_PLAYERS]);
    } catch(e){ console.warn('[DB] register room:', e.message); }
  }

  send(ws, {
    t: 'room_created',
    code: code,
    you: player.id,
    players: room.getPlayerList(),
    maxPlayers: MAX_PLAYERS
  });
}

async function handleJoinRoom(ws, msg){
  if (ws.roomCode){
    return send(ws, { t: 'error', msg: 'already in room' });
  }
  const code = String(msg.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room){
    return send(ws, { t: 'error', msg: 'Không tìm thấy phòng' });
  }
  if (room.players.size >= MAX_PLAYERS){
    return send(ws, { t: 'error', msg: 'Phòng đã đầy' });
  }

  const name = String(msg.name || 'Hunter').slice(0, 16);
  const player = createPlayer(ws, name, msg);
  room.addPlayer(player);
  ws.roomCode = code;

  /* Send current state to new player */
  send(ws, {
    t: 'room_joined',
    code: code,
    you: player.id,
    players: room.getPlayerList(),
    maxPlayers: MAX_PLAYERS,
    world: { seed: SEED }
  });

  /* Notify others */
  room.broadcast({
    t: 'player_joined',
    player: playerToJson(player)
  }, player.id);

  console.log('[Room]', name, '→', code, '(' + room.players.size + '/' + MAX_PLAYERS + ')');

  /* Update DB count */
  if (db){
    try {
      await db.query(`
        UPDATE rooms SET count = $1, updated_at = NOW() WHERE code = $2
      `, [room.players.size, code]);
    } catch(e){}
  }
}

function handleMove(ws, msg){
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const player = room.players.get(ws.id);
  if (!player) return;

  const now = Date.now();
  const dt = (now - player.lastMoveTime) / 1000;
  player.lastMoveTime = now;

  const newX = Number(msg.x) || 0;
  const newY = Number(msg.y) || 0;

  /* Basic anti-cheat: max speed 500 px/s */
  if (dt > 0 && dt < 1){
    const dist = Math.hypot(newX - player.x, newY - player.y);
    const maxDist = 500 * dt + 100;
    if (dist > maxDist){
      /* Teleport detected — snap to server pos */
      send(ws, { t: 'pos_correct', x: Math.round(player.x), y: Math.round(player.y) });
      return;
    }
  }

  player.x = newX;
  player.y = newY;
  player.facing = msg.facing === -1 ? -1 : 1;
  player.anim = msg.anim || 'idle';
  player.sitting = !!msg.sitting;
  if (msg.hp != null) player.hp = Math.max(0, Math.min(100, Number(msg.hp)));
  player.lastSeen = now;

  room.broadcast({
    t: 'player_update',
    id: player.id,
    x: player.x,
    y: player.y,
    facing: player.facing,
    anim: player.anim,
    sitting: player.sitting,
    hp: player.hp
  }, player.id);
}

function handleAttack(ws, msg){
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const attacker = room.players.get(ws.id);
  if (!attacker) return;

  const now = Date.now();
  if (now - (attacker.lastAttack || 0) < 500) return; /* Rate limit */
  attacker.lastAttack = now;

  const angle = Number(msg.angle) || 0;
  const range = 80;
  const hitX = attacker.x + Math.cos(angle) * 50;
  const hitY = attacker.y + Math.sin(angle) * 50;

  let target = null;
  let minD = range;
  for (const p of room.players.values()){
    if (p.id === attacker.id) continue;
    if (p.hp <= 0) continue;
    const d = Math.hypot(p.x - hitX, p.y - hitY);
    if (d < minD){ minD = d; target = p; }
  }

  /* Broadcast attack animation to room */
  room.broadcast({
    t: 'attack',
    attackerId: attacker.id,
    attackerName: attacker.name,
    angle: angle
  });

  if (target){
    const dmg = Math.max(1, Math.min(20, Number(msg.dmg) || 1));
    target.hp = Math.max(0, target.hp - dmg);

    console.log('[Hit]', attacker.name, '→', target.name, dmg + 'dmg · ' + target.hp + 'HP');

    send(target.ws, {
      t: 'hit',
      attackerId: attacker.id,
      attackerName: attacker.name,
      dmg: dmg,
      hp: target.hp
    });

    if (target.hp <= 0){
      room.broadcast({
        t: 'player_died',
        id: target.id,
        name: target.name,
        killer: attacker.name,
        killerId: attacker.id
      });
    }
  }
}

function handleChat(ws, msg){
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const player = room.players.get(ws.id);
  if (!player) return;
  const text = String(msg.text || '').slice(0, 200);
  if (!text) return;
  room.broadcast({
    t: 'chat',
    from: player.name,
    fromId: player.id,
    text: text
  });
}

async function handleDisconnect(ws){
  const code = ws.roomCode;
  if (!code) return;
  ws.roomCode = null;

  const room = rooms.get(code);
  if (!room) return;

  const player = room.players.get(ws.id);
  if (player){
    room.removePlayer(ws.id);
    room.broadcast({
      t: 'player_left',
      id: player.id,
      name: player.name
    });
    console.log('[Room]', player.name, 'left', code);

    if (room.players.size > 0){
      if (db){
        try {
          await db.query(`UPDATE rooms SET count = $1, updated_at = NOW() WHERE code = $2`,
            [room.players.size, code]);
        } catch(e){}
      }
    } else {
      rooms.delete(code);
      if (db){
        try {
          await db.query(`UPDATE rooms SET status = 'closed', updated_at = NOW() WHERE code = $1`,
            [code]);
        } catch(e){}
      }
      console.log('[Room] Closed', code);
    }
  }
}

/* ============================================================
   HEARTBEAT + CLEANUP
   ============================================================ */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch(e){}
  });
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms){
    if (now - room.lastActivity > ROOM_TTL || room.isEmpty()){
      rooms.delete(code);
      console.log('[Room] Cleanup', code);
    }
  }
}, 60000);

/* Cleanup old tokens periodically */
setInterval(async () => {
  if (!db) return;
  try {
    await db.query(`DELETE FROM auth_tokens WHERE expires_at < NOW()`);
  } catch(e){}
}, 60 * 60 * 1000);

/* ============================================================
   START
   ============================================================ */
server.listen(PORT, () => {
  console.log('🌐 Listening on', PORT);
  initDB();
});

/* 404 */
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
