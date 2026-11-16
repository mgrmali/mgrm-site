/* 맹그라미 업무 허브 — Claude 커넥터 (MCP)
   claude.ai 에 커스텀 커넥터로 등록하면 Claude 가 허브 프로젝트·작업·회차를 읽고,
   작업을 추가하거나 완료 표시를 할 수 있습니다.

   주소     : https://hub.mgrm.kr/mcp
   로그인   : OAuth. 연결할 때 한 번 QNAP 계정으로 로그인 (허브 로그인과 같은 계정)
   막아 둔 것: 원천징수·지급·급여·매출·매입·금고·인력·거래처·계약금액, 문진·문의의 연락처
              → 이 파일은 프로젝트·작업·회차·문진/문의 요약만 꺼내 보냅니다
   끊기     : 허브 그룹(hub-admin / hub-staff)에서 계정을 빼면 바로 막힘
              전체를 한 번에 끊으려면 Cloudflare 변수 MCP_VER 를 다른 값으로 (예 2) */

const ACCESS_TTL = 60 * 60;              // 출입증 1시간
const REFRESH_TTL = 60 * 60 * 24 * 90;   // 갱신권 90일 (쓸 때마다 다시 90일)
const CODE_TTL = 5 * 60;
const STAGES = ['프리', '프로덕션', '포스트', '완료'];
const CALS = ['MGRM촬영', 'MGRM구성', 'MGRM편집', 'MGRM D.I', 'MGRM스케줄'];
// 연결을 허락할 돌아갈 주소 (claude.ai 커넥터만)
const REDIRECT_HOSTS = ['claude.ai', 'claude.com'];
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function isMcpPath(p) {
  return p === '/mcp' || p.startsWith('/oauth/') || p.startsWith('/.well-known/oauth-');
}

export async function handleMcp(req, env, url, h) {
  const p = url.pathname;
  const origin = url.origin;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: openCors() });

  if (p.startsWith('/.well-known/oauth-protected-resource')) {
    return out(h, { resource: origin + '/mcp', authorization_servers: [origin],
      bearer_methods_supported: ['header'], resource_name: '맹그라미 업무 허브' });
  }
  if (p.startsWith('/.well-known/oauth-authorization-server')) {
    return out(h, { issuer: origin,
      authorization_endpoint: origin + '/oauth/authorize',
      token_endpoint: origin + '/oauth/token',
      registration_endpoint: origin + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['hub'] });
  }
  if (p === '/oauth/register' && req.method === 'POST') return register(req, env, h);
  if (p === '/oauth/authorize' && req.method === 'GET') return authorizePage(env, url, h);
  if (p === '/oauth/authorize' && req.method === 'POST') return authorizePost(req, env, h);
  if (p === '/oauth/token' && req.method === 'POST') return token(req, env, h);
  if (p === '/mcp') return mcp(req, env, origin, h);
  return out(h, { error: 'not_found' }, 404);
}

/* ───────── 서명된 표 (클라이언트·인증코드·출입증·갱신권 모두 같은 방식) */
async function seal(env, h, kind, obj) {
  const body = kind + '.' + h.b64e(JSON.stringify(obj));
  return body + '.' + await h.hmac(env.SESSION_SECRET, 'mcp|' + body);
}
async function open(env, h, kind, t) {
  const parts = String(t || '').split('.');
  if (parts.length !== 3 || parts[0] !== kind) return null;
  const sig = await h.hmac(env.SESSION_SECRET, 'mcp|' + parts[0] + '.' + parts[1]);
  if (!h.same(sig, parts[2])) return null;
  let o; try { o = JSON.parse(h.b64d(parts[1])); } catch { return null; }
  if (!o || (o.exp && o.exp < now())) return null;
  if (kind !== 'mc1' && String(o.v || '1') !== ver(env)) return null;
  return o;
}
const now = () => Math.floor(Date.now() / 1000);
const ver = (env) => String(env.MCP_VER || '1');

/* ───────── 1. 클라이언트 등록 (claude.ai 가 자동으로 함) */
function okRedirect(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && REDIRECT_HOSTS.some((d) => x.hostname === d || x.hostname.endsWith('.' + d));
  } catch { return false; }
}
async function register(req, env, h) {
  let b = {};
  try { b = await req.json(); } catch {}
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || !uris.every(okRedirect)) {
    return out(h, { error: 'invalid_redirect_uri', error_description: 'claude.ai 커넥터만 연결할 수 있습니다.' }, 400);
  }
  const name = String(b.client_name || 'Claude').slice(0, 60);
  const client_id = await seal(env, h, 'mc1', { r: uris, n: name });
  return out(h, { client_id, client_name: name, redirect_uris: uris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], client_id_issued_at: now() }, 201);
}

