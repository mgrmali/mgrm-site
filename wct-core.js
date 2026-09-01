/* wct-core.js · v1.2.0 · 2026-09-01
   변경: accDigits() 추가 — 계좌번호에서 숫자만 남깁니다 */
/* ══════════════════════════════════════════════════════════
   wct-core.js — 모든 페이지가 함께 쓰는 코어

   여기 한 곳만 고치면 전 페이지에 반영됩니다.
   페이지마다 복사해 두지 마세요.
   ══════════════════════════════════════════════════════════ */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbzSRu7J20klkUFYE8lfx1qf_C6SLolq0g-p_fhHfGmQKreUSDNkbQSh8bQn63JvL3bu/exec';

const ITER = 600000;
const IDLE_LIMIT = 30 * 60 * 1000;   // 30분 무활동 시 자동 잠금

const $ = (id) => document.getElementById(id);
const won = (n) => Number(n || 0).toLocaleString('ko-KR');
const b64e = (b) => {
  const u = new Uint8Array(b); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** HTML 이스케이프 — 게시판 등 사용자 입력을 화면에 넣을 때 반드시 통과시킬 것 */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WCT = {
  auth: '', priv: null, pub: '', data: null, role: 'admin', me: null,

  isAdmin() { return WCT.role === 'admin'; },

  // ────────── 통신
  /* 앱스스크립트는 요청이 겹치면 서로 밀립니다.
     같은 조회가 이미 돌고 있으면 새로 보내지 않고 그 결과를 함께 씁니다. */
  _inflight: {},

  async api(action, body = {}) {
    const dedupe = action === 'bootstrap' || action === 'envelope';
    const sig = dedupe ? action + ':' + JSON.stringify(body) : null;
    if (sig && WCT._inflight[sig]) return WCT._inflight[sig];

    const run = (async () => {
      const r = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, key: WCT.auth }, body)),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '요청에 실패했습니다.');
      return j;
    })();

    if (sig) {
      WCT._inflight[sig] = run;
      run.finally(() => { delete WCT._inflight[sig]; });
    }
    return run;
  },

  async status() {
    return (await fetch(`${GAS_URL}?action=status`)).json();
  },

  // ────────── 비밀번호 → 키
  async derive(pw, salt, mode) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw),
      'PBKDF2', false, ['deriveBits', 'deriveKey']);
    const p = { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' };
    if (mode === 'auth') return b64e(await crypto.subtle.deriveBits(p, base, 256));
    return crypto.subtle.deriveKey(p, base, { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']);
  },

  /** PD 계정 토큰 — 아이디+비밀번호를 서버가 준 솔트로 늘려 만든다.
      비밀번호 자체는 절대 전송되지 않고, 이 토큰으로는 개인키를 열 수 없다. */
  async userToken(userId, pw, saltB64) {
    const base = await crypto.subtle.importKey('raw',
      new TextEncoder().encode(String(userId).trim().toLowerCase() + '\u0000' + pw),
      'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: b64d(saltB64), iterations: ITER, hash: 'SHA-256' }, base, 256);
    return b64e(bits);
  },

  newSalt() { return b64e(crypto.getRandomValues(new Uint8Array(16))); },

  /* ── 복구 코드
     사람이 옮겨 적기 쉽도록 헷갈리는 글자(I,O,0,1)를 뺀 20자를
     4자씩 끊어 씁니다. 대소문자와 하이픈은 무시합니다. */
  newRecoveryCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = crypto.getRandomValues(new Uint8Array(20));
    const s = Array.from(a, (n) => cs[n % cs.length]).join('');
    return s.match(/.{1,4}/g).join('-');
  },

  normalizeCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  },

  /** 개인키(pkcs8)를 주어진 비밀문구로 감싼다 */
  async wrapKey(pkcs8, secret, saltB64) {
    const key = await WCT.derive(secret, b64d(saltB64), 'key');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pkcs8);
    return { wrapped: b64e(wrapped), iv: b64e(iv) };
  },

  /** 감싸인 개인키를 비밀문구로 푼다. 실패하면 null */
  async unwrapKey(wrappedB64, ivB64, secret, saltB64) {
    try {
      const key = await WCT.derive(secret, b64d(saltB64), 'key');
      return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64) },
        key, b64d(wrappedB64));
    } catch { return null; }
  },

  // ────────── 봉투
  async seal(payload, pubB64) {
    const pub = await crypto.subtle.importKey('spki', b64d(pubB64 || WCT.pub),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes,
      new TextEncoder().encode(JSON.stringify(payload)));
    const wk = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub,
      await crypto.subtle.exportKey('raw', aes));
    return { v: 1, kind: payload.kind || 'record', alg: 'RSA-OAEP-256+AES-256-GCM',
             wk: b64e(wk), iv: b64e(iv), ct: b64e(ct) };
  },

  async open(env) {
    const rawAes = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, WCT.priv, b64d(env.wk));
    const aes = await crypto.subtle.importKey('raw', rawAes, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv) },
      aes, b64d(env.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  },

  // ────────── 세션 (탭 안에서만 유지, 탭 닫으면 소멸)
  async saveSession(pkcs8B64) {
    sessionStorage.setItem('wct', JSON.stringify({
      auth: WCT.auth, pub: WCT.pub, priv: pkcs8B64 || '',
      role: WCT.role, me: WCT.me, at: Date.now(),
    }));
  },

  touch() {
    const raw = sessionStorage.getItem('wct');
    if (!raw) return;
    const s = JSON.parse(raw);
    s.at = Date.now();
    sessionStorage.setItem('wct', JSON.stringify(s));
  },

  async restore() {
    const raw = sessionStorage.getItem('wct');
    if (!raw) return false;
    let s;
    try { s = JSON.parse(raw); } catch { return false; }
    if (!s.auth || Date.now() - (s.at || 0) > IDLE_LIMIT) {
      sessionStorage.removeItem('wct');
      return false;
    }
    try {
      // PD 계정에는 개인키가 없습니다 (주민번호·계좌를 열 수 없음)
      WCT.priv = s.priv
        ? await crypto.subtle.importKey('pkcs8', b64d(s.priv),
            { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'])
        : null;
      WCT.auth = s.auth;
      WCT.pub = s.pub || '';
      WCT.role = s.role || 'admin';
      WCT.me = s.me || null;
      WCT.touch();
      return true;
    } catch {
      sessionStorage.removeItem('wct');
      return false;
    }
  },

  lock() {
    sessionStorage.removeItem('wct');
    sessionStorage.removeItem('wct_data');
    WCT.priv = null; WCT.auth = ''; WCT.data = null;
    WCT.role = 'admin'; WCT.me = null; WCT._cache = {}; WCT._fpKey = null;
    location.href = 'admin.html';
  },

  /** 하위 페이지 진입점. 잠겨 있으면 허브로 돌려보낸다.
      adminOnly=true 인 페이지는 PD 가 들어오면 되돌린다. */
  async requireAuth(adminOnly = false) {
    if (!await WCT.restore()) {
      location.href = 'admin.html?next=' + encodeURIComponent(location.pathname.split('/').pop());
      return false;
    }
    if (adminOnly && !WCT.isAdmin()) {
      location.href = 'admin.html?denied=1';
      return false;
    }
    return true;
  },

  /* 주민번호 지문(blind index)
       같은 번호 → 같은 지문, 지문 → 원본 복원 불가.
       키는 마스터 비밀번호에서 유도하므로 서버에는 절대 없다.
       덕분에 시트만 털려도 지문으로 주민번호를 알아낼 수 없다. */
  _fpKey: null,

  async fpKey() {
    if (WCT._fpKey) return WCT._fpKey;
    // 개인키를 재료로 삼는다 — 이 브라우저에서 잠금을 푼 사람만 만들 수 있다
    const seed = sessionStorage.getItem('wct');
    if (!seed) throw new Error('잠금이 풀려 있지 않습니다.');
    const priv = JSON.parse(seed).priv;
    const bits = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode('wct-fp-v1:' + priv));
    WCT._fpKey = await crypto.subtle.importKey('raw', bits,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return WCT._fpKey;
  },

  /** 주민번호 → 지문 문자열 (숫자만 남겨 정규화 후 HMAC) */
  async fingerprint(rrn) {
    const digits = String(rrn || '').replace(/\D/g, '');
    if (digits.length !== 13) return '';
    const key = await WCT.fpKey();
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(digits));
    return b64e(sig).replace(/[+/=]/g, '').slice(0, 22);
  },

  /** 봉투 여러 개를 한 번에 열어 캐시에 채웁니다.
      명세서·영수증처럼 여러 사람을 한꺼번에 다룰 때 씁니다. */
  async revealMany(list) {
    const need = list.filter((p) => p && p.envFileId && !WCT._cache[p.envFileId]);
    if (!need.length) return;
    const ids = [...new Set(need.map((p) => p.envFileId))];
    const r = await WCT.api('envelopes', { fileIds: ids });
    for (const id of ids) {
      const env = r.envelopes[id];
      if (!env) continue;
      try { WCT._cache[id] = await WCT.open(env); } catch (e) {}
    }
  },

  /** 인력 봉투를 열어 계좌·주민번호 등 원본을 꺼낸다.
      한 번 연 것은 탭이 살아 있는 동안 재사용한다(매번 서버를 두드리지 않도록). */
  _cache: {},
  async reveal(person) {
    if (!person || !person.envFileId) throw new Error('저장된 정보가 없습니다.');
    if (WCT._cache[person.envFileId]) return WCT._cache[person.envFileId];
    const env = (await WCT.api('envelope', { fileId: person.envFileId })).envelope;
    const data = await WCT.open(env);
    WCT._cache[person.envFileId] = data;
    return data;
  },

  /* 페이지를 옮겨도 방금 받은 데이터를 다시 씁니다.
     force=true 는 내가 뭔가 바꾼 직후에만 쓰세요. */
  DATA_TTL: 90 * 1000,

  /* 저장 직후 전체를 다시 읽으면 느립니다.
     화면에 이미 반영해 둔 경우에는 이걸 써서 뒤에서 조용히 맞춥니다. */
  _pending: null,
  syncLater() {
    clearTimeout(WCT._pending);
    WCT._pending = setTimeout(function () {
      WCT.load(true).catch(function () {});
    }, 1500);
  },

  async load(force = false) {
    if (!force) {
      if (WCT.data) { WCT.touch(); return WCT.data; }
      try {
        const raw = sessionStorage.getItem('wct_data');
        if (raw) {
          const c = JSON.parse(raw);
          if (Date.now() - c.at < WCT.DATA_TTL) {
            WCT.data = c.d; WCT.touch(); return WCT.data;
          }
        }
      } catch {}
    }
    WCT.data = await WCT.api('bootstrap', force ? { fresh: true } : {});
    if (WCT.data.role) WCT.role = WCT.data.role;
    if (WCT.data.me) WCT.me = WCT.data.me;
    try {
      sessionStorage.setItem('wct_data', JSON.stringify({ at: Date.now(), d: WCT.data }));
    } catch {}
    WCT.touch();
    return WCT.data;
  },

  /* 화면을 먼저 그리고 데이터는 뒤에서 갱신.
     캐시가 신선하면 조회를 아예 하지 않습니다.
     예전에는 캐시로 한 번, 최신으로 또 한 번 불러 요청이 두 배였습니다. */
  async loadThenRefresh(render) {
    const fresh = WCT.data ||
      (() => { try {
        const c = JSON.parse(sessionStorage.getItem('wct_data') || 'null');
        return c && Date.now() - c.at < WCT.DATA_TTL ? c.d : null;
      } catch { return null; } })();

    if (fresh) {
      WCT.data = fresh;
      render();
      // 캐시가 꽤 지났을 때만 뒤에서 한 번 갱신합니다
      const raw = sessionStorage.getItem('wct_data');
      let age = Infinity;
      try { age = Date.now() - JSON.parse(raw).at; } catch {}
      if (age > 30 * 1000) {
        const before = JSON.stringify(WCT.data);
        try {
          await WCT.load(true);
          if (JSON.stringify(WCT.data) !== before) render();
        } catch {}
      }
      return;
    }
    await WCT.load(false);
    render();
  },
};

