# React 웹·RN 앱을 위한 백엔드 확장 계약

갱신일: 2026-11-04 · 기준: master 6285aba / API 0.9.0 · 상태: B-18/B-19 신규 경로는 설계 초안

[백엔드 계획](plan.md) · [앱 구조](../front/react-native-webview-plan.md) · [배포 정책](../architecture/app-release-versioning.md)

## 1. 현행 API에서 재사용할 것

기준 커밋은 `master` **6285aba**, API **0.9.0**, migration **0017_news_refresh_deadline**다. [현재 구현 현황](implementation-status-2026-11-03.md)과 [고정 OpenAPI](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/openapi.json)를 대조했다. 아래는 이미 구현된 인증 경로다. B-18의 HttpOnly 웹 세션·WebView 교환권·client-config, B-19의 APNs/FCM·위젯 계약은 아직 이 명세에 없다.

| 경로 | 현행 역할 |
| --- | --- |
| `GET /v1/auth/providers` | 네이버·카카오 사용 가능 상태 |
| `GET /v1/auth/{provider}/login` | return_url, code_challenge, client_state로 시스템 브라우저 로그인 시작 |
| `GET /v1/auth/{provider}/callback` | 제공자 callback 확인 후 일회용 Mori code/state로 복귀 |
| `POST /v1/auth/exchange` | code + code_verifier로 Mori access/refresh token 발급 |
| `POST /v1/auth/refresh` | Mori 토큰 갱신 |
| `POST /v1/auth/logout` | 현재 인증 세션 해제 |

로그인 코드를 검증하는 Mori의 challenge/verifier 흐름과 네이버·카카오 제공자 자체의 OAuth 지원 기능을 동일시하지 않는다. 앱의 장기 토큰을 callback URL에 넣지 않는다. 반응형 웹/앱 여부와 관계없이 주차·일정·메모·대시보드·문서·기능/결과·채팅은 기존 도메인 API를 재사용한다.

앱이 Free/Pro 또는 사용자 Pod 주소를 골라 요청하게 하지 않는다. 인증된 사용자와 서버 runtime 바인딩이 기준이다. 웹 검색은 채팅에서 Hermes가 도구로 선택하고 별도 공개 AI 검색 API를 다시 만들지 않는다.

## 2. B-18: 웹 세션과 앱 연계

기존 API는 Bearer 토큰 흐름이다. 제품 React 웹에서 refresh token을 localStorage에 두지 않도록 서버가 보관하는 웹 세션 계층을 추가한다. 별도 Pod가 필수는 아니며 Mori 백엔드의 모듈/라우터로 시작할 수 있다. 기존 도메인 로직을 복제하지 않고 같은 인증 주체로 위임한다.

| 신규 계약 후보 | 목적/입출력 | 검증 조건 |
| --- | --- | --- |
| 웹 로그인 시작/복귀 라우터 | verifier/state를 서버 세션에 저장하고 현행 소셜 흐름 연결 | CSRF/state·허용 복귀 주소·로그인 취소/만료 |
| `POST /v1/auth/webview-ticket` | native Bearer 세션에서 짧은 수명의 일회용 교환권 발급 | 사용자/세션·대상 web origin·challenge에 귀속, 평문 원본 영속 저장 금지 |
| `POST /v1/auth/webview-session` | 교환권+웹 verifier 확인 후 Secure/HttpOnly 쿠키 설정 | 원자적 1회 소비·만료·정확한 origin·replay 차단 |
| 웹 세션 갱신/종료 라우터 | 서버 토큰 갱신 및 원래 native 세션과 해제 연계 | 동시 refresh 직렬화·revocation·CSRF |

위 경로는 후보이며 구현 시 OpenAPI와 함께 확정한다. 웹 세션은 native 세션과 연결해 native logout 후에도 웹 쿠키가 계속 유효한 별도 로그인이 남지 않게 한다. 웹에서 시작한 logout도 앱에 상태를 알리고 서버 연결 세션을 해제한다.

교환 예시는 신뢰한 WebView가 verifier를 만들고 challenge를 RN에 전달 → RN이 인증된 API로 교환권 발급 → 제한된 브리지로 해당 페이지에 교환권 전달 → 웹이 verifier와 함께 POST하여 쿠키 수립이다. 짧은 교환권도 URL/접근 로그에 남기지 않고 페이지 세대와 요청 ID를 연결한다. native access/refresh token을 웹 JavaScript에 제공하지 않는다.

초기 쿠키 정책은 동일 origin, Secure, HttpOnly, 적절한 SameSite를 사용하며 상태 변경에는 CSRF/Origin 검증을 추가한다. 외부 소셜 로그인 왕복의 cookie와 WebView 세션 cookie는 다른 수명주기다. WebView 최초 요청에 Authorization header를 설정하는 것만으로 이후 모든 탐색이 인증되는 것으로 처리하지 않는다. [WebView의 header/cookie 동작](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Guide.md)

## 3. B-18: client-config 계약 초안

