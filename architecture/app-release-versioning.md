# 웹·앱 버전과 독립 배포 계획

갱신일: 2026-11-04 · 상태: 제품 배포 설계, 실제 React/RN·client-config·배포 workflow 구현 전 · 서버 기준: master `6285aba` / API 0.9.0

[전체 계획](../plan.md) · [React/RN 구조](../front/react-native-webview-plan.md) · [단계별 릴리스 실행서](release-playbook-2026-11-04.md) · [모바일 서버 계약](../back/mobile-client-contracts.md)

이 문서는 Mori에 적용할 버전·호환·배포 규칙이다. 아래 숫자와 산출물 예시는 아직 발급하거나 배포한 값이 아니다. 당근 사례에서 확인한 사실은 [공식 자료 재조사](../front/industry-architecture-research-2026-11-04.md)로 분리하며, 당근의 내부 앱 버전·지원 종료 정책을 추정해 Mori의 근거로 쓰지 않는다.

## 1. 웹과 앱이 함께 배포되는 방식

Mori는 React 웹 화면을 RN의 주 WebView 한 개에서 연다. RN JS와 네이티브 모듈은 앱 바이너리에 묶고, 원격 HTTPS 웹은 독립 배포한다. 초기에는 **RN JavaScript OTA를 도입하지 않는다.** 원격 웹 갱신과 RN JS OTA는 다른 경로다. Expo/EAS는 후속 도입 여부를 별도 결정하며 첫 출시의 필수 서비스가 아니다.

| 변경 대상 | 산출물 | 사용자에게 전달되는 경로 | 새 앱 build 필요 |
| --- | --- | --- | --- |
| 웹 카드·목록·폼·카피·CSS | React 정적 release | HTTPS에서 호환 release 선택 | 기존 bridge/API만 쓰면 불필요 |
| 웹의 새 API 사용 | 웹 release와 API 계약 | 서버 선배포 후 웹 공개 | 기기 기능이 같으면 불필요 |
| 녹음 SDK·네이티브 모듈·권한·로그인 복귀 설정 | 서명 iOS/Android 앱 | TestFlight/Play 내부 테스트 후 스토어 | 필요 |
| RN JS·WebView 설정·native 오류 화면 | RN JS를 포함한 앱 바이너리 | 스토어 앱 갱신 | 초기 정책상 필요 |
| OS 위젯 UI·앱 확장 | 앱 바이너리/확장 | 스토어 앱 갱신 | 필요 |
| Mori API·worker·DB | backend 이미지·migration | k3s 서버 배포 | API 호환성에 따라 판단 |
| Hermes 도구·gateway·문서 worker | Hermes 이미지·설정 | 내부 runtime 배포 | 클라이언트 계약이 같으면 불필요 |
| 검색 엔진 설정 | SearXNG 이미지/설정 | 내부 서비스 배포 | 불필요 |