/** 클립보드 복사 — https 가 아닌 환경까지 대비한 폴백 포함 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    return ok;
  }
}

/** 화면 하단에 잠깐 뜨는 알림 */
function toast(text, bad = false) {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
      'padding:12px 20px;border-radius:10px;font-size:13px;z-index:999;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.5);transition:opacity .25s;pointer-events:none';
    document.body.appendChild(el);
  }
  el.style.background = bad ? '#2a1614' : '#132318';
  el.style.border = '1px solid ' + (bad ? '#e2564a' : '#4ea87a');
  el.style.color = bad ? '#f0a89f' : '#9fd9bb';
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

/** 계좌를 은행·번호·예금주까지 붙여 한 줄로 */
function accountLine(bank, account, holder) {
  return [bank, account, holder ? `(${holder})` : ''].filter(Boolean).join(' ');
}

// 활동 감지 — 마우스/키보드가 움직이면 잠금 시계를 되돌린다
['click', 'keydown', 'scroll'].forEach((e) =>
  window.addEventListener(e, () => WCT.touch(), { passive: true }));

/* ══════════════ 세액 계산 ══════════════ */

function trunc(v, u) { return Math.floor(v / u) * u; }

/* 소득구분
   biz   사업소득 3.3%  — 계속·반복적 인적용역 (프리랜서)
   other 기타소득 8.8%  — 일시적 인적용역 (단기 알바, 강연 등)     */
