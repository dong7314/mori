# Hermes 문서 작업 이미지

기존 고정 Hermes base에 문서 실행 환경과 `mori_documents` 플러그인을 추가했다. **단일 운영자용 기본 파일 생성·편집 도구**이며 앱의 업로드/다운로드 API, 사용자별 파일 격리, HWP 편집까지 구현한 것은 아니다.

## 지원 범위

| 형식 | 생성·읽기 | 편집 | 제한 |
| --- | --- | --- | --- |
| DOCX | 제목·본문 문단 생성, 본문/표 텍스트 읽기 | 본문 문단 인덱스로 교체, 문단 추가 | 교체한 문단의 글자별 서식은 초기화. 복잡한 도형·변경 추적·레이아웃 보존 미보장 |
| XLSX | 시트·행/셀 생성, 시트별 값/수식 읽기 | 지정 시트의 셀 값·수식 수정 | 수식은 저장만 하고 재계산하지 않음. 복잡한 Excel 기능 보존 미보장 |
| PDF | 한국어 폰트를 포함한 텍스트 PDF 생성, 텍스트 추출 | 페이지 선택·순서 변경·회전 | 기존 본문 문구 직접 수정, OCR, 전자서명 유지 미지원 |

`.hwp`, `.hwpx`, 구형 `.doc`/`.xls`, 매크로 문서, Google Docs/Sheets 연동은 별도 단계다. LibreOffice·브라우저·OCR는 설치하지 않으므로 Word/Excel→PDF 변환 및 수식 재계산을 지원한다고 표시하지 않는다. 추가 제공 시 이미지 크기와 자원 사용을 측정하고 별도 문서 Worker 배치도 검토한다.

공식 base에는 이미 `docx`, `xlsx`, `pdf` 스킬과 CLI가 들어 있는 것을 확인했다. 이번 추가는 스킬 문서를 설치하는 작업에 그치지 않고, Hermes API가 호출할 수 있는 제한된 `mori_document` 도구와 실제 라이브러리를 연결한다. 임의 터미널·Python 코드 실행 도구를 새로 활성화하지 않는다. 기본 스킬의 모든 기능을 이 도구가 제공하는 것은 아니다.

## 이미지 내부와 파일 수명

- 의존성: `documents-requirements.in` / hash 고정 `documents-requirements.lock`.
- 라이브러리: python-docx 1.2.0, openpyxl 3.1.5, pypdf 6.19.0, reportlab 5.0.1.
- 실행 환경: `/opt/mori/documents-venv/bin/python`. 기존 HTML 추출 venv와 분리.
- 폰트: Debian `fonts-nanum`의 NanumGothic TTF. 한국어 PDF에 내장한다.
- 플러그인: `/opt/mori/plugins/mori_documents`, bootstrap이 home의 plugin 경로로 연결.
- 파일: `${HERMES_HOME:-/opt/data}/documents/<32자리 hex ID>.<확장자>`.
- 생성·수정마다 새로운 파일 ID를 반환한다. 원본은 덮어쓰거나 삭제하지 않는다.
- 파일 ID는 다운로드 URL이나 접근 권한 토큰이 아니다. 다른 사용자와 공유하는 runtime에 이 도구를 열지 않는다. 향후 Mori가 인증된 사용자/작업별 저장 공간·파일 소유권을 제공해야 한다.
- 현재 보관 만료·정리/총 용량 quota는 없다. 운영자가 시험 파일을 관리하며 무제한 공개 서비스에 사용하지 않는다.

입력/출력 파일 10 MB, Office 압축 해제 총 크기 50 MB·항목 2,000개, PDF 100페이지, 요청 256 KB, worker 30초·CPU 20초·가상 메모리 1 GiB 한도를 둔다. 파일 경로·URL 대신 형식이 검증된 ID만 받으며 symlink 입력은 거부한다. 이 제한은 다중 사용자 sandbox를 대체하지 않는다. 파일을 읽은 내용은 비신뢰 데이터로 표시하며 지시로 실행하지 않는다.

## 이미지 빌드와 로컬 검사

저장소 루트에서 실행한다. 새 도구는 `hermes/` 빌드에 자동 포함된다.

```sh
docker build --platform linux/amd64 -t mori-hermes:documents-check hermes
python3 scripts/runtime/check_image.py --image mori-hermes:documents-check
python3 scripts/runtime/check_image.py --image mori-hermes:documents-check --documents
```

첫 검사는 기존 검색 전용 설정의 기동을 확인한다. 두 번째는 **검사 전용 임시 설정**에 문서 toolset을 켜고 정상 gateway의 toolset 목록을 확인한 뒤, 실제 플러그인→문서 venv subprocess로 세 형식의 생성→읽기→수정→재읽기를 실행한다. 한국어 텍스트, 수정 내용, 원본 유지도 검사한다. 시험 파일과 컨테이너/볼륨은 자체 생성한 대상만 정리한다.