웹 버튼 하나를 추가한다고 모두 앱 업데이트가 되는 것은 아니다. 반대로 웹만 바꿔 설치된 앱에 녹음 모듈이나 새 OS 권한을 추가할 수는 없다. RN의 스토어 배포도 플랫폼 서명과 release build를 거친다. [RN iOS 배포](https://reactnative.dev/docs/publishing-to-app-store) · [RN Android 배포](https://reactnative.dev/docs/signed-apk-android).

## 2. 따로 관리할 버전

| 구분 | Mori 규칙·예시 | 바꾸는 시점 | 비교 방법 |
| --- | --- | --- | --- |
| 제품 앱 표시 버전 | 초기 예시 `0.1.0`, 이후 `1.0.0` | 사용자에게 알릴 제품 기능/수정 묶음 | major/minor/patch 숫자 비교 |
| iOS build | `CFBundleVersion=1`, 다음 업로드 `2` | 새 iOS 바이너리를 생성·업로드할 때 | 해당 앱 식별자의 증가 정수 |
| Android build | `versionCode=1`, 다음 업로드 `2` | 새 Android 바이너리를 생성·업로드할 때 | 해당 applicationId의 증가 정수 |
| 웹 release | `web-<Git SHA 12자리>-<build ID>` | 새 정적 산출물을 만들 때 | 순서 비교 없이 불변 ID로 식별 |
| API URL 계약 | `/v1` | 기존 클라이언트를 깨는 공개 계약 재설계 시 | 지원 계약 목록으로 판단 |
| API 서비스 버전 | 현행 `0.9.0` | backend 구현 릴리스 | 서비스 추적용, 앱 호환을 이것만으로 판정하지 않음 |
| bridge protocol | 초기 `1` | 메시지 envelope/필수 의미가 비호환 변경될 때 | 지원 major의 교집합 |
| capability | 예: `audio.record.v1` | 개별 native 기능의 입력/결과 계약 변경 | 정확한 이름/버전 포함 여부 |
| client-config schema | 초기 제안 `schema_version=1` | 설정 응답 구조가 비호환 변경될 때 | RN bootstrap이 지원하는 schema |
| 정책 revision | 증가 정수 | release 선택·최소 build·기능 공개 정책 변경 | 이전 revision과 유효기간 확인 |

iOS 표시 버전은 `CFBundleShortVersionString`, Android 표시 버전은 `versionName`에 넣는다. Apple 표시값은 점으로 구분한 숫자 3개 형식이므로 `0.1.0-beta.1` 같은 문구를 해당 필드에 넣지 않는다. `internal/staging/production`은 별도 채널 metadata다. [Apple 표시 버전](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring).

Apple build 값은 숫자 1~3부분 형식을 지원하지만 Mori는 관리가 단순한 증가 정수 한 개로 통일한다. Android `versionCode`는 이미 사용한 값을 재사용하지 않고 증가시킨다. Play의 상한 2,100,000,000 안에서 관리하며 긴 날짜·시각 문자열을 정수로 붙여 만들지 않는다. 두 플랫폼의 build 번호가 같을 필요는 없다. **플랫폼을 넘어 같은 counter를 공유한다는 요구도 없다.** [Apple build 값](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion) · [Android 버전 지정](https://developer.android.com/studio/publish/versioning).

Mori의 앱 SemVer는 제품 정책이다. 큰 사용자 경험/호환 변경은 major, 호환되는 기능 추가는 minor, 수정은 patch로 묶는다. 이 값이 bridge나 API major를 자동으로 바꾸지는 않는다. 버전 비교에서 `1.10.0`을 `1.9.0`보다 작게 읽는 문자열 비교를 쓰지 않는다.

## 3. 첫 구현에서 만들 버전 관리 파일

아래는 **master에 추가할 설계 경로**다. plan 브랜치에 실행 코드를 만든 것이 아니다.

```text
frontend/release/
  app-version.json          # 표시 버전, 플랫폼별 다음 build, 채널
  compatibility.schema.json # release/client-config 응답 검증
  compatibility.json        # 검토한 앱·웹·bridge·API 조합
  releases/                 # Git SHA·산출물 digest·검증/승격 기록
```

`app-version.json` 변경은 release 준비 PR에서 검토한다. build 발급은 플랫폼별로 직렬화하고 업로드 기록의 최대값과 대조한다. 취소·실패한 업로드 번호도 재사용하지 않는 Mori 정책으로 시작한다. 같은 검증 바이너리를 내부 테스트에서 production으로 승격할 때는 다시 빌드하거나 번호를 바꾸지 않는다. 소스를 고쳐 재빌드하면 새 번호를 발급한다.

웹 release에는 full Git SHA, lockfile hash, toolchain, build ID와 정적 파일/이미지 digest를 함께 남긴다. 같은 SHA를 재빌드해 다른 bytes가 생겨도 기존 ID를 덮어쓰지 않는다. `web-<SHA>-<build ID>`를 사용하는 이유다. 초기에는 정적 이미지가 staging/production 공통 runtime config를 읽도록 구성하고, environment별 빌드가 불가피하면 서로 다른 산출물로 명시한다. 서로 다른 파일을 ‘동일 artifact 승격’으로 부르지 않는다.

## 4. 앱 시작과 호환 웹 선택

```text
RN 내장 시작/오류 화면
 → 고정 HTTPS client-config 조회
 → schema·유효기간·platform/build·허용 origin 검증
 → 호환 web release 로드
 → bridge handshake와 실제 capability 교집합 확인
 → 세션 복구 → 본인 대시보드
```

`GET /v1/client-config`와 웹 세션/교환권은 B-18의 **미구현 서버 계약**이다. `/v1/capabilities`는 worker/제공자 준비 상태이며 release 선택 API가 아니다. 브라우저는 native build가 없는 `web` platform으로 처리하고 필수 native capability를 요구하지 않는 release를 선택한다.

설정 요청의 app build/capability는 화면 호환 정보다. 사용자 인증이나 Pro 판정으로 쓰지 않는다. origin뿐 아니라 허용된 release 경로·리다이렉트·새 창을 검증한다. WebView `originWhitelist`는 origin 기준이고 Android의 `onShouldStartLoadWithRequest`는 최초 로드에 호출되지 않으므로 시작 URL 검사도 별도로 필요하다. [WebView 공식 reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md).

| 조합 | Mori가 선택할 동작 |
| --- | --- |
| 이전 앱 + 같은 bridge의 새 웹 | 해당 조합의 인수 결과가 있으면 새 웹 제공 |
| 이전 앱 + 선택적인 새 녹음 기능 | 텍스트 입력은 유지하고 지원하지 않는 녹음 동작만 대체/비활성 |
| 이전 앱 + 필수 bridge v2 웹 | v1 호환 웹 유지, v2 웹 배포 제외 |
| 새 앱 + 이전 웹 | 새 앱이 명시적으로 지원하는 이전 protocol로 실행 |
| 새 웹 + API의 추가 필드 | 생성 타입/런타임 검증의 호환 정책에 따라 수용 |
| 이전 웹 + API 필드 제거 | 지원 종료 전 제거 금지, 병행 계약 또는 다음 API major 필요 |
| 설정 실패 + 유효한 마지막 정책 | 마지막 검증 release 시도, 실패하면 RN 재시도 화면 |
| 최초 실행/만료 정책/알 수 없는 schema | 검증되지 않은 latest로 우회하지 않고 연결 복구 안내 |
| 세션 만료·구독 회수 | 웹 로드 성공과 무관하게 서버 권한 검사 적용 |

현재 native 권한 허용과 capability 지원은 다르다. `audio.record.v1`이 있는 앱도 마이크 권한은 거부될 수 있다. 사용자가 권한을 거부했다고 앱 버전이 오래됐다고 안내하지 않는다.

## 5. 웹 배포와 캐시

초기 구조는 k3s/Harbor를 사용한다. React 웹을 불변 release 경로에 빌드하고, release별 정적 이미지/Service 또는 불변 자산 저장 경로를 통해 제공한다. `/releases/<release-id>/`의 asset base·라우터 basename을 맞추고 `/v1`, OAuth callback, Universal Link/App Link 확인 경로는 고정한다. 실제 origin과 앱 식별자는 착수 단계에서 정한다.

| 대상 | 초기 캐시 정책 | 이유 |
| --- | --- | --- |
| hash가 있는 JS/CSS/폰트·불변 release 자산 | 긴 `max-age`와 `immutable` | 같은 URL을 덮어쓰지 않는 산출물 |
| bootstrap·release 포인터 | `no-cache`와 ETag 등 재검증 | 호환 release 변경을 다시 확인 |
| client-config | 정책 유효기간·ETag와 정해진 재검증 | 캐시 저장 가능성과 fallback 허용 기한을 구분 |
| 인증·개인 데이터·문서 | 기존 `no-store`와 공용 캐시 금지 | 사용자 자료가 공유 캐시에 남지 않도록 처리 |
| Web Push service worker | 기기 알림 계약에 필요한 경우 별도 구현 | 초기 앱 전체 offline/update service worker와 구분 |

`no-cache`는 저장 금지가 아니라 재사용 전 검증을 요구한다. 자산의 `immutable`은 같은 URL의 내용이 바뀌지 않는 조건에서만 사용한다. 초기에는 앱 전체를 cache-first로 감싸는 PWA service worker를 추가하지 않는다. 이미 있는 Web Push 예시와 웹 release 업데이트 체계를 혼동하지 않는다. [HTTP 캐시 지시어](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control).

지원 중인 앱이 참조하는 release, 직전 정상 release, 최근 30일 release의 합집합을 초기 보관 정책으로 제안한다. 기간이 지났다는 이유만으로 지원 앱의 chunk를 지우지 않는다. 취약 release는 접근을 차단하고 호환 수정본으로 전환한다. 보관 수·활성 사용·비용은 운영 실측 후 조정한다.

웹 세션 계층의 SSE 프록시는 버퍼링하지 않는다. 원본 파일 10MB와 JSON escape를 포함한 전송 크기를 구분하며 파일 전송 설정이 SSE를 함께 버퍼링하지 않게 한다. 오래 열린 화면에서 동적 chunk가 사라지지 않도록 release 삭제 시점을 검증한다.

## 6. 앱과 웹의 배포 순서

1. API/DB는 기존 앱이 읽을 수 있는 추가형 변경을 먼저 반영한다.
2. 새 웹 산출물을 게시하되 아직 모든 사용자에게 선택하지 않는다.
3. 최소 지원 앱·현재 앱·다음 앱과 웹/API 조합을 staging에서 검증한다.
4. native 변경이 있으면 서명 바이너리를 TestFlight/Play 내부 테스트에 올린다.
5. 실제 기기·계정·권한·초안·SSE·파일·딥링크를 인수한다.
6. 스토어에서 해당 build가 설치 가능한지 확인하고 platform별 정책을 공개한다.
7. 웹은 내부 대상→확대 순으로 포인터를 승격한다. 문제 시 기능과 웹 선택을 이전 호환값으로 돌린다.

iOS TestFlight는 내부/외부 테스트를 나누며 외부 시험에는 별도 검토가 필요할 수 있다. Play도 내부·비공개·공개 test track을 제공한다. 첫 출시에 필요한 계정별 검증 요건은 출시 시 콘솔에서 다시 확인한다. 검사 수·대기 시간은 이번 계획의 보장값으로 쓰지 않는다. [TestFlight](https://developer.apple.com/testflight/) · [Play 테스트 track](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en).

앱 update의 iOS phased release는 자동 업데이트 대상에 대한 단계 배포이며 사용자의 수동 설치를 막는 기능이 아니다. 웹 대상 배포와 스토어 단계 배포도 별개다. Play의 staged rollout 중단도 이미 설치한 앱을 이전 바이너리로 되돌리지 않는다. 구체 운영은 [실행서](release-playbook-2026-11-04.md)를 따른다. [Apple phased release](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/) · [Play staged rollout](https://support.google.com/googleplay/android-developer/answer/6346149?hl=en).

## 7. 갱신·강제 업데이트·복구

웹 release 전환은 새 시작이나 안전한 화면 복귀에서 적용한다. 녹음·전사·파일 업로드·제출 중 폼·진행 중 채팅 관찰에서 강제 reload하지 않는다. draft와 run ID/마지막 SSE ID를 보관하고, 서버 상태 조회와 사용자 의도를 확인한 뒤 새 화면으로 간다. 패널 닫기는 작업 취소가 아니다.

권장 업데이트는 기존 이용을 유지하며 안내한다. 필수 업데이트는 지원할 수 없는 protocol·중대한 수정 필요 등 근거를 기록하고 **해당 플랫폼의 배포 build가 실제 설치 가능한 경우** 적용한다. iOS가 승인됐다고 Android 최소 build를 동시에 올리지 않는다. 단순 신규 기능 홍보를 위해 전체 앱을 차단하지 않는다.

웹 오류는 호환 release 포인터를 되돌린다. native 오류는 기능 중단과 더 높은 build의 수정 앱 배포로 복구한다. 서버가 설치된 앱을 강제로 downgrade할 수 있다고 가정하지 않는다. API 이미지 복귀와 DB migration 되돌리기는 별도이며 새 데이터가 이전 코드에서 읽히는지 먼저 확인한다. 호환 불명확한 DB 파괴 rollback을 자동 실행하지 않는다.

## 8. 스토어 출시와 OTA의 경계

현재 서버는 웹 Toss 결제와 관리자 승인/유효 유료 기간의 Pro를 구현했다. 앱 안의 판매 방식·StoreKit/Google Play 구매/복원·서버 검증은 별도 결정/구현이다. 소셜 로그인 선택지·계정 삭제/보관·위젯 개인정보도 출시 전에 제품/서버 계약을 확인한다. 특정 심사 예외나 앱 내 웹 구매 허용을 이 문서만으로 확정하지 않는다. [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

Expo를 채택하더라도 OTA가 native module이나 권한을 추가해 주는 것은 아니다. 추후 OTA를 도입하면 runtimeVersion과 해당 native build의 코드 호환, 서명·채널·부분 배포·복구를 별도로 검증한다. 초기에는 이 경로를 구현하지 않는다. [Expo runtimeVersion](https://docs.expo.dev/eas-update/runtime-versions/).

## 9. 현재 구현 상태와 다음 작업

- **완료:** React 웹/RN 재사용 방향, backend 0.9 코드와 로컬 검증, 본 계획의 버전·호환 규칙.
- **미구현:** 제품 RN/React 코드, client-config·웹 세션/교환권, bridge 패키지, release manifest 생성기·호환 검사·웹 배포·앱 서명 CI.
- **다음 작업:** 프론트 기반에서 release/bridge 경계를 먼저 만들고 내부 build→staging→실기기 인수까지 [실행서 R-01~R-10](release-playbook-2026-11-04.md)에 따라 진행한다.
- **검증 범위:** 이 문서는 2026-11-04 공식 문서를 확인해 쓴 설계다. 새 앱·스토어 등록·배포·CI 성공 기록을 만든 것은 아니다.
