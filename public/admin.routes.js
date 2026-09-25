/* ============================================================
   ADMIN ROUTES — Tài khoản OP riêng
   ============================================================
   - Auth bằng username/password từ ENV (không cần DB user)
   - Token HMAC-signed, TTL 7 ngày
   - Đọc source code trực tiếp từ disk (server-side)
   - Rate limit login: 10 lần/phút/IP
   ============================================================ */
"use strict";

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

/* ---------- Danh sách file được phép đọc ---------- */
const ALLOWED_FILES = [
  { path: "index.html",                lang: "html",       desc: "Game client — single-file SPA" },
  { path: "server.js",                 lang: "javascript", desc: "Backend — Express + WebSocket + Postgres" },
  { path: "package.json",              lang: "json",       desc: "Dependencies + scripts" },
  { path: "sprites.json",              lang: "json",       desc: "Metadata animation player + weapon" },
  { path: "weapon-tuning.json",        lang: "json",       desc: "Per-frame weapon position config" },
  { path: "db/schema.sql",             lang: "sql",        desc: "Postgres schema — users, saves, rooms" },
  { path: "db/schema_prompt.sql",      lang: "sql",        desc: "Postgres schema — prompt builder" },
  { path: "db/migrate.js",             lang: "javascript", desc: "Auto-migration script" },
  { path: "public/prompt.routes.js",   lang: "javascript", desc: "Prompt Builder API — Myers diff + delta" },
  { path: "public/admin.routes.js",    lang: "javascript", desc: "Admin routes — auth + build" },
  { path: "public/prompt-manager.html",lang: "html",       desc: "Admin dashboard UI" },
  { path: "public/editor.html",        lang: "html",       desc: "DH Studio — Sprite editor" },
  { path: "public/weapon-tuner.html",  lang: "html",       desc: "Weapon tuner tool" }
];

