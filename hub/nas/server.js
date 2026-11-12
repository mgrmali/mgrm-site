/* 맹그라미 업무 허브 — NAS 저장 서버
   QNAP Container Station 에서 실행합니다. (node:22-alpine, 추가 설치 없음)

   하는 일
     1. QNAP 계정 확인 (허브 로그인)         POST /auth
     2. 허브 데이터 읽기·쓰기 (구글 시트 대신)  POST /rpc
     3. 외부 공개 기능 (정산 정보 제출 폼)     POST /public
     4. 구글 시트 → NAS 한 번 옮기기          POST /import

   Cloudflare 터널을 통해 hub.mgrm.kr Worker 만 접근합니다.
   모든 요청은 비밀 열쇠(STORE_TOKEN)가 있어야 하고,
   누가 요청했는지(아이디·역할)는 Worker 가 확인한 뒤 붙여 보냅니다.

   기존 앱스스크립트(Code.gs, 원천징수 자료관리)의 동작을 그대로 옮겼습니다.
   시트 탭 이름·열 이름도 같아서, 나중에 엑셀로 내보내도 같은 모양입니다. */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const VERSION = 'hub-store 1.4.0';
const PORT = +(process.env.PORT || 8080);
const DATA = path.resolve(process.env.DATA_DIR || '/data');
const TOKEN = process.env.STORE_TOKEN || '';
const DATA_KEY = process.env.DATA_KEY || '';          // 개인키를 디스크에 잠가 두는 열쇠
const QNAP_URL = process.env.QNAP_URL || '';
/* 그룹 파일: 쉼표로 여러 경로를 주면 앞에서부터 읽히는 파일을 씁니다.
   QNAP 은 /etc/group 을 통째로 갈아끼우므로 파일 하나를 마운트하면 옛 내용이 남습니다.
   → 폴더(/etc/config)를 마운트하고 그 안의 group 을 읽는 것이 안전합니다. */
const GROUP_FILES = String(process.env.GROUP_FILE || '/qnap/config/group,/qnap/group')
  .split(',').map((x) => x.trim()).filter(Boolean);
function readGroupFile_() {
  for (const p of GROUP_FILES) {
    try { const t = fs.readFileSync(p, 'utf8'); if (t) return t; } catch {}
  }
  return '';
}
const ADMIN_GROUP = process.env.HUB_ADMIN_GROUP || 'hub-admin';
const STAFF_GROUP = process.env.HUB_STAFF_GROUP || 'hub-staff';
const BLOCKED_USERS = ['admin'];                      // QNAP 기본 관리자는 허브 로그인 금지
const MAX_BYTES = 9 * 1024 * 1024;

for (const [k, v] of [['STORE_TOKEN', TOKEN], ['DATA_KEY', DATA_KEY]]) {
  if (v.length < 32) { console.error(`${k} 가 비어 있거나 너무 짧아요 (32자 이상).`); process.exit(1); }
}
if (!QNAP_URL) console.warn('QNAP_URL 이 비어 있어요 — 로그인이 동작하지 않습니다.');

fs.mkdirSync(path.join(DATA, 'files'), { recursive: true });
fs.mkdirSync(path.join(DATA, '백업'), { recursive: true });
process.umask(0o007);

