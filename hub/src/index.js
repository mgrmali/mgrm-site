/* 맹그라미 업무 허브 — hub.mgrm.kr Worker
   화면(public/)을 내보내고, 모든 저장은 NAS 저장 서버(hub/nas/server.js)로 넘깁니다.

   로그인   : QNAP 계정. NAS 가 확인해 주면 .mgrm.kr 전체에 쓰는 쿠키를 발급
              (컬러 다이어리도 같은 쿠키를 알아봅니다)
   NAS 꺼짐 : 로그인·허브 화면은 안내만 띄우고,
              외부 정산 정보 제출은 D1 에 잠근 채로 보관했다가 NAS 가 켜지면 넘깁니다 */

const COOKIE = 'mgrm_sess';
const COOKIE_DOMAIN = '.mgrm.kr';
const IDLE = 30 * 60;                 // 30분 무활동이면 다시 로그인
const MAX = 60 * 60 * 14;             // 아무리 길어도 14시간
const PUBLIC_FILES = ['/submit.html', '/wct-style.css', '/wct-core.js', '/favicon.png', '/logo.png',
                      '/login.html', '/login'];
const enc = new TextEncoder();

export default {
  async fetch(req, env, ctx) {
    try { return await handle(req, env, ctx); }
    catch (e) { console.error(e); return json({ ok: false, error: 'server' }, 500); }
  },
  // 10분마다: NAS 가 꺼져 있을 때 받아 둔 제출물을 NAS 로 넘깁니다
  async scheduled(ev, env, ctx) { ctx.waitUntil(flush(env)); },
};

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname;
  COOKIE_HOST = url.hostname;
  const miss = ['STORE_URL', 'STORE_TOKEN', 'SESSION_SECRET'].filter((k) => !env[k]);
  if (miss.length) return text(`설정이 덜 됐어요: Cloudflare 비밀 값 ${miss.join(', ')} 를 넣어주세요.`, 500);

  if (p === '/api/login' && req.method === 'POST') return login(req, env);
  if (p === '/api/logout') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  // 회사 홈페이지(mgrm.kr)의 리뷰·납품·문진·문의 폼이 여기로 보냅니다 → 교차 출처 허용
  if (p === '/api/public' && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (p === '/api/public' && req.method === 'POST') {
    const r = await pub(req, env, ctx);
    const out = new Response(r.body, r);
    Object.entries(cors(req)).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  }
  if (p === '/api/health') return health(env);
  if (p === '/' ) return Response.redirect(new URL('/admin.html', url).toString(), 302);
  if (p === '/login') return env.ASSETS.fetch(new Request(new URL('/login.html', url), req));
  if (PUBLIC_FILES.includes(p)) return env.ASSETS.fetch(req);

  const who = await session(env, getCookie(req, COOKIE));
  if (!who) {
    if (p.startsWith('/api/')) return json({ ok: false, error: '로그인이 필요합니다.', relogin: true }, 401);
    return Response.redirect(new URL('/login?next=' + encodeURIComponent(p.slice(1)), url).toString(), 302);
  }

  if (p === '/api/rpc' && req.method === 'POST') return rpc(req, env, who);
  if (p === '/api/export') return exportCsv(req, env, who, url);
  if ((p === '/api/import' || p === '/api/initkeys') && req.method === 'POST') return relay(req, env, who, p.replace('/api', ''));
  if (p.startsWith('/api/')) return json({ ok: false, error: 'not found' }, 404);

  // 화면 — 활동할 때마다 쿠키 만료를 늘려 줍니다
  const res = await env.ASSETS.fetch(req);
  const out = new Response(res.body, res);
  out.headers.append('set-cookie', cookie(await makeToken(env, who, who.iat), IDLE));
  return out;
}

/* ───────── NAS 연결 */
class NasError extends Error {}
async function store(env, path, body, extraHeaders) {
  const h = Object.assign({ 'x-store-token': env.STORE_TOKEN, 'content-type': 'application/json' }, extraHeaders || {});
  let r;
  try {
    r = await fetch(env.STORE_URL.replace(/\/$/, '') + path,
      { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(path === '/import' ? 120000 : 25000) });
  } catch (e) { throw new NasError('NAS에 연결할 수 없어요'); }
  if (r.status === 530 || r.status === 502 || r.status === 503 || r.status === 504) throw new NasError('NAS에 연결할 수 없어요');
  return r;
}
const NAS_DOWN = { ok: false, error: 'NAS에 연결할 수 없어요. NAS와 인터넷이 켜져 있는지 확인해 주세요.', nas: 'down' };

