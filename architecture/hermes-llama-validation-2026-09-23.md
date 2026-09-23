# 공용 Hermes 연결 및 RTX 3090 llama.cpp 실행 기록

[전체 계획](../plan.md) · [재개 절차](hermes-shared-resume.md) · [아키텍처](plan.md)

기록일: 2026-09-23. 근거는 사용자가 제공한 명령 출력·로그와 마지막 명령의 정상 동작 보고다. AI가 서버에 접속해 검증한 결과는 아니다. 이번 문서 수정은 서버 설정이나 `master`의 배포 파일을 변경하지 않는다.

**후속 결과:** 같은 날 사용자가 Hermes 경유 재시험에서 “안녕하세요! 오늘 어떤 일이 필요하신가요?”라는 실제 인사 응답을 제공했다. [첫 대화 성공 기록](hermes-shared-validation-2026-09-23.md). 아래 확인 범위와 ‘바로 다음에 할 확인’은 사이드 채팅 종료 당시의 기록으로 보존한다. 일반 대화 재시험은 이후 통과했지만 최종 서버의 잘못된 키 거부·컨텍스트/부하 실측·제품 파일 동기화는 아직 남아 있다.

## 확인한 범위

| 항목 | 결과 |
| --- | --- |
| 공용 Hermes | `mori` namespace의 `mori-hermes-shared` Pod가 `k3s-infra`에서 `1/1 Running`, 재시작 0회 |
| 영속 볼륨 | `mori-hermes-shared-home`, 5Gi, RWO, `local-path`, `Bound`. 재시작 후 데이터 보존 시험은 별도 |
| Secret | `mori-hermes`, Opaque, DATA 2. 키 값은 기록하지 않음 |
| Hermes health | HTTP 200. 실제 에이전트 초기화·대화 성공과 구분 |
| Pod → llama.cpp 직접 호출 | Pod 환경변수에 키 존재, 인증 헤더를 넣은 직접 Chat Completions 호출 HTTP 200 |
| 최종 GPU 서버 실행 | 로컬 GGUF, 98,304 컨텍스트, 슬롯 1, Flash Attention, Q8 K/V 캐시 명령에 대해 사용자 정상 동작 보고 |
| 남은 검증 | 최종 실행 후 인증 재확인, Hermes 경유 실제 답변, 적용 컨텍스트·부하 중 VRAM·지연 실측, 도구 호출·주차 DB·사용자 격리·실제 Hermes 콜드 스타트 |

## 오류와 조치 과정

1. `chat-test.py`에서 Hermes health는 200이지만 응답 내용에 `HTTP 401: Invalid API Key`가 포함됐다. 스크립트가 비어 있지 않은 오류 문구도 성공으로 처리하므로 마지막 성공 문구만으로 통과 처리하지 않는다.
2. GPU 프로세스의 `LLAMA_API_KEY`와 k3s Secret 값이 같다는 사용자 확인이 있었고, Pod에서 키를 넣은 직접 호출은 HTTP 200이었다. 당시 Pod→GPU 연결과 해당 키는 동작했다.
3. Hermes 확인 결과는 `multiplex_profiles: true`, Pod 키 존재, profile `.env` 키 없음, provider `custom:lan_llama`, `key_env: LLAMA_API_KEY`였다. 다중 프로필의 secret scope가 원인 후보여서 단일 사용자 시험용으로 ConfigMap의 `gateway.multiplex_profiles`를 `false`로 바꾸고 Deployment 재시작을 안내했다. 이후 새 Pod와 HTTP 500 로그를 받았다. 이 조치는 다중 사용자 운영의 최종 인증 설계가 아니다. 기존 전달 YAML을 재적용하기 전 이 설정을 대조해야 한다.
4. HTTP 500의 직접 원인은 설치된 Hermes의 최소 컨텍스트 검사였다. 로그에서 서버 창은 51,200 토큰, 요구량은 최소 64,000 토큰이었다. 모델 서버의 실제 컨텍스트를 늘려야 하며 Hermes 설정의 숫자만 바꿔 우회하지 않는다. 이 검사 실패만으로 이전 Hermes 경유 인증 문제가 해결됐다고 확정하지 않는다.
5. GPU 서버에서 `-hf ... -ngl 99 -c 98304`만 적용한 실행은 CUDA OOM으로 실패했다. Q8 캐시·슬롯 1 옵션이 빠져 있었고, GPU 레이어 99 고정으로 자동 fit도 실패했다. 마지막 오류는 `rs cache` 버퍼 598.50MiB 할당 실패였다. 이 수치가 전체 부족량이라는 뜻은 아니다.
6. 기존 프로세스가 남았는지 확인했다. `pgrep` 결과 없음, 8080 LISTEN 없음, `nvidia-smi`는 실행 프로세스 없음·2MiB/24,576MiB였다. 확인 시점에는 이전 작업이 남아 있지 않았다. OOM 발생 당시의 GPU 점유 상태까지 소급해 증명하지는 않는다.
7. `dongyeop`에서 `root`로 실행 계정이 바뀌었고 새 로그는 `/root/.cache/huggingface/hub/...`를 사용했다. 계정별 캐시 차이로 다시 받았을 가능성이 있다. 다운로드 100% 표시만으로 매번 전체 재전송을 단정하지 않는다. 이미 받은 파일을 `-m`으로 지정하고 Q8 캐시·슬롯 1을 적용한 아래 명령에서 정상 동작을 보고받았다. 여러 옵션을 함께 변경했으므로 성공 원인을 한 옵션으로 단정하지 않는다.

