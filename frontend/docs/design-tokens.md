# 디자인 토큰 — FE-01-02 완료 기록

갱신일: 2026-11-11 · 상태: 사용자와 합의한 범위로 완료 · 다음: FE-01-03 앱 프레임과 5개 탭

## 완료 범위와 협업 방식

사용자가 직접 작성한 토큰·테마·폰트와 기본 적용 화면을 기준으로 FE-01-02를 완료한다. 색상·간격·모서리·글자 크기·모션 시간·그림자를 정리했고, vanilla-extract로 라이트·다크 테마를 연결했다.

2026-11-11 사용자 요청에 따라 별도의 토큰 카탈로그 화면과 추가 큰 글자 샘플 작성은 이번 단계의 완료 조건에서 제외했다. 기존 App의 테마 전환 화면은 유지한다. 200% 글자·모바일 화면·RN 실기기 검증을 수행한 것으로 기록하지 않는다. 공통 컴포넌트와 앱 프레임을 구현할 때 해당 작업의 인수 기준으로 확인한다.

제품 코드와 명령 실행은 사용자가 직접 익히며 진행하고 AI는 개념 설명·작은 예시·리뷰를 기본으로 지원한다. 이번 커밋·푸시와 문서 정리는 사용자가 명시적으로 요청했다.

## 구현 위치

| 역할 | 파일 |
| --- | --- |
| 공용 패키지 진입점 | [packages/design-tokens/src/index.ts](../packages/design-tokens/src/index.ts) |
| 색상 원본 | [colors.ts](../packages/design-tokens/src/colors.ts) |
| 간격·모서리 | [spacing.ts](../packages/design-tokens/src/spacing.ts) · [radius.ts](../packages/design-tokens/src/radius.ts) |
| 글자 크기 | [typography.ts](../packages/design-tokens/src/typography.ts) |
| 모션·그림자 | [motion.ts](../packages/design-tokens/src/motion.ts) · [elevation.ts](../packages/design-tokens/src/elevation.ts) |
| 웹 테마·전역 스타일 | [theme.css.ts](../apps/web/src/styles/theme.css.ts) · [global.css.ts](../apps/web/src/styles/global.css.ts) |
| 웹 크기 변환 | [common.ts](../apps/web/src/core/util/common.ts) |
| 기본 적용 화면 | [App.tsx](../apps/web/src/core/app/App.tsx) · [App.styles.css.ts](../apps/web/src/core/app/App.styles.css.ts) |

## 현재 결정

- 스타일은 vanilla-extract를 사용한다. 기존 계획의 CSS Modules + Sass 채택안은 이번 선택으로 변경했다.
- 글자 크기만 공용 토큰으로 관리한다. 글자 굵기·줄 높이는 필요할 때 사용처에서 정하며, 현재 제목의 줄 높이는 `1.3`이다.
- 간격·모서리·글자 크기의 원본은 숫자로 둔다. 웹 글자 크기는 `toRem`으로 변환한다.
- 그림자 원본은 현재 웹의 `box-shadow` 문자열이다. RN 네이티브용 생성·호환 검증까지 완료한 것은 아니다.
- 테마 전환은 현재 App 상태의 라이트·다크 선택으로 확인한다. 시스템 테마 자동 선택이나 선택 저장은 현재 구현 범위에 포함하지 않는다.

## PoC 대응과 사용자 조정

기준 소스는 [PoC `8fa4fe4`의 mobile 스타일](https://github.com/dong7314/mori/blob/8fa4fe4/styles/_mobile.scss)이다. 그대로 옮긴 값과 사용자 선택으로 바꾼 값을 구분한다.

| 현재 색상 토큰 | PoC 변수 | 라이트 | 다크 |
| --- | --- | --- | --- |
| `background` | `--canvas` | `#f5f6f3` | `#171c1b` |
| `surface` | `--surface` | `#ffffff` | `#232c28` |
| `textPrimary` | `--ink` | `#28352f` | `#edf3ee` |
| `textSecondary` | `--secondary` | `#5d6c63` | `#a8b6ad` |
| `border` | `--line` | `#e5eae3` | `#354039` |
| `accent` | `--accent` | `#456e57` | `#abcbb3` |

| 분류 | 현재 값 | 대응과 선택 이유 |
| --- | --- | --- |
| 간격 | `none/xs/sm/md/lg/xl/xxl = 0/4/8/12/16/24/32` | 계획의 기본 간격 단계에서 출발. 현재 화면·카드 안쪽은 24, 제목 아래·버튼 위는 16, 버튼 안쪽은 세로 8·가로 16이다. |
| 모서리 | `none/xs/sm/md/lg/xl/xxl = 0/4/6/8/12/16/24` | 사용자가 덜 둥근 외형으로 조정. 현재 카드는 `md=8`, 버튼은 `sm=6`이다. PoC의 카드 24·주요 버튼 16을 그대로 복제한 값은 아니다. |
| 글자 크기 | `caption/body/sectionTitle/pageTitle = 12/16/18/32` | 용도별 크기만 공유한다. 현재 본문은 `1rem`, 제목은 `2rem`으로 적용한다. |
| 모션 | `feedback=120ms` | 버튼의 `::before` 배경·테두리만 `scale(0.98)`로 변형한다. 글자·클릭 영역은 유지하고, `prefers-reduced-motion: no-preference`일 때만 효과를 켠다. |
| 그림자 | `none/sm/md/lg/xl` | 네 단계 모두 가까운 그림자와 넓고 옅은 그림자 두 겹으로 구성했다. PoC에는 표면용 라이트·다크 그림자 한 세트씩이 있으며, 현재 네 단계는 Mori용 확장안이다. |

그림자는 [Material의 key·ambient 합성 구현](https://github.com/material-components/material-web/blob/main/elevation/internal/_elevation.scss)과 [토스 공개 RN 문서의 그림자 예제](https://tossmini-docs.toss.im/tds-react-native/components/shadow/)를 참고해 조정했다. 현재 수치를 해당 서비스의 공식 토큰 값으로 해석하지 않는다. 실제 값은 `elevation.ts`를 기준으로 한다.

## 폰트

Pretendard Variable을 `public/fonts`에서 직접 제공한다. 폰트는 PoC의 원본과 동일하며 [라이선스와 출처](../apps/web/public/fonts/README.md)를 함께 보존한다. `globalFontFace`에서 `100 900` 굵기 범위를 등록하고 `font-display: swap`을 사용한다. 이 범위는 폰트 파일의 지원 굵기를 나타내며, 공용 글자 굵기 토큰을 정의한 것은 아니다.

## 검증

- 사용자는 개발 서버에서 색상·테마 전환·폰트·버튼 배경 눌림 효과가 작동한다고 확인했다.
- 2026-11-11 최종 검사에서 `pnpm typecheck`, `pnpm lint`, `pnpm build`가 모두 통과했다. 실행 환경은 Node.js `25.8.0`, pnpm `12.16.1`이다.
- 추가 전용 미리보기·큰 글자 샘플은 사용자 인수 결정에 따라 생략했다. 실제 계정 API·RN 컨테이너·브리지·실기기 인수 완료를 의미하지 않는다.
