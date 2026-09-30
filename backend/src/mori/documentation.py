"""Interactive documentation backed by the running application's OpenAPI schema."""

import json
from html import escape

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

DESCRIPTION = """
PoC의 대시보드·스케줄·대화·기능·마이 화면을 위한 Mori API입니다.

### 요청을 시험하는 방법
- 로그인 없이 명세를 읽을 수 있습니다. 공개 API인 `GET /health/live`부터 실행해 보세요.
- 사용자 API는 **네이버·카카오 로그인으로 발급한 Mori 액세스 토큰**이 필요합니다.
  Authentication / Authorize의 HTTPBearer에 `Bearer ` 접두어 없이 토큰만 입력하세요.
- `Idempotency-Key`가 필수인 요청은 UUID를 입력합니다.
  새 작업에는 새 UUID를, 통신 실패로 같은 작업을 재시도할 때는 기존 UUID를 사용하세요.
- 수정·삭제에는 조회한 `revision`이 필요합니다. 충돌하면 다시 조회한 뒤 수정하세요.
- 날짜와 시각에는 `+09:00` 또는 `Z` 같은 UTC 오프셋을 포함하세요.
- 채팅 응답은 `text/event-stream`(SSE)입니다. 화면에서 계속 대기할 수 있으며,
  실제 작업 결과는 메시지 기록 및 실행 기록 API에서도 확인할 수 있습니다.

### 구현 범위
일정·메모·알림 목표·사용자 기능 정의와 결과를 저장합니다. 실제 예약 실행, 기기 푸시,
주가 공급자와 Office 문서 변환은 아직 연결되지 않았습니다.
요청 실행은 현재 연결된 API의 데이터를 실제로 변경합니다.
"""

TAGS = [
    {"name": "dashboard", "description": "대시보드 시간대별 카드와 최근 기록·보관함"},
    {"name": "calendar", "description": "스케줄: 월·주·일 기간 조회와 일정 편집"},
    {"name": "chat", "description": "대화 목록·메시지·SSE 진행 상태·실행 결과"},
    {"name": "features", "description": "기본 기능 카탈로그와 내 기능 정의·버전·결과"},
    {"name": "notes", "description": "메모 작성·조회·검색·편집·삭제·복원"},
    {"name": "reminders", "description": "알림 목표 시각과 취소·복원. 기기 푸시는 미연결"},
    {"name": "documents", "description": "TXT·MD·CSV 원문 보관 및 다운로드"},
    {"name": "parking", "description": "사용자별 주차 위치 저장과 최신 위치 조회"},
    {"name": "account", "description": "마이: 내 정보·프로필 수정·테마·요금제와 결제 상태"},
    {"name": "auth", "description": "네이버·카카오 소셜 로그인과 Mori 인증 세션"},
    {"name": "admin", "description": "최고 관리자의 Pro 승인·회수와 변경 이력"},
    {"name": "health", "description": "API 기동 및 데이터베이스 준비 상태"},
]

SCALAR_JS = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.2/dist/browser/standalone.js"


def install_scalar(app: FastAPI) -> None:
    @app.get("/scalar", include_in_schema=False, response_class=HTMLResponse)
    async def scalar(request: Request):
        root = request.scope.get("root_path", "").rstrip("/")
        config = json.dumps(
            {
                "url": root + app.openapi_url,
                "theme": "default",
                "layout": "modern",
                "persistAuth": False,
                "agent": {"disabled": True},
                "telemetry": False,
                "withDefaultFonts": False,
                "showDeveloperTools": "never",
                "authentication": {"preferredSecurityScheme": "HTTPBearer"},
            },
            ensure_ascii=False,
        ).replace("<", "\\u003c")
        root_json = json.dumps(root).replace("<", "\\u003c")
        return HTMLResponse(
            f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Mori API · Scalar</title>
  <style>body {{ margin: 0; font-family: system-ui, sans-serif; }}</style>
</head>
<body>
  <div id="app"></div>
  <noscript>JavaScript를 켜거나 <a href="{escape(root + app.openapi_url)}">OpenAPI JSON</a>을
  확인해 주세요.</noscript>
  <script src="{SCALAR_JS}"></script>
  <script>
    const configuration = {config};
    configuration.servers = [{{url: window.location.origin + {root_json}}}];
    Scalar.createApiReference('#app', configuration);
  </script>
</body>
</html>""",
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )
