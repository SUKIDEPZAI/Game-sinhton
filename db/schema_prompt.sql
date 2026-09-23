-- ============================================================
-- Dragon Hunter — Prompt Builder Schema
-- Chạy tự động qua db/migrate.js khi server start
-- ============================================================

-- ============================================================
-- PROJECTS
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_projects (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  owner_id    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pp_slug ON prompt_projects(slug);
CREATE INDEX IF NOT EXISTS idx_pp_owner ON prompt_projects(owner_id);

-- ============================================================
-- VERSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_versions (
  id            BIGSERIAL PRIMARY KEY,
  project_id    INT NOT NULL REFERENCES prompt_projects(id) ON DELETE CASCADE,
  hash          TEXT NOT NULL,
  label         TEXT,
  ts            TIMESTAMPTZ DEFAULT NOW(),
  total_size    INT NOT NULL,
  files_count   INT NOT NULL,
  is_delta      BOOLEAN DEFAULT FALSE,
  base_version  BIGINT REFERENCES prompt_versions(id) ON DELETE SET NULL,
  content       TEXT,
  delta         JSONB,
  delta_size    INT DEFAULT 0,
  meta          JSONB DEFAULT '{}'::jsonb,
  UNIQUE(project_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_pv_project_ts ON prompt_versions(project_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_pv_hash       ON prompt_versions(hash);
CREATE INDEX IF NOT EXISTS idx_pv_is_delta   ON prompt_versions(is_delta);

-- ============================================================
-- FILES (mỗi file trong 1 version)
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_files (
  id          BIGSERIAL PRIMARY KEY,
  version_id  BIGINT NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  url         TEXT,
  hash        TEXT NOT NULL,
  size        INT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pf_version ON prompt_files(version_id);
CREATE INDEX IF NOT EXISTS idx_pf_label   ON prompt_files(label);
CREATE INDEX IF NOT EXISTS idx_pf_hash    ON prompt_files(hash);

-- ============================================================
-- CHANGES (file nào đổi so với version trước)
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_changes (
  id          BIGSERIAL PRIMARY KEY,
  version_id  BIGINT NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE,
  file_label  TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('new','modified','deleted'))
);
CREATE INDEX IF NOT EXISTS idx_pc_version ON prompt_changes(version_id);
CREATE INDEX IF NOT EXISTS idx_pc_label   ON prompt_changes(file_label);

-- ============================================================
-- VIEW — ANALYTICS OVERVIEW
-- ============================================================
CREATE OR REPLACE VIEW prompt_analytics AS
SELECT
  pv.project_id,
  COUNT(*)                                          AS total_versions,
  SUM(pv.files_count)                               AS total_file_instances,
  AVG(pv.files_count)::NUMERIC(10,2)                AS avg_files,
  AVG(pv.total_size)::BIGINT                        AS avg_size,
  MAX(pv.total_size)                                AS max_size,
  MIN(pv.ts)                                        AS first_version,
  MAX(pv.ts)                                        AS last_version,
  SUM(CASE WHEN pv.is_delta THEN 1 ELSE 0 END)      AS delta_count,
  SUM(CASE WHEN NOT pv.is_delta THEN 1 ELSE 0 END)  AS full_count,
  SUM(pv.delta_size)                                AS total_delta_lines
FROM prompt_versions pv
GROUP BY pv.project_id;

-- ============================================================
-- VIEW — HOT FILES
-- ============================================================
CREATE OR REPLACE VIEW prompt_hot_files AS
SELECT
  pv.project_id,
  pc.file_label,
  COUNT(*)                                                   AS change_count,
  SUM(CASE WHEN pc.change_type = 'new'      THEN 1 ELSE 0 END) AS new_count,
  SUM(CASE WHEN pc.change_type = 'modified' THEN 1 ELSE 0 END) AS mod_count,
  SUM(CASE WHEN pc.change_type = 'deleted'  THEN 1 ELSE 0 END) AS del_count
FROM prompt_changes pc
JOIN prompt_versions pv ON pv.id = pc.version_id
GROUP BY pv.project_id, pc.file_label;

-- ============================================================
-- DONE
-- ============================================================
