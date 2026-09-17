import argparse
import json
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, update

from mori.auth.dependencies import hash_token
from mori.auth.models import AccessToken, User
from mori.config import Settings
from mori.database import build_engine, build_session_factory


def token_days(value: str) -> int:
    days = int(value)
    if not 1 <= days <= 365:
        raise argparse.ArgumentTypeError("token-days must be between 1 and 365")
    return days


def display_name(value: str) -> str:
    value = value.strip()
    if not 1 <= len(value) <= 80:
        raise argparse.ArgumentTypeError("name must be between 1 and 80 characters")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Mori 개인 알파 사용자·토큰 관리")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-user", help="사용자 생성 및 첫 토큰 발급")
    create.add_argument("--name", required=True, type=display_name)
    create.add_argument("--token-days", type=token_days, default=30)
    issue = commands.add_parser("issue-token", help="기존 사용자에게 새 토큰 발급")
    issue.add_argument("--user-id", required=True, type=UUID)
    issue.add_argument("--token-days", type=token_days, default=30)
    revoke = commands.add_parser("revoke-token", help="토큰 ID로 접근 권한 폐기")
    revoke.add_argument("--token-id", required=True, type=UUID)
    args = parser.parse_args()
    engine = build_engine(Settings())
    try:
        with build_session_factory(engine).begin() as session:
            if args.command == "revoke-token":
                result = session.execute(
                    update(AccessToken)
                    .where(AccessToken.id == args.token_id)
                    .values(revoked_at=func.now())
                )
                if result.rowcount == 0:
                    parser.error("token not found")
                output = {"token_id": str(args.token_id), "revoked": True}
            else:
                if args.command == "create-user":
                    user = User(display_name=args.name)
                    session.add(user)
                    session.flush()
                else:
                    user = session.get(User, args.user_id)
                    if user is None:
                        parser.error("user not found")
                raw_token = "mori_" + secrets.token_urlsafe(32)
                expires_at = datetime.now(UTC) + timedelta(days=args.token_days)
                token = AccessToken(
                    user_id=user.id, token_hash=hash_token(raw_token), expires_at=expires_at
                )
                session.add(token)
                session.flush()
                output = {
                    "user_id": str(user.id),
                    "token_id": str(token.id),
                    "access_token": raw_token,
                    "expires_at": expires_at.isoformat(),
                }
        # Show credentials once, and only after the transaction has committed.
        print(json.dumps(output, ensure_ascii=False, indent=2))
    finally:
        engine.dispose()
