import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from mori.auth.models import User
from mori.cli import main
from mori.errors import ApiError
from mori.main import create_app
from mori.membership.dependencies import CurrentProUser
from mori.membership.models import AccessChange
from mori.membership.schemas import AccessDecision
from mori.membership.service import change_pro_access, set_super_admin
from mori.membership.types import AccountTier


@pytest.fixture
def administrator(accounts, sessions):
    with sessions() as session:
        set_super_admin(
            session,
            accounts["alice"]["user_id"],
            enabled=True,
            decision=AccessDecision(reason="초기 최고 관리자 지정"),
        )
    return accounts["alice"]


def decision_path(account, action="approve"):
    return f"/v1/admin/users/{account['user_id']}/pro/{action}"


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/v1/admin/users"),
        ("get", "/v1/admin/users/{user_id}/access-history"),
        ("post", "/v1/admin/users/{user_id}/pro/approve"),
        ("post", "/v1/admin/users/{user_id}/pro/revoke"),
    ],
)
def test_admin_routes_reject_anonymous_free_and_pro_users(client, accounts, sessions, method, path):
    path = path.format(user_id=accounts["bob"]["user_id"])
    request = getattr(client, method)
    kwargs = {"json": {"reason": "테스트"}} if method == "post" else {}
    assert request(path, **kwargs).status_code == 401
    headers = {**accounts["alice"]["headers"], "X-User-Role": "super_admin", "X-User-Tier": "pro"}
    assert request(path, headers=headers, **kwargs).status_code == 403
    with sessions.begin() as session:
        session.get(User, accounts["alice"]["user_id"]).tier = "pro"
    assert request(path, headers=headers, **kwargs).status_code == 403
    with sessions() as session:
        assert session.get(User, accounts["bob"]["user_id"]).tier == "free"
        assert session.scalar(select(func.count()).select_from(AccessChange)) == 0


def test_approval_and_revocation_apply_to_existing_tokens_and_record_actor(
    client, accounts, administrator
):
    @client.app.get("/test/pro-feature")
    def pro_feature(user: CurrentProUser):
        return {"user_id": str(user.id)}

    member = accounts["bob"]
    assert client.get("/v1/me", headers=member["headers"]).json()["tier"] == "free"
    assert client.get("/test/pro-feature", headers=member["headers"]).status_code == 403
    approved = client.post(
        decision_path(member),
        headers=administrator["headers"],
        json={"reason": "  초기 테스터 승인  "},
    )
    assert approved.status_code == 200
    assert approved.json()["tier"] == "pro" and approved.json()["role"] == "user"
    assert client.get("/v1/me", headers=member["headers"]).json()["tier"] == "pro"
    assert client.get("/test/pro-feature", headers=member["headers"]).status_code == 200
    revoked = client.post(
        decision_path(member, "revoke"),
        headers=administrator["headers"],
        json={"reason": "테스트 참여 종료"},
    )
    assert revoked.status_code == 200 and revoked.json()["tier"] == "free"
    assert client.get("/test/pro-feature", headers=member["headers"]).status_code == 403
    history = client.get(
        f"/v1/admin/users/{member['user_id']}/access-history", headers=administrator["headers"]
    )
    assert history.status_code == 200
    assert [item["action"] for item in history.json()] == ["revoke_pro", "approve_pro"]
    assert all(item["actor_id"] == str(administrator["user_id"]) for item in history.json())
    assert history.json()[1]["reason"] == "초기 테스터 승인"
    assert history.headers["cache-control"] == "no-store"
    assert client.get("/v1/me", headers=administrator["headers"]).json()["tier"] == "free"


