"""Generate or check the frontend contract without connecting to a database."""

import argparse
import json
from pathlib import Path

from mori.config import Settings
from mori.main import create_app

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
app = create_app(Settings(database_url="postgresql+psycopg://schema@localhost/schema"))
rendered = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
target = Path(__file__).resolve().parents[1] / "docs" / "openapi.json"
if args.check:
    if not target.exists() or target.read_text() != rendered:
        raise SystemExit("OpenAPI differs: run uv run python scripts/export_openapi.py")
else:
    target.parent.mkdir(exist_ok=True)
    target.write_text(rendered)
