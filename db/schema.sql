-- ============================================================
-- Dragon Hunter Database Schema
-- ============================================================

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- AUTH TOKENS
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_expires ON auth_tokens(expires_at);

-- USER SAVE DATA
CREATE TABLE IF NOT EXISTS user_saves (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- USER SESSIONS (log)
CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT,
  ua TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id, created_at DESC);

-- ROOMS (metadata for lobby listing — game state is in-memory)
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  count INT NOT NULL DEFAULT 1,
  max_players INT NOT NULL DEFAULT 5,
  status TEXT DEFAULT 'open',
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rooms_updated ON rooms(updated_at DESC);

-- WEAPON TUNING
CREATE TABLE IF NOT EXISTS weapon_tuning (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  config JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- MATCH HISTORY (optional)
CREATE TABLE IF NOT EXISTS match_history (
  id SERIAL PRIMARY KEY,
  room_code TEXT,
  winner_id INT REFERENCES users(id),
  data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