module.exports = function mountAdminRoutes(app, db, config) {

  const ADMIN_USER = config.user;
  const ADMIN_PASS = config.pass;
  const SECRET = config.secret;
  const ROOT = config.root;

  if (!ADMIN_PASS) {
    console.log("[admin.routes] ADMIN_PASS not set — admin routes disabled");
    return;
  }

  /* ============================================================
     TOKEN — HMAC-SHA256 signed, TTL 7 ngày
     ============================================================ */
  function signToken(payload) {
    const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
    return data + "." + sig;
  }

  function verifyToken(token) {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [data, sig] = parts;
    const expected = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
    if (sig.length !== expected.length) return null;
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    } catch (e) { return null; }
    try {
      const payload = JSON.parse(Buffer.from(data, "base64url").toString());
      if (payload.exp && payload.exp < Date.now()) return null;
      return payload;
    } catch (e) { return null; }
  }

  /* ============================================================
     RATE LIMIT — login
     ============================================================ */
  const loginAttempts = new Map();
  function checkRate(ip) {
    const now = Date.now();
    let r = loginAttempts.get(ip);
    if (!r || now > r.resetAt) {
      r = { count: 0, resetAt: now + 60000 };
      loginAttempts.set(ip, r);
    }
    r.count++;
    return r.count <= 10;
  }
  setInterval(() => {
    const now = Date.now();
    loginAttempts.forEach((r, ip) => {
      if (now > r.resetAt) loginAttempts.delete(ip);
    });
  }, 60000);

  /* ============================================================
     MIDDLEWARE — requireAdmin
     ============================================================ */
  function requireAdmin(req, res, next) {
    const auth = req.headers.authorization || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "missing token" });
    const payload = verifyToken(m[1].trim());
    if (!payload) return res.status(401).json({ error: "invalid or expired token" });
    req.admin = { username: payload.user };
    next();
  }

  /* ============================================================
     POST /admin/login
     Body: { username, password }
     ============================================================ */
  app.post("/admin/login", (req, res) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
    if (!checkRate(ip)) {
      return res.status(429).json({ error: "Quá nhiều lần thử. Chờ 1 phút." });
    }

    const body = req.body || {};
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "Nhập đầy đủ username và password" });
    }

    /* Timing-safe compare */
    let userOk = false, passOk = false;
    try {
      const ua = Buffer.from(username);
      const ub = Buffer.from(ADMIN_USER);
      userOk = ua.length === ub.length && crypto.timingSafeEqual(ua, ub);

      const pa = Buffer.from(password);
      const pb = Buffer.from(ADMIN_PASS);
      passOk = pa.length === pb.length && crypto.timingSafeEqual(pa, pb);
    } catch (e) {
      userOk = false; passOk = false;
    }

    if (!userOk || !passOk) {
      console.log("[admin] Login failed from", ip);
      return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
    }

    const token = signToken({
      user: ADMIN_USER,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000 /* 7 days */
    });

    console.log("[admin] Login OK:", ADMIN_USER, "from", ip);
    res.json({
      ok: true,
      token,
      user: { username: ADMIN_USER }
    });
  });

  /* ============================================================
     GET /admin/me
     ============================================================ */
  app.get("/admin/me", requireAdmin, (req, res) => {
    res.json({ ok: true, user: req.admin });
  });

  /* ============================================================
     GET /admin/files — list file có thể build
     ============================================================ */
  app.get("/admin/files", requireAdmin, (req, res) => {
    res.json({ files: ALLOWED_FILES });
  });

  /* ============================================================
     GET /admin/build — build prompt.txt từ disk
     Query: ?files=index.html,server.js (optional)
     ============================================================ */
  app.get("/admin/build", requireAdmin, async (req, res) => {
    try {
      let fileList = ALLOWED_FILES;

      /* Filter nếu có ?files=... */
      if (req.query.files) {
        const wanted = String(req.query.files).split(",").map(s => s.trim());
        fileList = ALLOWED_FILES.filter(f => wanted.includes(f.path));
      }

      /* Build prompt */
      const now = new Date().toISOString();
      const totalSize = 0;

      let out = "";
      out += "═".repeat(65) + "\n";
      out += "🐉 DRAGON HUNTER — FULL PROJECT CONTEXT\n";
      out += "═".repeat(65) + "\n\n";
      out += "META:\n";
      out += "  Generated:  " + now + "\n";
      out += "  Admin:      " + req.admin.username + "\n";
      out += "  Files:      " + fileList.length + "\n";
      out += "  Source:     Server-side disk read\n\n";

      out += "QUICK OVERVIEW:\n";
      out += "  Dragon Hunter — game PvP pixel-art 2D top-down.\n";
      out += "  Stack: Vanilla JS client (single-file) + Node.js + WebSocket + PostgreSQL.\n";
      out += "  Đặc biệt: PNG nhúng metadata JSON ở hàng pixel cuối (steganography).\n";
      out += "  Có 2 tool: editor.html (sprite sheet) + weapon-tuner.html (chỉnh vị trí vũ khí).\n";
      out += "  KHÔNG framework · KHÔNG build step · Mở file HTML là chạy.\n";
      out += "  UI tiếng Việt, code tiếng Anh.\n\n";

      out += "FILE INDEX:\n";
      fileList.forEach((f, i) => {
        out += "  " + String(i + 1).padStart(2, "0") + ". " +
               f.path.padEnd(32) + " — " + f.desc + "\n";
      });
      out += "\n";

      /* Read all files */
      const fileContents = [];
      for (const f of fileList) {
        const fullPath = path.join(ROOT, f.path);
        /* Security: ensure path stays in ROOT */
        if (!fullPath.startsWith(ROOT)) {
          fileContents.push({ ...f, content: "[BLOCKED: path outside root]", size: 0, lines: 0 });
          continue;
        }
        try {
          const content = await fs.readFile(fullPath, "utf8");
          fileContents.push({
            ...f,
            content,
            size: Buffer.byteLength(content, "utf8"),
            lines: content.split("\n").length
          });
        } catch (e) {
          fileContents.push({ ...f, content: "[ERROR: " + e.message + "]", size: 0, lines: 0 });
        }
      }

      /* Append content */
      fileContents.forEach((f, i) => {
        out += "═".repeat(65) + "\n";
        out += "FILE " + (i + 1) + "/" + fileContents.length + ": " + f.path + "\n";
        out += "SIZE: " + formatSize(f.size) + " · LINES: " + f.lines + "\n";
        out += "DESC: " + f.desc + "\n";
        out += "═".repeat(65) + "\n\n";
        out += f.content;
        out += "\n\n";
      });

      out += "═".repeat(65) + "\n";
      out += "END OF PROMPT · " + now + "\n";
      out += "═".repeat(65) + "\n";

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(out);

    } catch (e) {
      console.error("[admin/build]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     GET /admin/versions — list tất cả versions của mọi project
     ============================================================ */
  app.get("/admin/versions", requireAdmin, async (req, res) => {
    if (!db) return res.json({ versions: [], projects: [] });
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const r = await db.query(
        "SELECT pv.id, pv.hash, pv.label, pv.ts, pv.total_size, pv.files_count, " +
        "       pv.is_delta, pv.delta_size, pp.slug AS project_slug, pp.name AS project_name " +
        "FROM prompt_versions pv " +
        "JOIN prompt_projects pp ON pp.id = pv.project_id " +
        "ORDER BY pv.ts DESC LIMIT $1",
        [limit]
      );
      const projects = await db.query(
        "SELECT pp.id, pp.slug, pp.name, pp.created_at, COUNT(pv.id) AS version_count " +
        "FROM prompt_projects pp " +
        "LEFT JOIN prompt_versions pv ON pv.project_id = pp.id " +
        "GROUP BY pp.id ORDER BY pp.created_at DESC"
      );
      res.json({ versions: r.rows, projects: projects.rows });
    } catch (e) {
      console.error("[admin/versions]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     GET /admin/version/:id — full content (reconstruct delta)
     ============================================================ */
  app.get("/admin/version/:id", requireAdmin, async (req, res) => {
    if (!db) return res.status(503).json({ error: "db not available" });
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: "bad id" });
    try {
      const rows = await db.query(
        "WITH RECURSIVE chain AS (" +
        "  SELECT * FROM prompt_versions WHERE id = $1 " +
        "  UNION ALL " +
        "  SELECT pv.* FROM prompt_versions pv JOIN chain c ON pv.id = c.base_version" +
        ") SELECT * FROM chain ORDER BY id ASC",
        [id]
      );
      if (rows.rowCount === 0) return res.status(404).json({ error: "not found" });

      let content = null;
      for (const v of rows.rows) {
        if (!v.is_delta) { content = v.content; continue; }
        if (content && v.delta) {
          const delta = typeof v.delta === "string" ? JSON.parse(v.delta) : v.delta;
          const lines = content.split("\n");
          let offset = 0;
          for (const d of delta) {
            const idx = d.line + offset;
            if (d.op === "add") { lines.splice(idx, 0, d.value); offset++; }
            else if (d.op === "del") { lines.splice(idx, 1); offset--; }
          }
          content = lines.join("\n");
        }
      }
      if (!content) return res.status(500).json({ error: "reconstruct failed" });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(content);
    } catch (e) {
      console.error("[admin/version]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     DELETE /admin/version/:id
     ============================================================ */
  app.delete("/admin/version/:id", requireAdmin, async (req, res) => {
    if (!db) return res.status(503).json({ error: "db not available" });
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: "bad id" });
    try {
      const r = await db.query("DELETE FROM prompt_versions WHERE id = $1", [id]);
      res.json({ ok: true, deleted: r.rowCount });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     DELETE /admin/all — xóa toàn bộ versions
     ============================================================ */
  app.delete("/admin/all", requireAdmin, async (req, res) => {
    if (!db) return res.status(503).json({ error: "db not available" });
    try {
      const r = await db.query("DELETE FROM prompt_versions");
      res.json({ ok: true, deleted: r.rowCount });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ============================================================
     GET /admin/analytics — full stats
     ============================================================ */
  app.get("/admin/analytics", requireAdmin, async (req, res) => {
    if (!db) return res.json({ empty: true });
    try {
      const [ov, hf, cp, iv, projects] = await Promise.all([
        db.query(
          "SELECT COUNT(*) AS total_versions, " +
          "       SUM(files_count) AS total_file_instances, " +
          "       AVG(files_count)::NUMERIC(10,2) AS avg_files, " +
          "       AVG(total_size)::BIGINT AS avg_size, " +
          "       MAX(total_size) AS max_size, " +
          "       SUM(CASE WHEN is_delta THEN 1 ELSE 0 END) AS delta_count, " +
          "       SUM(CASE WHEN NOT is_delta THEN 1 ELSE 0 END) AS full_count, " +
          "       SUM(delta_size) AS total_delta_lines " +
          "FROM prompt_versions"
        ),
        db.query(
          "SELECT pc.file_label, COUNT(*) AS change_count, " +
          "       SUM(CASE WHEN pc.change_type='new' THEN 1 ELSE 0 END) AS new_count, " +
          "       SUM(CASE WHEN pc.change_type='modified' THEN 1 ELSE 0 END) AS mod_count " +
          "FROM prompt_changes pc " +
          "GROUP BY pc.file_label ORDER BY change_count DESC LIMIT 20"
        ),
        db.query(
          "SELECT AVG(total_size)::BIGINT AS avg_uncompressed, " +
          "       AVG(pg_column_size(content))::BIGINT AS avg_compressed, " +
          "       SUM(delta_size) AS total_delta_lines " +
          "FROM prompt_versions WHERE content IS NOT NULL"
        ),
        db.query(
          "SELECT AVG(diff)::BIGINT AS avg_interval_seconds FROM (" +
          "  SELECT EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (ORDER BY ts))) AS diff " +
          "  FROM prompt_versions" +
          ") t WHERE diff IS NOT NULL"
        ),
        db.query(
          "SELECT pp.slug, pp.name, COUNT(pv.id) AS version_count " +
          "FROM prompt_projects pp " +
          "LEFT JOIN prompt_versions pv ON pv.project_id = pp.id " +
          "GROUP BY pp.id ORDER BY version_count DESC"
        )
      ]);

      res.json({
        empty: (ov.rows[0].total_versions || 0) === 0,
        overview: ov.rows[0],
        hotFiles: hf.rows,
        compression: cp.rows[0],
        intervals: iv.rows[0],
        projects: projects.rows
      });
    } catch (e) {
      console.error("[admin/analytics]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log("[admin.routes] ✓ Mounted 8 endpoints · user: " + ADMIN_USER);
};

function formatSize(bytes) {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
   }
