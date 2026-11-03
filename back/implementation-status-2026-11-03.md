# 백엔드 0.9 구현 현황과 남은 작업

기준일: **2026-11-03** · 구현: **master 6285aba** · 비교 화면: **poc 8fa4fe4** · API: **0.9.0** · DB head: **0017_news_refresh_deadline**

이 문서는 master에 반영한 기능을 plan의 다음 작업과 연결한다. 완료 범위는 코드·로컬 검증이며, 제품 프론트 연결이나 운영 환경 검증과 구분한다. PoC는 계속 독립적인 화면/동작 기준으로 유지한다.

## 1. 확인한 기준과 증거

| 기준 | 확인한 내용 |
| --- | --- |
| 구현 커밋 | `296c49b`부터 `6285aba`까지 기능별 16개 커밋, master에 push 완료 |
| API 명세 | [고정 OpenAPI 0.9.0](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/openapi.json), 서로 다른 경로 85개 |
| 화면 대응 | [PoC 화면별 대조표](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/poc-parity-map-0.9.md) |
| 기능·배포 계약 | [백엔드 0.9 문서](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/poc-backend-0.9.md) |
| 리뷰와 재현 근거 | [독립 코드 리뷰·회귀 기록](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/poc-coverage-review-0.9.md) |
| 클라이언트 후속 | [B-18/B-19 계약](mobile-client-contracts.md), [프론트 실행 계획](../front/implementation-roadmap-2026-10-06.md) |

`screen-api-implementation-2026-09-30.md` 등의 0.7 문서는 당시 기록이다. 현재 기능이 미구현인지 판단할 때 오래된 본문의 상태·마이그레이션 번호를 사용하지 않는다. master README 일부의 과거 관리자 Pro 설명보다 현재 결제·권한 서비스와 0.9 계약을 우선한다.

## 2. 이번에 완료한 개발

### 인증·계정·유효 이용권

네이버·카카오 로그인, Mori 일회용 교환 코드, 액세스/갱신 토큰 회전과 세션 폐기를 유지한다. 사용자는 인증 문맥에서 정하며 요청 body의 사용자 ID로 전환하지 않는다. 비정상 제공자 JSON/문자 인코딩은 로그인 실패 흐름으로 처리하고 잘못된 갱신 토큰이 기존 세션을 훼손하지 않게 했다.

`GET/PATCH /v1/me`는 사용자 정보와 이름, `GET/PUT /v1/me/settings`는 테마를 담당한다. `/v1/plans`와 `/v1/me/subscription`은 무료/Pro 안내, 설정한 가격·결제 가능 상태와 유효 구독 정보를 반환한다. Pro 권한은 **관리자 승인 또는 유효 유료 구독**으로 계산한다. worker가 중단돼도 요청 시 유효 기간을 검사하고, 관리자 승인과 결제 이용권을 서로 덮어쓰지 않는다.

### 결제와 구독 상태

Toss 웹 자동결제의 체크아웃, 결제수단 등록 완료 접수, 영속 주문, 정기 갱신, 주문 재조회, 기간 말 해지와 해지 철회를 구현했다. 금액·고객 키·주문 ID는 서버가 결정한다. 빌링키와 일회용 인증 키는 암호화해 보관한다. 웹훅은 알려진 주문의 재조회 요청으로만 사용하고 제공자 재확인 결과로 권한을 변경한다.

통신 결과가 불확실하면 새 주문으로 재과금하지 않고 원래 주문을 재조회한다. 미확정 상태가 반복되면 `review`로 남겨 운영 확인이 가능하다. 과거 주문의 환불이 새 구독의 상태·갱신 중단 설정을 바꾸지 않으며 현재 결제의 실제 취소는 이용권에 반영한다. 해지는 즉시 환불이 아니고, 이미 종료된 구독을 해지 철회로 되살리지 않는다.

지원 경로는 `/v1/billing/checkouts`, `/checkouts/{id}/complete`, `/orders`, `/orders/{id}`, `/orders/{id}/reconcile`, `/subscription/cancel`, `/subscription/resume`, `/webhooks/toss`다. 상세는 [결제·시세 계약](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/billing-market.md)을 따른다.

### 사용자별 실행 환경

