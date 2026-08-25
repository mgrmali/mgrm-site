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
  auth: '', priv: null, pub: '', data: null,

  // ────────── 통신
  async api(action, body = {}) {
    const r = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, key: WCT.auth }, body)),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '요청에 실패했습니다.');
    return j;
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
      auth: WCT.auth, pub: WCT.pub, priv: pkcs8B64, at: Date.now(),
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
    if (!s.priv || Date.now() - (s.at || 0) > IDLE_LIMIT) {
      sessionStorage.removeItem('wct');
      return false;
    }
    try {
      WCT.priv = await crypto.subtle.importKey('pkcs8', b64d(s.priv),
        { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
      WCT.auth = s.auth;
      WCT.pub = s.pub;
      WCT.touch();
      return true;
    } catch {
      sessionStorage.removeItem('wct');
      return false;
    }
  },

  lock() {
    sessionStorage.removeItem('wct');
    WCT.priv = null; WCT.auth = ''; WCT.data = null;
    location.href = 'admin.html';
  },

  /** 하위 페이지 진입점. 잠겨 있으면 허브로 돌려보낸다. */
  async requireAuth() {
    if (await WCT.restore()) return true;
    location.href = 'admin.html?next=' + encodeURIComponent(location.pathname.split('/').pop());
    return false;
  },

  async load(force = false) {
    if (!WCT.data || force) WCT.data = await WCT.api('bootstrap');
    WCT.touch();
    return WCT.data;
  },
};

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

/* ══════════════ 날짜 · 기한 ══════════════ */

const today = () => new Date().toISOString().slice(0, 10);
const thisYm = () => new Date().toISOString().slice(0, 7);

/** 원천세: 지급월의 다음 달 10일 */
function whtDeadline(payYm) {
  const [y, m] = payYm.split('-').map(Number);
  return new Date(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 10);
}

/** 간이지급명세서: 귀속월의 다음 달 말일 */
function stmtDeadline(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0);
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

/* ══════════════ 공통 헤더 ══════════════ */

function mountHeader(title, backTo = 'admin.html') {
  const el = document.createElement('div');
  el.className = 'appbar';
  el.innerHTML = `
    <a class="back" href="${backTo}">← 홈</a>
    <span class="apptitle">${esc(title)}</span>
    <button class="g sm" id="__lock">잠그기</button>`;
  document.body.insertBefore(el, document.body.firstChild);
  $('__lock').onclick = () => WCT.lock();
}
