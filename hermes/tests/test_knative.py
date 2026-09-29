"""Knative cutover invariants; no live cluster or model required."""

import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]


def load(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load("scripts/runtime/prepare_knative.py", "prepare_knative")
smoke = load("scripts/smoke/knative.py", "smoke_knative")


class KnativeTests(unittest.TestCase):
    def setUp(self):
        self.source = yaml.safe_load((ROOT / "infra/k3s/base/hermes/deployment.yaml").read_text())
        spec = self.source["spec"]["template"]["spec"]
        for container in spec["containers"] + spec["initContainers"]:
            container["image"] = "harbor.example/mori/hermes@sha256:" + "a" * 64
        spec["imagePullSecrets"] = [{"name": "harbor-pull"}]

    def test_cutover_preserves_storage_credentials_and_images(self):
        original = copy.deepcopy(self.source)
        service, client = prepare.render(self.source)
        pod = service["spec"]["template"]["spec"]
        source = self.source["spec"]["template"]["spec"]
        self.assertEqual(self.source, original)
        for field in (
            "volumes",
            "initContainers",
            "imagePullSecrets",
            "nodeSelector",
            "tolerations",
        ):
            self.assertEqual(pod[field], source[field])
        self.assertEqual(pod["containers"][0]["env"], source["containers"][0]["env"])
        self.assertEqual(client["spec"]["containers"][0]["image"], pod["containers"][0]["image"])
        self.assertNotIn("volumes", client["spec"])
        self.assertEqual(
            [e["name"] for e in client["spec"]["containers"][0]["env"]], ["API_SERVER_KEY"]
        )

    def test_knative_contract_and_single_runtime_limits(self):
        service, _ = prepare.render(self.source)
        pod = service["spec"]["template"]["spec"]
        self.assertNotIn("terminationGracePeriodSeconds", pod)
        self.assertNotIn("app", service["spec"]["template"]["metadata"].get("labels", {}))
        self.assertEqual(pod["containers"][0]["ports"][0]["name"], "http1")
        self.assertEqual(pod["containers"][0]["readinessProbe"]["httpGet"]["port"], 8642)
        self.assertEqual(
            service["spec"]["template"]["metadata"]["annotations"][
                "autoscaling.knative.dev/max-scale"
            ],
            "1",
        )
        self.assertEqual(
            service["metadata"]["labels"]["networking.knative.dev/visibility"], "cluster-local"
        )

    def test_unpinned_or_mismatched_init_image_rejected(self):
        pod = self.source["spec"]["template"]["spec"]
        pod["initContainers"][0]["image"] = "wrong:latest"
        with self.assertRaises(ValueError):
            prepare.render(self.source)
        pod["containers"][0]["image"] = "hermes:latest"
        with self.assertRaises(ValueError):
            prepare.render(self.source)

    def test_cutover_guard_rejects_terminating_pvc_users(self):
        pod = {
            "metadata": {"name": "old-terminating", "deletionTimestamp": "now"},
            "spec": {
                "volumes": [{"persistentVolumeClaim": {"claimName": "mori-hermes-shared-home"}}]
            },
        }
        with (
            patch.object(smoke, "check_source_stopped"),
            patch.object(smoke, "get", return_value={"items": [pod]}),
        ):
            with self.assertRaisesRegex(SystemExit, "old-terminating"):
                smoke.check_no_pvc_users()

    def test_zero_pod_check_cannot_call_client_while_runtime_exists(self):
        stopped = {"spec": {"replicas": 0}}
        service = {"status": {"url": "http://mori-hermes-knative.mori.svc.cluster.local"}}
        with (
            patch("sys.argv", ["knative.py", "--require-zero"]),
            patch.object(smoke, "get", side_effect=[stopped, service]),
            patch.object(
                smoke, "live_pods", side_effect=[[], [{"metadata": {"name": "still-here"}}]]
            ),
            patch.object(smoke.subprocess, "run") as run,
        ):
            with self.assertRaisesRegex(SystemExit, "Not a cold start"):
                smoke.main()
            run.assert_not_called()

    def test_credentials_never_sent_to_unexpected_route(self):
        with (
            patch("sys.argv", ["knative.py"]),
            patch.object(smoke, "check_source_stopped"),
            patch.object(smoke, "get", return_value={"status": {"url": "https://example.org"}}),
            patch.object(smoke.subprocess, "run") as run,
        ):
            with self.assertRaisesRegex(SystemExit, "Unexpected"):
                smoke.main()
            run.assert_not_called()


class KnativeUpgradeTests(unittest.TestCase):
    def test_upgrade_preserves_data_and_removes_temporary_entrypoint(self):
        upgrade = load("scripts/runtime/prepare_knative_upgrade.py", "upgrade")
        original = KnativeTests()
        original.setUp()
        service, _ = prepare.render(original.source)
        template = service["spec"]["template"]
        template["metadata"]["name"] = "old-revision"
        container = template["spec"]["containers"][0]
        container["command"] = ["/bin/sh", "-ec"]
        container["args"] = ["temporary foreground workaround"]
        service["spec"]["traffic"] = [{"revisionName": "old-revision", "percent": 100}]
        before = copy.deepcopy(service)
        image = "harbor.example/mori/hermes@sha256:" + "b" * 64
        result, patch = upgrade.render(service, image)
        self.assertEqual(service, before)
        pod = result["spec"]["template"]["spec"]
        self.assertNotIn("command", pod["containers"][0])
        self.assertEqual(pod["containers"][0]["args"], ["gateway", "run"])
        self.assertEqual(pod["containers"][0]["env"], container["env"])
        self.assertEqual(pod["volumes"], template["spec"]["volumes"])
        self.assertEqual(pod["initContainers"][0]["image"], image)
        self.assertNotIn("name", result["spec"]["template"]["metadata"])
        self.assertEqual(result["spec"]["traffic"], [{"latestRevision": True, "percent": 100}])
        self.assertNotIn("replicas", patch["spec"])
        with self.assertRaises(ValueError):
            upgrade.render(service, "hermes:latest")


if __name__ == "__main__":
    unittest.main()
