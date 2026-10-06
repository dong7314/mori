# 당근 앱 구조 조사와 Mori 적용 판단

최초 조사일: 2026-10-02 · 채용 공고 재확인/문서 마무리: 2026-10-06 · [프론트 계획](plan.md) · [Mori 앱 구조](react-native-webview-plan.md)

## 1. 조사 결론

공식 자료에서 확인되는 당근의 구조는 **네이티브 앱 + React 웹뷰 + 일부 Lynx 화면**이다. 당근 전체가 React Native로 구현됐다고 확인할 근거는 찾지 못했다. 사용자가 기억하는 채용 공고의 링크·직무가 없어 해당 공고의 시기와 팀은 특정하지 못했으며, 특정 조직이나 과거의 React Native 사용 가능성까지 부정하는 결론은 아니다.

Mori는 사용자가 원하는 **React 웹 + React Native 앱 컨테이너 + WebView**로 계획을 구체화한다. 이는 당근의 전체 기술 스택을 복제하는 결정이 아니라, 웹 화면과 기기 기능의 책임을 나누는 운영 방식을 개인 프로젝트에 맞게 적용한 선택이다.

## 2. 확인한 공식 근거

채용 공고는 조사일 공개 내용이고 게시일·변경일이 표시되지 않은 경우 날짜를 추정하지 않았다. 기술 글은 작성 당시 사례로 읽으며 현재 모든 화면의 구현을 뜻하지 않는다.