// ══════════════════════════════════════════ 저장소 (SQLite)
const db = new DatabaseSync(path.join(DATA, 'hub.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS rows (
    pos   INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet TEXT NOT NULL,
    data  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rows_sheet ON rows(sheet, pos);
  CREATE TABLE IF NOT EXISTS log (
    at TEXT NOT NULL, user TEXT, role TEXT, action TEXT, ip TEXT, ok INTEGER
  );
`);

/* 시트(탭) 구조 — Code.gs 의 SHEETS 와 같습니다 */
const SHEETS = {
  '설정':   ['키', '값'],
  '초대':   ['토큰', '라벨', '역할', '만료', '생성', '사용', '정원', '제출수', '차단'],
  '제출함': ['제출ID', '수신시각', '구분', '토큰', '라벨', '파일ID', '크기', '상태'],
  '인력':   ['ID', '성명', '역할', '은행', '예금주', '계좌표시', '봉투ID',
             '업종코드', '동의일', '활성', '등록일', '소득구분', '지문'],
  '거래처': ['ID', '상호', '사업자번호', '대표자', '업태', '종목', '주소',
             '담당자', '이메일', '은행', '예금주', '계좌표시', '봉투ID', '등록일'],
  '프로젝트': ['ID', '이름', '클라이언트', '활성', '단계', '시작일', '마감일',
             '계약금액', '담당', '메모', '등록일', '코드', '폴더', '회차표'],
  '회차':   ['ID', '프로젝트ID', '회차', '날짜', '장소', '주소', '집합', '내용', '상태', '등록일'],
  '작업':   ['ID', '프로젝트ID', '단계', '제목', '담당', '마감일', '완료', '순서', '등록일', '캘린더',
             '시작일', '캘린더이름'],
  '지급':   ['ID', '인력ID', '성명', '지급일', '귀속월', '프로젝트', '역할',
             '지급액', '소득세', '지방소득세', '실지급', '소액부징수', '상태', '메모', '등록일',
             '소득구분', '소득금액'],
  '게시판': ['ID', '분류', '제목', '내용', '작성자', '작성일', '수정일', '고정'],
  '금고':   ['ID', '분류', '이름', '봉투ID', '메모', '수정일', '등록일'],
  '캘린더': ['키', '제목', '날짜', '캘린더', '이벤트ID', '동기시각', '지문'],
  '매출':   ['ID', '일자', '프로젝트', '거래처', '항목', '공급가액', '부가세', '합계',
             '발행상태', '발행일', '입금일', '증빙', '메모', '등록일'],
  '매입':   ['ID', '일자', '프로젝트', '거래처', '분류', '항목', '공급가액', '부가세', '합계',
             '증빙', '공제여부', '메모', '등록일'],
  '급여자': ['ID', '성명', '구분', '기본급여', '기본소득세', '메모', '활성', '등록일',
             '국민연금', '건강보험', '고용보험'],
  '급여':   ['ID', '지급연월', '급여자ID', '성명', '지급액', '소득세', '지방소득세', '메모', '등록일',
             '국민연금료', '건강보험료', '장기요양료', '고용보험료'],
  '원천세': ['지급연월', '귀속연월', '사업소득인원', '사업소득지급액', '사업소득세',
             '근로소득인원', '근로소득지급액', '근로소득세', '소득세합계', '지방소득세',
             '홈택스신고일', '위택스신고일', '메모', '기록일',
             '기타소득인원', '기타소득지급액', '기타소득세'],
  // ── 컬러리버브 리뷰·납품·문진·문의 (예전 앱스스크립트 v2.4 와 같은 열)
  '리뷰프로젝트': ['키', '작품명', '버전', '영상주소', '비밀번호', '만료일', 'FPS', '활성',
             '납품허용', '납품안내', '납품만료', '메모', '등록일'],
  '리뷰코멘트': ['접수시각', '프로젝트키', '작품명', '버전', '타임코드', '초', '작성자', '내용', '처리', '코멘트ID', '읽음'],
  '납품파일': ['ID', '프로젝트키', '파일명', '구분', '규격', '용량', '체크섬', '링크', '활성'],
  '납품기록': ['최근수령', '프로젝트키', '작품명', '이름', '소속', '받은파일', '횟수', '최초수령', '읽음'],
  '문진':   ['접수번호', '접수시각', '담당자', '회사명', '연락처', '이메일',
             '프로젝트명', '영상 종류', '러닝타임', '컷 수', '게재처', '편집 상태',
             '납품 희망일', '중간 확인일', '카메라 기종', '촬영 포맷', '프레임레이트', '해상도',
             '현장 LUT', '멀티 카메라', '편집본 형태', '자막·CG', '촬영 담당자 연락처',
             '레퍼런스 링크', '레퍼런스에서 좋았던 점', '피하고 싶은 느낌',
             '피부톤', '브랜드색', '브랜드색 기준', '기존 시리즈', '기존 영상 링크',
             '최종 전달처', '규격서', '추가 버전', '최종 결정권자', '피드백 담당자', '감수 방식', '리뷰 환경', '기타 참고사항',
             '동의: 소스 보관', '동의: 수정 범위', '_유입경로', '_lang', '진행 상태', '읽음', '메모'],
  '문의':   ['접수번호', '접수시각', '이름/회사', '이메일', '문의 분야', '내용', '_유입경로', '진행 상태', '읽음', '메모'],
};
const VIDEO_BASE = process.env.VIDEO_BASE || 'https://mgrm.myqnapcloud.com:8081/review/';
/* 리뷰 영상 올리기: 허브에서 올린 파일을 이 폴더에 저장합니다.
   QNAP 웹 서버가 이 폴더를 VIDEO_BASE 주소로 내보내야 합니다 (예: Web 공유 폴더의 review). */
const REVIEW_DIR = process.env.REVIEW_DIR || '/web/review';
const REVIEW_BASE = process.env.REVIEW_BASE || 'https://mgrm.kr/review.html?p=';
const DELIVERY_BASE = process.env.DELIVERY_BASE || 'https://mgrm.kr/delivery.html?p=';

const Q = {
  all: db.prepare('SELECT pos, data FROM rows WHERE sheet = ? ORDER BY pos'),
  ins: db.prepare('INSERT INTO rows (sheet, data) VALUES (?, ?)'),
  upd: db.prepare('UPDATE rows SET data = ? WHERE pos = ?'),
  del: db.prepare('DELETE FROM rows WHERE pos = ?'),
  wipe: db.prepare('DELETE FROM rows WHERE sheet = ?'),
  log: db.prepare('INSERT INTO log (at, user, role, action, ip, ok) VALUES (?, ?, ?, ?, ?, ?)'),
};

/** 시트 전체를 객체 배열로. 각 행에 _pos(행 번호 대신)가 붙습니다. */
function rows_(name) {
  return Q.all.all(name).map((r) => Object.assign(JSON.parse(r.data), { _pos: r.pos }));
}
function clean_(o) { const c = Object.assign({}, o); delete c._pos; return c; }
/** 배열(appendRow 형식) → 열 이름 객체 */
function obj_(name, arr) {
  const o = {};
  SHEETS[name].forEach((h, i) => { o[h] = arr[i] === undefined ? '' : arr[i]; });
  return o;
}
function append_(name, arrOrObj) {
  const o = Array.isArray(arrOrObj) ? obj_(name, arrOrObj) : arrOrObj;
  return Number(Q.ins.run(name, JSON.stringify(clean_(o))).lastInsertRowid);
}
function save_(row) { Q.upd.run(JSON.stringify(clean_(row)), row._pos); }
function remove_(row) { Q.del.run(row._pos); }
function patch_(row, set) {
  Object.keys(set).forEach((k) => { if (set[k] !== undefined) row[k] = set[k]; });
  save_(row);
}
function nextId_(name) {
  let m = 0;
  rows_(name).forEach((x) => { m = Math.max(m, Number(x.ID) || 0); });
  return m + 1;
}
function tx_(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function cfgGet_(key) {
  const f = rows_('설정').find((r) => String(r['키']) === key);
  return f ? String(f['값']) : '';
}
function cfgSet_(key, value) {
  const f = rows_('설정').find((r) => String(r['키']) === key);
  if (f) patch_(f, { '값': value });
  else append_('설정', [key, value]);
}

// ══════════════════════════════════════════ 봉투 파일 (암호화된 JSON)
/* 봉투는 브라우저에서 이미 공개키로 잠근 상태로 들어옵니다.
   파일 ID 는 영문·숫자·_·- 만 씁니다 (구글 드라이브 ID 도 그대로 들어감). */
const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
function fileCreate_(text) {
  const id = 'n' + crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(DATA, 'files', id + '.json'), text);
  return id;
}
function fileRead_(id) {
  if (!ID_RE.test(String(id))) throw new Error('잘못된 파일 ID 입니다.');
  return fs.readFileSync(path.join(DATA, 'files', id + '.json'), 'utf8');
}
function fileTrash_(id) {
  if (!ID_RE.test(String(id))) return;
  const src = path.join(DATA, 'files', id + '.json');
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.join(DATA, 'files', '_삭제됨'), { recursive: true });
  fs.renameSync(src, path.join(DATA, 'files', '_삭제됨', id + '_' + Date.now() + '.json'));
}

// ══════════════════════════════════════════ 개인키 (관리자 전용)
/* 원래는 관리자 비밀번호로만 열리던 개인키입니다.
   이제는 NAS 에 DATA_KEY 로 잠가 두고, 관리자 그룹으로 로그인한 사람에게만 내려줍니다. */
function seal_(text) {
  const key = crypto.createHash('sha256').update(DATA_KEY).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
function unseal_(s) {
  const [iv, tag, ct] = String(s).split('.').map((x) => Buffer.from(x, 'base64'));
  const key = crypto.createHash('sha256').update(DATA_KEY).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
function keystore_() {
  const sealed = cfgGet_('privSealed');
  return { pub: cfgGet_('pub'), pkcs8: sealed ? unseal_(sealed) : '' };
}

// ══════════════════════════════════════════ 날짜 도우미
function kst_(d) {
  const t = new Date((d ? new Date(d) : new Date()).getTime() + 9 * 3600e3);
  return t.toISOString();   // 끝의 Z 는 무시하고 앞부분만 씀
}
const nowStr_ = () => kst_().slice(0, 16).replace('T', ' ');           // yyyy-MM-dd HH:mm
const stamp_ = () => kst_().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
function fmt_(v) {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return kst_(s).slice(0, 16).replace('T', ' ');
  return s;
}
function ym_(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return kst_(s).slice(0, 7);
  const m = s.match(/^(\d{4})[-\/.]?(\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) : s;
}
function ymd_(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return kst_(s).slice(0, 10);
  return s.slice(0, 10);
}
const isTrue_ = (v) => v === true || String(v).toUpperCase() === 'TRUE';
const notFalse_ = (v) => v !== false && String(v).toUpperCase() !== 'FALSE';

// ══════════════════════════════════════════ QNAP 로그인
const fails = new Map();   // 키(아이디·IP) → { n, until }
const LOCK_N = 5, LOCK_MS = 15 * 60e3;

function lockedFor_(k) {
  const f = fails.get(k);
  if (!f) return 0;
  if (f.until && f.until > Date.now()) return f.until - Date.now();
  if (f.until && f.until <= Date.now()) fails.delete(k);
  return 0;
}
function failed_(k) {
  const f = fails.get(k) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= LOCK_N) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails.set(k, f);
}

/** QNAP 그룹 파일에서 이 계정이 어느 허브 그룹에 들어 있는지 */
function groupsOf_(user) {
  let text = '';
  text = readGroupFile_(); if (!text) return [];
  const u = String(user).toLowerCase();
  return text.split('\n').map((l) => l.split(':')).filter((p) => p.length >= 4)
    .filter((p) => p[3].split(',').map((x) => x.trim().toLowerCase()).includes(u))
    .map((p) => p[0]);
}
function roleOf_(user) {
  const g = groupsOf_(user);
  if (g.includes(ADMIN_GROUP)) return 'admin';
  if (g.includes(STAFF_GROUP)) return 'pd';
  return '';
}
/** 허브 그룹 구성원 목록 (계정 화면 표시용) */
function members_() {
  let text = '';
  text = readGroupFile_(); if (!text) return [];
  const out = [];
  text.split('\n').map((l) => l.split(':')).filter((p) => p.length >= 4).forEach((p) => {
    const role = p[0] === ADMIN_GROUP ? 'admin' : p[0] === STAFF_GROUP ? 'pd' : '';
    if (!role) return;
    p[3].split(',').map((x) => x.trim()).filter(Boolean).forEach((u) => {
      if (!out.some((o) => o.userId === u)) out.push({ userId: u, role });
      else if (role === 'admin') out.find((o) => o.userId === u).role = 'admin';
    });
  });
  return out;
}

/** QNAP authLogin.cgi 로 아이디·비밀번호 확인
    QNAP_URL 에 여러 주소를 쉼표로 적을 수 있고(예: http://ip:8080,https://ip:443),
    앞에서부터 차례로 시도합니다. 거절 사유는 로그에 남깁니다(비밀번호는 안 남김). */
function qnapOnce_(base, user, pw) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ user, pwd: Buffer.from(pw, 'utf8').toString('base64'),
      serviceKey: '1', remme: '0', client_app: 'mgrm-hub' }).toString();
    const u = new URL(base.replace(/\/+$/, '') + '/cgi-bin/authLogin.cgi');
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', timeout: 10000, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'mgrm-hub' } }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => {
        const tag = (n) => ((t.match(new RegExp(`<${n}>(?:<!\\[CDATA\\[)?([^<\\]]*)`)) || [])[1] || '');
        const passed = tag('authPassed') === '1';
        const sid = tag('authSid');
        if (passed && sid) {
          try {
            lib.get(new URL(base.replace(/\/+$/, '') + '/cgi-bin/authLogin.cgi?logout=1&sid=' +
              encodeURIComponent(sid)), { rejectUnauthorized: false }, (r) => r.resume()).on('error', () => {});
          } catch {}
        }
        const info = { status: res.statusCode, authPassed: tag('authPassed'), errorValue: tag('errorValue'),
          need_2sv: tag('need_2sv'), pw_status: tag('pw_status'), is_booting: tag('is_booting'),
          head: passed ? '' : t.replace(/\s+/g, ' ').slice(0, 300) };
        resolve({ passed, need2sv: tag('need_2sv') === '1' || /need_2sv>1|2sv/i.test(t) && !passed,
                  name: tag('username') || user, info, base });
      });
    });
    req.on('timeout', () => req.destroy(new Error('NAS 응답 시간 초과')));
    req.on('error', reject);
    req.end(body);
  });
}
async function qnapCheck_(user, pw) {
  const bases = QNAP_URL.split(',').map((s) => s.trim()).filter(Boolean);
  if (!bases.length) throw new Error('NAS 설정(QNAP_URL)이 비어 있습니다.');
  let last = null, lastErr = null;
  for (const base of bases) {
    try {
      const r = await qnapOnce_(base, user, pw);
      console.log(`[auth] ${user} @ ${base} →`, JSON.stringify(r.info));
      if (r.passed || r.need2sv) return r;
      last = r;
    } catch (e) { lastErr = e; console.log(`[auth] ${user} @ ${base} → 연결 실패: ${e.message}`); }
  }
  if (last) return last;
  throw lastErr || new Error('NAS 에 연결하지 못했습니다.');
}

async function auth_(b) {
  const user = String(b.user || '').trim();
  const pw = String(b.pw || '');
  const ip = String(b.ip || '');
  if (!user || !pw) return { ok: false, error: '아이디와 비밀번호를 입력하세요.' };
  const kU = 'u:' + user.toLowerCase(), kI = 'i:' + ip;
  const wait = Math.max(lockedFor_(kU), ip ? lockedFor_(kI) : 0);
  if (wait) return { ok: false, error: `여러 번 틀려 잠시 잠겼습니다. ${Math.ceil(wait / 60e3)}분 뒤에 다시 시도하세요.` };

  const deny = (msg) => { failed_(kU); if (ip) failed_(kI); log_(user, '', 'login', ip, false);
                          return { ok: false, error: msg }; };
  if (BLOCKED_USERS.includes(user.toLowerCase())) {
    return deny('이 계정으로는 허브에 로그인할 수 없습니다. 개인 계정을 쓰세요.');
  }
  let r;
  try { r = await qnapCheck_(user, pw); }
  catch (e) { return { ok: false, error: 'NAS에 확인하지 못했습니다: ' + e.message }; }
  if (r.need2sv) return deny('2단계 인증이 켜진 계정은 아직 허브 로그인을 지원하지 않습니다.');
  if (!r.passed) return deny('아이디 또는 비밀번호가 올바르지 않습니다.');
  const role = roleOf_(user);
  if (!role) return deny(`허브 사용 권한이 없는 계정입니다. QNAP에서 '${ADMIN_GROUP}' 또는 '${STAFF_GROUP}' 그룹에 넣어 주세요.`);
  fails.delete(kU);
  log_(user, role, 'login', ip, true);
  return { ok: true, user, name: r.name || user, role };
}

function log_(user, role, action, ip, ok) {
  try { Q.log.run(nowStr_(), user || '', role || '', action || '', ip || '', ok ? 1 : 0); } catch {}
}

// ══════════════════════════════════════════ 공개 기능 (로그인 없음)
function checkToken_(token) {
  if (!token) return { ok: false, error: '링크에 인증 정보가 없습니다.' };
  const r = rows_('초대').find((x) => String(x['토큰']) === String(token));
  if (!r) return { ok: false, error: '유효하지 않은 링크입니다.' };
  if (r['사용'] || isTrue_(r['차단'])) return { ok: false, error: '이미 제출이 완료된 링크입니다.' };
  const exp = r['만료'] ? new Date(r['만료']) : null;
  if (exp && !isNaN(exp.getTime()) && exp < new Date()) {
    return { ok: false, error: '유효기간이 지난 링크입니다. 담당자에게 새 링크를 요청하세요.' };
  }
  return { ok: true, label: String(r['라벨'] || ''), role: String(r['역할'] || '') };
}

const COMPANY_DEFAULT = {
  '회사명': '주식회사 맹그라미',
  '사업자번호': '652-88-01977',
  '대표자': '박수진, 맹진욱 (공동대표)',
  '사업장주소': '경상북도 안동시 경북대로 427, 202호 (옥동, 대신빌딩)',
  '업태': '정보통신업',
  '종목': '미디어콘텐츠창작업',
  '계산서이메일': 'wlsdnr601@mgrm.kr',
  '계산서안내': '용역 완료 후 7일 이내에 발행 부탁드립니다.',
};
const RATE_DEFAULT = {
  '요율_국민연금': '4.75', '요율_건강보험': '3.595', '요율_장기요양': '13.14',
  '요율_고용보험': '0.9', '요율_절사단위': '10',
};
function companyInfo_() {
  const o = {}; Object.keys(COMPANY_DEFAULT).forEach((k) => { o[k] = cfgGet_(k) || COMPANY_DEFAULT[k]; });
  return o;
}
function rates_() {
  const o = {}; Object.keys(RATE_DEFAULT).forEach((k) => { o[k] = cfgGet_(k) || RATE_DEFAULT[k]; });
  return o;
}

function public_(b) {
  const a = String(b.action || '');
  if (a === 'status') return { ok: true, initialized: !!cfgGet_('pub'), saltAuth: '' };
  if (a === 'pubkey') return { ok: true, pub: cfgGet_('pub') };
  if (a === 'company') {
    const c = companyInfo_();
    return { ok: true, company: { name: c['회사명'], bizNo: c['사업자번호'], ceo: c['대표자'],
      address: c['사업장주소'], bizType: c['업태'], bizItem: c['종목'],
      email: c['계산서이메일'], notice: c['계산서안내'] } };
  }
  if (a === 'check') return checkToken_(b.t);
  if (a === 'submit' || (!a && b.token && b.envelope)) return tx_(() => submit_(b));
  // 컬러리버브 — 예전 폼은 action 없이 '_폼종류' 로 구분해 보냈습니다
  const kind = String(b['_폼종류'] || '');
  const ra = a || (kind === '리뷰코멘트' ? 'review.comment' : kind === '납품기록' ? 'delivery.record'
                : kind === '작업문의' ? 'inquiry' : (b['담당자'] || b['프로젝트명']) ? 'intake' : '');
  if (ra === 'review.meta') return metaProject_(b.p);
  if (ra === 'review.open') return openProject_(b.p, b.pw);
  if (ra === 'review.comment') return tx_(() => handleReview_(b));
  if (ra === 'delivery.meta') return deliveryMeta_(b.p);
  if (ra === 'delivery.open') return deliveryOpen_(b.p, b.pw);
  if (ra === 'delivery.record') return tx_(() => handleDelivery_(b));
  if (ra === 'intake') return tx_(() => handleIntake_(b));
  if (ra === 'inquiry') return tx_(() => handleInquiry_(b));
  return { ok: false, error: 'unknown action' };
}

// ══════════════════════════════════════════ 컬러리버브: 리뷰 · 납품 (공개)
function isOn_(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const t = String(v).trim().toLowerCase();
  if (!t) return false;
  return ['false', '0', 'x', 'no', 'n', 'off', '아니오', '아니요', '꺼짐', '중지'].indexOf(t) < 0;
}
function resolveSrc_(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  return VIDEO_BASE + t.replace(/^\/+/, '');
}
function isExpired_(v) {
  if (!v) return false;
  const d = new Date(String(v).length <= 10 ? String(v) + 'T23:59:59+09:00' : v);
  if (isNaN(d.getTime())) return false;
  return d < new Date();
}
function findProject_(key) {
  const r = rows_('리뷰프로젝트').find((x) => String(x['키']).trim() === String(key || '').trim());
  if (!r) return null;
  return { row: r, key: String(r['키']).trim(), title: String(r['작품명'] || ''), ver: String(r['버전'] || ''),
    src: resolveSrc_(r['영상주소']), pw: String(r['비밀번호'] || '').trim(), until: r['만료일'] || '',
    fps: Number(r['FPS']) || 24, on: isOn_(r['활성']), deliver: isOn_(r['납품허용']),
    dnote: String(r['납품안내'] || '').trim(), duntil: r['납품만료'] || r['만료일'] || '' };
}
function checkProject_(key) {
  const r = findProject_(key);
  if (!r) return { ok: false, error: 'none' };
  if (!r.on) return { ok: false, error: 'off', title: r.title };
  if (isExpired_(r.until)) return { ok: false, error: 'expired', title: r.title };
  return { ok: true, row: r };
}
function metaProject_(key) {
  const c = checkProject_(key);
  if (!c.ok) return c;
  return { ok: true, title: c.row.title, ver: c.row.ver, need: !!c.row.pw };
}
function openProject_(key, pw) {
  const c = checkProject_(key);
  if (!c.ok) return c;
  const r = c.row;
  if (r.pw && String(pw || '').trim() !== r.pw) return { ok: false, error: 'pw' };
  const list = rows_('리뷰코멘트').filter((x) => String(x['프로젝트키']).trim() === r.key)
    .map((x) => ({ id: x['코멘트ID'], tc: x['타임코드'], sec: x['초'], who: x['작성자'], txt: x['내용'] }));
  return { ok: true, title: r.title, ver: r.ver, src: r.src, fps: r.fps, comments: list,
    delivery: r.deliver && !isExpired_(r.duntil) };
}
function handleReview_(d) {
  const job = d['작업'] || '등록';
  const id = String(d['코멘트ID'] || '').trim();
  if ((job === '수정' || job === '삭제') && id) {
    const r = rows_('리뷰코멘트').find((x) => String(x['코멘트ID']).trim() === id);
    if (!r) return { ok: false, error: 'notfound' };
    if (job === '삭제') remove_(r);
    else patch_(r, { '내용': d['내용'] || '', '처리': '수정됨 ' + nowStr_().slice(5), '읽음': false });
    return { ok: true };
  }
  // 프로젝트가 실제로 있는지만 확인 (아무 키로나 쌓이지 않게)
  if (!findProject_(d['프로젝트키'])) return { ok: false, error: 'none' };
  append_('리뷰코멘트', [nowStr_(), String(d['프로젝트키'] || '').trim(), d['프로젝트'] || '', d['버전'] || '',
    d['타임코드'] || '', d['초'] || '', d['작성자'] || '', d['내용'] || '', '', id, false]);
  return { ok: true };
}
function checkDelivery_(key) {
  const r = findProject_(key);
  if (!r) return { ok: false, error: 'none' };
  if (!r.on) return { ok: false, error: 'off', title: r.title };
  if (!r.deliver) return { ok: false, error: 'notready', title: r.title };
  if (isExpired_(r.duntil)) return { ok: false, error: 'expired', title: r.title };
  return { ok: true, row: r };
}
function deliveryMeta_(key) {
  const c = checkDelivery_(key);
  if (!c.ok) return c;
  return { ok: true, title: c.row.title, ver: c.row.ver, need: !!c.row.pw };
}
function listFiles_(key) {
  return rows_('납품파일').filter((x) => String(x['프로젝트키']).trim() === key && isOn_(x['활성']) && String(x['링크'] || '').trim())
    .map((x) => ({ name: String(x['파일명'] || ''), kind: String(x['구분'] || ''), spec: String(x['규격'] || ''),
      size: String(x['용량'] || ''), hash: String(x['체크섬'] || ''), url: String(x['링크'] || '').trim() }));
}
function lastReceipt_(key) {
  const list = rows_('납품기록').filter((x) => String(x['프로젝트키']).trim() === key)
    .sort((a, b) => String(b['최근수령']).localeCompare(String(a['최근수령'])));
  if (!list.length) return null;
  const r = list[0];
  return { who: String(r['이름'] || ''), org: String(r['소속'] || ''), files: String(r['받은파일'] || ''), at: fmt_(r['최근수령']) };
}
function deliveryOpen_(key, pw) {
  const c = checkDelivery_(key);
  if (!c.ok) return c;
  const r = c.row;
  if (r.pw && String(pw || '').trim() !== r.pw) return { ok: false, error: 'pw' };
  return { ok: true, title: r.title, ver: r.ver, expires: ymd_(r.duntil), note: r.dnote,
    files: listFiles_(r.key), received: lastReceipt_(r.key) };
}
function handleDelivery_(d) {
  const key = String(d['프로젝트키'] || '').trim(), title = String(d['작품명'] || '').trim();
  const who = String(d['이름'] || '').trim(), org = String(d['소속'] || '').trim(), file = String(d['파일명'] || '').trim();
  if (!key || !who) return { ok: false, error: 'noname' };
  if (!findProject_(key)) return { ok: false, error: 'none' };
  const r = rows_('납품기록').find((x) => String(x['프로젝트키']).trim() === key &&
    String(x['이름']).trim() === who && String(x['소속']).trim() === org);
  if (r) {
    const files = String(r['받은파일'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const isNew = file && files.indexOf(file) < 0;
    if (isNew) files.push(file);
    patch_(r, { '최근수령': nowStr_(), '받은파일': files.join(', '), '횟수': (Number(r['횟수']) || 0) + 1,
      '최초수령': r['최초수령'] || nowStr_(), '읽음': isNew ? false : r['읽음'] });
  } else {
    append_('납품기록', [nowStr_(), key, title, who, org, file, 1, nowStr_(), false]);
  }
  return { ok: true };
}

// ══════════════════════════════════════════ 컬러리버브: 문진 · 문의 (공개)
function ticket_(sheet, prefix) {
  const pre = prefix + kst_().slice(2, 10).replace(/-/g, '') + '-';
  const n = rows_(sheet).filter((r) => String(r['접수번호']).indexOf(pre) === 0).length;
  return pre + ('0' + (n + 1)).slice(-2);
}
function handleIntake_(d) {
  const o = {};
  SHEETS['문진'].forEach((h) => { o[h] = d[h] === undefined ? '' : String(d[h]).slice(0, 4000); });
  o['접수번호'] = ticket_('문진', 'MGRM-'); o['접수시각'] = nowStr_(); o['진행 상태'] = '접수'; o['읽음'] = false;
  append_('문진', o);
  return { ok: true, no: o['접수번호'] };
}
function handleInquiry_(d) {
  const o = {};
  SHEETS['문의'].forEach((h) => { o[h] = d[h] === undefined ? '' : String(d[h]).slice(0, 4000); });
  if (!o['내용'] && !o['이메일']) return { ok: false, error: '내용이 비어 있습니다.' };
  o['접수번호'] = ticket_('문의', 'MGRM-Q-'); o['접수시각'] = nowStr_(); o['진행 상태'] = '접수'; o['읽음'] = false;
  append_('문의', o);
  return { ok: true, no: o['접수번호'] };
}

function submit_(b) {
  const c = checkToken_(b.token);
  if (!c.ok) return { ok: false, error: c.error };
  const env = b.envelope;
  if (!env || !env.wk || !env.iv || !env.ct) return { ok: false, error: '제출 형식이 올바르지 않습니다.' };
  const text = JSON.stringify(env);
  if (text.length > MAX_BYTES) return { ok: false, error: '첨부 용량이 너무 큽니다. 사진 장수를 줄여주세요.' };
  const kind = env.kind === 'business' ? '사업자' : '프리랜서';
  const fid = fileCreate_(text);
  append_('제출함', [crypto.randomUUID().slice(0, 8), b.receivedAt || nowStr_(), kind,
    b.token, c.label || '', fid, text.length, '대기']);
  const inv = rows_('초대').find((r) => String(r['토큰']) === String(b.token));
  if (inv) {
    const cap = Number(inv['정원']) || 1;
    const used = (Number(inv['제출수']) || 0) + 1;
    patch_(inv, { '제출수': used, '사용': used >= cap ? nowStr_() : inv['사용'] });
  }
  return { ok: true };
}

// ══════════════════════════════════════════ 의뢰 폴더 (NAS '1. 의뢰')
/* 새 프로젝트를 만들 때 '1. 의뢰/연도/' 안에 템플릿(00_REF_업체_사업명)을 복사해 폴더를 만듭니다.
   이름: 월_코드_사업명  (예: 11_KSP_준공기념영상) — 월은 폴더를 만든 달
   컨테이너에 '1. 의뢰' 공유 폴더를 REQUEST_DIR(/request)로 연결해야 합니다. */
const FOLDER = (() => {
  const ROOT = path.resolve(process.env.REQUEST_DIR || '/request');
  const TEMPLATE = process.env.REQUEST_TEMPLATE || '00_REF_업체_사업명';
  const EMPTY_INSIDE = ['00_ADMIN/04_FORM_양식'];             // 폴더만 만들고 안의 파일은 복사하지 않음
  const COLOR_ONLY = ['00_ADMIN', '20_IN', '30_WORK', '40_OUT']; // 색보정 단독 의뢰
  const skip = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('~$') ||
    ['Thumbs.db', 'desktop.ini', '#recycle'].includes(n);
  const isTemplate = (n) => /^00_/.test(n);
  const N = (n) => String(n).normalize('NFC');
  /** 맥에서 만든 이름은 한글 자모가 풀려(NFD) 저장되기도 해서, 실제 이름을 찾아 씁니다 */
  function real_(dir, name) {
    if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    try {
      const hit = fs.readdirSync(dir).find((n) => N(n) === N(name));
      if (hit) return path.join(dir, hit);
    } catch {}
    return null;
  }

  function ready() { try { fs.accessSync(ROOT, fs.constants.W_OK); return true; } catch { return false; } }
  function need_() {
    if (!ready()) throw new Error(`NAS '1. 의뢰' 폴더에 연결되지 않았어요 (${ROOT}). 컨테이너 설정을 확인해 주세요.`);
  }
  /** 안전한 이름: 금지 문자·공백 제거 */
  function safe(s) {
    return String(s || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, '').replace(/^\.+|\.+$/g, '').slice(0, 80);
  }
  function inside_(p) {
    const r = path.resolve(p);
    if (r !== ROOT && !r.startsWith(ROOT + path.sep)) throw new Error('잘못된 폴더 경로예요.');
    return r;
  }
  function template_(year) {
    const years = fs.readdirSync(ROOT).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
    for (const y of [String(year), ...years]) {
      const t = real_(path.join(ROOT, y), TEMPLATE);
      if (t) return t;
    }
    throw new Error(`템플릿 폴더(${TEMPLATE})를 찾지 못했어요.`);
  }
  function mkdir_(p) {
    fs.mkdirSync(p, { recursive: true });
    try { fs.chmodSync(p, 0o777); } catch {}
  }
  function copy_(src, dst, rel, colorOnly) {
    mkdir_(dst);
    if (EMPTY_INSIDE.includes(rel)) return;
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip(ent.name)) continue;
      const r = rel ? rel + '/' + N(ent.name) : N(ent.name);
      if (!rel && colorOnly && ent.isDirectory() && !COLOR_ONLY.includes(N(ent.name))) continue;
      const s = path.join(src, ent.name), d = path.join(dst, ent.name);
      if (ent.isDirectory()) copy_(s, d, r, colorOnly);
      else if (ent.isFile()) { fs.copyFileSync(s, d); try { fs.chmodSync(d, 0o666); } catch {} }
    }
  }
  /** 폴더 이름 기본값 */
  function nameOf(code, name, month) {
    const mm = month || kst_().slice(5, 7);
    return [mm, safe(code), safe(name)].filter(Boolean).join('_');
  }
  function make({ code, name, folderName, colorOnly }) {
    need_();
    const year = kst_().slice(0, 4);
    const fname = safe(folderName) || nameOf(code, name);
    if (!/^\d{2}_/.test(fname)) throw new Error('폴더 이름은 월 두 자리로 시작해야 해요 (예: 11_KSP_사업명).');
    if (isTemplate(fname)) throw new Error('00_ 으로 시작하는 이름은 템플릿용이라 쓸 수 없어요.');
    const tpl = template_(year);
    const yearDir = path.join(ROOT, year);
    mkdir_(yearDir);
    const dst = inside_(path.join(yearDir, fname));
    if (real_(yearDir, fname)) throw new Error(`같은 이름의 폴더가 이미 있어요: ${year}/${fname}`);
    copy_(tpl, dst, '', colorOnly);
    return `${year}/${fname}`;
  }
  function list(year) {
    need_();
    const y = /^\d{4}$/.test(String(year || '')) ? String(year) : kst_().slice(0, 4);
    const dir = path.join(ROOT, y);
    const folders = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !skip(e.name) && !isTemplate(N(e.name)))
      .map((e) => `${y}/${e.name.normalize('NFC')}`).sort() : [];
    const years = fs.readdirSync(ROOT).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
    return { year: y, years, folders };
  }
  function check(rel) {
    need_();
    const r = String(rel || '').normalize('NFC');
    if (!/^\d{4}\/[^/]+$/.test(r)) throw new Error('폴더는 "연도/폴더이름" 형식이어야 해요.');
    const [yy, nm] = r.split('/');
    const p = inside_(real_(path.join(ROOT, yy), nm) || path.join(ROOT, r));
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('그 폴더가 NAS에 없어요: ' + r);
    return r;
  }
  return { ready, make, list, check, nameOf, ROOT };
})();

// ══════════════════════════════════════════ 구글 캘린더 (NAS 에서 직접)
/* 구글 '서비스 계정'(로봇 계정)으로 캘린더 API 를 직접 부릅니다. 추가 설치 없음.
   준비물
     1. HubData/google-sa.json  — 구글 클라우드에서 받은 서비스 계정 열쇠 파일
     2. CAL_IDS                 — 캘린더 이름 → 캘린더 ID (JSON). 환경변수 또는 HubData/calendars.json
     3. MGRM 캘린더 5개를 서비스 계정 이메일과 "일정 변경" 권한으로 공유
   준비가 안 돼 있으면 예전처럼 앱스스크립트(GAS_URL)로 보냅니다. */
const GCAL = (() => {
  const SA_FILE = process.env.GOOGLE_SA_FILE || path.join(DATA, 'google-sa.json');
  const CAL_FILE = path.join(DATA, 'calendars.json');
  const DEFAULT_CAL = 'MGRM스케줄';
  const AUTO_PREFIX = ['proj-', 'task-', 'shoot-'];    // 허브가 스스로 만드는 일정
  const SHOOT_CAL = 'MGRM촬영';
  let sa = null, ids = null, token = null, tokenExp = 0, busy = null, again = false, timer = null;

  function load_() {
    if (sa && ids) return true;
    try {
      const j = JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
      if (!j.client_email || !j.private_key) return false;
      let m = {};
      if (process.env.CAL_IDS) m = JSON.parse(process.env.CAL_IDS);
      else if (fs.existsSync(CAL_FILE)) m = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
      if (!m[DEFAULT_CAL]) return false;
      sa = j; ids = m; return true;
    } catch (e) { return false; }
  }
  const ready = () => load_();

  async function token_() {
    if (token && Date.now() < tokenExp - 60e3) return token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const claim = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key).toString('base64url');
    const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${head}.${claim}.${sig}` }) });
    const j = await res.json();
    if (!j.access_token) throw new Error('구글 로그인 실패: ' + (j.error_description || j.error || res.status));
    token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
    return token;
  }
  async function api_(method, calName, eventId, body) {
    const cal = ids[calName] || ids[DEFAULT_CAL];
    const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cal) +
      '/events' + (eventId ? '/' + encodeURIComponent(eventId) : '');
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + await token_(),
      'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return { status: 204 };
    const j = await res.json().catch(() => ({}));
    return { status: res.status, body: j };
  }
  const addDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10); };
  const evId = (v) => String(v || '').replace(/@google\.com$/, '');
  const sigOf = (e) => crypto.createHash('sha1').update(JSON.stringify(
    [e.title, e.date, e.end || '', e.desc || '', e.remind || 0, e.cal, e.loc || ''])).digest('hex').slice(0, 16);

  function body_(e) {
    const end = e.end && e.end > e.date ? e.end : e.date;
    const b = { summary: e.title, description: (e.desc ? e.desc + '\n\n' : '') + '— 업무 허브에서 넣은 일정',
      start: { date: e.date }, end: { date: addDay(end, 1) },
      location: e.loc || '',
      extendedProperties: { private: { hubKey: e.key } } };
    const r = Number(e.remind) || 0;
    // 하루 일정 알림: r일 전 오전 9시
    b.reminders = r > 0 ? { useDefault: false,
      overrides: [{ method: 'popup', minutes: Math.min(40320, r * 1440 - 540) }] } : { useDefault: false, overrides: [] };
    return b;
  }

  /** 작업 이름으로 캘린더 고르기 */
  function guess(title) {
    const t = String(title || '');
    if (/DIT/i.test(t)) return 'MGRM촬영';
    if (/D\.?I(?![A-Za-z])|색보정|컬러|그레이딩/i.test(t)) return 'MGRM D.I';
    if (/편집|시사|사운드|믹싱|CG|그래픽|마스터|자막/i.test(t)) return 'MGRM편집';
    if (/기획|시나리오|콘티|구성|스토리보드|대본|트리트먼트/.test(t)) return 'MGRM구성';
    if (/촬영|헌팅|로케이션|답사/.test(t)) return 'MGRM촬영';
    return DEFAULT_CAL;
  }

  /** 허브 프로젝트·작업으로 일정 만들기 */
  function hubEvents() {
    const ev = [];
    const cut = kst_(Date.now() - 365 * 86400e3).slice(0, 10);
    const projs = {};
    rows_('프로젝트').map(mapProject_).forEach((p) => { projs[p.id] = p; });
    Object.values(projs).filter((p) => p.active !== false && p.due && p.stage !== '완료').forEach((p) => {
      ev.push({ key: `proj-${p.id}`, date: p.due, remind: 3, cal: DEFAULT_CAL,
        title: p.code ? `[${p.code}] 마감_${p.name}` : `마감 · ${p.name}`,
        desc: (p.client ? `클라이언트: ${p.client}\n` : '') + `단계: ${p.stage}` +
              (p.folder ? `\n폴더: 1. 의뢰/${p.folder}` : '') });
    });
    rows_('작업').map(mapTask_).filter((t) => t.cal && t.due).forEach((t) => {
      const p = projs[t.projectId];
      if (!p || p.active === false) return;
      const cal = ids && ids[t.calName] ? t.calName : guess(t.title);
      ev.push({ key: `task-${t.id}`, date: t.start && t.start < t.due ? t.start : t.due, end: t.due,
        remind: t.done ? 0 : 2, cal,
        title: (t.done ? '✓ ' : '') + (p.code ? `[${p.code}] ${t.title}` : `${t.title} · ${p.name}`),
        desc: `프로젝트: ${p.name}\n단계: ${t.stage}` + (t.assignee ? `\n담당: ${t.assignee}` : '') +
              (p.folder ? `\n폴더: 1. 의뢰/${p.folder}` : '') });
    });
    // 촬영 회차 — 하루 종일, MGRM촬영, 장소 칸은 주소가 있을 때만 (테슬라 내비)
    rows_('회차').map(mapShoot_).filter((s) => s.date && s.status !== '취소').forEach((s) => {
      const p = projs[s.projectId];
      if (!p || p.active === false) return;
      const head = `촬영_${s.no}회차` + (s.place ? `(${s.place})` : '');
      ev.push({ key: `shoot-${s.id}`, date: s.date, cal: SHOOT_CAL, remind: 1, loc: s.addr,
        title: p.code ? `[${p.code}] ${head}` : `${head} · ${p.name}`,
        desc: [s.call ? `집합: ${s.call}` : '', s.note, p.shootVer ? `${p.shootVer} 기준` : '']
          .filter(Boolean).join('\n') });
    });
    return ev.filter((e) => e.date >= cut);
  }

  /** 캘린더에 이미 있는 '[코드] 촬영_N회차(장소)' 일정을 허브 회차로 가져와 그대로 이어받습니다 */
  async function importShoots(projectId) {
    if (!load_()) return { ok: false, error: '캘린더 직접 연동이 설정되지 않았어요.' };
    const p = byId_('프로젝트', projectId);
    if (!p) return { ok: false, error: '프로젝트를 찾지 못했어요.' };
    const code = String(p['코드'] || '');
    if (!code) return { ok: false, error: '프로젝트에 코드를 먼저 넣어 주세요 (예: YHN).' };
    const items = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ q: `[${code}]`, singleEvents: 'true', maxResults: '250',
        timeMin: new Date(Date.now() - 400 * 86400e3).toISOString() });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/' +
        encodeURIComponent(ids[SHOOT_CAL]) + '/events?' + q, { headers: { Authorization: 'Bearer ' + await token_() } });
      const j = await res.json();
      if (res.status >= 300) return { ok: false, error: '캘린더를 읽지 못했어요: ' + ((j.error && j.error.message) || res.status) };
      items.push(...(j.items || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    const re = new RegExp('^\\[' + code + '\\]\\s*촬영_\\s*([0-9A-Za-z-]+)\\s*회차\\s*(?:\\((.*)\\))?\\s*$');
    const found = items.filter((ev) => ev.status !== 'cancelled' && ev.start && ev.start.date &&
      !(ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.hubKey))
      .map((ev) => ({ ev, m: String(ev.summary || '').trim().match(re) })).filter((x) => x.m);
    return tx_(() => {
      const mine = rows_('회차').filter((r) => Number(r['프로젝트ID']) === Number(projectId));
      const have = new Set(mine.map((r) => String(r['회차'])));
      let id = nextId_('회차'), added = 0, skipped = 0, ver = '';
      found.sort((a, b) => a.ev.start.date.localeCompare(b.ev.start.date)).forEach(({ ev, m }) => {
        if (have.has(m[1])) { skipped++; return; }
        const lines = String(ev.description || '').replace(/\r/g, '').split('\n');
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        const last = lines.length ? lines[lines.length - 1].trim() : '';
        if (/기준$/.test(last)) { ver = ver || last.replace(/\s*기준$/, ''); lines.pop(); }
        const sid = id++;
        append_('회차', { 'ID': sid, '프로젝트ID': Number(projectId), '회차': m[1], '날짜': ev.start.date,
          '장소': (m[2] || '').trim(), '주소': String(ev.location || ''), '집합': '',
          '내용': lines.join('\n').trim(), '상태': '', '등록일': nowStr_() });
        // 같은 일정을 허브 것으로 등록 (지우고 다시 만들지 않음) — 다음 반영 때 허브 내용으로 맞춰짐
        append_('캘린더', { '키': `shoot-${sid}`, '제목': ev.summary, '날짜': ev.start.date,
          '캘린더': SHOOT_CAL, '이벤트ID': ev.id, '동기시각': nowStr_(), '지문': '' });
        have.add(m[1]); added++;
      });
      if (ver && !String(p['회차표'] || '')) patch_(p, { '회차표': ver });
      return { ok: true, added, skipped, version: ver };
    });
  }

  /** 원하는 일정 목록(want)과 지금 캘린더(시트 기록)를 맞춥니다. scope 에 맞는 키만 건드림 */
  async function apply_(want, inScope) {
    const rec = rows_('캘린더').filter((r) => inScope(String(r['키'])));
    const byKey = {}; rec.forEach((r) => { byKey[String(r['키'])] = r; });
    const seen = new Set();
    let added = 0, updated = 0, removed = 0, failed = 0;
    for (const e of want) {
      if (!e || !e.key || !e.date || seen.has(e.key)) continue;
      seen.add(e.key);
      e.cal = ids[e.cal] ? e.cal : DEFAULT_CAL;
      const sig = sigOf(e), r = byKey[e.key];
      try {
        if (r && String(r['지문']) === sig && String(r['캘린더']) === e.cal && r['이벤트ID']) continue;
        let id = r ? evId(r['이벤트ID']) : '';
        let res = null;
        if (r && id && String(r['캘린더'] || DEFAULT_CAL) !== e.cal) {   // 캘린더가 바뀌면 옮김
          await api_('DELETE', String(r['캘린더'] || DEFAULT_CAL), id); id = '';
        }
        if (id) res = await api_('PATCH', e.cal, id, body_(e));
        if (!res || res.status === 404 || res.status === 410 || (res.body && res.body.status === 'cancelled')) {
          res = await api_('POST', e.cal, '', body_(e)); if (res.status < 300) { r ? updated++ : added++; }
        } else if (res.status < 300) updated++;
        if (res.status >= 300) throw new Error((res.body.error && res.body.error.message) || res.status);
        const row = { '키': e.key, '제목': e.title, '날짜': e.date, '캘린더': e.cal,
          '이벤트ID': res.body.id, '동기시각': nowStr_(), '지문': sig };
        if (r) patch_(r, row); else append_('캘린더', row);
      } catch (err) { failed++; console.error('캘린더', e.key, err.message); }
    }
    for (const r of rec) {
      if (seen.has(String(r['키']))) continue;
      try {
        if (r['이벤트ID']) {
          const res = await api_('DELETE', String(r['캘린더'] || DEFAULT_CAL), evId(r['이벤트ID']));
          if (res.status >= 300 && ![404, 410].includes(res.status)) throw new Error(String(res.status));
        }
        remove_(r); removed++;
      } catch (err) { failed++; console.error('캘린더 삭제', r['키'], err.message); }
    }
    return { added, updated, removed, failed, total: seen.size };
  }

  async function run_(fn) {            // 한 번에 하나씩
    while (busy) { try { await busy; } catch {} }
    busy = fn(); try { return await busy; } finally { busy = null; }
  }

  /** [캘린더로 보내기] 버튼 — 세금 일정(브라우저가 계산) + 허브 일정 전부 */
  async function syncAll(clientEvents) {
    if (!load_()) return { ok: false, error: '캘린더 연동이 아직 설정되지 않았습니다.' };
    const own = (k) => AUTO_PREFIX.some((p) => k.startsWith(p));
    const want = (clientEvents || []).filter((e) => e && !own(String(e.key)))
      .map((e) => Object.assign({}, e, { cal: DEFAULT_CAL })).concat(hubEvents());
    try {
      const r = await run_(() => apply_(want, () => true));
      return Object.assign({ ok: true, calendar: 'MGRM 캘린더' }, r);
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** 프로젝트·작업이 바뀐 뒤 몇 초 기다렸다가 허브 일정만 맞춤 */
  function later() {
    if (!load_()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      run_(() => apply_(hubEvents(), (k) => AUTO_PREFIX.some((p) => k.startsWith(p))))
        .then((r) => { if (r.added || r.updated || r.removed || r.failed) console.log('캘린더 자동 반영', r); })
        .catch((e) => console.error('캘린더 자동 반영 실패', e.message));
    }, 4000);
  }

  async function check() {
    if (!load_()) return { ok: true, found: false, error: '캘린더 연동이 아직 설정되지 않았습니다.', names: [] };
    const names = [], bad = [];
    for (const [name, id] of Object.entries(ids)) {
      try {
        const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(id),
          { headers: { Authorization: 'Bearer ' + await token_() } });
        (res.status < 300 ? names : bad).push(name + (res.status < 300 ? '' : ` (권한 없음 ${res.status})`));
      } catch (e) { bad.push(name + ' (' + e.message + ')'); }
    }
    return { ok: true, found: !bad.length, name: names.join(', '), names: bad.length ? bad : names,
      synced: rows_('캘린더').length, robot: sa.client_email, direct: true };
  }

  return { ready, syncAll, later, check, guess, hubEvents, importShoots };
})();