const INCOME_TYPES = {
  biz:   { label: '사업소득 3.3%', code: 'A25', short: '프리랜서' },
  other: { label: '기타소득 8.8%', code: 'A40', short: '일반·학생' },
};

/** 사업소득 3.3% — 소득세 1,000원 미만이면 소액부징수(징수 X, 신고 O) */
function calcBizTax(gross, unit = 10) {
  gross = Math.round(Number(gross) || 0);
  if (gross <= 0) return null;
  const it = trunc(gross * 0.03, unit);
  if (it < 1000) {
    return { type: 'biz', gross, base: gross, incomeTax: 0, localTax: 0,
             net: gross, exempt: '소액부징수' };
  }
  const lt = trunc(it * 0.1, unit);
  return { type: 'biz', gross, base: gross, incomeTax: it, localTax: lt,
           net: gross - it - lt, exempt: '' };
}

/** 기타소득 8.8% — 필요경비 60% 차감 후 20%.
    기타소득금액(=지급액의 40%)이 5만원 이하면 과세최저한으로 비과세.
    즉 지급액 125,000원 이하는 세금이 0원입니다. */
function calcOtherTax(gross, unit = 10, expenseRate = 0.6) {
  gross = Math.round(Number(gross) || 0);
  if (gross <= 0) return null;
  const base = Math.round(gross * (1 - expenseRate));
  if (base <= 50000) {
    return { type: 'other', gross, base, incomeTax: 0, localTax: 0,
             net: gross, exempt: '과세최저한' };
  }
  const it = trunc(base * 0.2, unit);
  const lt = trunc(it * 0.1, unit);
  return { type: 'other', gross, base, incomeTax: it, localTax: lt,
           net: gross - it - lt, exempt: '' };
}

