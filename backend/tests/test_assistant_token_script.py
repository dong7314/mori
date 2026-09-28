import importlib.util
import re
import stat
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "token_script", Path(__file__).resolve().parents[1] / "scripts/create_assistant_test_token.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_generator_creates_unique_private_file_and_never_overwrites(tmp_path):
    first, second = tmp_path / "a", tmp_path / "b"
    module.create_token_file(first)
    module.create_token_file(second)
    value = first.read_text()
    assert re.fullmatch(r"mori_lab_[A-Za-z0-9_-]{64}", value)
    assert first.read_text() != second.read_text()
    assert stat.S_IMODE(first.stat().st_mode) == 0o600
    with pytest.raises(FileExistsError):
        module.create_token_file(first)
    assert first.read_text() == value