`GET /v1/client-config`를 로그인 전에도 조회할 수 있게 한다. 개인정보·자격증명은 포함하지 않고 rate limit과 스키마 검증을 적용한다. 입력은 platform, app_build, bridge_protocol이며 브라우저는 native build가 없는 별도 platform으로 취급한다.

| 응답 후보 필드 | 의미 |
| --- | --- |
| `policy_revision`, `expires_at` | 정책 버전·마지막 정상 설정 사용 기한 |
| `min_supported_build`, `latest_build` | 플랫폼별 최소/권장 앱 build |
| `update_mode`, `store_url` | none/recommended/required와 허용된 스토어 설치 주소 |
| `web_release`, `fallback_release` | 검증한 정적 웹 release ID/경로와 호환 fallback |
| `bridge_protocol`, `required_capabilities` | 해당 release가 기대하는 앱 기능 |
| `enabled_features` | 운영상 공개 가능한 기능 목록; 사용자 권한을 대신하지 않음 |

초기는 Git에서 검토한 정책 파일/ConfigMap으로 관리하고 별도 운영 어드민 화면을 만들지 않는다. 정책 변경도 staging 검증 → 새 revision 게시 순서를 따른다. 응답 ETag와 cache 정책을 정하고 실제 release가 준비되기 전에 포인터를 전환하지 않는다.

client-config 응답 실패와 사용자 인증 실패는 다르다. 마지막 정책의 유효기간이 지나면 앱 내 재시도 안내를 제공한다. 캐시된 설정으로 서버의 접근권한 회수를 무시할 수 없다. 서버 API의 권한 검사는 요청마다 유지한다.

## 4. B-19: 기기 등록·위젯·알림

현재 **Web Push** 구독 등록/목록/해제와 알림 전달 worker·전달 이력은 구현했다. `GET /v1/notifications/push-config`, `GET/POST /v1/notifications/subscriptions`, `DELETE /v1/notifications/subscriptions/{id}`, `GET /v1/reminders/{id}/deliveries`를 재사용한다. 이는 APNs/FCM용 native 설치 등록이나 위젯 API가 아니다. HTTPS 브라우저의 권한·service worker·실제 Push 전달도 연결 후 별도 확인해야 한다.

아래 표는 B-19에서 추가할 **native 기기/위젯 계약**이다. Reminder 저장, Web Push 제공자 접수, 기기 수신과 사용자 확인은 서로 다른 상태다.

| 신규 계약 후보 | 책임 |
| --- | --- |
| 기기 설치 등록/갱신/해제 | 설치 식별자·사용자 세션·platform·push token·환경·권한 상태 |
| 인증된 위젯 snapshot 조회 | 표시 대상·show_from/until·as_of·만료·다음 갱신 힌트·딥링크 ID |
| 기기용 제한 세션 발급/회수 | 위젯에 필요한 읽기 범위만 허용하고 계정 로그아웃 시 회수 |
| 전달 상태/재시도 기록 | 예약 회차·대상 기기·중복 키·제공자 접수·실제 확인을 구분 |

기기 토큰은 회전/폐기될 수 있으므로 로그인 한 번에 영구 고정하지 않는다. 동일 설치의 계정 전환 시 이전 사용자 바인딩을 원자적으로 해제한다. 테스트/운영 APNs·FCM 대상이 섞이지 않게 환경을 저장한다. 토큰 원문을 일반 로그에 남기지 않는다.

위젯 snapshot은 DB의 저장 결과를 읽고 Hermes를 깨우지 않는다. 잠금 화면에 표시할 개인정보 범위와 OS 공유 저장소 접근을 별도 제한한다. scope가 제한된 세션과 마지막 snapshot만 확장에 제공하고 전체 native refresh token을 무분별하게 복제하지 않는다.

로컬 알림과 서버 푸시를 함께 쓰면 reminder 회차/기기 키로 중복을 통제한다. 제공자 접수 성공을 사용자가 읽었다고 기록하지 않는다. 정확한 시각 보장 여부는 OS 정책과 실제 기기 검증 결과를 따른다.

## 5. 다른 후속 기능과의 관계

| 현행 구현 | 앱에서 연결할 일 | B-18/B-19와 별도인 한계 |
| --- | --- | --- |
| `POST /v1/speech/transcriptions` 원본 오디오 바이트 전사 | RN 녹음/권한·지원 MIME·취소·키보드 전환, 전사문 확인 후 별도 채팅 제출 | 전사는 채팅을 자동 실행하지 않음. 브라우저/RN 녹음과 TTS는 미구현 |
| `/v1/files`, `/v1/document-jobs` 및 기존 `/v1/documents` | 파일 선택/공유·업로드·첨부·작업 상태·다운로드·취소/재시도 UI | HWP/HWPX는 읽기/텍스트 변환만 지원. OCR·원본 HWP 편집과 레이아웃 보존 변환은 없음 |
| durable `/runs` 접수와 저장된 `/events` 재생·취소 | run ID·마지막 이벤트 ID 보관, 인증 fetch 스트림 재연결·중복 제거·백그라운드 복귀 | 앱 연결 종료는 작업 취소가 아님. worker 운영이 필요하며 즉시 실행/정시 완료를 보장하지 않음 |
| Mori DB 예약·worker prewarm 및 Pro Knative 배정 | `/v1/me/runtime` 준비/실패 상태 표시, 예약 회차 조회·취소와 결과 상세 연결 | Route ready는 Pod 상시 실행이 아님. 실제 k3s·GPU·앱 종료 인수는 별도 |
| Toss 웹 자동결제와 유효 Pro 권한 | 웹 SDK·callback·주문 상태 확인·기간 말 해지/재개 | StoreKit/Google Play 구매 검증은 별도 개발. 202를 과금 완료로 표시하지 않음 |
| Web Push 구독·전달 worker·service worker 계약 예시 | HTTPS 권한 요청·구독 등록/해제·딥링크 및 실제 브라우저 전달 | APNs/FCM 등록·OS 위젯·native 로컬 알림과 동일 기능으로 취급하지 않음 |

