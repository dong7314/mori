# React 웹·RN 앱 프론트엔드 구현 기준

작성일: 2026-11-04 · 상태: 사용자 개발을 위한 채택안·착수 검증 기준 · 화면 `poc 8fa4fe4` / API `master 6285aba`

[전체 계획](../plan.md) · [화면별 작업 분해](poc-to-react-work-breakdown-2026-11-04.md) · [컴포넌트·UX 규격](component-system-2026-11-04.md) · [공식 서비스 사례](industry-architecture-research-2026-11-04.md) · [배포 실행안](../architecture/release-playbook-2026-11-04.md)

## 1. 이 문서로 정한 것

제품 프론트·RN 앱은 사용자가 개발한다. AI는 API 계약 보완·코드/문서 검토와 요청받은 구현을 지원한다. 이 문서의 경로·컴포넌트·도구는 앞으로 만들 기준이며 현재 설치된 제품 프로젝트가 아니다. PoC 소스의 실제 흐름을 나누어 React로 옮기고, 개발용 데이터와 실제 계정 데이터를 분리한다.

Mori는 **React DOM 웹 + React Native 컨테이너 + 원격 HTTPS WebView 하나**를 사용한다. 탭·카드·상세·입력 화면은 웹, 녹음·권한·보안 저장소·로그인 복귀·기기 기능은 RN이 맡는다. RN에 웹의 5탭을 다시 만들지 않고, DOM 컴포넌트를 RN 컴포넌트로 직접 가져오지 않는다. 공통화 대상은 API 타입·브리지 스키마·디자인 토큰이다.

당근의 React/Stackflow/SEED 웹뷰와 토스의 RN/WebView 혼합 운영에서 책임·배포 경계를 참고한다. Mori의 단일 웹 앱에 초기부터 회사별 대규모 배포 플랫폼이나 서비스별 RN 번들 로더를 이식하지 않는다. 회사에서 확인한 사실과 Mori의 결정은 [사례 조사](industry-architecture-research-2026-11-04.md)에 구분했다.

## 2. 프레임워크와 라이브러리 채택안

| 영역 | 초기 선택 | Mori에서 맡길 일·선택 이유 | 도입 시점 |
| --- | --- | --- | --- |
| 웹 | React + TypeScript + Vite SPA | 개인 데이터 중심 5탭, 기존 별도 API와 정적 웹 배포 | 01 |
| 패키지 | pnpm workspace | web/mobile·공통 3개 패키지, 단일 lockfile·명시적 의존성 | 01 |
| 화면 스택 | Stackflow + history-sync, basic-ui는 검증 후 | 모바일 push/pop·뒤로가기·스크롤 복원. URL/스택의 주체를 하나로 유지 | 01~03 |
| 접근성 UI | React Aria Components | Select·Popover·Dialog·Calendar·입력의 키보드/포커스/상태 기반. 외형은 Mori CSS | 01 |
| 스타일 | CSS Modules + Sass·CSS 변수 | 기존 SCSS/토큰 이식, 기능별 스타일 격리·라이트/다크 | 01 |
| 서버 상태 | TanStack Query | 조회·캐시·페이지·저장 후 무효화, 화면 복귀 재조회 | 04~05 |
| 공유 UI 상태 | Zustand | 공통 composer 모드·초안·음성 세션·native capability. 서버 레코드는 넣지 않음 | 06·11 |
| 폼 | React Hook Form + Zod + resolver | dirty·검증·submit·서버 오류, 커스텀 picker 연결 | 04~05 |
| API 타입/호출 | openapi-typescript + openapi-fetch | master OpenAPI에서 타입 생성, 인증/오류 transport 통일 | 01·04 |
| 날짜 | @internationalized/date + Intl | CalendarDate·Time·IANA 시간대·한국어 표시, 서버 UTC와 폼 날짜 구분 | 01·07 |
| 모션 | CSS transition + Motion for React | 카드 공유 요소·패널 출입. Stackflow와 같은 transform을 동시에 쓰지 않음 | 02 |
| 주가 차트 | Lightweight Charts | 캔들 전용 차트·리사이즈·확대. 접근 가능한 숫자/표 대체 UI 별도 | 10 |
| 자동 검사 | Vitest + Testing Library + MSW + Playwright | 순수 계산·사용자 조작·API 계약·모바일 탐색 회귀 | 01 이후 해당 기능과 함께 |
| RN | React Native + react-native-webview | 단일 웹 컨테이너·native capability adapter. Xcode/Gradle 소유 | 03 |