| 자료 | 시점 | 확인한 내용 | 해석 범위 |
| --- | --- | --- | --- |
| [Frontend — 당근페이 채용](https://careers.daangn.com/jobs/role/5919465003/) | 조사일 공개 | React·TypeScript로 웹과 모바일 앱 내 웹뷰 UI/UX 개발 | React 사용을 React Native 사용으로 바꿔 읽을 수 없음 |
| [Android 채용](https://careers.daangn.com/jobs/role/4496730003/) | 조사일 공개 | Kotlin·Jetpack Compose 등 네이티브 기술, 웹·Lynx 연결, GitHub Actions | Android의 네이티브 기반과 혼합 구조를 확인 |
| [iOS 채용](https://careers.daangn.com/jobs/role/5282170003/) | 조사일 공개 | SwiftUI 등 네이티브 기술, Tuist·GitHub Actions·fastlane | iOS도 별도 네이티브 개발·출시 책임이 있음 |
| [웹 프로젝트 배포하기 #2](https://medium.com/daangn/당근마켓에-웹-프로젝트-배포하기-2-웹-서버로-돌아가기-3030daea456c) | 2022-07-29 | 로컬 파일 웹뷰에서 HTTP로 서비스하는 리모트 웹뷰로 이동, 프론트 배포 책임 분리 | 오래된 배포 사례이며 당시 호스팅 업체를 현재 표준으로 단정하지 않음 |
| [당근 @ FEConf 2023](https://medium.com/daangn/당근-feconf-2023-3994d7813f15) | 2023-11-21 | 웹의 React 활용, Stackflow와 공통 디자인 시스템 소개 | 웹 개발·화면 전환의 참고 사례 |
| [웹뷰 다음의 레일을 깔다: 당근이 Lynx를 선택한 이유](https://medium.com/daangn/웹뷰-다음의-레일을-깔다-당근이-lynx를-선택한-이유-34dd50abbfb7) | 2026-08-12 | 핵심 네이티브 유지, 일부 웹뷰 영역에 Lynx 적용, React Native·Flutter와 비교 | 현재 구조를 이해하는 가장 최근의 직접 설명 |

최근 Lynx 글은 공유하기 하단 패널·최근 본 글·즐겨찾기를 적용 사례로 제시한다. 번들은 Warp와 CloudFront로 제공하고, 인터페이스는 공통 정의에서 생성하며 SEED 디자인을 연결한다. 이 사례는 화면 단위 전환과 복귀 경로의 중요성을 보여준다. 글에 없는 전체 앱의 버전 번호 정책·강제 업데이트 기준까지 당근의 관행으로 추정하지 않는다. [해당 공식 글](https://medium.com/daangn/웹뷰-다음의-레일을-깔다-당근이-lynx를-선택한-이유-34dd50abbfb7)

검색은 공식 채용 사이트의 프론트엔드·Android·iOS 공고와 공식 기술 블로그를 중심으로 진행했다. 검색 결과에 함께 나타나는 다른 회사의 React Native 공고나 AI 요약은 당근의 구현 근거로 사용하지 않았다.

## 3. React, React Native, WebView의 차이

| 방식 | 화면을 그리는 위치 | Mori에서의 역할 |
| --- | --- | --- |
| React 웹 | 브라우저/WebView의 HTML·CSS·DOM | 5탭, 카드·상세, 캘린더, 대화, 계정 화면 |
| React Native | iOS·Android 앱의 네이티브 UI 계층 | 앱 시작·권한·로그인 복귀·녹음·공유·기기 연결 |
| react-native-webview | RN 앱 안에 웹 실행 환경을 삽입 | 같은 React 웹을 앱에서 열고 제한된 브리지 제공 |
| OS 위젯 | 앱과 별도의 OS 확장/위젯 실행 환경 | 주차·일정 등 저장된 요약 정보 표시 |

React 웹 컴포넌트의 HTML/CSS가 RN 컴포넌트로 자동 변환되지는 않는다. Mori는 웹 화면 자체를 WebView에서 재사용하고, 타입·디자인 토큰·업무 계약을 공유한다. 위젯은 플랫폼 구현이 추가로 필요하다. [React Native 통합 문서](https://reactnative.dev/docs/integration-with-existing-apps), [React Native WebView 안내](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Guide.md), [WidgetKit](https://developer.apple.com/documentation/widgetkit), [Android 위젯](https://developer.android.com/develop/ui/views/appwidgets/overview)

## 4. Mori가 채택할 것

1. UI는 React에서 우선 구현하고, OS 기능은 명시적인 앱 인터페이스로 호출한다.
2. 웹 화면·앱 바이너리·API를 별도 버전과 배포 단위로 관리한다.
3. 공통 여백·타이포그래피·색상·모션 규칙을 공유하되 웹과 네이티브 렌더러는 각자 구현한다.
4. 구버전 앱이 지원하는 기능을 확인한 뒤 호환되는 웹을 제공한다. 실패하면 검증된 이전 웹으로 복귀한다.
5. 웹의 체감 성능을 먼저 측정하고 필요해진 화면만 네이티브로 전환한다.

초기에는 Lynx·당근의 사내 호스팅·자체 DSL을 도입하지 않는다. 기존 k3s·Harbor와 작은 브리지 계약으로 시작한다. Stackflow는 [공식 화면 스택 라이브러리](https://stackflow.so/docs/get-started/introduction)를 실제 캘린더·채팅 패널에 시험한 뒤 결정한다. 당근이 쓴다는 이유만으로 라우팅·캐시·빌드 체계를 모두 채택하지 않는다.

## 5. 결정과 남은 검증

- **결정:** React 웹 + RN 컨테이너 + 원격 HTTPS WebView, 별도 네이티브 위젯, 독립 배포와 호환성 관리.
- **구현 시작 때 고정:** React/RN/WebView의 호환 버전, 지원 OS 최소 버전, 앱 식별자와 실제 도메인. 검증한 lockfile과 빌드 도구 버전을 기록한다.
- **실기기 검증:** 소셜 로그인 복귀, 키보드/뒤로가기, SSE 재접속, 녹음·공유, 위젯 갱신 제약.
- **정책 확인:** iOS 배포 전 소셜 로그인 정책의 적용 여부를 확인한다. 현재 네이버·카카오 정책을 문서 작업만으로 변경하지 않는다.

이번 변경은 `plan`의 설계 결정이다. RN 앱·웹 배포·브리지 API가 구현되었다는 의미는 아니다. 상세 구현 순서는 [프론트 앱 계획](react-native-webview-plan.md), 배포/업데이트는 [릴리스 계획](../architecture/app-release-versioning.md)을 따른다.