## 정상 동작을 보고받은 명령

실행 위치: **GPU 노트북 `192.168.0.8`**, 사용자 보고의 root 터미널, `/home/dongyeop/llama.cpp`. k3s master/worker에서 실행하는 명령이 아니다. 기존 서버가 종료된 상태에서 실행했다.

```bash
./build/bin/llama-server \
  -m /root/.cache/huggingface/hub/models--ggml-org--Qwen3.8-27B-GGUF/snapshots/efbb3b1f70a21d97fd4495240648405f7228554f/Qwen3.8-27B-Q4_K_M.gguf \
  --host 0.0.0.0 \
  --port 8080 \
  -ngl 99 \
  -c 98304 \
  -np 1 \
  -fa on \
  -ctk q8_0 \
  -ctv q8_0 \
  --alias 'ggml-org/Qwen3.8-27B-GGUF:Q4_K_M'
```

- `-m`: 해당 서버에 이미 받은 GGUF를 사용한다. 다른 계정·장비에서는 실제로 존재하며 읽을 수 있는 경로로 변경한다.
- `-c 98304`: 96K 컨텍스트 요청값. 최종 시작 로그/API의 실제 적용값은 추가 수집한다.
- `-np 1`: 서버 슬롯 하나. 여러 사용자 동시 추론 성능을 검증한 설정이 아니다.
- `-fa on`, `-ctk q8_0`, `-ctv q8_0`: Flash Attention과 Q8 KV 캐시. 모델 가중치는 Q4_K_M 그대로이며, 별도의 `rs cache`까지 모두 Q8로 바뀐다는 뜻은 아니다.
- `--alias`: Hermes가 사용하는 기존 모델 ID 유지.
- `-m`만 사용하고 mmproj를 지정하지 않은 텍스트 시험이다. 이미지 입력은 검증하지 않았다.

위 명령에는 키 값이 없다. 실행 셸의 `LLAMA_API_KEY`에 기존 k3s Secret과 같은 키를 주입하는 것이 별도 전제다. 앞선 root 실행에서는 `no API key is set` 경고가 있었으며, 최종 성공 보고만으로 인증 복구를 확정하지 않는다. 키는 문서·명령행 인자에 기록하지 않고 보호된 환경 설정으로 관리한다. root의 캐시 경로는 이번 재현 경로이며 영구 서비스의 실행 사용자·모델 저장 위치는 별도로 정한다.

96K는 이 명령의 정상 동작 보고가 있는 시험값이며 3090의 최대치나 운영 보장값이 아니다. GPU 레이어·캐시·슬롯·컨텍스트를 동일하게 둔 반복 실행과 실제 긴 입력 부하를 검증한 후 확정한다.

## 바로 다음에 할 확인

1. GPU 노트북에서 최종 시작 로그의 컨텍스트·슬롯·GPU 버퍼 정보와 `nvidia-smi`를 수집한다. 시작 성공뿐 아니라 Hermes 요청 처리 중 메모리와 지연을 확인한다.
2. 최종 서버의 인증 설정을 확인하고 Hermes Pod에서 인증된 직접 호출을 재검증한다. 공개 health 응답만으로 인증을 검증하지 않는다.
3. k3s master에서 기존 포트포워딩을 유지하고 시험 디렉터리의 `python3 chat-test.py`를 실행한다. 실제 인사 답변인지 확인하고, 401/500 또는 오류 문구가 섞인 응답은 성공에서 제외한다.
4. 재현 가능한 `master` 배포/시험 파일에 프로필 설정과 오류 응답 판정 수정을 반영하는 작업을 별도로 진행한다. 로그의 config 버전 마이그레이션 경고도 검토하되 버전 숫자만 올려 해결됐다고 처리하지 않는다.
5. 일반 대화가 통과한 후 검색 도구, Mori 주차 DB 저장·조회, 실제 Hermes Knative 전환을 기존 인수 순서에 따라 검증한다.

공식 옵션 참고: [llama.cpp 서버 문서](https://github.com/ggml-org/llama.cpp/tree/master/tools/server), [사용한 GGUF 저장소](https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/tree/main). CLI 옵션은 설치 빌드의 `--help`와 대조한다.
