# 공용 Hermes 일반 Deployment — 첫 대화 연동 성공

[전체 계획](../plan.md) · [이슈와 GPU 설정 기록](hermes-llama-validation-2026-09-23.md) · [기존 준비 절차](hermes-shared-resume.md) · [검색 설계](hermes-search-runtime.md)

기록일: 2026-09-23. **사용자가 실행한 `chat-test.py`에서 실제 한국어 인사 응답을 확인했다.** 근거는 이 대화에 제공한 Pod/PVC 조회와 테스트 출력이며, AI가 클러스터에 원격 접속해 검증한 결과는 아니다. 서버·제품 코드 변경 없이 `plan`의 상태와 다음 작업만 갱신한다.

## 1. 이번에 완료한 흐름

```text
master 192.168.0.100의 테스트 클라이언트
  → port-forward / 공용 Hermes Service
  → worker k3s-infra의 Hermes Gateway
  → 기존 GPU 노트북 192.168.0.8:8080의 llama.cpp
  → 한국어 답변 반환
```

현재는 일반 Deployment의 상시 실행 테스트다. Knative 내부 Route로 호출한 결과나 Mori API를 통한 제품 대화가 아니다. Oracle A1(ARM 2코어·12GB)은 별도 배포 후보로 논의했지만 사용자는 우선 기존 집 worker 흐름을 시험하기로 했으며, Oracle 배포/VPN 연결은 수행하지 않았다.

## 2. 사용자 제공 출력

### Pod 및 볼륨

사용자가 master의 `/home/dongyeop/mori-hermes-lab-20260922`에서 조회했다.

```text
NAME                                   READY   STATUS    RESTARTS   AGE   IP            NODE
mori-hermes-shared-85b7f6744b-2dm58      1/1     Running   0          42m   10.42.1.133   k3s-infra

NAME                      STATUS   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
mori-hermes-shared-home    Bound    5Gi        RWO            local-path     43m
```

Pod 이름·IP·AGE는 해당 조회 시점의 값이며 장애 조치 후 동일 Pod가 계속 실행됐다고 가정하지 않는다. PVC Bound는 연결 상태를 확인한 것이고 재시작 후 기억·세션 복원 검증은 아니다.

### 최종 대화 재시험

```text
root@dongyeop-ZY-AK2PLUS:/home/dongyeop/mori-hermes-lab-20260922# python3 chat-test.py
Hermes health HTTP 200
모델 답변:
안녕하세요! 오늘 어떤 일이 필요하신가요?
첫 대화 응답 확인. 검색/주차 DB 저장/사용자 격리/콜드 스타트는 아직 검증하지 않았습니다.
```

이전 이슈에서는 오류 문구도 비어 있지 않은 응답으로 취급하는 시험 스크립트의 한계가 있었다. 이번에는 마지막 성공 문구뿐 아니라 **출력된 본문이 실제 인사 답변이며 401/500 오류 문구가 없다는 것**을 확인했다. 단일 대화 연동은 통과로 기록하되, 범용 자동 성공 판정이 수정됐다고 보지는 않는다.

## 3. 검증 범위와 한계

| 항목 | 상태 |
| --- | --- |
| 공용 Hermes 배치 | worker의 1/1 Running·재시작 0회 출력 확인 |
| 영속 볼륨 | 5Gi local-path PVC Bound 확인 |
| API 상태 | Hermes health HTTP 200 |
| 모델 경유 일반 대화 | 실제 한국어 답변 확인. 공용 Hermes↔기존 llama.cpp 첫 대화 흐름 통과 |
| 키를 포함한 정상 요청 | 시험 클라이언트는 Secret을 읽어 인증 헤더를 보내는 경로. 성공 출력 확인 |
| 인증 강제 여부 | 최종 GPU 서버와 Hermes가 무인증/잘못된 키 요청을 거부하는지는 별도 미검증. 정상 요청 성공만으로 판정하지 않음 |
| 모델 설정 | 사이드 기록의 모델 ID `ggml-org/Qwen3.8-27B-GGUF:Q4_K_M`, 96K·슬롯 1·Q8 캐시 실행 성공 보고. 이번 답변만으로 실제 컨텍스트·VRAM·장기 부하를 확정하지 않음 |
| 프로필 설정 | 이슈 대응 중 `multiplex_profiles: false` 변경·재시작을 안내. 최종 ConfigMap/실행 설정 덤프와 제품 파일 동기화는 남음 |
| 실행 이미지 | 전달 템플릿은 공식 고정 digest를 사용했으나 현재 Pod의 imageID를 별도 수집하지 않음 |
| 사용자 격리 | 단일 시험 사용자 범위. 계정별 profile·파일·도구 권한 검증 미완료 |
| 검색·주차·콜드 스타트 | SearXNG 도구 호출, Mori Adapter·DB 저장, 실제 Hermes 0↔1·상태 복원 모두 미검증 |
| 응답 성능 | 이번 요청의 소요 시간·첫 토큰·p50/p95·동시 처리량 미측정. 샘플 앱의 1.140초와 혼동하지 않음 |