async function health(env) {
  try { const r = await store(env, '/health'); return json({ ok: true, nas: await r.json() }); }
  catch { return json({ ok: false, nas: 'down' }); }
}

/* ───────── 로그인 */
async function login(req, env) {
  let b = {};
  try { b = await req.json(); } catch {}
  let r;
  try {
    r = await (await store(env, '/auth', { user: String(b.user || '').trim(), pw: String(b.pw || ''),
      ip: req.headers.get('cf-connecting-ip') || '' })).json();
  } catch (e) { return json(NAS_DOWN, 503); }
  if (!r.ok) { await new Promise((f) => setTimeout(f, 600)); return json(r, 401); }
  const who = { user: r.user, name: r.name || r.user, role: r.role };
  return json({ ok: true, me: who }, 200, { 'set-cookie': cookie(await makeToken(env, who), IDLE) });
}

async function rpc(req, env, who) {
  let b = {};
  try { b = await req.json(); } catch {}
  b._who = who;
  b._ip = req.headers.get('cf-connecting-ip') || '';
  let r;
  try { r = await (await store(env, '/rpc', b)).json(); }
  catch (e) { return json(NAS_DOWN, 503); }
  if (r && r.relogin) return json(r, 401, { 'set-cookie': cookie('', 0) });
  return json(r);
}

async function relay(req, env, who, path) {
  if (who.role !== 'admin') return json({ ok: false, error: '관리자만 할 수 있습니다.' }, 403);
  let b = {};
  try { b = await req.json(); } catch {}
  b._who = who; b._ip = req.headers.get('cf-connecting-ip') || '';
  try { return json(await (await store(env, path, b)).json()); }
  catch { return json(NAS_DOWN, 503); }
}