// ══════════════════════════════════════════ 허브 기능 (로그인 필요)
const PD_ALLOWED = [
  'bootstrap', 'me', 'project.add', 'project.update', 'project.delete',
  'task.add', 'task.set', 'task.delete', 'board.add', 'board.delete', 'board.pin',
  'folder.list', 'folder.make', 'folder.link',
  'shoot.save', 'shoot.delete', 'shoot.bulk', 'shoot.import',
];
const READ_ONLY = ['bootstrap', 'me', 'review.videos', 'envelope', 'envelopes', 'unlock', 'user.list',
                   'recovery.status', 'calendar.check', 'log.list', 'folder.list'];

async function rpc_(b) {
  const who = b._who || {};
  const a = String(b.action || '');
  if (!who.user || !who.role) return { ok: false, error: '로그인이 필요합니다.' };
  // 권한은 요청할 때마다 QNAP 그룹을 다시 봅니다 (그룹에서 빼면 바로 막힘)
  const role = roleOf_(who.user);
  if (!role) return { ok: false, error: '허브 사용 권한이 없어졌습니다. 관리자에게 문의하세요.', relogin: true };
  who.role = role;
  if (role !== 'admin' && PD_ALLOWED.indexOf(a) < 0) {
    return { ok: false, error: '이 기능은 관리자만 사용할 수 있습니다.' };
  }
  if (a === 'shoot.import') {
    const r = await GCAL.importShoots(b.projectId);
    if (r.ok) GCAL.later();
    log_(who.user, role, a, b._ip, r.ok);
    return r;
  }
  if (a === 'calendar.sync' || a === 'calendar.check') {
    return GCAL.ready() ? (a === 'calendar.check' ? GCAL.check() : GCAL.syncAll(b.events || []))
                        : calendarRelay_(a, b);
  }
  const run = () => admin_(a, b, who);
  const res = READ_ONLY.includes(a) ? run() : tx_(run);
  // 프로젝트·작업이 바뀌면 캘린더를 뒤에서 조용히 맞춥니다 (직접 연동일 때만)
  if (res && res.ok && /^(project|task|folder|shoot)\./.test(a) && a !== 'folder.list') GCAL.later();
  if (!READ_ONLY.includes(a) || a === 'envelope' || a === 'envelopes' || a === 'unlock') {
    log_(who.user, role, a, b._ip, res && res.ok);
  }
  return res;
}

