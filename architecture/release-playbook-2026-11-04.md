# React 웹·RN 앱 릴리스 실행서

작성일/공식 자료 확인일: 2026-11-04 · 상태: 구현할 실행 계획 · 기준 서버: master `6285aba` / API 0.9.0

[버전·배포 원칙](app-release-versioning.md) · [프론트 구조](../front/react-native-webview-plan.md) · [프론트 실행 계획](../front/implementation-roadmap-2026-10-06.md) · [개발 규약과 라이브러리 선택](../front/frontend-engineering-guide-2026-11-04.md) · [운영 runtime 전환](runtime-operations-roadmap-2026-11-03.md)

이 문서는 프론트 개발자가 release 준비부터 실제 인수까지 수행할 작업 목록이다. 예제의 버전·build·도메인·Git SHA는 형식 설명이며 현재 배포값이 아니다. 제품 코드·CI·client-config는 아직 없으므로 아래 작업을 완료 상태로 표시하지 않는다. UI는 사용자가 개발하고 AI는 요청한 계약 보완·검토를 지원한다.

## 1. 작업 단위와 의존성

| ID | 작업 | 선행 조건 | 완료 증거 |
| --- | --- | --- | --- |
| R-01 | toolchain·앱 ID·버전 원본 확정 | 프론트 기반 착수 | lockfile·빌드 도구 버전·환경별 식별자 기록 |
| R-02 | bridge·client-config schema와 상태 모델 | RN 최소 실험·B-18 | 런타임 schema 검사·실패 fixture·서버 계약 |
| R-03 | release manifest와 호환 행렬 생성 | R-01/R-02 | artifact별 SHA·digest·지원 계약 기록 |
| R-04 | 웹 PR preview와 자동 검사 | React 공통 UI·테스트 | 모바일 preview·타입/lint/테스트/build 결과 |
| R-05 | 서명 native release build | RN 프로젝트·자격 증명 준비 | iOS archive/Android AAB·실기기 기동 |
| R-06 | staging 첫 세로 흐름 인수 | B-18·API/worker 환경 | 로그인→주차→대시보드→채팅/SSE 결과 |
| R-07 | 불변 웹 release 게시·선택 정책 | R-03/R-04/R-06 | 공개 전 direct URL·asset·상태/탐색 확인 |
| R-08 | 내부 앱 배포·호환 시험 | R-05/R-07 | 구/신 앱×웹×API 조합별 기기 결과 |
| R-09 | production 단계 공개·관측 | 인수·스토어 설치 가능 상태 | 대상/정책 revision·지표·승격 결정 기록 |
| R-10 | 실패 복귀·지원 종료·자산 정리 | 최소 두 release/build 확보 | 웹 복귀·native 수정 build·old chunk 시험 |

R-01~R-04는 fixture로 시작할 수 있다. R-06 완료에는 실제 사용자와 서버 데이터가 필요하다. 기기/제공자가 없어서 fixture로 통과한 결과는 해당 단계의 UI/계약 검사로만 기록한다.

## 2. R-01: 버전과 빌드 도구 고정

### 작업

- package manager 버전과 workspace lockfile을 한 곳에서 관리한다. 웹 React와 RN peer React 요구 범위를 함께 확인한다.
- React/RN/WebView/TypeScript와 생성 클라이언트·테스트 도구의 peer 범위를 대조한다. 최신 태그가 모두 상호 호환한다는 전제를 두지 않는다. 검증한 정확한 버전과 install/build 결과는 개발 규약의 baseline에 기록한다.
- Node·Java/JDK·Xcode·CocoaPods·Gradle wrapper와 최소 OS를 실제 RN build 기준으로 확정한다. 서버 Python 버전과 프론트 toolchain은 별도다.
- production과 staging의 앱 식별자·HTTPS origin·Universal Link/App Link·callback을 표로 정한다. 개발용 localhost/port-forward를 배포 앱에 넣지 않는다.
- 앱 표시 버전과 플랫폼별 build counter를 `frontend/release/app-version.json` 같은 검토 가능한 원본에 둔다. 아직 저장소에 있는 실제 파일명으로 해석하지 않는다.

### build 번호 발급 규칙