/* ───────── 2. 로그인 화면 */
async function checkAuthParams(env, h, q) {
  const c = await open(env, h, 'mc1', q.client_id);
  if (!c) return { err: '등록되지 않은 연결 요청입니다. claude.ai 에서 커넥터를 다시 추가해 주세요.' };
  if (!q.redirect_uri || !c.r.includes(q.redirect_uri)) return { err: '돌아갈 주소가 맞지 않습니다.' };
  if (q.response_type !== 'code') return { err: '지원하지 않는 요청 방식입니다.' };
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return { err: '보안 코드(PKCE)가 없는 요청입니다.' };
  return { client: c };
}
const KEYS = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];

async function authorizePage(env, url, h) {
  const q = {}; KEYS.forEach((k) => { q[k] = url.searchParams.get(k) || ''; });
  const chk = await checkAuthParams(env, h, q);
  if (chk.err) return page(chk.err, null, null, 400);
  return page('', q, chk.client.n);
}

async function authorizePost(req, env, h) {
  let f;
  try { f = await req.formData(); } catch { return page('요청을 읽지 못했어요.', null, null, 400); }
  const q = {}; KEYS.forEach((k) => { q[k] = String(f.get(k) || ''); });
  const chk = await checkAuthParams(env, h, q);
  if (chk.err) return page(chk.err, null, null, 400);
  const user = String(f.get('user') || '').trim(), pw = String(f.get('pw') || '');
  if (!user || !pw) return page('아이디와 비밀번호를 입력하세요.', q, chk.client.n, 400);
  let r;
  try {
    r = await (await h.store(env, '/auth', { user, pw, ip: req.headers.get('cf-connecting-ip') || '' })).json();
  } catch { return page('NAS에 연결할 수 없어요. NAS와 인터넷이 켜져 있는지 확인해 주세요.', q, chk.client.n, 503); }
  if (!r.ok) {
    await new Promise((x) => setTimeout(x, 600));
    return page(r.error || '아이디 또는 비밀번호가 맞지 않습니다.', q, chk.client.n, 401);
  }
  const code = await seal(env, h, 'oc1', { c: q.client_id.slice(-24), r: q.redirect_uri, ch: q.code_challenge,
    u: r.user, n: r.name || r.user, ro: r.role, v: ver(env), exp: now() + CODE_TTL });
  const back = new URL(q.redirect_uri);
  back.searchParams.set('code', code);
  if (q.state) back.searchParams.set('state', q.state);
  return Response.redirect(back.toString(), 302);
}

/* ───────── 3. 출입증 발급 */
async function token(req, env, h) {
  let b = {};
  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) b = await req.json();
    else { const f = await req.formData(); f.forEach((v, k) => { b[k] = String(v); }); }
  } catch {}
  const basic = (req.headers.get('authorization') || '').match(/^Basic\s+(.+)$/i);
  if (basic && !b.client_id) { try { b.client_id = decodeURIComponent(atob(basic[1]).split(':')[0]); } catch {} }
  const bad = (d) => out(h, { error: 'invalid_grant', error_description: d }, 400);
  if (!(await open(env, h, 'mc1', b.client_id))) return out(h, { error: 'invalid_client' }, 401);
  const cid = String(b.client_id).slice(-24);

  let who;
  if (b.grant_type === 'authorization_code') {
    const c = await open(env, h, 'oc1', b.code);
    if (!c || c.c !== cid || c.r !== b.redirect_uri) return bad('인증 코드가 맞지 않습니다.');
    if (!b.code_verifier || await sha256(b.code_verifier) !== c.ch) return bad('보안 코드가 맞지 않습니다.');
    // 한 번 쓴 코드는 다시 못 씀
    const key = 'mcp:code:' + String(b.code).split('.')[2];
    if (env.DB) {
      const seen = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(key).first();
      if (seen) return bad('이미 사용한 인증 코드입니다.');
      await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').bind(key, String(c.exp)).run();
      await env.DB.prepare("DELETE FROM kv WHERE k LIKE 'mcp:code:%' AND CAST(v AS INTEGER) < ?").bind(now()).run();
    }
    who = { u: c.u, n: c.n, ro: c.ro };
  } else if (b.grant_type === 'refresh_token') {
    const rt = await open(env, h, 'rt1', b.refresh_token);
    if (!rt || rt.c !== cid) return bad('갱신권이 만료됐거나 맞지 않습니다. 커넥터를 다시 연결해 주세요.');
    who = { u: rt.u, n: rt.n, ro: rt.ro };
  } else {
    return out(h, { error: 'unsupported_grant_type' }, 400);
  }
  const base = { c: cid, u: who.u, n: who.n, ro: who.ro, v: ver(env) };
  return out(h, {
    access_token: await seal(env, h, 'at1', Object.assign({ exp: now() + ACCESS_TTL }, base)),
    token_type: 'Bearer', expires_in: ACCESS_TTL, scope: 'hub',
    refresh_token: await seal(env, h, 'rt1', Object.assign({ exp: now() + REFRESH_TTL }, base)),
  });
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let x = ''; new Uint8Array(d).forEach((c) => { x += String.fromCharCode(c); });
  return btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ───────── 4. MCP 본체 */
