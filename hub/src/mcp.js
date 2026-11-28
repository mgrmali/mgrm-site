/* 맹그라미 업무 허브 — Claude 커넥터 (MCP)
   claude.ai 에 커스텀 커넥터로 등록하면 Claude 가 허브 프로젝트·작업·회차를 읽고,
   작업을 추가하거나 완료 표시를 할 수 있습니다.

   주소     : https://hub.mgrm.kr/mcp
   로그인   : OAuth. 연결할 때 한 번 QNAP 계정으로 로그인 (허브 로그인과 같은 계정)
   여는 것  : 프로젝트·작업·회차, 문진·문의(연락처 포함), 리뷰·납품, 회사 서류 링크,
              NAS 파일(공유 폴더 전체 — HubData·Container·시스템 폴더 빼고)  ← 1.2.0
              문의·리뷰·서류·NAS 파일은 hub-admin 계정으로 연결했을 때만
   막아 둔 것: 원천징수·지급·급여·매출·매입·금고·인력·거래처·계약금액·사용자 관리, 회사 계좌번호
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
  h.origin = new URL(req.url).origin;
  if (!m || typeof m !== 'object') return rpcErr(null, -32600, 'Invalid Request');
  const id = m.id === undefined ? null : m.id;
  if (m.id === undefined) return null;              // 알림(notifications/*) 은 답하지 않음
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion;
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mgrm-hub', title: '맹그라미 업무 허브', version: '1.3.0' },
        instructions: '맹그라미 업무 허브(hub.mgrm.kr)와 회사 NAS(QNAP)를 다룹니다. 날짜는 한국 시간(YYYY-MM-DD).\n'
          + '· 허브: 하루 요약 hub_today, 프로젝트 hub_projects/hub_project/hub_add_project/hub_update_project, 작업 hub_add_task/hub_update_task, '
          + '촬영 회차 hub_save_shoots, 문진·문의 hub_inbox/hub_inbox_item/hub_inbox_set, 리뷰·납품 hub_reviews/hub_review/hub_review_save/hub_review_comment, '
          + '회사 서류 링크 hub_papers/hub_paper_link/hub_paper_set, 세무 자료를 MGRM-Doc 에 엑셀로 저장 hub_taxdoc.\n'
          + '· NAS 파일: 경로는 "공유폴더/하위/파일". 처음엔 nas_list(경로 비움)로 공유 폴더를 보세요. 찾기 nas_find, 읽기 nas_read, '
          + '텍스트 저장 nas_write, 큰 파일(PDF·워드·영상)은 작업 공간에서 nas_upload_link 로 올리고 nas_download_link 로 가져옵니다. '
          + '지우기는 없고 nas_trash 가 _to_delete 로 옮깁니다(nas_restore 로 되돌림). 옮기기·복사·휴지통은 사용자가 요청한 것만 하세요.\n'
          + '· 링크를 만들어도 클라이언트에게 보내는 건 사용자가 정합니다.' } };
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
      // 사진 읽기: Claude 가 직접 볼 수 있게 그림으로 보냄
      if (res && res.image && res.image.data) {
        const img = res.image; delete res.image;
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: img.data, mimeType: img.mime },
          { type: 'text', text: JSON.stringify(res, null, 1) }], structuredContent: res, isError } };
      }
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
  { name: 'hub_save_shoots', title: '허브 촬영 회차 저장',
    description: '프로젝트의 촬영 회차를 스케줄표 기준으로 한꺼번에 저장. 회차 번호가 같으면 고치고 없으면 새로 만듦. '
      + '허브가 MGRM촬영 캘린더를 자동으로 맞춤(하루 종일, 장소 칸은 주소가 있을 때만). 목록에 없는 기존 회차는 지우지 않고 missing 으로 돌려줌.',
    inputSchema: { type: 'object', required: ['project', 'rows'], properties: {
      project: { type: 'string', description: '프로젝트 ID, 코드, 또는 이름 일부' },
      version: { type: 'string', description: '스케줄표 버전 (예: 스케줄표 4고 기준 ver.1 (261116)) — 캘린더 메모 끝에 붙음' },
      rows: { type: 'array', items: { type: 'object', required: ['no'], properties: {
        no: { type: 'string', description: '회차 번호 (예 1, 2, 추가)' },
        date: { type: 'string', description: 'YYYY-MM-DD (모르면 비움)' },
        place: { type: 'string', description: '대표 장소 이름 (제목 괄호에 들어감)' },
        addr: { type: 'string', description: '도로명 주소 (내비용, 모르면 비움)' },
        call: { type: 'string', description: '집합 시간' },
        note: { type: 'string', description: '장소 순서·씬·출연·※특이사항' },
        cancel: { type: 'boolean', description: '취소된 회차면 true' } } } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  /* ── 1.2.0 프로젝트 */
  { name: 'hub_add_project', title: '허브 프로젝트 만들기',
    description: '새 프로젝트를 만듦. 기본 작업 목록(프리·프로덕션·포스트, 허브 화면과 같음)을 넣고, make_folder 면 NAS 1. 의뢰/연도/월_코드_사업명 폴더를 템플릿대로 만듦. '
      + '만들기 전에 이름·코드·클라이언트를 사용자에게 확인하세요.',
    inputSchema: { type: 'object', required: ['name'], properties: {
      name: { type: 'string', description: '프로젝트(사업) 이름' },
      code: { type: 'string', description: '프로젝트 코드 영문 대문자·숫자 2~6글자 (예 KSP). 폴더 이름·캘린더 제목에 들어감' },
      client: { type: 'string', description: '클라이언트' },
      stage: { type: 'string', enum: STAGES.slice(0, 3), description: '시작 단계 (기본 프리)' },
      start: { type: 'string', description: '시작일 YYYY-MM-DD' },
      due: { type: 'string', description: '마감일 YYYY-MM-DD' },
      owner: { type: 'string', description: '담당' },
      memo: { type: 'string' },
      template: { type: 'boolean', description: '기본 작업 목록 넣기 (기본 true)' },
      make_folder: { type: 'boolean', description: 'NAS 의뢰 폴더 만들기 (기본 true)' },
      color_only: { type: 'boolean', description: '색보정 단독 의뢰 폴더 (00_ADMIN·20_IN·30_WORK·40_OUT 만)' },
      folder_name: { type: 'string', description: '폴더 이름을 직접 정할 때 (월 두 자리로 시작, 예 11_KSP_준공기념영상)' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'hub_update_project', title: '허브 프로젝트 고치기',
    description: '프로젝트 단계·이름·코드·클라이언트·시작일·마감일·담당·메모·활성(끔=비활성) 바꾸기. 적은 칸만 바뀜.',
    inputSchema: { type: 'object', required: ['project'], properties: {
      project: { type: 'string', description: '프로젝트 ID, 코드, 또는 이름 일부' },
      stage: { type: 'string', enum: STAGES }, name: { type: 'string' }, code: { type: 'string' }, client: { type: 'string' },
      start: { type: 'string' }, due: { type: 'string' }, owner: { type: 'string' }, memo: { type: 'string' },
      active: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'hub_project_folder', title: '허브 프로젝트 의뢰 폴더',
    description: '폴더가 없는 프로젝트에 NAS 의뢰 폴더를 만들거나(make), 이미 있는 폴더 "연도/폴더이름" 을 연결(link). list 는 그 해 의뢰 폴더 목록.',
    inputSchema: { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['make', 'link', 'list'] },
      project: { type: 'string', description: 'make·link 할 프로젝트' },
      folder: { type: 'string', description: 'link: "2026/11_KSP_준공기념영상" 형식, 빈 값이면 연결 해제' },
      folder_name: { type: 'string', description: 'make: 폴더 이름 직접 정하기' },
      color_only: { type: 'boolean' }, year: { type: 'string', description: 'list: 연도' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },

  /* ── 1.2.0 문진·문의 (관리자) */
  { name: 'hub_inbox', title: '문진·문의 목록',
    description: '홈페이지로 들어온 DI 문진(작업 의뢰서)과 작업 문의 목록. 기본은 안 읽은 것만. 관리자 계정만.',
    inputSchema: { type: 'object', properties: {
      all: { type: 'boolean', description: '읽은 것도 모두' },
      kind: { type: 'string', enum: ['문진', '문의'], description: '한 종류만' },
      query: { type: 'string', description: '회사·이름·프로젝트·내용 글자로 거르기' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'hub_inbox_item', title: '문진·문의 자세히',
    description: '한 건의 전체 내용 (담당자 연락처·이메일 포함 — 답장 초안용). no 는 접수번호.',
    inputSchema: { type: 'object', required: ['no'], properties: {
      no: { type: 'string', description: '접수번호 (hub_inbox 결과의 no)' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'hub_inbox_set', title: '문진·문의 처리',
    description: '진행 상태(접수/검토 중/견적 발송/진행/완료/보류), 내부 메모, 읽음 표시. 지우기는 허브 화면에서.',
    inputSchema: { type: 'object', required: ['no'], properties: {
      no: { type: 'string' },
      status: { type: 'string', enum: ['접수', '검토 중', '견적 발송', '진행', '완료', '보류'] },
      memo: { type: 'string', description: '내부 메모 (전체를 이 값으로 바꿈)' },
      read: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },

  /* ── 1.2.0 리뷰·납품 (관리자) */
  { name: 'hub_reviews', title: '리뷰·납품 목록',
    description: '컬러리버브 리뷰 링크 목록(작품·버전·만료·납품 허용·안 읽은 코멘트 수), 최근 납품 수령 기록, NAS 리뷰 폴더의 영상 목록. 관리자 계정만.',
    inputSchema: { type: 'object', properties: {
      all: { type: 'boolean', description: '꺼진(비활성) 리뷰도 포함' },
      query: { type: 'string', description: '작품명 글자로 거르기' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'hub_review', title: '리뷰 자세히',
    description: '리뷰 하나의 코멘트 전체(타임코드 순, 처리 여부), 납품 파일, 누가 언제 받았는지. key 는 리뷰 키 또는 작품명 일부.',
    inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'hub_review_save', title: '리뷰 링크 만들기·고치기',
    description: '새 리뷰 링크를 만들거나(key 비움) 기존 것을 고침. video 는 NAS 리뷰 폴더의 파일 이름(hub_reviews 의 videos) 또는 영상 주소. '
      + '리뷰 폴더에 새 영상을 넣으려면 nas_upload_link 로 Web/review/파일이름 에 올리세요. 링크를 클라이언트에게 보내는 건 사용자가.',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string', description: '고칠 리뷰 키 (새로 만들 땐 비움)' },
      title: { type: 'string', description: '작품명' }, version: { type: 'string', description: '버전 (예 v2)' },
      video: { type: 'string' }, password: { type: 'string', description: '열람 비밀번호 (비우면 없음)' },
      until: { type: 'string', description: '만료일 YYYY-MM-DD' }, fps: { type: 'number', description: '기본 24' },
      active: { type: 'boolean' }, deliver: { type: 'boolean', description: '납품 페이지 열기' },
      deliver_note: { type: 'string' }, deliver_until: { type: 'string' }, memo: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'hub_review_comment', title: '리뷰 코멘트 처리',
    description: '코멘트 처리 완료·되돌리기, 읽음 표시. ids 는 hub_review 결과의 코멘트 id 들.',
    inputSchema: { type: 'object', required: ['ids'], properties: {
      ids: { type: 'array', items: { type: 'string' } },
      done: { type: 'boolean' }, read: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },

  /* ── 1.2.0 회사 서류 (관리자) */
  { name: 'hub_papers', title: '회사 서류·링크 목록',
    description: '올려 둔 회사 서류(사업자등록증·통장사본 등), 만든 제출용 링크와 상태·열람 기록. 계좌번호는 가려서 보냄. 관리자 계정만.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'hub_paper_link', title: '회사 서류 제출용 링크 만들기',
    description: '받는 곳 이름으로 서류 링크(hub.mgrm.kr/d/…)를 만듦. 받는 사람은 로그인 없이 열고, 도장을 켜면 PDF 에 "○○ 제출용" 이 찍힘.',
    inputSchema: { type: 'object', required: ['to', 'docs'], properties: {
      to: { type: 'string', description: '받는 곳 (예 제이레퍼토리)' },
      docs: { type: 'array', items: { type: ['integer', 'string'] }, description: '서류 id 또는 이름 일부 (hub_papers 의 docs)' },
      days: { type: 'integer', enum: [7, 30, 0], description: '열리는 기간 (0 = 기한 없음, 기본 7)' },
      stamp: { type: 'boolean', description: '"○○ 제출용" 도장 (기본 true)' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'hub_paper_set', title: '회사 서류 링크 닫기·열기·연장',
    description: 'close: 링크 닫기, open: 다시 열기, extend: 오늘부터 days 일 연장.',
    inputSchema: { type: 'object', required: ['id', 'action'], properties: {
      id: { type: 'integer', description: '링크 id (hub_papers 의 links)' },
      action: { type: 'string', enum: ['close', 'open', 'extend'] },
      days: { type: 'integer', description: 'extend 기간 (기본 7)' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },

  /* ── 1.3.0 세무 자료 → MGRM-Doc (관리자) */
  { name: 'hub_taxdoc', title: '세무 자료를 MGRM-Doc 에 저장',
    description: '허브의 원천세·급여·매출매입 자료를 NAS MGRM-Doc 세무 폴더에 엑셀로 저장합니다 (같은 내용이면 건너뛰고, 바뀌면 예전 것은 _to_delete). '
      + 'month: 그 달 지급대장(주민번호 가림)·원천세 요약·간이지급명세서(세무사 제출용, 주민번호 전체)·급여대장 / sales: 그 해 매출매입 / vat: 분기 부가세 자료 / '
      + 'year: 법인세 준비자료(1년치) / status: 자동 저장 기록. 매월 5일·분기·1월 10일에 자동으로도 돌아갑니다. 결과는 저장한 경로만 알려 주고 주민번호는 돌려주지 않습니다.',
    inputSchema: { type: 'object', required: ['kind'], properties: {
      kind: { type: 'string', enum: ['month', 'sales', 'vat', 'year', 'status'] },
      ym: { type: 'string', description: 'month 일 때 지급 월 YYYY-MM' },
      year: { type: 'string', description: 'sales·vat·year 일 때 YYYY' },
      q: { type: 'integer', minimum: 1, maximum: 4, description: 'vat 분기' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },

  /* ── 1.2.0 NAS 파일 (관리자) */
  { name: 'nas_list', title: 'NAS 폴더 보기',
    description: '경로 비움 = 공유 폴더 목록과 남은 용량. 경로를 주면 그 안의 폴더·파일(크기·수정일). depth 로 하위 몇 단계까지(최대 4). '
      + 'HubData·Container·시스템 폴더는 보안상 안 보임.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: '"공유폴더/하위/…" (예 MGRM-Qnap/1. 의뢰/2026)' },
      depth: { type: 'integer', minimum: 1, maximum: 4 }, limit: { type: 'integer', description: '최대 개수 (기본 500)' },
      hidden: { type: 'boolean', description: '. 으로 시작하는 숨김 파일도' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'nas_find', title: 'NAS 파일 찾기',
    description: '이름(글자 포함 또는 * ? 패턴)·확장자·수정일로 찾기. path 를 비우면 모든 공유 폴더. 15초 안에서 찾음 — 넓으면 path 를 좁히세요. _to_delete 안은 trash:true 일 때만.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string' }, name: { type: 'string', description: '예: 견적서, *_v2.mov' },
      ext: { type: 'array', items: { type: 'string' }, description: '예 ["mov","mp4"]' },
      since: { type: 'string', description: '이날 이후 수정 YYYY-MM-DD' }, type: { type: 'string', enum: ['file', 'dir'] },
      depth: { type: 'integer' }, limit: { type: 'integer' }, trash: { type: 'boolean' }, hidden: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'nas_info', title: 'NAS 파일·폴더 정보',
    description: '크기·수정일·만든 날짜·디스크 남은 용량. 폴더면 안의 파일 수와 전체 용량(15초 안에서 셈).',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' },
      total: { type: 'boolean', description: '폴더 전체 용량 세기 (기본 true)' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'nas_read', title: 'NAS 파일 읽기',
    description: '글자 파일(txt·csv·srt·edl·xml·json·cube·mhl 등)은 내용(한 번에 200KB, 이어 읽기는 offset=next), 사진(jpg·png·gif·webp, 4MB까지)은 그림으로. '
      + 'PDF·워드·엑셀·영상은 nas_download_link 로 작업 공간에 가져와 여세요.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'integer' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'nas_mkdir', title: 'NAS 폴더 만들기',
    description: '폴더 만들기 (중간 폴더도 같이). 이미 있으면 그대로 둠.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'nas_write', title: 'NAS에 텍스트 파일 저장',
    description: 'Claude 가 쓴 글자 파일(md·txt·csv·html·srt·json 등, 5MB까지)을 저장. 같은 이름이 있으면 멈춤 — overwrite(기존 것은 _to_delete 로 옮긴 뒤 저장) 또는 rename(_2 붙이기). '
      + '엑셀에서 열 csv 는 bom:true. PDF·워드·영상 같은 파일은 nas_upload_link.',
    inputSchema: { type: 'object', required: ['path', 'text'], properties: {
      path: { type: 'string', description: '파일 경로 (공유폴더/폴더/파일이름.확장자)' }, text: { type: 'string' },
      overwrite: { type: 'boolean' }, rename: { type: 'boolean' }, bom: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'nas_upload_link', title: 'NAS 파일 올리기 주소',
    description: 'Claude 작업 공간에서 만든 파일(PDF·워드·엑셀·이미지·영상 등, 크기 제한 없음)을 NAS 에 올리는 1회용 주소(1시간). '
      + '결과의 script 를 bash 에서 FILE 만 바꿔 실행하면 50MB 조각으로 올리고 sha256 으로 확인함. 같은 이름이 있으면 _2 를 붙이고, overwrite 면 기존 것을 _to_delete 로 옮김. '
      + '작업 공간에서 hub.mgrm.kr 에 접속이 막히면 claude.ai 설정에서 허용 도메인에 hub.mgrm.kr 을 넣어야 함.',
    inputSchema: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: '저장할 파일 경로 (공유폴더/폴더/파일이름.확장자)' },
      overwrite: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'nas_download_link', title: 'NAS 파일 가져오기 주소',
    description: 'NAS 파일을 Claude 작업 공간으로 내려받는 1회용 주소(1시간). curl -fL -C - -o 파일 주소. PDF·엑셀·영상 분석용.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'nas_move', title: 'NAS 옮기기·이름 바꾸기',
    description: 'from 을 to 로 옮기거나 이름을 바꿈. to 가 있는 폴더면 그 안으로. 받는 곳에 같은 이름이 있으면 멈춤. 다른 볼륨이면 복사한 뒤 크기가 같을 때만 원래 것을 정리(뒤에서 진행, nas_jobs).',
    inputSchema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'nas_copy', title: 'NAS 복사',
    description: 'from 을 to 로 복사 (폴더 통째로 가능). 남은 공간을 먼저 확인. 8초 넘게 걸리면 뒤에서 계속 — nas_jobs 로 진행률 확인.',
    inputSchema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'nas_jobs', title: 'NAS 복사·옮기기 진행 상황',
    description: '뒤에서 진행 중이거나 끝난 복사·옮기기 목록과 진행률.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'nas_trash', title: 'NAS 휴지통으로 옮기기',
    description: '완전 삭제 대신 그 공유 폴더의 _to_delete/날짜시각/원래경로 로 옮김. nas_restore 로 되돌릴 수 있음. 사용자가 지우라고 한 것만.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' },
      reason: { type: 'string', description: '왜 옮기는지 (기록에 남음)' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'nas_trash_list', title: 'NAS 휴지통 목록',
    description: 'Claude 가 _to_delete 로 옮긴 것 중 아직 되돌리지 않은 것 (원래 경로·옮긴 곳·이유).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'nas_restore', title: 'NAS 휴지통에서 되돌리기',
    description: '휴지통 기록 id 를 원래 자리로 되돌림 (원래 자리에 같은 이름이 있으면 to 로 다른 경로).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, to: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'nas_log', title: 'NAS 작업 기록',
    description: 'Claude 커넥터로 한 파일 작업 기록 (저장·올리기·가져오기·옮기기·복사·휴지통·되돌리기). 최근 것부터.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
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
  return { projects, pmap, tasks, shoots, intakes, inquiries, admin, rv };
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

/* 허브 화면(projects.html)과 같은 기본 작업 — ★ 는 캘린더에 넣음 */
const TEMPLATE = {
  '프리': ['기획 · 시나리오', '콘티 · 스토리보드', '견적 · 계약', '로케이션 헌팅', '캐스팅', '스태프 섭외', '★촬영 스케줄 확정', '장비 리스트 · 렌탈'],
  '프로덕션': ['장비 점검', '★촬영 D-1 준비', '★본 촬영', 'DIT 백업 · 검수', '데이터 인계'],
  '포스트': ['가편집', '★1차 시사', '수정 반영', 'DI · 색보정', '사운드 믹싱', 'CG · 그래픽', '★최종 시사', '마스터 출력', '★납품'],
};
const ADMIN_ONLY = { error: '이 기능은 hub-admin(관리자) 계정으로 연결했을 때만 쓸 수 있어요.' };
/* NAS 파일 도구: 관리자만, NAS 의 nas.* 로 넘기고 필요하면 결과를 다듬음 */
function nas(action, pick, after) {
  return async (a, env, who, req, h) => {
    if (who.role !== 'admin') return ADMIN_ONLY;
    const r = await call(env, who, req, h, Object.assign({ action }, pick(a || {})));
    if (!r || !r.ok) return { error: (r && r.error) || 'NAS 가 답하지 않았어요.' };
    delete r.ok;
    return after ? after(r, h) : r;
  };
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
  async hub_save_shoots(a, env, who, req, h) {
    const rows = Array.isArray(a.rows) ? a.rows : [];
    if (!rows.length) return { error: 'rows 가 비어 있어요.' };
    for (const r of rows) if (r.date && !isDate(r.date)) return { error: `${r.no}회차 날짜는 YYYY-MM-DD 형식이어야 해요.` };
    const d = await load(env, who, req, h);
    const p = findProject(d, a.project);
    if (!p) return { error: `'${a.project}' 프로젝트를 찾지 못했어요.` };
    const body = { action: 'shoot.bulk', projectId: p.id,
      rows: rows.map((r) => ({ no: String(r.no || ''), date: r.date || '', place: r.place || '', addr: r.addr || '',
        call: r.call || '', note: r.note || '', status: r.cancel ? '취소' : '' })) };
    if (a.version !== undefined) body.version = String(a.version);
    const r = await call(env, who, req, h, body);
    return r.ok ? { ok: true, project: label(p), added: r.added, updated: r.updated, missing: r.missing } : r;
  },

  /* ── 1.2.0 프로젝트 */
  async hub_add_project(a, env, who, req, h) {
    const name = String(a.name || '').trim();
    if (!name) return { error: '프로젝트 이름이 필요해요.' };
    for (const k of ['due', 'start']) if (a[k] && !isDate(a[k])) return { error: `${k} 는 YYYY-MM-DD 형식이어야 해요.` };
    const code = String(a.code || '').trim().toUpperCase();
    if (code && !/^[A-Z0-9]{2,6}$/.test(code)) return { error: '코드는 영문 대문자·숫자 2~6글자예요.' };
    const d = await load(env, who, req, h);
    const dup = code ? d.projects.find((p) => String(p.code || '').toUpperCase() === code) : null;
    const tasks = a.template === false ? [] : Object.entries(TEMPLATE).flatMap(([stage, arr]) =>
      arr.map((raw) => ({ stage, title: raw.replace(/^★/, ''), cal: raw.startsWith('★') })));
    const r = await call(env, who, req, h, { action: 'project.add', name, client: a.client || '', code,
      stage: STAGES.slice(0, 3).includes(a.stage) ? a.stage : '프리', start: a.start || '', due: a.due || '',
      owner: a.owner || '', memo: a.memo || '', makeFolder: a.make_folder !== false, folderName: a.folder_name || '',
      colorOnly: !!a.color_only, tasks });
    if (!r.ok) return r;
    return { ok: true, id: r.id, project: (code ? `[${code}] ` : '') + name, tasks: tasks.length, folder: r.folder || '',
      folderError: r.folderError || undefined, warning: dup ? `코드 ${code} 는 '${dup.name}' 에서도 쓰고 있어요.` : undefined };
  },

  async hub_update_project(a, env, who, req, h) {
    for (const k of ['due', 'start']) if (a[k] && !isDate(a[k])) return { error: `${k} 는 YYYY-MM-DD 형식이어야 해요.` };
    if (a.stage && !STAGES.includes(a.stage)) return { error: '단계는 ' + STAGES.join(', ') + ' 중 하나' };
    const d = await load(env, who, req, h);
    const p = findProject(d, a.project);
    if (!p) return { error: `'${a.project}' 프로젝트를 찾지 못했어요.` };
    const b = { action: 'project.update', id: p.id };
    const map = { name: 'name', client: 'client', stage: 'stage', start: 'start', due: 'due', owner: 'owner', memo: 'memo', code: 'code', active: 'active' };
    let n = 0;
    Object.keys(map).forEach((k) => { if (a[k] !== undefined) { b[map[k]] = typeof a[k] === 'string' ? a[k].trim() : a[k]; n++; } });
    if (!n) return { error: '바꿀 칸이 없어요.' };
    const r = await call(env, who, req, h, b);
    return r.ok ? { ok: true, project: label(Object.assign({}, p, b.code !== undefined ? { code: String(b.code).toUpperCase() } : {},
      b.name ? { name: b.name } : {})), changed: Object.keys(map).filter((k) => a[k] !== undefined) } : r;
  },

  async hub_project_folder(a, env, who, req, h) {
    if (a.action === 'list') return call(env, who, req, h, { action: 'folder.list', year: a.year || '' });
    const d = await load(env, who, req, h);
    const p = findProject(d, a.project);
    if (!p) return { error: `'${a.project}' 프로젝트를 찾지 못했어요.` };
    if (a.action === 'make') {
      const r = await call(env, who, req, h, { action: 'folder.make', id: p.id, folderName: a.folder_name || '', colorOnly: !!a.color_only });
      return r.ok ? { ok: true, project: label(p), folder: r.folder, nasPath: 'MGRM-Qnap/1. 의뢰/' + r.folder } : r;
    }
    if (a.action === 'link') {
      const r = await call(env, who, req, h, { action: 'folder.link', id: p.id, folder: a.folder || '' });
      return r.ok ? { ok: true, project: label(p), folder: r.folder || '(연결 해제)' } : r;
    }
    return { error: 'action 은 make, link, list 중 하나' };
  },

  /* ── 1.2.0 문진·문의 */
  async hub_inbox(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    if (!d.admin) return ADMIN_ONLY;
    const q = String(a.query || '').trim().toLowerCase();
    const one = (x, kind) => kind === '문진'
      ? { no: String(x['접수번호']), kind, at: x['접수시각'], from: [x['회사명'], x['담당자']].filter(Boolean).join(' · '),
        title: x['프로젝트명'], videoKind: x['영상 종류'], wantDate: x['납품 희망일'], status: x['진행 상태'] || '접수', read: !!x['읽음'] }
      : { no: String(x['접수번호']), kind, at: x['접수시각'], from: x['이름/회사'], title: x['문의 분야'],
        summary: String(x['내용'] || '').replace(/\s+/g, ' ').slice(0, 160), status: x['진행 상태'] || '접수', read: !!x['읽음'] };
    let list = [];
    if (a.kind !== '문의') list = list.concat((d.rv.intakes || []).map((x) => one(x, '문진')));
    if (a.kind !== '문진') list = list.concat((d.rv.inquiries || []).map((x) => one(x, '문의')));
    list = list.filter((x) => (a.all || !x.read) && (!q || JSON.stringify(x).toLowerCase().includes(q)))
      .sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return { count: list.length, items: list, note: a.all ? undefined : '안 읽은 것만 (all:true 면 전체)' };
  },

  async hub_inbox_item(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    if (!d.admin) return ADMIN_ONLY;
    const no = String(a.no || '').trim();
    const intake = (d.rv.intakes || []).find((x) => String(x['접수번호']) === no);
    const inq = intake ? null : (d.rv.inquiries || []).find((x) => String(x['접수번호']) === no);
    const x = intake || inq;
    if (!x) return { error: `접수번호 ${no} 를 찾지 못했어요. hub_inbox 로 확인해 주세요.` };
    const fields = {};
    Object.keys(x).forEach((k) => { if (k !== '_lang' && x[k] !== '' && x[k] != null) fields[k] = x[k]; });
    return { kind: intake ? '문진' : '문의', no, fields,
      note: '연락처·이메일은 답장 초안에만 쓰고, 메일을 보내는 건 사용자 확인 뒤에.' };
  },

  async hub_inbox_set(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    if (!d.admin) return ADMIN_ONLY;
    const no = String(a.no || '').trim();
    const isIntake = (d.rv.intakes || []).some((x) => String(x['접수번호']) === no);
    const isInq = !isIntake && (d.rv.inquiries || []).some((x) => String(x['접수번호']) === no);
    if (!isIntake && !isInq) return { error: `접수번호 ${no} 를 찾지 못했어요.` };
    const r = await call(env, who, req, h, { action: isIntake ? 'intake.set' : 'inquiry.set', no,
      status: a.status, memo: a.memo, read: typeof a.read === 'boolean' ? a.read : undefined });
    return r.ok ? { ok: true, kind: isIntake ? '문진' : '문의', no, status: a.status, read: a.read } : r;
  },

  /* ── 1.2.0 리뷰·납품 */
  async hub_reviews(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    if (!d.admin) return ADMIN_ONLY;
    const q = String(a.query || '').trim().toLowerCase();
    const rv = d.rv;
    const projects = (rv.projects || []).filter((p) => (a.all || p.active) && (!q || (p.title + ' ' + p.key).toLowerCase().includes(q)))
      .map((p) => { const cm = (rv.comments || []).filter((c) => c.key === p.key);
        return { key: p.key, title: p.title, version: p.ver, video: p.src, until: p.until, active: p.active, deliver: p.deliver,
          password: p.pw ? '있음' : '없음', comments: cm.length, openComments: cm.filter((c) => !c.done).length,
          unread: cm.filter((c) => !c.read).length, link: p.link, deliveryLink: p.deliver ? p.dlink : undefined, created: p.createdAt }; })
      .sort((x, y) => String(y.created).localeCompare(String(x.created)));
    const records = (rv.records || []).slice().sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 20)
      .map((r) => ({ at: r.at, key: r.key, title: r.title, who: r.who, org: r.org, files: r.files, count: r.count, read: r.read }));
    let videos = [];
    try { const v = await call(env, who, req, h, { action: 'review.videos' });
      videos = (v.videos || []).slice(0, 40).map((x) => ({ name: x.name, size: (x.size / 1048576).toFixed(0) + 'MB',
        at: new Date(x.at + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') })); } catch {}
    return { count: projects.length, reviews: projects, recentDeliveries: records,
      videos, videoFolder: 'Web/review (NAS 경로) — 새 영상은 nas_upload_link 로 여기에' };
  },

  async hub_review(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    if (!d.admin) return ADMIN_ONLY;
    const k = String(a.key || '').trim(), low = k.toLowerCase();
    const all = d.rv.projects || [];
    const p = all.find((x) => x.key === k) || all.filter((x) => x.title.toLowerCase().includes(low))
      .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))[0];
    if (!p) return { error: `'${k}' 리뷰를 찾지 못했어요. hub_reviews 로 확인해 주세요.` };
    const comments = (d.rv.comments || []).filter((c) => c.key === p.key)
      .sort((x, y) => (Number(x.sec) || 0) - (Number(y.sec) || 0))
      .map((c) => ({ id: c.id, tc: c.tc, ver: c.ver, who: c.who, text: c.txt, at: c.at, done: c.done || '', read: c.read }));
    return { review: { key: p.key, title: p.title, version: p.ver, video: p.src, until: p.until, fps: p.fps, active: p.active,
      password: p.pw ? '있음' : '없음', deliver: p.deliver, deliverNote: p.dnote, deliverUntil: p.duntil, memo: p.memo,
      link: p.link, deliveryLink: p.dlink },
      comments, files: (d.rv.files || []).filter((f) => f.key === p.key),
      deliveries: (d.rv.records || []).filter((r) => r.key === p.key) };
  },

  async hub_review_save(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    if (!d.admin) return ADMIN_ONLY;
    for (const k of ['until', 'deliver_until']) if (a[k] && !isDate(a[k])) return { error: `${k} 는 YYYY-MM-DD 형식이어야 해요.` };
    const key = String(a.key || '').trim();
    const cur = key ? (d.rv.projects || []).find((x) => x.key === key) : null;
    if (key && !cur) return { error: `리뷰 키 ${key} 를 찾지 못했어요.` };
    if (!key && !String(a.title || '').trim()) return { error: '새 리뷰는 작품명(title)이 필요해요.' };
    const b = { action: 'review.project.save', key, title: a.title, ver: a.version, src: a.video, pw: a.password, until: a.until,
      fps: a.fps, active: a.active, deliver: a.deliver, dnote: a.deliver_note, duntil: a.deliver_until, memo: a.memo };
    if (!cur) { b.fps = a.fps || 24; if (a.active === undefined) b.active = true; }
    const r = await call(env, who, req, h, b);
    return r.ok ? { ok: true, key: r.key, created: !cur, link: r.link, deliveryLink: r.dlink,
      note: '링크를 클라이언트에게 보내는 건 사용자가 정해요.' } : r;
  },

  async hub_review_comment(a, env, who, req, h) {
    const d = await load(env, who, req, h);
    if (!d.admin) return ADMIN_ONLY;
    const ids = (Array.isArray(a.ids) ? a.ids : [a.ids]).map(String).filter(Boolean);
    if (!ids.length) return { error: 'ids 가 비어 있어요.' };
    const have = new Set((d.rv.comments || []).map((c) => c.id));
    const miss = ids.filter((i) => !have.has(i));
    let n = 0;
    for (const id of ids.filter((i) => have.has(i))) {
      const r = await call(env, who, req, h, { action: 'review.comment.set', id,
        done: typeof a.done === 'boolean' ? a.done : undefined, read: typeof a.read === 'boolean' ? a.read : undefined });
      if (r.ok) n++;
    }
    return { ok: true, updated: n, notFound: miss.length ? miss : undefined };
  },

  /* ── 1.2.0 회사 서류 */
  async hub_papers(a, env, who, req, h) {
    if (who.role !== 'admin') return ADMIN_ONLY;
    const r = await call(env, who, req, h, { action: 'paper.list' });
    if (!r.ok) return r;
    const c = r.company || {};
    return { company: { name: c.name, bizNo: c.bizNo, ceo: c.ceo, address: c.address, email: c.email, tel: c.tel,
      bank: c.bank, account: c.account ? '(가려 둠 — 링크를 받는 사람 화면에만 보임)' : '' },
      docs: (r.docs || []).map((x) => ({ id: x.id, name: x.name, type: x.type, size: x.size, at: x.at })),
      links: (r.links || []).map((l) => ({ id: l.id, to: l.to, docs: l.docNames, state: l.state, exp: l.exp || '기한 없음',
        stamp: l.stamp, views: l.views, downloads: l.downs, last: l.last, by: l.by, at: l.at, link: h.origin + '/d/' + l.token })) };
  },

  async hub_paper_link(a, env, who, req, h) {
    if (who.role !== 'admin') return ADMIN_ONLY;
    const to = String(a.to || '').trim();
    if (!to) return { error: '받는 곳(to)을 적어 주세요.' };
    const l = await call(env, who, req, h, { action: 'paper.list' });
    if (!l.ok) return l;
    const docs = l.docs || [];
    const want = Array.isArray(a.docs) ? a.docs : [a.docs];
    const ids = [], miss = [];
    want.forEach((w) => {
      const s = String(w).trim();
      const hit = /^\d+$/.test(s) ? docs.find((x) => x.id === Number(s)) : docs.find((x) => x.name.includes(s));
      if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); } else miss.push(s);
    });
    if (miss.length) return { error: '이 서류를 못 찾았어요: ' + miss.join(', '), docs: docs.map((x) => ({ id: x.id, name: x.name })) };
    const r = await call(env, who, req, h, { action: 'paper.link', to, ids, days: [7, 30, 0].includes(a.days) ? a.days : 7, stamp: a.stamp !== false });
    return r.ok ? { ok: true, id: r.id, to, docs: ids.map((i) => docs.find((x) => x.id === i).name), until: r.exp || '기한 없음',
      link: h.origin + '/d/' + r.token, note: '링크를 보내는 건 사용자가 정해요.' } : r;
  },

  async hub_paper_set(a, env, who, req, h) {
    if (who.role !== 'admin') return ADMIN_ONLY;
    const id = Number(a.id);
    if (!id) return { error: 'id 가 필요해요.' };
    let b;
    if (a.action === 'close') b = { action: 'paper.close', id };
    else if (a.action === 'open') b = { action: 'paper.close', id, open: true };
    else if (a.action === 'extend') b = { action: 'paper.extend', id, days: Number(a.days) || 7 };
    else return { error: 'action 은 close, open, extend 중 하나' };
    const r = await call(env, who, req, h, b);
    return r.ok ? { ok: true, id, action: a.action } : r;
  },

  /* ── 1.2.0 NAS 파일 */
  nas_list: nas('nas.list', (a) => ({ path: a.path || '', depth: a.depth, limit: a.limit, hidden: !!a.hidden })),
  nas_find: nas('nas.find', (a) => ({ path: a.path || '', name: a.name, ext: a.ext, since: a.since, type: a.type, depth: a.depth,
    limit: a.limit, trash: !!a.trash, hidden: !!a.hidden })),
  nas_info: nas('nas.info', (a) => ({ path: a.path, total: a.total })),
  nas_read: nas('nas.read', (a) => ({ path: a.path, offset: a.offset })),
  nas_mkdir: nas('nas.mkdir', (a) => ({ path: a.path })),
  nas_write: nas('nas.write', (a) => ({ path: a.path, text: a.text, overwrite: !!a.overwrite, rename: !!a.rename, bom: !!a.bom })),
  nas_move: nas('nas.move', (a) => ({ from: a.from, to: a.to })),
  nas_copy: nas('nas.copy', (a) => ({ from: a.from, to: a.to })),
  nas_jobs: nas('nas.jobs', (a) => ({ id: a.id })),
  nas_trash: nas('nas.trash', (a) => ({ path: a.path, reason: a.reason })),
  nas_trash_list: nas('nas.trash.list', (a) => ({ query: a.query, limit: a.limit })),
  nas_restore: nas('nas.restore', (a) => ({ id: a.id, to: a.to })),
  nas_log: nas('nas.log', (a) => ({ query: a.query, limit: a.limit })),
  hub_taxdoc: async (a, env, who, req, h) => {
    if (who.role !== 'admin') return ADMIN_ONLY;
    const k = String((a && a.kind) || 'month');
    const r = await call(env, who, req, h, k === 'status' ? { action: 'taxdoc.status' }
      : { action: 'taxdoc.save', kind: k, ym: a.ym, year: a.year, q: a.q });
    if (!r || !r.ok) return { error: (r && r.error) || 'NAS 가 답하지 않았어요.' };
    delete r.ok;
    return r;
  },
  nas_upload_link: nas('nas.uplink', (a) => ({ path: a.path, overwrite: !!a.overwrite }), (r, h) => {
    const url = h.origin + '/u/' + r.token;
    return { ok: true, path: r.path, url, expires: r.expires,
      script: [
        `FILE="/여기에/올릴/파일"; U="${url}"`,
        'S=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE"); O=0; C=52428800',
        'while [ "$O" -lt "$S" ]; do',
        '  dd if="$FILE" bs=1048576 skip=$((O/1048576)) count=50 status=none | curl -sSf -X PUT --data-binary @- "$U?offset=$O" >/dev/null || { echo "조각 실패: $O"; exit 1; }',
        '  O=$((O+C)); done',
        'H=$( (sha256sum "$FILE" 2>/dev/null || shasum -a 256 "$FILE") | cut -d" " -f1)',
        'curl -sS -X POST "$U?op=finish&size=$S&sha256=$H"; echo',
      ].join('\n'),
      note: '끊기면 같은 주소로 다시 실행하면 처음부터 다시 받아요. 마지막 줄 결과의 path 가 실제 저장된 경로예요 (같은 이름이 있으면 _2).' };
  }),
  nas_download_link: nas('nas.downlink', (a) => ({ path: a.path }), (r, h) => {
    const url = h.origin + '/f/' + r.token;
    const name = String(r.path).split('/').pop();
    return { ok: true, path: r.path, size: r.sizeText, url, expires: r.expires,
      command: `curl -fL -C - -o ${JSON.stringify(name)} "${url}"` };
  }),
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
      허용하면 <b>${esc(client || 'Claude')}</b>가 허브의 <b>프로젝트·작업·촬영 회차</b>를 읽고 고칠 수 있어요.
      관리자(hub-admin) 계정이면 <b>문진·문의, 리뷰·납품, 회사 서류 링크, NAS 파일</b>도 다뤄요.<br>
      NAS 파일은 완전히 지우지 않고 _to_delete 로만 옮겨요.
      원천징수·지급·금고·매출 같은 돈·개인정보와 HubData 폴더는 열리지 않아요.</p>
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
