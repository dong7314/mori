# Mori PoC 2 화면 참고 기록

## Muse 공개 화면

| 화면 | 직접 확인한 구간 | Mori에 적용한 것 |
| --- | --- | --- |
| 대화 | [공식 모바일 투어 0:25–0:45](https://www.youtube.com/watch?v=wHn0hTjvFoo&t=25s)에서 작은 아바타, 본문과 말풍선, 하단 입력 조작 확인 | 상태는 상단에 두고 메시지는 본문 크기로 표시 |
| 현재 상태와 활동 | [공식 모바일 투어 0:55–1:05](https://www.youtube.com/watch?v=wHn0hTjvFoo&t=55s)에서 키보드 앞의 마스코트와 상황별 상태, 날짜별 활동 확인 | 상단 모리를 누르면 실제 부탁·기록·확인·파일 상태를 볼 수 있음 |
| 답변을 기다릴 때와 작업할 때 | [Claire Vo 실사용 영상 28:27–28:36](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1707s)에서 선택 화면 동안 정면인 캐릭터가 선택 전송 후 헤드폰과 키보드의 작업 포즈로 전환되는 장면 확인 | Mori는 기다릴 때 질문 표시와 정면 자세를 사용. 결과 준비 중에는 메모가 움직이고 캐릭터가 몸을 숙임 |
| 작업 상세 | [Claire Vo 실사용 영상 25:18](https://www.youtube.com/watch?v=2UwemqPkJSQ&t=1518s)에서 단계별 실행 내역과 결과 요약 확인 | 작업 상세에서 남긴 메모·확인 답변·결과를 날짜 순서로 확인 |
| Feed·Ideas | [공식 모바일 투어 1:09–1:45](https://www.youtube.com/watch?v=wHn0hTjvFoo&t=69s)에서 이미지가 있는 추천과 분류된 제안 목록 확인 | Mori의 오늘 화면에는 응답이 필요한 항목과 실제 진행·결과를 먼저 표시 |
| Goals와 일정 | [공식 모바일 투어 1:46–2:05](https://www.youtube.com/watch?v=wHn0hTjvFoo&t=106s)에서 목표 목록과 날짜별 타임라인 확인 | 맡은 일 목록과 작업 상세를 분리하고 날짜는 항목에 연결 |
| Library와 결과 | [공식 모바일 투어 2:11–2:25](https://www.youtube.com/watch?v=wHn0hTjvFoo&t=131s)에서 파일·미디어 탭과 결과 상세 확인 | 기록의 받은 파일 탭에서 파일을 열고 TXT로 저장 |
| 승인·연결 | [Muse App Store](https://apps.apple.com/us/app/muse-from-meta/id6760173601) 연결 화면과 [WIRED 실사용 캡처](https://www.wired.com/story/metas-muse-is-better-at-surveilling-than-helping-me/)에서 대화 안 승인 조작 확인 | 먼저 답변을 대화에 기록하고, 준비된 파일을 그 뒤에 추가 |

Claire Vo 영상에서 선택을 기다릴 때 표시되는 실제 문구는 `Connected`입니다. Mori의 `답변을 기다려요`와 물음표 동작은 이 사례를 바탕으로 정한 Mori의 상태 표현입니다. 비교 범위는 공개 영상과 캡처에서 볼 수 있는 화면입니다.

## Apple 기본 앱과 모션

- [미리 알림 공식 영상 0:06–0:10](https://www.youtube.com/watch?v=64hq3vDifcY&t=6s)에서는 기본 내용을 목록에서 입력하고, 세부 속성을 하단 시트에서 편집한 뒤 원래 목록으로 돌아옵니다.
- [Siri AI에서 캘린더로 추가하는 공식 영상](https://www.apple.com/newsroom/videos/2026/autoplay/09/apple-siri-ai-mode-in-camera-add-to-calender/large_2x.mp4) 0:05–0:10에서는 작은 진행 표면이 결과 시트로 확장되고, 기존 행을 유지하면서 결과가 추가됩니다.
- [Motion HIG](https://developer.apple.com/design/human-interface-guidelines/motion)와 [Liquid Glass 세션](https://developer.apple.com/videos/play/wwdc2025/219/)의 취지에 맞춰 조작부에만 유리 질감을 적용했습니다. Mori의 시트는 아래에서 올라오고, 닫을 때 같은 방향으로 내려갑니다. 동작 줄이기는 캐릭터 키프레임과 시트 이동을 줄입니다.

## 토스와 당근

- [토스 TDS Mobile 시트 샘플](https://tossmini-docs.toss.im/tds-mobile/components/bottom-sheet/)을 열어 바탕 위에 짧은 시트가 올라오는 동작을 확인했습니다. [토스 인터랙션팀 글](https://toss.tech/article/interaction)의 터치 피드백과 [타이포 규칙](https://tossmini-docs.toss.im/tds-mobile/foundation/typography/)의 제목·본문·보조 정보 위계도 참고했습니다.
- [당근 SEED 시트 샘플](https://seed-design.io/react/components/bottom-sheet)을 열고 닫아 위로 정착하는 움직임과 버튼 초점 복귀를 확인했습니다. [당근 앱 화면](https://apps.apple.com/kr/app/id1018769995)의 연속 목록을 참고해 별도 행 카드를 줄였습니다.

교차 검증은 공개 웹 샘플 조작과 영상 프레임 확인으로 진행했습니다. Mori는 브라우저에 예시 데이터와 작업을 저장하는 UI PoC입니다.

## 개편한 화면 구조

- 오늘·일정·보관함·생활을 하단에 두고, 작업 상세와 대화에 들어가도 출발한 탭이 선택된 상태로 유지됩니다. 부탁 입력은 탭 옆의 별도 조작으로 열립니다. [Apple 탭 바 가이드](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- 부탁은 현재 화면에서 입력하고, 기한 등 추가 속성이 필요할 때 작성 중인 내용을 시트에 이어서 편집합니다. [Apple 시트 가이드](https://developer.apple.com/design/human-interface-guidelines/sheets)
- 확인 질문, 사용자의 답변, 받은 파일을 하나의 작업 기록 안에서 찾을 수 있게 했습니다. 답변 입력과 받은 파일은 각각 현재 진행 단계에서 바로 조작할 수 있습니다. [Muse의 승인과 활동 기록](https://www.meta.com/en-gb/help/superintelligence/1385290430137537/)
