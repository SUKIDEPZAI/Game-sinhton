/* ============================================================
   ADMIN ROUTES v2 — Deep Analysis + Image Scanner
   ============================================================
   - Scan đệ quy toàn bộ project
   - Đọc PNG: metadata DHUN + BBOX analysis
   - Phân tích code: functions, imports, exports, LOC
   - Dependency graph
   - Change detection SHA-256
   - Prompt chuyên sâu cho AI
   ============================================================ */
"use strict";

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

/* ============ CONFIG ============ */
const SCAN_IGNORE = new Set([
  "node_modules", ".git", ".github", "dist", "build",
  ".cache", "coverage", ".next", ".vscode", ".idea",
  "package-lock.json", ".env", ".env.local"
]);
const TEXT_EXT = new Set([
  ".html", ".css", ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx",
  ".json", ".md", ".sql", ".txt", ".yml", ".yaml", ".xml",
  ".svg", ".env.example", ".gitignore"
]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_FILE_SIZE = 5 * 1024 * 1024; /* 5MB max per text file */

module.exports = function mountAdminRoutes(app, db, config) {

  const ADMIN_USER = config.user;
  const ADMIN_PASS = config.pass;
  const SECRET = config.secret;
  const ROOT = config.root;
  const CACHE_FILE = path.join(ROOT, ".admin-cache.json");

  if (!ADMIN_PASS) {
    console.log("[admin.routes] ADMIN_PASS not set — admin routes disabled");
    return;
  }

  /* ============================================================
     TOKEN
     ============================================================ */
  function signToken(payload) {
    const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
    return data + "." + sig;
  }
  function verifyToken(token) {
    if (!token) return null;
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
     RATE LIMIT
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
     MIDDLEWARE
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
     ALGORITHM — RECURSIVE FILE SCANNER
     ============================================================ */
  async function scanDirectory(dir, baseDir) {
    const files = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) { return files; }

    for (const entry of entries) {
      const name = entry.name;
      if (SCAN_IGNORE.has(name)) continue;
      if (name.startsWith(".") && name !== ".gitignore") continue;

      const fullPath = path.join(dir, name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        const sub = await scanDirectory(fullPath, baseDir);
        files.push(...sub);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          files.push({
            path: relPath,
            absPath: fullPath,
            size: stat.size,
            mtime: stat.mtimeMs
          });
        } catch (e) {}
      }
    }
    return files;
  }

  /* ============================================================
     ALGORITHM — SHA-256 FILE HASH
     ============================================================ */
  async function hashFile(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  }

  /* ============================================================
     ALGORITHM — PNG METADATA DECODER (DHUN steganography)
     Đọc hàng pixel cuối của PNG, decode magic "DHUN"
     ============================================================ */
  function decodePngMetadata(buffer) {
    try {
      /* Đọc width/height từ IHDR chunk */
      if (buffer.length < 24) return null;
      const sig = buffer.slice(0, 8).toString("hex");
      if (sig !== "89504e470d0a1a0a") return null;

      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);

      /* Tìm IDAT chunks và giải nén để lấy raw pixels */
      let pos = 8;
      const idatChunks = [];
      while (pos < buffer.length) {
        const len = buffer.readUInt32BE(pos);
        const type = buffer.slice(pos + 4, pos + 8).toString("ascii");
        if (type === "IDAT") {
          idatChunks.push(buffer.slice(pos + 8, pos + 8 + len));
        } else if (type === "IEND") {
          break;
        }
        pos += 12 + len;
      }
      if (!idatChunks.length) return null;

      const compressed = Buffer.concat(idatChunks);
      let raw;
      try { raw = zlib.inflateSync(compressed); } catch (e) { return null; }

      /* Bytes per pixel: giả sử RGBA = 4 */
      const bpp = 4;
      const stride = width * bpp + 1; /* +1 filter byte */
      if (raw.length < stride * height) return null;

      /* Lấy hàng cuối (bỏ filter byte) */
      const lastRowStart = (height - 1) * stride + 1;
      const lastRow = raw.slice(lastRowStart, lastRowStart + width * bpp);

      /* Check magic DHUN */
      if (lastRow[0] !== 0x44 || lastRow[1] !== 0x48 ||
          lastRow[2] !== 0x55 || lastRow[3] !== 0x4E) {
        return { width, height, hasMetadata: false };
      }

      /* Đọc length */
      const len = lastRow[6] | (lastRow[7] << 8) |
                  (lastRow[8] << 16) | (lastRow[9] << 24);
      if (len <= 0 || len > 300000) {
        return { width, height, hasMetadata: false };
      }

      /* Decode 3 pixels = 1 byte */
      const bytes = [];
      for (let i = 0; i < len; i++) {
        const p = Math.floor((10 + i) / 3);
        const ch = (10 + i) % 3;
        if (p * 4 + ch >= lastRow.length) break;
        bytes.push(lastRow[p * 4 + ch]);
      }

      const json = Buffer.from(bytes).toString("utf8");
      let meta = null;
      try { meta = JSON.parse(json); } catch (e) {}

      return {
        width,
        height,
        hasMetadata: true,
        metadata: meta,
        metadataSize: len
      };
    } catch (e) {
      return null;
    }
  }

  /* ============================================================
     ALGORITHM — ANALYZE IMAGE (frames, anchors, BBOX per frame)
     ============================================================ */
  function analyzeImageInfo(meta) {
    if (!meta || !meta.metadata) return null;
    const m = meta.metadata;
    const info = {
      width: meta.width,
      height: meta.height,
      model: m.model || null,
      anim: m.label || m.anim || null,
      fps: m.fps || 10,
      loop: m.loop !== false,
      frames: m.frames || (m.vLines ? m.vLines.length - 1 : 1),
      spriteH: m.spriteH || meta.height,
      anchorMode: m.anchorMode || "stable-x",
      vLines: m.vLines || null,
      stableAnchor: m.stableAnchor || null,
      anchorCount: m.anchors ? m.anchors.filter(a => a).length : 0,
      frameWidths: null,
      avgFrameWidth: null
    };
    if (m.vLines && m.vLines.length >= 2) {
      const widths = [];
      for (let i = 0; i < m.vLines.length - 1; i++) {
        widths.push(m.vLines[i + 1] - m.vLines[i]);
      }
      info.frameWidths = widths;
      info.avgFrameWidth = Math.round(widths.reduce((a, b) => a + b, 0) / widths.length);
    }
    return info;
  }

  /* ============================================================
     ALGORITHM — CODE ANALYZER
     Phân tích: functions, imports, exports, complexity, LOC
     ============================================================ */
  function analyzeCode(content, ext) {
    const lines = content.split("\n");
    const info = {
      lines: lines.length,
      chars: content.length,
      nonEmptyLines: lines.filter(l => l.trim()).length,
      commentLines: 0,
      functions: 0,
      asyncFunctions: 0,
      classes: 0,
      imports: [],
      exports: [],
      routes: [],
      todos: [],
      complexity: 0
    };

    /* Comment + function count */
    const fnRegex = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
    const arrowFnRegex = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g;
    const asyncFnRegex = /\basync\s+(?:function\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=\s*async)/g;
    const classRegex = /\bclass\s+([A-Za-z_$][\w$]*)/g;
    const importRegex = /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    const exportRegex = /(?:export\s+(?:default\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)|module\.exports\s*=\s*([A-Za-z_$][\w$]*))/g;
    const routeRegex = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
    const todoRegex = /(?:TODO|FIXME|XXX|HACK|BUG):\s*(.+)/gi;

    const commentRegex = /^\s*(?:\/\/|\/\*|\*|#|--)/;
    for (const line of lines) {
      if (commentRegex.test(line)) info.commentLines++;
    }

    let m;
    while ((m = fnRegex.exec(content))) info.functions++;
    while ((m = arrowFnRegex.exec(content))) info.functions++;
    while ((m = asyncFnRegex.exec(content))) info.asyncFunctions++;
    while ((m = classRegex.exec(content))) info.classes++;
    while ((m = importRegex.exec(content))) {
      info.imports.push(m[1] || m[2]);
    }
    while ((m = exportRegex.exec(content))) {
      info.exports.push(m[1] || m[2]);
    }
    while ((m = routeRegex.exec(content))) {
      info.routes.push(m[1].toUpperCase() + " " + m[2]);
    }
    while ((m = todoRegex.exec(content))) {
      info.todos.push(m[1].trim().slice(0, 120));
    }

    /* Complexity: đếm if/for/while/case/&&/|| */
    const complexityRegex = /\b(if|for|while|case|catch)\b|&&|\|\||\?/g;
    let cm;
    while ((cm = complexityRegex.exec(content))) info.complexity++;

    info.imports = [...new Set(info.imports)];
    info.exports = [...new Set(info.exports)];
    return info;
  }

  /* ============================================================
     ALGORITHM — JSON ANALYZER
     ============================================================ */
  function analyzeJSON(content) {
    try {
      const obj = JSON.parse(content);
      const info = { valid: true, keys: Object.keys(obj), depth: 0, size: JSON.stringify(obj).length };
      function depth(o, d) {
        if (!o || typeof o !== "object") return d;
        let max = d;
        for (const k in o) {
          const dd = depth(o[k], d + 1);
          if (dd > max) max = dd;
        }
        return max;
      }
      info.depth = depth(obj, 0);
      info.isProject = obj.format === "dh-studio-project";
      info.isTuning = obj.format === "dh-weapon-tuning";
      if (info.isProject && obj.models) {
        info.models = Object.keys(obj.models);
        let totalAnims = 0;
        for (const m of info.models) {
          totalAnims += Object.keys(obj.models[m].animations || {}).length;
        }
        info.totalAnimations = totalAnims;
      }
      return info;
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  /* ============================================================
     BUILD PROJECT SNAPSHOT
     ============================================================ */
  async function buildSnapshot() {
    const startTime = Date.now();
    const files = await scanDirectory(ROOT, ROOT);
    console.log("[admin/build] Scanned " + files.length + " files");

    const analyzed = {
      text: [],
      image: [],
      other: [],
      tree: null,
      totalSize: 0,
      totalTextSize: 0,
      dependencies: {},
      stats: {
        totalFiles: files.length,
        textFiles: 0,
        imageFiles: 0,
        otherFiles: 0,
        totalFunctions: 0,
        totalClasses: 0,
        totalRoutes: 0,
        totalImports: 0,
        totalTODOs: 0,
        totalComplexity: 0,
        totalCodeLines: 0
      }
    };

    /* Load previous cache để detect changes */
    let prevCache = {};
    try {
      if (fsSync.existsSync(CACHE_FILE)) {
        prevCache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
      }
    } catch (e) {}

    const newCache = {};

    /* Analyze each file */
    for (const f of files) {
      const ext = path.extname(f.path).toLowerCase();
      const isText = TEXT_EXT.has(ext) || !ext;
      const isImage = IMAGE_EXT.has(ext);

      analyzed.totalSize += f.size;

      if (isImage) {
        try {
          const buf = await fs.readFile(f.absPath);
          const hash = await hashFile(buf);
          const meta = decodePngMetadata(buf);
          const imgInfo = analyzeImageInfo(meta);

          const entry = {
            path: f.path,
            size: f.size,
            hash,
            changed: prevCache[f.path] !== hash,
            imageInfo: imgInfo
          };
          analyzed.image.push(entry);
          analyzed.stats.imageFiles++;
          newCache[f.path] = hash;
        } catch (e) {
          analyzed.other.push({ path: f.path, size: f.size, error: e.message });
          analyzed.stats.otherFiles++;
        }
      } else if (isText) {
        if (f.size > MAX_FILE_SIZE) {
          analyzed.other.push({
            path: f.path, size: f.size, note: "Too large — skipped content"
          });
          analyzed.stats.otherFiles++;
          continue;
        }
        try {
          const content = await fs.readFile(f.absPath, "utf8");
          const hash = await hashFile(Buffer.from(content));
          const codeAnalysis = analyzeCode(content, ext);
          const jsonAnalysis = ext === ".json" ? analyzeJSON(content) : null;

          const entry = {
            path: f.path,
            size: f.size,
            hash,
            changed: prevCache[f.path] !== hash,
            content,
            analysis: codeAnalysis,
            jsonAnalysis
          };
          analyzed.text.push(entry);
          analyzed.totalTextSize += f.size;
          analyzed.stats.textFiles++;
          analyzed.stats.totalFunctions += codeAnalysis.functions;
          analyzed.stats.totalClasses += codeAnalysis.classes;
          analyzed.stats.totalRoutes += codeAnalysis.routes.length;
          analyzed.stats.totalImports += codeAnalysis.imports.length;
          analyzed.stats.totalTODOs += codeAnalysis.todos.length;
          analyzed.stats.totalComplexity += codeAnalysis.complexity;
          analyzed.stats.totalCodeLines += codeAnalysis.nonEmptyLines;
          newCache[f.path] = hash;
        } catch (e) {
          analyzed.other.push({ path: f.path, size: f.size, error: e.message });
          analyzed.stats.otherFiles++;
        }
      } else {
        analyzed.other.push({ path: f.path, size: f.size });
        analyzed.stats.otherFiles++;
      }
    }

    /* Build dependency graph */
    analyzed.dependencies = buildDependencyGraph(analyzed.text);

    /* Save cache */
    try {
      await fs.writeFile(CACHE_FILE, JSON.stringify(newCache, null, 2));
    } catch (e) {}

    analyzed.buildTime = Date.now() - startTime;
    return analyzed;
  }

  /* ============================================================
     DEPENDENCY GRAPH
     ============================================================ */
  function buildDependencyGraph(textFiles) {
    const graph = {};
    const pathSet = new Set(textFiles.map(f => f.path));

    for (const f of textFiles) {
      if (!f.analysis || !f.analysis.imports.length) continue;
      const deps = [];
      for (const imp of f.analysis.imports) {
        /* Skip node_modules packages */
        if (!imp.startsWith(".") && !imp.startsWith("/")) {
          deps.push({ type: "pkg", name: imp });
          continue;
        }
        /* Try to resolve relative path */
        const dir = path.dirname(f.path);
        const candidates = [
          path.normalize(path.join(dir, imp)).replace(/\\/g, "/"),
          path.normalize(path.join(dir, imp + ".js")).replace(/\\/g, "/"),
          path.normalize(path.join(dir, imp + ".html")).replace(/\\/g, "/"),
          path.normalize(path.join(dir, "index.js")).replace(/\\/g, "/")
        ];
        let resolved = null;
        for (const c of candidates) {
          if (pathSet.has(c)) { resolved = c; break; }
        }
        deps.push({
          type: resolved ? "local" : "unresolved",
          name: imp,
          path: resolved
        });
      }
      graph[f.path] = deps;
    }
    return graph;
  }

  /* ============================================================
     BUILD SMART PROMPT TEXT
     ============================================================ */
  function buildPromptText(snapshot) {
    const now = new Date().toISOString();
    let out = "";

    /* ============ HEADER ============================================ */
    out += "╔" + "═".repeat(70) + "╗\n";
    out += "║  🐉 DRAGON HUNTER — DEEP PROJECT ANALYSIS PROMPT".padEnd(71) + "║\n";
    out += "║  Generated: " + now.padEnd(56) + "║\n";
    out += "╚" + "═".repeat(70) + "╝\n\n";

    /* ============ SECTION 1 — TL;DR ================================ */
    out += "┌─ §1 ─ TL;DR ────────────────────────────────────────────────────┐\n";
    out += "Dragon Hunter — Game PvP pixel-art 2D top-down multiplayer.\n";
    out += "Stack:   Vanilla JS client + Node.js + WebSocket + PostgreSQL.\n";
    out += "Đặc biệt: PNG steganography (metadata JSON ở hàng pixel cuối).\n";
    out += "Có 2 tool: sprite editor + weapon tuner.\n";
    out += "KHÔNG framework · KHÔNG build step · Mở HTML là chạy.\n";
    out += "UI tiếng Việt · Code tiếng Anh.\n";
    out += "└────────────────────────────────────────────────────────────────┘\n\n";

    /* ============ SECTION 2 — PROJECT STATS ======================== */
    const s = snapshot.stats;
    out += "┌─ §2 ─ PROJECT STATISTICS ───────────────────────────────────────┐\n";
    out += "│ Files scanned:    " + String(s.totalFiles).padEnd(10) +
           " Text: " + String(s.textFiles).padEnd(6) +
           " Image: " + String(s.imageFiles).padEnd(6) +
           " Other: " + s.otherFiles + "\n";
    out += "│ Total size:       " + formatSize(snapshot.totalSize) + "\n";
    out += "│ Text size:        " + formatSize(snapshot.totalTextSize) + "\n";
    out += "│ Code lines:       " + s.totalCodeLines + " (non-empty)\n";
    out += "│ Functions:        " + s.totalFunctions + "\n";
    out += "│ Classes:          " + s.totalClasses + "\n";
    out += "│ HTTP routes:      " + s.totalRoutes + "\n";
    out += "│ Imports:          " + s.totalImports + "\n";
    out += "│ TODO/FIXME:       " + s.totalTODOs + "\n";
    out += "│ Complexity:       " + s.totalComplexity + " (branch points)\n";
    out += "│ Build time:       " + snapshot.buildTime + "ms\n";
    out += "└────────────────────────────────────────────────────────────────┘\n\n";

    /* ============ SECTION 3 — FILE TREE ============================ */
    out += "┌─ §3 ─ FILE TREE ────────────────────────────────────────────────┐\n";
    out += buildTreeText(snapshot);
    out += "└────────────────────────────────────────────────────────────────┘\n\n";

    /* ============ SECTION 4 — TEXT FILES INVENTORY ================= */
    out += "┌─ §4 ─ TEXT FILES INVENTORY ─────────────────────────────────────┐\n";
    out += padRight("PATH", 36) + padRight("SIZE", 10) +
           padRight("LINES", 8) + padRight("FN", 6) +
           padRight("CLS", 6) + padRight("RT", 6) + "CHG\n";
    out += "─".repeat(80) + "\n";
    for (const f of snapshot.text) {
      const a = f.analysis || {};
      out += padRight(f.path, 36) +
             padRight(formatSize(f.size), 10) +
             padRight(String(a.lines || 0), 8) +
             padRight(String(a.functions || 0), 6) +
             padRight(String(a.classes || 0), 6) +
             padRight(String((a.routes || []).length), 6) +
             (f.changed ? "✓" : " ") + "\n";
    }
    out += "└────────────────────────────────────────────────────────────────┘\n\n";

    /* ============ SECTION 5 — IMAGE FILES ========================== */
    out += "┌─ §5 ─ IMAGE / SPRITE FILES ─────────────────────────────────────┐\n";
    if (snapshot.image.length === 0) {
      out += "  (Không có file ảnh)\n";
    } else {
      for (const img of snapshot.image) {
        out += "  " + img.path + " " + (img.changed ? "[CHANGED]" : "") + "\n";
        out += "    Size: " + formatSize(img.size) + "  SHA: " + img.hash + "\n";
        if (img.imageInfo) {
          const ii = img.imageInfo;
          out += "    Dimensions: " + ii.width + "×" + ii.height + "px\n";
          if (ii.model || ii.anim) {
            out += "    Model: " + (ii.model || "?") +
                   "  Anim: " + (ii.anim || "?") + "\n";
          }
          if (ii.frames) {
            out += "    Frames: " + ii.frames +
                   "  FPS: " + ii.fps +
                   "  Loop: " + (ii.loop ? "yes" : "no") + "\n";
          }
          if (ii.spriteH) out += "    Sprite height: " + ii.spriteH + "px\n";
          if (ii.anchorMode) out += "    Anchor mode: " + ii.anchorMode + "\n";
          if (ii.avgFrameWidth) out += "    Avg frame width: " + ii.avgFrameWidth + "px\n";
          if (ii.stableAnchor) out += "    Stable anchor: [" +
            ii.stableAnchor[0] + "," + ii.stableAnchor[1] + "]\n";
          if (ii.anchorCount) out += "    Anchors: " + ii.anchorCount + " detected\n";
        } else {
          out += "    (No DHUN metadata — plain image)\n";
        }
        out += "\n";
      }
    }
    out += "└────────────────────────────────────────────────────────────────┘\n\n";

    /* ============ SECTION 6 — DEPENDENCY GRAPH ===================== */
    out += "┌─ §6 ─ DEPENDENCY GRAPH ────────────────────────────────────────┐\n";
    for (const [file, deps] of Object.entries(snapshot.dependencies)) {
      if (!deps.length) continue;
      out += "  " + file + ":\n";
      for (const d of deps) {
        const icon = d.type === "local" ? "→" :
                     d.type === "pkg" ? "📦" : "❓";
        out += "    " + icon + " " + d.name +
               (d.path ? "  →  " + d.path : "") + "\n";
      }
    }
    out += "└────────────────────────────────────────────────────────────────┘\n\n";

    /* ============ SECTION 7 — TODO/FIXME ============================ */
    const allTodos = [];
    for (const f of snapshot.text) {
      if (f.analysis && f.analysis.todos.length) {
        for (const t of f.analysis.todos) {
          allTodos.push({ file: f.path, text: t });
        }
      }
    }
    if (allTodos.length) {
      out += "┌─ §7 ─ TODO / FIXME ────────────────────────────────────────────┐\n";
      for (const t of allTodos) {
        out += "  [" + t.file + "]\n";
        out += "    " + t.text + "\n";
      }
      out += "└────────────────────────────────────────────────────────────────┘\n\n";
    }

    /* ============ SECTION 8 — ROUTES TABLE ========================== */
    const allRoutes = [];
    for (const f of snapshot.text) {
      if (f.analysis && f.analysis.routes.length) {
        for (const r of f.analysis.routes) {
          allRoutes.push({ file: f.path, route: r });
        }
      }
    }
    if (allRoutes.length) {
      out += "┌─ §8 ─ HTTP ROUTES ─────────────────────────────────────────────┐\n";
      for (const r of allRoutes) {
        out += "  " + padRight(r.route, 48) + " " + r.file + "\n";
      }
      out += "└────────────────────────────────────────────────────────────────┘\n\n";
    }

    /* ============ SECTION 9 — FULL SOURCE CODE ===================== */
    out += "╔" + "═".repeat(70) + "╗\n";
    out += "║  §9 — FULL SOURCE CODE (text files)                             ║\n";
    out += "╚" + "═".repeat(70) + "╝\n\n";

    for (let i = 0; i < snapshot.text.length; i++) {
      const f = snapshot.text[i];
      const ext = path.extname(f.path).slice(1);
      const lang = { js:"javascript", json:"json", md:"markdown",
                     html:"html", sql:"sql", css:"css",
                     yml:"yaml", yaml:"yaml" }[ext] || "text";

      out += "\n" + "═".repeat(72) + "\n";
      out += "  FILE " + (i + 1) + "/" + snapshot.text.length +
             ": " + f.path + "\n";
      out += "  Size: " + formatSize(f.size) +
             "  ·  SHA: " + f.hash +
             (f.changed ? "  ·  [CHANGED]" : "") + "\n";
      if (f.analysis) {
        out += "  Analysis: " + f.analysis.lines + " lines · " +
               f.analysis.functions + " fn · " +
               f.analysis.classes + " cls · " +
               f.analysis.complexity + " complexity\n";
      }
      out += "═".repeat(72) + "\n\n";
      out += "```" + lang + "\n" + f.content + "\n```\n\n";
    }

    /* ============ FOOTER ============================================ */
    out += "\n" + "═".repeat(72) + "\n";
    out += "  END OF PROJECT PROMPT · " + now + "\n";
    out += "  Total: " + snapshot.text.length + " text + " +
           snapshot.image.length + " image files\n";
    out += "═".repeat(72) + "\n";

    return out;
  }

  /* ============================================================
     HELPERS
     ============================================================ */
  function buildTreeText(snapshot) {
    const paths = [
      ...snapshot.text.map(f => f.path),
      ...snapshot.image.map(f => f.path),
      ...snapshot.other.map(f => f.path)
    ].sort();

    const tree = {};
    for (const p of paths) {
      const parts = p.split("/");
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!node[part]) node[part] = (i === parts.length - 1) ? null : {};
        node = node[part] || {};
      }
    }

    let out = "";
    function walk(node, prefix) {
      const keys = Object.keys(node).sort();
      keys.forEach((k, i) => {
        const isLast = i === keys.length - 1;
        const branch = isLast ? "└── " : "├── ";
        out += "  " + prefix + branch + k + "\n";
        if (node[k] && typeof node[k] === "object") {
          walk(node[k], prefix + (isLast ? "    " : "│   "));
        }
      });
    }
    walk(tree, "");
    return out;
  }

  function padRight(s, n) {
    s = String(s);
    return s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length);
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) return "—";
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
    return (bytes / 1024 / 1024).toFixed(2) + "MB";
  }

  /* ============================================================
     ROUTES
     ============================================================ */

  /* ---------- POST /admin/login ---------- */
  app.post("/admin/login", (req, res) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
    if (!checkRate(ip)) return res.status(429).json({ error: "Quá nhiều lần thử. Chờ 1 phút." });

    const body = req.body || {};
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password)
      return res.status(400).json({ error: "Nhập đầy đủ username và password" });

    let userOk = false, passOk = false;
    try {
      const ua = Buffer.from(username);
      const ub = Buffer.from(ADMIN_USER);
      userOk = ua.length === ub.length && crypto.timingSafeEqual(ua, ub);
      const pa = Buffer.from(password);
      const pb = Buffer.from(ADMIN_PASS);
      passOk = pa.length === pb.length && crypto.timingSafeEqual(pa, pb);
    } catch (e) { userOk = false; passOk = false; }

    if (!userOk || !passOk) {
      console.log("[admin] Login failed from", ip);
      return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
    }

    const token = signToken({
      user: ADMIN_USER,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000
    });

    console.log("[admin] Login OK:", ADMIN_USER, "from", ip);
    res.json({ ok: true, token, user: { username: ADMIN_USER } });
  });

  /* ---------- GET /admin/me ---------- */
  app.get("/admin/me", requireAdmin, (req, res) => {
    res.json({ ok: true, user: req.admin });
  });

  /* ---------- GET /admin/scan — scan + cache ---------- */
  app.get("/admin/scan", requireAdmin, async (req, res) => {
    try {
      const snapshot = await buildSnapshot();
      res.json({
        ok: true,
        stats: snapshot.stats,
        totalSize: snapshot.totalSize,
        totalTextSize: snapshot.totalTextSize,
        buildTime: snapshot.buildTime,
        textFiles: snapshot.text.map(f => ({
          path: f.path, size: f.size, hash: f.hash, changed: f.changed,
          analysis: f.analysis
        })),
        imageFiles: snapshot.image.map(f => ({
          path: f.path, size: f.size, hash: f.hash, changed: f.changed,
          imageInfo: f.imageInfo
        })),
        otherFiles: snapshot.other,
        dependencies: snapshot.dependencies
      });
    } catch (e) {
      console.error("[admin/scan]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------- GET /admin/build — build + download prompt ---------- */
  app.get("/admin/build", requireAdmin, async (req, res) => {
    try {
      const snapshot = await buildSnapshot();
      const prompt = buildPromptText(snapshot);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Prompt-Size", Buffer.byteLength(prompt, "utf8"));
      res.setHeader("X-Files-Count", snapshot.stats.totalFiles);
      res.setHeader("X-Build-Time", snapshot.buildTime);
      res.send(prompt);
    } catch (e) {
      console.error("[admin/build]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------- GET /admin/preview — build + return json for UI ---------- */
  app.get("/admin/preview", requireAdmin, async (req, res) => {
    try {
      const snapshot = await buildSnapshot();
      const prompt = buildPromptText(snapshot);
      res.json({
        ok: true,
        content: prompt,
        size: Buffer.byteLength(prompt, "utf8"),
        stats: snapshot.stats,
        buildTime: snapshot.buildTime
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------- GET /admin/file/* — read single file ---------- */
  app.get("/admin/file/*", requireAdmin, async (req, res) => {
    const filePath = req.params[0];
    if (!filePath) return res.status(400).json({ error: "missing path" });

    const fullPath = path.join(ROOT, filePath);
    /* Security */
    if (!path.resolve(fullPath).startsWith(path.resolve(ROOT))) {
      return res.status(403).json({ error: "path outside root" });
    }
    try {
      const content = await fs.readFile(fullPath, "utf8");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(content);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  /* ---------- GET /admin/versions ---------- */
  app.get("/admin/versions", requireAdmin, async (req, res) => {
    if (!db) return res.json({ versions: [], projects: [] });
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const r = await db.query(
        "SELECT pv.id, pv.hash, pv.label, pv.ts, pv.total_size, pv.files_count, " +
        "       pv.is_delta, pv.delta_size, pp.slug AS project_slug " +
        "FROM prompt_versions pv " +
        "JOIN prompt_projects pp ON pp.id = pv.project_id " +
        "ORDER BY pv.ts DESC LIMIT $1",
        [limit]
      );
      const projects = await db.query(
        "SELECT pp.id, pp.slug, pp.name, pp.created_at, " +
        "       COUNT(pv.id) AS version_count " +
        "FROM prompt_projects pp " +
        "LEFT JOIN prompt_versions pv ON pv.project_id = pp.id " +
        "GROUP BY pp.id ORDER BY pp.created_at DESC"
      );
      res.json({ versions: r.rows, projects: projects.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------- GET /admin/version/:id ---------- */
  app.get("/admin/version/:id", requireAdmin, async (req, res) => {
    if (!db) return res.status(503).json({ error: "db not available" });
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: "bad id" });
    try {
      const rows = await db.query(
        "WITH RECURSIVE chain AS (" +
        "  SELECT * FROM prompt_versions WHERE id = $1 " +
        "  UNION ALL " +
        "  SELECT pv.* FROM prompt_versions pv " +
        "  JOIN chain c ON pv.id = c.base_version" +
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
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------- DELETE /admin/version/:id ---------- */
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

  /* ---------- DELETE /admin/all ---------- */
  app.delete("/admin/all", requireAdmin, async (req, res) => {
    if (!db) return res.status(503).json({ error: "db not available" });
    try {
      const r = await db.query("DELETE FROM prompt_versions");
      res.json({ ok: true, deleted: r.rowCount });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------- GET /admin/analytics ---------- */
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
      res.status(500).json({ error: e.message });
    }
  });

  console.log("[admin.routes] ✓ Mounted v2 · Deep analysis · user: " + ADMIN_USER);
};