오프라인 컨테이너 검사이므로 LLM이 도구를 선택하는지, 문서의 화면 배치가 올바른지, 실제 k3s 저장소/앱 다운로드가 되는지는 별도 검증한다.

## 명시적 활성화 — 신뢰된 단일 사용자 전용

기본 설정은 계속 검색용 `web`, `mori_images`만 노출한다. 문서 플러그인은 이미지와 plugin 목록에 준비하되 쓰기 가능한 도구를 자동으로 현재 채팅 어댑터에 노출하지 않는다.

`infra/k3s/base/hermes/config.yaml`의 아래 부분을 변경한다.

```yaml
platform_toolsets:
  api_server:
    - web
    - mori_images
    - mori_documents
```

이후 [일반 YAML 배포 안내](../infra/k3s/hermes-shared.md)에 따라 새 이미지 digest로 YAML을 다시 만들고 validate/dry-run/diff/apply한다. 설정만 변경한 경우에도 해당 Deployment를 재시작한다.

```sh
sudo k3s kubectl -n mori rollout restart deployment/mori-hermes-shared
sudo k3s kubectl -n mori rollout status deployment/mori-hermes-shared --timeout=600s
python3 scripts/smoke/runtime.py --mode documents-direct
```

**현재 Mori 채팅 어댑터는 검색·이미지 외 toolset을 거부한다.** 문서 toolset을 켠 인스턴스는 준비 검사에서 거부된다. 기본 도구 설정을 유지하고 문서 기능은 로컬 `--documents` 검사로 확인한다. 실제 서비스 문서 연동에는 파일 소유권과 결과 전달 계약이 필요하다.

## 도구 입력과 확인할 응답

Hermes 모델에는 `mori_document` 스키마가 제공된다. 직접 호출 또는 `tool_describe`/`tool_call` 간접 경로로 사용할 수 있다.

```json
{"operation":"create","format":"docx","spec":{"title":"서울 여행 계획","paragraphs":["첫째 날: 경복궁 관람","둘째 날: 국립중앙박물관 관람"]}}
```

```json
{"operation":"edit","file_id":"<생성 결과의 file_id>","spec":{"paragraph_updates":[{"index":1,"text":"첫째 날: 국립중앙박물관 관람"}]}}
```

DOCX 제목도 본문 문단 인덱스에 포함된다. 수정 전 `read`의 `body_paragraphs`에서 실제 인덱스를 확인한다. 생성 답변의 `success`, 새 `file_id`, `bytes`, 편집 답변의 `source_file_id`와 주의사항을 확인한다. 수정본을 다시 읽고 기대한 값이 저장됐는지 검사하며, 모델의 성공 문구만으로 통과시키지 않는다.

기존 로컬 파일을 시험하려면 운영자가 확장자가 맞는 `32자리 소문자 hex.docx/xlsx/pdf` 이름으로 이 전용 문서 폴더에 복사하고 UID 10000이 읽을 수 있게 준비할 수 있다. 모델에게 호스트 경로·URL 다운로드를 맡기는 기능은 없다. 파일을 사용자에게 전달하는 HTTP 경로는 아직 없으며 추후 Mori 파일 API가 담당한다.

## 개발 검증

기존 런타임 검증 venv에 문서 의존성도 설치한다.

```sh
python -m pip install --require-hashes -r hermes/requirements.lock
python -m pip install --require-hashes -r hermes/documents-requirements.lock
python -m unittest discover -s hermes/tests -v
```

문서 테스트는 DOCX/표 보존, XLSX 셀·수식 저장, PDF 페이지/회전, 원본 보존, 잘못된 경로·symlink·매크로·암호화 PDF·입력 크기·인덱스·timeout 거부를 확인한다. 전체 기능 인수에는 GPU 모델의 실제 문서 도구 호출, 결과 화면 검토 및 Mori 파일 전달 검증을 추가해야 한다.

## 확인 결과 — 2026-09-29

- 런타임 전체 50개 unit/fixture 테스트, Ruff와 일반 YAML 구조 검사 통과.
- `mori-hermes:documents-check`의 linux/amd64 빌드 성공.
- 네트워크 없는 실제 컨테이너에서 UID 10000으로 plugin → 별도 venv 실행, DOCX/XLSX/PDF 생성·읽기·편집·재읽기와 원본 유지 통과. 한국어 PDF 텍스트도 재추출 확인.
- 정상 gateway 기동 후 `mori_documents` toolset 활성화·설정 확인, API 무인증/오인증 거부와 기존 본문 추출 provider 확인.
- 모델이 문서 도구를 선택하는 실제 GPU 요청, 렌더링 화면 검토, Harbor push와 k3s 배포, Mori 업로드/다운로드는 이번 로컬 검증에 포함하지 않음.
