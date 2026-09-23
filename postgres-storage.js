/* Optional PostgreSQL persistence adapter for production deployments.
 * The current app can continue using SQLite; this module provides the SQL
 * primitives needed when DATABASE_URL is configured and the pg package is installed.
 */
const crypto = require('crypto');
const schema = `
CREATE TABLE IF NOT EXISTS who_app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);`;
function createPostgresStore(pg) {
  if (!pg || !pg.Pool) throw new Error('pg package is required for PostgreSQL storage.');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 10), ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  return {
    pool,
    async init(){ await pool.query(schema); },
    async load(fallback){ const r=await pool.query('SELECT payload FROM who_app_state WHERE id=1'); return r.rows[0]?.payload || fallback; },
    async save(db, version=23){ await pool.query(`INSERT INTO who_app_state(id,version,payload,updated_at) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at`,[version,db,Date.now()]); },
    async close(){ await pool.end(); }
  };
}
function migrationToken(){ return crypto.randomBytes(12).toString('hex'); }
module.exports={schema,createPostgresStore,migrationToken};