현행 채팅 접수는 UUID `Idempotency-Key`로 중복을 막고 `202`에 `run_id/status_url/events_url`을 반환한다. SSE 관찰은 기본 25초에 종료할 수 있으며 `Last-Event-ID` 또는 `after`로 같은 실행을 이어 읽는다. 관찰 종료를 실패로 표시하거나 새 POST로 작업을 중복 생성하지 않는다. 자세한 계약은 [고정 채팅 문서](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/chat.md)를 따른다.

무료 계정은 공용 gateway에서 사용자별 자식 프로세스·HOME을 분리하고, Pro는 개인 Knative Service/PVC를 사용한다. 클라이언트가 user_id나 runtime URL을 선택하지 않는다. 공용 프로필과 Pro PVC 사이의 자동 메모리 이사는 미구현이다. 예약 원장은 Mori DB/worker이며 Hermes cron을 앱에서 중복 등록하지 않는다.

## 6. 인수 기준

B-18은 iOS/Android/브라우저에서 소셜 로그인 취소·만료·성공·갱신·logout을 검증한다. 다른 계정·다른 세션·만료 교환권·재사용·외부 origin은 실패해야 한다. 웹 쿠키 경로의 CSRF, native Bearer 경로의 소유권, SSE 프록시의 지연/종료도 확인한다.

client-config는 구/신 앱 조합, 지원하지 않는 protocol, 없는 release, 만료 정책, 스토어 미출시 상태의 잘못된 강제 업데이트를 검증한다. B-19는 앱 종료·계정 전환·기기 token 회전·권한 거부·snapshot 만료·중복 전달을 실기기에서 확인한다.

구현 시 관련 요청/응답을 OpenAPI에 추가해 Swagger/Scalar와 생성 클라이언트를 함께 갱신한다. 이번 문서 작업에서는 API 서비스 버전이나 migration 번호를 올리지 않는다. backend 726개·Hermes 91개/1개 skip/43 subtest 통과는 2026-11-03 master 커밋 전 검증 결과이며, 새 모바일 세션·native Push·위젯의 구현/실기기 검증 증거가 아니다.

## 7. 착수 순서

1. B-18 웹 세션과 WebView 교환 방식·정확한 origin/CSRF·로그아웃 연계를 먼저 구현한다. 현재 JSON Bearer 로그인 계약은 보존한다.
2. React/RN의 첫 화면 동선을 기존 주차·대시보드·durable 채팅 API에 연결한다. 제품 프론트를 만들며 PoC를 운영 API용으로 바꾸지 않는다.
3. client-config의 앱/웹 release 호환 정책과 네이티브 브리지 capability 협상을 실제 배포 구조에 맞춰 구현한다. `/v1/capabilities`의 worker/제공자 준비 상태를 client-config로 오인하지 않는다.
4. B-19 APNs/FCM·위젯 snapshot/제한 세션과 앱 계정 전환을 구현하고 실제 iOS/Android에서 검증한다.
5. 스토어 결제를 사용할 경우 구매 검증·복원·갱신/취소 통지를 별도로 연결하고 웹 구독·관리자 승인과 같은 유효 이용권 판정으로 합친다.


## 7. 프론트 상세 계획과 확정할 계약

2026-11-04의 [릴리스 실행서](../architecture/release-playbook-2026-11-04.md)는 client-config 응답에 `schema_version`, `api_contract`, `api_contract_revision` 등을 제안하고, app build/web release/bridge 호환과 실패 상태를 세분화했다. 이 문서의 기존 후보와 함께 B-18 구현 때 하나의 스키마로 확정한다. 현재 0.9 OpenAPI에 해당 경로·필드가 이미 존재하는 것으로 사용하지 않는다.

[58개 프론트 작업](../front/poc-to-react-work-breakdown-2026-11-04.md)의 FE-04 세션·FE-12 기기 작업이 해당 서버 계약의 소비자다. [typed API 기준](../front/frontend-engineering-guide-2026-11-04.md)에 따라 기존 도메인 DTO는 현재 OpenAPI에서 생성하고, 후보 client-config/bridge는 구현 전에 별도 버전 스키마와 실패 fixture를 만든다. 프론트 담당은 사용자가, 요청된 서버 계약 보완·검토는 AI가 맡는다.
