const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'who-sabi-me.sqlite');
const LEGACY_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const emptyDb = () => ({users:{},sessions:{},sessionMeta:{},profiles:{},quizzes:{},memories:[],attempts:[],notifications:[],follows:{},comments:[],messages:[],friendRequests:[],reports:[],privacy:{},tokens:{},blocks:{},stories:[],puzzleGames:{},wallets:{},subscriptions:{},transactions:[],coinLedger:[],wordBank:[],announcements:[],appeals:[],wordBank:[],announcements:[],appeals:[],creators:{},creatorPacks:[],creatorPurchases:[],creatorPayouts:[],creatorSubscriptions:[],creatorFollows:{},creatorReviews:[],creatorStorefronts:{},creatorPosts:[],creatorPostLikes:{},creatorPostComments:[],creatorLives:[],creatorCollaborations:[],creatorDrafts:[],creatorScheduledPosts:[],creatorPromoCodes:[],creatorAiHistory:[],matchmaking:{},playerAiProfiles:{},playerCoachHistory:[]});

const sqlite = new DatabaseSync(DB_FILE);
sqlite.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);`);

function readLegacy(){
  try { return {...emptyDb(), ...JSON.parse(fs.readFileSync(LEGACY_FILE,'utf8'))}; } catch { return emptyDb(); }
}
function load(){
  const row = sqlite.prepare('SELECT payload FROM app_state WHERE id=1').get();
  if (row?.payload) { try { return {...emptyDb(), ...JSON.parse(row.payload)}; } catch {} }
  const legacy = readLegacy();
  save(legacy);
  return legacy;
}
function save(db){
  const payload = JSON.stringify(db);
  const stmt = sqlite.prepare(`INSERT INTO app_state(id,version,payload,updated_at) VALUES(1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload,updated_at=excluded.updated_at`);
  stmt.run(34, payload, Date.now());
}
function backup(destination){
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  sqlite.exec(`VACUUM INTO '${String(destination).replace(/'/g,"''")}'`);
}
function randomId(){return crypto.randomBytes(18).toString('hex')}
module.exports={DB_FILE,emptyDb,load,save,backup,randomId};