/** 소득구분에 맞는 계산기를 고른다 */
function calcTax(gross, unit = 10, type = 'biz') {
  return type === 'other' ? calcOtherTax(gross, unit) : calcBizTax(gross, unit);
}

/** 실지급액에서 세전 금액 역산 */
function calcFromNet(net, type = 'biz') {
  net = Math.round(Number(net) || 0);
  const g0 = Math.round(net / (type === 'other' ? 0.912 : 0.967));
  for (let d = 0; d < 600; d++) {
    for (const g of (d ? [g0 + d, g0 - d] : [g0])) {
      if (g <= 0) continue;
      const r = calcTax(g, 10, type);
      if (r && r.net === net) return r;
    }
  }
  return calcTax(g0, 10, type);
}

/* 4대보험 근로자 부담분
   ⚠️ 계산값은 참고치입니다. 공단 고지서 금액이 정답이며 화면에서 덮어쓸 수 있습니다.
      국민연금은 기준소득월액 등급으로 부과되어 단순 비율과 다를 수 있습니다. */
function calcInsurance(gross, opt = {}) {
  const g = Math.round(Number(gross) || 0);
  const r = (WCT.data && WCT.data.rates) || {};
  const num = (k, d) => Number(r[k] != null ? r[k] : d) || 0;
  // 공단은 통상 10원 미만을 버립니다. 고지서와 다르면 설정에서 단위를 바꾸세요.
  const unit = Math.max(1, num('요율_절사단위', 10));
  const floor = (v) => Math.floor(v / unit) * unit;

  const np = opt.np === false ? 0 : floor(g * num('요율_국민연금', 4.75) / 100);
  const hi = opt.hi === false ? 0 : floor(g * num('요율_건강보험', 3.595) / 100);
  const ltc = hi ? floor(hi * num('요율_장기요양', 13.14) / 100) : 0;
  const ei = opt.ei === true ? floor(g * num('요율_고용보험', 0.9) / 100) : 0;
  return { np, hi, ltc, ei, total: np + hi + ltc + ei };
}

