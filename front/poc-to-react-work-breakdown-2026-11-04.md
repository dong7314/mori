# 최신 PoC에서 제품 React로 옮기는 작업 분해

기준일: **2026-11-04** · 화면: `poc` **8fa4fe4** · 서버: `master` **6285aba / API 0.9.0** · 상태: 제품 프론트 구현 전

[프론트 계획](plan.md) · [구현·라이브러리 기준](frontend-engineering-guide-2026-11-04.md) · [01~12 실행 순서](implementation-roadmap-2026-10-06.md) · [웹/RN 경계](react-native-webview-plan.md) · [서버 완료/잔여 작업](../back/implementation-status-2026-11-03.md)

## 1. 이 문서를 사용하는 방법

프론트·앱·위젯은 사용자가 개발하고 AI는 요청받은 구현·검토와 서버 계약 보완을 지원한다. 아래 한 행은 작은 구현/리뷰 단위다. 같은 행의 화면·컴포넌트·상태·API와 인수 사례를 함께 다룬다. 단계별로 결과를 확인한 뒤 다음 단위로 진행하며 제품 전체를 한 번에 이식하지 않는다.

`FE-06-03`은 기존 실행 계획 06의 세 번째 작업이다. 완료 체크는 소스·검사·화면 증거가 있을 때만 바꾼다. **현재 모든 FE 작업은 대기**다. PoC에 화면이 있거나 서버 API가 구현됐다는 사실을 제품 React 화면의 완료로 세지 않는다.

제안 경로는 `frontend/apps/web/src/{app,shared,features}`와 `frontend/packages/{api-client,bridge,design-tokens}`다. 아래 컴포넌트 이름과 경로는 구현 시 만들 대상이며 현재 저장소에 존재하는 제품 코드가 아니다. 모노레포 전체를 먼저 추상화하기보다 각 작업에 필요한 경계부터 만든다.

## 2. 최신 화면 근거와 이전 문서의 차이

직접 확인한 근거는 `src/app-experience.js`와 관련 모듈·검사다. PoC README 일부에는 오래된 ‘오늘의 약속·최근 대화’ 설명이 남아 있으므로 화면 작업은 아래 고정 소스를 우선한다. 이번에는 소스 대조와 ego-browser의 격리된 mobile preview에서 대시보드·기능 목록/생성·반복 option·일정/폼·마이의 읽기/탐색을 확인했다. 실제 계정으로 저장하거나 제공자 API를 시험하지 않았으며 실기기 UI 인수 완료 보고가 아니다.