무료 계정은 공용 Hermes gateway에서 사용자별 자식 프로세스·HOME·내부 키를 분리한다. 동일 Unix UID 안의 논리적 분리이며 검색 도구만 허용하고 임의 코드 실행 sandbox로 사용하지 않는다. 제품 파일 처리는 Mori 문서 worker에 맡긴다. 서버가 인증된 사용자 ID를 전달하며 클라이언트는 runtime URL을 지정하지 않는다. `MORI_HERMES_TEST_USER_ID` 단일 테스트 경로는 호환용으로 남겨 둔다.

Pro는 사용자별 Knative Service·Secret·PVC를 자동 배정하는 provisioner를 사용한다. DB lease와 generation으로 중복 처리·늦은 응답을 통제하고 권한 만료/회수·재승인 상태를 재조정한다. `/v1/me/runtime`과 `/retry`는 상태 확인·재시도를 제공한다. `ready`는 Route 준비이며 Pod가 항상 실행 중이라는 뜻은 아니다. 공용 프로필에서 개인 PVC로 자동 메모리 이사는 없고, 개인 환경 회수 시 PVC를 보존한다.

### 지속 채팅·기능 선택·이벤트

`POST /v1/conversations/{id}/runs`가 실행을 DB에 접수하고 `202`와 `run_id/status_url/events_url`을 반환한다. worker가 실제 모델·도구 작업을 수행한다. 이벤트와 최종 상태를 저장하므로 SSE 연결이 종료되거나 앱이 다시 열려도 같은 run을 조회할 수 있다. 이벤트 ID와 `Last-Event-ID`/`after`로 재생 위치를 정한다. 관찰 연결은 기본 25초 후 끝날 수 있으며 관찰 종료는 작업 취소가 아니다.

명시적 취소, worker lease 만료 후 복구, 재시도, 중복 접수와 결과 게시 전 상태/권한/버전 재검사를 구현했다. 표시 이벤트는 실제 도구 호출·저장 진행 상태이며 내부 추론은 공개하지 않는다. 대화 목록에는 `last_message/last_activity_at`을 제공해 제목 수정과 메시지 날짜를 구분한다.

일반 대화는 주차·메모·일정·알림·기능 생성/조회/실행·뉴스 설정/수집·주가 설정/조회·문서 작업을 제안한다. 선택된 사용자 기능은 고정 버전과 `allowed_actions` 안에서만 실행한다. 기본 권한은 `reply`이며 모델이 기능을 만들면서 스스로 쓰기 권한을 추가하지 못한다. 서로 다른 저장 동작 2~4개 batch는 원자적으로 저장한다.

`feature_lookup`은 실제 문맥에 보낸 최대 50개 기능 ID 안에서 현재 소유권·상태를 확인하고 상세 참조만 반환한다. 중지/초안 기능을 자동 재개하거나 실행하지 않는다. 채팅에서 동명 사용자 기능 생성을 요청하면 기존 정의를 재사용해 안내하며 권한·예약을 덮어쓰지 않는다. 자세한 접수·재접속은 [채팅 계약](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/chat.md)을 따른다.

### Mori 소유 예약과 사전 기동

예약 원장은 Mori DB다. `Feature.schedule`, `AutomationScheduleState`, `AutomationJob`에 규칙·회차·다음 시각·실행 상태를 보관한다. Hermes cron에 같은 예약을 등록하지 않는다. 단발/매일/평일과 IANA 시간대를 지원하며 Hermes가 필요한 활성 사용자 기능과 AI 요약 뉴스에 한해 기본 120초 전부터 인증된 toolsets 요청으로 배정 환경을 깨운다. 주가 수집·단순 표시·Web Push는 매번 agent를 기동하는 대상이 아니다.

실행 회차의 실패·재시도·취소·lease 회수와 오래된 결과 게시 차단을 구현했다. 지연 실행은 복구 시각 대신 원래 `scheduled_at`과 실행 시간대를 사용한다. 오늘 메모 정리도 원래 회차 날짜의 마지막 내용 저장 시각으로 조회한다. 시간대 변환이 표현 범위를 벗어나면 저장 전 거부하고 기존 불량 revision은 다른 예약의 실행을 막지 않도록 격리한다.

`GET /v1/automation/jobs`와 `/{id}`에서 회차를 조회하고 `POST /{id}/cancel`로 한 회차를 취소한다. 반복 기능 전체의 중지/재개는 `/v1/features/{id}/state`다. prewarm 요청만으로 정시 완료나 외부 부수 효과의 정확히 한 번 처리를 보장하지 않는다.

### 파일·문서 작업과 명시적 채팅 첨부

