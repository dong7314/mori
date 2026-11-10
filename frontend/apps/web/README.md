# Mori 웹

React · TypeScript · Vite로 만드는 Mori 웹 앱이다. 현재 FE-01-01 환경 구성과 FE-01-02 디자인 토큰 기반을 완료했다. 다음 작업은 FE-01-03의 앱 프레임과 5개 탭 구성이다.

## 실행과 검사

다음 명령은 pnpm workspace 루트인 `frontend/`에서 실행한다.

```bash
pnpm dev
pnpm typecheck
pnpm lint
pnpm build
```

## 현재 구성

- `src/core/app`: 라이트·다크 전환과 기본 스타일을 확인하는 현재 앱 진입 화면
- `src/core/util/common.ts`: 공용 숫자 크기를 웹의 `rem`으로 바꾸는 함수
- `src/styles`: vanilla-extract 테마와 전역 초기화·폰트 등록
- `public/fonts`: Pretendard Variable 원본과 라이선스·출처
- `../../packages/design-tokens`: 색상, 간격, 모서리, 글자 크기, 모션 시간, 웹용 그림자 값

토큰의 값·PoC 대응·완료 범위는 [디자인 토큰 기록](../../docs/design-tokens.md)을 따른다. 제품 코드는 사용자가 직접 작성하고, AI는 설명과 코드 리뷰를 기본으로 지원한다.

현재 화면은 토큰과 테마의 기본 적용을 확인하는 단계다. 5개 탭·실제 API 화면·RN 컨테이너·브리지는 후속 작업이다.
