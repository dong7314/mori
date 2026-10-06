# 웹·앱 배포와 버전 호환 계획

갱신일: 2026-10-06 · 상태: 목표 설계/배포 자동화 미구현

[전체 계획](../plan.md) · [앱 구조](../front/react-native-webview-plan.md) · [모바일 API 계약](../back/mobile-client-contracts.md)

이 문서는 Mori의 운영 규칙이다. 당근의 독립적인 화면 배포 사례는 [조사 기록](../front/daangn-app-research-2026-10-02.md)에 있고, 아래의 버전 번호·지원 기간·강제 업데이트 정책은 Mori에 제안하는 설계다.

## 1. 서로 다른 네 가지 배포 단위

| 단위 | 포함 내용 | 배포 대상 | 갱신 방식 |
| --- | --- | --- | --- |
| React 웹 | 5탭·카드·상세·캘린더·웹 채팅 | k3s 웹 서비스 | 새 정적 빌드 게시 후 호환되는 웹 release 선택 |
| RN 앱 바이너리 | RN JS와 native 모듈·권한·위젯 확장·앱 설정 | App Store / Google Play | 서명한 앱 빌드와 스토어 배포 |
| Mori API/worker | 인증·도메인·예약·클라이언트 정책 | k3s API/worker | Harbor 이미지 digest + YAML, 필요 시 migration |
| Hermes/SearXNG | 에이전트·도구·검색 runtime | 기존 내부 서비스 | 기존 이미지/YAML 수명주기 |

웹 카드 디자인만 바뀌고 API/브리지가 호환되면 웹만 배포한다. 새 위젯·native 모듈·OS 권한·소셜 SDK 변경은 앱 빌드가 필요하다. 웹 배포만으로 구버전 앱에 새 native 기능을 설치할 수 없다. 제품 화면 변경마다 Hermes 이미지를 다시 만들 필요도 없다.

