/* ============================================================
   DB Migration Script
   Chạy: node db/migrate.js
   Hoặc tự động khi server start
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate(){
  const url = process.env.DATABASE_URL;
  if (!url){
    console.log('[Migrate] No DATABASE_URL — skip');
    return false;
  }

  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false }
  });

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    console.log('[Migrate] Running schema.sql...');
    await pool.query(sql);
    console.log('[Migrate] ✓ Schema applied');

    /* Verify tables */
    const r = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    console.log('[Migrate] Tables:', r.rows.map(x => x.tablename).join(', '));

    await pool.end();
    return true;
  } catch(e){
    console.error('[Migrate] ✗ Fail:', e.message);
    await pool.end();
    return false;
  }
}

if (require.main === module){
  migrate().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = migrate;