기존 텍스트 `/v1/documents`를 유지하고 바이너리 `/v1/files`와 비동기 `/v1/document-jobs`를 추가했다. 파일 원본 바이트 업로드, 소유권, 목록/다운로드, 휴지통/복원, 기본 파일 10 MB·사용자 합계 100 MB·휴지통 30일을 처리한다. 삭제 파일도 보관 중 용량에 포함하며 파기 후 복원은 불가능하다.

문서 작업은 접수·읽기·생성·편집·변환·취소·새 작업으로 재시도할 수 있다. 결과는 원본을 덮어쓰지 않는 새 파일이다. 제한된 subprocess에서 시간·메모리·ZIP 확장량·출력량을 제한한다. JSON 옵션의 200,000 UTF-8 바이트 한도, 중첩 NUL/비유한수·직렬화 한계는 저장 전에 검증한다. DOCX의 본문 순서·중첩 표·콘텐츠 컨트롤·캐시된 표시 필드·병합 셀을 보완하고 원본 및 편집 문단 번호를 유지했다.

| 형식 | 구현 범위 | 명시적 한계 |
| --- | --- | --- |
| TXT/MD/CSV | 읽기·생성·텍스트 편집 | 일반 텍스트 처리 |
| DOCX | 읽기·생성·문단 교체/추가·중첩 표 텍스트 | 교체 문단의 inline 서식 손실 가능, 표 중첩 64단계 |
| XLSX | 읽기·생성·셀 편집 | 수식 재계산·매크로 실행 없음 |
| PDF | 텍스트 읽기·생성·페이지 선택/회전 | OCR·문서 본문 레이아웃 편집 없음 |
| HWP/HWPX | 텍스트 읽기와 추출 텍스트 변환 | 원본 HWP 편집/생성 없음; 정상 원본 전체 추출 검증 별도 |
| 변환 | 추출 텍스트를 TXT/MD/DOCX/PDF로 재구성 | 원래 페이지·도형·표 배치 보존 변환이 아님 |

채팅은 `attachments=[{kind:file|document,id:UUID}]`로 본인 자료를 최대 3개 명시한다. 문서 선택 UI는 클라이언트가 만든다. 접수와 최종 결과 게시 단계에서 첨부 소유권·상태를 다시 확인하며, 모델이 임의 경로나 다른 사용자의 파일 ID를 선택하게 하지 않는다. `action.queued`는 문서 작업 등록일 뿐 파일 완성이 아니다.

### 뉴스·주가·음성·Web Push

뉴스는 주제·예약 저장, 수동/예약 수집, 기사 링크·발췌, 선택적 AI 검색 발췌 요약을 지원한다. 같은 주제의 재수집 실패는 마지막 성공 기사/요약·기준 시각을 보존하고 stale 상태를 표시한다. 주제 변경 후 이전 결과를 새 주제의 결과로 표시하지 않는다. 수동 수집의 180초 기한이 지나면 본인 조회에서 중단 상태로 복구하고 늦은 결과를 게시하지 않는다.

KIS 국내 주식의 `range=day`는 당일 완료된 1분봉이다. 현재 수집 구간은 한국 시간 09:00–15:30이며 진행 중인 분을 제외한다. 빈 세션은 빈 봉과 `as_of=null/empty_reason`을 반환한다. 국내 주/월·지수·해외 차트와 quote/예약 snapshot은 완료된 거래일 일봉·종가다. 실시간 체결이나 모든 시장의 분봉으로 표시하지 않는다. snapshot은 더 오래된 시각의 늦은 응답으로 덮어쓰지 않지만 개별 회차 결과는 그 작업의 실제 응답을 보존한다.

음성 전사 `/v1/speech/transcriptions`는 원본 오디오를 받아 텍스트를 반환하고 채팅을 자동 제출하지 않는다. 브라우저/RN 녹음·권한·음성 상호작용·TTS는 클라이언트 개발이다. Web Push는 공개 VAPID 설정·구독 등록/목록/해제·알림 전달 기록·worker와 service worker 계약 예시를 제공한다. APNs/FCM 설치 등록이나 위젯 API는 아니다.

### 대시보드·도메인 기록

`/v1/dashboard?hours=0|3|5|24`는 서버 시각·시간대·표시 구간·그룹·다음 갱신 시각과 최근 기록 최대 5개를 반환한다. `/v1/library`가 검색·분류·페이지·전체 건수·상세 주소·아이콘·파일 크기·체크 개수를 제공한다. 메모 복원으로 마지막 내용 저장 시각을 바꾸지 않고, 알림은 `started_at`을 저장해 재접속 후 진행률을 복원한다.