위 표는 Mori의 채택안이다. 공식 문서의 기능 설명만으로 해당 조합이 실기기에서 검증됐다고 보지 않는다. 01~03에서 실제 타입 검사·웹 빌드·두 OS 최소 앱과 탐색/키보드 실험을 통과한 버전을 정확히 고정한다.

React 공식 문서는 프레임워크 시작을 권장하면서 Vite 등으로 직접 구성하는 경로도 제공한다. Mori는 별도 API·모바일 스택·로그인 이후 화면이라는 조건 때문에 Vite SPA를 선택한다. SSR이 불필요하다는 일반론은 아니며 공개 검색 노출·SSR 요구가 생기면 별도 결정한다. [React의 앱 구성 선택](https://react.dev/learn/creating-a-react-app), [직접 구성](https://react.dev/learn/build-a-react-app-from-scratch).

### 대안과 이번에 채택하지 않는 이유

| 대안 | 판단 |
| --- | --- |
| Next.js / React Router framework | 각각 유효한 프레임워크다. 현재 Mori의 서버/화면 스택과 중복 책임이 생겨 초기에는 추가하지 않음 |
| Stackflow + React Router 이중 관리 | 동일 상세의 URL·back·스크롤을 두 주체가 소유하지 않음. Stackflow 실험 실패 시 ADR로 대체하고 기존 주체 제거 |
| MUI / Ant Design 전체 테마 | 관리 화면에 적합한 기본 외형을 Mori 모바일 UI에 맞춰 재정의하는 비용이 커 초기 제외 |
| shadcn/Radix | 유효한 접근성 기반 대안. 날짜·시간·선택 입력까지 일관된 한 기반을 쓰기 위해 React Aria를 우선 선택 |
| SEED 전체 테마 | 당근의 구성/접근성·토큰을 참고하되 당근 브랜드 외형을 Mori에 복사하지 않음 |
| Tailwind / vanilla-extract | 사용할 수 있지만 기존 SCSS 이식과 선택 기반을 명확히 하려고 CSS Modules를 우선. 세 방식을 동시에 운영하지 않음 |
| FullCalendar·대형 드래그 캘린더 | PoC는 월/주/일·직접 폼 중심. 초기 월 그리드/주·일 레이아웃을 구현하고 drag/반복 일정 요구가 생길 때 재평가 |
| Redux·GraphQL·Axios 동시 추가 | 이미 정한 서버 캐시·UI 상태·REST transport의 책임을 중복 구현하지 않음 |
| 리치 텍스트 에디터·다양한 표 차트 | 메모는 우선 plain text, 주가는 캔들. 실제 편집 스키마 요구가 생길 때 추가 |
| Turborepo/Nx·RN JS OTA·Lynx | 초기 작업량에서 필수 아님. 측정된 빌드/배포 문제와 native 호환 요구가 있을 때 별도 도입 |

## 3. 조사한 버전과 고정 절차

2026-11-04 공식 npm registry의 stable dist-tag와 peerDependencies를 조회했다. 아래는 **관측값과 초기 후보**이며 설치·통합 빌드 결과가 아니다. 날짜가 지나면 착수 시 다시 확인한다. 앱/웹 release 버전과 라이브러리 버전은 별개다.

| 묶음 | 확인한 버전 | 초기 처리 |
| --- | --- | --- |
| React / react-dom | 19.3.1 / 19.3.1 | 웹 두 패키지 버전을 맞춤 |
| React Native / WebView | 0.88.1 / 14.0.1 | RN의 React peer ^19.3.0과 두 OS 빌드 확인 |
| TypeScript | latest 7.0.2, 5.9.3도 배포 확인 | **초기 5.9.3 후보**. openapi-typescript 7.13.0의 peer가 ^5.x이므로 latest 일괄 설치 금지 |
| Vite / pnpm | 8.3.5 / 12.16.1 | Node 24 LTS의 지원 patch를 골라 packageManager·버전 파일에 정확히 고정 |
| Stackflow React/basic-ui/history-sync | 2.1.4 / 1.19.2 / 2.1.0 | core/config peer도 함께 확인. 패키지마다 major가 다르며 임의 동일 버전 맞추기 금지 |
| React Aria / 날짜 | 1.22.1 / 3.12.4 | controlled 입력·SSR 아닌 SPA·접근성·picker 조합 검사 |
| Query / Zustand | 5.105.3 / 5.0.16 | 서버 데이터와 UI store의 분리 검사 |
| RHF / resolver / Zod | 7.91.0 / 7.0.2 / 4.6.7 | 타입 추론·controlled picker·서버 오류 연결 검사 |
| Motion / Lightweight Charts | 14.9.1 / 5.2.1 | 동적 로딩·카드/페이지 transform 충돌·차트 cleanup 검사 |
| openapi-typescript / fetch | 7.13.0 / 0.17.0 | 현재 OpenAPI 타입 생성·raw 파일/SSE transport 확인 |
| Vitest / RTL / MSW / Playwright | 5.1.0 / 16.3.3 / 3.0.3 / 1.64.1 | MSW의 TS >=5.9 및 Vite·Node peer를 포함해 확인 |

Node의 생산용 LTS 사용 근거는 [공식 release 표](https://nodejs.org/en/about/previous-releases), package metadata는 [공식 npm registry의 React](https://registry.npmjs.org/react/latest), [RN](https://registry.npmjs.org/react-native/latest), [TypeScript 5.9.3](https://registry.npmjs.org/typescript/5.9.3), [openapi-typescript](https://registry.npmjs.org/openapi-typescript/latest)를 따른다. RN·웹의 React를 맞추되 native template의 검증 조합을 웹의 최신 버전 때문에 무조건 올리지 않는다.

착수 PR에서 실제 선택값·peer 해석·설치 결과와 web/mobile 타입 검사·웹 build·iOS/Android 최소 기동 결과를 기록한다. 실패하면 해당 조합을 완료로 두지 않고 호환 버전으로 조정한다. `package.json`의 직접 의존성과 `packageManager`, pnpm lockfile, Node/Xcode/Gradle 버전을 추적한다. CI는 frozen lockfile을 사용한다. 패키지 업데이트는 버전 변경과 회귀 결과를 별도 PR로 검토한다.

## 4. 프로젝트와 파일 배치

```text
frontend/
  apps/
    web/src/
      app/                   # providers, screen registry, route params, auth boundary
      shared/ui/             # Mori 공통 조작/표시 컴포넌트와 접근성 wrapper
      shared/lib/            # 날짜, 오류, SSE parser 등 화면 독립 로직
      features/
        dashboard/           # api/, model/, ui/, tests/
        calendar/
        conversations/
        features/
        parking/
        news/
        market/
        notes/
        documents/
        reminders/
        account/
      mocks/                 # MSW handlers·명시적 개발 fixture
    mobile/
      src/app/               # 시작·native 인증·복귀·실패 화면
      src/bridge/            # 권한 검증·command handler·page generation
      ios/                   # 서명·권한·위젯 확장
      android/               # Gradle·권한·위젯
  packages/
    api-client/              # generated DTO, typed client, transport interfaces
    bridge/                  # protocol·runtime schema·capabilities
    design-tokens/           # 원본 토큰, CSS 변수·RN 값 생성
```

작은 기능은 폴더를 모두 만들지 않고 필요해질 때 나눈다. 특정 화면의 모든 상태·API·스타일을 공통 디렉터리에 몰지 않는다. shared는 features를 import하지 않으며, feature 사이 공유는 공통 계약/도메인 query key 또는 app 조합 계층으로 연결한다. app은 기능들을 조합하고 모듈 import 시 서버 요청·전역 이벤트 등록을 실행하지 않는다.

## 5. 상태의 기준을 하나씩 둔다

| 데이터 | 소유자 | 저장/재생 규칙 |
| --- | --- | --- |
| 주차·일정·메모·파일·기능·구독 | 서버 + TanStack Query | 계정 범위를 query key에 포함, 변경 후 관련 조회 무효화 |
| 선택 탭·상세 ID·back 이력 | Stackflow/history | 스택과 URL을 맞추고 리소스 접근은 다시 서버 확인 |
| 폼 값·dirty·필드 오류 | RHF | 서버 조회값을 초기화하되 dirty 중 재조회로 덮어쓰지 않음 |
| 하단 composer·미전송 초안·음성 단계 | 작은 Zustand UI store | 탭/패널 전환에도 이어짐, 계정 전환 때 정리 |
| 팝오버 열림·작은 선택 상태 | component state | 다른 화면과 공유할 필요가 있을 때만 승격 |
| native capability·현재 기기 권한 | bridge session + UI store | 지원 기능과 OS 허용을 구분, 앱 복귀 때 갱신 |
| run 상태·SSE 이벤트·최종 결과 | 서버 run + 공통 실행 observer | 이벤트 ID 중복 제거·서버 상태 재조회. 페이지 unmount가 실행 취소가 아님 |
| 인증 토큰 | 서버 웹 세션 / RN 보안 저장소 | Zustand·query cache·URL·localStorage에 장기 토큰을 넣지 않음 |

공통 결과 이동 컴포넌트의 이름은 `ResourceLink`, 일정 도메인 폴더는 `features/calendar`로 통일한다. 화면/탭의 사용자 라벨 ‘일정’과 폴더 이름은 별개다.

초안은 처음에 메모리 `DraftRepository` adapter로 관리한다. 탭/패널을 닫았다 여는 동안의 보존과 WebView 프로세스 종료 뒤의 복구는 다르다. 서버의 run·메시지는 재조회할 수 있지만 저장 전 초안·녹음은 메모리 종료 뒤 복원을 보장하지 않는다. FE-06-02에서 계정별 저장 adapter를 분리하고, 영속 초안이 필요하면 저장 범위·TTL·로그아웃/계정 전환 삭제를 명시한 뒤 추가한다. 첨부 bytes·음성 원본·토큰을 초안 store에 영속화하지 않는다. UI는 실제 보관된 초안만 복원하고 누락한 원문을 추정하지 않는다.

Zustand는 전역 저장소가 필요한 UI에 한정한다. 편집 중인 Note 본문을 Query·RHF·Zustand 세 곳에서 각각 수정하지 않는다. 기본 목록은 서버 조회, 편집 폼은 RHF, 저장 완료 후 Query 갱신 순서다. React state/Effect로 모든 fetch와 캐시를 다시 만들지 않는다.

## 6. API와 TypeScript 경계

1. master의 `backend/docs/openapi.json`에서 `packages/api-client` DTO를 생성한다. 생성 파일은 직접 고치지 않고 API 변경과 함께 재생성/차이 검사를 한다.
2. DTO의 wire 값과 UI model을 구분한다. 서버 날짜/ID/nullable 값을 화면별 mapper에서 해석하고 view component가 API 필드 이름을 임의 추측하지 않게 한다.
3. 타입은 런타임 검사가 아니다. Zod는 폼·bridge·client-config와 외부 구조 해석의 경계에서 사용하고, 생성 타입을 `as`로 강제 변환해 검증했다고 하지 않는다.
4. 웹은 같은 origin의 세션 계층을 통하고 native는 보안 저장소의 세션을 사용한다. API base URL·헤더는 transport에서만 결정한다. 사용자 입력으로 내부 runtime URL을 만들지 않는다.
5. JSON 요청과 raw 파일/SSE를 구분한다. 파일은 multipart가 아닌 원본 bytes, SSE는 청크 누적 parser·event ID·재접속·상태 조회로 처리한다.
6. 작성 intent마다 UUID 요청 키를 만들고 같은 재시도에서 보존한다. 수정의 revision을 조회값에서 가져오며 409에는 서버 변경 확인/재편집을 제공한다.
7. 저장 성공 뒤 주차·dashboard·library처럼 관련 query를 갱신한다. 결제·문서 완료를 optimistic success로 표시하지 않는다. 불확실한 POST를 무조건 새 키로 재시도하지 않는다.

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`를 초기 타입 검사 기준으로 둔다. 서버가 `null`로 해제를 표현하는 값과 필드 생략을 구분하며, 예를 들어 주가 schedule 생략=유지/null=해제를 mapper가 보존한다. Vite의 TS 변환만으로 타입 검사가 끝나지 않으므로 CI에서 `tsc --noEmit` 계열 검사를 따로 실행한다. [Vite TS/CSS 안내](https://vite.dev/guide/features), [OpenAPI 타입 생성](https://openapi-ts.dev/introduction), [typed fetch](https://openapi-ts.dev/openapi-fetch/).

## 7. 폼·날짜·선택 입력 구현

모든 폼은 기본값·필드 label·도움말·오류의 위치·submit 상태를 공통 wrapper로 맞춘다. RHF의 defaultValues로 dirty 기준을 정하고 custom picker는 Controller 계층에서 값·blur·오류를 연결한다. 중첩 Select를 열었다고 부모 폼이 submit되거나 닫히지 않게 한다. 버튼의 기본 type과 disabled·pending 의미를 명시한다.

날짜만 있는 종일 일정은 CalendarDate, 하루의 시각은 Time, 실제 timestamp는 zone/UTC로 나누어 다룬다. `YYYY-MM-DD`를 임의 `new Date()`로 읽어 전날로 밀지 않는다. 사용자 timezone·서버 표시 구간을 사용하고 ‘내일’은 기기 시스템 시계만으로 확정하지 않는다. wheel picker의 선택 중 값과 폼 확정값을 분리해 취소는 원래 값을 유지한다.

일정 월 그리드·주/일 timeline은 같은 query와 선택 날짜를 사용한다. 범위 이동 때 인접 범위 조회와 취소/재조회 정책을 정하고, 반복 개인 일정은 현행 API에 없으므로 가짜 반복 저장을 만들지 않는다. [날짜 객체와 시간대](https://react-aria.adobe.com/internationalized/date/), [폼 API](https://react-hook-form.com/get-started), [schema 검증](https://zod.dev/).

## 8. UI·모션·차트 구현 원칙

React Aria는 외형이 없는 조작 기반으로 사용하고 Mori의 토큰·공통 wrapper에서 모양을 정한다. 기본 화면은 페이지, 짧은 선택은 popover/action sheet, 보조 입력은 bottom sheet다. 모든 상세를 큰 Dialog로 열지 않는다. 상세 ID와 복귀 이력은 navigation이 맡고, 모달은 focus trap·배경 접근 차단·닫힌 뒤 trigger 복귀를 맡는다. [React Aria](https://react-aria.adobe.com/getting-started), [Radix 비교 근거](https://www.radix-ui.com/primitives/docs/overview/introduction), [SEED 참고](https://seed-design.io/).

Stackflow는 화면 프레임·back을, Motion은 선택한 카드/내부 공유 요소를 맡긴다. 두 엔진이 같은 요소 transform을 동시에 제어하지 않는다. 카드 시작/끝 snapshot과 컨텐츠를 전환 중 보존하고, 종료 시 비로소 데이터를 한 번에 교체하는 깜빡임을 만들지 않는다. 구조는 [컴포넌트 규격](component-system-2026-11-04.md)의 CardTransitionCoordinator를 따른다. [Stackflow 기능](https://stackflow.so/docs/get-started/introduction), [Motion layout](https://motion.dev/docs/react-layout-animations).

주가 차트는 해당 상세에서 lazy load하고 크기 변경·제거 시 observer와 인스턴스를 정리한다. 국내 1분봉·일봉·종가·빈 세션·부분 데이터의 서버 필드를 보존하고 임의 현재가나 매끄러운 곡선으로 치환하지 않는다. Canvas만으로 설명을 끝내지 않고 기준 가격·시각·등락과 표/요약을 DOM으로 제공한다. Lightweight Charts의 Apache 라이선스와 NOTICE·사용자 접근 가능한 TradingView 링크 요구를 준수한다. [공식 저장소/라이선스 안내](https://github.com/tradingview/lightweight-charts).

## 9. 테스트·검토와 완료 판정

| 검사 | 검증할 실제 위험 | 대표 사례 |
| --- | --- | --- |
| Vitest | 순수 계산/변환 | manual/always 매핑, timezone·range, SSE 청크·이벤트 순번 |
| Testing Library | 사용자의 입력/접근성 | label로 선택, 취소 시 값 보존, 오류 포커스, dirty 보호 |
| MSW | 실제 transport와 화면 연결 | 401/409/422/502·빈값·지연·수집 실패·재접속, 같은 요청 키 재사용 |
| Playwright | 브라우저 탐색과 레이아웃 | 카드 확장/복귀·back·nested picker·tab 스크롤·모션 감소·큰 글자 |
| 실기기 | WebView/OS의 실제 제약 | iOS/Android 키보드·swipe/back·소셜 복귀·녹음·Push·회전 |

UI 구현을 그대로 복제한 테스트보다 상태 전이·계정 경계·복구·시간/금액 해석을 검증한다. 컴포넌트별 상태 예제는 개발 전용 카탈로그로 만들고 운영 마이에 숨은 설정을 넣지 않는다. 초기에는 작은 Vite catalog로 시작해 여러 컴포넌트 변경의 검토가 어려워지면 Storybook 도입을 검토한다.

Playwright mobile emulation은 실제 WKWebView·Android WebView·OS 위젯 검증을 대신하지 않는다. MSW 데이터도 실제 모델/제공자 성공의 근거가 아니다. [MSW](https://mswjs.io/docs/), [Playwright emulation](https://playwright.dev/docs/emulation).

### 01~03 기반 검증을 나누어 제출할 산출물

- **01 웹 기반 PR:** 검증한 Node·pnpm·웹 직접 의존성 버전과 lockfile, 웹 실행/검사·CI 초안.
- 5탭과 상세 한 개, 입력/선택/패널 한 종류, 빈/로딩/오류 예제.
- DTO 생성과 `typecheck`, `lint`, `test`, `build` 실행 결과. 패키지가 설치되지 않은 현재 plan 작업에서는 이 결과를 통과로 기록하지 않는다.
- **03 RN 실험 PR:** native template/React peer·WebView 버전과 mobile 스크립트, 같은 웹·뒤로가기·키보드·safe area의 결과와 미검증 기기 목록. 01의 첫 PR에 RN 완성을 요구하지 않는다.
- React Aria/Stackflow/Motion 조합에서 포커스·중첩·뒤로가기·중단/복귀가 충돌하는지 확인한 기록. 충돌이 남으면 기능 UI 전부를 이 기반으로 확장하지 않는다.

## 10. 유지 원칙

현재 PoC는 디자인과 사용자 동선의 기준이며 데이터 의미는 서버가 기준이다. 라이브러리 선택은 이번 요구를 충족하는 범위로 시작하고, 새 의존성을 넣을 때 해결할 문제·대안·번들/라이선스·기존 상태와의 책임을 기록한다. 백엔드 726개/Hermes 91개 검사를 프론트 완료 증거로 옮기지 않는다. 단계별 완료는 [작업 분해표](poc-to-react-work-breakdown-2026-11-04.md)에 사용자 구현 커밋과 검증 결과가 생길 때 갱신한다.
