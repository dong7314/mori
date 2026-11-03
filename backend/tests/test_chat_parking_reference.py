from uuid import uuid4

from sqlalchemy import func, select
from test_chat import agent as agent
from test_chat import conversation, events, send

from mori.parking.models import ParkingRecord


def test_parking_save_and_lookup_share_detail_kind_after_reopening_chat(
    client, accounts, sessions, agent
):
    headers = accounts["alice"]["headers"]
    cid = conversation(client, accounts)
    agent.decision = {"action": "parking_save", "parking": {"floor": "B3", "spot": "B16"}}
    saved = events(send(client, accounts, cid, "지하 3층 B16에 주차했어"))
    save_ref = next(e["result_ref"] for e in saved if e["type"] == "action.completed")

    agent.decision = {"action": "parking_lookup"}
    key = uuid4()
    looked_up = events(send(client, accounts, cid, "내 주차 위치 알려줘", key=key))
    lookup_ref = next(e["result_ref"] for e in looked_up if e["type"] == "action.completed")
    assert (
        lookup_ref
        == save_ref
        == {
            "resource_id": save_ref["resource_id"],
            "kind": "parking",
            "detail_url": "/v1/parking-records/latest",
        }
    )
    detail = client.get(lookup_ref["detail_url"], headers=headers)
    assert detail.status_code == 200
    assert detail.json()["id"] == lookup_ref["resource_id"]
    assert detail.json()["spot"] == "B16"
    assert events(send(client, accounts, cid, "내 주차 위치 알려줘", key=key)) == looked_up

    messages = client.get(f"/v1/conversations/{cid}/messages", headers=headers).json()
    assert [message["result_refs"] for message in messages] == [[save_ref], [lookup_ref]]
    assert (
        client.get(
            f"/v1/conversations/{cid}/messages", headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    assert (
        client.get(lookup_ref["detail_url"], headers=accounts["bob"]["headers"]).status_code == 404
    )
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(ParkingRecord)) == 1


def test_parking_lookup_without_saved_location_has_no_detail_link(client, accounts, agent):
    cid = conversation(client, accounts)
    agent.decision = {"action": "parking_lookup"}
    observed = events(send(client, accounts, cid, "내 주차 위치 알려줘"))
    assert observed[-1]["type"] == "run.completed"
    assert not any(event.get("result_ref") for event in observed)
    messages = client.get(
        f"/v1/conversations/{cid}/messages", headers=accounts["alice"]["headers"]
    ).json()
    assert messages[0]["result_refs"] == []
