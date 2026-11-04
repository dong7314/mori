# 공통 컴포넌트와 화면 전환·입력 규격

작성일: 2026-11-04 · 상태: 제품 React에서 구현할 UI 계약 · 기준: `poc 8fa4fe4`

[프론트 작업 분해](poc-to-react-work-breakdown-2026-11-04.md) · [구현/라이브러리 기준](frontend-engineering-guide-2026-11-04.md) · [프론트 계획](plan.md)

## 1. 재사용할 기준

기존 PoC의 간결한 세이지/크림·라벤더 보조색, 마스코트·기능 SVG·타이포그래피와 실제 조작 흐름을 제품 컴포넌트로 옮긴다. 아래 이름은 구현할 제안 API이며 현재 만들어진 React 컴포넌트가 아니다. 컴포넌트의 동작 기반은 React Aria, 화면 스택은 Stackflow, 필요한 공유 요소 전환은 Motion으로 나눈다.

색·간격·모션 값의 원본은 [PoC mobile 스타일](https://github.com/dong7314/mori/blob/8fa4fe4/styles/_mobile.scss), [접근성 보완](https://github.com/dong7314/mori/blob/8fa4fe4/styles/experience.scss), [모션](https://github.com/dong7314/mori/blob/8fa4fe4/src/motion.mjs)과 [presentation](https://github.com/dong7314/mori/blob/8fa4fe4/src/presentation.mjs)에서 추출한다. 화면별 CSS 수치를 그대로 복사해 중복을 늘리지 않는다.

### 토큰을 만드는 방식

| 분류 | 첫 추출 기준 | 제품에서 관리할 것 |
| --- | --- | --- |
| 색 | canvas #f5f6f3·surface #fff·ink #28352f·accent #456e57, dark 별도 | semantic 이름으로 background/surface/text/border/action 상태를 매핑 |
| 간격 | 기존 4/8/12/16/24/32 단계와 gutter | screen/list/field/section 간격, 좁은 화면과 태블릿 보정 |
| 글자 | 기존 한글 폰트·이름/제목/본문/보조 단계 | rem 기준, 일반·큰 글자, line-height·weight·숫자 표기 |
| 모서리/깊이 | 카드·목록·버튼·시트의 현재 차이 | card/field/sheet radius, surface shadow·border, dark 대비 |
| 터치 | PoC의 44px 조작 높이를 출발 기준으로 확인 | 작은 아이콘도 터치 영역 확보, adjacent hit area 겹침 금지 |
| 모션 | 진입/이탈/카드/선택의 기존 의미 | duration/easing·중단/복귀·감소된 모션, 실제 기기에서 값 조정 |

위 색상은 현행 소스의 예시이고 모든 상태를 이 네 값으로 표현한다는 뜻이 아니다. CSS 변수와 RN용 값은 같은 토큰 원본에서 생성하되 DOM 스타일과 native 스타일 코드를 직접 공유하지 않는다. 반투명 효과는 내비게이션 등 제한된 표면에 두고 정보 카드·폼의 대비를 보존한다.

## 2. 공통 표시/조작 컴포넌트

| 컴포넌트 | 주요 값과 동작 | 공통 규칙 |
| --- | --- | --- |
| `AppFrame` / `TabNavigation` | 활성 탭·insets·각 탭 scroll | 5탭, 한 곳에서 safe area 계산, 탭 이동 후 초안/날짜 보존 |
| `PageHeader` | title·back·trailing action | 상세와 루트의 위계, 큰 제목을 의미 없이 반복하지 않음 |
| `SectionHeader` | title·actionLabel·onAction | 시간 범위/전체 보기 등 오른쪽 액션의 글자 크기·터치 높이 통일 |
| `Button` / `IconButton` | variant·pending·disabled·label | 주/보조/위험 동작, hover·press·focus·loading을 각각 정의 |
| `RecordRow` | icon·title·preview·meta·destination | 일반 글자에서 미리보기 한 줄 말줄임, 같은 variant의 기본 높이 일치 |
| `FeatureCard` / `CustomFeatureCard` | icon·title·schedule·status·lastRun | 현재 PoC의 카드 grid와 헤더 추가 진입을 유지. 목록 variant를 도입할 때만 공통 Row 규격 적용 |
| `Badge` / `StatusText` | semantic status·label | 색만으로 의미 구분하지 않으며 선택/상태/버튼을 혼동하지 않음 |
| `Field` / `TextArea` | label·help·error·required·control | label·오류 연결, 저장 실패에도 입력 보존, 한국어 IME 중 강제 submit 금지 |
| `FormActions` | primary·secondary·submit state | 버튼 높이 통일·중복 제출 방지, 필수 정보가 충분한 저장에 불필요한 승인창 없음 |
| `EmptyState` / `ErrorState` | 원인·가능한 다음 행동 | 빈 결과·미설정·권한 부족·실패를 다른 상태로 표현 |
| `UndoToast` | 서버 작업 참조·복원 동작·기한 | 닫기/자동 소멸·키보드 접근, 복원 실패도 표시 |
| `ResourceLink` / `JobStatus` | kind·ID/detail URL·실제 상태 | 임의 HTML/내부 runtime URL 실행 없이 검증된 앱 목적지로 연결 |

일반 크기에서는 목록 제목/미리보기 길이 때문에 행 높이가 달라지지 않게 한다. 큰 글자·스크린리더에서는 필요한 내용과 조작을 잘라 높이를 고정하지 않는다. 말줄임된 전체 내용은 상세에서 볼 수 있다. 목록 hover 배경은 행 전체의 올바른 모서리/분리선을 따라 칠하고 내부 텍스트 사각형에만 칠하지 않는다. hover는 해당 입력 장치에서만 보조 피드백으로 사용하고 모바일 기능에 필수로 만들지 않는다.

## 3. 페이지·시트·선택창의 사용 기준

| 표면 | 사용처 | 진입/종료와 상태 |
| --- | --- | --- |
| `NavigationPage` | 기능 상세·대화·길게 읽는 기록·일정/기능 편집 | push/pop·URL/ID·scroll 복원, 뒤로가기 한 번에 한 단계 |
| `BottomSheet` | 짧은 보조 입력·보관함 부가 작업 | 아래에서 진입/이탈, 내용 기반 높이와 최대 높이·safe area |
| `ChoiceSheet` / `SelectionPopover` | 반복·테마·시간 범위 등 단일 선택 | 작은 화면은 sheet, 넓은 화면은 anchor popover 가능. 같은 값/취소 의미 유지 |
| `DatePickerSheet` / `TimePickerSheet` | 모든 폼의 날짜·시간/기간 입력 | 전체 사용 가능 너비·확정 전 draft·취소 원복 |
| `ConfirmAlert` | 데이터 삭제 등 확인이 필요한 위험 행동 | 영향과 실제 대상만 안내, 기본 저장/화면 이동에는 사용하지 않음 |

React Aria의 overlay/포커스 동작을 공통 wrapper 안에서 통일한다. 페이지마다 별도 dialog 외곽·닫기 버튼을 다시 만들지 않는다. modal 상태의 배경 접근·스크롤을 막고, 닫힌 뒤 trigger 또는 합당한 복귀 요소에 포커스를 돌려준다. 중첩 picker가 닫혔다고 부모 편집 화면이 닫히거나 body 스크롤 잠금이 풀리지 않게 한다. [React Aria 조합/스타일 방식](https://react-aria.adobe.com/getting-started).

시트는 모바일 사용 너비를 채우고, 태블릿/데스크톱에서는 읽기/선택 폭을 제한한다. 크기/최대 높이는 `SheetLayout` 한 모듈에서 결정한다. 빈 영역을 맞추려고 접힌 참고 내용·음성 예시에 고정 height를 남기지 않는다. 커스텀 반복 옵션을 열어 부모 폼 전체를 밀어내는 inline 확장은 사용하지 않는다.

## 4. 날짜·시간·반복 입력

- `PickerField`는 선택값과 변경 가능 상태를 표시하고 실제 입력은 공통 picker에서 처리한다. label을 누르거나 키보드로도 열 수 있다.
- 날짜/시간 선택 중인 draft와 저장 폼 값을 분리한다. 완료에서만 전달하고 취소·back은 기존 값을 유지한다.
- wheel의 시/분은 보이는 상단 ‘시·24시간·분’ 설명을 반복하지 않아도 된다. 접근성 이름·선택 값·증감/키보드 동작은 제공한다.
- 전체 앱의 시작/종료/수집/표시 시각에 같은 wheel/field를 사용한다. 분 단위·24시간/오전오후 표기와 실제 저장값을 구분한다.
- wheel은 scroll snap의 시각 효과만으로 접근성을 완료하지 않는다. pointer·키보드·스크린리더와 큰 글자를 검사하고 필요하면 접근 가능한 숫자/시간 입력 대체를 제공한다.
- 반복 옵션은 필요할 때/한 번/매일/평일처럼 현재 지원 범위에 맞추고, 보이는 레이블과 서버 repeat/날짜 값을 명시적으로 매핑한다.
- 참고 내용은 accordion으로 접되 내용·글자 수·오류를 잃지 않는다. 아이콘은 18개 허용 키·세 그룹·현재 선택의 동일한 표현을 사용한다.

일정의 실제 timestamp, 종일 날짜, 주차 표시 시간, 사용자 기능 반복은 다른 모델이다. 하나의 편의 `Date` 값으로 합치지 않는다. 날짜와 IANA 시간대 변환은 [구현 기준](frontend-engineering-guide-2026-11-04.md#7-폼날짜선택-입력-구현)과 서버 스키마를 따른다.

## 5. 대시보드 카드와 전용 축소 장면

| 구성 | 표시할 정보 | 유지할 상호작용 |
| --- | --- | --- |
| `TimeWindowMenu` | 지금·3·5시간·하루, 각 범위의 탐색 설명 | 현재 선택 check만 표시, 불필요한 오른쪽 화살표 없음 |
| `TimeRangeSummary` | 시작/종료 시각·항목 수 | 숫자와 단위 한 줄, 주변 카드와 같은 surface 강도 |
| `CarouselRail` | 시간대별 카드·좌우 탐색 상태 | 버튼 규격 통일, swipe/세로 스크롤 충돌 방지 |
| `TimeCard` | 종류·시각·상태·제목·짧은 정보 | 아래 ‘최신 보기/설정 보기’ 중복 row 제거, 카드 전체에서 상세 이동 |
| `ParkingScene` | 저장한 층/구역의 주차장 map 축소 장면 | 실사 이미지 대신 SVG·의미 있는 위치/경로 |
| `NewsScene` | 뉴스 페이지의 축소 장면·주제 | 예시 기사 제목을 실제 수집 결과로 가장하지 않음 |
| `MarketScene` | 빨강/파랑 캔들 | 실제 자료가 있으면 자료 사용. 시각 예시는 명시적 개발 fixture에서만 |
| `ScheduleScene` / `ReminderScene` | 일정 배치 / 단순한 자명종·남은 시간 | 뉴스 종이 모양 재사용 없이 각 기능 의미를 표현 |
| `CustomScene` | 사용자 아이콘·참고/결과 유형·시간 | 허용된 카드 템플릿 안에서 표현, 임의 UI 코드 렌더링 없음 |

메모·문서·시간 없는 기록은 ‘기록과 정리’에 둔다. 현재 카드가 없다고 모든 기본 기능의 빈 카드를 넣지 않는다. 일정/대화 중복 섹션과 상단 빠른 추가 줄도 복구하지 않는다. 최근 기록은 최대 5개, 분류 탭은 전체 목록에서 제공한다.

### CardTransitionCoordinator

전환의 기준은 카드의 위치·크기·radius·아이콘·제목과 상세 hero의 동일한 데이터다. 클릭 시 카드 ID와 snapshot을 잡고, 상세 데이터는 기존 query cache로 먼저 렌더링한다. 추가 요청이 있으면 본문 상태로 보여주며 hero를 전환 중 다른 내용으로 교체하지 않는다.

Stackflow는 목적지와 back 이력을 만든다. 카드가 확장되는 frame에는 같은 시점에 기본 페이지 slide를 중첩하지 않는다. Motion이 전환하는 요소와 Stackflow가 transform하는 외곽을 분리하거나 카드 진입에 기본 slide를 끈다. 상세에서 돌아올 때는 같은 카드 ID/현재 레일 위치를 찾아 축소한다. 원래 카드가 없어졌다면 과도한 위치 점프 대신 일반 pop/fade로 복귀한다.

연속 탭·중간 back·화면 회전·키보드/글자 크기 변경·모션 감소·앱 백그라운드에서는 진행 중 애니메이션을 정리해 클릭을 막는 투명 레이어가 남지 않게 한다. 종료할 때마다 화면 내용이 뒤늦게 뒤바뀌거나 새 snapshot이 한 번 더 나타나지 않아야 한다. [Motion shared layout](https://motion.dev/docs/react-layout-animations), [Stackflow 화면 스택](https://stackflow.so/docs/get-started/introduction).

## 6. 채팅·음성의 공통 입력 기준

대시보드 하단 입력과 마이크 버튼은 같은 높이·기준선·공통 외곽을 사용한다. 입력창의 위치는 고정하고 채팅/음성 패널이 그 위로 확장된다. 대화 탭에서 새 대화를 여는 진입은 페이지 push, 하단 dock에서 여는 진입은 아래→위 확장이다. 두 진입 모두 같은 대화/초안/실행 observer를 사용한다.

`VoicePanel`은 idle→listening→transcribing→review→submitting/error 같은 명시적 단계를 갖는다. 패널 높이는 단계/내용에 맞추고 접힌 예시 영역의 빈 높이를 유지하지 않는다. waveform은 clip된 시각 영역 안에서 동작해 body scrollbar를 만들지 않는다. 전사 내용을 검토/수정한 뒤 사용자 의도로 채팅을 제출하며 API가 자동 전송한 것처럼 처리하지 않는다.

탭/패널 전환은 메모리 초안을 보존하지만 WebView 프로세스 종료 뒤 저장 전 초안/녹음 복구는 초기 범위에서 보장하지 않는다. 서버 메시지/run과 실제 보관된 초안만 복원하며 앱 재시작으로 사라진 내용을 저장됐다고 표시하지 않는다.

동일 실행의 SSE 관찰은 패널의 열림 상태와 분리한다. 닫기는 접기, 취소는 서버 cancel로 처리한다. 캐시된 대화/실행 결과와 재연결 상태를 보여주고 ‘이 기기에 저장됩니다’·‘예시 응답’ 같은 PoC 문구를 운영 화면에 넣지 않는다. 실제 도구/저장 단계와 결과 참조를 사용하며 내부 사고 과정 원문은 표시하지 않는다.

## 7. 상세 화면별 공통 외곽과 고유 본문

| 상세 | 공통으로 재사용할 것 | 고유 본문·연결 |
| --- | --- | --- |
| 주차 | DetailHeader·수정 액션·시각/상태 | 위치/map·목적·표시 설정, manual/always 차이 |
| 뉴스 | 출처 링크·업데이트·오류/재시도 | 검색 발췌 요약·기사 목록·stale·수집 예약 |
| 주가 | 기간 선택·가격 기준·빈/실패 | 분봉/일봉 캔들·통화·시간대·자료 시점·표 대체 |
| 메모 | 편집/삭제/복원·본문 외곽 | plain text·마지막 내용 저장 시각·입력 보존 |
| 일정 | 상세/편집/삭제·시간/위치 | 월/주/일 공통 데이터·종일·기간·겹침 안내 |
| 알림 | 상태/목표·취소·재시작 | started_at 기준 진행률·연장·전달 상태 |
| 사용자 기능 | 정의/편집/중지·버전·결과 | allowed_actions·실행 회차·체크리스트 |
| 문서 작업 | 작업 상태·취소/재시도·결과 링크 | 원본/미리보기·잘림·새 결과 파일 다운로드 |
| 마이 | 설정 그룹·row·프로필 표시 | 로그인·프로필/이름·테마·유효 요금제·기간 말 해지 |

상세마다 제목 크기·여백·닫기 아이콘·액션 정렬을 새로 정하지 않는다. 공통 외곽 안에서 고유 기능의 정보만 다르게 표현한다. 선택창·상세·위험 확인의 의미를 같게 만들지 않는다.

## 8. 컴포넌트 인수 목록

1. 같은 variant의 행·버튼·선택값이 화면마다 같은 padding·글자·상태를 사용하는가.
2. 일반·pressed·hover·keyboard focus·disabled·pending·error·selected를 각각 확인했는가.
3. 320/375/390px 모바일, 768px 태블릿과 큰 화면에서 가로 넘침·하단 가림이 없는가.
4. 200% 글자·라이트/다크·대비/모션 감소·스크린리더에서 조작 의미가 유지되는가.
5. picker·sheet·페이지 중첩의 back/ESC·포커스 복귀·scroll lock이 한 번씩 동작하는가.
6. 폼 dirty 중 재조회·계정 전환·app resume에서 입력을 잃거나 다른 계정 자료를 보이지 않는가.
7. 실제 API의 401/409/422/502·빈값·stale·문서 queued·결제 review를 UI에 맞게 표현하는가.
8. Android back과 iOS swipe, 키보드·safe area·회전은 실제 WebView에서 확인했는가.

각 FE 작업은 이 규격 중 해당되는 상태 예제를 함께 제공한다. 모든 상태를 처음부터 거대한 범용 컴포넌트로 만들지 않고 두 화면 이상에서 같은 조작이 반복될 때 공통 wrapper에 반영한다.
