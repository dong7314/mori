"""Only a persisted, user-edited feature definition grants custom execution writes."""

from mori.errors import ApiError

KNOWN_ACTIONS = {
    "reply",
    "note_save",
    "event_save",
    "reminder_save",
    "parking_save",
    "document_process",
}


def permitted_actions(snapshot, decision):
    allowed = snapshot.get("allowed_actions", ["reply"])
    if (
        not isinstance(allowed, list)
        or "reply" not in allowed
        or len(allowed) > len(KNOWN_ACTIONS)
        or any(not isinstance(a, str) or a not in KNOWN_ACTIONS for a in allowed)
        or len(set(allowed)) != len(allowed)
    ):
        raise ApiError(409, "FEATURE_POLICY_INVALID", "기능의 허용 작업을 다시 확인해 주세요.")
    if decision is None:
        raise ApiError(502, "FEATURE_ACTION_NOT_ALLOWED", "기능 실행 응답을 확인하지 못했습니다.")
    actions = decision.actions if decision.action == "batch" else [decision]
    if not actions or len(actions) > 4 or any(action.action not in allowed for action in actions):
        raise ApiError(502, "FEATURE_ACTION_NOT_ALLOWED", "이 기능에 허용되지 않은 작업입니다.")
    return actions
