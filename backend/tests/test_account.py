from concurrent.futures import ThreadPoolExecutor

import pytest

from mori.auth.models import User


def test_profile_edit_updates_real_user_and_rejects_stale_write(client, accounts):
    h = accounts["alice"]["headers"]
    old = client.get("/v1/me", headers=h).json()
    result = client.patch(
        "/v1/me", headers=h, json={"display_name": "새 이름", "revision": old["revision"]}
    )
    assert result.status_code == 200
    assert result.json()["revision"] == 2
    assert result.json()["providers"] == old["providers"]
    assert result.json()["created_at"] == old["created_at"]
    assert client.get("/v1/me", headers=h).json()["display_name"] == "새 이름"
    assert client.get("/v1/me", headers=accounts["bob"]["headers"]).json()["display_name"] == "bob"
    assert (
        client.patch(
            "/v1/me", headers=h, json={"display_name": "옛 내용", "revision": 1}
        ).status_code
        == 409
    )


@pytest.mark.parametrize(
    "extra",
    [{"tier": "pro"}, {"role": "super_admin"}, {"providers": ["kakao"]}, {"user_id": "other"}],
)
def test_profile_cannot_edit_identity_or_privilege(client, accounts, extra):
    response = client.patch(
        "/v1/me",
        headers=accounts["alice"]["headers"],
        json={"display_name": "변경", "revision": 1, **extra},
    )
    assert response.status_code == 422
    assert client.get("/v1/me", headers=accounts["alice"]["headers"]).json()["tier"] == "free"


def test_profile_concurrent_edits_have_one_winner(client, accounts):
    def edit(name):
        return client.patch(
            "/v1/me",
            headers=accounts["alice"]["headers"],
            json={"display_name": name, "revision": 1},
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(edit, ("첫 이름", "두 번째 이름"))) == [200, 409]


def test_theme_persists_per_account_without_dashboard_settings(client, accounts):
    h = accounts["alice"]["headers"]
    assert client.get("/v1/me/settings", headers=h).json() == {"theme": "system", "revision": 0}
    assert client.put(
        "/v1/me/settings", headers=h, json={"theme": "dark", "revision": 0}
    ).json() == {"theme": "dark", "revision": 1}
    assert client.get("/v1/me/settings", headers=h).json()["theme"] == "dark"
    assert (
        client.get("/v1/me/settings", headers=accounts["bob"]["headers"]).json()["theme"]
        == "system"
    )
    assert (
        client.put("/v1/me/settings", headers=h, json={"theme": "light", "revision": 0}).status_code
        == 409
    )
    for payload in (
        {"theme": "neon", "revision": 1},
        {"theme": "light", "revision": 1, "commute_time": "09:00"},
    ):
        assert client.put("/v1/me/settings", headers=h, json=payload).status_code == 422
    for path in ("/v1/me/preferences", "/v1/me/summary"):
        assert client.get(path, headers=h).status_code == 404
        assert path not in client.get("/openapi.json").json()["paths"]


def test_subscription_does_not_conflate_admin_pro_with_paid_subscription(
    client, accounts, sessions
):
    plans = client.get("/v1/plans").json()
    assert plans[0]["amount"] == 0 and plans[1]["amount"] is None
    assert not any(p["checkout_available"] for p in plans)
    h = accounts["alice"]["headers"]
    free = client.get("/v1/me/subscription", headers=h).json()
    assert free["plan"] == "free" and free["access_source"] == "free"
    with sessions.begin() as session:
        session.get(User, accounts["alice"]["user_id"]).tier = "pro"
    pro = client.get("/v1/me/subscription", headers=h).json()
    assert pro["plan"] == "pro" and pro["access_source"] == "admin_approval"
    assert pro["billing_status"] == "not_subscribed"
    assert not pro["cancellation_available"] and not pro["checkout_available"]


def test_account_endpoints_require_login_and_logout_revokes_access(client, accounts):
    for path in ("/v1/me", "/v1/me/settings", "/v1/me/subscription"):
        assert client.get(path).status_code == 401
    h = accounts["alice"]["headers"]
    assert client.post("/v1/auth/logout", headers=h).status_code == 204
    assert (
        client.patch("/v1/me", headers=h, json={"display_name": "변경", "revision": 1}).status_code
        == 401
    )
    assert client.get("/v1/me/settings", headers=h).status_code == 401