앞선 401, 컨텍스트 검사 500, GPU OOM, root 계정 캐시·인증 주의점은 [별도 이슈 기록](hermes-llama-validation-2026-09-23.md)에 보존한다. 실제 답변 성공이 모든 이슈의 원인·해결 상태를 소급해 확정하지는 않는다.

## 4. 전달 파일과 저장소 구현의 구분

2026-09-22 실험 묶음 `mori-hermes-lab-20260922.tar.gz`를 제공했고 사용자는 해당 디렉터리의 스크립트를 실행했다. 묶음에는 `prepare.py`, `chat-test.py`, `hermes-shared.template.yaml`, `README.md`가 있다. 준비 스크립트는 namespace/Secret과 실제 모델 ID가 들어간 YAML을 마련하고, 적용 명령은 사용자가 실행했다. 사용자 환경에는 추가 이슈 대응 변경이 있을 수 있다.

전달 템플릿의 이미지 참조:

```text
nousresearch/hermes-agent@sha256:d43ac4ef5c76ec063342cd1cb1c1f839ce73acffa9445bee87bbccfd39ccb808
```

준비 당시 registry의 amd64/arm64 manifest와 amd64 revision label `9a7b54accf841127bacfaab74fa1d7d982bca9fa`를 확인했다. 이는 현재 운영 Pod의 imageID 수집을 대체하지 않는다.

`master`의 현재 비교 기준 `55652f6`에는 여전히 초기 배포 초안이 있다. **실험 성공과 제품 배포 파일 동기화 완료를 구분한다.** 다음 구현에서 worker selector/toleration, 고정 이미지, 실제 모델 설정, 프로필 secret 범위, 시험 스크립트의 오류 응답 판정을 반영한다. 이전 초안/전달 YAML을 다시 적용해 현장 설정을 덮어쓰지 않는다. 이 plan 커밋은 실험 스크립트나 제품 코드를 수정·배포하지 않는다.

## 5. 다음 작업

1. **재현 설정 정리:** 최종 ConfigMap(키 제외), Pod imageID, 모델 시작 로그·실행 옵션을 확인하고 `master`의 배포/시험 파일에 반영한다. 설정 마이그레이션 경고와 오류 응답 오판정을 고친다. 키 없이/잘못된 키로 모델 호출 엔드포인트가 거부되는지도 확인한다. 공개 health는 이 인증 시험의 대상과 구분한다.
2. **SearXNG 자체 호스팅:** worker에 내부 검색 서비스를 배포하고 JSON 검색 결과를 확인한다. Hermes의 실제 `web_search` 도구 호출 → 결과 → 후속 모델 응답·출처까지 검증한다. `web_extract`와 파일 처리는 별도다.
3. **실제 Hermes Knative 전환:** 기존 Deployment와 새 Revision이 같은 home에 동시에 쓰지 않도록 전환한다. 내부 Route를 통해 0→1→0과 상태 보존·기동 지연을 측정한다. [전환 절차](knative-serving.md).
4. **Mori Adapter·주차 도구:** 인증된 계정의 “지하 2층 C구역 C36에 주차했어”를 `parking.save`로 저장하고 `parking.latest`로 재조회한다. DB 성공 후 응답, 중복 저장 방지, 계정별 격리를 확인한다. 검색은 주차 도구의 필수 의존성은 아니다.

현재 일반 Deployment는 자동으로 0개가 되지 않는다. 다음 테스트를 위해 유지할 수 있고, 중지가 필요하면 진행 중 요청이 끝난 뒤 scale 0으로 줄이고 PVC/Secret은 보존한다. namespace·PVC 삭제를 단순 중지 수단으로 사용하지 않는다.