/* 구글 캘린더 연동은 당분간 기존 앱스스크립트를 통해 보냅니다.
   (NAS 에서 구글 캘린더에 직접 쓰려면 구글 로그인 설정이 따로 필요해서)
   이사할 때 옮겨 온 예전 관리자 토큰(gasAuth)으로 앱스스크립트에 대신 요청합니다. */
const GAS_URL = process.env.GAS_URL || '';
function calendarRelay_(a, b) {
  const key = cfgGet_('gasAuth');
  if (!GAS_URL || !key) {
    return Promise.resolve(a === 'calendar.check'
      ? { ok: true, found: false, error: '캘린더 연동이 아직 설정되지 않았습니다.', names: [] }
      : { ok: false, error: '캘린더 연동이 아직 설정되지 않았습니다.' });
  }
  const body = JSON.stringify({ action: a, key, events: b.events || [] });
  return new Promise((resolve) => {
    const go = (url, hops) => {
      const u = new URL(url);
      const req = https.request(u, { method: hops ? 'GET' : 'POST', timeout: 60000,
        headers: hops ? {} : { 'Content-Type': 'text/plain;charset=utf-8',
                               'Content-Length': Buffer.byteLength(body) } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) {
          res.resume(); return go(res.headers.location, hops + 1);
        }
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => { try { resolve(JSON.parse(t)); }
          catch { resolve({ ok: false, error: '캘린더 서버 응답을 읽지 못했습니다.' }); } });
      });
      req.on('error', (e) => resolve({ ok: false, error: '캘린더 서버 연결 실패: ' + e.message }));
      req.on('timeout', () => req.destroy(new Error('시간 초과')));
      req.end(hops ? undefined : body);
    };
    go(GAS_URL, 0);
  });
}