async function exportCsv(req, env, who, url) {
  if (who.role !== 'admin') return json({ ok: false, error: '관리자만' }, 403);
  const sheet = url.searchParams.get('sheet') || '';
  try {
    const r = await store(env, '/export?sheet=' + encodeURIComponent(sheet), undefined, { 'x-hub-who': JSON.stringify(who) });
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(sheet)}.csv` } });
  } catch { return json(NAS_DOWN, 503); }
}

const ALLOWED_ORIGINS = ['https://mgrm.kr', 'https://www.mgrm.kr', 'https://hub.mgrm.kr', 'https://diary.mgrm.kr'];
function cors(req) {
  const o = req.headers.get('origin') || '';
  const ok = ALLOWED_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok ? { 'access-control-allow-origin': o, 'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', 'vary': 'origin' } : {};
}
// NAS 가 꺼져 있어도 받아 둘 수 있는 요청 (나중에 그대로 다시 보냄)
const QUEUEABLE = ['submit', 'review.comment', 'delivery.record', 'intake', 'inquiry'];
function pubAction(b) {
  if (b.action) return String(b.action);
  if (b.token && b.envelope) return 'submit';
  const kind = String(b['_폼종류'] || '');
  if (kind === '리뷰코멘트') return 'review.comment';
  if (kind === '납품기록') return 'delivery.record';
  if (kind === '작업문의') return 'inquiry';
  if (b['담당자'] || b['프로젝트명']) return 'intake';
  return '';
}

/* ───────── 외부 공개 (정산 정보 제출 · 리뷰 · 납품 · 문진 · 문의) */
async function pub(req, env, ctx) {
  let b = {};
  try { b = await req.json(); } catch {}
  const a = pubAction(b);
  try {
    const r = await (await store(env, '/public', Object.assign({}, b, { action: a }))).json();
    if (a === 'pubkey' && r.ok && r.pub) ctx.waitUntil(kvSet(env, 'pub', r.pub));
    if (a === 'company' && r.ok) ctx.waitUntil(kvSet(env, 'company', JSON.stringify(r.company)));
    if (a === 'check' && r.ok) ctx.waitUntil(kvSet(env, 'inv:' + b.t, '1'));
    // 방금 NAS 가 살아났을 수 있으니 밀린 제출물도 넘겨 봅니다
    ctx.waitUntil(flush(env));
    return json(r);
  } catch (e) {
    if (!(e instanceof NasError)) throw e;
  }
  // ── NAS 가 꺼져 있을 때: 제출은 받아 두고, 나머지는 기억해 둔 값으로 답합니다
  if (a === 'pubkey') { const pub = await kvGet(env, 'pub'); return json(pub ? { ok: true, pub } : NAS_DOWN); }
  if (a === 'company') { const c = await kvGet(env, 'company'); return json(c ? { ok: true, company: JSON.parse(c) } : NAS_DOWN); }
  if (a === 'status') return json({ ok: true, initialized: !!(await kvGet(env, 'pub')), saltAuth: '' });
  if (a === 'check') {
    // 전에 한 번 확인됐던 링크면 열어 줍니다 (최종 확인은 NAS 가 살아난 뒤)
    const seen = await kvGet(env, 'inv:' + b.t);
    return json(seen ? { ok: true, label: '', role: '', offline: true } : NAS_DOWN);
  }
  if (QUEUEABLE.includes(a)) {
    if (a === 'submit' && (!b.token || !b.envelope || !b.envelope.ct)) return json({ ok: false, error: '제출 형식이 올바르지 않습니다.' });
    const body = JSON.stringify(Object.assign({}, b, { action: a, receivedAt: kstNow() }));
    if (body.length > 9.5 * 1024 * 1024) return json({ ok: false, error: '첨부 용량이 너무 큽니다. 사진 장수를 줄여주세요.' });
    await env.DB.prepare('INSERT INTO pending (at, body) VALUES (?, ?)').bind(kstNow(), body).run();
    // 문진·문의는 접수번호를 바로 못 주니 임시 번호를 돌려줍니다
    return json({ ok: true, queued: true, no: a === 'intake' || a === 'inquiry' ? '접수 대기' : undefined });
  }
  return json(NAS_DOWN);
}

/* 밀린 제출물을 NAS 로 넘깁니다. 한 번에 20건. */
async function flush(env) {
  if (!env.DB) return;
  const rows = (await env.DB.prepare('SELECT id, body FROM pending ORDER BY id LIMIT 20').all()).results || [];
  for (const row of rows) {
    let r;
    try { r = await (await store(env, '/public', JSON.parse(row.body))).json(); }
    catch { return; }   // 아직 안 켜졌으면 다음 기회에
    // NAS 가 받았거나(ok) 링크가 무효해서 거절했으면(ok:false) 둘 다 큐에서 뺍니다. 거절 사유는 기록으로 남깁니다.
    await env.DB.prepare('DELETE FROM pending WHERE id = ?').bind(row.id).run();
    if (!r.ok) await env.DB.prepare('INSERT INTO pending_failed (at, body, error) VALUES (?, ?, ?)')
      .bind(kstNow(), row.body.slice(0, 2000), String(r.error || '')).run();
  }
}

async function kvGet(env, k) {
  if (!env.DB) return '';
  const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return r ? r.v : '';
}
async function kvSet(env, k, v) {
  if (!env.DB) return;
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
}

/* ───────── 세션 쿠키 (컬러 다이어리와 같은 형식: v2.만료.아이디.역할.이름.서명) */
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
function b64url(buf) {
  let s = ''; const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64e = (s) => b64url(enc.encode(s));
const b64d = (s) => { try { return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); } catch { return ''; } };
function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeToken(env, who, issued) {
  const now = Math.floor(Date.now() / 1000);
  const iat = issued || now;
  const exp = Math.min(now + IDLE, iat + MAX);
  const body = `v2.${exp}.${iat}.${b64e(who.user)}.${who.role}.${b64e(who.name || '')}`;
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}
async function session(env, t) {
  if (!t) return null;
  const parts = t.split('.');
  if (parts.length !== 7 || parts[0] !== 'v2') return null;
  if (!(+parts[1] > Date.now() / 1000)) return null;
  if (!same(await hmac(env.SESSION_SECRET, parts.slice(0, 6).join('.')), parts[6])) return null;
  return { user: b64d(parts[3]), role: parts[4], name: b64d(parts[5]), iat: +parts[2] };
}
let COOKIE_HOST = '';   // 요청 호스트 (mgrm.kr 아래일 때만 Domain 을 붙임 — 로컬 시험용)
function cookie(v, age) {
  const dom = COOKIE_HOST.endsWith('mgrm.kr') ? `Domain=${COOKIE_DOMAIN}; ` : '';
  return `${COOKIE}=${v}; ${dom}Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}
function getCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
function json(o, status = 200, headers = {}) {
  return new Response(JSON.stringify(o), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers) });
}
function text(s, status = 200) { return new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } }); }