/** 부가세 — 공급가액 기준 10% */
function calcVat(supply) {
  const s = Math.round(Number(supply) || 0);
  return { supply: s, vat: Math.floor(s * 0.1), total: s + Math.floor(s * 0.1) };
}

/** 합계금액에서 공급가액·부가세 역산 */
function vatFromTotal(total) {
  const t = Math.round(Number(total) || 0);
  const supply = Math.round(t / 1.1);
  return { supply, vat: t - supply, total: t };
}

/* ══════════════ 마스킹 ══════════════ */

const maskRrn = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 13 ? `${d.slice(0, 6)}-${d[6]}******` : '-';
};
const maskAcc = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length < 5 ? '-' : '*'.repeat(d.length - 4) + d.slice(-4);
};

/* 계좌번호에서 숫자만 남깁니다.
   제출자가 은행명·하이픈·공백을 섞어 적어도 은행 홈페이지 입력칸에
   그대로 붙여넣을 수 있는 형태로 만들어 줍니다.
   예: '국민 1002-123-456789' → '1002123456789' */
const accDigits = (v) => String(v || '').replace(/\D/g, '');

/* ══════════════ 날짜 · 기한 ══════════════ */

/* 날짜는 반드시 '한국 시간 기준'으로 뽑습니다.
   toISOString() 은 UTC라서 오전 9시 이전에 쓰면 하루 전날이 나옵니다.
   (매월 1일 아침이면 귀속월까지 지난달로 잡히는 사고가 납니다) */
const _pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
const today = () => ymd(new Date());
const thisYm = () => today().slice(0, 7);

/** 원천세: 지급월의 다음 달 10일 */
function whtDeadline(payYm) {
  const [y, m] = payYm.split('-').map(Number);
  return new Date(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 10);
}

/** 간이지급명세서: 귀속월의 '다음 달 말일'
    new Date(y, monthIndex, 0) 은 monthIndex 직전 달의 말일을 준다.
    m 이 1~12 이므로 다음 달 말일은 monthIndex = m + 1 이다.
    (예: 2026-08 귀속 → new Date(2026, 9, 0) = 2026-09-30) */
function stmtDeadline(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? new Date(y + 1, 1, 0) : new Date(y, m + 1, 0);
}

function dday(date) {
  const left = Math.ceil((date - new Date()) / 86400000);
  return {
    left,
    text: left < 0 ? `${-left}일 지남` : left === 0 ? '오늘' : `D-${left}`,
    color: left < 0 ? 'var(--bad)' : left <= 3 ? 'var(--warn)' : 'var(--dim)',
  };
}

/** 원천세 집계 — '지급일'이 속한 달 기준 (귀속월 아님)
    사업소득(A25)과 기타소득(A40)은 신고서에서 칸이 다르므로 나눠서 낸다 */
function whtAggregate(payYm) {
  const all = (WCT.data.payments || []).filter(
    (p) => (p.payDate || '').slice(0, 7) === payYm && p.status !== '예정');
  const part = (type) => {
    const list = all.filter((p) => (p.incomeType || 'biz') === type);
    return { list, count: new Set(list.map((p) => p.personId)).size,
      gross: list.reduce((a, p) => a + p.gross, 0),
      tax: list.reduce((a, p) => a + p.incomeTax, 0),
      local: list.reduce((a, p) => a + p.localTax, 0) };
  };
  const biz = part('biz'), other = part('other');
  return {
    list: all, biz, other,
    count: new Set(all.map((p) => p.personId)).size,
    gross: biz.gross + other.gross,
    tax: biz.tax + other.tax,
    local: biz.local + other.local,
    accrual: [...new Set(all.map((p) => p.ym))].sort(),
  };
}

/* ══════════════ 캘린더에 보낼 일정 ══════════════
   key 를 기준으로 갱신하므로 여러 번 눌러도 일정이 늘어나지 않습니다. */

function vatDeadlines(year) {
  return [
    { key: `vat-${year}-1`, date: `${year}-04-25`, title: '부가세 · 1기 예정 (1~3월)' },
    { key: `vat-${year}-2`, date: `${year}-07-25`, title: '부가세 · 1기 확정 (4~6월)' },
    { key: `vat-${year}-3`, date: `${year}-10-25`, title: '부가세 · 2기 예정 (7~9월)' },
    { key: `vat-${year}-4`, date: `${year + 1}-01-25`, title: '부가세 · 2기 확정 (10~12월)' },
  ];
}