주차 저장/조회 결과는 공통 `parking` 참조를 사용한다. 예약 뉴스와 주가 완료 대화는 각각 브리핑/stock 상세 참조를 남기며, 주가 회차 결과와 현재 snapshot을 구분한다. 카드 이동은 추측한 액션 이름보다 `kind/detail_url`을 사용한다. PoC의 시간 없는 주차 `always` 예시는 서버의 `manual`로 연결하며 서버의 명시적 `always`는 새 위치 저장 전까지 표시하는 별도 모드다.

## 3. DB·프로세스·설정 준비 상태

| migration | 반영 범위 |
| --- | --- |
| 0008_poc_completion | 예약·외부 정보·Web Push 기본 완료 구조 |
| 0009_runtime_provisioning | 사용자별 개인 런타임 배정 상태 |
| 0010_durable_chat | 지속 채팅 실행 lease/작업 |
| 0011_billing | 주문·구독·암호화 결제키·이용권 |
| 0012_operations_artifacts | worker 상태·prewarm·업로드 파일·문서 작업 |
| 0013_news_summary | 검색 발췌 요약 결과 |
| 0014_feature_actions | 명시적인 기능 실행 권한 |
| 0015_chat_attachments | 채팅 첨부 자료 참조 |
| 0016_reminder_started_at | 재시작 가능한 알림 시작 시각 |
| 0017_news_refresh_deadline | 중단된 수동 뉴스 수집 복구 기한 |

API가 테이블을 자동 생성하지 않는다. 새 버전 실행 전 migration을 적용하고 DB·API·worker 버전을 맞춘다. API와 별도로 `mori worker`, 개인 런타임 provisioner, 공용 gateway가 필요하다. 채팅은 `MORI_CHAT_ENABLED`와 `MORI_CHAT_WORKER_ENABLED`를 함께 켜며 예약·Push·문서·결제는 각 기능 플래그로 활성화한다. `/v1/capabilities`와 `mori worker-health`가 설정 유무와 실제 heartbeat를 구분한다.

서버 Secret에는 인증·제공자 키와 런타임/결제 암호화 키를 저장한다. 예제 `.env`/YAML은 실자격 증명이 아니다. API는 클러스터 토큰을 마운트하지 않고 provisioner에만 필요한 권한을 부여한다. 이미지·manifest 코드 제공이 실제 Harbor 게시·k3s 적용을 뜻하지 않는다.

## 4. 최종 검증 결과와 한계

2026-11-03 master 커밋 전 최종 전체 재실행 결과는 다음과 같다. 이번 plan 문서 작업에서 같은 검사를 반복한 것은 아니다.

| 검사 | 결과 | 해석 |
| --- | --- | --- |
| Backend 전체 | **726개 통과**, 기존 deprecation 경고 2건 | 임시 실제 PostgreSQL·API·worker, migration 왕복·모델 차이 검사 포함 |
| Hermes 전체 | **91개 통과·1개 skip·43 subtest 통과** | gateway 실제 자식 프로세스 및 문서 worker 검사 포함 |
| Hermes skip | 로컬 Trafilatura 미설치 본문 추출 검사 1개 | 본문 추출 운영 인수로 대체할 수 없음 |
| 정적/계약 | Ruff·포맷·OpenAPI·uv.lock 오프라인 일치·diff 통과 | 생성 명세와 소스·고정 의존성 일치 |
| 독립 리뷰 | 최종 서브 에이전트 3명과 root 범위에서 새 확정 결함 없음 | 모든 환경의 무결함 보장이 아님 |

외부 제공자의 HTTP는 제어된 응답으로 검증했다. 실제 돈·제공자 계정·GPU 모델·Kubernetes 클러스터를 호출한 통합 시험은 포함하지 않았다. 정상 HWP/HWPX 원본 전체, Linux 이미지 자원 제한/한글 글꼴, 실제 브라우저 Push·RN 녹음은 별도다. 이번 누적 변경으로 새 이미지를 빌드·push·배포한 것은 아니므로 기존 0.1.0 이미지가 새 gateway/문서 처리 코드를 포함한다고 가정하지 않는다.

## 5. 앞으로 남은 개발과 인수 작업

### 다음 개발: 제품 웹/앱 연결 기반

