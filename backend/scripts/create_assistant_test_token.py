"""Generate a search-only lab token locally; never print its value or overwrite a file."""

import argparse
import os
import secrets
from pathlib import Path


def create_token_file(path: Path) -> None:
    token = "mori_lab_" + secrets.token_urlsafe(48)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
        f.write(token)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    create_token_file(args.output)
    print("테스트 토큰 파일 생성:", args.output.resolve())
    print("값은 출력하지 않았습니다. 파일은 소유자만 읽고 쓸 수 있습니다.")


if __name__ == "__main__":
    main()