def test_no_change_does_not_duplicate_history(client, accounts, administrator, sessions):
    for action in ("revoke", "approve", "approve", "revoke", "revoke"):
        assert (
            client.post(
                decision_path(accounts["bob"], action),
                headers=administrator["headers"],
                json={"reason": "승인 상태 변경"},
            ).status_code
            == 200
        )
    with sessions() as session:
        assert (
            session.scalar(
                select(func.count())
                .select_from(AccessChange)
                .where(AccessChange.user_id == accounts["bob"]["user_id"])
            )
            == 2
        )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"reason": " "},
        {"reason": "x" * 301},
        {"reason": "before\x00after"},
        {"reason": "승인", "role": "super_admin"},
        {"reason": "승인", "tier": "pro"},
        {"reason": "승인", "actor_id": str(uuid4())},
    ],
)
def test_decisions_require_reason_and_reject_extra_privilege_fields(
    client, accounts, administrator, payload
):
    response = client.post(
        decision_path(accounts["bob"]), headers=administrator["headers"], json=payload
    )
    assert response.status_code == 422
    assert client.get("/v1/me", headers=accounts["bob"]["headers"]).json()["tier"] == "free"


def test_missing_or_legacy_user_cannot_be_approved(client, administrator, sessions):
    with sessions.begin() as session:
        user = User(display_name="legacy")
        session.add(user)
        session.flush()
        legacy_id = user.id
    for identifier in (uuid4(), legacy_id):
        response = client.post(
            f"/v1/admin/users/{identifier}/pro/approve",
            headers=administrator["headers"],
            json={"reason": "승인"},
        )
        assert response.status_code == 404
    listed = client.get("/v1/admin/users", headers=administrator["headers"]).json()["items"]
    assert str(legacy_id) not in [user["id"] for user in listed]


def test_member_listing_is_bounded_filterable_and_paginated(client, accounts, administrator):
    first = client.get("/v1/admin/users?limit=1", headers=administrator["headers"]).json()
    assert len(first["items"]) == 1 and first["next_cursor"]
    second = client.get(
        "/v1/admin/users",
        headers=administrator["headers"],
        params={"limit": 1, "cursor": first["next_cursor"]},
    ).json()
    assert second["next_cursor"] is None
    assert {first["items"][0]["id"], second["items"][0]["id"]} == {
        str(account["user_id"]) for account in accounts.values()
    }
    assert (
        client.get("/v1/admin/users?limit=101", headers=administrator["headers"]).status_code == 422
    )
    assert (
        client.get("/v1/admin/users?tier=pro", headers=administrator["headers"]).json()["items"]
        == []
    )
    client.post(
        decision_path(accounts["bob"]), headers=administrator["headers"], json={"reason": "승인"}
    )
    filtered = client.get("/v1/admin/users?tier=pro", headers=administrator["headers"]).json()
    assert [user["id"] for user in filtered["items"]] == [str(accounts["bob"]["user_id"])]
    assert "subject" not in str(filtered) and "token" not in str(filtered)


def test_cli_bootstraps_and_revokes_only_existing_social_users(
    client, accounts, sessions, monkeypatch, capsys
):
    identifier = str(accounts["alice"]["user_id"])
    for action, expected in (
        ("grant", "super_admin"),
        ("grant", "super_admin"),
        ("revoke", "user"),
    ):
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "mori",
                f"{action}-super-admin",
                "--user-id",
                identifier,
                "--reason",
                "서버 운영자 지정",
            ],
        )
        main()
        me = client.get("/v1/me", headers=accounts["alice"]["headers"]).json()
        assert me["role"] == expected and me["tier"] == "free"
    with sessions() as session:
        changes = session.scalars(select(AccessChange).order_by(AccessChange.created_at)).all()
        assert [c.action for c in changes] == ["grant_super_admin", "revoke_super_admin"]
        assert all(c.actor_id is None for c in changes)
    capsys.readouterr()
    monkeypatch.setattr(
        sys,
        "argv",
        ["mori", "grant-super-admin", "--user-id", str(uuid4()), "--reason", "미가입자"],
    )
    with pytest.raises(SystemExit) as stopped:
        main()
    assert stopped.value.code == 2
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 2


