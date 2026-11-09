/**
 * mgrm.kr — 언어 자동 분기 Worker
 *
 * run_worker_first 에 등록된 경로(/color.html, /intake.html, 옛 업무 허브 주소)만 이 코드를 거칩니다.
 * 나머지 정적 파일은 엣지에서 그대로 나가므로 성능 영향이 없습니다.
 *
 * 판단 순서
 *   1. lang 쿠키가 있으면 그 값이 무조건 우선 (사용자가 직접 고른 값)
 *   2. 쿠키가 없고 Accept-Language 가 ko 로 시작하지 않으면 영문으로 302
 *   3. Accept-Language 헤더 자체가 없으면(검색봇) 국문 원본 그대로
 */

const MAP = {
  "/color.html": "/en/color.html",
  "/intake.html": "/en/intake.html",
};

/* 업무 허브는 hub.mgrm.kr 로 옮겼습니다 — 예전 주소는 같은 경로로 넘겨 줍니다.
   (정산 정보 제출 링크 submit.html?t=… 처럼 뒤에 붙은 값도 그대로 유지) */
const HUB = "https://hub.mgrm.kr";
const MOVED = new Set(["/admin.html", "/admin", "/board.html", "/board", "/invoices.html", "/invoices", "/projects.html", "/projects", "/submit.html", "/submit", "/vault.html", "/vault", "/withholding.html", "/withholding", "/wct-core.js", "/wct-style.css"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (MOVED.has(url.pathname)) {
      const p = url.pathname.endsWith(".html") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css")
        ? url.pathname : url.pathname + ".html";
      return Response.redirect(HUB + p + url.search + url.hash, 301);
    }
    const target = MAP[url.pathname];

    if (target && request.method === "GET") {
      const cookie = request.headers.get("Cookie") || "";
      const saved = (cookie.match(/(?:^|;\s*)lang=(ko|en)/) || [])[1];
      const al = request.headers.get("Accept-Language");

      const goEn = saved === "en" || (!saved && al && !/^\s*ko\b/i.test(al));

      if (goEn) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: target + url.search,
            "Cache-Control": "no-store",
            Vary: "Accept-Language, Cookie",
          },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