**초기에는 RN JavaScript OTA 업데이트를 사용하지 않는다.** RN JS도 앱 빌드에 묶고 원격 React 웹만 독립 배포한다. 이후 OTA가 필요해지면 Expo Updates 등 별도 런타임 호환/서명/복귀 체계를 검증한다. OTA는 원격 WebView 페이지 갱신과 다르며 native 코드 변경을 대신하지 않는다. [Expo runtimeVersion](https://docs.expo.dev/eas-update/runtime-versions/)

## 2. 버전 이름과 변경 규칙

| 값 | 예시 | 의미/변경 기준 |
| --- | --- | --- |
| 앱 표시 버전 | `1.2.0` | 사용자에게 보이는 기능 릴리스 버전. 예시이며 아직 앱 출시 전 |
| Android build | `versionCode=42` | 업로드할 때 증가하는 정수 |
| iOS build | `CFBundleVersion=42` | Mori 정책상 새 업로드마다 증가시키는 숫자 build |
| 웹 release ID | `web-<git-sha>` | 수정하지 않는 빌드 식별자; 동일 ID 덮어쓰기 금지 |
| bridge protocol | `1` | 메시지 규약의 호환성 경계 |
| capability | `audio.record.v1` | 설치된 native 구현이 제공하는 기능/계약 |
| API 서비스 버전 | 현재 `0.7.0` | 서버 구현 릴리스. URL의 `/v1`과 별개 |
| 정책 revision | 증가하는 정수 | 앱별 웹 선택·최소 build·기능 중지 정책 변경 |
| OTA runtimeVersion | 초기에는 없음 | OTA 도입 시 native runtime과 JS 번들의 호환 단위 |

앱 버전과 build 번호는 플랫폼별로 관리한다. 같은 앱 버전이라도 iOS·Android build가 같을 필요는 없다. `1.10.0`과 `1.9.0`을 문자열 사전순으로 비교하지 않는다. 강제 업데이트 판단은 플랫폼별 정수 build를 기준으로 한다. [앱 버전 필드 설명](https://docs.expo.dev/build-reference/app-versions/)

웹 배포 기록에는 Git SHA·이미지 digest·호환 bridge 범위·필수 capability·지원 API 계약·이전 정상 release를 남긴다. `latest`는 사람이 확인할 별칭으로만 둘 수 있고 운영 YAML은 검증한 digest로 고정한다. 앱 build에도 Git SHA와 빌드 도구 버전을 추적 가능하게 남긴다.

## 3. 앱 시작과 웹 선택

```text
앱에 내장된 시작/오류 화면
 → 고정된 HTTPS 주소의 client-config 조회
 → platform/build/bridge에 맞는 지원 정책 확인
 → 허용된 origin의 호환 web release 로드
 → native/web handshake와 실제 capability 확인
 → 로그인 복구 → 대시보드
```

클라이언트 설정 조회는 웹 로드 전에 RN이 실행한다. 브라우저 진입은 native capability가 없는 `web` 대상으로 처리한다. 응답에 `policy_revision`, `expires_at`, `min_supported_build`, `latest_build`, `update_mode`, `store_url`, `web_release`, `fallback_release`, `enabled_features`를 두는 초안이다. 실제 API는 [B-18 계약](../back/mobile-client-contracts.md)에서 구현한다.

서버가 URL을 줬다는 이유만으로 임의 origin을 열지 않는다. 앱에 내장된 허용 origin과 release 경로를 확인한다. 설정은 HTTPS·스키마 검증·유효기간·ETag를 적용하고 사용자 토큰/권한을 포함하지 않는다. 앱이 보고한 build/capability는 UI 호환성 판단용이며 Pro 권한이나 사용자 인증 근거가 아니다.

예를 들어 신규 웹이 `audio.record.v2`를 필수로 요구하면 v1 앱에 그 웹을 배포하지 않는다. 선택 기능이면 해당 기능만 숨기고 텍스트 입력 등 기존 동작을 유지한다. bridge major를 바꿀 때는 기존 major를 지원하는 웹을 유지하거나 스토어 업데이트가 가능한 시점에 지원 종료 절차를 밟는다.

| 예시 조합 | 기대 동작 |
| --- | --- |
| 구 앱 + 같은 bridge의 새 웹 | 호환 계약이면 새 UI 사용 |
| 구 앱 + 필수 native 기능이 추가된 웹 | 구 앱용 호환 웹 유지; 선택 기능은 비활성 |
| 새 앱 + 이전 웹 | 새 앱이 지원하는 이전 bridge/기능으로 실행 |
| 설정 서버 일시 실패 + 유효한 마지막 정책 | 마지막 호환 release 시도; 실패하면 native 재시도 화면 |
| 최초 실행·정책 없음 / 만료 후 호환성 불명 | native 연결 안내; 검증 안 된 최신 웹 임의 실행 금지 |
| 세션 만료·서버 권한 회수 | 웹 선택 성공과 무관하게 재인증/접근 거부 |

오프라인에 웹 화면 전체가 항상 열린다고 약속하지 않는다. 초기 앱은 네트워크 오류에서도 native 복구 화면이 남아야 한다. 별도로 보관한 사용자 요약을 보여주는 경우 기준 시각을 표시하고 로그인 전·계정 전환 후에는 숨긴다.

## 4. 기존 k3s·Harbor를 쓰는 웹 배포

초기에는 별도 클라우드 배포 플랫폼을 필수로 추가하지 않는다. 다음 구성은 새로 구현할 계획이며 현재 클러스터에 적용된 리소스가 아니다.

1. `frontend/apps/web`을 빌드해 release ID가 포함된 경로로 정적 파일을 만든다. asset base와 클라이언트 라우터 basename을 같은 release 경로로 맞춘다.
2. 정적 파일을 Nginx 이미지에 넣어 Harbor의 `mori/mori-web:<release-id>`에 push한다. 배포에는 결과 digest를 기록한다.
3. 초기에는 release별 Deployment/Service와 `/releases/<release-id>/` 경로를 만든다. 지원 중인 이전 웹은 별도 경로로 유지한다. 기존 release를 덮어쓰는 rolling update 때문에 열린 화면의 JS chunk가 사라지는 문제를 피한다.
4. 같은 HTTPS origin에서 `/v1/`은 Mori API/웹 세션 계층으로 연결하고, 루트 진입은 호환 release로 보내는 작은 bootstrap을 제공한다. 로그인 callback과 Universal Link/App Link 확인 파일도 고정 경로를 사용한다.
5. 새 release의 파일·라우팅·로그인·SSE를 확인한 뒤 client-config의 선택 release만 바꾼다. RN 바이너리나 Hermes를 재시작하지 않는다.

예시의 서비스명·경로는 설계용이다. 실제 도메인과 앱 ID는 첫 구현에서 정하고 staging/production을 분리한다. home k3s의 외부 HTTPS 진입점, 인증서, DNS와 실제 휴대폰 외부망 접근을 별도로 검증한다. 개발용 `localhost`·`kubectl port-forward`는 스토어 앱의 서비스 주소로 쓰지 않는다.

release별 경량 웹 서비스는 초기 운영을 단순하게 하는 선택이다. 보관 수가 늘면 불변 정적 자산 저장소와 단일 게이트웨이로 합칠 수 있지만 URL/호환 계약은 유지한다. 초기 보관 규칙은 **지원 앱이 참조하는 모든 release + 직전 정상 release + 최근 30일 release**의 합집합이다. 지원 종료·오래 열린 세션의 갱신 안내·접근 로그를 확인한 후 정리한다. 보안 취약 release는 예외적으로 차단하고 호환 수정본으로 교체한다.

정적 해시 자산은 긴 immutable 캐시를 쓸 수 있다. release를 선택하는 bootstrap/config는 재검증하고, 인증 응답·개인 데이터·사용자 문서에는 공용 캐시를 적용하지 않는다. 초기에는 service worker를 넣지 않고 HTTP 캐시부터 시작해 중복 업데이트 체계를 피한다.

SSE 경로는 프록시 버퍼링을 끄고 요청 수명에 맞는 timeout을 검증한다. 텍스트 문서의 10MB 제한은 UTF-8 원문 크기이고 JSON escape 등 전송 크기는 더 클 수 있으므로 ingress의 전송 한도와 API 원문 한도를 따로 정한다. 큰 파일 때문에 SSE 응답까지 버퍼링하는 공통 설정을 만들지 않는다.

## 5. 앱 빌드·배포 경로

```text
master의 검증된 커밋
 → 웹/앱/API 계약 검사
 → 웹 staging 게시 + API staging 연결
 → iOS 서명 archive / Android 서명 AAB
 → TestFlight / Google Play 내부 테스트
 → 실제 기기 시나리오 확인
 → 스토어 제출·출시 가능 상태 확인
 → 제한된 대상부터 배포 확대
```

GitHub Actions를 공통 검사와 자동화의 출발점으로 둔다. iOS는 macOS/Xcode 빌드 환경, Android는 Android SDK/JDK/Gradle 환경을 고정한다. 첫 내부 배포는 개발 Mac에서 수행할 수 있고 반복 가능한 명령을 만든 뒤 CI로 옮긴다. 서명 인증서·프로비저닝·Android keystore·스토어 자격증명은 Secret에 두며 저장소에 커밋하지 않는다. [RN iOS 배포](https://reactnative.dev/docs/publishing-to-app-store), [RN Android 배포](https://reactnative.dev/docs/signed-apk-android)

Harbor는 웹/API 이미지 저장소이고 휴대폰 앱의 설치 배포처가 아니다. 앱 사용자에게는 각 스토어의 설치 경로를 제공한다. EAS Build/Submit을 나중에 선택할 수 있지만 계정·요금·네이티브 확장 지원을 확인한 별도 결정으로 남긴다.

`master`는 제품 소스, `poc`는 UX 실험, `plan`은 문서라는 브랜치 전략을 유지한다. staging/production을 이 세 브랜치와 일대일로 대응시키지 않는다. 같은 검증된 산출물을 환경 설정으로 승격하고 production에서 다시 빌드해 다른 결과를 만들지 않는다.

## 6. CI와 승격 순서

| 순서 | 검사/작업 | 실패 시 처리 |
| --- | --- | --- |
| 1 | 타입·lint·핵심 화면 테스트, OpenAPI 차이/브리지 schema 검사 | build 중단 |
| 2 | 웹 build·앱 release build·산출물 digest 기록 | 배포하지 않음 |
| 3 | 추가형 API/DB 변경을 staging에 먼저 반영 | 기존 앱/API 계약 확인 후 진행 |
| 4 | 새 웹 release 게시·로그인/SSE/파일/딥링크 시험 | 현재 정책 포인터 유지 |
| 5 | 최소 지원 앱과 새 앱의 호환 조합 검증 | 신규 capability 비활성/수정 |
| 6 | 앱 내부 테스트·스토어 배포 | 스토어 이용 가능 전 강제 업데이트 금지 |
| 7 | 플랫폼별 소규모 대상 → 확대 | 실패율 증가 시 웹 선택/기능 플래그 복귀 |

처음에는 전체 테스트 사용자를 명시한 allowlist로 배포 범위를 나눈다. 자동 비율 배포가 필요해지면 설치 ID의 안정적인 분배를 사용해 실행마다 다른 웹으로 바뀌지 않게 한다. 로그에는 app build/web release/bridge/API version/request ID를 남기며 토큰·음성 원문·대화 본문을 버전 추적용 로그에 넣지 않는다.

웹 전환은 재실행 또는 안전한 화면 복귀 시 적용한다. 녹음 중·폼 작성 중·SSE 실행 중 강제 reload하지 않는다. draft 저장과 실행 상태 확인 후 전환한다. 서버 schema 변경은 먼저 필드를 추가하고 지원 앱이 사용하지 않게 된 후 제거하는 순서로 진행한다.

## 7. 업데이트 안내와 복구

- **권장 업데이트:** 사용을 계속할 수 있고 새 기능을 안내한다. 반복 안내를 제한한다.
- **필수 업데이트:** 보안·중단된 계약 등 기존 앱을 유지할 수 없는 근거가 있을 때만 적용한다. iOS/Android별 스토어 배포 상태와 최소 build를 따로 관리한다.
- **웹 오류:** client-config를 직전 호환 release로 복귀한다. 신규 웹이 기록한 데이터도 이전 웹/API가 읽을 수 있는지 확인한다.
- **앱 오류:** 이미 설치된 바이너리를 서버가 강제로 이전 버전으로 낮출 수 없다. 문제 기능을 중지하고 더 높은 build의 수정 앱을 배포한다.
- **API/DB 오류:** API 이미지 복귀 가능성과 DB migration 복구 가능성은 다르다. 이전 앱·웹과의 데이터 호환 여부를 확인하고 데이터 삭제를 동반한 자동 되돌리기를 하지 않는다.

지원 범위는 단순히 최신 두 앱 버전으로 자르지 않는다. 최소 build 이상에서 사용 중인 bridge와 웹 release의 조합을 등록한다. 지원 종료는 사용자 안내와 새 앱 설치 가능성을 확인한 후 정책 revision으로 기록한다.

## 8. 스토어 배포 전에 확인할 제품 결정

원격 웹 갱신이나 OTA를 심사 우회 수단으로 쓰지 않는다. 스토어 심사 기준은 제출 시 다시 확인하며, 단순 웹 포장 수준을 넘는 제품 기능과 안정성을 갖춘다. iOS의 소셜 로그인 조항 적용 여부는 네이버·카카오만 제공하는 현재 정책과 함께 검토해야 한다. 필요하면 동등한 로그인 선택지 추가를 별도 기획으로 결정한다. 결제는 현재 관리자 승인 Pro를 유지하며, 실제 디지털 서비스 과금 도입 시 스토어별 결제 정책을 다시 검토한다. [Apple App Review Guidelines — 2.5.2·4.2·4.8](https://developer.apple.com/app-store/review/guidelines/)

현재 서비스가 소셜 로그인 예외에 해당한다는 근거 없이 네이버·카카오만으로 iOS 심사가 가능하다고 가정하지 않는다. 계정 생성 기능에 대응하는 앱 내 계정 삭제도 출시 전 검토/구현 항목이다. 현재 마이 API에 탈퇴가 이미 있다는 뜻은 아니다. [Apple — 4.8·5.1.1(v)](https://developer.apple.com/app-store/review/guidelines/)

이 확인은 지금 인증 제공자나 결제 방식을 변경했다는 뜻이 아니다. 스토어 등록·심사·계정 비용도 자체 k3s 서버 운영과 별개다.

## 9. 완료 판정

문서 작성·이미지 build만으로 배포 완료라고 하지 않는다. A-06은 구 앱/새 앱 × 구 웹/새 웹 호환성, 정책 실패/웹 오류 복귀, 저장 후 재조회, 실제 기기 로그인을 통과해야 한다. A-07은 서명/스토어 내부 배포·지원 OS·권한/위젯·업데이트 동작을 실제 기기에서 확인해야 한다.

이번 작업에서 수행한 것은 설계와 문서 검증이다. 새 앱·웹 이미지, client-config API, CI workflow와 Kubernetes 리소스는 후속 `master` 작업이다.
