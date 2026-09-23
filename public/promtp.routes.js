/* ============================================================
   PROMPT.ROUTES.JS — Universal Module
   ============================================================
   Dùng cho cả 2 môi trường:

   - Node.js:  require('./public/prompt.routes')
               → mount server routes vào Express

   - Browser:  <script src="public/prompt.routes.js"></script>
               → có window.PromptRoutes làm client API

   ============================================================ */
(function (root, factory) {
  "use strict";

  /* ============ SHARED ALGORITHMS ============ */
  var ALGO = factory();

  /* ============ SERVER SIDE (Node.js) ============ */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = function mountPromptRoutes(app, db, requireAuth) {
      if (!db) {
        console.warn("[prompt.routes] No DB — routes disabled");
        return;
      }

      /* ---------- Project resolve ---------- */
      async function getOrCreateProject(slug, ownerId) {
        var r = await db.query(
          "SELECT * FROM prompt_projects WHERE slug = $1",
          [slug]
        );
        if (r.rowCount > 0) return r.rows[0];

        r = await db.query(
          "INSERT INTO prompt_projects (slug, name, owner_id) VALUES ($1, $2, $3) RETURNING *",
          [slug, slug, ownerId || null]
        );
        return r.rows[0];
      }

      /* ---------- POST /prompt/snapshot ---------- */
      app.post("/prompt/snapshot", requireAuth, async function (req, res) {
        var body = req.body || {};
        var project = body.project;
        var label = body.label || "auto";
        var files = body.files;
        var fullText = body.fullText;
        var changes = body.changes || [];

        if (!project || !Array.isArray(files) || !fullText) {
          return res.status(400).json({ error: "Missing project/files/fullText" });
        }

        try {
          var proj = await getOrCreateProject(project, req.userId);
          var hash = ALGO.hashContent(fullText);

          var dup = await db.query(
            "SELECT id, ts FROM prompt_versions WHERE project_id = $1 AND hash = $2",
            [proj.id, hash]
          );
          if (dup.rowCount > 0) {
            return res.json({ ok: true, dedup: true, version: dup.rows[0] });
          }

          var prev = await db.query(
            "SELECT id, content FROM prompt_versions WHERE project_id = $1 ORDER BY ts DESC LIMIT 1",
            [proj.id]
          );

          var delta = null, deltaSize = 0, isDelta = false, baseVersion = null;
          if (prev.rowCount > 0 && prev.rows[0].content) {
            var ops = ALGO.myersDiff(prev.rows[0].content, fullText);
            delta = ALGO.compressDelta(ops);
            deltaSize = delta.length;
            baseVersion = prev.rows[0].id;
            var totalLines = fullText.split("\n").length;
            if (deltaSize * 3 < totalLines) isDelta = true;
          }

          var ins = await db.query(
            "INSERT INTO prompt_versions " +
            "(project_id, hash, label, total_size, files_count, is_delta, " +
            " base_version, content, delta, delta_size, meta) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, ts",
            [
              proj.id, hash, label, fullText.length, files.length,
              isDelta, baseVersion,
              isDelta ? null : fullText,
              delta ? JSON.stringify(delta) : null,
              deltaSize,
              JSON.stringify({ ua: req.headers["user-agent"] || null })
            ]
          );

          var versionId = ins.rows[0].id;

          if (files.length > 0) {
            var filePlaceholders = files.map(function (_, i) {
              var b = i * 5;
              return "($" + (b+1) + ",$" + (b+2) + ",$" + (b+3) + ",$" + (b+4) + ",$" + (b+5) + ")";
            }).join(",");

            var fileParams = [];
            for (var fi = 0; fi < files.length; fi++) {
              var f = files[fi];
              fileParams.push(
                versionId,
                String(f.label || "").slice(0, 80),
                f.url ? String(f.url).slice(0, 200) : null,
                String(f.hash || "").slice(0, 80),
                Number(f.size) || 0
              );
            }

            await db.query(
              "INSERT INTO prompt_files (version_id, label, url, hash, size) VALUES " +
              filePlaceholders,
              fileParams
            );
          }

          if (changes.length > 0) {
            var cPlaceholders = changes.map(function (_, i) {
              var b = i * 3;
              return "($" + (b+1) + ",$" + (b+2) + ",$" + (b+3) + ")";
            }).join(",");

            var cParams = [];
            for (var ci = 0; ci < changes.length; ci++) {
              var c = changes[ci];
              var type = ["new", "modified", "deleted"].indexOf(c.type) >= 0
                ? c.type : "modified";
              cParams.push(versionId, String(c.label || "").slice(0, 80), type);
            }

            await db.query(
              "INSERT INTO prompt_changes (version_id, file_label, change_type) VALUES " +
              cPlaceholders,
              cParams
            );
          }

          res.json({
            ok: true,
            version: { id: versionId, ts: ins.rows[0].ts },
            isDelta: isDelta,
            deltaSize: deltaSize,
            hash: hash
          });
        } catch (e) {
          console.error("[prompt/snapshot]", e.message);
          res.status(500).json({ error: e.message });
        }
      });

      /* ---------- GET /prompt/versions ---------- */
      app.get("/prompt/versions", requireAuth, async function (req, res) {
        var project = req.query.project || "default";
        var limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

        try {
          var proj = await db.query(
            "SELECT id FROM prompt_projects WHERE slug = $1",
            [project]
          );
          if (proj.rowCount === 0) return res.json({ versions: [] });

          var r = await db.query(
            "SELECT id, hash, label, ts, total_size, files_count, " +
            "       is_delta, delta_size, pg_column_size(content) AS compressed_size " +
            "FROM prompt_versions WHERE project_id = $1 " +
            "ORDER BY ts DESC LIMIT $2",
            [proj.rows[0].id, limit]
          );

          res.json({ versions: r.rows, projectId: proj.rows[0].id });
        } catch (e) {
          console.error("[prompt/versions]", e.message);
          res.status(500).json({ error: e.message });
        }
      });

      /* ---------- GET /prompt/version/:id ---------- */
      app.get("/prompt/version/:id", requireAuth, async function (req, res) {
        var id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: "Bad id" });

        try {
          var rows = await db.query(
            "WITH RECURSIVE chain AS (" +
            "  SELECT * FROM prompt_versions WHERE id = $1 " +
            "  UNION ALL " +
            "  SELECT pv.* FROM prompt_versions pv JOIN chain c ON pv.id = c.base_version" +
            ") SELECT * FROM chain ORDER BY id ASC",
            [id]
          );
          if (rows.rowCount === 0) return res.status(404).json({ error: "Not found" });

          var content = null;
          for (var i = 0; i < rows.rows.length; i++) {
            var v = rows.rows[i];
            if (!v.is_delta) { content = v.content; continue; }
            if (content && v.delta) {
              var delta = typeof v.delta === "string" ? JSON.parse(v.delta) : v.delta;
              content = ALGO.applyDelta(content.split("\n"), delta).join("\n");
            }
          }
          if (!content) return res.status(500).json({ error: "Reconstruct failed" });

          var files = await db.query(
            "SELECT label, url, hash, size FROM prompt_files WHERE version_id = $1",
            [id]
          );
          var changes = await db.query(
            "SELECT file_label, change_type FROM prompt_changes WHERE version_id = $1",
            [id]
          );

          res.json({
            content: content,
            files: files.rows,
            changes: changes.rows,
            versionId: id,
            meta: rows.rows.find(function (v) { return v.id === id; }) || null
          });
        } catch (e) {
          console.error("[prompt/version]", e.message);
          res.status(500).json({ error: e.message });
        }
      });

      /* ---------- GET /prompt/diff?a=&b= ---------- */
      app.get("/prompt/diff", requireAuth, async function (req, res) {
        var a = parseInt(req.query.a);
        var b = parseInt(req.query.b);
        if (!a || !b) return res.status(400).json({ error: "Need a and b" });

        async function getContent(id) {
          var rows = await db.query(
            "WITH RECURSIVE chain AS (" +
            "  SELECT * FROM prompt_versions WHERE id = $1 " +
            "  UNION ALL " +
            "  SELECT pv.* FROM prompt_versions pv JOIN chain c ON pv.id = c.base_version" +
            ") SELECT * FROM chain ORDER BY id ASC",
            [id]
          );
          var content = null;
          for (var i = 0; i < rows.rows.length; i++) {
            var v = rows.rows[i];
            if (!v.is_delta) { content = v.content; continue; }
            if (content && v.delta) {
              var delta = typeof v.delta === "string" ? JSON.parse(v.delta) : v.delta;
              content = ALGO.applyDelta(content.split("\n"), delta).join("\n");
            }
          }
          return content || "";
        }

        try {
          var results = await Promise.all([getContent(a), getContent(b)]);
          var ops = ALGO.myersDiff(results[0], results[1]);
          var changesOnly = ops.filter(function (o) { return o.type !== "eq"; });

          res.json({
            a: a, b: b,
            stats: {
              additions: ops.filter(function (o) { return o.type === "add"; }).length,
              deletions: ops.filter(function (o) { return o.type === "del"; }).length,
              totalOps: ops.length
            },
            changes: changesOnly.slice(0, 5000)
          });
        } catch (e) {
          console.error("[prompt/diff]", e.message);
          res.status(500).json({ error: e.message });
        }
      });

      /* ---------- GET /prompt/analytics?project= ---------- */
      app.get("/prompt/analytics", requireAuth, async function (req, res) {
        var project = req.query.project || "default";

        try {
          var proj = await db.query(
            "SELECT id FROM prompt_projects WHERE slug = $1",
            [project]
          );
          if (proj.rowCount === 0) return res.json({ empty: true });

          var pid = proj.rows[0].id;

          var results = await Promise.all([
            db.query("SELECT * FROM prompt_analytics WHERE project_id = $1", [pid]),
            db.query(
              "SELECT * FROM prompt_hot_files WHERE project_id = $1 " +
              "ORDER BY change_count DESC LIMIT 15", [pid]
            ),
            db.query(
              "SELECT id, ts, total_size, files_count, delta_size, is_delta " +
              "FROM prompt_versions WHERE project_id = $1 ORDER BY ts ASC LIMIT 100", [pid]
            ),
            db.query(
              "SELECT EXTRACT(HOUR FROM ts) AS hour, COUNT(*) AS cnt " +
              "FROM prompt_versions WHERE project_id = $1 GROUP BY 1 ORDER BY 1", [pid]
            ),
            db.query(
              "SELECT AVG(total_size)::BIGINT AS avg_uncompressed, " +
              "       AVG(pg_column_size(content))::BIGINT AS avg_compressed, " +
              "       SUM(delta_size) AS total_delta_lines " +
              "FROM prompt_versions WHERE project_id = $1 AND content IS NOT NULL", [pid]
            ),
            db.query(
              "SELECT AVG(diff)::BIGINT AS avg_interval_seconds FROM (" +
              "  SELECT EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (ORDER BY ts))) AS diff " +
              "  FROM prompt_versions WHERE project_id = $1" +
              ") t WHERE diff IS NOT NULL", [pid]
            )
          ]);

          res.json({
            empty: false,
            projectId: pid,
            overview: results[0].rows[0] || null,
            hotFiles: results[1].rows,
            timeline: results[2].rows,
            hourlyActivity: results[3].rows,
            compression: results[4].rows[0] || null,
            intervals: results[5].rows[0] || null
          });
        } catch (e) {
          console.error("[prompt/analytics]", e.message);
          res.status(500).json({ error: e.message });
        }
      });

      /* ---------- DELETE /prompt/versions?project= ---------- */
      app.delete("/prompt/versions", requireAuth, async function (req, res) {
        var project = req.query.project || "default";
        try {
          var proj = await db.query(
            "SELECT id FROM prompt_projects WHERE slug = $1", [project]
          );
          if (proj.rowCount === 0) return res.json({ ok: true, deleted: 0 });

          var r = await db.query(
            "DELETE FROM prompt_versions WHERE project_id = $1", [proj.rows[0].id]
          );
          res.json({ ok: true, deleted: r.rowCount });
        } catch (e) {
          console.error("[prompt DELETE]", e.message);
          res.status(500).json({ error: e.message });
        }
      });

      console.log("[prompt.routes] Mounted 6 endpoints");
    };

    /* Export algorithms cho test */
    module.exports.hashContent = ALGO.hashContent;
    module.exports.myersDiff = ALGO.myersDiff;
    module.exports.compressDelta = ALGO.compressDelta;
    module.exports.applyDelta = ALGO.applyDelta;
  }

  /* ============ CLIENT SIDE (Browser) ============ */
  else if (typeof window !== "undefined") {

    /**
     * Client API — gọi backend endpoints
     * Cách dùng:
     *   var api = window.PromptRoutes.client(BACKEND_URL, AUTH.token);
     *   await api.saveSnapshot({ project, files, fullText, changes });
     */
    function makeClient(baseUrl, token) {
      if (!baseUrl) throw new Error("PromptRoutes: baseUrl required");

      async function apiCall(path, options) {
        options = options || {};
        var headers = Object.assign({}, options.headers || {});
        if (token) headers["Authorization"] = "Bearer " + token;
        if (options.body && typeof options.body !== "string") {
          headers["Content-Type"] = "application/json";
          options.body = JSON.stringify(options.body);
        }
        var url = baseUrl.replace(/\/+$/, "") + path;
        var res = await fetch(url, Object.assign({}, options, { headers: headers }));
        var data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok) {
          var err = new Error((data && data.error) || ("HTTP " + res.status));
          err.status = res.status;
          throw err;
        }
        return data;
      }

      return {
        /* POST /prompt/snapshot */
        saveSnapshot: function (payload) {
          return apiCall("/prompt/snapshot", { method: "POST", body: payload });
        },

        /* GET /prompt/versions */
        listVersions: function (project, limit) {
          var q = "/prompt/versions?project=" + encodeURIComponent(project);
          if (limit) q += "&limit=" + limit;
          return apiCall(q, { method: "GET" });
        },

        /* GET /prompt/version/:id */
        getVersion: function (id) {
          return apiCall("/prompt/version/" + id, { method: "GET" });
        },

        /* GET /prompt/diff?a=&b= */
        diff: function (a, b) {
          return apiCall("/prompt/diff?a=" + a + "&b=" + b, { method: "GET" });
        },

        /* GET /prompt/analytics */
        analytics: function (project) {
          return apiCall(
            "/prompt/analytics?project=" + encodeURIComponent(project),
            { method: "GET" }
          );
        },

        /* DELETE /prompt/versions */
        clearAll: function (project) {
          return apiCall(
            "/prompt/versions?project=" + encodeURIComponent(project),
            { method: "DELETE" }
          );
        }
      };
    }

    /* Expose toàn bộ */
    window.PromptRoutes = {
      client: makeClient,
      hashContent: ALGO.hashContent,
      myersDiff: ALGO.myersDiff,
      compressDelta: ALGO.compressDelta,
      applyDelta: ALGO.applyDelta
    };

    console.log("[PromptRoutes] Client API ready — use window.PromptRoutes.client(baseUrl, token)");
  }

})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ============================================================
     ALGORITHMS — dùng chung server + client
     ============================================================ */

  /* ---------- SHA-256 ---------- */
  function hashContent(text) {
    if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
      /* Browser: dùng sync fallback đơn giản */
      var h = 0, i, chr;
      for (i = 0; i < text.length; i++) {
        chr = text.charCodeAt(i);
        h = ((h << 5) - h + chr) | 0;
      }
      return "local_" + (h >>> 0).toString(16) + "_" + text.length.toString(16);
    }
    /* Node.js: dùng crypto module */
    try {
      var nodeCrypto = require("crypto");
      return nodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
    } catch (e) {
      return "fallback_" + text.length.toString(16);
    }
  }

  /* ---------- Myers Diff O(ND) ---------- */
  function myersDiff(a, b) {
    var A = a.split("\n"), B = b.split("\n");
    var N = A.length, M = B.length;
    var MAX = N + M;
    var v = new Array(2 * MAX + 1).fill(0);
    var trace = [];

    for (var d = 0; d <= MAX; d++) {
      trace.push(v.slice());
      for (var k = -d; k <= d; k += 2) {
        var x;
        if (k === -d || (k !== d && v[k - 1 + MAX] < v[k + 1 + MAX])) {
          x = v[k + 1 + MAX];
        } else {
          x = v[k - 1 + MAX] + 1;
        }
        var y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[k + MAX] = x;
        if (x >= N && y >= M) {
          return backtrack(trace, A, B, d, MAX);
        }
      }
    }
    return [];
  }

  function backtrack(trace, A, B, d, MAX) {
    var ops = [];
    var x = A.length, y = B.length;
    for (var depth = d; depth > 0; depth--) {
      var v = trace[depth];
      var k = x - y;
      var prevK;
      if (k === -depth || (k !== depth && v[k - 1 + MAX] < v[k + 1 + MAX])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      var prevX = v[prevK + MAX];
      var prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        ops.unshift({ type: "eq", value: A[x - 1] });
        x--; y--;
      }
      if (x === prevX) {
        ops.unshift({ type: "add", value: B[y - 1] });
        y--;
      } else {
        ops.unshift({ type: "del", value: A[x - 1] });
        x--;
      }
    }
    while (x > 0 && y > 0) {
      ops.unshift({ type: "eq", value: A[x - 1] });
      x--; y--;
    }
    return ops;
  }

  /* ---------- Delta Compression ---------- */
  function compressDelta(ops) {
    var delta = [];
    var line = 0;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === "eq") { line++; continue; }
      delta.push({ op: op.type, line: line, value: op.value });
      if (op.type === "del") line++;
    }
    return delta;
  }

  function applyDelta(baseLines, delta) {
    var out = baseLines.slice();
    var offset = 0;
    for (var i = 0; i < delta.length; i++) {
      var d = delta[i];
      var idx = d.line + offset;
      if (d.op === "add") {
        out.splice(idx, 0, d.value);
        offset++;
      } else if (d.op === "del") {
        out.splice(idx, 1);
        offset--;
      }
    }
    return out;
  }

  return {
    hashContent: hashContent,
    myersDiff: myersDiff,
    compressDelta: compressDelta,
    applyDelta: applyDelta
  };
});