def test_revoked_administrator_is_rechecked_even_with_cached_auth_context(
    client, accounts, administrator, sessions
):
    with sessions() as stale:
        actor = stale.get(User, administrator["user_id"])
        assert actor.role == "super_admin"
        with sessions() as operator:
            set_super_admin(
                operator, actor.id, enabled=False, decision=AccessDecision(reason="역할 회수")
            )
        with pytest.raises(ApiError) as denied:
            change_pro_access(
                stale,
                actor.id,
                accounts["bob"]["user_id"],
                AccountTier.PRO,
                AccessDecision(reason="이미 회수된 관리자"),
            )
        assert denied.value.status_code == 403
    assert (
        client.post(
            decision_path(accounts["bob"]),
            headers=administrator["headers"],
            json={"reason": "시도"},
        ).status_code
        == 403
    )


def test_concurrent_approvals_create_one_audit_entry(
    client, accounts, administrator, settings, sessions
):
    barrier = Barrier(2)

    def approve(_):
        with TestClient(create_app(settings)) as independent:
            barrier.wait(timeout=10)
            return independent.post(
                decision_path(accounts["bob"]),
                headers=administrator["headers"],
                json={"reason": "동시 승인"},
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(approve, range(2)))
    assert [r.status_code for r in responses] == [200, 200]
    with sessions() as session:
        assert (
            session.scalar(
                select(func.count())
                .select_from(AccessChange)
                .where(AccessChange.user_id == accounts["bob"]["user_id"])
            )
            == 1
        )


def test_admin_can_approve_self_without_changing_role(client, administrator):
    response = client.post(
        decision_path(administrator),
        headers=administrator["headers"],
        json={"reason": "프로 기능 운영 검증"},
    )
    assert response.status_code == 200
    assert response.json()["tier"] == "pro" and response.json()["role"] == "super_admin"


def test_tier_change_and_audit_are_atomic(client, accounts, administrator, sessions):
    # A failing history write must roll back the user's changed tier as well.
    with sessions.begin() as session:
        session.execute(
            text(
                "ALTER TABLE access_changes ADD CONSTRAINT test_reject_pro "
                "CHECK (action <> 'approve_pro')"
            )
        )
    try:
        failed = client.post(
            decision_path(accounts["bob"]),
            headers=administrator["headers"],
            json={"reason": "원자성 검증"},
        )
        assert failed.status_code == 503
        assert client.get("/v1/me", headers=accounts["bob"]["headers"]).json()["tier"] == "free"
    finally:
        with sessions.begin() as session:
            session.execute(text("ALTER TABLE access_changes DROP CONSTRAINT test_reject_pro"))


@pytest.mark.parametrize("column,value", [("tier", "paid"), ("role", "admin")])
def test_database_rejects_unknown_tier_and_role(accounts, sessions, column, value):
    with pytest.raises(IntegrityError), sessions.begin() as session:
        setattr(session.get(User, accounts["alice"]["user_id"]), column, value)


def test_upgrade_preserves_existing_user_session_and_parking_as_free(client, accounts, sessions):
    alice = accounts["alice"]
    saved = client.post(
        "/v1/parking-records",
        headers={**alice["headers"], "Idempotency-Key": str(uuid4())},
        json={"spot": "C36"},
    )
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    command.downgrade(config, "0002_social_login")
    try:
        with sessions() as session:
            assert (
                session.scalar(
                    text("SELECT display_name FROM users WHERE id = :id"), {"id": alice["user_id"]}
                )
                == "alice"
            )
    finally:
        command.upgrade(config, "head")
    me = client.get("/v1/me", headers=alice["headers"])
    assert me.status_code == 200
    assert me.json()["tier"] == "free" and me.json()["role"] == "user"
    assert client.get("/v1/parking-records/latest", headers=alice["headers"]).json() == saved.json()