/** 캘린더 제목용 짧은 월 표기. 올해면 '8월', 다른 해면 '25년 8월' */
function shortYm(ym, baseYear) {
  const [y, m] = ym.split('-').map(Number);
  return y === baseYear ? `${m}월` : `${String(y).slice(2)}년 ${m}월`;
}

function buildCalendarEvents(D) {
  const ev = [];
  const now = new Date();
  const Y = now.getFullYear();

  // 원천세 — 지급월 기준 (급여만 있어도 신고 대상)
  const paid = (D.payments || []).filter((p) => p.status !== '예정')
    .map((p) => (p.payDate || '').slice(0, 7)).filter(Boolean);
  const wage = (D.payroll || []).map((r) => r.ym);
  [...new Set([...paid, ...wage])].sort().forEach((m) => {
    ev.push({ key: `wht-${m}`, date: ymd(whtDeadline(m)), remind: 3,
      title: `원천세 · ${shortYm(m, Y)} 지급분`,
      desc: '홈택스(소득세)와 위택스(지방소득세)를 둘 다 하셔야 합니다.\n' +
            '업무 허브 → 원천징수 → 원천세 탭 → [신고 순서 보기]' });
  });

  // 간이지급명세서 — 귀속월 기준 (원천세와 날짜가 다릅니다)
  [...new Set((D.payments || []).filter((p) => p.status === '지급완료')
    .map((p) => p.ym))].sort().forEach((m) => {
    ev.push({ key: `stmt-${m}`, date: ymd(stmtDeadline(m)), remind: 3,
      title: `지급명세서 · ${shortYm(m, Y)} 귀속`,
      desc: '업무 허브 → 원천징수 → 월별 신고 탭 → [엑셀 만들기]' });
  });

  // 부가세 · 법인세
  const y = now.getFullYear();
  [y - 1, y, y + 1].forEach((yy) => vatDeadlines(yy).forEach((v) =>
    ev.push(Object.assign({ remind: 5,
      desc: '업무 허브 → 세금계산서 → 부가세 탭' }, v))));
  [y, y + 1].forEach((yy) => ev.push({ key: `corp-${yy}`, date: `${yy}-03-31`,
    remind: 14, title: `법인세 · ${yy - 1}년 귀속`,
    desc: '결산·세무조정이 필요합니다. 세무사에게 맡기세요.' }));

  // 프로젝트 마감
  const projById = {};
  (D.projects || []).forEach((p) => { projById[p.id] = p; });
  (D.projects || []).filter((p) => p.active !== false && p.due && p.stage !== '완료')
    .forEach((p) => {
      ev.push({ key: `proj-${p.id}`, date: p.due, remind: 3,
        title: `마감 · ${p.name}`,
        desc: (p.client ? `클라이언트: ${p.client}\n` : '') + `단계: ${p.stage}` });
    });

  /* 작업 — 📅 를 켠 것만 넣습니다.
     마감일이 없거나, 이미 완료했거나, 프로젝트가 끝났으면 넣지 않습니다. */
  (D.tasks || []).filter((t) => t.cal && t.due && !t.done).forEach((t) => {
    const p = projById[t.projectId];
    if (!p || p.active === false || p.stage === '완료') return;
    ev.push({ key: `task-${t.id}`, date: t.due, remind: 2,
      title: `${t.title} · ${p.name}`,
      desc: `프로젝트: ${p.name}\n단계: ${t.stage}` +
            (t.assignee ? `\n담당: ${t.assignee}` : '') });
  });

  // 1년 넘게 지난 것은 만들지 않습니다
  const cut = ymd(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));
  return ev.filter((e) => e.date >= cut);
}

/* ══════════════ 공통 헤더 ══════════════ */

function mountHeader(title, backTo = 'admin.html') {
  const el = document.createElement('div');
  el.className = 'appbar';
  el.innerHTML = `
    <a class="back" href="${backTo}">← 홈</a>
    <span class="apptitle">${esc(title)}</span>
    <button class="g sm" id="__reload">새로고침</button>
    <button class="g sm" id="__lock">잠그기</button>`;
  document.body.insertBefore(el, document.body.firstChild);
  $('__lock').onclick = () => WCT.lock();
  $('__reload').onclick = async () => {
    const b = $('__reload');
    b.disabled = true; b.textContent = '갱신 중…';
    try {
      await WCT.load(true);
      if (typeof window.__onReload === 'function') window.__onReload();
      toast('최신 정보로 갱신했습니다.');
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; b.textContent = '새로고침'; }
  };
}
