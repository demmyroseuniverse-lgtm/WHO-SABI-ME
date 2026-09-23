const {heartbeat,retryHint}=require('./realtime');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {emptyDb, load: loadDb, save: persistDb, backup: backupDb, DB_FILE, randomId} = require('./storage');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const SESSION_TTL = Number(process.env.SESSION_TTL_MS || 1000*60*60*24*30);
const IS_HTTPS = String(process.env.NODE_ENV||'').toLowerCase()==='production';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME||'admin';
const REQUIRE_EMAIL_VERIFIED = String(process.env.REQUIRE_EMAIL_VERIFIED||'false').toLowerCase()==='true';
const PASSWORD_MIN = Math.max(8, Number(process.env.PASSWORD_MIN_LENGTH||10));
const COIN_PACKS={starter:{coins:100,priceKobo:9900},booster:{coins:550,priceKobo:49000},mega:{coins:1200,priceKobo:99000}};
const FREE_MEMBERSHIP={name:'Arena Membership',priceKobo:0,days:0};
const REWARDED_AD={coins:20,dailyLimit:10,cooldownMs:60_000};
const AD_CONFIG={provider:process.env.AD_PROVIDER||'adsense',enabled:String(process.env.ADS_ENABLED||'false').toLowerCase()==='true',publisherId:process.env.ADSENSE_PUBLISHER_ID||'',slots:{top:process.env.ADSENSE_SLOT_TOP||'',feed:process.env.ADSENSE_SLOT_FEED||'',discover:process.env.ADSENSE_SLOT_DISCOVER||'',premium:process.env.ADSENSE_SLOT_PREMIUM||''}};
const REWARDED_ADS_PROVIDER=process.env.REWARDED_ADS_PROVIDER||'demo';
const REWARDED_ADS_ENABLED=String(process.env.REWARDED_ADS_ENABLED||'true').toLowerCase()==='true';
const PAYSTACK_ENABLED=String(process.env.PAYSTACK_ENABLED||'false').toLowerCase()==='true';
const PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||'';
const PAYSTACK_CURRENCY=process.env.PAYSTACK_CURRENCY||'NGN';
const APP_BASE_URL=(process.env.APP_BASE_URL||'').replace(/\/$/,'');
function ensureAdminData(){db.wordBank=Array.isArray(db.wordBank)?db.wordBank:[];db.announcements=Array.isArray(db.announcements)?db.announcements:[];db.appeals=Array.isArray(db.appeals)?db.appeals:[];for(const u of Object.values(db.users||{}))u.status=u.status||'active'}
function isAdmin(u){return u===ADMIN_USERNAME}
function accountStatus(u){const a=Object.values(db.users||{}).find(x=>x.username===u);return a?.status||'active'}
function ensureEconomy(username){db.wallets=db.wallets||{};db.subscriptions=db.subscriptions||{};db.transactions=db.transactions||[];db.coinLedger=db.coinLedger||[];db.adRewards=db.adRewards||{};db.adMetrics=db.adMetrics||{views:{}};if(username&&!db.wallets[username])db.wallets[username]={coins:0,updatedAt:Date.now()};if(username&&!db.subscriptions[username])db.subscriptions[username]={tier:'free',name:FREE_MEMBERSHIP.name,priceKobo:0,startedAt:Date.now(),expiresAt:null}}
const LOGIN_LIMIT = Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE || 12);
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 120);
const RATE_WINDOW = 60_000;
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 2_000_000);
const rateBuckets = new Map();
const loginBuckets = new Map();
const startedAt = Date.now();
let shuttingDown = false;
const sseClients = new Map();
const typingState = new Map();
function loginLimit(ip){const now=Date.now();let b=loginBuckets.get(ip);if(!b||now-b.started>RATE_WINDOW)b={started:now,count:0};b.count++;loginBuckets.set(ip,b);return b.count<=LOGIN_LIMIT}
function rateLimit(ip){const now=Date.now();let b=rateBuckets.get(ip);if(!b||now-b.started>RATE_WINDOW)b={started:now,count:0};b.count++;rateBuckets.set(ip,b);return b.count<=RATE_LIMIT}
function broadcast(username,event,data){const set=sseClients.get(username);if(!set)return;const payload=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;for(const res of set){try{res.write(payload)}catch{set.delete(res)}}}
let db=loadDb();
ensureAdminData();
db.creators=db.creators||{};db.creatorPacks=Array.isArray(db.creatorPacks)?db.creatorPacks:[];db.creatorPurchases=Array.isArray(db.creatorPurchases)?db.creatorPurchases:[];db.creatorPayouts=Array.isArray(db.creatorPayouts)?db.creatorPayouts:[];db.creatorSubscriptions=Array.isArray(db.creatorSubscriptions)?db.creatorSubscriptions:[];db.creatorFollows=db.creatorFollows||{};db.creatorReviews=Array.isArray(db.creatorReviews)?db.creatorReviews:[];db.creatorStorefronts=db.creatorStorefronts||{};db.creatorPosts=Array.isArray(db.creatorPosts)?db.creatorPosts:[];db.creatorPostLikes=db.creatorPostLikes||{};db.creatorPostComments=Array.isArray(db.creatorPostComments)?db.creatorPostComments:[];db.creatorLives=Array.isArray(db.creatorLives)?db.creatorLives:[];db.creatorCollaborations=Array.isArray(db.creatorCollaborations)?db.creatorCollaborations:[];
db.dailyPuzzleAttempts=db.dailyPuzzleAttempts||{};
function saveDb(){persistDb(db)}
function id(){return randomId()}
function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')){return new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,(e,key)=>e?reject(e):resolve(`${salt}:${key.toString('hex')}`)))}
async function verifyPassword(password,stored){const [salt,key]=String(stored).split(':');const actual=await hashPassword(password,salt);return crypto.timingSafeEqual(Buffer.from(actual),Buffer.from(stored))}
function parseCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i).trim(),decodeURIComponent(x.slice(i+1).trim())]}))}
function clearSession(sid){if(sid){delete db.sessions[sid];delete (db.sessionMeta||{})[sid]}}
function sessionCookie(sid,maxAge=SESSION_TTL){return `wsm_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAge/1000)}${IS_HTTPS?'; Secure':''}`}
function userFrom(req){const sid=parseCookies(req).wsm_sid;if(!sid||!db.sessions[sid])return null;const session=db.sessions[sid];const username=typeof session==='object'?session.username:session;if(typeof session==='object'&&session.expiresAt&&session.expiresAt<Date.now()){delete db.sessions[sid];return null}return username}
function passwordStrong(p){return typeof p==='string' && p.length>=PASSWORD_MIN && /[A-Za-z]/.test(p) && /\d/.test(p)}
function blocked(a,b){return Boolean((db.blocks?.[a]||[]).includes(b)||(db.blocks?.[b]||[]).includes(a))}
function send(res,status,data,headers={}){const body=typeof data==='string'?data:JSON.stringify(data);const security={'Content-Type':typeof data==='string'?'text/plain; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://pagead2.googlesyndication.com https://www.googletagservices.com; connect-src 'self' https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net; frame-src 'self' https://googleads.g.doubleclick.net https://tpc.googlesyndication.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};if(IS_HTTPS)security['Strict-Transport-Security']='max-age=31536000; includeSubDomains';res.writeHead(status,{...security,...headers});res.end(body)}
function rawBody(req){return new Promise((resolve,reject)=>{let chunks=[];let total=0;req.on('data',c=>{total+=c.length;if(total>MAX_BODY){reject(Object.assign(new Error('Request body too large.'),{status:413}));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function jsonBody(req){return new Promise((resolve,reject)=>{let s='';let tooLarge=false;req.on('data',c=>{if(tooLarge)return;s+=c;if(s.length>MAX_BODY){tooLarge=true;reject(Object.assign(new Error('Request body too large.'),{status:413}));req.destroy()}});req.on('end',()=>{if(tooLarge)return;try{resolve(s?JSON.parse(s):{})}catch(e){reject(Object.assign(new Error('Invalid JSON body.'),{status:400}))}});req.on('error',reject)})}
function publicUser(username){const p=db.profiles[username];return p?{username:p.username,displayName:p.displayName,bio:p.bio,avatar:p.avatar||'',createdAt:p.createdAt}:null}
function stateFor(username){
 const visibleProfiles=Object.fromEntries(Object.entries(db.profiles).map(([u,p])=>{const privacy=db.privacy[u]||{};if(privacy.private&&u!==username&&!((db.follows[username]||[]).includes(u))) return [u,{...p,avatar:'',bio:'Private profile'}];return [u,p]}));
 const cutoff=Date.now()-24*60*60*1000; db.stories=(db.stories||[]).filter(x=>x.createdAt>cutoff);
 for (const [u,p] of Object.entries(visibleProfiles)) p.online=Boolean(sseClients.has(u));
 return {profiles:visibleProfiles,quizzes:db.quizzes,memories:db.memories,attempts:db.attempts,notifications:db.notifications.filter(n=>n.username===username),following:db.follows[username]||[],comments:db.comments.slice(-2000),messages:db.messages.filter(m=>m.from===username||m.to===username).slice(-500),friendRequests:db.friendRequests.filter(r=>r.from===username||r.to===username),privacy:db.privacy[username]||{},stories:db.stories.slice(-500),puzzleGames:Object.fromEntries(Object.entries(db.puzzleGames||{}).filter(([id,g])=>g.players.includes(username)||g.invited.includes(username)))}
}
function mergeState(username,s){
  if(s.profiles&&typeof s.profiles==='object') for(const [u,p] of Object.entries(s.profiles)) if(p&&p.username) db.profiles[u]={...db.profiles[u],...p};
  if(s.quizzes&&typeof s.quizzes==='object') for(const [u,q] of Object.entries(s.quizzes)) if(q) db.quizzes[u]=q;
  if(Array.isArray(s.memories)){const map=new Map(db.memories.map(x=>[x.id,x]));for(const x of s.memories)if(x?.id)map.set(x.id,x);db.memories=[...map.values()].slice(-1000)}
  if(Array.isArray(s.attempts)){const map=new Map(db.attempts.map(x=>[x.id||`${x.username}|${x.player}|${x.createdAt}`,x]));for(const x of s.attempts)if(x)map.set(x.id||`${x.username}|${x.player}|${x.createdAt}`,x);db.attempts=[...map.values()].slice(-5000)}
  if(Array.isArray(s.following)) db.follows[username]=[...new Set(s.following.filter(x=>typeof x==='string'))];
  saveDb();
}


function areFriends(a,b){return Boolean(a&&b&&a!==b&&(db.follows[a]||[]).includes(b)&&(db.follows[b]||[]).includes(a))}
function puzzleRoomCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code='';for(let i=0;i<6;i++)code+=chars[Math.floor(Math.random()*chars.length)];return code}
function safePuzzle(g,username){const now=Date.now();const out={...g,grid:g.grid,placements:undefined};out.currentPlayer=g.status==='playing'?g.players[g.turnIndex]:null;out.isMyTurn=out.currentPlayer===username;out.remainingMs=g.status==='playing'?Math.max(0,(g.turnEndsAt||0)-now):0;out.winner=g.status==='finished'?Object.entries(g.scores).sort((a,b)=>b[1]-a[1])[0]?.[0]:null;out.spectators=Array.isArray(g.spectators)?g.spectators.length:0;out.isSpectator=Array.isArray(g.spectators)&&g.spectators.includes(username);out.spectatorComments=(g.spectatorComments||[]).slice(-100);out.reactions=(g.reactions||[]).slice(-80);out.roomCode=g.roomCode||null;out.difficulty=g.difficulty||'normal';out.reconnecting=Boolean(g.players?.includes(username)&&g.status==='playing');return out}
function advancePuzzle(g){if(g.status!=='playing')return;g.turnIndex=(g.turnIndex+1)%g.players.length;if(g.turnIndex===0)g.round++;if(g.found.length>=g.words.length){g.status='finished';g.turnStartedAt=null;g.turnEndsAt=null;return}g.turnStartedAt=Date.now();g.turnEndsAt=g.turnStartedAt+15000}
function selectedPuzzleWord(g,start,end){const s=g.placements.find(p=>{const a=p.row*g.size+p.col,b=(p.row+p.dr*(p.word.length-1))*g.size+(p.col+p.dc*(p.word.length-1));return (a===start&&b===end)||(a===end&&b===start)});return s?.word||null}
const server=http.createServer(async(req,res)=>{
  const requestId=id();res.setHeader('X-Request-Id',requestId);
  if(shuttingDown)return send(res,503,{error:'Server is shutting down.'},{'Retry-After':'10'});
  try{
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(!rateLimit(req.socket.remoteAddress||'unknown')) return send(res,429,{error:'Too many requests. Please try again shortly.'},{'Retry-After':'60'});
    if(req.method==='GET' && u.pathname==='/api/health') return send(res,200,{ok:true,version:'40.0.0',status:'healthy',database:'sqlite',uptimeMs:Date.now()-startedAt,time:Date.now()});
    if(req.method==='GET' && u.pathname==='/api/ready'){const ready=Boolean(db&&db.users&&db.profiles);return send(res,ready?200:503,{ok:ready,status:ready?'ready':'not-ready'});}
    if(u.pathname.startsWith('/api/')){
      if(req.method==='POST' && u.pathname==='/api/register'){
        const b=await jsonBody(req);const email=String(b.email||'').trim().toLowerCase();const password=String(b.password||'');const username=String(b.username||'').trim().toLowerCase().replace(/[^a-z0-9_.-]/g,'');
        if(!/^\S+@\S+\.\S+$/.test(email)||!passwordStrong(password)||username.length<3)return send(res,400,{error:'Use a valid email, an 8+ character password and a username of at least 3 characters.'});
        if(db.users[email]||Object.values(db.users).some(x=>x.username===username))return send(res,409,{error:'Email or username already exists.'});
        const ph=await hashPassword(password);db.users[email]={email,username,password:ph,createdAt:Date.now(),emailVerified:false,status:'active'};db.profiles[username]={username,displayName:username,bio:'',avatar:'',createdAt:Date.now()};db.follows[username]=[];const sid=id();db.sessions[sid]={username,createdAt:Date.now(),expiresAt:Date.now()+SESSION_TTL};db.sessionMeta[sid]={username,createdAt:Date.now(),ip:req.socket.remoteAddress||'',ua:req.headers['user-agent']||''};saveDb();return send(res,200,{user:publicUser(username),emailVerified:false},{'Set-Cookie':sessionCookie(sid)});
      }
      if(req.method==='POST' && u.pathname==='/api/login'){
        if(!loginLimit(req.socket.remoteAddress||'unknown')) return send(res,429,{error:'Too many login attempts. Please try again later.'},{'Retry-After':'60'});
        const b=await jsonBody(req);const email=String(b.email||'').trim().toLowerCase();const password=String(b.password||'');const account=db.users[email];if(!account||!(await verifyPassword(password,account.password)))return send(res,401,{error:'Incorrect email or password.'});if(account?.status==='banned')return send(res,403,{error:'This account is banned.'});if(account?.status==='suspended')return send(res,403,{error:'This account is suspended.'});if(REQUIRE_EMAIL_VERIFIED&&!account.emailVerified)return send(res,403,{error:'Please verify your email before signing in.'});const sid=id();db.sessions[sid]={username:account.username,createdAt:Date.now(),expiresAt:Date.now()+SESSION_TTL};db.sessionMeta[sid]={username:account.username,createdAt:Date.now(),ip:req.socket.remoteAddress||'',ua:req.headers['user-agent']||''};saveDb();return send(res,200,{user:publicUser(account.username),emailVerified:Boolean(account.emailVerified)},{'Set-Cookie':sessionCookie(sid)});
      }
      const username=userFrom(req);
      if(req.method==='POST' && u.pathname==='/api/paystack/webhook') {
        if(!PAYSTACK_ENABLED || !PAYSTACK_SECRET_KEY) return send(res,503,{error:'Paystack webhook is not configured.'});
        const raw=await rawBody(req);
        const signature=String(req.headers['x-paystack-signature']||'');
        const expected=crypto.createHmac('sha512',PAYSTACK_SECRET_KEY).update(raw).digest('hex');
        if(!signature || signature.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return send(res,401,{error:'Invalid webhook signature.'});
        let event; try{event=JSON.parse(raw.toString('utf8'));}catch{return send(res,400,{error:'Invalid webhook payload.'});}
        ensureEconomy();
        if(event.event==='charge.success'){
          const data=event.data||{}; const reference=String(data.reference||'');
          const tx=db.transactions.find(x=>x.reference===reference);
          if(tx && tx.type==='coin_purchase' && tx.status!=='completed' && Number(data.amount)===Number(tx.amountKobo) && String(data.currency)===PAYSTACK_CURRENCY){
            tx.status='completed'; tx.providerTransactionId=String(data.id||''); tx.paidAt=Date.now(); tx.webhookEvent='charge.success';
            const wallet=db.wallets[tx.username]||{coins:0,updatedAt:Date.now()}; wallet.coins+=Number(tx.coins||0); wallet.updatedAt=Date.now(); db.wallets[tx.username]=wallet;
            db.coinLedger.push({id:id(),username:tx.username,delta:Number(tx.coins||0),reason:'paystack-purchase',reference:tx.id,createdAt:Date.now()}); saveDb();
          } else if(tx && tx.status==='pending' && (Number(data.amount)!==Number(tx.amountKobo) || String(data.currency)!==PAYSTACK_CURRENCY)){
            tx.status='amount_mismatch'; tx.webhookEvent='charge.success'; saveDb();
          }
        }
        if(String(event.event||'').startsWith('refund.')){
          const data=event.data||{}; const reference=String(data.transaction_reference||data.transaction?.reference||data.reference||'');
          const tx=db.transactions.find(x=>x.reference===reference&&x.type==='coin_purchase');
          if(tx){tx.refundStatus=String(data.status||event.event.replace('refund.',''));tx.refundUpdatedAt=Date.now();if(event.event==='refund.processed')tx.status='refunded';if(event.event==='refund.failed')tx.refundStatus='failed';saveDb();}
        }
        return send(res,200,{ok:true});
      }
      if(req.method==='POST' && u.pathname==='/api/password-reset/request'){
        const b=await jsonBody(req);const email=String(b.email||'').trim().toLowerCase();const account=db.users[email];const token=id()+id();
        if(account){db.tokens[token]={type:'passwordReset',email,expiresAt:Date.now()+15*60*1000};saveDb();}
        const response={ok:true,message:'If that email exists, a reset link has been prepared.'};if(process.env.NODE_ENV!=='production'&&account)response.devToken=token;return send(res,200,response);
      }
      if(req.method==='POST' && u.pathname==='/api/password-reset/confirm'){
        const b=await jsonBody(req);const token=String(b.token||'');const password=String(b.password||'');const t=db.tokens[token];if(!t||t.type!=='passwordReset'||t.expiresAt<Date.now())return send(res,400,{error:'Invalid or expired reset token.'});if(!passwordStrong(password))return send(res,400,{error:`Password must be at least ${PASSWORD_MIN} characters and contain letters and numbers.`});db.users[t.email].password=await hashPassword(password);delete db.tokens[token];for(const [sid,sess] of Object.entries(db.sessions))if((typeof sess==='object'?sess.username:sess)===db.users[t.email].username)delete db.sessions[sid];saveDb();return send(res,200,{ok:true});
      }
      if(req.method==='POST' && u.pathname==='/api/verify-email'){
        const b=await jsonBody(req);const email=String(b.email||'').trim().toLowerCase();const account=db.users[email];if(!account)return send(res,200,{ok:true});const token=id()+id();db.tokens[token]={type:'emailVerify',email,expiresAt:Date.now()+24*60*60*1000};saveDb();return send(res,200,{ok:true,devToken:process.env.NODE_ENV==='production'?undefined:token});
      }
      if(req.method==='POST' && u.pathname==='/api/verify-email/confirm'){
        const b=await jsonBody(req);const t=db.tokens[String(b.token||'')];if(!t||t.type!=='emailVerify'||t.expiresAt<Date.now())return send(res,400,{error:'Invalid or expired verification token.'});if(db.users[t.email])db.users[t.email].emailVerified=true;delete db.tokens[String(b.token||'')];saveDb();return send(res,200,{ok:true});
      }
      if(req.method==='POST' && u.pathname==='/api/logout'){const sid=parseCookies(req).wsm_sid;clearSession(sid);saveDb();return send(res,200,{ok:true},{'Set-Cookie':'wsm_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});}
      if(!username)return send(res,401,{error:'Sign in required.'});
      if(!isAdmin(username) && ['banned','suspended'].includes(accountStatus(username))) return send(res,403,{error:`This account is ${accountStatus(username)}.`});
      if(req.method==='GET' && u.pathname==='/api/events'){
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});retryHint(res); const stopHeartbeat=heartbeat(res); req.on('close',()=>stopHeartbeat());
        res.write(`event: ready\ndata: ${JSON.stringify({username,serverTime:Date.now()})}\n\n`);
        for(const [u,set] of sseClients){if(u!==username) for(const c of set){try{c.write(`event: presence\ndata: ${JSON.stringify({username,online:true})}\n\n`)}catch{}}}
        if(!sseClients.has(username))sseClients.set(username,new Set()); const clients=sseClients.get(username); clients.add(res);
        const keep=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},25000);
        req.on('close',()=>{clearInterval(keep);clients.delete(res);if(!clients.size){sseClients.delete(username);for(const [u,set] of sseClients)for(const c of set){try{c.write(`event: presence\ndata: ${JSON.stringify({username,online:false})}\n\n`)}catch{}}}});
        return;
      }
      if(req.method==='GET' && u.pathname==='/api/ads/config'){return send(res,200,{...AD_CONFIG,slotsConfigured:Object.values(AD_CONFIG.slots).filter(Boolean).length});}
      if(req.method==='GET' && u.pathname==='/ads.txt'){const pub=String(AD_CONFIG.publisherId||'').replace(/^ca-/, '');if(!pub)return send(res,404,'# AdSense publisher ID not configured\n',{ 'Content-Type':'text/plain; charset=utf-8'});return send(res,200,`google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'public, max-age=3600'});}
      if(req.method==='POST' && u.pathname==='/api/ads/impression'){const b=await jsonBody(req);const slot=String(b.slot||'').slice(0,40);if(!slot)return send(res,400,{error:'Missing ad slot.'});db.adMetrics=db.adMetrics||{views:{}};db.adMetrics.views[slot]=(db.adMetrics.views[slot]||0)+1;if(db.adMetrics.views[slot]%100===0)saveDb();return send(res,200,{ok:true});}
      if(req.method==='GET' && u.pathname==='/api/economy'){ensureEconomy(username);const sub=db.subscriptions[username]||null;return send(res,200,{wallet:db.wallets[username],subscription:sub||{tier:'free',name:FREE_MEMBERSHIP.name,priceKobo:0,expiresAt:null},coinPacks:COIN_PACKS,plans:{free:FREE_MEMBERSHIP},rewardedAd:REWARDED_AD});}
      if(req.method==='POST' && u.pathname==='/api/economy/demo-credit'){ensureEconomy(username);const b=await jsonBody(req);const amount=Math.max(1,Math.min(5000,Number(b.coins)||0));db.wallets[username].coins+=amount;db.wallets[username].updatedAt=Date.now();db.coinLedger.push({id:id(),username,delta:amount,reason:'demo-credit',createdAt:Date.now()});db.transactions.push({id:id(),username,type:'demo-credit',status:'completed',amountKobo:0,coins:amount,createdAt:Date.now()});saveDb();return send(res,200,{wallet:db.wallets[username]});}
      if(req.method==='POST' && u.pathname==='/api/economy/reward-ad'){if(!REWARDED_ADS_ENABLED)return send(res,503,{error:'Rewarded ads are temporarily unavailable.'});if(REWARDED_ADS_PROVIDER!=='verified')return send(res,503,{error:'Rewarded ads are in demo mode. Connect a verified rewarded-ad provider before production use.'});ensureEconomy(username);const now=Date.now();const day=new Date(now).toISOString().slice(0,10);const rec=db.adRewards[username]||{day,views:0,lastAt:0};if(rec.day!==day){rec.day=day;rec.views=0;rec.lastAt=0}if(rec.views>=REWARDED_AD.dailyLimit)return send(res,429,{error:`Daily rewarded-ad limit reached (${REWARDED_AD.dailyLimit}). Come back tomorrow.`});if(now-rec.lastAt<REWARDED_AD.cooldownMs)return send(res,429,{error:'Please wait before watching another rewarded ad.'});rec.views++;rec.lastAt=now;db.adRewards[username]=rec;db.wallets[username].coins+=REWARDED_AD.coins;db.wallets[username].updatedAt=now;db.coinLedger.push({id:id(),username,delta:REWARDED_AD.coins,reason:'rewarded-ad',createdAt:now});db.transactions.push({id:id(),username,type:'rewarded-ad',status:'completed',amountKobo:0,coins:REWARDED_AD.coins,createdAt:now});saveDb();return send(res,200,{wallet:db.wallets[username],rewardedAd:{coins:REWARDED_AD.coins,viewsToday:rec.views,dailyLimit:REWARDED_AD.dailyLimit}});}
      if(req.method==='POST' && u.pathname==='/api/economy/checkout'){ensureEconomy(username);const b=await jsonBody(req);const kind=String(b.kind||'');const key=String(b.key||'');if(kind==='subscription')return send(res,400,{error:'Arena Membership is free. No paid platform membership is required.'});const catalog=COIN_PACKS;const item=catalog[key];if(!item)return send(res,400,{error:'Unknown product.'});const account=Object.values(db.users||{}).find(x=>x.username===username);if(!account?.email)return send(res,400,{error:'A valid account email is required for payment.'});const tx={id:id(),username,type:'coin_purchase',product:key,status:'pending',amountKobo:item.priceKobo,coins:item.coins||0,createdAt:Date.now()};if(!PAYSTACK_ENABLED||!PAYSTACK_SECRET_KEY)return send(res,200,{transaction:tx,provider:'not-configured',message:'Paystack is not configured yet.'});const reference=`WSM-${tx.id}`;const payload={email:account.email,amount:item.priceKobo,currency:PAYSTACK_CURRENCY,reference,metadata:{username,transactionId:tx.id,product:key,coins:item.coins},callback_url:APP_BASE_URL?`${APP_BASE_URL}/?payment=success`:undefined};Object.keys(payload).forEach(k=>payload[k]===undefined&&delete payload[k]);const pr=await fetch('https://api.paystack.co/transaction/initialize',{method:'POST',headers:{Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});const pj=await pr.json().catch(()=>({}));if(!pr.ok||!pj.status){return send(res,502,{error:pj.message||'Unable to initialize Paystack payment.'})}tx.provider='paystack';tx.reference=reference;tx.authorizationUrl=pj.data?.authorization_url||'';db.transactions.push(tx);saveDb();return send(res,200,{transaction:tx,provider:'paystack',authorizationUrl:tx.authorizationUrl});}
      if(req.method==='GET' && u.pathname==='/api/economy/verify'){ensureEconomy(username);const ref=String(u.searchParams.get('reference')||'');if(!PAYSTACK_ENABLED||!PAYSTACK_SECRET_KEY)return send(res,400,{error:'Paystack is not configured.'});const tx=db.transactions.find(x=>x.username===username&&x.reference===ref);if(!tx)return send(res,404,{error:'Transaction not found.'});const vr=await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`,{headers:{Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`}});const vj=await vr.json().catch(()=>({}));if(!vr.ok||!vj.status)return send(res,502,{error:vj.message||'Unable to verify payment.'});const data=vj.data||{};if(data.status==='success'&&Number(data.amount)===Number(tx.amountKobo)&&String(data.currency)===PAYSTACK_CURRENCY&&tx.status!=='completed'){tx.status='completed';tx.providerTransactionId=String(data.id||'');tx.paidAt=Date.now();const wallet=db.wallets[username]||{coins:0,updatedAt:Date.now()};wallet.coins+=Number(tx.coins||0);wallet.updatedAt=Date.now();db.wallets[username]=wallet;db.coinLedger.push({id:id(),username,delta:Number(tx.coins||0),reason:'paystack-purchase',reference:tx.id,createdAt:Date.now()});saveDb();}return send(res,200,{transaction:tx,wallet:db.wallets[username],providerStatus:data.status});}
      if(req.method==='GET' && u.pathname==='/api/economy/transactions'){ensureEconomy(username);return send(res,200,{transactions:db.transactions.filter(x=>x.username===username).slice(-100).reverse()});}
      if(req.method==='GET' && u.pathname==='/api/me'){const account=Object.values(db.users).find(x=>x.username===username);return send(res,200,{user:publicUser(username),emailVerified:Boolean(account?.emailVerified),sessions:Object.entries(db.sessionMeta||{}).filter(([sid,x])=>x.username===username).map(([sid,x])=>({id:sid.slice(0,8),createdAt:x.createdAt,ip:x.ip,ua:x.ua,current:sid===parseCookies(req).wsm_sid}))});}
      if(req.method==='GET' && u.pathname==='/api/state')return send(res,200,{state:stateFor(username),user:publicUser(username)});
      if(req.method==='POST' && u.pathname==='/api/change-password'){const b=await jsonBody(req);const old=String(b.currentPassword||'');const next=String(b.newPassword||'');const account=Object.values(db.users).find(x=>x.username===username);if(!account||!(await verifyPassword(old,account.password)))return send(res,401,{error:'Current password is incorrect.'});if(!passwordStrong(next))return send(res,400,{error:`Password must be at least ${PASSWORD_MIN} characters and contain letters and numbers.`});account.password=await hashPassword(next);for(const [sid,sess] of Object.entries(db.sessions)){if((typeof sess==='object'?sess.username:sess)===username)clearSession(sid)}const sid=id();db.sessions[sid]={username,createdAt:Date.now(),expiresAt:Date.now()+SESSION_TTL};db.sessionMeta[sid]={username,createdAt:Date.now(),ip:req.socket.remoteAddress||'',ua:req.headers['user-agent']||''};saveDb();return send(res,200,{ok:true},{'Set-Cookie':sessionCookie(sid)});}
      if(req.method==='POST' && u.pathname==='/api/logout-all'){for(const [sid,sess] of Object.entries(db.sessions))if((typeof sess==='object'?sess.username:sess)===username)clearSession(sid);saveDb();return send(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)});}
      if(req.method==='POST' && u.pathname==='/api/sessions/revoke'){const b=await jsonBody(req);const prefix=String(b.id||'');const current=parseCookies(req).wsm_sid;const found=Object.keys(db.sessionMeta||{}).find(sid=>sid.startsWith(prefix)&&db.sessionMeta[sid].username===username);if(!found)return send(res,404,{error:'Session not found.'});if(found===current)return send(res,400,{error:'Use sign out to end the current session.'});clearSession(found);saveDb();return send(res,200,{ok:true});}
      if(req.method==='POST' && u.pathname.startsWith('/api/users/') && u.pathname.endsWith('/block')){const target=decodeURIComponent(u.pathname.slice('/api/users/'.length,-'/block'.length)).toLowerCase();if(!db.profiles[target]||target===username)return send(res,400,{error:'Invalid user.'});db.blocks[username]=[...new Set([...(db.blocks[username]||[]),target])];saveDb();return send(res,200,{ok:true});}
      if(req.method==='DELETE' && u.pathname.startsWith('/api/users/') && u.pathname.endsWith('/block')){const target=decodeURIComponent(u.pathname.slice('/api/users/'.length,-'/block'.length)).toLowerCase();db.blocks[username]=(db.blocks[username]||[]).filter(x=>x!==target);saveDb();return send(res,200,{ok:true});}
      if(req.method==='GET' && u.pathname==='/api/security/status'){const account=Object.values(db.users).find(x=>x.username===username);return send(res,200,{emailVerified:Boolean(account?.emailVerified),requireEmailVerified:REQUIRE_EMAIL_VERIFIED,passwordMin:PASSWORD_MIN,activeSessions:Object.values(db.sessionMeta||{}).filter(x=>x.username===username).length});}
            if(req.method==='GET' && u.pathname==='/api/stories'){
        const cutoff=Date.now()-24*60*60*1000; db.stories=(db.stories||[]).filter(x=>x.createdAt>cutoff); saveDb();
        return send(res,200,{stories:db.stories.slice().sort((a,b)=>b.createdAt-a.createdAt).slice(0,500)});
      }
      if(req.method==='POST' && u.pathname==='/api/stories'){
        const b=await jsonBody(req); const image=String(b.image||''); const caption=String(b.caption||'').trim();
        if(!image.startsWith('data:image/')) return send(res,400,{error:'A valid image is required.'});
        if(image.length>5*1024*1024) return send(res,413,{error:'Story image is too large. Keep it under about 4 MB.'});
        const story={id:id(),username,caption:caption.slice(0,180),image,createdAt:Date.now(),expiresAt:Date.now()+24*60*60*1000,views:[]};
        db.stories=db.stories||[]; db.stories.push(story); db.stories=db.stories.slice(-500); saveDb();
        return send(res,200,{story});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/stories/') && u.pathname.endsWith('/view')){
        const sid=u.pathname.split('/')[3]; const story=(db.stories||[]).find(x=>x.id===sid);
        if(!story||story.expiresAt<Date.now()) return send(res,404,{error:'Story expired or not found.'});
        story.views=[...new Set([...(story.views||[]),username])]; saveDb(); return send(res,200,{ok:true,views:story.views.length});
      }

      if(req.method==='POST' && u.pathname==='/api/comments'){
        const b=await jsonBody(req);const memoryId=String(b.memoryId||'');const text=String(b.text||'').trim();if(!memoryId||!text||text.length>500)return send(res,400,{error:'A memory and comment up to 500 characters are required.'});const m=db.memories.find(x=>x.id===memoryId);if(!m)return send(res,404,{error:'Memory not found.'});const c={id:id(),memoryId,username,text,createdAt:Date.now()};db.comments.push(c);db.comments=db.comments.slice(-2000);if(m.username!==username){const notification={id:id(),username:m.username,type:'comment',value:text.slice(0,80),createdAt:Date.now(),read:false};db.notifications.unshift(notification);saveDb();broadcast(m.username,'notification',notification);broadcast(m.username,'comment',c);}else saveDb();return send(res,200,{comment:c});
      }
      if(req.method==='POST' && u.pathname==='/api/friend-requests'){
        const b=await jsonBody(req);const to=String(b.to||'').trim().toLowerCase();if(blocked(username,to))return send(res,403,{error:'You cannot interact with this user.'});if(!db.profiles[to]||to===username)return send(res,400,{error:'Invalid recipient.'});const existing=db.friendRequests.find(r=>((r.from===username&&r.to===to)||(r.from===to&&r.to===username))&&r.status==='pending');if(existing)return send(res,409,{error:'A pending request already exists.'});const r={id:id(),from:username,to,status:'pending',createdAt:Date.now()};db.friendRequests.push(r);const notification={id:id(),username:to,type:'friend',value:username,createdAt:Date.now(),read:false};db.notifications.unshift(notification);saveDb();broadcast(to,'notification',notification);broadcast(to,'friendRequest',r);return send(res,200,{request:r});
      }
      if(req.method==='PUT' && u.pathname.startsWith('/api/friend-requests/')){
        const rid=u.pathname.split('/').pop();const b=await jsonBody(req);const r=db.friendRequests.find(x=>x.id===rid);if(!r||r.to!==username)return send(res,404,{error:'Request not found.'});if(!['accepted','declined'].includes(b.status))return send(res,400,{error:'Invalid request status.'});r.status=b.status;r.updatedAt=Date.now();if(b.status==='accepted'){db.follows[username]=[...new Set([...(db.follows[username]||[]),r.from])];db.follows[r.from]=[...new Set([...(db.follows[r.from]||[]),username])];const notification={id:id(),username:r.from,type:'friendAccepted',value:username,createdAt:Date.now(),read:false};db.notifications.unshift(notification);broadcast(r.from,'notification',notification)}saveDb();return send(res,200,{request:r});
      }
      /* v22 — private room codes and recovery */
      if(req.method==='POST' && u.pathname==='/api/puzzle/join-code'){const b=await jsonBody(req);const code=String(b.code||'').trim().toUpperCase();const g=Object.values(db.puzzleGames||{}).find(x=>x.roomCode===code&&['lobby','playing'].includes(x.status));if(!g)return send(res,404,{error:'Puzzle room not found or already finished.'});if(g.players.includes(username))return send(res,200,{game:safePuzzle(g,username)});if(g.players.length>=5)return send(res,409,{error:'This game already has 5 players. You can still watch if you are a friend of a player.'});if(!areFriends(username,g.host))return send(res,403,{error:'You must be friends with the host to join this private game.'});g.players.push(username);g.invited.push(username);g.updatedAt=Date.now();const n={id:id(),username,type:'puzzleInvite',value:g.id,createdAt:Date.now(),read:false};db.notifications.unshift(n);saveDb();broadcast(username,'puzzleInvite',n);return send(res,200,{game:safePuzzle(g,username)});}
      if(req.method==='POST' && u.pathname==='/api/puzzle/resume'){const active=Object.values(db.puzzleGames||{}).filter(g=>g.status==='playing'&&g.players.includes(username)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,10);for(const g of active){g.lastSeen=g.lastSeen||{};g.lastSeen[username]=Date.now();if(g.turnEndsAt<=Date.now())advancePuzzle(g)}saveDb();return send(res,200,{games:active.map(g=>safePuzzle(g,username))});}
      /* v15 — multiplayer 50-word turn-based puzzle */
      if(req.method==='POST' && u.pathname==='/api/puzzle/create'){
        const b=await jsonBody(req); const invited=[...new Set((Array.isArray(b.invited)?b.invited:[]).map(x=>String(x).trim().toLowerCase()).filter(Boolean).filter(x=>x!==username))];
        if(invited.length<1 || invited.length>4) return send(res,400,{error:'Choose 1 to 4 friends. A game has 2 to 5 players total.'});
        if(invited.some(x=>!db.profiles[x])) return send(res,400,{error:'One or more invited usernames do not exist.'});
        const players=[username,...invited];
        const difficulty=['easy','normal','hard'].includes(String(b.difficulty))?String(b.difficulty):'normal';
        const wordBank=['AFRICA','APPLE','BEACH','BASKET','BREAD','BRIDGE','CAMERA','CANDLE','CHAIR','CLOUD','COFFEE','COMPUTER','DANCE','DESERT','DIAMOND','EAGLE','EARTH','ENGINE','FAMILY','FIRE','FLOWER','FOREST','FRIEND','GARDEN','GUITAR','HAMMER','HEART','ISLAND','JACKET','JOURNEY','KITCHEN','LADDER','LEMON','MARKET','MIRROR','MOUNTAIN','MUSIC','OCEAN','ORANGE','PALACE','PENCIL','PLANET','RAINBOW','RIVER','SCHOOL','SILVER','SMILE','SUMMER','THUNDER','WINDOW','KINGDOM','SUNSET','TRAVEL','VICTORY','WATER','STAR','LIGHT','PUZZLE','PLAYER','SUPPORT','WINNER','LEGACY','TIGER','LION','HORSE','MANGO','BANANA','PAPAYA','NATURE','GROWTH','ENERGY','VISION','BRAVE','UNITY','PEACE','POWER','CROWN','GOLD','RHYTHM','STORY','MEMORY','FUTURE','CREATE','LEARN','FOCUS','SPEED','SHARE','LAUGH','DREAM','GOAL','CHAMPION','LEVEL','QUEST','ARENA','SPARK','TALENT','GIFT','WORLD','HOME','VOICE'];
        const words=[...wordBank].sort(()=>Math.random()-.5).slice(0,50);
        function makeGrid(words){const size=difficulty==='easy'?18:difficulty==='hard'?20:18;const g=Array.from({length:size},()=>Array(size).fill(''));const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];const placed=[];const can=(w,r,c,dr,dc)=>{for(let i=0;i<w.length;i++){const rr=r+dr*i,cc=c+dc*i;if(rr<0||rr>=size||cc<0||cc>=size)return false;if(g[rr][cc]&&g[rr][cc]!==w[i])return false}return true};const put=(w)=>{for(let tries=0;tries<400;tries++){const d=dirs[Math.floor(Math.random()*dirs.length)],r=Math.floor(Math.random()*size),c=Math.floor(Math.random()*size);if(can(w,r,c,d[0],d[1])){for(let i=0;i<w.length;i++)g[r+d[0]*i][c+d[1]*i]=w[i];placed.push({word:w,row:r,col:c,dr:d[0],dc:d[1]});return true}}return false};[...words].sort((a,b)=>b.length-a.length).forEach(put);const letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ';for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(!g[r][c])g[r][c]=letters[Math.floor(Math.random()*letters.length)];return {size,grid:g.flat(),placements:placed}}
        let puzzle=makeGrid(words); if(puzzle.placements.length<50){for(let attempt=0;attempt<8&&puzzle.placements.length<50;attempt++)puzzle=makeGrid(words)} const gameId=id(); let roomCode=puzzleRoomCode(); while(Object.values(db.puzzleGames||{}).some(g=>g.roomCode===roomCode))roomCode=puzzleRoomCode(); const game={id:gameId,roomCode,difficulty,players,invited,accepted:[username],host:username,status:'lobby',words,grid:puzzle.grid,size:puzzle.size,placements:puzzle.placements,found:[],scores:Object.fromEntries(players.map(p=>[p,0])),turnIndex:0,round:1,createdAt:Date.now(),updatedAt:Date.now(),turnStartedAt:null,turnEndsAt:null,spectators:[],spectatorComments:[],lastSeen:Object.fromEntries(players.map(p=>[p,Date.now()]))};db.puzzleGames[gameId]=game;
        for(const to of invited){const n={id:id(),username:to,type:'puzzleInvite',value:gameId,createdAt:Date.now(),read:false};db.notifications.unshift(n);broadcast(to,'puzzleInvite',n)} saveDb(); return send(res,200,{game:safePuzzle(game,username)});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/puzzle/') && u.pathname.endsWith('/respond')){
        const gameId=u.pathname.split('/')[3]; const b=await jsonBody(req);const g=db.puzzleGames[gameId];if(!g||!g.players.includes(username))return send(res,404,{error:'Game not found.'});if(!g.invited.includes(username))return send(res,403,{error:'You are not an invited player.'});const accept=b.accept!==false;if(accept&&!g.accepted.includes(username))g.accepted.push(username);if(!accept){g.players=g.players.filter(x=>x!==username);g.invited=g.invited.filter(x=>x!==username)}g.updatedAt=Date.now();saveDb();broadcast(g.host,'puzzleUpdate',{gameId});return send(res,200,{game:safePuzzle(g,username)});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/puzzle/') && u.pathname.endsWith('/start')){
        const gameId=u.pathname.split('/')[3];const g=db.puzzleGames[gameId];if(!g||g.host!==username)return send(res,403,{error:'Only the host can start the game.'});if(g.accepted.length<2)return send(res,400,{error:'At least 2 players must accept the invitation.'});g.players=g.accepted.slice(0,5);g.status='playing';g.turnIndex=0;g.round=1;g.turnStartedAt=Date.now();g.turnEndsAt=g.turnStartedAt+15000;g.lastSeen=g.lastSeen||{};for(const p of g.players)g.lastSeen[p]=Date.now();g.updatedAt=Date.now();saveDb();for(const p of g.players)broadcast(p,'puzzleUpdate',{gameId});const friendSet=new Set();for(const p of g.players){for(const f of (db.follows[p]||[])){if(!g.players.includes(f)&&areFriends(p,f))friendSet.add(f)}}for(const f of friendSet){const n={id:id(),username:f,type:'livePuzzle',value:gameId,actor:username,createdAt:Date.now(),read:false};db.notifications.unshift(n);broadcast(f,'livePuzzle',n)}saveDb();return send(res,200,{game:safePuzzle(g,username)});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/puzzle/') && u.pathname.endsWith('/rematch')){
        const oldId=u.pathname.split('/')[3]; const old=db.puzzleGames[oldId]; if(!old||old.status!=='finished')return send(res,400,{error:'Only finished games can be rematched.'});
        if(!old.players.includes(username))return send(res,403,{error:'Only a player from the finished game can create a rematch.'});
        const players=old.players.slice(0,5); const words=old.words.slice();
        function makeGrid(words){const size=18,g=Array.from({length:size},()=>Array(size).fill(''));const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],placed=[];const can=(w,r,c,dr,dc)=>{for(let i=0;i<w.length;i++){const rr=r+dr*i,cc=c+dc*i;if(rr<0||rr>=size||cc<0||cc>=size)return false;if(g[rr][cc]&&g[rr][cc]!==w[i])return false}return true};for(const w of [...words].sort((a,b)=>b.length-a.length)){let ok=false;for(let tries=0;tries<500&&!ok;tries++){const d=dirs[Math.floor(Math.random()*dirs.length)],r=Math.floor(Math.random()*size),c=Math.floor(Math.random()*size);if(can(w,r,c,d[0],d[1])){for(let i=0;i<w.length;i++)g[r+d[0]*i][c+d[1]*i]=w[i];placed.push({word:w,row:r,col:c,dr:d[0],dc:d[1]});ok=true}}}const letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ';for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(!g[r][c])g[r][c]=letters[Math.floor(Math.random()*letters.length)];return{size,grid:g.flat(),placements:placed}}
        const puzzle=makeGrid(words),gameId=id(); const game={id:gameId,players,invited:players.filter(x=>x!==username),accepted:players,host:username,status:'lobby',words,grid:puzzle.grid,size:puzzle.size,placements:puzzle.placements,found:[],scores:Object.fromEntries(players.map(x=>[x,0])),turnIndex:0,round:1,createdAt:Date.now(),updatedAt:Date.now(),turnStartedAt:null,turnEndsAt:null,spectators:[],spectatorComments:[],reactions:[],rematchOf:oldId}; db.puzzleGames[gameId]=game;
        for(const to of game.invited){const n={id:id(),username:to,type:'puzzleInvite',value:gameId,createdAt:Date.now(),read:false};db.notifications.unshift(n);broadcast(to,'puzzleInvite',n)} saveDb(); return send(res,200,{game:safePuzzle(game,username)});
      }
      if(req.method==='GET' && u.pathname==='/api/puzzle/live'){
        const live=Object.values(db.puzzleGames||{}).filter(g=>g.status==='playing' && g.players.some(p=>areFriends(username,p)) && !g.players.includes(username)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,20);
        return send(res,200,{games:live.map(g=>safePuzzle(g,username))});
      }
      if(req.method==='GET' && u.pathname==='/api/puzzle/leaderboard'){
        const totals={};
        for(const g of Object.values(db.puzzleGames||{})){
          if(g.status!=='finished') continue;
          for(const p of (g.players||[])){
            totals[p]=totals[p]||{username:p,games:0,wins:0,words:0};
            totals[p].games++;
            totals[p].words+=Number(g.scores?.[p]||0);
          }
          const max=Math.max(...Object.values(g.scores||{}).map(Number),0);
          for(const p of (g.players||[])) if(Number(g.scores?.[p]||0)===max && max>0) totals[p].wins++;
        }
        const rows=Object.values(totals).sort((a,b)=>b.wins-a.wins||b.words-a.words||b.games-a.games).slice(0,25);
        return send(res,200,{leaderboard:rows});
      }
      if(req.method==='GET' && u.pathname==='/api/puzzle/history'){
        const games=Object.values(db.puzzleGames||{}).filter(g=>g.status==='finished' && g.players?.includes(username)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,30);
        return send(res,200,{games:games.map(g=>safePuzzle(g,username))});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/puzzle/') && u.pathname.endsWith('/spectate')){
        const gameId=u.pathname.split('/')[3];const g=db.puzzleGames[gameId];if(!g||g.status!=='playing')return send(res,404,{error:'Live game not found.'});
        if(g.players.includes(username))return send(res,400,{error:'Players cannot join as spectators.'});
        if(!g.players.some(p=>areFriends(username,p)))return send(res,403,{error:'Only friends of a player can spectate this game.'});
        g.spectators=g.spectators||[];if(!g.spectators.includes(username))g.spectators.push(username);g.updatedAt=Date.now();saveDb();for(const p of g.players)broadcast(p,'puzzleSpectator',{gameId,username,action:'join'});return send(res,200,{game:safePuzzle(g,username)});
      }
      if(req.method==='DELETE' && u.pathname.startsWith('/api/puzzle/') && u.pathname.endsWith('/spectate')){
        const gameId=u.pathname.split('/')[3];const g=db.puzzleGames[gameId];if(!g)return send(res,404,{error:'Game not found.'});g.spectators=(g.spectators||[]).filter(x=>x!==username);g.updatedAt=Date.now();saveDb();for(const p of g.players)broadcast(p,'puzzleSpectator',{gameId,username,action:'leave'});return send(res,200,{game:safePuzzle(g,username)});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/puzzle/') && u.pathname.endsWith('/react')){
        const gameId=u.pathname.split('/')[3];const g=db.puzzleGames[gameId];const b=await jsonBody(req);const reaction=String(b.reaction||'').trim();const allowed=['❤️','🔥','😂','👏','💪'];if(!g||!['playing','finished'].includes(g.status))return send(res,404,{error:'Game not found.'});if(!g.players.includes(username)&&!(g.spectators||[]).includes(username))return send(res,403,{error:'Join the live game to react.'});if(!allowed.includes(reaction))return send(res,400,{error:'Unsupported reaction.'});g.reactions=g.reactions||[];g.reactions.push({id:id(),username,reaction,createdAt:Date.now()});g.reactions=g.reactions.slice(-300);g.updatedAt=Date.now();saveDb();for(const p of g.players)broadcast(p,'puzzleReaction',{gameId,reaction,username});for(const sp of (g.spectators||[]))broadcast(sp,'puzzleReaction',{gameId,reaction,username});return send(res,200,{ok:true,reaction});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/puzzle/') && u.pathname.endsWith('/comment')){
        const gameId=u.pathname.split('/')[3];const g=db.puzzleGames[gameId];const b=await jsonBody(req);const text=String(b.text||'').trim();if(!g||!['playing','finished'].includes(g.status))return send(res,404,{error:'Game not found.'});if(!g.players.includes(username)&&!(g.spectators||[]).includes(username))return send(res,403,{error:'Join the live game to comment.'});if(!text||text.length>300)return send(res,400,{error:'Comment must be 1–300 characters.'});const c={id:id(),username,text,createdAt:Date.now()};g.spectatorComments=g.spectatorComments||[];g.spectatorComments.push(c);g.spectatorComments=g.spectatorComments.slice(-100);g.updatedAt=Date.now();saveDb();for(const p of g.players)broadcast(p,'puzzleComment',{gameId,comment:c});for(const s of (g.spectators||[]))broadcast(s,'puzzleComment',{gameId,comment:c});return send(res,200,{comment:c});
      }
      if(req.method==='GET' && u.pathname==='/api/puzzle/games'){
        const games=Object.values(db.puzzleGames||{}).filter(g=>g.players.includes(username)||g.invited.includes(username)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,30);return send(res,200,{games:games.map(g=>safePuzzle(g,username))});
      }
      /* v20 — Puzzle Arena: daily challenges, XP, badges, streaks, head-to-head records */
      function dailySeedWords(day){
        const bank=(db.wordBank&&db.wordBank.length?db.wordBank:['AFRICA','APPLE','BEACH','BASKET','BREAD','BRIDGE','CAMERA','CANDLE','CHAIR','CLOUD','COFFEE','COMPUTER','DANCE','DESERT','DIAMOND','EAGLE','EARTH','ENGINE','FAMILY','FIRE','FLOWER','FOREST','FRIEND','GARDEN','GUITAR','HAMMER','HEART','ISLAND','JACKET','JOURNEY','KITCHEN','LADDER','LEMON','MARKET','MIRROR','MOUNTAIN','MUSIC','OCEAN','ORANGE','PALACE','PENCIL','PLANET','RAINBOW','RIVER','SCHOOL','SILVER','SMILE','SUMMER','THUNDER','WINDOW','KINGDOM','SUNSET','TRAVEL','VICTORY','WATER','STAR','LIGHT','PUZZLE','PLAYER','SUPPORT','WINNER','LEGACY','TIGER','LION','HORSE','MANGO','BANANA','PAPAYA','NATURE','GROWTH','ENERGY','VISION','BRAVE','UNITY','PEACE','POWER','CROWN','GOLD','RHYTHM','STORY','MEMORY','FUTURE','FRIENDS','CREATE','LEARN','FOCUS','SPEED','SHARE','LAUGH','DREAM','GOAL','CHAMPION','LEVEL','QUEST','ARENA','SPARK','TALENT','GIFT','WORLD','HOME','VOICE','HEARTBEAT']).map(String).map(x=>x.toUpperCase()).filter(x=>/^[A-Z]{2,16}$/.test(x));
        let n=0;for(const ch of day)n=(n*31+ch.charCodeAt(0))>>>0;
        const out=[];while(out.length<10){n=(n*1664525+1013904223)>>>0;const w=bank[n%bank.length];if(!out.includes(w))out.push(w)}return out;
      }
      function buildDailyGrid(words){
        const size=15,g=Array.from({length:size},()=>Array(size).fill(''));const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],placed=[];
        let seed=0;for(const w of words)for(const ch of w)seed=(seed*33+ch.charCodeAt(0))>>>0;
        const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
        const can=(w,r,c,dr,dc)=>{for(let i=0;i<w.length;i++){const rr=r+dr*i,cc=c+dc*i;if(rr<0||rr>=size||cc<0||cc>=size)return false;if(g[rr][cc]&&g[rr][cc]!==w[i])return false}return true};
        for(const w of [...words].sort((a,b)=>b.length-a.length)){let done=false;for(let t=0;t<500&&!done;t++){const d=dirs[Math.floor(rnd()*dirs.length)],r=Math.floor(rnd()*size),c=Math.floor(rnd()*size);if(can(w,r,c,d[0],d[1])){for(let i=0;i<w.length;i++)g[r+d[0]*i][c+d[1]*i]=w[i];placed.push({word:w,row:r,col:c,dr:d[0],dc:d[1]});done=true}}}
        const letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ';for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(!g[r][c])g[r][c]=letters[Math.floor(rnd()*letters.length)];return {size,grid:g.flat(),placements:placed};
      }
      function todayKey(){const d=new Date();return d.toISOString().slice(0,10)}
      function arenaStats(username){
        let xp=0,games=0,wins=0,words=0;
        for(const g of Object.values(db.puzzleGames||{})){if(g.status!=='finished'||!g.players?.includes(username))continue;games++;const score=Number(g.scores?.[username]||0);words+=score;xp+=score*10;const max=Math.max(...Object.values(g.scores||{}).map(Number),0);if(score===max&&score>0){wins++;xp+=100}}
        const daily=db.dailyPuzzleAttempts[username]||{};for(const a of Object.values(daily)){words+=Number(a.score||0);xp+=Number(a.score||0)*10}
        const level=Math.max(1,Math.floor(xp/250)+1),into=xp%250;const badges=[];if(games>=1)badges.push('🎯 First Game');if(wins>=1)badges.push('🏆 First Win');if(words>=25)badges.push('🔤 Word Hunter');if(words>=100)badges.push('📚 Word Master');if(wins>=10)badges.push('👑 Champion');if((daily[todayKey()]?.streak||0)>=3)badges.push('🔥 3-Day Streak');return {username,xp,level,games,wins,words,badges,levelProgress:into/250,streak:Number(daily.currentStreak||0)};
      }
      if(req.method==='GET' && u.pathname==='/api/puzzle/arena'){
        const key=todayKey();const words=dailySeedWords(key),puzzle=buildDailyGrid(words),attempt=db.dailyPuzzleAttempts[username]?.[key]||null;return send(res,200,{date:key,words,puzzle:{size:puzzle.size,grid:puzzle.grid,placements:puzzle.placements},attempt,stats:arenaStats(username)});
      }
      if(req.method==='POST' && u.pathname==='/api/puzzle/arena/submit'){
        const b=await jsonBody(req),key=todayKey(),score=Math.max(0,Math.min(10,Number(b.score)||0));db.dailyPuzzleAttempts[username]=db.dailyPuzzleAttempts[username]||{};if(db.dailyPuzzleAttempts[username][key])return send(res,409,{error:'You already completed today’s challenge.',attempt:db.dailyPuzzleAttempts[username][key],stats:arenaStats(username)});
        const priorDates=Object.keys(db.dailyPuzzleAttempts[username]).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort();let streak=1;if(priorDates.length){const last=priorDates[priorDates.length-1],ld=new Date(last+'T00:00:00Z'),td=new Date(key+'T00:00:00Z');if(Math.round((td-ld)/86400000)===1)streak=Number(db.dailyPuzzleAttempts[username].currentStreak||1)+1}
        const attempt={date:key,score,streak,completedAt:Date.now()};db.dailyPuzzleAttempts[username][key]=attempt;db.dailyPuzzleAttempts[username].currentStreak=streak;saveDb();return send(res,200,{attempt,stats:arenaStats(username)});
      }
      /* v33 — AI-Powered Player Experience */
      function playerAiProfile(user){
        const stats=arenaStats(user), daily=db.dailyPuzzleAttempts[user]||{}; const scores=Object.values(daily).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)).map(x=>Number(x.score||0));
        const recent=scores.slice(-7), avg=recent.length?recent.reduce((a,b)=>a+b,0)/recent.length:0;
        const games=Object.values(db.puzzleGames||{}).filter(g=>g.status==='finished'&&g.players?.includes(user));
        const avgWords=games.length?games.slice(-10).reduce((n,g)=>n+Number(g.scores?.[user]||0),0)/Math.min(games.length,10):0;
        const difficulty=avg>=8||avgWords>=8?'hard':avg>=5||avgWords>=4?'normal':'easy';
        const focus=avg<5?'accuracy':avgWords<4?'word finding':stats.streak<3?'consistency':'speed';
        return {level:stats.level,xp:stats.xp,streak:stats.streak,avgDaily:Number(avg.toFixed(1)),avgWords:Number(avgWords.toFixed(1)),recommendedDifficulty:difficulty,focus};
      }
      function playerRecommendations(user){
        const p=playerAiProfile(user), rec=[];
        rec.push(p.recommendedDifficulty==='hard'?'Try Hard challenges to stretch your current level.':p.recommendedDifficulty==='normal'?'Normal challenges should provide a balanced challenge for you.':'Start with Easy challenges and build accuracy before increasing difficulty.');
        if(p.streak<3)rec.push('Play today and return tomorrow to build a longer streak.'); else rec.push(`Your ${p.streak}-day streak is active — keep it going.`);
        if(p.focus==='accuracy')rec.push('Slow down on selections and verify both endpoints before submitting a word.');
        else if(p.focus==='word finding')rec.push('Scan for short words first, then look for longer diagonal and vertical words.');
        else if(p.focus==='speed')rec.push('Use your first scan to identify likely long words, then work quickly through the board.');
        else rec.push('Keep your current rhythm and challenge friends with similar scores.');
        return rec;
      }
      function coachMessage(user,context){
        const p=playerAiProfile(user), c=String(context||'').toLowerCase();
        if(c.includes('stuck')) return p.focus==='accuracy'?'Try a shorter word and scan horizontally first.':'Look for long words along the diagonals; overlapping letters can reveal another word.';
        if(c.includes('win')) return 'Nice result. Review the words you missed and repeat the same scanning pattern next game.';
        if(c.includes('lose')) return 'Use the next game to improve one thing only: accuracy, speed, or scanning. Small gains compound.';
        return `Your current focus is ${p.focus}. ${p.recommendedDifficulty==='hard'?'You can try a harder challenge.':'Choose a challenge close to your current level.'}`;
      }
      if(req.method==='GET' && u.pathname==='/api/player/ai/profile') return send(res,200,{profile:playerAiProfile(username),recommendations:playerRecommendations(username)});
      if(req.method==='GET' && u.pathname==='/api/player/ai/recommendations'){
        const p=playerAiProfile(username), published=db.creatorPacks.filter(x=>x.status==='published').slice().sort((a,b)=>Number(b.views||0)+Number(b.sales||0)*5-(Number(a.views||0)+Number(a.sales||0)*5)).slice(0,6);
        return send(res,200,{profile:p,recommendations:playerRecommendations(username),packs:published.map(x=>({id:x.id,title:x.title,category:x.category,difficulty:x.difficulty,priceCoins:x.priceCoins,views:x.views||0,sales:x.sales||0,creator:x.creator}))});
      }
      if(req.method==='POST' && u.pathname==='/api/player/ai/coach'){
        const b=await jsonBody(req),message=coachMessage(username,b.context);db.playerCoachHistory=Array.isArray(db.playerCoachHistory)?db.playerCoachHistory:[];db.playerCoachHistory.push({id:id(),username,context:String(b.context||'general').slice(0,80),message,createdAt:Date.now()});db.playerCoachHistory=db.playerCoachHistory.slice(-5000);saveDb();return send(res,200,{message});
      }
      if(req.method==='GET' && u.pathname==='/api/player/ai/insights'){
        const p=playerAiProfile(username),daily=db.dailyPuzzleAttempts[username]||{},days=Object.values(daily).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)).slice(-14), games=Object.values(db.puzzleGames||{}).filter(g=>g.status==='finished'&&g.players?.includes(username)).slice(-20);
        const bestDaily=days.reduce((m,x)=>Math.max(m,Number(x.score||0)),0), bestGame=games.reduce((m,g)=>Math.max(m,Number(g.scores?.[username]||0)),0);
        return send(res,200,{profile:p,insights:[`Average daily score: ${p.avgDaily}/10`,`Average multiplayer words: ${p.avgWords}`,`Best recent daily score: ${bestDaily}/10`,`Best recent multiplayer score: ${bestGame} words`,`Recommended difficulty: ${p.recommendedDifficulty}`,`Primary focus: ${p.focus}`],recentDaily:days});
      }
      if(req.method==='GET' && u.pathname==='/api/player/matchmaking'){
        db.matchmaking=db.matchmaking||{};const q=Object.values(db.matchmaking).filter(x=>x.status==='waiting');const mine=db.matchmaking[username]||null;return send(res,200,{mine,queue:q.length,players:q.map(x=>x.username).slice(0,20)});
      }
      if(req.method==='POST' && u.pathname==='/api/player/matchmaking/join'){
        const b=await jsonBody(req),difficulty=['easy','normal','hard'].includes(b.difficulty)?b.difficulty:'normal';db.matchmaking=db.matchmaking||{};const existing=db.matchmaking[username];if(existing?.status==='waiting')return send(res,200,{status:'waiting',match:existing});
        const opponent=Object.values(db.matchmaking).find(x=>x.status==='waiting'&&x.username!==username&&x.difficulty===difficulty);if(opponent){const players=[opponent.username,username],words=dailySeedWords(todayKey()).slice(0,Math.min(10,difficulty==='hard'?10:difficulty==='normal'?8:6));const puzzle=buildDailyGrid(words),gameId=id();const game={id:gameId,players,invited:[],accepted:players,host:opponent.username,status:'playing',words,grid:puzzle.grid,size:puzzle.size,placements:puzzle.placements,found:[],scores:Object.fromEntries(players.map(x=>[x,0])),turnIndex:0,round:1,createdAt:Date.now(),updatedAt:Date.now(),turnStartedAt:Date.now(),turnEndsAt:Date.now()+15000,spectators:[],spectatorComments:[],reactions:[],roomCode:puzzleRoomCode(),difficulty};db.puzzleGames[gameId]=game;delete db.matchmaking[opponent.username];delete db.matchmaking[username];saveDb();for(const p of players)broadcast(p,'matchFound',{gameId});return send(res,200,{status:'matched',game:safePuzzle(game,username)});}
        db.matchmaking[username]={username,difficulty,status:'waiting',createdAt:Date.now()};saveDb();return send(res,200,{status:'waiting',queue:Object.keys(db.matchmaking).length});
      }
      if(req.method==='POST' && u.pathname==='/api/player/matchmaking/leave'){db.matchmaking=db.matchmaking||{};delete db.matchmaking[username];saveDb();return send(res,200,{ok:true});}
      if(req.method==='GET' && u.pathname==='/api/puzzle/season'){
        const season=todayKey().slice(0,7),totals={};for(const g of Object.values(db.puzzleGames||{})){if(g.status!=='finished'||new Date(g.updatedAt||0).toISOString().slice(0,7)!==season)continue;for(const p of g.players||[]){const x=totals[p]||(totals[p]={username:p,points:0,wins:0,words:0});const score=Number(g.scores?.[p]||0);x.words+=score;x.points+=score*10;const max=Math.max(...Object.values(g.scores||{}).map(Number),0);if(score===max&&score>0){x.wins++;x.points+=100}}}
        const rows=Object.values(totals).sort((a,b)=>b.points-a.points||b.wins-a.wins||b.words-a.words).slice(0,50);return send(res,200,{season,leaderboard:rows});
      }
      if(req.method==='GET' && u.pathname==='/api/puzzle/records'){
        const target=String(u.searchParams.get('with')||'').trim().toLowerCase();if(!target||!db.profiles[target])return send(res,400,{error:'Choose a valid friend.'});let a={games:0,wins:0,words:0},b={games:0,wins:0,words:0};for(const g of Object.values(db.puzzleGames||{})){if(g.status!=='finished'||!g.players?.includes(username)||!g.players?.includes(target))continue;const sa=Number(g.scores?.[username]||0),sb=Number(g.scores?.[target]||0);a.games++;b.games++;a.words+=sa;b.words+=sb;if(sa>sb)a.wins++;else if(sb>sa)b.wins++}return send(res,200,{with:target,you:a,friend:b});
      }
      if(req.method==='GET' && u.pathname==='/api/puzzle/profile') return send(res,200,{stats:arenaStats(username)});
      if(req.method==='GET' && u.pathname.startsWith('/api/puzzle/')){
        const gameId=u.pathname.split('/')[3];const g=db.puzzleGames[gameId];if(!g||(!g.players.includes(username)&&!(g.spectators||[]).includes(username)))return send(res,404,{error:'Game not found.'});if(g.players.includes(username)){g.lastSeen=g.lastSeen||{};g.lastSeen[username]=Date.now()}if(g.status==='playing'&&g.turnEndsAt<Date.now()){advancePuzzle(g);saveDb()}return send(res,200,{game:safePuzzle(g,username)});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/puzzle/') && u.pathname.endsWith('/find')){
        const gameId=u.pathname.split('/')[3];const b=await jsonBody(req);const g=db.puzzleGames[gameId];if(!g||!g.players.includes(username))return send(res,404,{error:'Game not found.'});if(g.status!=='playing')return send(res,400,{error:'This game is not currently playing.'});if(g.turnEndsAt<=Date.now()){advancePuzzle(g);saveDb();return send(res,409,{error:'Time is up. The turn has moved to the next player.',game:safePuzzle(g,username)})};const active=g.players[g.turnIndex];if(active!==username)return send(res,409,{error:`It is @${active}'s turn.`,game:safePuzzle(g,username)});const a=Number(b.start),z=Number(b.end);if(!Number.isInteger(a)||!Number.isInteger(z)||a<0||z>=g.grid.length)return send(res,400,{error:'Invalid selection.'});const wordFromSelection=selectedPuzzleWord(g,a,z);if(!wordFromSelection)return send(res,400,{error:'That selection is not one of the hidden words.'});if(g.found.some(x=>x.word===wordFromSelection))return send(res,400,{error:'That word has already been found.'});g.found.push({word:wordFromSelection,username,round:g.round,createdAt:Date.now()});g.scores[username]=(g.scores[username]||0)+1;advancePuzzle(g);saveDb();for(const p of g.players)broadcast(p,'puzzleUpdate',{gameId});return send(res,200,{ok:true,word:wordFromSelection,game:safePuzzle(g,username)});
      }
      if(req.method==='POST' && u.pathname==='/api/messages'){
        const b=await jsonBody(req);const to=String(b.to||'').trim().toLowerCase();const text=String(b.text||'').trim();const kind=String(b.kind||'text');const data=String(b.data||'');if(!db.profiles[to]||blocked(username,to)||((!text)&&(!data))||text.length>2000||data.length>6*1024*1024||!['text','image','audio'].includes(kind))return send(res,400,{error:'Recipient and a valid message are required.'});const m={id:id(),from:username,to,text,kind,data,createdAt:Date.now(),read:false};db.messages.push(m);db.messages=db.messages.slice(-5000);const notification={id:id(),username:to,type:'message',value:username,createdAt:Date.now(),read:false};db.notifications.unshift(notification);saveDb();broadcast(to,'notification',notification);broadcast(to,'message',m);return send(res,200,{message:m});
      }
      if(req.method==='POST' && u.pathname==='/api/messages/typing'){const b=await jsonBody(req);const to=String(b.to||'').trim().toLowerCase();if(db.profiles[to]){broadcast(to,'typing',{from:username,typing:Boolean(b.typing)});typingState.set(username,{to,until:Date.now()+3000});}return send(res,200,{ok:true});}
      if(req.method==='GET' && u.pathname==='/api/messages'){const withUser=String(u.searchParams.get('with')||'').toLowerCase();const messages=db.messages.filter(m=>(m.from===username&&m.to===withUser)||(m.from===withUser&&m.to===username)).slice(-200);messages.forEach(m=>{if(m.to===username)m.read=true});saveDb();return send(res,200,{messages});}
      if(req.method==='POST' && u.pathname==='/api/report'){
        const b=await jsonBody(req);const targetType=String(b.targetType||'');const targetId=String(b.targetId||'');const reason=String(b.reason||'').trim();if(!targetType||!targetId||!reason)return send(res,400,{error:'Report details are required.'});db.reports.push({id:id(),reporter:username,targetType,targetId,reason,createdAt:Date.now(),status:'open'});saveDb();return send(res,200,{ok:true});
      }
      /* v27 — Creator & Business Center */
      if(req.method==='GET' && u.pathname==='/api/creator'){
        const c=db.creators[username]||{username,displayName:db.profiles[username]?.displayName||username,bio:'',verified:false,createdAt:Date.now()};
        db.creators[username]=c; saveDb();
        const packs=db.creatorPacks.filter(x=>x.creator===username).slice().reverse();
        const purchases=db.creatorPurchases.filter(x=>x.buyer===username).slice(-100).reverse();
        const sales=db.creatorPurchases.filter(x=>x.creator===username);
        return send(res,200,{creator:c,packs,purchases,analytics:{sales:sales.length,coinsEarned:sales.reduce((a,x)=>a+Number(x.creatorCoins||0),0),views:packs.reduce((a,x)=>a+Number(x.views||0),0)}});
      }
      if(req.method==='PUT' && u.pathname==='/api/creator'){
        const b=await jsonBody(req); const displayName=String(b.displayName||'').trim().slice(0,50); const bio=String(b.bio||'').trim().slice(0,180);
        db.creators[username]={...(db.creators[username]||{username,createdAt:Date.now(),verified:false}),username,displayName:displayName||db.profiles[username]?.displayName||username,bio,updatedAt:Date.now()}; saveDb(); return send(res,200,{creator:db.creators[username]});
      }
      if(req.method==='POST' && u.pathname==='/api/creator/verification'){
        const c=db.creators[username]||{username,createdAt:Date.now()}; c.verificationStatus='pending';c.verificationNote=String((await jsonBody(req)).note||'').slice(0,500);c.updatedAt=Date.now();db.creators[username]=c;saveDb();return send(res,200,{creator:c});
      }
      if(req.method==='POST' && u.pathname==='/api/creator/packs'){
        const b=await jsonBody(req),title=String(b.title||'').trim().slice(0,80),description=String(b.description||'').trim().slice(0,300),price=Math.floor(Number(b.priceCoins)||0),difficulty=['easy','normal','hard'].includes(b.difficulty)?b.difficulty:'normal',category=String(b.category||'General').trim().slice(0,40)||'General';
        let words=Array.isArray(b.words)?b.words.map(x=>String(x||'').trim().toUpperCase().replace(/[^A-Z]/g,'')).filter(x=>x.length>=2&&x.length<=30):[]; words=[...new Set(words)].slice(0,50);
        if(!title||words.length<5||price<1||price>10000)return send(res,400,{error:'Title, at least 5 valid words, and a price from 0–10000 coins are required.'});
        const pack={id:id(),creator:username,title,description,difficulty,category:String(category||'General').trim().slice(0,40)||'General',priceCoins:price,words,views:0,sales:0,status:'published',createdAt:Date.now(),updatedAt:Date.now()};db.creatorPacks.push(pack);saveDb();return send(res,200,{pack});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/marketplace'){
        const packs=db.creatorPacks.filter(x=>x.status==='published').slice().reverse().slice(0,100).map(x=>({...x,words:undefined,creatorName:db.profiles[x.creator]?.displayName||x.creator}));return send(res,200,{packs});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/packs/') && u.pathname.endsWith('/purchase')){
        const pid=u.pathname.split('/')[4],pack=db.creatorPacks.find(x=>x.id===pid&&x.status==='published');if(!pack)return send(res,404,{error:'Pack not found.'});if(pack.creator===username)return send(res,400,{error:'You cannot purchase your own pack.'}); const promoCode=String((await jsonBody(req)).promoCode||'').trim().toUpperCase();
        db.wallets=db.wallets||{};db.wallets[username]=db.wallets[username]||{coins:0,updatedAt:Date.now()}; let cost=Number(pack.priceCoins||0); const promo=db.creatorPromoCodes?.find(x=>x.creator===pack.creator&&x.code===promoCode&&x.status==='active'); if(promo&&(promo.expiresAt===null||promo.expiresAt>Date.now())&&(promo.maxUses===null||promo.uses<promo.maxUses))cost=Math.max(0,Math.floor(cost*(1-promo.discountPercent/100)));if(db.wallets[username].coins<cost)return send(res,400,{error:'Not enough coins.'});
        const already=db.creatorPurchases.some(x=>x.packId===pid&&x.buyer===username);if(already)return send(res,409,{error:'You already own this pack.'}); if(promo){promo.uses=(promo.uses||0)+1;}
        db.wallets[username].coins-=cost;db.wallets[username].updatedAt=Date.now();const creatorShare=Math.floor(cost*.8);const purchase={id:id(),packId:pid,buyer:username,creator:pack.creator,creatorCoins:creatorShare,priceCoins:cost,createdAt:Date.now()};db.creatorPurchases.push(purchase);pack.sales=(pack.sales||0)+1;pack.updatedAt=Date.now();db.coinLedger=db.coinLedger||[];db.coinLedger.push({id:id(),username,delta:-cost,reason:'creator-pack-purchase',reference:pid,createdAt:Date.now()},{id:id(),username:pack.creator,delta:creatorShare,reason:'creator-pack-sale',reference:pid,createdAt:Date.now()});db.wallets[pack.creator]=db.wallets[pack.creator]||{coins:0,updatedAt:Date.now()};db.wallets[pack.creator].coins+=creatorShare;db.wallets[pack.creator].updatedAt=Date.now();saveDb();return send(res,200,{purchase,wallet:db.wallets[username]});
      }
      if(req.method==='DELETE' && u.pathname.startsWith('/api/creator/packs/')){
        const pid=u.pathname.split('/').pop(),pack=db.creatorPacks.find(x=>x.id===pid&&x.creator===username);if(!pack)return send(res,404,{error:'Pack not found.'});pack.status='archived';pack.updatedAt=Date.now();saveDb();return send(res,200,{ok:true});
      }
      /* v28 — Creator monetization, verification and payouts */
      if(req.method==='POST' && u.pathname==='/api/creator/payouts'){
        const b=await jsonBody(req); const amount=Math.floor(Number(b.coins)||0); const method=String(b.method||'bank').slice(0,30); const accountName=String(b.accountName||'').trim().slice(0,100); const accountNumber=String(b.accountNumber||'').replace(/\D/g,'').slice(0,20); const bank=String(b.bank||'').trim().slice(0,80);
        db.wallets=db.wallets||{}; db.wallets[username]=db.wallets[username]||{coins:0,updatedAt:Date.now()};
        if(amount<100||amount>db.wallets[username].coins)return send(res,400,{error:'Enter a payout amount of at least 100 coins and no more than your available balance.'});
        if(!accountName||accountNumber.length<6||!bank)return send(res,400,{error:'Bank name, account name and account number are required.'});
        const pending=db.creatorPayouts.some(x=>x.username===username&&x.status==='pending'); if(pending)return send(res,409,{error:'You already have a pending payout request.'});
        const payout={id:id(),username,coins:amount,method,bank,accountName,accountNumberLast4:accountNumber.slice(-4),status:'pending',createdAt:Date.now()};db.creatorPayouts.push(payout);saveDb();return send(res,200,{payout});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/payouts')return send(res,200,{payouts:db.creatorPayouts.filter(x=>x.username===username).slice().reverse().slice(0,50)});
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/packs/') && u.pathname.endsWith('/view')){
        const pid=u.pathname.split('/')[4],pack=db.creatorPacks.find(x=>x.id===pid&&x.status==='published');if(!pack)return send(res,404,{error:'Pack not found.'});pack.views=(pack.views||0)+1;pack.updatedAt=Date.now();saveDb();return send(res,200,{ok:true,views:pack.views});
      }
      if(req.method==='POST' && u.pathname==='/api/creator/subscription'){
        const b=await jsonBody(req);const creator=String(b.creator||'').trim().toLowerCase();const tier=['supporter','pro'].includes(String(b.tier||''))?String(b.tier):'supporter';const price=tier==='pro'?500:200;if(!db.creators[creator])return send(res,404,{error:'Creator not found.'});if(creator===username)return send(res,400,{error:'You cannot subscribe to yourself.'});ensureEconomy(username);if(db.wallets[username].coins<price)return send(res,400,{error:`You need ${price} coins for this creator membership.`});db.wallets[username].coins-=price;const creatorShare=Math.floor(price*.8);db.wallets[creator]=db.wallets[creator]||{coins:0,updatedAt:Date.now()};db.wallets[creator].coins+=creatorShare;db.wallets[creator].updatedAt=Date.now();const sub={id:id(),username,creator,tier,priceCoins:price,creatorCoins:creatorShare,expiresAt:Date.now()+30*24*60*60*1000,createdAt:Date.now()};db.creatorSubscriptions.push(sub);db.coinLedger.push({id:id(),username,delta:-price,reason:'creator-subscription',reference:sub.id,createdAt:Date.now()},{id:id(),username:creator,delta:creatorShare,reason:'creator-subscription-earnings',reference:sub.id,createdAt:Date.now()});saveDb();return send(res,200,{subscription:sub,wallet:db.wallets[username]});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/subscription')return send(res,200,{subscription:db.creatorSubscriptions.filter(x=>x.username===username&&x.expiresAt>Date.now()).sort((a,b)=>b.createdAt-a.createdAt)[0]||null});
      if(req.method==='GET' && u.pathname==='/api/creator/discover'){
        const q=String(u.searchParams.get('q')||'').trim().toLowerCase(),category=String(u.searchParams.get('category')||'').trim().toLowerCase(),difficulty=String(u.searchParams.get('difficulty')||'').trim().toLowerCase();
        const packs=db.creatorPacks.filter(x=>x.status==='published').map(x=>{const reviews=db.creatorReviews.filter(r=>r.packId===x.id);const avg=reviews.length?reviews.reduce((a,r)=>a+r.rating,0)/reviews.length:0;return {...x,words:undefined,creatorName:db.creators[x.creator]?.displayName||db.profiles[x.creator]?.displayName||x.creator,creatorVerified:Boolean(db.creators[x.creator]?.verified),reviewCount:reviews.length,rating:Number(avg.toFixed(1)),category:x.category||'General'}}).filter(x=>(!q||x.title.toLowerCase().includes(q)||x.description.toLowerCase().includes(q)||x.creatorName.toLowerCase().includes(q))&&(!category||x.category.toLowerCase()===category)&&(!difficulty||x.difficulty===difficulty));
        packs.sort((a,b)=>(b.sales-a.sales)||(b.rating-a.rating)||(b.views-a.views)); const creators=Object.values(db.creators||{}).map(c=>{const packs2=db.creatorPacks.filter(x=>x.creator===c.username&&x.status==='published');const followers=Object.values(db.creatorFollows||{}).filter(a=>(a||[]).includes(c.username)).length;const sales=packs2.reduce((a,x)=>a+(x.sales||0),0);return {...c,followers,packs:packs2.length,sales}}).filter(c=>!q||String(c.username).toLowerCase().includes(q)||String(c.displayName||'').toLowerCase().includes(q)).sort((a,b)=>b.followers-a.followers||b.sales-a.sales).slice(0,50);
        return send(res,200,{packs:packs.slice(0,100),creators,categories:[...new Set(db.creatorPacks.map(x=>x.category||'General'))].sort()});
      }
      if(req.method==='GET' && u.pathname.startsWith('/api/creator/storefront/')){
        const target=decodeURIComponent(u.pathname.split('/').pop()).toLowerCase(),c=db.creators[target];if(!c)return send(res,404,{error:'Creator not found.'});
        const packs=db.creatorPacks.filter(x=>x.creator===target&&x.status==='published').map(x=>{const rs=db.creatorReviews.filter(r=>r.packId===x.id);return {...x,words:undefined,reviewCount:rs.length,rating:rs.length?Number((rs.reduce((a,r)=>a+r.rating,0)/rs.length).toFixed(1)):0}});
        const followers=Object.values(db.creatorFollows||{}).filter(a=>(a||[]).includes(target)).length;const following=(db.creatorFollows[username]||[]).includes(target);return send(res,200,{creator:{...c,followers,following},packs,followers});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/follow/')){
        const target=decodeURIComponent(u.pathname.split('/').pop()).toLowerCase();if(!db.creators[target])return send(res,404,{error:'Creator not found.'});if(target===username)return send(res,400,{error:'You cannot follow yourself.'});db.creatorFollows[username]=db.creatorFollows[username]||[];const set=new Set(db.creatorFollows[username]);set.has(target)?set.delete(target):set.add(target);db.creatorFollows[username]=[...set];saveDb();return send(res,200,{following:set.has(target),followers:Object.values(db.creatorFollows).filter(a=>(a||[]).includes(target)).length});
      }
      if(req.method==='GET' && u.pathname.startsWith('/api/creator/reviews/')){
        const pid=decodeURIComponent(u.pathname.split('/').pop());const reviews=db.creatorReviews.filter(r=>r.packId===pid).slice().reverse().slice(0,100);return send(res,200,{reviews});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/reviews/')){
        const pid=decodeURIComponent(u.pathname.split('/').pop()),pack=db.creatorPacks.find(x=>x.id===pid&&x.status==='published');if(!pack)return send(res,404,{error:'Pack not found.'});if(!db.creatorPurchases.some(x=>x.packId===pid&&x.buyer===username))return send(res,403,{error:'Unlock the pack before reviewing it.'});const b=await jsonBody(req),rating=Math.round(Number(b.rating)),body=String(b.body||'').trim().slice(0,500);if(rating<1||rating>5)return send(res,400,{error:'Rating must be 1 to 5.'});const existing=db.creatorReviews.find(x=>x.packId===pid&&x.username===username);if(existing){existing.rating=rating;existing.body=body;existing.updatedAt=Date.now()}else db.creatorReviews.push({id:id(),packId:pid,creator:pack.creator,username,rating,body,createdAt:Date.now()});saveDb();return send(res,200,{ok:true});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/recommendations'){
        const follows=db.creatorFollows[username]||[],owned=db.creatorPurchases.filter(x=>x.buyer===username).map(x=>x.packId);const candidates=db.creatorPacks.filter(x=>x.status==='published'&&!owned.includes(x.id));const ranked=candidates.map(x=>{let score=(x.sales||0)*0.5+(x.views||0)*0.05;if(follows.includes(x.creator))score+=1000;const rs=db.creatorReviews.filter(r=>r.packId===x.id);if(rs.length)score+=(rs.reduce((a,r)=>a+r.rating,0)/rs.length)*10;return {...x,words:undefined,score,creatorName:db.creators[x.creator]?.displayName||x.creator,creatorVerified:Boolean(db.creators[x.creator]?.verified),category:x.category||'General'}}).sort((a,b)=>b.score-a.score).slice(0,30);return send(res,200,{packs:ranked});
      }

      if(req.method==='POST' && u.pathname==='/api/appeals'){
        const b=await jsonBody(req);const reason=String(b.reason||'').trim();if(!reason||reason.length>1000)return send(res,400,{error:'Appeal reason is required.'});db.appeals=db.appeals||[];if(db.appeals.some(x=>x.username===username&&x.status==='open'))return send(res,409,{error:'You already have an open appeal.'});const a={id:id(),username,reason,status:'open',createdAt:Date.now()};db.appeals.push(a);saveDb();return send(res,200,{appeal:a});
      }
      if(req.method==='PUT' && u.pathname==='/api/profile/privacy'){
        const b=await jsonBody(req);db.privacy[username]={private:Boolean(b.private)};saveDb();return send(res,200,{privacy:db.privacy[username]});
      }
      /* v26 — Admin & Moderation Center */
      // v30 Creator Social Network
      /* v32 — AI Creator Assistant */
      function aiClean(s,max=500){return String(s||'').trim().replace(/\s+/g,' ').slice(0,max)}
      function aiTopicKey(topic){return aiClean(topic,80).toLowerCase()}
      function localAiQuiz(topic,category,difficulty,count){
        const t=aiTopicKey(topic), c=aiTopicKey(category)||'general'; const banks={
          nigeria:['LAGOS','ABUJA','IBADAN','KANO','ENUGU','CALABAR','BENIN','ILORIN','OSOGBO','AKURE','NIGER','AFRICA','YORUBA','HAUSA','IGBO'],
          football:['GOAL','PITCH','STRIKER','DEFENDER','GOALKEEPER','REFEREE','STADIUM','TROPHY','LEAGUE','PASS','CORNER','KICKOFF','CAPTAIN'],
          music:['RHYTHM','MELODY','CHORUS','ALBUM','SINGER','BEAT','STAGE','MICROPHONE','GUITAR','PIANO','DJ','CONCERT'],
          technology:['SOFTWARE','HARDWARE','SERVER','DATABASE','NETWORK','BROWSER','MOBILE','ROBOT','CLOUD','CODING','ALGORITHM','SECURITY'],
          africa:['NIGERIA','GHANA','KENYA','EGYPT','MOROCCO','ETHIOPIA','ZAMBIA','UGANDA','TANZANIA','SENEGAL','RWANDA','AFRICA'],
          culture:['TRADITION','FESTIVAL','LANGUAGE','DANCE','FOOD','CLOTHING','HERITAGE','FAMILY','MUSIC','ART','STORY','COMMUNITY']
        };
        const key=Object.keys(banks).find(k=>t.includes(k)||c.includes(k))||'culture';
        const base=[...banks[key]]; const generic=[t.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,18),c.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,18),'KNOWLEDGE','CHALLENGE','TRIVIA','QUIZ'];
        const pool=[...new Set([...base,...generic].filter(x=>x.length>=2))]; const n=Math.max(5,Math.min(50,Number(count)||10));
        while(pool.length<n) pool.push(`${key.toUpperCase()}${pool.length+1}`);
        return {topic,category,difficulty,count:n,answers:pool.slice(0,n),note:'Local assistant suggestions. Verify factual answers before publishing.'};
      }
      function localAiCaption(topic,tone){
        const t=aiClean(topic,120)||'my latest quiz'; const tones={fun:'Fun, fast and made for bragging rights!',professional:'A focused challenge for curious minds.',hype:'Think you know it? Prove it and challenge your friends!',friendly:'Come play, learn something new and share your score!'};
        const lead=tones[aiClean(tone,30).toLowerCase()]||tones.fun; return `${lead} 🎯 ${t}. Test yourself, invite a friend and see who sabi am.`;
      }
      function localAiHashtags(topic,category){const words=[...`${topic||''} ${category||''}`.toUpperCase().matchAll(/[A-Z0-9]+/g)].map(m=>m[0]).filter(x=>x.length>2);const base=['WHO SABI ME','QUIZ','TRIVIA','PUZZLE','PLAY','CHALLENGE','NIGERIA'];return [...new Set([...words,...base])].slice(0,10).map(x=>'#'+x.replace(/[^A-Z0-9]/g,''));}
      function localAiDifficulty(words){const arr=Array.isArray(words)?words.map(x=>String(x).trim()).filter(Boolean):String(words||'').split(/\n|,/).map(x=>x.trim()).filter(Boolean);const avg=arr.length?arr.reduce((n,w)=>n+w.replace(/[^A-Za-z]/g,'').length,0)/arr.length:0;let difficulty=avg>=8?'hard':avg>=5?'normal':'easy';return {difficulty,reason:`Estimated from ${arr.length} entries and average answer length of ${avg.toFixed(1)} characters. Add clues and test with players before publishing.`};}
      if(req.method==='GET' && u.pathname==='/api/creator/ai/status')return send(res,200,{enabled:true,provider:process.env.AI_API_URL?'external-compatible':'local',note:process.env.AI_API_URL?'External AI provider configured; never expose the server API key to clients.':'Local assistant is active. Configure AI_API_URL and AI_API_KEY to connect a compatible external model.'});
      if(req.method==='POST' && u.pathname==='/api/creator/ai/quiz'){const b=await jsonBody(req);const topic=aiClean(b.topic,80);if(!topic)return send(res,400,{error:'A quiz topic is required.'});return send(res,200,{result:localAiQuiz(topic,aiClean(b.category,40),aiClean(b.difficulty,20),b.count)});}
      if(req.method==='POST' && u.pathname==='/api/creator/ai/caption'){const b=await jsonBody(req);return send(res,200,{caption:localAiCaption(b.topic,b.tone)});}
      if(req.method==='POST' && u.pathname==='/api/creator/ai/hashtags'){const b=await jsonBody(req);return send(res,200,{hashtags:localAiHashtags(aiClean(b.topic,80),aiClean(b.category,40))});}
      if(req.method==='POST' && u.pathname==='/api/creator/ai/difficulty'){const b=await jsonBody(req);return send(res,200,{result:localAiDifficulty(b.words)});}
      if(req.method==='GET' && u.pathname==='/api/creator/ai/recommendations'){
        const mine=db.creatorPacks.filter(x=>x.creator===username), sales=mine.reduce((n,x)=>n+Number(x.sales||0),0),views=mine.reduce((n,x)=>n+Number(x.views||0),0); const categories={};for(const p of db.creatorPacks.filter(x=>x.status==='published')){const k=p.category||'General';categories[k]=(categories[k]||0)+Number(p.sales||0)+Number(p.views||0)*0.05;}const top=Object.entries(categories).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([category,signal])=>({category,signal:Number(signal.toFixed(1))}));return send(res,200,{recommendations:[`Your published packs have ${sales} sales and ${views} views.`,top[0]?`Consider a new ${top[0][0]} pack because it has strong marketplace activity.`:'Publish a first pack and collect player feedback.',mine.length<3?'Try publishing 3–5 packs across related categories to learn what your audience responds to.':'Refresh older packs with new questions, descriptions and promotional posts.', 'Use the difficulty assistant to balance easy, normal and hard content.'],topCategories:top});
      }

      /* v31 — Creator Studio & Content Engine */
      if(req.method==='GET' && u.pathname==='/api/creator/studio'){
        db.creatorDrafts=db.creatorDrafts||[];db.creatorScheduledPosts=db.creatorScheduledPosts||[];db.creatorPromoCodes=db.creatorPromoCodes||[];
        const drafts=db.creatorDrafts.filter(x=>x.creator===username).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,100);
        const scheduled=db.creatorScheduledPosts.filter(x=>x.creator===username).sort((a,b)=>a.publishAt-b.publishAt).slice(0,100);
        const promos=db.creatorPromoCodes.filter(x=>x.creator===username).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100);
        const posts=db.creatorPosts.filter(x=>x.creator===username), likes=posts.reduce((n,x)=>n+(db.creatorPostLikes[x.id]||[]).length,0), comments=db.creatorPostComments.filter(x=>posts.some(p=>p.id===x.postId)).length;
        const packs=db.creatorPacks.filter(x=>x.creator===username); const sales=db.creatorPurchases.filter(x=>x.creator===username);
        return send(res,200,{drafts,scheduled,promos,analytics:{posts:posts.length,likes,comments,views:packs.reduce((n,x)=>n+Number(x.views||0),0),packSales:sales.length,coinsEarned:sales.reduce((n,x)=>n+Number(x.creatorCoins||0),0),followers:(db.creatorFollows[username]||[]).length}});
      }
      if(req.method==='POST' && u.pathname==='/api/creator/studio/drafts'){
        db.creatorDrafts=db.creatorDrafts||[];const b=await jsonBody(req),title=String(b.title||'').trim().slice(0,100),text=String(b.text||'').trim().slice(0,2000);if(!text)return send(res,400,{error:'Draft content is required.'});const d={id:id(),creator:username,title,text,createdAt:Date.now(),updatedAt:Date.now()};db.creatorDrafts.push(d);saveDb();return send(res,200,{draft:d});
      }
      if(req.method==='PUT' && u.pathname.startsWith('/api/creator/studio/drafts/')){
        db.creatorDrafts=db.creatorDrafts||[];const did=u.pathname.split('/').pop(),d=db.creatorDrafts.find(x=>x.id===did&&x.creator===username);if(!d)return send(res,404,{error:'Draft not found.'});const b=await jsonBody(req);if(b.title!==undefined)d.title=String(b.title||'').trim().slice(0,100);if(b.text!==undefined)d.text=String(b.text||'').trim().slice(0,2000);d.updatedAt=Date.now();saveDb();return send(res,200,{draft:d});
      }
      if(req.method==='DELETE' && u.pathname.startsWith('/api/creator/studio/drafts/')){db.creatorDrafts=db.creatorDrafts||[];const did=u.pathname.split('/').pop();db.creatorDrafts=db.creatorDrafts.filter(x=>!(x.id===did&&x.creator===username));saveDb();return send(res,200,{ok:true});}
      if(req.method==='POST' && u.pathname==='/api/creator/studio/schedule'){
        db.creatorScheduledPosts=db.creatorScheduledPosts||[];const b=await jsonBody(req),text=String(b.text||'').trim().slice(0,1000),publishAt=Number(b.publishAt);if(!text||!Number.isFinite(publishAt)||publishAt<Date.now()+60000)return send(res,400,{error:'Content and a publish time at least 1 minute in the future are required.'});const item={id:id(),creator:username,text,publishAt,status:'scheduled',createdAt:Date.now(),updatedAt:Date.now()};db.creatorScheduledPosts.push(item);saveDb();return send(res,200,{scheduled:item});
      }
      if(req.method==='DELETE' && u.pathname.startsWith('/api/creator/studio/schedule/')){db.creatorScheduledPosts=db.creatorScheduledPosts||[];const sid=u.pathname.split('/').pop();db.creatorScheduledPosts=db.creatorScheduledPosts.filter(x=>!(x.id===sid&&x.creator===username));saveDb();return send(res,200,{ok:true});}
      if(req.method==='GET' && u.pathname==='/api/creator/studio/promos'){db.creatorPromoCodes=db.creatorPromoCodes||[];return send(res,200,{promos:db.creatorPromoCodes.filter(x=>x.creator===username).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100)});}
      if(req.method==='POST' && u.pathname==='/api/creator/studio/promos'){
        db.creatorPromoCodes=db.creatorPromoCodes||[];const b=await jsonBody(req),code=String(b.code||'').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,24),discount=Math.floor(Number(b.discountPercent)||0),maxUses=Math.floor(Number(b.maxUses)||0),expiresAt=Number(b.expiresAt||0);if(!code||discount<1||discount>90)return send(res,400,{error:'Code and a discount from 1–90% are required.'});if(db.creatorPromoCodes.some(x=>x.code===code&&x.status==='active'))return send(res,409,{error:'That promo code is already active.'});const promo={id:id(),creator:username,code,discountPercent:discount,maxUses:maxUses>0?maxUses:null,uses:0,expiresAt:expiresAt>0?expiresAt:null,status:'active',createdAt:Date.now()};db.creatorPromoCodes.push(promo);saveDb();return send(res,200,{promo});
      }
      if(req.method==='PUT' && u.pathname.startsWith('/api/creator/studio/promos/')){db.creatorPromoCodes=db.creatorPromoCodes||[];const pid=u.pathname.split('/').pop(),promo=db.creatorPromoCodes.find(x=>x.id===pid&&x.creator===username);if(!promo)return send(res,404,{error:'Promo code not found.'});promo.status=promo.status==='active'?'paused':'active';promo.updatedAt=Date.now();saveDb();return send(res,200,{promo});}
      if(req.method==='GET' && u.pathname==='/api/creator/social/feed'){
        db.creatorScheduledPosts=db.creatorScheduledPosts||[]; const due=db.creatorScheduledPosts.filter(x=>x.status==='scheduled'&&x.publishAt<=Date.now()); for(const x of due){const post={id:id(),creator:x.creator,text:x.text,createdAt:x.publishAt,scheduledSource:x.id};db.creatorPosts.push(post);x.status='published';x.updatedAt=Date.now();const followers=Object.entries(db.creatorFollows||{}).filter(([u,arr])=>Array.isArray(arr)&&arr.includes(x.creator)).map(([u])=>u);for(const u2 of followers)db.notifications.unshift({id:id(),username:u2,type:'creator_post',value:x.creator,body:'A creator you follow published a new update.',createdAt:Date.now(),read:false});} if(due.length)saveDb();
        const following=db.creatorFollows[username]||[]; const creators=[username,...following];
        const posts=db.creatorPosts.filter(x=>creators.includes(x.creator)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(x=>({...x,liked:Boolean((db.creatorPostLikes[x.id]||[]).includes(username)),likes:(db.creatorPostLikes[x.id]||[]).length,comments:db.creatorPostComments.filter(c=>c.postId===x.id).slice(-20),creatorName:db.creators[x.creator]?.displayName||db.profiles[x.creator]?.displayName||x.creator}));
        return send(res,200,{posts});
      }
      if(req.method==='POST' && u.pathname==='/api/creator/social/posts'){
        const b=await jsonBody(req), text=String(b.text||'').trim().slice(0,1000); if(!text)return send(res,400,{error:'Post text is required.'});
        const post={id:id(),creator:username,text,createdAt:Date.now()}; db.creatorPosts.push(post); saveDb(); return send(res,200,{post});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/social/posts/') && u.pathname.endsWith('/like')){
        const pid=u.pathname.split('/')[5],post=db.creatorPosts.find(x=>x.id===pid); if(!post)return send(res,404,{error:'Post not found.'});
        db.creatorPostLikes[pid]=db.creatorPostLikes[pid]||[]; const a=db.creatorPostLikes[pid], i=a.indexOf(username); if(i>=0)a.splice(i,1); else a.push(username); saveDb(); return send(res,200,{liked:i<0,likes:a.length});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/social/posts/') && u.pathname.endsWith('/comments')){
        const pid=u.pathname.split('/')[5],post=db.creatorPosts.find(x=>x.id===pid); if(!post)return send(res,404,{error:'Post not found.'}); const b=await jsonBody(req),text=String(b.text||'').trim().slice(0,400); if(!text)return send(res,400,{error:'Comment is required.'});
        const c={id:id(),postId:pid,username,text,createdAt:Date.now()}; db.creatorPostComments.push(c); saveDb(); return send(res,200,{comment:c});
      }
      if(req.method==='POST' && u.pathname==='/api/creator/social/live'){
        const b=await jsonBody(req),title=String(b.title||'Creator Live').trim().slice(0,100); const active=db.creatorLives.find(x=>x.creator===username&&x.status==='live'); if(active)return send(res,409,{error:'You already have an active creator live session.'});
        const live={id:id(),creator:username,title,status:'live',viewers:0,createdAt:Date.now(),updatedAt:Date.now()};db.creatorLives.push(live);saveDb();return send(res,200,{live});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/social/live/') && u.pathname.endsWith('/end')){
        const lid=u.pathname.split('/')[5],live=db.creatorLives.find(x=>x.id===lid&&x.creator===username);if(!live)return send(res,404,{error:'Live session not found.'});live.status='ended';live.updatedAt=Date.now();saveDb();return send(res,200,{live});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/social/live'){
        const lives=db.creatorLives.filter(x=>x.status==='live').sort((a,b)=>b.createdAt-a.createdAt).slice(0,50).map(x=>({...x,creatorName:db.creators[x.creator]?.displayName||db.profiles[x.creator]?.displayName||x.creator,following:(db.creatorFollows[username]||[]).includes(x.creator)}));return send(res,200,{lives});
      }
      if(req.method==='POST' && u.pathname==='/api/creator/social/collaborations'){
        const b=await jsonBody(req),partner=String(b.partner||'').trim().toLowerCase(),title=String(b.title||'').trim().slice(0,100);if(!db.creators[partner])return send(res,404,{error:'Creator partner not found.'});if(partner===username)return send(res,400,{error:'Choose another creator.'});if(!title)return send(res,400,{error:'Collaboration title is required.'});
        const collab={id:id(),creator:username,partner,title,status:'pending',createdAt:Date.now(),updatedAt:Date.now()};db.creatorCollaborations.push(collab);saveDb();return send(res,200,{collaboration:collab});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/social/collaborations')return send(res,200,{collaborations:db.creatorCollaborations.filter(x=>x.creator===username||x.partner===username).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100)});
      if(req.method==='PUT' && u.pathname.startsWith('/api/creator/social/collaborations/')){
        const cid=u.pathname.split('/').pop(),c=db.creatorCollaborations.find(x=>x.id===cid&&(x.creator===username||x.partner===username));if(!c)return send(res,404,{error:'Collaboration not found.'});const b=await jsonBody(req),status=String(b.status||'pending');if(!['pending','accepted','declined','completed'].includes(status))return send(res,400,{error:'Invalid collaboration status.'});c.status=status;c.updatedAt=Date.now();saveDb();return send(res,200,{collaboration:c});
      }
      if(u.pathname.startsWith('/api/admin/') && !isAdmin(username)) return send(res,403,{error:'Admin access required.'});
      if(req.method==='GET' && u.pathname==='/api/admin/creators'){
        const creators=Object.values(db.creators||{}).map(c=>{const sales=db.creatorPurchases.filter(x=>x.creator===c.username);return {...c,sales:sales.length,coinsEarned:sales.reduce((a,x)=>a+Number(x.creatorCoins||0),0),packs:db.creatorPacks.filter(x=>x.creator===c.username).length}}).sort((a,b)=>b.sales-a.sales);return send(res,200,{creators});
      }
      if(req.method==='PUT' && u.pathname.startsWith('/api/admin/creators/') && u.pathname.endsWith('/verification')){
        const target=decodeURIComponent(u.pathname.split('/')[4]).toLowerCase(),c=db.creators[target];if(!c)return send(res,404,{error:'Creator not found.'});const b=await jsonBody(req);const status=String(b.status||'');if(!['verified','rejected','pending'].includes(status))return send(res,400,{error:'Invalid verification status.'});c.verified=status==='verified';c.verificationStatus=status;c.verificationReviewedBy=username;c.verificationReviewedAt=Date.now();c.verificationReviewNote=String(b.note||'').slice(0,500);saveDb();return send(res,200,{creator:c});
      }
      if(req.method==='GET' && u.pathname==='/api/admin/payouts')return send(res,200,{payouts:(db.creatorPayouts||[]).slice().reverse().slice(0,500)});
      if(req.method==='PUT' && u.pathname.startsWith('/api/admin/payouts/')){
        const pid=u.pathname.split('/').pop(),p=(db.creatorPayouts||[]).find(x=>x.id===pid);if(!p)return send(res,404,{error:'Payout not found.'});const b=await jsonBody(req),status=String(b.status||'');if(!['pending','approved','paid','rejected'].includes(status))return send(res,400,{error:'Invalid payout status.'});
        if(p.status==='pending'&&status==='approved'){db.wallets=db.wallets||{};db.wallets[p.username]=db.wallets[p.username]||{coins:0,updatedAt:Date.now()};if(db.wallets[p.username].coins<p.coins)return send(res,409,{error:'Creator no longer has enough coins for this payout.'});db.wallets[p.username].coins-=p.coins;db.wallets[p.username].updatedAt=Date.now();db.coinLedger=db.coinLedger||[];db.coinLedger.push({id:id(),username:p.username,delta:-p.coins,reason:'creator-payout-reserve',reference:p.id,createdAt:Date.now()});} else if((p.status==='approved'||p.status==='paid')&&status==='rejected'){db.wallets=db.wallets||{};db.wallets[p.username]=db.wallets[p.username]||{coins:0,updatedAt:Date.now()};db.wallets[p.username].coins+=p.coins;db.wallets[p.username].updatedAt=Date.now();db.coinLedger=db.coinLedger||[];db.coinLedger.push({id:id(),username:p.username,delta:p.coins,reason:'creator-payout-refund',reference:p.id,createdAt:Date.now()});}
        p.status=status;p.adminNote=String(b.note||'').slice(0,500);p.reviewedBy=username;p.updatedAt=Date.now();saveDb();return send(res,200,{payout:p});
      }
      if(req.method==='GET' && u.pathname==='/api/admin/ads'){const views=db.adMetrics?.views||{};return send(res,200,{provider:AD_CONFIG.provider,enabled:AD_CONFIG.enabled,configured:Boolean(AD_CONFIG.publisherId),publisherConfigured:Boolean(AD_CONFIG.publisherId),slots:Object.fromEntries(Object.entries(AD_CONFIG.slots).map(([k,v])=>[k,Boolean(v)])),adsTxtReady:Boolean(AD_CONFIG.publisherId),rewardedAds:{enabled:REWARDED_ADS_ENABLED,provider:REWARDED_ADS_PROVIDER,productionVerified:REWARDED_ADS_PROVIDER==='verified'},views});}
      if(req.method==='GET' && u.pathname==='/api/admin/revenue'){
        ensureEconomy();
        const txs=(db.transactions||[]).filter(x=>x.type==='coin_purchase');
        const completed=txs.filter(x=>x.status==='completed');
        const refunded=txs.filter(x=>x.refundStatus==='processed');
        const gross=completed.reduce((a,x)=>a+Number(x.amountKobo||0),0);
        const refundedAmount=refunded.reduce((a,x)=>a+Number(x.refundAmountKobo||x.amountKobo||0),0);
        const net=Math.max(0,gross-refundedAmount);
        const creatorSales=(db.creatorPurchases||[]).reduce((a,x)=>a+Number(x.priceCoins||0),0);
        const creatorCoinsEarned=(db.creatorPurchases||[]).reduce((a,x)=>a+Number(x.creatorCoins||0),0);
        const payoutRequests=(db.creatorPayouts||[]).reduce((a,x)=>a+Number(x.coins||0),0);
        const adViews=Object.values(db.adMetrics?.views||{}).reduce((a,v)=>a+Number(v||0),0);
        const users=Object.values(db.users||{});
        return send(res,200,{currency:PAYSTACK_CURRENCY,grossKobo:gross,refundedKobo:refundedAmount,netKobo:net,completedPayments:completed.length,pendingPayments:txs.filter(x=>x.status==='pending').length,creatorMarketplaceCoins:creatorSales,creatorCoinsEarned,creatorPayoutCoins:payoutRequests,adViews,users:users.length,generatedAt:Date.now()});
      }
      if(req.method==='GET' && u.pathname==='/api/admin/launch-check'){
        const checks=[
          {key:'paystack',label:'Paystack live payments configured',ok:PAYSTACK_ENABLED&&/^sk_(live|test)_/.test(PAYSTACK_SECRET_KEY)&&PAYSTACK_CURRENCY==='NGN',detail:PAYSTACK_ENABLED?'Configured':'Disabled'},
          {key:'baseUrl',label:'Production app base URL configured',ok:Boolean(APP_BASE_URL&&/^https:\/\//i.test(APP_BASE_URL)),detail:APP_BASE_URL||'Missing'},
          {key:'adsense',label:'AdSense publisher configured',ok:Boolean(AD_CONFIG.publisherId&&/^ca-pub-/.test(AD_CONFIG.publisherId)),detail:AD_CONFIG.publisherId?'Publisher ID present':'Missing publisher ID'},
          {key:'adSlots',label:'At least one standard ad slot configured',ok:Object.values(AD_CONFIG.slots).some(Boolean),detail:`${Object.values(AD_CONFIG.slots).filter(Boolean).length}/4 slots configured`},
          {key:'rewarded',label:'Rewarded ads production provider verified',ok:REWARDED_ADS_PROVIDER==='verified'&&REWARDED_ADS_ENABLED,detail:`Provider: ${REWARDED_ADS_PROVIDER}`},
          {key:'https',label:'HTTPS production mode',ok:IS_HTTPS,detail:IS_HTTPS?'Enabled':'NODE_ENV is not production'},
          {key:'admin',label:'Admin account configured',ok:Boolean(ADMIN_USERNAME),detail:ADMIN_USERNAME},
          {key:'db',label:'Persistent database available',ok:Boolean(db),detail:DB_FILE||'database'}
        ];
        return send(res,200,{ready:checks.every(x=>x.ok),checks,generatedAt:Date.now()});
      }
      if(req.method==='GET' && u.pathname==='/api/admin/payments'){
        ensureEconomy(); const txs=db.transactions.filter(x=>x.type==='coin_purchase').slice().reverse().slice(0,200);
        return send(res,200,{transactions:txs,summary:{total:txs.length,completed:txs.filter(x=>x.status==='completed').length,pending:txs.filter(x=>x.status==='pending').length,amountKobo:txs.filter(x=>x.status==='completed').reduce((a,x)=>a+Number(x.amountKobo||0),0),coins:txs.filter(x=>x.status==='completed').reduce((a,x)=>a+Number(x.coins||0),0)}});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/admin/payments/') && u.pathname.endsWith('/refund')){
        if(!PAYSTACK_ENABLED||!PAYSTACK_SECRET_KEY)return send(res,503,{error:'Paystack is not configured.'});
        const txid=decodeURIComponent(u.pathname.split('/')[4]); const tx=db.transactions.find(x=>x.id===txid&&x.type==='coin_purchase'); if(!tx)return send(res,404,{error:'Payment transaction not found.'});
        if(tx.status!=='completed')return send(res,400,{error:'Only completed payments can be refunded.'}); if(tx.refundStatus==='processed'||tx.refundStatus==='pending'||tx.refundStatus==='processing')return send(res,409,{error:'A refund is already in progress or completed.'});
        const b=await jsonBody(req); const amount=Math.max(1,Math.min(Number(tx.amountKobo),Number(b.amountKobo||tx.amountKobo)));
        const pr=await fetch('https://api.paystack.co/refund',{method:'POST',headers:{Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({transaction:tx.reference,amount,currency:PAYSTACK_CURRENCY,customer_note:String(b.customerNote||'WHO SABI ME? payment refund').slice(0,200),merchant_note:String(b.merchantNote||'Admin initiated refund').slice(0,200)})});
        const pj=await pr.json().catch(()=>({})); if(!pr.ok||!pj.status)return send(res,502,{error:pj.message||'Unable to initiate refund.'});
        tx.refundStatus=pj.data?.status||'pending'; tx.refundId=pj.data?.id||null; tx.refundAmountKobo=amount; tx.refundRequestedAt=Date.now(); tx.refundReason=String(b.merchantNote||'').slice(0,200); saveDb();
        return send(res,200,{ok:true,transaction:tx,refund:pj.data});
      }
      if(req.method==='GET' && u.pathname==='/api/admin/overview'){
        ensureAdminData();
db.creators=db.creators||{};db.creatorPacks=Array.isArray(db.creatorPacks)?db.creatorPacks:[];db.creatorPurchases=Array.isArray(db.creatorPurchases)?db.creatorPurchases:[];db.creatorPayouts=Array.isArray(db.creatorPayouts)?db.creatorPayouts:[];db.creatorSubscriptions=Array.isArray(db.creatorSubscriptions)?db.creatorSubscriptions:[];db.creatorFollows=db.creatorFollows||{};db.creatorReviews=Array.isArray(db.creatorReviews)?db.creatorReviews:[];db.creatorStorefronts=db.creatorStorefronts||{};db.creatorPosts=Array.isArray(db.creatorPosts)?db.creatorPosts:[];db.creatorPostLikes=db.creatorPostLikes||{};db.creatorPostComments=Array.isArray(db.creatorPostComments)?db.creatorPostComments:[];db.creatorLives=Array.isArray(db.creatorLives)?db.creatorLives:[];db.creatorCollaborations=Array.isArray(db.creatorCollaborations)?db.creatorCollaborations:[]; const users=Object.values(db.users||{}), games=Object.values(db.puzzleGames||{}), tx=db.transactions||[];
        const reports=db.reports||[], openReports=reports.filter(x=>x.status==='open').length, appeals=(db.appeals||[]).filter(x=>x.status==='open').length;
        return send(res,200,{stats:{users:users.length,activeUsers:users.filter(x=>(x.status||'active')==='active').length,suspended:users.filter(x=>x.status==='suspended').length,banned:users.filter(x=>x.status==='banned').length,profiles:Object.keys(db.profiles||{}).length,memories:(db.memories||[]).length,quizzes:Object.keys(db.quizzes||{}).length,liveGames:games.filter(g=>g.status==='playing').length,totalGames:games.length,openReports,appeals,wordBank:db.wordBank.length,announcements:db.announcements.length,transactions:tx.length,revenueKobo:tx.filter(x=>x.status==='completed').reduce((a,x)=>a+Number(x.amountKobo||0),0)},serverTime:Date.now()});
      }
      if(req.method==='GET' && u.pathname==='/api/admin/users'){
        const q=String(u.searchParams.get('q')||'').trim().toLowerCase(); const users=Object.values(db.users||{}).filter(x=>!q||x.username.includes(q)||x.email.includes(q)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,200);
        return send(res,200,{users:users.map(x=>({username:x.username,email:x.email,status:x.status||'active',createdAt:x.createdAt,emailVerified:Boolean(x.emailVerified),sessions:Object.values(db.sessionMeta||{}).filter(s=>s.username===x.username).length}))});
      }
      if(req.method==='PUT' && u.pathname.startsWith('/api/admin/users/')){
        const target=decodeURIComponent(u.pathname.split('/').pop()).toLowerCase(); const account=Object.values(db.users||{}).find(x=>x.username===target); if(!account)return send(res,404,{error:'User not found.'}); if(target===username)return send(res,400,{error:'Do not change the administrator account status.'}); const b=await jsonBody(req); const status=String(b.status||'active'); if(!['active','suspended','banned'].includes(status))return send(res,400,{error:'Invalid account status.'}); account.status=status; account.statusReason=String(b.reason||'').slice(0,300);account.statusAt=Date.now(); if(status!=='active'){for(const [sid,sess] of Object.entries(db.sessions||{}))if((typeof sess==='object'?sess.username:sess)===target)clearSession(sid)} saveDb(); return send(res,200,{ok:true,user:{username:target,status}});
      }
      if(req.method==='GET' && u.pathname==='/api/admin/reports') return send(res,200,{reports:(db.reports||[]).slice().reverse().slice(0,500)});
      if(req.method==='PUT' && u.pathname.startsWith('/api/admin/reports/')){const rid=u.pathname.split('/').pop();const r=(db.reports||[]).find(x=>x.id===rid);if(!r)return send(res,404,{error:'Report not found.'});const b=await jsonBody(req);const status=String(b.status||'resolved');if(!['open','reviewing','resolved','dismissed'].includes(status))return send(res,400,{error:'Invalid report status.'});r.status=status;r.adminNote=String(b.note||'').slice(0,500);r.updatedAt=Date.now();r.resolvedBy=username;saveDb();return send(res,200,{report:r});}
      if(req.method==='GET' && u.pathname==='/api/admin/games'){const games=Object.values(db.puzzleGames||{}).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,200);return send(res,200,{games:games.map(g=>({id:g.id,roomCode:g.roomCode,status:g.status,host:g.host,players:g.players||[],spectators:(g.spectators||[]).length,round:g.round,scores:g.scores||{},createdAt:g.createdAt,updatedAt:g.updatedAt}))});}
      if(req.method==='POST' && u.pathname==='/api/admin/games/end'){const b=await jsonBody(req);const g=db.puzzleGames?.[String(b.gameId||'')];if(!g)return send(res,404,{error:'Game not found.'});g.status='finished';g.turnStartedAt=null;g.turnEndsAt=null;g.adminEnded=true;g.updatedAt=Date.now();saveDb();for(const p of g.players||[])broadcast(p,'puzzleUpdate',{gameId:g.id,adminEnded:true});return send(res,200,{ok:true});}
      if(req.method==='GET' && u.pathname==='/api/admin/wordbank')return send(res,200,{words:(db.wordBank||[]).slice().sort()});
      if(req.method==='POST' && u.pathname==='/api/admin/wordbank'){const b=await jsonBody(req);const words=Array.isArray(b.words)?b.words:[b.word];const added=[];for(const raw of words){const w=String(raw||'').trim().toUpperCase();if(/^[A-Z]{2,16}$/.test(w)&&!db.wordBank.includes(w)){db.wordBank.push(w);added.push(w)}}db.wordBank=[...new Set(db.wordBank)].slice(0,5000);saveDb();return send(res,200,{ok:true,added,words:db.wordBank});}
      if(req.method==='DELETE' && u.pathname.startsWith('/api/admin/wordbank/')){const word=decodeURIComponent(u.pathname.split('/').pop()).toUpperCase();db.wordBank=(db.wordBank||[]).filter(x=>x!==word);saveDb();return send(res,200,{ok:true});}
      if(req.method==='GET' && u.pathname==='/api/admin/announcements')return send(res,200,{announcements:(db.announcements||[]).slice().reverse().slice(0,100)});
      if(req.method==='POST' && u.pathname==='/api/admin/announcements'){const b=await jsonBody(req);const title=String(b.title||'').trim().slice(0,100),body=String(b.body||'').trim().slice(0,1000);if(!title||!body)return send(res,400,{error:'Title and message are required.'});const a={id:id(),title,body,createdAt:Date.now(),createdBy:username,active:b.active!==false};db.announcements.push(a);db.notifications.push(...Object.values(db.users||{}).map(x=>({id:id(),username:x.username,type:'announcement',value:title,body,createdAt:Date.now(),read:false})));saveDb();return send(res,200,{announcement:a});}
      if(req.method==='DELETE' && u.pathname.startsWith('/api/admin/announcements/')){const aid=u.pathname.split('/').pop();db.announcements=(db.announcements||[]).filter(x=>x.id!==aid);saveDb();return send(res,200,{ok:true});}
      if(req.method==='GET' && u.pathname==='/api/admin/appeals')return send(res,200,{appeals:(db.appeals||[]).slice().reverse().slice(0,300)});
      if(req.method==='PUT' && u.pathname.startsWith('/api/admin/appeals/')){const aid=u.pathname.split('/').pop();const a=(db.appeals||[]).find(x=>x.id===aid);if(!a)return send(res,404,{error:'Appeal not found.'});const b=await jsonBody(req);const status=String(b.status||'reviewing');if(!['open','reviewing','approved','rejected'].includes(status))return send(res,400,{error:'Invalid appeal status.'});a.status=status;a.adminNote=String(b.note||'').slice(0,500);a.updatedAt=Date.now();a.reviewedBy=username;if(status==='approved'){const acct=Object.values(db.users||{}).find(x=>x.username===a.username);if(acct)acct.status='active'}saveDb();return send(res,200,{appeal:a});}
      /* v28 — Creator monetization, verification and payouts */
      if(req.method==='POST' && u.pathname==='/api/creator/payouts'){
        const b=await jsonBody(req); const amount=Math.floor(Number(b.coins)||0); const method=String(b.method||'bank').slice(0,30); const accountName=String(b.accountName||'').trim().slice(0,100); const accountNumber=String(b.accountNumber||'').replace(/\D/g,'').slice(0,20); const bank=String(b.bank||'').trim().slice(0,80);
        db.wallets=db.wallets||{}; db.wallets[username]=db.wallets[username]||{coins:0,updatedAt:Date.now()};
        if(amount<100||amount>db.wallets[username].coins)return send(res,400,{error:'Enter a payout amount of at least 100 coins and no more than your available balance.'});
        if(!accountName||accountNumber.length<6||!bank)return send(res,400,{error:'Bank name, account name and account number are required.'});
        const pending=db.creatorPayouts.some(x=>x.username===username&&x.status==='pending'); if(pending)return send(res,409,{error:'You already have a pending payout request.'});
        const payout={id:id(),username,coins:amount,method,bank,accountName,accountNumberLast4:accountNumber.slice(-4),status:'pending',createdAt:Date.now()};db.creatorPayouts.push(payout);saveDb();return send(res,200,{payout});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/payouts')return send(res,200,{payouts:db.creatorPayouts.filter(x=>x.username===username).slice().reverse().slice(0,50)});
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/packs/') && u.pathname.endsWith('/view')){
        const pid=u.pathname.split('/')[4],pack=db.creatorPacks.find(x=>x.id===pid&&x.status==='published');if(!pack)return send(res,404,{error:'Pack not found.'});pack.views=(pack.views||0)+1;pack.updatedAt=Date.now();saveDb();return send(res,200,{ok:true,views:pack.views});
      }
      if(req.method==='POST' && u.pathname==='/api/creator/subscription'){
        const b=await jsonBody(req);const creator=String(b.creator||'').trim().toLowerCase();const tier=['supporter','pro'].includes(String(b.tier||''))?String(b.tier):'supporter';const price=tier==='pro'?500:200;if(!db.creators[creator])return send(res,404,{error:'Creator not found.'});if(creator===username)return send(res,400,{error:'You cannot subscribe to yourself.'});ensureEconomy(username);if(db.wallets[username].coins<price)return send(res,400,{error:`You need ${price} coins for this creator membership.`});db.wallets[username].coins-=price;const creatorShare=Math.floor(price*.8);db.wallets[creator]=db.wallets[creator]||{coins:0,updatedAt:Date.now()};db.wallets[creator].coins+=creatorShare;db.wallets[creator].updatedAt=Date.now();const sub={id:id(),username,creator,tier,priceCoins:price,creatorCoins:creatorShare,expiresAt:Date.now()+30*24*60*60*1000,createdAt:Date.now()};db.creatorSubscriptions.push(sub);db.coinLedger.push({id:id(),username,delta:-price,reason:'creator-subscription',reference:sub.id,createdAt:Date.now()},{id:id(),username:creator,delta:creatorShare,reason:'creator-subscription-earnings',reference:sub.id,createdAt:Date.now()});saveDb();return send(res,200,{subscription:sub,wallet:db.wallets[username]});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/subscription')return send(res,200,{subscription:db.creatorSubscriptions.filter(x=>x.username===username&&x.expiresAt>Date.now()).sort((a,b)=>b.createdAt-a.createdAt)[0]||null});
      if(req.method==='GET' && u.pathname==='/api/creator/discover'){
        const q=String(u.searchParams.get('q')||'').trim().toLowerCase(),category=String(u.searchParams.get('category')||'').trim().toLowerCase(),difficulty=String(u.searchParams.get('difficulty')||'').trim().toLowerCase();
        const packs=db.creatorPacks.filter(x=>x.status==='published').map(x=>{const reviews=db.creatorReviews.filter(r=>r.packId===x.id);const avg=reviews.length?reviews.reduce((a,r)=>a+r.rating,0)/reviews.length:0;return {...x,words:undefined,creatorName:db.creators[x.creator]?.displayName||db.profiles[x.creator]?.displayName||x.creator,creatorVerified:Boolean(db.creators[x.creator]?.verified),reviewCount:reviews.length,rating:Number(avg.toFixed(1)),category:x.category||'General'}}).filter(x=>(!q||x.title.toLowerCase().includes(q)||x.description.toLowerCase().includes(q)||x.creatorName.toLowerCase().includes(q))&&(!category||x.category.toLowerCase()===category)&&(!difficulty||x.difficulty===difficulty));
        packs.sort((a,b)=>(b.sales-a.sales)||(b.rating-a.rating)||(b.views-a.views)); const creators=Object.values(db.creators||{}).map(c=>{const packs2=db.creatorPacks.filter(x=>x.creator===c.username&&x.status==='published');const followers=Object.values(db.creatorFollows||{}).filter(a=>(a||[]).includes(c.username)).length;const sales=packs2.reduce((a,x)=>a+(x.sales||0),0);return {...c,followers,packs:packs2.length,sales}}).filter(c=>!q||String(c.username).toLowerCase().includes(q)||String(c.displayName||'').toLowerCase().includes(q)).sort((a,b)=>b.followers-a.followers||b.sales-a.sales).slice(0,50);
        return send(res,200,{packs:packs.slice(0,100),creators,categories:[...new Set(db.creatorPacks.map(x=>x.category||'General'))].sort()});
      }
      if(req.method==='GET' && u.pathname.startsWith('/api/creator/storefront/')){
        const target=decodeURIComponent(u.pathname.split('/').pop()).toLowerCase(),c=db.creators[target];if(!c)return send(res,404,{error:'Creator not found.'});
        const packs=db.creatorPacks.filter(x=>x.creator===target&&x.status==='published').map(x=>{const rs=db.creatorReviews.filter(r=>r.packId===x.id);return {...x,words:undefined,reviewCount:rs.length,rating:rs.length?Number((rs.reduce((a,r)=>a+r.rating,0)/rs.length).toFixed(1)):0}});
        const followers=Object.values(db.creatorFollows||{}).filter(a=>(a||[]).includes(target)).length;const following=(db.creatorFollows[username]||[]).includes(target);return send(res,200,{creator:{...c,followers,following},packs,followers});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/follow/')){
        const target=decodeURIComponent(u.pathname.split('/').pop()).toLowerCase();if(!db.creators[target])return send(res,404,{error:'Creator not found.'});if(target===username)return send(res,400,{error:'You cannot follow yourself.'});db.creatorFollows[username]=db.creatorFollows[username]||[];const set=new Set(db.creatorFollows[username]);set.has(target)?set.delete(target):set.add(target);db.creatorFollows[username]=[...set];saveDb();return send(res,200,{following:set.has(target),followers:Object.values(db.creatorFollows).filter(a=>(a||[]).includes(target)).length});
      }
      if(req.method==='GET' && u.pathname.startsWith('/api/creator/reviews/')){
        const pid=decodeURIComponent(u.pathname.split('/').pop());const reviews=db.creatorReviews.filter(r=>r.packId===pid).slice().reverse().slice(0,100);return send(res,200,{reviews});
      }
      if(req.method==='POST' && u.pathname.startsWith('/api/creator/reviews/')){
        const pid=decodeURIComponent(u.pathname.split('/').pop()),pack=db.creatorPacks.find(x=>x.id===pid&&x.status==='published');if(!pack)return send(res,404,{error:'Pack not found.'});if(!db.creatorPurchases.some(x=>x.packId===pid&&x.buyer===username))return send(res,403,{error:'Unlock the pack before reviewing it.'});const b=await jsonBody(req),rating=Math.round(Number(b.rating)),body=String(b.body||'').trim().slice(0,500);if(rating<1||rating>5)return send(res,400,{error:'Rating must be 1 to 5.'});const existing=db.creatorReviews.find(x=>x.packId===pid&&x.username===username);if(existing){existing.rating=rating;existing.body=body;existing.updatedAt=Date.now()}else db.creatorReviews.push({id:id(),packId:pid,creator:pack.creator,username,rating,body,createdAt:Date.now()});saveDb();return send(res,200,{ok:true});
      }
      if(req.method==='GET' && u.pathname==='/api/creator/recommendations'){
        const follows=db.creatorFollows[username]||[],owned=db.creatorPurchases.filter(x=>x.buyer===username).map(x=>x.packId);const candidates=db.creatorPacks.filter(x=>x.status==='published'&&!owned.includes(x.id));const ranked=candidates.map(x=>{let score=(x.sales||0)*0.5+(x.views||0)*0.05;if(follows.includes(x.creator))score+=1000;const rs=db.creatorReviews.filter(r=>r.packId===x.id);if(rs.length)score+=(rs.reduce((a,r)=>a+r.rating,0)/rs.length)*10;return {...x,words:undefined,score,creatorName:db.creators[x.creator]?.displayName||x.creator,creatorVerified:Boolean(db.creators[x.creator]?.verified),category:x.category||'General'}}).sort((a,b)=>b.score-a.score).slice(0,30);return send(res,200,{packs:ranked});
      }

      if(req.method==='POST' && u.pathname==='/api/appeals'){
        const b=await jsonBody(req);const reason=String(b.reason||'').trim();if(!reason||reason.length>1000)return send(res,400,{error:'Appeal reason is required.'});db.appeals=db.appeals||[];if(db.appeals.some(x=>x.username===username&&x.status==='open'))return send(res,409,{error:'You already have an open appeal.'});const a={id:id(),username,reason,status:'open',createdAt:Date.now()};db.appeals.push(a);saveDb();return send(res,200,{appeal:a});
      }
      if(req.method==='PUT' && u.pathname==='/api/profile/privacy'){
        const b=await jsonBody(req);db.privacy[username]={private:Boolean(b.private)};saveDb();return send(res,200,{privacy:db.privacy[username]});
      }
      if(req.method==='PUT' && u.pathname==='/api/state'){const b=await jsonBody(req);mergeState(username,b.state||{});return send(res,200,{state:stateFor(username)});}
      return send(res,404,{error:'API route not found.'});
    }
    let file=decodeURIComponent(u.pathname);if(file==='/'||file==='')file='/index.html';const full=path.normalize(path.join(ROOT,file));if(!full.startsWith(ROOT))return send(res,403,'Forbidden');
    fs.readFile(full,(e,data)=>{if(e)return send(res,404,'Not found');const ext=path.extname(full);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});res.end(data)})
  }catch(e){console.error(e);send(res,500,{error:'Server error.'})}
});
const shutdown=(signal)=>{if(shuttingDown)return;shuttingDown=true;console.log(`${signal}: shutting down`);for(const set of sseClients.values())for(const res of set){try{res.end()}catch{}};saveDb();server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),8000).unref()};process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
setInterval(()=>{let changed=false;for(const g of Object.values(db.puzzleGames||{})){if(g.status==='playing'&&g.turnEndsAt<=Date.now()){advancePuzzle(g);g.updatedAt=Date.now();changed=true;for(const p of g.players)broadcast(p,'puzzleUpdate',{gameId:g.id})}}if(changed)saveDb()},250);

server.listen(PORT,()=>console.log(`WHO SABI ME? v40 running on http://localhost:${PORT}`));