async function mcp(req, env, origin, h) {
  const meta = origin + '/.well-known/oauth-protected-resource';
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  const at = m ? await open(env, h, 'at1', m[1].trim()) : null;
  if (!at) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: Object.assign(openCors(), {
      'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${meta}"` }) });
  }
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const who = { user: at.u, name: at.n, role: at.ro };
  let msg;
  try { msg = await req.json(); } catch { return rpcOut([rpcErr(null, -32700, 'Parse error')]); }
  const list = Array.isArray(msg) ? msg : [msg];
  const replies = [];
  for (const one of list) {
    const r = await dispatch(one, env, who, req, h);
    if (r) replies.push(r);
  }
  if (!replies.length) return new Response(null, { status: 202, headers: openCors() });
  return rpcOut(Array.isArray(msg) ? replies : replies[0]);
}
const rpcOut = (o) => new Response(JSON.stringify(o), { headers: Object.assign(openCors(),
  { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }) });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(m, env, who, req, h) {
  if (!m || typeof m !== 'object') return rpcErr(null, -32600, 'Invalid Request');
  const id = m.id === undefined ? null : m.id;
  if (m.id === undefined) return null;              // 알림(notifications/*) 은 답하지 않음
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion;
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mgrm-hub', title: '맹그라미 업무 허브', version: '1.0.0' },
        instructions: '맹그라미 업무 허브(hub.mgrm.kr)의 프로젝트·작업·촬영 회차를 읽고 작업을 추가·완료할 수 있습니다. '
          + '하루 요약은 hub_today, 프로젝트 목록은 hub_projects, 한 프로젝트 자세히는 hub_project. 날짜는 한국 시간(YYYY-MM-DD).' } };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = m.params && m.params.name;
      const args = (m.params && m.params.arguments) || {};
      const fn = RUN[name];
      if (!fn) return rpcErr(id, -32602, '없는 도구: ' + name);
      let res;
      try { res = await fn(args, env, who, req, h); }
      catch (e) { res = { error: e && e.message ? e.message : String(e) }; }
      const isError = !!(res && res.error);
      return { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify(res, null, 1) }],
        structuredContent: res, isError } };
    }
    default: return rpcErr(id, -32601, 'Method not found: ' + m.method);
  }
}