1. release 준비에서 iOS/Android 각각 다음 번호를 예약한다.
2. CI는 플랫폼·환경별 build job을 직렬화하고 사용된 번호와 중복되지 않는지 확인한다.
3. 같은 source라도 다시 만든 바이너리에는 새 번호를 사용한다. 내부 테스트에서 통과한 **같은 바이너리의 track 승격**은 다시 빌드하지 않는다.
4. build 완료 artifact에는 app version·build·Git SHA·서명 환경·toolchain을 기록한다.

초기 예시는 iOS `0.1.0 (1)`, Android `versionName=0.1.0/versionCode=1`이다. 이는 아직 발급된 버전이 아니다. Apple 표시값은 숫자 3부분, build는 1~3숫자부분이 가능하며 Mori는 정수 한 개로 단순화한다. Android counter는 양의 정수이며 재사용하지 않는다. [Apple 표시](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring) · [Apple build](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion) · [Android version](https://developer.android.com/studio/publish/versioning).

## 3. R-02: client-config와 bridge 계약

### 서버에 추가할 client-config 예시

아래는 B-18의 **응답 후보**다. 현재 OpenAPI나 운영 서버의 응답이 아니다. 기존 모바일 계약의 필드와 구현 시 함께 확정하며, `schema_version`·`api_contract_revision`은 이번에 구체화한 후보다.

```json
{
  "schema_version": 1,
  "policy_revision": 12,
  "expires_at": "2026-11-05T00:00:00Z",
  "platform": "ios",
  "min_supported_build": 1,
  "latest_build": 1,
  "update_mode": "none",
  "store_url": null,
  "web_release": "web-a1b2c3d4e5f6-104",
  "fallback_release": "web-112233aabbcc-103",
  "bridge_protocol": 1,
  "required_capabilities": ["navigation.back.v1"],
  "api_contract": "v1",
  "api_contract_revision": 1,
  "enabled_features": ["parking", "chat", "calendar"]
}
```

RN은 설정의 release ID를 앱에 내장한 허용 origin/경로로 해석한다. 서버가 보내는 임의 URL을 그대로 WebView의 신뢰된 페이지로 열지 않는다. `store_url`도 스토어의 허용 host·앱 식별자를 검증한다. 브라우저 platform은 native build와 필수 capability가 없는 별도 정책으로 응답한다.

handshake 뒤 primary 웹의 필수 capability가 부족하면 해당 UI를 활성화하지 않는다. `fallback_release` 문자열만 믿고 전환하지 않고 fallback manifest의 bridge/API 범위·필수 capability도 별도로 검증한다. 서버/로컬 정책에 그 호환 근거가 있고 현재 앱이 충족할 때 **한 번만** fallback을 시도한다. 같은 release의 재선택·반복 실패·알 수 없는 manifest는 native 복구 화면으로 종료하며, 선택 기능의 권한 거부를 필수 앱 업데이트로 오해하지 않는다. fallback도 비호환이면 임의 latest로 우회하지 않는다.

`enabled_features`는 UI 공개 여부다. Pro 권한·파일 소유권·예약 실행 허용을 대신하지 않는다. `min_supported_build`와 `latest_build`도 해당 플랫폼의 설치 가능한 release만 가리킨다.

### RN bootstrap 상태

| 상태 | 다음 동작 | 사용자에게 보일 상태 |
| --- | --- | --- |
| 설정 조회 중 | 제한된 시간 동안 요청·취소 가능 | native 시작 화면 |
| 유효한 정책 | 허용 release 로드와 handshake | 웹 로딩→정상 화면 |
| 일시 실패 + 유효한 마지막 정책 | 같은 호환 release 한정 재시도 | 연결 재시도와 마지막 확인 상태 |
| 만료·최초 실패·모르는 schema | 임의 latest로 진행하지 않음 | native 재시도/업데이트 안내 |
| 필수 앱 update | 설치 가능 store 경로 확인 | 이유·설치·재확인 동작 |
| WebView 프로세스 종료 | 안전한 reload 뒤 인증·서버 run/메시지·지원하는 탐색을 복구 | 저장 전 메모리 초안/녹음은 복구 보장 없이 실제 보관분만 복원 |
| 세션 만료 | 인증 복구/로그인 | 다른 계정 자료를 숨긴 로그인 화면 |

첫 로드, 리다이렉트, 외부 링크, `target=_blank`/새 창, 로그인 callback과 일반 탐색을 각기 검사한다. WebView의 origin whitelist 한 개가 모든 경로 검증을 대신하지 않는다. Android 첫 로드는 navigation callback만으로 막을 수 없다는 공식 제한도 테스트한다. [WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md).

## 4. R-03: release manifest와 호환 행렬

manifest는 API가 응답하는 client-config와 구분한다. manifest는 **무엇을 빌드했고 무엇과 검증했는지**를 보관하고 client-config는 설치된 앱에 **현재 무엇을 선택할지**를 알려준다.

### artifact별 기록

| artifact | 필수 기록 |
| --- | --- |
| 웹 | release ID·full Git SHA·lockfile hash·build ID·정적/이미지 digest·asset base·지원 bridge/API·필수 capability |
| iOS | 표시 버전·build·bundle ID·Git SHA·Xcode/SDK·archive checksum·symbols·테스트 대상 OS |
| Android | 표시 버전·versionCode·applicationId·Git SHA·JDK/Gradle/SDK·AAB checksum·mapping/symbols |
| API | service version·image digest·API 계약/호환 revision·DB head·구/신 클라이언트 인수 |
| 정책 | revision·선택 release·이전 정상 release·지원 앱 범위·유효기간·공개 대상·검토 기록 |

서명 파일·토큰·OAuth code·대화/음성 원문은 artifact metadata에 넣지 않는다. 오류 추적에서는 app build/web release/bridge/API revision과 request/run ID로 연결한다. 필요한 source map과 native symbols는 접근을 제한한 디버깅 artifact로 보관한다.

### 최소 호환 행렬

| 앱 | 웹 | API/bridge | 통과해야 하는 것 |
| --- | --- | --- | --- |
| 최소 지원 iOS/Android build | 현재 웹 | 현재 API·이전 protocol | 로그인·주차·SSE·파일·뒤로가기 |
| 최소 지원 build | 다음 웹 | 현재/다음 API | 선택 native 기능 fallback·추가 필드 |
| 다음 build | 현재 웹 | 호환 protocol 교집합 | 앱 업데이트 직후 기존 웹 정상 사용 |
| 다음 build | 다음 웹 | 다음 API·protocol | 신규 기능·권한 거부·중단 복구 |
| 브라우저 | 현재/다음 웹 | native capability 없음 | 텍스트·직접 폼·파일과 기기 기능 대체 |
| 앱/브라우저 | 직전 정상 웹 | 배포 후 현재 DB/API | 웹 rollback 뒤 새로 저장한 데이터 조회 |

모든 가능한 조합을 무한 지원하지 않는다. 지원 중인 실제 조합을 manifest에 등록하고, 종료된 protocol이 참조하는 앱 사용량·스토어 설치 가능 상태·대체 경로를 확인한 뒤 지원 종료를 공지한다. ‘최신 두 버전’이라는 숫자만으로 계약을 삭제하지 않는다.

## 5. R-04/R-05: PR 검사와 build pipeline

### 모든 프론트 변경 PR

1. frozen lockfile 설치·dependency 경계·타입 검사·lint.
2. 공통 UI story/fixture, keyboard/focus, 긴 목록·오류·빈값·로딩 상태 확인.
3. 도메인 모델·폼·API adapter·SSE parser·bridge schema의 의미 있는 검사.
4. 웹 production build, preview URL과 모바일/태블릿 화면 확인.
5. API/bridge 공개 타입의 breaking diff 검사. 생성 파일과 수기 transport를 구분한다.

### native 변경 PR

1. R-01 baseline의 iOS/Android release build를 모두 실행한다.
2. 권한·callback·위젯 extension·native module 링크·WebView 시작/복귀를 확인한다.
3. Android 서명 AAB와 iOS archive의 bundle ID·환경·version/build를 검사한다.
4. 실제 기기 smoke와 내부 배포를 완료한 artifact에만 release 승격 표시를 붙인다.

웹의 타입 검사 성공은 native build 성공이 아니다. 시뮬레이터 통과도 실제 마이크·Push·위젯 인수를 대신하지 않는다. 공개되지 않은 키로 성공을 꾸미거나 배포 환경의 임의 API를 호출하는 검사는 만들지 않는다. [RN iOS release build](https://reactnative.dev/docs/publishing-to-app-store) · [RN Android signing/AAB](https://reactnative.dev/docs/signed-apk-android).

## 6. R-06/R-07: staging과 웹 승격

### 기본 staging 인수

- 실제 소셜 로그인→이름/테마 저장→logout/다른 계정 로그인.
- 주차 저장→새로고침→대시보드 시간 범위→같은 상세 복귀.
- durable runs 접수→관찰 종료→SSE ID로 이어 읽기→완료/취소→결과 리소스 확인.
- 폼 revision 충돌·전송 응답 유실·같은 요청 키 재시도·오프라인 복귀.
- 파일 업로드/문서 작업 접수와 완료 파일을 구분하고 취소/재시도·다운로드를 확인.
- 녹음·전사·앱 전환·키보드·safe area와 외부 링크에서 입력/권한 상태 유지.

### 웹 게시 순서

1. 검증한 API/DB를 staging에 반영한다.
2. 새 웹 release를 불변 경로에 게시하고 direct URL로 확인한다. 아직 일반 사용자의 포인터를 바꾸지 않는다.
3. asset base·basename·OAuth 고정 callback·새 창·딥링크·SSE 프록시를 확인한다.
4. 현재 앱/다음 앱에서 호환 행렬을 통과한 뒤 내부 대상의 정책 revision을 올린다.
5. 같은 artifact를 production에 승격하고 선택 포인터만 바꾼다. production에서 다른 파일을 다시 만들지 않는다.

release 경로 아래 hash 자산은 `max-age/immutable`, bootstrap/config는 재검증, 개인 응답은 `no-store`로 구분한다. 뒤로가기는 브라우저 bfcache로 과거 화면을 복원할 수도 있으므로 재활성 시 세션과 서버 상태를 확인한다. `no-cache`만으로 계정 전환 시 과거 DOM이 안전하게 지워진다고 가정하지 않는다. [HTTP Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control).

## 7. R-08/R-09: 내부 앱·단계 배포

iOS는 TestFlight의 내부 그룹부터, Android는 Play 내부 test track부터 시작한다. 실제 단말의 OS/버전·권한·계정·앱 build/web release를 시험 기록에 남긴다. 외부 tester·production 심사의 선행 조건은 당시 계정/스토어 콘솔에서 확인한다. [TestFlight](https://developer.apple.com/testflight/) · [Play 테스트](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en).

Mori의 초기 웹 공개는 운영자/내부 allowlist부터 시작한다. 더 큰 대상 배포가 필요해지면 설치별 안정된 cohort를 선택하고 실행할 때마다 웹이 달라지지 않게 한다. 정책 변경 주체와 시각·범위·복귀값을 기록한다. 앱 build의 스토어 rollout과 웹 선택 cohort는 서로 다른 제어다.

Apple의 update phased release는 7일간 자동 업데이트 대상에 단계 제공할 수 있고, 사용자의 수동 다운로드는 별개다. 첫 앱 출시와 같은 의미로 적용하지 않는다. Play staged rollout은 배포를 중단해도 이미 받은 사용자의 앱을 되돌리지 않는다. 따라서 새로운 웹·API는 새 앱이 먼저 설치된 경우와 아직 이전 앱인 경우를 모두 지원해야 한다. [Apple phased update](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/) · [Play staged rollout](https://support.google.com/googleplay/android-developer/answer/6346149?hl=en).

### 승격 판단에 남길 정보

- 앱 시작/WebView 로드 실패·native crash·JS fatal·API 오류를 release별로 확인한다.
- 로그인 복귀·주차 저장·SSE 복구·녹음/파일 처리의 실패 원인과 사용자 지연을 구분한다.
- 웹 chunk 404·정책 schema 실패·bridge timeout·잘못된 새 창·외부 origin 차단을 관측한다.
- 표본이 작은 내부 시험에서 p95나 성공률을 확정적인 운영 SLO로 만들지 않는다. 수집한 표본·기기·조건을 함께 적는다.
- 배포 확대는 자동 성공 가정이 아니라 기록한 기준과 실제 결과에 따라 결정한다. 이번 문서에 CI나 운영 지표가 이미 있는 것으로 표시하지 않는다.

## 8. R-10: 복귀 훈련과 지원 종료

| 상황 | 즉시 조치 | 후속 복구 |
| --- | --- | --- |
| 웹 시각적/동작 오류 | 호환 이전 release 선택, 신규 기능 중지 | 수정 웹 artifact를 새 ID로 검증·승격 |
| 잘못된 client-config | 이전 검증 정책으로 revision 전진 수정 | 잘못된 정책 캐시·만료·최초 실행 인수 |
| native 녹음/로그인 오류 | 해당 기능 제한과 텍스트/재로그인 대체 | 더 높은 build의 수정 바이너리 배포 |
| 신규 API 오류 | 기존 호환 경로 유지·부분 기능 중지 | 이미지 복귀 또는 호환 수정 배포 |
| migration 이후 읽기 오류 | 영향 데이터·코드·백업 확인 | DB 호환 검증 후 복구, 파괴 rollback 자동 금지 |
| 앱 update 불가/스토어 지연 | 지원 가능한 이전 웹·기능 유지 | 해당 플랫폼 설치 가능 후 정책 전환 |

설정 포인터를 되돌리는 것과 이미 열린 WebView를 즉시 reload하는 것은 다르다. 기존 화면에는 안전한 갱신 시점에서 새 release를 적용한다. 작성 중 폼·녹음·업로드·SSE가 있으면 작업/초안과 run ID를 보존하고 사용자에게 갱신을 안내한다. 서버 권한 회수는 old 화면을 유지한다고 무시할 수 없다.

강제 업데이트는 필요 근거·플랫폼·최소 build·스토어 가용성·대체 경로를 함께 검토한다. 단순 뉴스/기능 추가로 채팅·기록 전체를 차단하지 않는다. native module의 새 capability가 선택 기능이면 이전 앱의 텍스트/기존 기능을 유지한다. bridge major가 필수로 바뀌어 대체할 수 없으면 먼저 호환 앱을 배포하고 종료 정책을 나중에 적용한다.

release 삭제는 지원 앱의 참조·활성 세션·동적 chunk·직전 정상 복귀 경로를 확인한 뒤 한다. 예시 보관 기간 30일이 지났어도 현재 지원 앱이 가리키는 release는 유지한다. 보안상 차단이 필요한 release는 호환 수정본으로 이동시키고 이유를 기록한다.

## 9. 실제 변경 시나리오

| 요구 | 웹 변경 | native 변경 | 버전/공개 동작 |
| --- | --- | --- | --- |
| 주차 카드 여백·애니메이션 수정 | 있음 | 없음 | 새 web release, 기존 앱 호환 검사 후 선택 |
| 기록 보관함 검색 추가 | 있음 | 없음 | API가 있으면 웹만, 없으면 추가형 API 선배포 |
| 녹음 모듈/오디오 형식 교체 | 전사/입력 UI | 있음 | 새 app build와 capability 계약 검증, 이전 앱 fallback |
| 큰 글자에서 선택 패널 수정 | 있음 | 필요 여부 검토 | CSS 수정만이면 웹, native inset/키보드 코드면 앱도 |
| 주가 차트 라이브러리 교체 | 있음 | 보통 없음 | 접근성·캔들 의미·성능·라이선스 검사 후 웹 release |
| 위젯 신규 레이아웃 | 웹 대시보드와 별도 | 있음 | 새 앱 build/확장·snapshot 호환 인수 |
| API 응답 필드 이름 변경 | 있음 | 직접 사용하는 native도 영향 | 구 필드 병행→신 클라이언트→지원 종료 후 제거 |
| bridge 입력을 v1에서 v2로 변경 | 있음 | 있음 | protocol 공존 또는 별도 호환 웹, 스토어 선배포 |
| RN JS 오류 수정 | 없음 또는 연동 UI | 초기에는 있음 | OTA 없이 새 바이너리 build |

## 10. 완료 판정과 추후 OTA

R-01~R-10은 계획 문서의 존재로 완료되지 않는다. 실제 코드·자동 검사·artifact·기기 결과·승격 기록을 해당 작업에 연결한다. 웹 source를 build한 사실만으로 스토어 출시를 완료 처리하지 않는다.

초기에는 RN JS OTA를 쓰지 않는다. 나중에 채택한다면 native code가 바뀔 때 새 build가 필요하고, 업데이트가 그 native code와 일치하는 runtimeVersion을 요구한다. 채널·runtimeVersion·서명·부분 배포·복구를 실제 검증한 뒤 별도 계획 변경으로 도입한다. WebView의 HTTPS 페이지 변경을 Expo OTA 성공으로 기록하지 않는다. [Expo runtime versions](https://docs.expo.dev/eas-update/runtime-versions/).

이 실행서는 공식 문서를 바탕으로 Mori에 적용할 절차를 제안한다. 실제 앱 ID·도메인·최소 OS·라이브러리 baseline·서명·CI·스토어 계정은 구현 시 확인하며, Toss 웹 결제 구현을 앱 구매/복원 검증으로 계산하지 않는다.
