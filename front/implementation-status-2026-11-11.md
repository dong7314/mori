# 프론트 공통 기반 구현 상태

갱신일: **2026-11-11** · 제품 코드: `master` · 비교 화면: `poc 8fa4fe4` · 다음 작업: **FE-01-03**

[프론트 계획](plan.md) · [세부 작업표](poc-to-react-work-breakdown-2026-11-04.md) · [구현 기준](frontend-engineering-guide-2026-11-04.md) · [제품 토큰과 PoC 대응표](https://github.com/dong7314/mori/blob/master/frontend/docs/design-tokens.md)

## 1. 완료한 범위와 다음 작업

| 작업 | 상태 | 구현 근거 |
| --- | --- | --- |
| FE-01-01 | 완료 | [`d96d1c2`](https://github.com/dong7314/mori/commit/d96d1c2997a3b2421d5b725a58029ddb9ac0bd0a): React/TypeScript/Vite 웹, pnpm workspace·공용 lockfile, 타입 검사·lint·빌드 명령 |
| FE-01-02 | 완료 · 사용자 인수 | [`441b339`](https://github.com/dong7314/mori/commit/441b339fea4ac4e2d2bca38c8a321832537a605e): vanilla-extract·공용 토큰·Pretendard·라이트/다크·버튼 피드백·그림자 |
| FE-01-03 | 다음 · 미착수 | AppFrame·5탭·페이지 탐색·뒤로가기와 스크롤 복원 |
| FE-01-04~06 | 대기 | 공통 입력/선택 UI, fixture/transport, PresentationHost |

큰 단계 **01은 진행 중**이다. FE-01-01·02 완료를 5탭 앱·공통 UI·React Native 컨테이너 완성으로 합산하지 않는다. 화면·입력·API 연결과 RN/브리지·웹 세션은 후속 작업이다.

제품 프론트 코드는 사용자가 직접 작성했고 AI가 설명·검토를 지원했다. 이번 요청에 따라 완료 상태·문서·한국어 커밋과 푸시를 정리한다.

## 2. 현행 코드 구조와 선택

| 위치 | 현재 역할 |
| --- | --- |
| `frontend/apps/web/src/core/app` | App·라이트/다크 전환 예제·스타일·앱 타입 |
| `frontend/apps/web/src/core/util/common.ts` | 숫자 font size를 웹 rem으로 바꾸는 `toRem` |
| `frontend/apps/web/src/styles` | vanilla-extract 테마 계약, 전역 초기화·폰트 등록 |
| `frontend/apps/web/public/fonts` | Pretendard Variable, OFL 라이선스와 출처 |
| `frontend/packages/design-tokens/src` | 색상·간격·모서리·font size·모션 시간·elevation 원본 |

- **스타일:** CSS Modules/Sass 초기안에서 vanilla-extract로 변경했다. `@vanilla-extract/css`와 Vite plugin으로 정적 CSS를 생성한다.
- **색상:** 라이트·다크 각각 background/surface/textPrimary/textSecondary/border/accent를 웹 테마에 연결한다.
- **글자:** font size 12/16/18/32만 공통화한다. font-weight와 line-height는 필요할 때 개별 스타일에서 직접 정한다. 현재 제목의 line-height는 1.3이다.
- **간격·모서리:** 간격은 0/4/8/12/16/24/32, 모서리는 사용자 조정값 0/4/6/8/12/16/24다. 이전 예제보다 덜 둥근 카드는 현재 기준을 따른다.
- **모션:** feedback 120ms를 공유한다. 버튼은 `::before` 배경만 0.98배로 축소하며 글자·클릭 영역·포커스 영역을 유지한다. 움직임 감소를 요청하지 않은 경우에만 효과를 적용한다.
- **그림자:** none과 sm/md/lg/xl을 라이트·다크별로 정의했다. 작은 그림자와 넓고 옅은 그림자를 겹치는 값은 공개 구현 패턴을 참고한 Mori 초기안이다. PoC에서 같은 네 단계를 그대로 복사한 것은 아니다. CSS 문자열은 현재 웹 표현이며 RN shadow API·렌더링 검증은 하지 않았다.

색상·폰트·간격의 PoC 근거와 사용자 변경 사유는 [제품 토큰 대응표](https://github.com/dong7314/mori/blob/master/frontend/docs/design-tokens.md)에 남긴다.

## 3. 이번 완료 조건의 조정

2026-11-11 사용자는 별도의 토큰 미리보기 화면을 추가하지 않고 FE-01-02를 완료한 뒤 다음 단계로 넘어가도록 요청했다. 이에 따라 **추가 전용 카탈로그·큰 글자 샘플 제작은 이번 완료 조건에서 제외**한다. 기존 App의 테마 화면을 추가 카탈로그로 확대하지 않는다.

사용자가 진행 과정에서 웹 실행·라이트/다크 전환·폰트·버튼 피드백을 확인한 범위와 소스 검토·명령어 검사를 근거로 인수한다. 이 결정이 실제 200% 확대·모바일 실기기·제품 전체 접근성·RN 인수 통과를 뜻하지는 않는다. 이 결과들은 후속 화면과 FE-12-05의 실제 인수에서 별도로 남긴다.

새로운 스크린리더 관련 보완을 이번 샘플에 추가하지 않기로 한 요청은 이 작업 범위의 결정이다. 기존 후속 공통 입력·버튼·제품 전체 검증 계약을 일괄 완료하거나 폐기한 것으로 해석하지 않는다.

## 4. 검사와 근거

커밋 직전 확인한 실행 환경은 **Node v25.8.0 / pnpm 12.16.1**이다. 사용자가 개발 과정에서 사용한 Node 24.3.0 안내와 이번 검사 환경을 구분하며 실제 실행한 값을 기록한다.

| 명령 | 결과 |
| --- | --- |
| `pnpm typecheck` | 통과 · exit 0 |
| `pnpm lint` | 통과 · exit 0 |
| `pnpm build` | 통과 · exit 0, Vite 8.3.5 production 빌드 |

빌드 산출물은 CSS 약 2.19kB, JavaScript 약 220.03kB다. 이 검사는 웹 코드·타입·CSS 생성·번들 빌드 범위다. 별도 단위 테스트나 브라우저 자동화·실기기 검사를 실행한 결과로 확장하지 않는다. 이전 백엔드/Hermes 검사 수를 프론트 검사 결과로 사용하지 않는다.

별도의 모바일/RN 빌드, 실제 계정 API 연결, 브리지·웹 세션·저장 기능, 운영 배포나 스토어 출시를 이번에 수행한 것은 아니다.

## 5. 다음 FE-01-03의 범위

AppFrame과 대시보드/스케줄/대화/기능/마이의 5탭 구조, 페이지 진입·뒤로가기·탭별 스크롤 복원의 기본 경계를 만든다. 탭 전환에서 상세로 이동했다가 돌아올 때 원래 위치가 유지되는지 확인하고, 잘못된 상세 ID와 새로고침 경로를 처리한다. 화면 스택·URL 관리 도구는 착수 시 실제 호환 조합을 확인하며 아직 설치·검증 완료로 기록하지 않는다.
