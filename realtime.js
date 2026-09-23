/* Realtime transport helper. SSE is already used by the app; this adds
 * heartbeat/reconnect metadata without requiring a browser WebSocket dependency. */
const HEARTBEAT_MS = Math.max(10000, Number(process.env.SSE_HEARTBEAT_MS || 25000));
function heartbeat(res){
  const timer=setInterval(()=>{ try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { clearInterval(timer); } },HEARTBEAT_MS);
  return ()=>clearInterval(timer);
}
function retryHint(res,ms=2000){ try { res.write(`retry: ${Math.max(500,ms)}\n\n`); } catch {} }
module.exports={HEARTBEAT_MS,heartbeat,retryHint};