| 우선순위 | 실제 남은 작업 | 완료 증거 |
| --- | --- | --- |
| 1 | React 공통 UI·라우팅·타입/조회 계층을 만들고 현재 OpenAPI 계약에 연결 | 첫 제품 화면이 실제 API의 loading/empty/error/success 상태를 표시 |
| 1 | B-18 웹 세션·WebView 일회용 교환·로그아웃 연계 | HttpOnly/CSRF/Origin·만료/재사용·다른 계정 거부와 iOS/Android 복귀 검사 |
| 1 | 로그인 → 주차 저장 → 대시보드 재조회 → durable 채팅 | 네트워크 재접속 후 같은 run/event·중복 저장 없음·실제 결과 상세 이동 |
| 2 | 일정·메모·파일/문서·기능·뉴스/주가·마이 연결 | revision 충돌·취소/재시도·다운로드·stale/가격 시점·구독 상태가 서버와 일치 |
| 2 | client-config·웹 release/앱 build/브리지 호환 정책 | 지원하지 않는 build/protocol·없는 release·fallback·강제 업데이트 검증 |
| 3 | APNs/FCM·기기 설치 수명·위젯 snapshot/제한 세션 | 로그아웃/계정 전환·token 회전·앱 종료·권한 거부·snapshot 만료의 실기기 인수 |
| 출시 전 결정 | StoreKit/Google Play 구매·복원·서버 검증 | 스토어별 갱신/취소·권한 회수·웹/관리자 이용권과 공존 확인 |

B-18/B-19는 [모바일 계약](mobile-client-contracts.md)의 설계이며 현재 85개 OpenAPI 경로에 포함되지 않는다. 브라우저 Web Push를 native Push 완료로 표시하거나 `/v1/capabilities`를 release용 client-config로 사용하지 않는다.

### 병행 작업: 배포와 외부 환경 인수

1. 변경한 backend/Hermes 이미지를 새 버전·digest로 빌드/게시한다. Linux 문서 worker와 글꼴·본문 추출 의존성을 확인한다.
2. 검증 환경 DB에 0017까지 적용하고 API·worker·gateway·provisioner의 설정/권한·heartbeat를 확인한다.
3. 무료 두 사용자 동시/순차 호출, Pro 배정·cold start·scale-to-zero·재기동·권한 만료/회수·재승인을 실제 k3s에서 검사한다. PVC·CNI·RBAC와 메모리 보존을 확인한다.
4. 실제 모델이 기능 선택·뉴스/주가·문서 action 계약을 지키는지, 허용되지 않은 쓰기를 거부하고 저장 성공 후에만 완료 답변을 내는지 확인한다.
5. 소셜 두 제공자, SearXNG/요약, Toss 테스트 상점/웹훅, KIS 현재 세션/휴장/호출 한도, 전사와 HTTPS Web Push를 각각 연결한다.
6. 예약 직전 기동·worker/API 중단·앱 연결 종료·재시도·취소·결과 게시·문서 다운로드까지 실제 사용자 동선을 확인한다.
7. DB/암호화 키 복구, 저장 용량·제공자 한도·동시 실행·지연 목표, 불확실한 결제 주문 확인, 모니터링·배포/롤백 절차를 정한다.

### 별도 범위로 남겨 둔 제품 확장

반복 개인 일정/예외·외부 캘린더, 자동 습관 학습, 일반 자연어 기존 기록 수정/삭제, 인터넷 아이콘 자산 영구 보관, Hermes 로컬 스킬 파일 자동 동기화, 공용/개인 메모리 이사, 특수 주식 장시간·시간 외/NXT·실시간 체결, 기사 원문 전체 요약, OCR·수식 재계산·HWP 원본 편집은 현재 완료 범위가 아니다. 이들은 PoC 대응 코드의 누락과 분리해 우선순위·사용 조건·비용·인수 기준을 정한다.

## 6. 상태 변경 규칙

기능이 코드에 있으면 ‘서버 구현’, 검사 증거가 있으면 ‘로컬 검증’, 제품 화면이 실제 계약을 쓰면 ‘프론트 연결’, 실제 제공자·기기·클러스터 시나리오가 통과하면 ‘운영 인수’로 갱신한다. 새로운 검사 수나 운영 성공은 실행 근거 없이 늘리지 않는다. 서버 경로·필드를 바꾸면 OpenAPI와 이 계획을 함께 갱신하고, 오래된 구현 기록은 날짜가 있는 이력으로 보존한다.
