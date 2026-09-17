import argparse
import json
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import delete, func

from mori.auth.models import AuthSession, LoginGrant, OAuthFlow
from mori.auth.sessions import revoke_session
from mori.config import Settings
from mori.database import build_engine, build_session_factory
from mori.errors import ApiError
from mori.membership.schemas import AccessDecision
from mori.membership.service import set_super_admin


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Mori 인증·관리자 역할 운영 도구 (가입·토큰 발급 없음)"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    revoke = commands.add_parser("revoke-session", help="로그인 세션 폐기")
    revoke.add_argument("--session-id", required=True, type=UUID)
    commands.add_parser("prune-auth", help="만료된 로그인 요청·교환 코드·세션 정리")
    for name in ("grant-super-admin", "revoke-super-admin"):
        role_command = commands.add_parser(name, help="기존 소셜 가입자의 최고 관리자 역할 변경")
        role_command.add_argument("--user-id", required=True, type=UUID)
        role_command.add_argument("--reason", required=True)
    args = parser.parse_args()
    engine = build_engine(Settings())
    try:
        with build_session_factory(engine)() as session:
            if args.command == "revoke-session":
                revoke_session(session, args.session_id)
                output = {"session_id": str(args.session_id), "revoked": True}
            elif args.command in {"grant-super-admin", "revoke-super-admin"}:
                try:
                    user = set_super_admin(
                        session,
                        args.user_id,
                        enabled=args.command == "grant-super-admin",
                        decision=AccessDecision(reason=args.reason),
                    )
                except ValidationError:
                    parser.exit(2, "변경 사유는 제어 문자 없이 1~300자로 입력해 주세요.\n")
                except ApiError as error:
                    parser.exit(2, error.message + "\n")
                output = {"user_id": str(user.id), "role": user.role, "tier": user.tier}
            else:
                output = {}
                for model in (OAuthFlow, LoginGrant, AuthSession):
                    result = session.execute(delete(model).where(model.expires_at <= func.now()))
                    output[model.__tablename__] = result.rowcount
                # Used refresh tokens stay until the whole session expires (replay detection).
                session.commit()
        print(json.dumps(output, ensure_ascii=False))
    finally:
        engine.dispose()
