# 모리 — 내 곁의 작은 비서

모바일·태블릿 앱 UI PoC입니다. 2026-09-29 기능 기반 대시보드 시나리오를 반영했습니다.

## 실행

Node.js 22.9 이상. 빌드된 CSS가 포함되어 있습니다.

```sh
npm start
```

[앱 열기](http://localhost:4173) · localhost:4173 · 로컬 인터페이스에만 바인딩합니다.

```sh
npm ci
npm run build
npm run check
npm test
```

환경 설정은 `.env.example`을 `.env`로 복사해 편집합니다. `PORT`, `MORI_POC_ORIGIN`, `MORI_API_BASE_URL` 변경 후 서버를 재시작하세요.

## 체험 시작

**대시보드 → 둘러보기**에서 시작하세요.

- **대시보드**: 현재 표시 시간의 카드 캐러셀, 기록과 문서, 오늘 일정, 최근 대화.
- **스케줄**: 월간 달력, 주간 일정 목록, 일간 타임라인. 직접 CRUD와 채팅이 같은 기록을 사용합니다.
- **대화**: 검색·새 대화·이어 보기. 텍스트와 음성 입력이 같은 대화로 이어집니다.
- **기능**: 주차·뉴스·주가·메모·스케줄·알림과 커스텀 기능. 정의·버전·실행 결과·중지 상태.
- **마이**: 로그인·로그아웃, 사용자 정보 조회·이름 수정, 시스템/라이트/다크 테마, 무료·Pro 요금제 안내.

상단 **아침 체험**에서 아침·09시 뉴스 수집·낮·저녁으로 이동합니다. 시간 이동은 기존 기록을 지우지 않습니다. 새로고침해도 기록과 알림 목표 시각이 유지됩니다.

## 연결 범위

| 기능 | 현재 동작 |
| --- | --- |
| 대화·주차·메모·일정·커스텀 | 브라우저 로컬 시나리오 실행 및 저장 |
| 뉴스·주가 | 예시 데이터, 상태·종목·기간 변경 |
| 알림 | 목표 시각 카운트다운, 연장·취소·완료 체험 |
| 예약 실행 | 앱이 열린 동안 로컬 실행, 재접속 시 당일 미실행 항목 보정 |
| 음성 | 지원 브라우저 음성 인식 + 수정 가능한 예시 입력 |
| TXT/MD/CSV | UTF-8 원문 10MB 이하 보관, 제한된 미리보기, 원문 다운로드 |
| 마이 | 소셜 로그인·로그아웃, 계정 정보·이름 수정·테마·요금제 조회 API 연결 |
| Hermes·AI 검색·Excel/PDF·OS 푸시·결제 | 이 UI 체험에는 연결하지 않음 |

체험 데이터는 `mori.experience.v6`에 저장되며 실제 계정 주차와 별도입니다. 음성은 브라우저 서비스가 처리할 수 있으며 Mori 서버 STT가 아닙니다. 앱을 닫아도 실행되는 예약·푸시는 백엔드 연결이 필요합니다.

주차는 출근용/외부와 상시/지정 시간 표시를 선택합니다. 새 위치만 기억하면 상시 표시하고,
시간 표시는 한국 시간·요일·기간을 직접 정합니다. 기존 체험 기록은 유지합니다.
문서 목록에는 메타데이터만 저장하고 원문은 IndexedDB에 보관해 10MB 파일을 새로고침 후에도
다시 열 수 있습니다. 실제 문서 API 연결과 AI 요약은 후속 작업입니다.

## 백엔드 연결

기본 API 주소는 `http://localhost:8000`입니다. `master` 작업 폴더에서 API와 DB를 실행합니다.

```sh
MORI_AUTH_RETURN_URLS='["http://localhost:4173/auth/callback","http://localhost:5173/auth/callback"]' \
  docker compose -p mori-poc-local up -d --build
```

독립 실행 파일 환경은 `docker-compose`를 사용합니다. 소셜 키는 **백엔드의** `MORI_NAVER_CLIENT_ID`, `MORI_NAVER_CLIENT_SECRET`, `MORI_KAKAO_CLIENT_ID`, `MORI_KAKAO_CLIENT_SECRET`로 설정합니다. 프론트엔드에 키를 넣지 않습니다.

| 등록 위치 | 기본 로컬 주소 |
| --- | --- |
| 네이버 앱 콜백 | `http://localhost:8000/v1/auth/naver/callback` |
| 카카오 앱 Redirect URI | `http://localhost:8000/v1/auth/kakao/callback` |
| 백엔드 MORI_AUTH_RETURN_URLS | `http://localhost:4173/auth/callback` |
| 백엔드 MORI_AUTH_PUBLIC_BASE_URL | `http://localhost:8000` |

마이의 **네이버 · 카카오로 로그인**에서 로그인합니다. 공급자 키가 없으면 버튼이 비활성화됩니다. 임의 사용자 ID 로그인이나 테스트 계정 우회는 제공하지 않습니다.

마이의 대시보드 조정·체험 시간·기록 초기화·가짜 Free/Pro 전환은 제거했습니다. 테마는 로그인한 계정에 저장하며, 로그인 전에는 현재 브라우저에만 저장합니다. 백엔드는 `0006_account_settings`까지 적용해야 합니다. 무료 이용에는 결제가 없으며 Pro 결제·해지는 결제사·가격·주기가 확정될 때까지 준비 중으로 표시합니다. 기존 관리자 승인 Pro와 유료 구독은 구분합니다.

## 파일 구조

- `src/app-experience.js`: 탭·상세·채팅·음성·폼·파일·계정 연결
- `src/experience.mjs`: 체험 데이터·요청 분기·카드 표시·예약
- `styles/experience.scss` → `styles/main.css`: 앱 디자인
- `src/api.mjs`, `src/ui-model.mjs`: API와 주차 입력/중복 방지
- `scripts/server.mjs`: PKCE 로그인·HttpOnly 세션·제한된 API 중계
- `tests/experience.test.mjs`: 새 시나리오 검증
- [체험 안내와 검증 기록](docs/app-poc.md)

이전 `src/app.js`, `styles/main.scss`와 순수 모델/테스트는 회귀 참고용이며 현재 진입점에서 사용하지 않습니다. 이전 저장소를 덮어쓰지 않습니다. API 토큰은 BFF 메모리에만 저장하며 서버 재시작 시 재로그인이 필요합니다.