| 현재 화면/동작 | 확인한 소스 | 제품에서 보존할 의미 |
| --- | --- | --- |
| 시간 선택과 시간대 카드 | [app-experience.js 264~285](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L264) | 지금·3·5·24시간, 현재와 예정 구분, 선택 체크, 시간대별 가로 탐색 |
| 대시보드 하단 | [287~300](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L287) | 최근 기록 최대 5개·전체 보기·둘러보기/기능 만들기. 약속/대화 중복 섹션과 상단 빠른 추가 줄 없음 |
| 보관함·목록 행 | [145~178](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L145) | 분류·본문 검색·파일 크기·새 메모/파일 가져오기, 행 높이·말줄임 |
| 대화 목록·이름·고정 | [302~315](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L302) | 날짜 그룹·본문/제목 검색·초안·이어가기; PoC에 대화 삭제 버튼은 없음 |
| 일정 월·주·일과 날짜 이동 | [317~369](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L317) | 선택 날짜·기간 이동·오늘·진행/다음 일정·시간대 추가 |
| 기본 6종·내 기능 | [371~385](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L371) | 모든/기본/내 기능 필터, 상태·실행 시간·버전/최근 결과 |
| 마이 | [448~458](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L448) | 계정·정보 수정·테마·요금제와 로그아웃. PoC 조정 옵션을 되살리지 않음 |
| 주차·메모·일정 입력 | [772~817](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L772) | 폼·선택/다이얼·미리보기·겹침 안내·저장 피드백 |
| 사용자 기능 입력 | [818~879](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L818) | 18개 아이콘/3그룹, 반복 옵션, 시간 해제, 참고 내용 펼침·글자 수, 실시간 카드 미리보기 |
| 기본/사용자 기능 상세 | [883~906](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L883) | 주차 지도·뉴스 출처·캔들·메모·일정·알림·결과 체크의 고유 화면 |
| 채팅과 음성 | [944~1165](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L944) | 대화 탭의 페이지 진입과 하단 입력의 위쪽 확장, 초안/스크롤·같은 대화 유지 |
| 문서·프로필·요금제 | [1176~1282](https://github.com/dong7314/mori/blob/8fa4fe4/src/app-experience.js#L1176) | 원문/목록 분리·다운로드·복원, 정보 조회/수정·테마와 비활성 결제 체험 |
| 날짜·시간·기간 선택 | [form-picker.mjs](https://github.com/dong7314/mori/blob/8fa4fe4/src/form-picker.mjs), [choice-field.mjs](https://github.com/dong7314/mori/blob/8fa4fe4/src/choice-field.mjs) | 너비·선택 값·취소/완료, 키보드·확대 시 선택 행 중심 보정 |
| 상세/패널의 수명 | [sheet-layout.mjs](https://github.com/dong7314/mori/blob/8fa4fe4/src/sheet-layout.mjs), [presentation.mjs](https://github.com/dong7314/mori/blob/8fa4fe4/src/presentation.mjs), [screen-history.mjs](https://github.com/dong7314/mori/blob/8fa4fe4/src/screen-history.mjs) | 화면 목적에 따른 페이지/시트, 단일 뒤로가기, 진입/복귀와 시스템 변화 시 종료 정리 |

PoC의 브라우저 음성·가짜 AI 지연/답변·열린 앱의 로컬 예약 실행·예시 기사/주가·IndexedDB 문서를 제품 서버 기능으로 그대로 복사하지 않는다. 재사용 대상은 시각 자산·순수 계산의 회귀 사례·상호작용 기준이다.

## 3. 상태를 어디에 둘 것인가

| 상태 종류 | 소유 위치 | 예시·수명 |
| --- | --- | --- |
| 서버 데이터 `Q` | API/query 계층 | 계정·리소스·목록·실행·작업. 서버가 원장이고 사용자별 캐시를 분리 |
| 탐색 `R` | 단일 웹 화면 스택/URL | 활성 탭·상세 ID·진입 방식·뒤로가기. RN은 동일 back을 중복 처리하지 않음 |
| 입력 `F` | 폼·초안 계층 | 아직 저장하지 않은 값·검증·수정 여부·기존 revision. 서버 객체를 직접 변경하지 않음 |
| UI `U` | 해당 화면/공통 UI | 열린 선택창·선택 시간 범위·달력 모드·스크롤·모션 진행. 도메인 저장과 구분 |
| 실행 관찰 `E` | 채팅/run 계층 | run ID·마지막 event ID·관찰 연결·중복 제거. 패널 unmount가 서버 run 취소를 뜻하지 않음 |
| 기기/브리지 `B` | RN·bridge adapter | capability·권한·녹음·파일 핸들·현재 page 세대. 타임아웃/취소/늦은 응답 정리 |

날짜/기간 필터 중 링크로 공유·복구할 값은 R과 query key로, 잠깐 열린 선택창은 U로 둔다. 같은 서버 자료를 전역 UI store에 또 복사하지 않는다. 권한과 무료/Pro 판정은 Q의 서버 응답을 사용한다. 라이브러리 이름이 달라도 이 책임 분리는 유지한다.

### 먼저 만들 공통 UI 계약

| 컴포넌트/모듈 | 책임 | 제품 인수 조건 |
| --- | --- | --- |
| `AppFrame`, `TabNavigation`, `PageHeader` | 5탭·안전 영역·스크롤·현재 위치 | 웹/RN에서 하단 가림·두 번 뒤로가기·중복 inset 없음 |
| `NavigationPage`, `PresentationHost` | 지속 읽기/편집은 페이지, 짧은 선택은 시트 | 모든 폼을 비슷한 dialog로 덮지 않고 화면 수명/복귀를 일관되게 처리 |
| `ChoiceSheet`, `DatePickerSheet`, `TimeWheel`, `DurationPicker` | 선택값 초안과 확정/취소 | 앱 너비 안에서 충분히 넓고 취소는 원래 값, 완료만 폼 반영; 불필요한 상단 ‘시/분’ 표시는 생략해도 접근성 이름 유지 |
| `Field`, `TextArea`, `FormActions`, `InlineError` | label·help·오류·저장 중·중복 제출 | 오류 값 보존·첫 오류 이동·버튼 높이 통일, IME 입력 중 강제 제출 금지 |
| `RecordRow`, `ConversationRow`, `SettingRow` | 유형별 공통 행 | 제목/미리보기 한 줄 말줄임과 정해진 기본 높이; 큰 글자에서는 접근성을 위해 필요한 높이 증가 허용 |
| `TimeCard`, `FeatureCard`, `CardDetailHero` | 실제 기능의 축소 시각화와 상세 연결 | 카드 SVG·제목·상태가 전환 중 갑자기 다른 내용으로 바뀌지 않음 |
| `ChatComposer`, `ChatPanel`, `VoicePanel` | 입력 한 곳·대화/초안 유지·음성 확장 | 입력창 기준 위치 유지, 패널만 펼쳐지고 body scrollbar·레이아웃 밀림 없음 |
| `ResourceLink`, `RunProgress`, `JobStatus` | 실제 이벤트·저장 결과/작업 상태 | 모델 추론 원문·가짜 ‘스킬 발견’ 문구 대신 근거 있는 단계만 표시 |
| `EmptyState`, `LoadingState`, `ErrorState`, `UndoToast` | 빈값/처리/실패/복원 | 빈 목록과 오류를 혼동하지 않고 undo는 서버 복원 결과로 확정 |
| `MotionCoordinator` | 진입·이탈·중첩·resize·취소 정리 | 200% 글자·회전·모션 감소·백그라운드에도 투명층/막힌 클릭/무한 애니메이션 없음 |

## 4. 단계 01~03 — 공통 기반과 앱 경계

| ID | 작은 작업·제안 파일 | 상태/의존 | 완료 증거 |
| --- | --- | --- | --- |
| FE-01-01 | `app/` workspace·실행/빌드·타입 검사·lint | 기반 | lockfile·웹 실행·production 빌드, `any`로 API 경계를 덮지 않음 |
| FE-01-02 | `design-tokens/` 색·서체·간격·모서리·모션·다크 | U, 01-01 | PoC 토큰 대응표와 라이트/다크·큰 글자 샘플 |
| FE-01-03 | `AppFrame`·5탭·page route·scroll 복원 | R/U, 01-02 | 탭 전환→상세→뒤로가기→원래 스크롤, 새로고침된 잘못된 ID 처리 |
| FE-01-04 | 공통 field·button·row·choice/picker·error | F/U, 01-02 | 옵션/시간/날짜를 키보드·터치로 선택/취소/완료, 320px/200% 글자 |
| FE-01-05 | fixture/transport·query key·사용자 캐시 경계 | Q, 01-01 | 개발 fixture가 실제 계정과 섞이지 않음, 계정 변경 때 이전 캐시 제거 |
| FE-01-06 | `PresentationHost`·card morph·reduced motion | R/U, 01-03/04 | 페이지/짧은 선택/카드 상세별 진입·복귀와 중간 취소 인수 |
| FE-02-01 | 대시보드 header·현재/예정·상태 fixture | Q/U, 01 | 0/1/여러 카드·긴 제목·빈 기록에서 정보 우선순위 일치 |
| FE-02-02 | 시간 범위·시각/개수 요약·시간대 rail | R/U, 02-01 | 0/3/5/24 변경·체크·좌우 버튼 상태·수동 스크롤, 시각/개수 한 줄 |
| FE-02-03 | 최근5개·전체보기·하단 utility 진입 | Q/R, 02-01 | 분류는 전체 목록에만, 대시보드 중복 약속/대화 섹션 없음 |
| FE-02-04 | 기본 기능별 카드 SVG와 상세 hero | U, 01-06/02-01 | 지도/신문/캔들/일정/알림/기능 시각을 실제 상태와 연결, 실사 asset 추가 강제 없음 |
| FE-03-01 | `apps/mobile` 기본 RN/WebView와 handshake | B, 01/02 | iOS/Android에서 같은 웹과 지원 capability 확인 |
| FE-03-02 | native back·외부링크·safe area·키보드 | R/B, 03-01 | 단일 탐색 주체, 신뢰 페이지와 외부 페이지 분리, 입력창 가림 없음 |
| FE-03-03 | 앱 시작/오프라인·resume·page 세대 정리 | B, 03-01 | 웹 load 실패 재시도·재로드 후 이전 bridge 응답 미반영 |

## 5. 단계 04~06 — 첫 실제 사용자 흐름

| ID | 작은 작업·제안 파일 | 상태/의존 | 완료 증거 |
| --- | --- | --- | --- |
| FE-04-01 | `features/auth` 공급자/로그인 시작·callback | Q/R, B-18 | 실제 소셜 계정 왕복·취소/만료·원래 복귀 위치 |
| FE-04-02 | native login 복귀·웹 세션 연결·logout | Q/B, 04-01/B-18 | access/refresh token을 URL/웹 영구 저장소에 노출하지 않고 계정 교체 시 이전 데이터 제거 |
| FE-04-03 | `features/account` 정보·이름·테마·Free/Pro | Q/F, 04-01 | 이름 저장 후 재조회·revision 충돌·시스템 테마·미설정 결제 상태 |
| FE-05-01 | `features/parking` 위치·용도·표시 폼/preview | Q/F, 04 | 층/자리 최소값 검증·요일/시간/기간·중복 저장 방지 |
| FE-05-02 | parking adapter와 dashboard invalidation | Q, 05-01 | 같은 요청 키 재전송과 새 위치 저장, manual/always/scheduled 의미 구분 |
| FE-05-03 | 서버 dashboard·library 연결·시간 경계 | Q/U, 02/05-02 | `server_time/next_refresh_at` 기준 갱신·null 종료·백그라운드 복귀 재조회 |
| FE-06-01 | 대화 목록·날짜 그룹·검색·초안·고정/이름 | Q/F/R, 04 | `last_activity_at/last_message`, IME 검색·빈 검색·긴 한 줄 미리보기 |
| FE-06-02 | 공유 `ChatComposer`·대화 panel/page 진입 | F/R/U, 01-06 | 대화 탭은 수평 페이지, 하단 dock은 위쪽 확장, 같은 대화/메모리 초안·키보드 유지. DraftRepository adapter와 프로세스 종료 시 복구 범위를 명시 |
| FE-06-03 | run 등록·request key·관찰 연결 | Q/E, 06-01/02 | 202 주소 보관·중복 POST 없음·25초 관찰 종료 후 같은 run 재연결 |
| FE-06-04 | SSE frame parser·재생·취소·복귀 | E, 06-03 | chunk 분할·이벤트 중복·Last-Event-ID/after·앱 복귀·명시 cancel·종료 상태 일치 |
| FE-06-05 | 실제 단계·최종 답변·결과 상세 route | E/Q/R, 06-04 | result kind/ID 검증→본인 리소스 조회, 저장 완료와 문서 작업 접수 구분 |
| FE-06-06 | 대화 삭제 제품 동선 결정과 API 연결 | Q/R, 06-01 | PoC에는 버튼이 없음을 명시하고 추가 동선 검토. 진행 중409, 삭제가 도메인 결과/예약 삭제를 뜻하지 않음 |

첫 통합 인수는 04~06이다. 실제 계정으로 주차를 저장하고 새로고침·채팅·재접속 후 같은 자료를 읽는다. fixture에서만 통과한 결과는 UI 인수로 기록하며 실제 Hermes/worker 통합 성공으로 적지 않는다. B-18은 별도 서버 작업이므로 프론트가 임시 로그인 우회나 PoC 메모리 프록시를 제품 세션으로 고정하지 않는다.

## 6. 단계 07~09 — 일정·기록·파일

| ID | 작은 작업·제안 파일 | 상태/의존 | 완료 증거 |
| --- | --- | --- | --- |
| FE-07-01 | `features/calendar` 월·주·일 범위와 날짜 이동 | Q/R/U, 04 | 월 말/연말·오늘·선택 날짜 유지, 각 기간 조회의 from/until 일치 |
| FE-07-02 | grid·주간 그룹·일간 timeline·진행/다음 | Q/U, 07-01 | 자정 경계·겹침·종일·기간을 넘는 일정·빈 날짜, tab/arrow 탐색 |
| FE-07-03 | 일정 폼·일시/기간 picker·겹침 preview | F, 01-04/07-01 | 종일과 시간 지정·장소/분류/메모, 잘못된 UTC/시간 범위의 서버422 표시 |
| FE-07-04 | 일정 생성/편집/삭제/복원·캐시 갱신 | Q/F, 07-03 | revision409에서 입력 보존·최신 값 확인, direct/AI 결과가 같은 달력에 반영 |
| FE-08-01 | `features/notes` 메모 목록/상세/폼 | Q/F/R, 04 | 80자 제목·12,000자 본문·검색/빈값/긴 본문·IME/저장 실패 입력 보존 |
| FE-08-02 | 메모 편집·삭제/undo·내용 저장 시각 | Q/F, 08-01 | 복원만으로 최신 내용 저장일이 바뀌지 않고 dashboard/library가 재조회됨 |
| FE-08-03 | `features/library` 분류·검색·추가 조회 | Q/R, 05/08-01 | `kind=note/document/feature_result`, offset/limit·total·동일 아이템 타입·상세 이동 |
| FE-09-01 | 파일 선택·텍스트/바이너리 구분·업로드 | Q/B/F, 08 | 실제 바이트/filename/MIME·10MB·quota·동일 키 재시도, multipart로 잘못 전송하지 않음 |
| FE-09-02 | 파일 목록/상세·미리보기/다운로드·휴지통 | Q/R, 09-01 | 원문을 목록에 넣지 않음, deleted/파기410·복원·잘림·새로고침 후 접근 |
| FE-09-03 | 문서 작업 등록·상태 polling·취소/재시도 | Q/F, 09-01 | 작업 ID와 output file ID 분리, retry 새 job·진행 실패·앱 복귀 추적 |
| FE-09-04 | 채팅의 명시적 파일/텍스트 문서 첨부 | Q/F/E, 06/09-01 | 본인 ID 최대3개·삭제/읽기 실패·취소·동일 키 다른 첨부409, 임의 경로/URL 첨부 금지 |
| FE-09-05 | 형식별 결과 UI·지원 한계 안내 | Q/U, 09-02/03 | DOCX/XLSX/PDF·HWP/HWPX 지원 동작만 노출, 원본 서식 보존/OCR/수식재계산을 과장하지 않음 |

PoC 일정 폼은 날짜+시작 시간+소요 시간과 색상 분류를 쓴다. 서버는 `starts_at/ends_at/timezone/all_day/category`다. adapter가 명시적으로 변환하고 일정 UI의 선택 날짜를 무조건 UTC 날짜 문자열로 자르지 않는다. 서버가 지원하는 종일 입력은 PoC 폼에 없는 제품 보완 작업으로 구분한다. 반복 사용자 기능 예약과 반복 개인 약속도 별개다.

## 7. 단계 10 — 기본 기능·사용자 기능·웹 결제를 나눠 구현

기존 ‘10’은 한 번의 개발 범위가 크다. 10A 기능 목록/정의 → 10B 결과·예약 → 10C 알림 → 10D 뉴스 → 10E 주가 → 10F 웹 결제로 나눈다. 서버 설정/제공자 준비에 따라 독립된 하위 작업은 병행할 수 있다.

| ID | 작은 작업·제안 파일 | 상태/의존 | 완료 증거 |
| --- | --- | --- | --- |
| FE-10-01 | `features/features` 6종·내 기능 목록/필터 | Q/U, 04 | 기본 소개6종과 서버 문서 카탈로그 차이를 숨기지 않고 제품 목록 매핑, 상태·행/카드 정렬 |
| FE-10-02 | 사용자 기능 폼·반복 option·시간 해제 | F, 01-04 | 필요할 때/단발/매일/평일·선택시간·IANA zone·단발 날짜, 폼 아래를 밀어 여는 반복 UI 금지 |
| FE-10-03 | 18개 아이콘·참고 accordion·카드 preview | F/U, 10-02 | 3그룹 아이콘 이름/선택·6,000자 참고·title/description/work 길이, 입력값에 따른 preview 일치 |
| FE-10-04 | 기능 생성/편집·버전·쓰기 권한 설정 | Q/F, 10-02/03 | `reference` 매핑·allowed_actions 명시 선택·reply 필수·기존 revision409, 모델이 권한을 늘리지 않음 |
| FE-10-05 | 기능 상세·수동 실행·중지/재개·이전 결과 | Q/E/R, 06/10-04 | execution_available/automation_status·초안·이전버전 결과·상태 경합, 중지는 과거 결과 삭제가 아님 |
| FE-10-06 | 결과 체크리스트·버전 상세·회차 목록/취소 | Q/F, 10-05 | 체크항목 ID/revision·원래 결과 유지, 한 회차 cancel과 반복 기능 pause 구분 |
| FE-10-07 | `features/reminders` preset·countdown·상세 | Q/U, 04 | 5/15/30/60분·started_at/target_at 기준, 렌더마다 목표시각을 새로 만들지 않음 |
| FE-10-08 | 알림 연장/취소/재시작·delivery 상태 | Q/F, 10-07 | +5분·취소·30분재시작·새로고침 후 진행률, 시각0과 전송/기기표시 완료 구분 |
| FE-10-09 | `features/news` 설정·기사/요약·수동 갱신 | Q/F, 04 | 주제/예약 revision·출처·검색 발췌 근거·이전 성공 stale·loading/실패·빈 결과/재시도 |
| FE-10-10 | `features/market` 종목/예약·가격 metadata | Q/F, 04 | symbol revision+feature_revision·schedule 생략/해제·원자 저장, 가격종류·통화·거래일 |
| FE-10-11 | 국내분봉/기타일봉 chart adapter와 renderer | Q/U, 10-10 | OHLC·붉은 상승/푸른 하락·범위별 interval, empty_reason/truncated·분봉옆 종가를 현재가로 오인시키지 않음 |
| FE-10-12 | `features/billing` plan·checkout·callback | Q/R/B, 04/제공자 | 서버 가격·고정 callback·주문 확인으로 성공 판단, 미설정/취소/실패/확인대기 표시 |
| FE-10-13 | 주문·구독 해지/해지철회·실효 Pro | Q/F, 10-12 | 기간말 해지와 즉시 환불 구분, admin/paid 근거·만료·준비 중 runtime 상태 인수 |

주차 상세 지도, 메모 상세, 일정 상세는 각각 05·08·07에서 구현하며 기본 기능 카드에도 같은 상세를 연결한다. 뉴스/주가/알림만별도 비슷한 dialog를 다시 만들지 않는다. 문서 작업은 09에서 만들고 10의 결과 참조가 이를 재사용한다.

## 8. 단계 11~12 — 음성·기기·배포 인수

| ID | 작은 작업·제안 파일 | 상태/의존 | 완료 증거 |
| --- | --- | --- | --- |
| FE-11-01 | `VoiceSession` 상태와 browser/native adapter | B/U, 03/06 | idle/requesting/listening/processing/review·권한거부·unsupported·중단/취소 정리 |
| FE-11-02 | 고정 composer 위 voice panel·파형/예시 | U/F, 11-01 | 열기/닫기 애니메이션·예시 펼침 높이·스크롤·재시도, 내용 변화로 입력창 이동 없음 |
| FE-11-03 | 녹음 bytes→전사→수정→같은 대화 제출 | Q/F/B, 11-01/02 | 전사40,000자와 채팅4,000자 구분, 전사 완료가 자동 제출 아님·중복 전송 방지 |
| FE-12-01 | client-config/bridge 호환·웹 실패 fallback | R/B, B-18 | 구/신 build×web release 조합, 만료설정/미지원 capability·재시도/업데이트 안내 |
| FE-12-02 | native 기기 등록/해제·Push·딥링크 | Q/B/R, B-19 | 앱종료→로그인/소유권확인→정확한 상세, 계정전환·권한거부·token회전 |
| FE-12-03 | 위젯 snapshot·OS확장·갱신/캐시 | Q/B, B-19 | 오래된자료·만료·logout정리, Hermes상주나 정각OS갱신 보장하지 않음 |
| FE-12-04 | release 기록·내부앱·staging·rollback 인수 | B/R, 운영준비 | 서명 build·immutable 웹·API/bridge 호환·호환 이전웹 복귀, native 변경은 새 build |
| FE-12-05 | 전 화면 실제기기·접근성·오류회복 | 전체, 앞 작업 | 모바일/태블릿·200%글자·스크린리더·모션감소·오프라인→복귀·서버run 복원. 메모리 초안/음성은 같은 프로세스에서 보존하고 프로세스 종료 뒤는 실제 저장된 범위만 복구 |

B-18 웹 세션·WebView 일회용 교환·client-config, B-19 native APNs/FCM·위젯 snapshot은 현재 OpenAPI 0.9에 없는 후속 서버 계약이다. Web Push·Toss 웹 자동결제·전사 API가 있다는 이유로 native Push·앱 구매·RN 녹음이 구현됐다고 표시하지 않는다.

## 9. 실제 API 연결 표

아래는 API 0.9.0의 실재 경로다. `{id}`는 설명용 축약이며 생성 타입과 실제 명세의 resource_id/conversation_id 등 매개변수 이름을 따른다. 서버 응답 전체는 고정 [OpenAPI](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/openapi.json)를 기준으로 한다.

| 제품 작업 | 현재 경로·요청 의미 | 캐시/화면 반영 |
| --- | --- | --- |
| 시간카드/기록 | `GET /v1/dashboard?hours=0\|3\|5\|24`; `GET /v1/library?kind=note\|document\|feature_result&q=...&limit=...&offset=...` | dashboard시간범위·사용자 key, library검색/분류/페이지 key |
| 주차 | `POST /v1/parking-records`, `GET /v1/parking-records/latest` | 최신위치·dashboard·채팅결과 상세 |
| 일정 | `GET/POST /v1/calendar/events`, `GET/PUT/DELETE /v1/calendar/events/{id}`, `POST .../{id}/restore` | 조회from/until·선택날짜·dashboard |
| 메모 | `GET/POST /v1/notes`, `GET/PUT/DELETE /v1/notes/{id}`, `POST .../{id}/restore` | 메모상세·library·dashboard |
| 대화/실행 | `GET/POST /v1/conversations`, `GET/PATCH/DELETE .../{id}`, `GET/POST .../{id}/messages`, `POST .../{id}/runs`, `GET .../{id}/runs/{run_id}`, `GET .../{id}/runs/{run_id}/events`, `POST .../{id}/runs/{run_id}/cancel` | 메시지·목록활동시각·run상태·이벤트커서 |
| 기능 | `GET /v1/feature-catalog`, `GET/POST /v1/features`, `GET/PUT .../{id}`, `POST .../{id}/state`, `GET .../{id}/versions/{version}`, `GET .../{id}/results` | 정의·목록·고정버전·dashboard |
| 결과/회차 | `GET /v1/feature-results/{id}`, `PATCH .../{id}/items/{item_id}`, `GET /v1/automation/jobs`, `GET .../{id}`, `POST .../{id}/cancel` | 결과체크·원래회차·반복정의 상태 구분 |
| 알림 | `GET/POST /v1/reminders`, `GET/PUT/DELETE .../{id}`, `POST .../{id}/extend\|cancel\|resume\|restore`, `GET .../{id}/deliveries` | 상세·countdown·dashboard·실제전달 상태 |
| 뉴스/주가 | `GET /v1/news`, `PUT /v1/news/settings`, `POST /v1/news/refresh`; `GET/PUT /v1/market/settings`, `GET /v1/market/quote\|candles\|snapshot` | 설정/결과·stale·quote종가vschart기준·예약 |
| 파일/문서 | `GET/POST /v1/files`, `GET/DELETE /v1/files/{id}`, `GET .../{id}/content`, `POST .../{id}/restore`; `GET/POST /v1/document-jobs`, `GET .../{id}`, `POST .../{id}/cancel\|retry`; 기존 `/v1/documents` | 파일·원문·작업·결과파일·library를 분리 |
| 마이/결제 | `/v1/me`, `/v1/me/settings`, `/v1/plans`, `/v1/me/subscription`; `/v1/billing/checkouts`, `/checkouts/{id}/complete`, `/orders`, `/orders/{id}`, `/orders/{id}/reconcile`, `/subscription/cancel\|resume` | 로그인사용자·실효등급·주문·구독. checkout은 성공 확정 아님 |
| 음성/환경 | `POST /v1/speech/transcriptions`, `GET /v1/capabilities`, `GET /v1/me/runtime`, `POST /v1/me/runtime/retry` | 전사초안·지원/worker상태·개인환경 준비 |

### PoC 값과 서버 값의 변환 규칙

- 주차의 PoC ‘시간 지정 안 함’은 기능 탭 조회라는 의미이므로 서버 `manual`로 매핑한다. 서버의 명시적 `always`는 새 위치 저장 전까지 dashboard에 표시한다. `scheduled`는 표시 규칙이며 기기 Push 예약이 아니다.
- 사용자 기능의 ‘필요할 때’는 `schedule=null`, 매일/평일/한 번은 각각 daily/weekdays/once다. 단발 날짜·timezone을 명시하고, 예약 생략과 명시적 null 해제를 다른 동작으로 취급한다.
- 사용자 기능의 PoC `content`는 서버 `reference`, 결과의 PoC `custom` 필터는 library의 `feature_result`다. `version`(정의/실행 버전)과 `revision`(동시 수정 검사)을 섞지 않는다.
- 일정의 날짜+시간+소요 시간은 서버 시작/종료·IANA zone으로 만든다. 종일의 종료 경계와 달력 기간의 반열린 구간을 일관되게 처리한다. 기기의 timezone을 사용자 설정으로 몰래 덮어쓰지 않는다.
- `show_until=null`은 항상 표시하는 유효한 계약이다. 빈 뉴스·`candles=[]/as_of=null/empty_reason`, 이전 성공 stale, 일부 preview truncated도 정상 화면 상태로 처리한다.
- 문서의 원본 보관·job등록·job완료·output file·download는 별도 상태다. 결과 참조 종류를 검증한 뒤 해당 resource를 재조회하고 임의 detail URL을 외부 탐색으로 실행하지 않는다.

## 10. 공통 인수 행렬과 기록 방식

| 축 | 최소 사례 |
| --- | --- |
| 화면/기기 | 320/375/390px 휴대폰, 768px 태블릿, 가로·큰 화면; RN iOS/Android 실기기 |
| 읽기/조작 | 200% 글자·VoiceOver/TalkBack·키보드·모션 감소·짧은/긴 콘텐츠·터치/포인터 |
| 데이터 | 0/1/여러개·서버미설정·로딩·stale·충돌409·검증422·인증401·삭제404/410 |
| 수명 | 처음 진입·뒤로가기·중간닫기·회전/resize·다른탭·백그라운드·재시작·네트워크 복귀 |
| 쓰기/실행 | 같은 UUID재전송·다른 내용409·진행중취소·lease복구·성공후 재조회·권한회수 |
| 소유권 | 계정A→logout→B, 다른 사용자의 ID/과거 캐시·알림/위젯·파일 참조 미혼합 |

업무 규칙을 가진 adapter/parser는 Vitest 등 선택한 도구로 의미 있는 경계 검사를 만들고, 상호작용은 컴포넌트 검사와 소수의 핵심 E2E로 확인한다. CSS 속성을 복제하는 검사나 모든 행에 같은 테스트를 반복하지 않는다. 화면 비교·실기기·제공자 인수가 필요한 결과를 단위 검사 숫자로 대신하지 않는다.

각 FE 작업은 `대기 → 구현 중 → fixture/UI 확인 → 실제 API 연결 → 실환경 인수`를 필요한 범위에서 기록한다. 완료 기록에는 FE ID, commit, 실제 실행 주소/환경, 확인한 화면/시나리오, 미검증 제한을 남긴다. root README의 현재 설명만 갱신하거나 화면이 열리는 것만으로 전체 기능 완료를 선언하지 않는다.
