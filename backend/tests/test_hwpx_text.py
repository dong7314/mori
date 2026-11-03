import zipfile

import pytest

from mori.artifacts.engine import MAX_TEXT
from mori.artifacts.service import invoke_engine
from mori.config import Settings

HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HS = "http://www.hancom.co.kr/hwpml/2011/section"


def section(body):
    return f'<hs:sec xmlns:hs="{HS}" xmlns:hp="{HP}">{body}</hs:sec>'


def run_job(root, operation, sections):
    filename = "f" * 32 + ".hwpx"
    with zipfile.ZipFile(root / filename, "w") as archive:
        for number, body in reversed(list(enumerate(sections))):
            archive.writestr(f"Contents/section{number}.xml", section(body))
    args = {"operation": operation, "file_id": filename}
    if operation == "convert":
        args["format"] = "txt"
    settings = Settings(database_url="postgresql+psycopg://unused@localhost/unused")
    result = invoke_engine(settings, args, root)
    if operation == "read":
        return result["data"]["text"], result["data"]["truncated"]
    return (root / result["file_id"]).read_text(), result["data"]["source_truncated"]


@pytest.mark.parametrize("operation", ["read", "convert"])
def test_hwpx_runs_inline_controls_and_nested_paragraphs_preserve_text(tmp_path, operation):
    body = """
        <hp:p id="0">
          <hp:run charPrIDRef="0"><hp:t>계좌</hp:t></hp:run>
          <hp:run charPrIDRef="1"><hp:t>번호 1234<hp:lineBreak/>다음 줄<hp:tab/>비고</hp:t></hp:run>
          <hp:run><foreign:t xmlns:foreign="urn:unrelated">제외할 메타데이터</foreign:t></hp:run>
        </hp:p>
        <hp:p id="1"><hp:run><hp:t>문단 끝</hp:t></hp:run></hp:p>
        <hp:p id="2"><hp:run><hp:t>바깥 시작</hp:t>
          <hp:tbl><hp:tr>
            <hp:tc><hp:subList>
              <hp:p id="3"><hp:run><hp:t>첫째 셀</hp:t></hp:run></hp:p>
            </hp:subList></hp:tc>
            <hp:tc><hp:subList>
              <hp:p id="4"><hp:run><hp:t>둘째 셀</hp:t></hp:run></hp:p>
            </hp:subList></hp:tc>
          </hp:tr></hp:tbl><hp:t>바깥 끝</hp:t>
        </hp:run></hp:p>
        <hp:p id="5"><hp:run><hp:t/></hp:run></hp:p>
        <hp:p id="6"><hp:run><hp:t>마지막 문단</hp:t></hp:run></hp:p>
    """
    expected = (
        "계좌번호 1234\n다음 줄\t비고\n문단 끝\n바깥 시작\n첫째 셀\n둘째 셀\n"
        "바깥 끝\n\n마지막 문단\n다음 구역"
    )
    actual, truncated = run_job(
        tmp_path, operation, [body, "<hp:p><hp:run><hp:t>다음 구역</hp:t></hp:run></hp:p>"]
    )
    assert actual == expected
    assert truncated is False


@pytest.mark.parametrize("operation", ["read", "convert"])
def test_hwpx_inline_tail_preview_and_conversion_keep_truncation(tmp_path, operation):
    body = (
        "<hp:p><hp:run><hp:t>prefix<hp:lineBreak/>"
        + "N" * (MAX_TEXT + 100)
        + "</hp:t></hp:run></hp:p>"
    )
    actual, truncated = run_job(tmp_path, operation, [body])
    assert actual == ("prefix\n" + "N" * (MAX_TEXT + 100))[:MAX_TEXT]
    assert truncated is True
