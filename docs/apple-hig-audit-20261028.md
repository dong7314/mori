# Apple HIG 기반 모바일·태블릿 UI/UX 점검

점검일: **2026-10-28 · Asia/Seoul**

[Apple Design](https://developer.apple.com/design/)을 출발점으로 아래 HIG 14개 문서의 공통·iOS·iPadOS 관련 본문과 WWDC25 디자인 세션 3개의 관련 대본을 읽었다. HIG는 공식 페이지가 제공하는 Markdown 본문도 확인했다. Apple 디자인 문서 전체나 관련 없는 플랫폼별 규격표까지 모두 검토했다는 의미는 아니다.

## 적용 범위

모리의 기존 정보 구조, 주요 화면과 기능, 녹색 accent, 밝은·어두운 테마를 유지한다. 사용자가 요청한 **화면 폭을 활용하는 날짜·시간 선택창과 카드에서 상세로 이어지는 확장 경험**도 보존한다. 이번 보완은 대비, 타이포그래피 위계, 터치 영역, 안전 영역, 반응형 입력 배치와 접근성 상태에 집중한다.

Apple의 네이티브 컴포넌트 배치가 웹의 모든 화면에 그대로 적용되는 것은 아니다. 예를 들어 현재 iPadOS HIG는 상단 탭과 중앙 page/form sheet를 설명하지만, 이를 이유로 모리의 탐색 구조나 전체 폭 하단 선택창을 다시 바꾸지 않는다. 각 패턴이 주는 맥락 유지·분명한 선택 상태·쉬운 종료 원칙을 기존 흐름에 적용한다. 마케팅 페이지 구성이나 별개의 비주얼 리디자인은 범위에 포함하지 않는다.

## 출처와 적용 결정

| 공식 출처 | 확인한 원칙 | 모리 적용 결정 |
| --- | --- | --- |
| [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) | 탭은 주요 목적지 이동에 사용하며, 현재 화면의 작업과 구분한다. 짧은 레이블과 안정적인 목적지 구성을 유지한다. | 기존 탐색 정보 구조와 레이블을 보존한다. 선택 상태의 대비를 보완하며 추가·저장을 새로운 목적지 탭으로 만들지 않는다. |
| [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | 현재 맥락을 보여주는 제목과 중요한 작업을 우선한다. 관련 작업을 묶고 핵심 작업을 구별한다. | 기존 제목·뒤로가기·완료의 위치 관계를 유지하고, 제목과 보조 정보의 위계·조작 영역을 정리한다. |
| [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) | 사이드바는 넓거나 깊은 정보 구조에 유용하다. 탭을 먼저 고려하고 필요한 경우 확장한다. | 기존 넓은 화면 탐색을 유지한다. HIG를 근거로 태블릿에 불필요한 새 사이드바나 추가 계층을 만들지 않는다. |
| [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | 기기 이름보다 실제 가용 공간에 대응한다. 안전 영역을 존중하고 글자 확대 시 행 높이와 배치를 조정한다. | 좌우 safe-area를 반영하고, 나란한 입력 쌍이 좁은 폭이나 큰 글자에서 자연스럽게 쌓이도록 한다. 선택·초안·현재 화면은 크기 변경 후에도 유지한다. |
| [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | 시트는 임시 작업에 사용한다. 취소와 완료를 구분하며, 크기 조절 가능한 시트에 grabber를 제공한다. | 전체 폭 선택창과 취소·완료 동작은 유지한다. 실제 드래그·크기 조절 기능이 없는 선택창의 grabber는 제거한다. |
| [Modality](https://developer.apple.com/design/human-interface-guidelines/modality) | 모달의 작업과 종료 방법을 분명히 하고, 닫기로 작성 내용을 잃지 않게 한다. 여러 모달을 무분별하게 겹치지 않는다. | 기존 입력 흐름과 작성값을 보존한다. 접근성 보완 때문에 새로운 모달 단계를 추가하지 않고, 닫기·뒤로가기·초점 복귀를 회귀 점검한다. |
| [Menus](https://developer.apple.com/design/human-interface-guidelines/menus) | 메뉴 항목은 짧고 분명하게 쓰고, 관련 항목을 묶는다. 선택 상태는 체크 표시 등으로 전달한다. | 기존 반복·종류 메뉴를 유지하고, 선택 그룹의 이름과 현재 상태가 보조 기술에도 전달되도록 정리한다. 색상만으로 선택을 구별하지 않는다. |
| [Pop-up buttons](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons) | 짧고 서로 배타적인 선택은 현재 값을 보여주는 pop-up으로 제공할 수 있다. 선택 전에 옵션의 성격을 예측할 수 있어야 한다. | 기존 짧은 선택 메뉴와 값 표시를 유지한다. 날짜·시간의 전체 폭 선택창을 모두 작은 pop-up으로 치환하지 않는다. |
| [Pickers](https://developer.apple.com/design/human-interface-guidelines/pickers) | 값은 논리적인 순서를 갖고 입력 맥락 가까이 표시한다. 날짜·시간 선택 방식은 공간과 작업에 맞춘다. | 공통 날짜·시간·기간 선택창의 순서와 취소·완료 모델을 보존한다. 달력 날짜와 이동 버튼의 실제 누름 영역을 보완한다. |
| [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | Liquid Glass는 콘텐츠 위의 조작·탐색 계층에 제한한다. 텍스트 가독성과 배경으로부터의 구분을 확보한다. | 기존 표면의 역할을 유지하면서 대비를 개선한다. 투명도 줄이기·대비 증가 환경에는 불투명 표면을 제공하고 카드 전체에 유리 효과를 추가하지 않는다. |
| [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) | 크기·굵기로 정보 위계를 만들고 글자 확대 후에도 유지한다. 좁은 행에서는 줄바꿈·세로 배치로 잘림을 줄인다. | 제목·본문·보조 문구의 위계를 정리한다. 입력 쌍과 긴 한국어 레이블을 큰 글자에서도 확인하며, 고정 높이나 일괄 축소로 내용을 감추지 않는다. |
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | 적어도 200% 글자 확대를 지원하고, 키보드·명확한 레이블·색 이외의 상태 단서를 제공한다. 움직임과 대비 환경에도 대응한다. | 200% 텍스트 조건, 그룹 이름·선택 상태, 키보드 초점, 라이트·다크 대비를 점검한다. 시스템 선호를 반영하는 CSS와 전환 정리를 함께 보완한다. |
| [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | 일반적으로 버튼 hit region을 44×44pt 이상으로 제공하고, 직접 만든 버튼에는 눌림 상태가 필요하다. | 모리 웹의 버튼·달력 조작 목표를 44×44 CSS px 이상으로 정한다. 보이는 아이콘·날짜 원과 실제 누름 영역을 구별하고 겹치지 않게 한다. |
| [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) | 움직임은 맥락과 피드백을 설명해야 한다. 짧고 선택 가능하며 중단할 수 있어야 하고, 반복 조작을 지연시키지 않아야 한다. | 기존 카드 확장과 연결 방향은 보존한다. 동작 줄이기 변경, 창 크기 변경, 문서 숨김 시 진행 중 전환과 임시 상태를 정리하여 최종 상태가 남도록 한다. |

| 공식 세션 | 확인한 원칙 | 모리 적용 결정 |
| --- | --- | --- |
| [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) | 재질·대비·모션을 함께 설계하며 유리 위에 유리를 쌓지 않는다. 네이티브 재질은 접근성 설정에 적응한다. | CSS blur를 네이티브 기능으로 설명하지 않는다. 불투명 fallback과 동작 줄이기를 직접 구현하고 실제 콘텐츠 위의 대비를 확인한다. |
| [Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/) | 장식보다 배치와 묶음으로 위계를 만든다. 컨트롤과 그것이 연 화면의 관계, 지속적인 탐색과 맥락별 작업을 구별한다. | 녹색 accent와 기존 카드 확장의 출발점·도착점 관계를 유지한다. 새 장식을 늘리기보다 텍스트 대비·그룹 구분·입력 상태를 보완한다. |
| [Elevate the design of your iPad app](https://developer.apple.com/videos/play/wwdc2025/208/) | 창 너비에 따라 적응하고, 크기 변경이 현재 작업을 파괴하지 않아야 한다. 터치 외에 포인터·키보드도 고려한다. | 전체 폭 선택창과 기존 태블릿 흐름을 보존한다. 폭 변화 중 초안·선택·포커스와 전환의 종료 상태를 확인한다. |

## 웹으로 옮길 때의 기준

- **44 CSS px는 모리의 웹 목표다.** Apple의 44pt를 CSS px와 정확히 같은 단위라고 주장하지 않는다. Buttons의 hit-region 지침과 별도로 Accessibility의 현재 표는 iOS/iPadOS 컨트롤을 기본 44×44pt, 최소 28×28pt로 구분한다. 문서별 맥락을 섞어 모든 컨트롤에 대한 단일 수치 규칙으로 확대하지 않는다.
- **글자 규격도 그대로 환산하지 않는다.** Typography의 iOS/iPadOS 기본 17pt·최소 11pt는 네이티브 규격이다. 웹에서는 읽기 쉬운 위계, 확대 가능성, 줄바꿈과 실제 렌더링을 기준으로 검증한다. 200% 글자 확대와 브라우저 줌은 별도로 기록한다.
- **CSS glass는 웹 근사 표현이다.** `backdrop-filter`는 네이티브 Liquid Glass의 광학 효과, 배경별 명도 적응, 자동 접근성 지원을 제공하지 않는다. `prefers-reduced-transparency`와 `prefers-contrast`는 지원 환경에서 반영하고, 미지원 환경에서도 읽을 수 있는 표면을 기본으로 둔다.
- **안전 영역은 좌우도 포함한다.** 가로 화면과 노치 환경을 고려해 `safe-area-inset-left`·`safe-area-inset-right`를 반영한다. CSS 값 확인이나 모의 환경만으로 실제 기기 검증을 완료했다고 보지 않는다.
- **전환의 끝 상태가 우선이다.** `prefers-reduced-motion` 변경, resize, `visibilitychange`로 문서가 숨겨질 때 페이지·헤더·카드·선택창 등 관리 중인 모든 전환을 정리한다. 복제 레이어, 임시 스타일, 대기 작업이 남아 다음 조작이나 포커스를 막지 않아야 한다. 구체적인 시간·이징은 모리 구현값이며 Apple의 지정값이 아니다.
- **선택 상태는 시각·의미 정보를 함께 제공한다.** 선택 그룹에는 이름을, 항목에는 실제 역할에 맞는 상태를 제공한다. 기존 키보드 이동과 초점 복귀를 유지하고, 동작하지 않는 grabber로 제스처 가능성을 암시하지 않는다.

## 적용 파일

- `styles/_mobile.scss`: 밝은·어두운 테마의 본문·보조 글자·강조 색 대비, 장식용 페이지 배경 정리.
- `styles/_hig-accessibility.scss`: 공통 글자 위계, 선택 버튼, 큰 글자 재배치, 좌우 안전 여백, 투명도·대비 설정과 키보드 초점.
- `styles/experience.scss`, `styles/main.css`: 공통 접근성 스타일 연결과 실제 화면에 사용하는 CSS 빌드 결과.
- `styles/_calendar.scss`: 달력의 작은 화면 터치 영역, 주말 색, 다른 달 날짜의 가독성.
- `styles/_form-picker.scss`, `src/form-picker.mjs`: 실제 휠 행 높이에 따른 선택 계산, 확대 중 값 유지, 취소·완료가 남는 스크롤 구조, 비기능 손잡이 제거.
- `src/presentation.mjs`: 관리 중인 시트·카드·선택창 전환을 시스템 설정·크기 변경·문서 숨김에 맞춰 정리. 늦게 도착한 닫기 이벤트가 다시 연 화면을 지우지 않도록 보호.
- `src/app-experience.js`: 전체 전환 정리 연결, 달력·기능·주가 기간 선택 그룹의 의미 정보.
- `tests/presentation.test.mjs`, `tests/form-picker.test.mjs`: 전환 중단·재개와 확대된 휠의 값 보존 회귀 테스트.

## 검증 결과

Ego Lite의 Chromium 페이지에서 실제 버튼·메뉴·키보드를 조작했다. 모바일·태블릿 화면 크기는 CDP 기기 지표 에뮬레이션이며, 물리 기기 검증이 아니다. 테스트 데이터는 전용 `preview=mobile` 저장 공간을 사용하고 종료 시 해당 키를 원래 값으로 복원했다.

| 상태 | 확인 항목 | 결과·증거 |
| --- | --- | --- |
| 통과 | 빌드·문법·자동 회귀 테스트 | `npm run build`, `npm run check`, 전체 **363개 통과**. 마지막 휠 방어 코드 후 관련 **11개 재검증 통과**. `git diff --check` 통과. |
| 통과 | 작은 화면·태블릿 너비 | 320·375·390·768·1024px에서 달력과 화면 폭 측정. 가로 넘침 없음. 844×390 가로 화면에서 시간 선택창 전체 높이 약 301px, 완료 버튼 높이 44px로 화면 안에 유지. |
| 통과 | 본문·보조 글자 대비 | 밝은 secondary는 canvas 5.11:1 / surface 5.54:1. 최종 muted는 canvas 5.02:1 / sage 4.57:1. 어두운 muted는 accent-soft 4.63:1. 초점 색 accent는 밝은 canvas 5.35:1. 표면별 토큰 계산이며 이미지·반투명 합성의 모든 픽셀을 인증한 결과는 아니다. |
| 통과 | 달력 터치 영역 | 주 달력 날짜: 320px에서 44×48px, 375px에서약 45.3×48px. 날짜 선택창: 320px에서 44×48px. 일반 분할 선택 버튼 높이 44px. 모든 앱 버튼의 전수 인증으로 확대 해석하지 않는다. |
| 통과·제한 | 200% 텍스트 확대 | 루트 글자 크기를 32px로 설정해 390px의 5개 탭에 가로 넘침이 없음을 확인. 달력 제목·이동 조작부와 요금제 카드가 재배치되고 입력 쌍은 한 열이 된다. 목록 미리보기의 한 줄 말줄임은 보존하며 전체 내용은 상세에서 읽는다. 브라우저 자체 줌·iOS Dynamic Type은 별도 실기기 검증 대상이다. |
| 통과 | 확대된 시간 휠 | 200%에서 행 높이 88px. 14:00의 선택과 중앙 위치가 유지되고 키보드 ↓·완료 후 14:01 반영, 초점은 원래 시간 버튼으로 복귀. 관련 자동 테스트는 88px·66.5px 높이 조건의 스크롤·탭·키보드·변경 중 값 보존을 검사한다. |
| 통과 | 선택창·메뉴 | 320px 날짜 창은 폭 320px, 1024px 태블릿 날짜 창은 중앙 폭 816px. 취소·완료·Escape·뒤로가기 조작 확인. 반복 메뉴에서 ↓·Enter로 ‘매일’ 선택 후 메뉴 닫힘과 트리거 초점 복귀 확인. 비기능 손잡이 없음. |
| 통과 | 의미와 선택 상태 | 달력 보기·기능 종류·주가 기간의 이름 있는 그룹과 `aria-pressed` 확인. 주가 ‘1일’만 true, 나머지는 false. 기존 탭의 `aria-current` 유지. VoiceOver 읽기 순서는 별도 검증 대상. |
| 통과 | 투명도·대비 선호 | CDP의 `prefers-reduced-transparency:reduce`·`prefers-contrast:more`에서 탭·빠른 입력·채팅 헤더·작성부 배경이 불투명 rgb, blur가 none임을 확인. 다크 채팅 작성부 키보드 초점은 3px 강조 윤곽선. |
| 통과 | 진행 중인 카드 전환 중단 | 실제 카드 확대 중 애니메이션 17개·복제 레이어 1개를 관측한 후 동작 줄이기를 켰다. 최종 변형 none, 복제 레이어 0개, 상세 화면 열림 유지. 닫으면 원래 카드로 초점 복귀. |
| 통과 | 크기 변경·음성 입력 | 카드 확대 중 390→768px 변경 후 상세 폭 768px, 잔여 복제 레이어 0개. 음성창 펼침 전후 입력란 하단 y=821px로 동일. 실제 마이크 녹음은 실행하지 않음. |
| 자동 테스트 통과 | 빠른 재개·문서 숨김 | OS 선호·resize·visibilitychange, 드래그 정리, 닫기 완료, 같은 tick에 다시 연 화면 보호, 최신 대기 갱신만 유지하는 회귀 검사 포함. 실제 앱 백그라운드 복귀는 실기기에서 추가 확인해야 한다. |

주요 캡처:

- [휴대폰 대시보드](screenshots/apple-hig-20261028/dashboard-light.png)
- [태블릿 다크 대시보드](screenshots/apple-hig-20261028/dashboard-tablet-dark.png)
- [320px 날짜 선택](screenshots/apple-hig-20261028/date-320.png)
- [200% 시간 선택](screenshots/apple-hig-20261028/time-200.png)
- [200% 달력 재배치](screenshots/apple-hig-20261028/calendar-200.png)
- [다크·대비 증가 채팅](screenshots/apple-hig-20261028/chat-dark-contrast.png)

**실제 iPhone/iPad Safari 기기, VoiceOver, 소프트 키보드, 노치와 터치 관성은 아직 검증하지 않았다.** 데스크톱 브라우저 크기 변경, 접근성 의미 정보 확인, 자동 테스트는 이 실기기 검증을 대신하지 않는다.