/* ───────── 도구 */
const TOOLS = [
  { name: 'hub_today', title: '허브 하루 요약',
    description: '오늘(한국 시간) 기준 허브 요약: 마감 지난 미완료 작업, 며칠 안에 마감인 작업, 진행 중 프로젝트의 단계·마감, '
      + '다가오는 촬영 회차, 안 읽은 문진·문의. 브리프나 "오늘 뭐 해야 돼?" 같은 질문에 사용.',
    inputSchema: { type: 'object', properties: {
      date: { type: 'string', description: '기준일 YYYY-MM-DD (비우면 오늘). 저녁 브리프처럼 내일 기준으로 볼 때 내일 날짜를 넣음' },
      days: { type: 'integer', description: '임박 작업으로 볼 기간(일). 기본 3', minimum: 0, maximum: 30 },
      shoot_days: { type: 'integer', description: '다가오는 회차로 볼 기간(일). 기본 7', minimum: 0, maximum: 60 } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'hub_projects', title: '허브 프로젝트 목록',
    description: '허브 프로젝트 목록 (이름·코드·클라이언트·단계·시작일·마감일·남은 작업 수). 기본은 진행 중(완료·비활성 제외).',
    inputSchema: { type: 'object', properties: {
      include_done: { type: 'boolean', description: '완료·비활성 프로젝트도 포함' },
      query: { type: 'string', description: '이름·코드·클라이언트에 들어간 글자로 거르기' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'hub_project', title: '허브 프로젝트 자세히',
    description: '프로젝트 하나의 정보와 작업 전체, 촬영 회차 전체. project 에 ID·코드·이름 일부를 넣음.',
    inputSchema: { type: 'object', required: ['project'], properties: {
      project: { type: 'string', description: '프로젝트 ID, 코드(예 KIAT), 또는 이름 일부' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'hub_add_task', title: '허브 작업 추가',
    description: '프로젝트에 작업을 추가. calendar 를 지정하면 그 MGRM 캘린더에 마감일이 들어감 (허브가 자동 동기화).',
    inputSchema: { type: 'object', required: ['project', 'title'], properties: {
      project: { type: 'string', description: '프로젝트 ID, 코드, 또는 이름 일부' },
      title: { type: 'string', description: '작업 제목' },
      due: { type: 'string', description: '마감일 YYYY-MM-DD' },
      start: { type: 'string', description: '시작일 YYYY-MM-DD (구간으로 넣을 때만)' },
      stage: { type: 'string', enum: STAGES.slice(0, 3), description: '단계 (기본: 프로젝트의 현재 단계)' },
      assignee: { type: 'string', description: '담당' },
      calendar: { type: 'string', enum: CALS, description: '마감일을 넣을 캘린더 (비우면 캘린더에 안 넣음)' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'hub_update_task', title: '허브 작업 수정·완료',
    description: '작업 완료 표시(done), 마감일·제목·담당 변경. task_id 는 hub_project / hub_today 결과의 작업 id.',
    inputSchema: { type: 'object', required: ['task_id'], properties: {
      task_id: { type: 'integer' },
      done: { type: 'boolean', description: '완료면 true, 되돌리면 false' },
      due: { type: 'string', description: '새 마감일 YYYY-MM-DD' },
      title: { type: 'string' }, assignee: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
];

/* NAS 에서 허브 전체를 받아 오되, 여기서 필요한 칸만 남깁니다 */
async function load(env, who, req, h) {
  let r;
  try {
    r = await (await h.store(env, '/rpc', { action: 'bootstrap', _who: who, _ip: req.headers.get('cf-connecting-ip') || '' })).json();
  } catch { throw new Error('NAS에 연결할 수 없어요. NAS와 인터넷이 켜져 있는지 확인해 주세요.'); }
  if (!r || !r.ok) throw new Error((r && r.error) || '허브를 읽지 못했어요.');
  const projects = (r.projects || []).map((p) => ({ id: p.id, name: p.name, code: p.code, client: p.client,
    stage: p.stage, start: p.start, due: p.due, owner: p.owner, memo: p.memo, active: p.active, folder: p.folder }));
  const pmap = new Map(projects.map((p) => [p.id, p]));
  const tasks = (r.tasks || []).map((t) => ({ id: t.id, projectId: t.projectId, stage: t.stage, title: t.title,
    assignee: t.assignee, start: t.start, due: t.due, done: t.done, order: t.order,
    calendar: t.cal ? (t.calName || 'MGRM스케줄') : '' }));
  const shoots = (r.shoots || []).map((s) => ({ id: s.id, projectId: s.projectId, no: s.no, date: s.date,
    place: s.place, addr: s.addr, call: s.call, note: s.note, status: s.status }));
  const admin = r.role === 'admin';
  const rv = (admin && r.reviews) || {};
  // 문진·문의: 연락처·이메일은 빼고 무엇이 들어왔는지만
  const intakes = (rv.intakes || []).filter((x) => !x['읽음']).map((x) => ({ no: x['접수번호'], at: x['접수시각'],
    company: x['회사명'], project: x['프로젝트명'], kind: x['영상 종류'], runtime: x['러닝타임'],
    wantDate: x['납품 희망일'], status: x['진행 상태'] }));
  const inquiries = (rv.inquiries || []).filter((x) => !x['읽음']).map((x) => ({ no: x['접수번호'], at: x['접수시각'],
    from: x['이름/회사'], field: x['문의 분야'], summary: String(x['내용'] || '').replace(/\s+/g, ' ').slice(0, 120),
    status: x['진행 상태'] }));
  return { projects, pmap, tasks, shoots, intakes, inquiries, admin };
}

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const live = (p) => p && p.active !== false && p.stage !== '완료';
const label = (p) => p ? (p.code ? `[${p.code}] ` : '') + p.name : '(프로젝트 없음)';

function findProject(d, q) {
  const s = String(q || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s) && d.pmap.has(Number(s))) return d.pmap.get(Number(s));
  const low = s.toLowerCase();
  const code = d.projects.filter((p) => p.code && p.code.toLowerCase() === low);
  if (code.length) return code[0];
  const hit = d.projects.filter((p) => (p.name + ' ' + p.client).toLowerCase().includes(low));
  const pick = hit.filter(live);
  return (pick.length ? pick : hit)[0] || null;
}

const RUN = {
  async hub_today(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    const today = isDate(a.date) ? a.date : kstToday();
    const days = Number.isInteger(a.days) ? a.days : 3;
    const sdays = Number.isInteger(a.shoot_days) ? a.shoot_days : 7;
    const soon = addDays(today, days), shootEnd = addDays(today, sdays);
    const todo = d.tasks.filter((t) => !t.done && live(d.pmap.get(t.projectId)));
    const row = (t) => ({ id: t.id, project: label(d.pmap.get(t.projectId)), title: t.title, stage: t.stage,
      due: t.due, assignee: t.assignee, calendar: t.calendar });
    const overdue = todo.filter((t) => isDate(t.due) && t.due < today)
      .sort((x, y) => x.due.localeCompare(y.due)).map((t) => Object.assign(row(t), { daysLate: diffDays(today, t.due) }));
    const dueSoon = todo.filter((t) => isDate(t.due) && t.due >= today && t.due <= soon)
      .sort((x, y) => x.due.localeCompare(y.due)).map((t) => Object.assign(row(t), { daysLeft: diffDays(t.due, today) }));
    const projects = d.projects.filter(live).map((p) => {
      const mine = todo.filter((t) => t.projectId === p.id).sort((x, y) =>
        (x.due || '9999').localeCompare(y.due || '9999') || x.order - y.order);
      return { id: p.id, project: label(p), client: p.client, stage: p.stage, start: p.start, due: p.due,
        daysToDue: isDate(p.due) ? diffDays(p.due, today) : null, openTasks: mine.length,
        nextTask: mine[0] ? { id: mine[0].id, title: mine[0].title, due: mine[0].due } : null };
    }).sort((x, y) => (x.due || '9999').localeCompare(y.due || '9999'));
    const shoots = d.shoots.filter((s) => isDate(s.date) && s.date >= today && s.date <= shootEnd
      && live(d.pmap.get(s.projectId)))
      .sort((x, y) => x.date.localeCompare(y.date))
      .map((s) => ({ project: label(d.pmap.get(s.projectId)), no: s.no, date: s.date, place: s.place,
        call: s.call, status: s.status }));
    const res = { date: today, note: '마감일이 있는 작업 중 calendar 칸이 채워진 것과 촬영 회차는 MGRM 캘린더에도 들어가 있음',
      overdue, dueSoon, projects, shoots };
    if (d.admin) { res.newIntakes = d.intakes; res.newInquiries = d.inquiries; }
    return res;
  },

  async hub_projects(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    const q = String(a.query || '').trim().toLowerCase();
    const list = d.projects.filter((p) => (a.include_done || live(p))
      && (!q || (p.name + ' ' + p.code + ' ' + p.client).toLowerCase().includes(q)));
    return { count: list.length, projects: list.map((p) => {
      const mine = d.tasks.filter((t) => t.projectId === p.id);
      return { id: p.id, name: p.name, code: p.code, client: p.client, stage: p.stage, start: p.start, due: p.due,
        owner: p.owner, active: p.active, tasks: mine.length, openTasks: mine.filter((t) => !t.done).length,
        shoots: d.shoots.filter((s) => s.projectId === p.id).length };
    }) };
  },

  async hub_project(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    const p = findProject(d, a.project);
    if (!p) return { error: `'${a.project}' 프로젝트를 찾지 못했어요. hub_projects 로 목록을 확인해 주세요.` };
    const tasks = d.tasks.filter((t) => t.projectId === p.id)
      .sort((x, y) => STAGES.indexOf(x.stage) - STAGES.indexOf(y.stage) || x.order - y.order);
    const shoots = d.shoots.filter((s) => s.projectId === p.id).sort((x, y) => (x.date || '').localeCompare(y.date || ''));
    return { project: p, tasks, shoots };
  },

  async hub_add_task(a, env, who, req, h) {
    if (!String(a.title || '').trim()) return { error: '작업 제목이 필요해요.' };
    for (const k of ['due', 'start']) if (a[k] && !isDate(a[k])) return { error: `${k} 는 YYYY-MM-DD 형식이어야 해요.` };
    if (a.calendar && !CALS.includes(a.calendar)) return { error: '캘린더는 ' + CALS.join(', ') + ' 중 하나' };
    const d = await load(env, who, req, h);
    const p = findProject(d, a.project);
    if (!p) return { error: `'${a.project}' 프로젝트를 찾지 못했어요.` };
    const stage = STAGES.slice(0, 3).includes(a.stage) ? a.stage : (STAGES.slice(0, 3).includes(p.stage) ? p.stage : '프리');
    const r = await call(env, who, req, h, { action: 'task.add', projectId: p.id, stage, title: String(a.title).trim(),
      assignee: a.assignee || '', due: a.due || '', start: a.start || '', cal: !!a.calendar, calName: a.calendar || '' });
    return r.ok ? { ok: true, id: r.id, project: label(p), stage, title: String(a.title).trim(), due: a.due || '',
      calendar: a.calendar || '' } : r;
  },

  async hub_update_task(a, env, who, req, h) {
    const id = Number(a.task_id);
    if (!id) return { error: 'task_id 가 필요해요.' };
    if (a.due && !isDate(a.due)) return { error: 'due 는 YYYY-MM-DD 형식이어야 해요.' };
    const d = await load(env, who, req, h);
    const t = d.tasks.find((x) => x.id === id);
    if (!t) return { error: `작업 ${id} 를 찾지 못했어요.` };
    const b = { action: 'task.set', id };
    if (typeof a.done === 'boolean') b.done = a.done;
    if (a.due) b.due = a.due;
    if (a.title) b.title = String(a.title);
    if (a.assignee !== undefined) b.assignee = String(a.assignee);
    const r = await call(env, who, req, h, b);
    return r.ok ? { ok: true, id, project: label(d.pmap.get(t.projectId)), title: b.title || t.title,
      done: b.done === undefined ? t.done : b.done, due: b.due || t.due } : r;
  },
};

async function call(env, who, req, h, body) {
  body._who = who; body._ip = req.headers.get('cf-connecting-ip') || '';
  try { return await (await h.store(env, '/rpc', body)).json(); }
  catch { return { ok: false, error: 'NAS에 연결할 수 없어요.' }; }
}

/* ───────── 공통 */
function openCors() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
    'access-control-expose-headers': 'www-authenticate, mcp-session-id' };
}
function out(h, o, status = 200) { return h.json(o, status, openCors()); }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(err, q, client, status = 200) {
  const hidden = q ? KEYS.map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('') : '';
  const form = q ? `
  <form method="post" action="/oauth/authorize" style="margin-top:22px;text-align:left">
    ${hidden}
    <label>아이디</label>
    <input type="text" name="user" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus>
    <label>비밀번호</label>
    <input type="password" name="pw" autocomplete="current-password">
    <button class="b" style="width:100%;margin-top:14px">로그인하고 연결 허용</button>
    <p class="dim" style="font-size:12px;margin-top:18px;line-height:1.7">
      허용하면 <b>${esc(client || 'Claude')}</b>가 허브의 <b>프로젝트·작업·촬영 회차</b>를 읽고,
      작업을 추가하거나 완료 표시를 할 수 있어요.<br>
      원천징수·지급·금고·매출 같은 돈·개인정보는 열리지 않아요.</p>
  </form>` : '';
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Claude 연결 · 맹그라미 업무 허브</title><link rel="stylesheet" href="/wct-style.css"></head>
<body><div class="center">
  <a class="brand" href="https://mgrm.kr"><img src="/logo.png" alt="맹그라미"></a>
  <h1 style="margin-bottom:8px">Claude 연결</h1>
  <p class="dim">허브 계정(QNAP)으로 로그인하면 Claude 커넥터가 연결됩니다.</p>
  ${err ? `<div class="msg bad" style="margin-top:16px">${esc(err)}</div>` : ''}
  ${form}
  <div class="brandline"></div>
  <p class="wct-foot" style="margin-top:14px">(주)맹그라미 · <b>MEDIA CONTENTS GROUP</b></p>
</div></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" } });
}