/** 회차 입력값 정리 */
function shootIn_(b) {
  const no = String(b.no === undefined ? '' : b.no).replace(/회차|\s/g, '');
  const date = String(b.date || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${no}회차 날짜는 2026-11-18 형식이어야 해요.`);
  return { '회차': no, '날짜': date, '장소': String(b.place || '').trim(), '주소': String(b.addr || '').trim(),
    '집합': String(b.call || '').trim(), '내용': String(b.note || '').trim(),
    '상태': b.status === '취소' ? '취소' : '' };
}

function normCode_(v) {
  const c = String(v || '').trim().toUpperCase();
  if (c && !/^[A-Z0-9]{2,6}$/.test(c)) throw new Error('프로젝트 코드는 영문 대문자·숫자 2~6글자로 적어 주세요.');
  return c;
}

function byId_(name, id) { return rows_(name).find((r) => Number(r.ID) === Number(id)); }

function admin_(a, b, who) {
  switch (a) {

    case 'me': {
      const out = { ok: true, role: who.role, me: { name: who.name || who.user, userId: who.user } };
      if (who.role === 'admin') Object.assign(out, keystore_());
      else out.pub = '';
      return out;
    }

    case 'unlock': {
      const k = keystore_();
      return { ok: true, keystore: { pub: k.pub, pkcs8: k.pkcs8 } };
    }

    case 'vault.save': {
      const fid = fileCreate_(JSON.stringify(b.envelope));
      if (b.id) {
        const r = byId_('금고', b.id);
        if (r) {
          const old = String(r['봉투ID'] || '');
          patch_(r, { '분류': b.cat || '기타', '이름': b.name || '', '봉투ID': fid,
            '메모': b.memo || '', '수정일': nowStr_() });
          if (old) fileTrash_(old);
          return { ok: true, id: Number(b.id) };
        }
      }
      const id = nextId_('금고');
      append_('금고', [id, b.cat || '기타', b.name || '', fid, b.memo || '', nowStr_(), nowStr_()]);
      return { ok: true, id };
    }

    case 'vault.delete': {
      const r = byId_('금고', b.id);
      if (r) { if (r['봉투ID']) fileTrash_(String(r['봉투ID'])); remove_(r); }
      return { ok: true };
    }

    // 계정은 이제 QNAP 에서 관리합니다. 목록만 보여 줍니다.
    case 'user.list':
      return { ok: true, managedBy: 'qnap', adminGroup: ADMIN_GROUP, staffGroup: STAFF_GROUP,
        users: members_().map((m, i) => ({ id: i + 1, userId: m.userId, name: m.userId,
          role: m.role, mustChange: false, active: true, lastSeen: lastSeen_(m.userId), memo: '' })) };
    case 'user.add': case 'user.reset': case 'user.set': case 'user.delete':
    case 'user.changePassword':
      return { ok: false, error: `계정은 QNAP 제어판 → 사용자에서 관리합니다. ('${ADMIN_GROUP}' / '${STAFF_GROUP}' 그룹)` };

    // 복구 코드는 더 이상 필요 없습니다 (개인키가 NAS 에 안전하게 보관됨)
    case 'recovery.status': return { ok: true, exists: false, issuedAt: '', managedBy: 'nas' };
    case 'recovery.set': case 'recovery.clear':
      return { ok: false, error: '이제 복구 코드가 필요 없습니다. 열쇠는 NAS에 보관됩니다.' };

    case 'log.list': {
      const lim = Math.min(Number(b.limit) || 200, 1000);
      return { ok: true, log: db.prepare('SELECT * FROM log ORDER BY rowid DESC LIMIT ?').all(lim) };
    }

    case 'bootstrap': return who.role === 'admin' ? bootstrapAdmin_(who) : bootstrapPd_(who);

    case 'envelope':
      return { ok: true, envelope: JSON.parse(fileRead_(b.fileId)) };

    case 'envelopes': {
      const out = {};
      (b.fileIds || []).slice(0, 200).forEach((id) => {
        try { out[id] = JSON.parse(fileRead_(id)); } catch { out[id] = null; }
      });
      return { ok: true, envelopes: out };
    }

    case 'dropFile': {
      fileTrash_(b.fileId);
      const r = rows_('제출함').find((x) => String(x['파일ID']) === String(b.fileId));
      if (r) patch_(r, { '상태': '삭제됨' });
      return { ok: true };
    }

    case 'invite.create':
      append_('초대', [b.token, b.label || '', b.role || '', b.expires || '', nowStr_(), '',
        Number(b.cap) || 1, 0, false]);
      return { ok: true };

    case 'invite.close': {
      const r = rows_('초대').find((x) => String(x['토큰']) === String(b.token));
      if (r) patch_(r, { '차단': b.closed !== false });
      return { ok: true };
    }

    case 'invite.delete': {
      const r = rows_('초대').find((x) => String(x['토큰']) === String(b.token));
      if (r) remove_(r);
      return { ok: true };
    }

    case 'person.add': {
      const fid = fileCreate_(JSON.stringify(b.envelope));
      const id = nextId_('인력');
      append_('인력', [id, b.name, b.role || '', b.bank || '', b.holder || '', b.accMask || '',
        fid, b.industry || '940909', b.consentDate || '', true, nowStr_(), b.incomeType || 'biz', b.fp || '']);
      return { ok: true, id, envFileId: fid };
    }

    case 'person.update': {
      const r = byId_('인력', b.id);
      if (!r) return { ok: true };
      if (b.envelope) {
        const old = String(r['봉투ID'] || '');
        r['봉투ID'] = fileCreate_(JSON.stringify(b.envelope));
        if (old) fileTrash_(old);
      }
      patch_(r, { '성명': b.name, '역할': b.role, '은행': b.bank, '예금주': b.holder,
        '계좌표시': b.accMask, '업종코드': b.industry, '동의일': b.consentDate,
        '소득구분': b.incomeType, '활성': b.active, '지문': b.fp });
      return { ok: true };
    }

    case 'person.delete': {
      const r = byId_('인력', b.id);
      if (r) { if (r['봉투ID']) fileTrash_(String(r['봉투ID'])); remove_(r); }
      return { ok: true };
    }

    case 'vendor.add': {
      const fid = fileCreate_(JSON.stringify(b.envelope));
      const id = nextId_('거래처');
      append_('거래처', [id, b.company, b.bizNo || '', b.ceo || '', b.bizType || '', b.bizItem || '',
        b.address || '', b.manager || '', b.email || '', b.bank || '', b.holder || '', b.accMask || '',
        fid, nowStr_()]);
      return { ok: true, id };
    }

    case 'project.add': {
      const code = normCode_(b.code);
      const id = nextId_('프로젝트');
      append_('프로젝트', [id, b.name, b.client || '', true, b.stage || '프리', b.start || '',
        b.due || '', Number(b.amount) || 0, b.owner || '', b.memo || '', nowStr_(), code, '']);
      if (b.tasks && b.tasks.length) {
        let tid = nextId_('작업');
        b.tasks.forEach((t, i) => append_('작업',
          [tid++, id, t.stage, t.title, '', '', false, i, nowStr_(), !!t.cal, '', '']));
      }
      const out = { ok: true, id, name: b.name, client: b.client || '' };
      if (b.makeFolder) {
        try {
          out.folder = FOLDER.make({ code, name: b.name, folderName: b.folderName, colorOnly: !!b.colorOnly });
          patch_(byId_('프로젝트', id), { '폴더': out.folder });
        } catch (e) { out.folderError = String(e.message || e); }
      }
      return out;
    }

    case 'folder.list': return { ok: true, ...FOLDER.list(b.year) };

    /* ── 촬영 회차 */
    case 'shoot.save': {
      const s = shootIn_(b);
      if (b.id) {
        const r = byId_('회차', b.id);
        if (!r) return { ok: false, error: '회차를 찾지 못했어요.' };
        patch_(r, s);
        return { ok: true, id: Number(b.id) };
      }
      if (!byId_('프로젝트', b.projectId)) return { ok: false, error: '프로젝트를 찾지 못했어요.' };
      const id = nextId_('회차');
      append_('회차', Object.assign({ 'ID': id, '프로젝트ID': Number(b.projectId), '등록일': nowStr_() }, s));
      return { ok: true, id };
    }

    case 'shoot.delete': {
      (Array.isArray(b.ids) ? b.ids : [b.id]).forEach((id) => {
        const r = byId_('회차', id); if (r) remove_(r);
      });
      return { ok: true };
    }

    /* 스케줄표 붙여넣기 — 회차 번호가 같으면 고치고, 없으면 새로 만듭니다.
       붙여넣기에 없는 기존 회차는 지우지 않고 목록만 돌려줍니다 (지울지는 화면에서 묻기) */
    case 'shoot.bulk': {
      const p = byId_('프로젝트', b.projectId);
      if (!p) return { ok: false, error: '프로젝트를 찾지 못했어요.' };
      if (b.version !== undefined) patch_(p, { '회차표': String(b.version || '') });
      const mine = rows_('회차').filter((r) => Number(r['프로젝트ID']) === Number(b.projectId));
      const byNo = {}; mine.forEach((r) => { byNo[String(r['회차'])] = r; });
      let added = 0, updated = 0;
      const seen = new Set();
      let id = nextId_('회차');
      (b.rows || []).forEach((x) => {
        const s = shootIn_(x);
        if (!s['회차']) return;
        seen.add(s['회차']);
        const r = byNo[s['회차']];
        if (r) {
          if (['날짜', '장소', '주소', '집합', '내용'].some((k) => String(r[k] || '') !== String(s[k] || ''))) {
            delete s['상태']; patch_(r, s); updated++;
          }
        } else {
          append_('회차', Object.assign({ 'ID': id++, '프로젝트ID': Number(b.projectId), '등록일': nowStr_() }, s));
          added++;
        }
      });
      const missing = mine.filter((r) => !seen.has(String(r['회차'])))
        .map((r) => ({ id: Number(r['ID']), no: String(r['회차']), date: ymd_(r['날짜']) }));
      return { ok: true, added, updated, missing };
    }

    case 'folder.make': {
      const r = byId_('프로젝트', b.id);
      if (!r) return { ok: false, error: '프로젝트를 찾지 못했어요.' };
      if (String(r['폴더'] || '')) return { ok: false, error: '이미 연결된 폴더가 있어요: ' + r['폴더'] };
      const folder = FOLDER.make({ code: String(r['코드'] || ''), name: String(r['이름']),
        folderName: b.folderName, colorOnly: !!b.colorOnly });
      patch_(r, { '폴더': folder });
      return { ok: true, folder };
    }

    case 'folder.link': {
      const r = byId_('프로젝트', b.id);
      if (!r) return { ok: false, error: '프로젝트를 찾지 못했어요.' };
      const folder = b.folder ? FOLDER.check(b.folder) : '';
      patch_(r, { '폴더': folder });
      return { ok: true, folder };
    }

    case 'project.update': {
      const r = byId_('프로젝트', b.id);
      if (r) patch_(r, { '이름': b.name, '클라이언트': b.client, '단계': b.stage, '시작일': b.start,
        '마감일': b.due, '계약금액': b.amount, '담당': b.owner, '메모': b.memo, '활성': b.active,
        '코드': b.code === undefined ? undefined : normCode_(b.code), '회차표': b.shootVer });
      return { ok: true };
    }

    case 'project.delete': {
      const r = byId_('프로젝트', b.id);
      if (r) remove_(r);
      rows_('작업').filter((t) => Number(t['프로젝트ID']) === Number(b.id)).forEach(remove_);
      rows_('회차').filter((t) => Number(t['프로젝트ID']) === Number(b.id)).forEach(remove_);
      return { ok: true };
    }

    case 'task.add': {
      const id = nextId_('작업');
      append_('작업', [id, b.projectId, b.stage || '프리', b.title, b.assignee || '', b.due || '',
        false, Number(b.order) || 999, nowStr_(), !!b.cal, b.start || '', b.calName || '']);
      return { ok: true, id };
    }

    case 'task.set': {
      const r = byId_('작업', b.id);
      if (r) patch_(r, { '완료': b.done === undefined ? undefined : !!b.done, '제목': b.title,
        '담당': b.assignee, '마감일': b.due, '캘린더': b.cal === undefined ? undefined : !!b.cal,
        '시작일': b.start, '캘린더이름': b.calName });
      return { ok: true };
    }

    case 'task.delete': {
      const r = byId_('작업', b.id);
      if (r) remove_(r);
      return { ok: true };
    }

    case 'payment.add': {
      const id = nextId_('지급');
      append_('지급', [id, b.personId, b.name, String(b.payDate || ''), String(b.ym || ''),
        b.project || '', b.role || '', b.gross, b.incomeTax, b.localTax, b.net, !!b.isSmall,
        b.status || '지급완료', b.memo || '', nowStr_(), b.incomeType || 'biz', Number(b.base) || 0]);
      return { ok: true, id };
    }

    case 'payment.delete': {
      const r = byId_('지급', b.id);
      if (r) remove_(r);
      return { ok: true };
    }

    case 'payment.markReported':
      rows_('지급').forEach((r) => {
        if (ym_(r['귀속월']) === String(b.ym) && String(r['상태']) !== '예정') patch_(r, { '상태': '신고완료' });
      });
      return { ok: true };

    case 'board.add': {
      const id = nextId_('게시판');
      append_('게시판', [id, b.cat || '일반', b.title, b.body || '',
        b.author || who.name || who.user, nowStr_(), '', !!b.pinned]);
      return { ok: true, id };
    }

    case 'board.delete': {
      const r = byId_('게시판', b.id);
      if (r) remove_(r);
      return { ok: true };
    }

    case 'board.pin': {
      const r = byId_('게시판', b.id);
      if (r) patch_(r, { '고정': !!b.pinned });
      return { ok: true };
    }

    case 'sales.save': {
      const row = [null, b.date, b.project || '', b.client || '', b.item || '',
        Number(b.supply) || 0, Number(b.vat) || 0, Number(b.total) || 0, b.status || '발행예정',
        b.issuedAt || '', b.paidAt || '', b.proof || '세금계산서', b.memo || '', nowStr_()];
      const r = b.id ? byId_('매출', b.id) : null;
      if (r) {
        row[0] = Number(b.id); row[13] = r['등록일'];
        Object.assign(r, obj_('매출', row)); save_(r);
        return { ok: true, id: Number(b.id) };
      }
      row[0] = nextId_('매출'); append_('매출', row);
      return { ok: true, id: row[0] };
    }

    case 'sales.delete': {
      const r = byId_('매출', b.id);
      if (r) remove_(r);
      return { ok: true };
    }

    case 'purchase.save': {
      const row = [null, b.date, b.project || '', b.vendor || '', b.cat || '기타', b.item || '',
        Number(b.supply) || 0, Number(b.vat) || 0, Number(b.total) || 0,
        b.proof || '세금계산서', b.deduct || '공제', b.memo || '', nowStr_()];
      const r = b.id ? byId_('매입', b.id) : null;
      if (r) {
        row[0] = Number(b.id); row[12] = r['등록일'];
        Object.assign(r, obj_('매입', row)); save_(r);
        return { ok: true, id: Number(b.id) };
      }
      row[0] = nextId_('매입'); append_('매입', row);
      return { ok: true, id: row[0] };
    }

    case 'purchase.delete': {
      const r = byId_('매입', b.id);
      if (r) remove_(r);
      return { ok: true };
    }

    case 'payroll.person.add': {
      const id = nextId_('급여자');
      append_('급여자', [id, b.name, b.kind || '직원', Number(b.baseGross) || 0, Number(b.baseTax) || 0,
        b.memo || '', true, nowStr_(), b.np !== false, b.hi !== false, b.ei === true]);
      return { ok: true, id };
    }

    case 'payroll.person.update': {
      const r = byId_('급여자', b.id);
      if (r) patch_(r, { '성명': b.name, '구분': b.kind, '기본급여': b.baseGross, '기본소득세': b.baseTax,
        '메모': b.memo, '활성': b.active, '국민연금': b.np, '건강보험': b.hi, '고용보험': b.ei });
      return { ok: true };
    }

    case 'payroll.person.delete': {
      const r = byId_('급여자', b.id);
      if (r) remove_(r);
      return { ok: true };
    }

    case 'payroll.save': {
      rows_('급여').filter((r) => ym_(r['지급연월']) === String(b.ym)).forEach(remove_);
      const list = b.rows || [];
      let id = nextId_('급여');
      list.forEach((r) => append_('급여', [id++, String(b.ym), r.personId, r.name, Number(r.gross) || 0,
        Number(r.tax) || 0, Number(r.localTax) || 0, r.memo || '', nowStr_(),
        Number(r.np) || 0, Number(r.hi) || 0, Number(r.ltc) || 0, Number(r.ei) || 0]));
      return { ok: true, count: list.length };
    }

    case 'wht.save': {
      const row = [String(b.payYm), String(b.accrualYm || b.payYm), b.bizCount, b.bizGross, b.bizTax,
        b.wageCount || 0, b.wageGross || 0, b.wageTax || 0, b.totalTax, b.localTax,
        b.hometax || '', b.wetax || '', b.memo || '', nowStr_(),
        b.otherCount || 0, b.otherGross || 0, b.otherTax || 0];
      const r = rows_('원천세').find((x) => ym_(x['지급연월']) === String(b.payYm));
      if (r) { Object.assign(r, obj_('원천세', row)); save_(r); return { ok: true, updated: true }; }
      append_('원천세', row);
      return { ok: true, updated: false };
    }

    // ── 컬러리버브 관리 (관리자)
    case 'review.project.save': {
      let key = String(b.key || '').trim();
      const r = key ? rows_('리뷰프로젝트').find((x) => String(x['키']).trim() === key) : null;
      const set = { '작품명': b.title, '버전': b.ver, '영상주소': b.src, '비밀번호': b.pw, '만료일': b.until,
        'FPS': b.fps, '활성': b.active, '납품허용': b.deliver, '납품안내': b.dnote, '납품만료': b.duntil, '메모': b.memo };
      if (r) { patch_(r, set); return { ok: true, key, link: REVIEW_BASE + key, dlink: DELIVERY_BASE + key }; }
      if (!key) {
        do { key = crypto.randomBytes(4).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase(); }
        while (key.length < 5 || rows_('리뷰프로젝트').some((x) => String(x['키']).trim() === key));
      }
      append_('리뷰프로젝트', [key, b.title || '', b.ver || '', b.src || '', b.pw || '', b.until || '',
        Number(b.fps) || 24, b.active !== false, !!b.deliver, b.dnote || '', b.duntil || '', b.memo || '', nowStr_()]);
      return { ok: true, key, link: REVIEW_BASE + key, dlink: DELIVERY_BASE + key };
    }
    case 'review.project.delete': {
      const key = String(b.key || '').trim();
      const r = rows_('리뷰프로젝트').find((x) => String(x['키']).trim() === key);
      let videoRemoved = false;
      if (r && b.withVideo) {
        // 이 프로젝트만 쓰는, 리뷰 폴더 안의 파일일 때만 지웁니다
        const src = String(r['영상주소'] || '').trim();
        const others = rows_('리뷰프로젝트').filter((x) => x !== r && String(x['영상주소'] || '').trim() === src);
        if (src && !/[\/]|^https?:/i.test(src) && !others.length) {
          try { fs.unlinkSync(path.join(REVIEW_DIR, src)); videoRemoved = true; } catch {}
        }
      }
      if (r) remove_(r);
      if (b.withData) {
        ['리뷰코멘트', '납품파일', '납품기록'].forEach((n) =>
          rows_(n).filter((x) => String(x['프로젝트키']).trim() === key).forEach(remove_));
      }
      return { ok: true, videoRemoved };
    }
    case 'review.videos': return { ok: true, videos: reviewFiles_(), base: VIDEO_BASE };
    case 'review.file.save': {
      const r = b.id ? byId_('납품파일', b.id) : null;
      const set = { '프로젝트키': b.key, '파일명': b.name, '구분': b.kind, '규격': b.spec, '용량': b.size,
        '체크섬': b.hash, '링크': b.url, '활성': b.active };
      if (r) { patch_(r, set); return { ok: true, id: r.ID }; }
      const id = nextId_('납품파일');
      append_('납품파일', [id, b.key, b.name || '', b.kind || '', b.spec || '', b.size || '', b.hash || '', b.url || '', b.active !== false]);
      return { ok: true, id };
    }
    case 'review.file.delete': { const r = byId_('납품파일', b.id); if (r) remove_(r); return { ok: true }; }
    case 'review.comment.set': {
      const r = rows_('리뷰코멘트').find((x) => String(x['코멘트ID']) === String(b.id));
      if (r) patch_(r, { '처리': b.done === undefined ? undefined : (b.done ? '완료 ' + nowStr_().slice(5) : ''), '읽음': b.read });
      return { ok: true };
    }
    case 'review.comment.delete': {
      const r = rows_('리뷰코멘트').find((x) => String(x['코멘트ID']) === String(b.id));
      if (r) remove_(r);
      return { ok: true };
    }
    case 'review.markRead': {
      const map = { comments: '리뷰코멘트', records: '납품기록', intakes: '문진', inquiries: '문의' };
      (b.kinds || Object.keys(map)).forEach((k) => {
        if (!map[k]) return;
        rows_(map[k]).forEach((r) => { if (!isTrue_(r['읽음'])) patch_(r, { '읽음': true }); });
      });
      return { ok: true };
    }
    case 'intake.set': {
      const r = rows_('문진').find((x) => String(x['접수번호']) === String(b.no));
      if (r) patch_(r, { '진행 상태': b.status, '메모': b.memo, '읽음': b.read });
      return { ok: true };
    }
    case 'intake.delete': { const r = rows_('문진').find((x) => String(x['접수번호']) === String(b.no)); if (r) remove_(r); return { ok: true }; }
    case 'inquiry.set': {
      const r = rows_('문의').find((x) => String(x['접수번호']) === String(b.no));
      if (r) patch_(r, { '진행 상태': b.status, '메모': b.memo, '읽음': b.read });
      return { ok: true };
    }
    case 'inquiry.delete': { const r = rows_('문의').find((x) => String(x['접수번호']) === String(b.no)); if (r) remove_(r); return { ok: true }; }

    case 'company.set':
      if (b.company !== undefined) cfgSet_('회사명', b.company);
      ['사업자번호', '대표자', '사업장주소', '업태', '종목', '계산서이메일', '계산서안내',
       '요율_국민연금', '요율_건강보험', '요율_장기요양', '요율_고용보험'].forEach((k) => {
        if (b[k] !== undefined) cfgSet_(k, b[k]);
      });
      return { ok: true };
  }
  return { ok: false, error: 'unknown action: ' + a };
}

function lastSeen_(user) {
  const r = db.prepare("SELECT at FROM log WHERE user = ? AND action = 'login' AND ok = 1 ORDER BY rowid DESC LIMIT 1").get(user);
  return r ? r.at : '';
}

const mapPerson_ = (r) => ({ id: Number(r['ID']), name: String(r['성명']), role: String(r['역할'] || ''),
  bank: String(r['은행'] || ''), holder: String(r['예금주'] || ''), accMask: String(r['계좌표시'] || ''),
  envFileId: String(r['봉투ID'] || ''), industry: String(r['업종코드'] || '940909'),
  consentDate: fmt_(r['동의일']), incomeType: String(r['소득구분'] || 'biz'), fp: String(r['지문'] || ''),
  active: notFalse_(r['활성']) });
const mapProject_ = (r) => ({ id: Number(r['ID']), name: String(r['이름']),
  client: String(r['클라이언트'] || ''), stage: String(r['단계'] || '프리'),
  start: ymd_(r['시작일']), due: ymd_(r['마감일']), amount: Number(r['계약금액']) || 0,
  owner: String(r['담당'] || ''), memo: String(r['메모'] || ''), active: notFalse_(r['활성']),
  code: String(r['코드'] || ''), folder: String(r['폴더'] || ''), shootVer: String(r['회차표'] || '') });
const mapShoot_ = (r) => ({ id: Number(r['ID']), projectId: Number(r['프로젝트ID']), no: String(r['회차'] || ''),
  date: ymd_(r['날짜']), place: String(r['장소'] || ''), addr: String(r['주소'] || ''),
  call: String(r['집합'] || ''), note: String(r['내용'] || ''), status: String(r['상태'] || '') });
const mapVendor_ = (r) => ({ id: Number(r['ID']), company: String(r['상호']),
  bizNo: String(r['사업자번호'] || ''), ceo: String(r['대표자'] || ''), bizType: String(r['업태'] || ''),
  bizItem: String(r['종목'] || ''), address: String(r['주소'] || ''), manager: String(r['담당자'] || ''),
  email: String(r['이메일'] || ''), bank: String(r['은행'] || ''), holder: String(r['예금주'] || ''),
  accMask: String(r['계좌표시'] || ''), envFileId: String(r['봉투ID'] || '') });
const mapPay_ = (r) => ({ id: Number(r['ID']), personId: Number(r['인력ID']), name: String(r['성명']),
  payDate: ymd_(r['지급일']), ym: ym_(r['귀속월']), project: String(r['프로젝트'] || ''),
  role: String(r['역할'] || ''), gross: Number(r['지급액']) || 0, incomeTax: Number(r['소득세']) || 0,
  localTax: Number(r['지방소득세']) || 0, net: Number(r['실지급']) || 0,
  status: String(r['상태'] || '지급완료'), memo: String(r['메모'] || ''),
  incomeType: String(r['소득구분'] || 'biz'), fp: String(r['지문'] || ''), base: Number(r['소득금액']) || 0 });
const mapTask_ = (r) => ({ id: Number(r['ID']), projectId: Number(r['프로젝트ID']),
  stage: String(r['단계'] || '프리'), title: String(r['제목'] || ''), assignee: String(r['담당'] || ''),
  due: ymd_(r['마감일']), done: isTrue_(r['완료']), order: Number(r['순서']) || 0, cal: isTrue_(r['캘린더']),
  start: ymd_(r['시작일']), calName: String(r['캘린더이름'] || '') });
const mapBoard_ = (r) => ({ id: Number(r['ID']), cat: String(r['분류'] || '일반'),
  title: String(r['제목'] || ''), body: String(r['내용'] || ''), author: String(r['작성자'] || ''),
  createdAt: fmt_(r['작성일']), pinned: isTrue_(r['고정']) });

function bootstrapAdmin_(who) {
  return { ok: true,
    submissions: rows_('제출함').filter((r) => String(r['상태']) !== '삭제됨').map((r) => ({
      id: String(r['제출ID']), at: fmt_(r['수신시각']), kind: String(r['구분']),
      label: String(r['라벨'] || ''), fileId: String(r['파일ID']),
      size: Number(r['크기']) || 0, status: String(r['상태']) })),
    invites: rows_('초대').map((r) => ({ token: String(r['토큰']), label: String(r['라벨'] || ''),
      role: String(r['역할'] || ''), expires: fmt_(r['만료']), used: fmt_(r['사용']) })),
    people: rows_('인력').map(mapPerson_),
    vendors: rows_('거래처').map(mapVendor_),
    projects: rows_('프로젝트').map(mapProject_),
    payments: rows_('지급').map(mapPay_),
    sales: rows_('매출').map((r) => ({ id: Number(r['ID']), date: ymd_(r['일자']),
      project: String(r['프로젝트'] || ''), client: String(r['거래처'] || ''), item: String(r['항목'] || ''),
      supply: Number(r['공급가액']) || 0, vat: Number(r['부가세']) || 0, total: Number(r['합계']) || 0,
      status: String(r['발행상태'] || '발행예정'), issuedAt: ymd_(r['발행일']), paidAt: ymd_(r['입금일']),
      proof: String(r['증빙'] || '세금계산서'), memo: String(r['메모'] || '') })),
    purchases: rows_('매입').map((r) => ({ id: Number(r['ID']), date: ymd_(r['일자']),
      project: String(r['프로젝트'] || ''), vendor: String(r['거래처'] || ''), cat: String(r['분류'] || '기타'),
      item: String(r['항목'] || ''), supply: Number(r['공급가액']) || 0, vat: Number(r['부가세']) || 0,
      total: Number(r['합계']) || 0, proof: String(r['증빙'] || '세금계산서'),
      deduct: String(r['공제여부'] || '공제'), memo: String(r['메모'] || '') })),
    vault: rows_('금고').map((r) => ({ id: Number(r['ID']), cat: String(r['분류'] || '기타'),
      name: String(r['이름'] || ''), envFileId: String(r['봉투ID'] || ''), memo: String(r['메모'] || ''),
      updatedAt: fmt_(r['수정일']) })),
    payrollPeople: rows_('급여자').map((r) => ({ id: Number(r['ID']), name: String(r['성명']),
      kind: String(r['구분'] || '직원'), baseGross: Number(r['기본급여']) || 0,
      baseTax: Number(r['기본소득세']) || 0, memo: String(r['메모'] || ''),
      np: notFalse_(r['국민연금']), hi: notFalse_(r['건강보험']), ei: isTrue_(r['고용보험']),
      active: notFalse_(r['활성']) })),
    payroll: rows_('급여').map((r) => ({ id: Number(r['ID']), ym: ym_(r['지급연월']),
      personId: Number(r['급여자ID']), name: String(r['성명']), gross: Number(r['지급액']) || 0,
      tax: Number(r['소득세']) || 0, localTax: Number(r['지방소득세']) || 0, memo: String(r['메모'] || ''),
      np: Number(r['국민연금료']) || 0, hi: Number(r['건강보험료']) || 0,
      ltc: Number(r['장기요양료']) || 0, ei: Number(r['고용보험료']) || 0 })),
    board: rows_('게시판').map(mapBoard_),
    tasks: rows_('작업').map(mapTask_),
    shoots: rows_('회차').map(mapShoot_),
    wht: rows_('원천세').map((r) => ({ payYm: ym_(r['지급연월']), accrualYm: ym_(r['귀속연월']),
      bizCount: Number(r['사업소득인원']) || 0, bizGross: Number(r['사업소득지급액']) || 0,
      bizTax: Number(r['사업소득세']) || 0, wageCount: Number(r['근로소득인원']) || 0,
      wageGross: Number(r['근로소득지급액']) || 0, wageTax: Number(r['근로소득세']) || 0,
      totalTax: Number(r['소득세합계']) || 0, localTax: Number(r['지방소득세']) || 0,
      hometax: fmt_(r['홈택스신고일']), wetax: fmt_(r['위택스신고일']), memo: String(r['메모'] || '') })),
    reviews: reviewsBundle_(),
    company: cfgGet_('회사명') || COMPANY_DEFAULT['회사명'],
    companyInfo: companyInfo_(),
    rates: rates_(),
    role: 'admin',
    me: { name: who.name || who.user, userId: who.user } };
}

function reviewsBundle_() {
  const projects = rows_('리뷰프로젝트').map((r) => ({ key: String(r['키']).trim(), title: String(r['작품명'] || ''),
    ver: String(r['버전'] || ''), src: String(r['영상주소'] || ''), srcFull: resolveSrc_(r['영상주소']),
    pw: String(r['비밀번호'] || ''), until: ymd_(r['만료일']), fps: Number(r['FPS']) || 24, active: isOn_(r['활성']),
    deliver: isOn_(r['납품허용']), dnote: String(r['납품안내'] || ''), duntil: ymd_(r['납품만료']),
    memo: String(r['메모'] || ''), createdAt: fmt_(r['등록일']),
    link: REVIEW_BASE + String(r['키']).trim(), dlink: DELIVERY_BASE + String(r['키']).trim() }));
  const comments = rows_('리뷰코멘트').map((r) => ({ id: String(r['코멘트ID'] || ''), at: fmt_(r['접수시각']),
    key: String(r['프로젝트키'] || '').trim(), title: String(r['작품명'] || ''), ver: String(r['버전'] || ''),
    tc: String(r['타임코드'] || ''), sec: r['초'], who: String(r['작성자'] || ''), txt: String(r['내용'] || ''),
    done: String(r['처리'] || ''), read: isTrue_(r['읽음']) }));
  const files = rows_('납품파일').map((r) => ({ id: Number(r['ID']), key: String(r['프로젝트키'] || '').trim(),
    name: String(r['파일명'] || ''), kind: String(r['구분'] || ''), spec: String(r['규격'] || ''), size: String(r['용량'] || ''),
    hash: String(r['체크섬'] || ''), url: String(r['링크'] || ''), active: isOn_(r['활성']) }));
  const records = rows_('납품기록').map((r) => ({ at: fmt_(r['최근수령']), key: String(r['프로젝트키'] || '').trim(),
    title: String(r['작품명'] || ''), who: String(r['이름'] || ''), org: String(r['소속'] || ''),
    files: String(r['받은파일'] || ''), count: Number(r['횟수']) || 0, first: fmt_(r['최초수령']), read: isTrue_(r['읽음']) }));
  const intakes = rows_('문진').map((r) => { const o = {}; SHEETS['문진'].forEach((h) => { o[h] = r[h] == null ? '' : r[h]; });
    o['읽음'] = isTrue_(r['읽음']); return o; });
  const inquiries = rows_('문의').map((r) => { const o = {}; SHEETS['문의'].forEach((h) => { o[h] = r[h] == null ? '' : r[h]; });
    o['읽음'] = isTrue_(r['읽음']); return o; });
  return { projects, comments, files, records, intakes, inquiries,
    unread: { comments: comments.filter((c) => !c.read).length, records: records.filter((c) => !c.read).length,
              intakes: intakes.filter((c) => !c['읽음']).length, inquiries: inquiries.filter((c) => !c['읽음']).length } };
}

function bootstrapPd_(who) {
  return { ok: true, role: 'pd', me: { name: who.name || who.user, userId: who.user }, mustChange: false,
    projects: rows_('프로젝트').map(mapProject_).map((p) => { p.amount = 0; return p; }),
    tasks: rows_('작업').map(mapTask_),
    shoots: rows_('회차').map(mapShoot_),
    board: rows_('게시판').map(mapBoard_),
    company: cfgGet_('회사명') || COMPANY_DEFAULT['회사명'],
    submissions: [], invites: [], people: [], vendors: [], payments: [], sales: [], purchases: [],
    payroll: [], payrollPeople: [], wht: [], vault: [], companyInfo: {}, rates: {} };
}

// ══════════════════════════════════════════ 구글 시트 → NAS 이사 (관리자, 한 번)
/* 이사 도구(migrate.html)가 보냅니다.
   sheets   : { 탭이름: [ {열이름: 값, ...}, ... ] }   ← 기존 시트 그대로
   files    : { 드라이브파일ID: 봉투객체 }
   keystore : { pub, pkcs8 }                            ← 관리자 비밀번호로 연 개인키
   gasAuth  : 예전 관리자 토큰 (캘린더 연동을 앱스스크립트로 계속 보내기 위해)
   replace  : true 면 그 탭을 비우고 새로 넣음 */
function import_(b) {
  if (!b._who || roleOf_(b._who.user) !== 'admin') return { ok: false, error: '관리자만 할 수 있습니다.' };
  return tx_(() => {
    const done = {};
    Object.keys(b.sheets || {}).forEach((name) => {
      if (!SHEETS[name]) return;
      if (b.replace) Q.wipe.run(name);
      const keep = name === '설정'
        ? ['회사명', ...Object.keys(COMPANY_DEFAULT), ...Object.keys(RATE_DEFAULT)] : null;
      let n = 0;
      (b.sheets[name] || []).forEach((r) => {
        const o = {};
        Object.keys(r).forEach((k) => { if (k !== '_row') o[k] = r[k]; });
        if (keep && !keep.includes(String(o['키']))) return;   // 비밀번호 관련 값은 옮기지 않음
        if (name === '설정') { cfgSet_(String(o['키']), o['값']); n++; return; }
        append_(name, o); n++;
      });
      done[name] = n;
    });
    let files = 0;
    Object.keys(b.files || {}).forEach((id) => {
      if (!ID_RE.test(id) || !b.files[id]) return;
      fs.writeFileSync(path.join(DATA, 'files', id + '.json'), JSON.stringify(b.files[id]));
      files++;
    });
    if (b.keystore && b.keystore.pub && b.keystore.pkcs8) {
      cfgSet_('pub', b.keystore.pub);
      cfgSet_('privSealed', seal_(b.keystore.pkcs8));
    }
    if (b.gasAuth) cfgSet_('gasAuth', b.gasAuth);
    log_(b._who.user, 'admin', 'import', b._ip, true);
    return { ok: true, sheets: done, files, keystore: !!(b.keystore && b.keystore.pkcs8) };
  });
}

/** 처음부터 새로 시작할 때 (이사할 자료가 없으면): 관리자 브라우저가 만든 열쇠쌍 등록 */
function initKeys_(b) {
  if (!b._who || roleOf_(b._who.user) !== 'admin') return { ok: false, error: '관리자만 할 수 있습니다.' };
  if (cfgGet_('pub')) return { ok: false, error: '이미 열쇠가 있습니다.' };
  if (!b.pub || !b.pkcs8) return { ok: false, error: '열쇠 정보가 부족합니다.' };
  return tx_(() => { cfgSet_('pub', b.pub); cfgSet_('privSealed', seal_(b.pkcs8)); return { ok: true }; });
}

// ══════════════════════════════════════════ 엑셀(CSV) 내보내기
function exportCsv_(name) {
  if (!SHEETS[name]) throw new Error('없는 탭입니다.');
  const head = SHEETS[name];
  const HIDE = ['pub', 'privSealed', 'gasAuth'];   // 열쇠 관련 값은 내보내지 않음
  const list = rows_(name).filter((r) => !(name === '설정' && HIDE.includes(String(r['키']))));
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [head.join(','), ...rows_(name).map((r) => head.map((h) => q(r[h])).join(','))].join('\n');
}

// ══════════════════════════════════════════ 매일 백업 (30일 보관)
function backup_() {
  const day = kst_().slice(0, 10);
  const dst = path.join(DATA, '백업', `hub-${day}.db`);
  if (fs.existsSync(dst)) return;
  try {
    db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(path.join(DATA, '백업')).filter((f) => /^hub-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    old.slice(0, Math.max(0, old.length - 30)).forEach((f) => fs.unlinkSync(path.join(DATA, '백업', f)));
    console.log('백업 완료:', dst);
  } catch (e) { console.error('백업 실패:', e.message); }
}
setInterval(backup_, 60 * 60e3); setTimeout(backup_, 10e3);

// ══════════════════════════════════════════ 리뷰 영상 올리기 (조각 업로드)
/* Cloudflare 는 한 번에 100MB 까지만 받으므로 브라우저가 조각(약 50MB)으로 나눠 보냅니다.
   start → chunk(여러 번, offset 순서대로) → finish. 끊겨도 같은 offset 부터 다시 보내면 이어집니다. */
const UPLOADS = new Map();                      // id → { name, size, part, at }
function safeName_(n) {
  const ext = (String(n).match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0].toLowerCase();
  let base = String(n).slice(0, String(n).length - ext.length)
    .normalize('NFC').replace(/[\\/:*?"<>|#%&{}$!'`@+=]+/g, '').replace(/\s+/g, '_').replace(/^\.+/, '');
  base = base.slice(0, 80) || 'review';
  return base + ext;
}
function freeName_(n) {
  let name = safeName_(n), i = 1;
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  while (fs.existsSync(path.join(REVIEW_DIR, name)) || [...UPLOADS.values()].some((u) => u.name === name)) {
    name = `${base}_${++i}${ext}`;
  }
  return name;
}
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm'];
async function upload_(req, res, url, who) {
  if (roleOf_(who.user || '') !== 'admin') return send(res, 403, { ok: false, error: '관리자만 할 수 있습니다.' });
  const op = url.searchParams.get('op');
  const now = Date.now();
  for (const [k, u] of UPLOADS) if (now - u.at > 6 * 3600e3) { try { fs.unlinkSync(u.part); } catch {} UPLOADS.delete(k); }

  if (op === 'start') {
    const name = url.searchParams.get('name') || '';
    const size = Number(url.searchParams.get('size') || 0);
    if (!VIDEO_EXT.includes(path.extname(name).toLowerCase())) {
      return send(res, 200, { ok: false, error: 'mp4 · mov · m4v · webm 영상만 올릴 수 있어요.' });
    }
    if (!(size > 0)) return send(res, 200, { ok: false, error: '파일 크기를 알 수 없어요.' });
    try { fs.mkdirSync(REVIEW_DIR, { recursive: true }); fs.accessSync(REVIEW_DIR, fs.constants.W_OK); }
    catch { return send(res, 200, { ok: false, error: `NAS 영상 폴더(${REVIEW_DIR})에 쓸 수 없어요. 컨테이너 설정을 확인해 주세요.` }); }
    const id = crypto.randomBytes(9).toString('hex');
    const fname = freeName_(name);
    const part = path.join(REVIEW_DIR, `.${id}.part`);
    fs.writeFileSync(part, '');
    UPLOADS.set(id, { name: fname, size, part, at: now });
    return send(res, 200, { ok: true, id, name: fname });
  }
  const id = url.searchParams.get('id') || '';
  const u = UPLOADS.get(id);
  if (!u) return send(res, 200, { ok: false, error: '올리기가 끊겼어요. 처음부터 다시 올려 주세요.' });
  u.at = now;

  if (op === 'chunk') {
    const offset = Number(url.searchParams.get('offset') || 0);
    const have = fs.statSync(u.part).size;
    if (offset > have) return send(res, 200, { ok: false, error: 'offset', have });
    if (offset < have) fs.truncateSync(u.part, offset);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(u.part, { flags: 'a' });
      let n = 0;
      req.on('data', (c) => { n += c.length; if (n > 96 * 1024 * 1024) { req.destroy(); reject(new Error('조각이 너무 큽니다')); } });
      req.pipe(ws);
      ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
    });
    return send(res, 200, { ok: true, have: fs.statSync(u.part).size });
  }
  if (op === 'finish') {
    const have = fs.statSync(u.part).size;
    if (have !== u.size) return send(res, 200, { ok: false, error: `크기가 맞지 않아요 (${have} / ${u.size})`, have });
    const dst = path.join(REVIEW_DIR, u.name);
    fs.renameSync(u.part, dst);
    try { fs.chmodSync(dst, 0o644); } catch {}
    UPLOADS.delete(id);
    console.log(`[upload] ${who.user} → ${dst} (${(have / 1048576).toFixed(1)}MB)`);
    return send(res, 200, { ok: true, name: u.name, url: VIDEO_BASE + encodeURI(u.name) });
  }
  if (op === 'cancel') {
    try { fs.unlinkSync(u.part); } catch {}
    UPLOADS.delete(id);
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { ok: false, error: 'op' });
}
/** 리뷰 폴더의 영상 목록 (관리 화면에서 고르기용) */
function reviewFiles_() {
  try {
    return fs.readdirSync(REVIEW_DIR).filter((n) => !n.startsWith('.') && VIDEO_EXT.includes(path.extname(n).toLowerCase()))
      .map((n) => { const st = fs.statSync(path.join(REVIEW_DIR, n)); return { name: n, size: st.size, at: st.mtimeMs }; })
      .sort((a, b) => b.at - a.at);
  } catch { return []; }
}

// ══════════════════════════════════════════ HTTP
function okToken(req) {
  const a = Buffer.from(String(req.headers['x-store-token'] || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function send(res, code, obj, type) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* 요청 처리 중 하나가 실패해도 서버는 계속 돕니다 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, v: VERSION,
      folder: FOLDER.ready(), calendar: GCAL.ready() ? 'direct' : (GAS_URL ? 'gas' : 'off') });
    if (!okToken(req)) return send(res, 401, { ok: false, error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname === '/export') {
      const who = JSON.parse(String(req.headers['x-hub-who'] || '{}'));
      if (roleOf_(who.user || '') !== 'admin') return send(res, 403, { ok: false, error: '관리자만' });
      return send(res, 200, exportCsv_(url.searchParams.get('sheet') || ''), 'text/csv; charset=utf-8');
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' });
    if (url.pathname === '/upload') {
      return await upload_(req, res, url, JSON.parse(String(req.headers['x-hub-who'] || '{}')));
    }

    const limit = url.pathname === '/import' ? 400 * 1024 * 1024 : 12 * 1024 * 1024;
    const b = JSON.parse(await readBody(req, limit) || '{}');
    let out;
    if (url.pathname === '/auth') out = await auth_(b);
    else if (url.pathname === '/public') out = public_(b);
    else if (url.pathname === '/rpc') out = await rpc_(b);
    else if (url.pathname === '/import') out = import_(b);
    else if (url.pathname === '/initkeys') out = initKeys_(b);
    else return send(res, 404, { ok: false, error: 'not found' });
    send(res, 200, out);
  } catch (e) {
    console.error(url.pathname, e);
    send(res, 200, { ok: false, error: String(e.message || e) });
  }
});
server.listen(PORT, () => {
  const gf = GROUP_FILES.find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
  let rv = '(없음!)';
  try { fs.accessSync(REVIEW_DIR, fs.constants.W_OK); rv = REVIEW_DIR; } catch {}
  console.log(`${VERSION} — :${PORT}, 데이터 ${DATA}, QNAP ${QNAP_URL || '(미설정)'}, 그룹 파일 ${gf || '(없음!)'}, 리뷰 영상 폴더 ${rv}`);
  console.log(`의뢰 폴더 ${FOLDER.ready() ? FOLDER.ROOT : '(연결 안 됨)'}, 캘린더 ${GCAL.ready() ? '직접 연동' : (GAS_URL ? '앱스스크립트 경유' : '(미설정)')}`);
});
