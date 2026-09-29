"""Deployment isolation and secret preservation without a live cluster."""

import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/runtime/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


configure = load_module("configure")
create_secrets = load_module("create_secrets")


class ComponentTests(unittest.TestCase):
    def test_search_render_needs_no_hermes_image(self):
        manifests = configure.render_manifests(component="searxng")
        self.assertEqual(set(manifests), {"searxng.yaml"})
        self.assertNotIn("mori-tools", manifests["searxng.yaml"])
        self.assertEqual(manifests["searxng.yaml"].count("namespace: search"), 3)
        self.assertNotIn("kind: Secret", manifests["searxng.yaml"])

    def test_hermes_only_matches_combined_output_and_shared_search(self):
        image = "harbor.example/mori/hermes@sha256:" + "a" * 64
        hermes = configure.render_manifests(image, component="hermes")
        self.assertEqual(set(hermes), {"hermes.yaml"})
        self.assertEqual(hermes["hermes.yaml"], configure.render_manifests(image)["hermes.yaml"])
        self.assertIn("http://searxng.search.svc.cluster.local:8080", hermes["hermes.yaml"])

    def test_search_secret_setup_never_requests_gpu_or_registry_credentials(self):
        with patch.object(create_secrets, "ensure_secret") as ensure:
            create_secrets.main(["--component", "searxng"])
        ensure.assert_called_once()
        self.assertEqual(
            ensure.call_args.args[:3], ("search", "searxng-secret", ["SEARXNG_SECRET"])
        )
        generated = ensure.call_args.args[3]()
        self.assertEqual(len(generated["SEARXNG_SECRET"]), 64)

    def test_existing_secret_preserved_without_generating_or_rotating(self):
        existing = json.dumps({"type": "Opaque", "data": {"SEARXNG_SECRET": "existing"}})
        factory = Mock(side_effect=AssertionError("Must not rotate"))
        with patch.object(create_secrets, "kube", return_value=existing) as kube:
            create_secrets.ensure_secret("search", "searxng-secret", ["SEARXNG_SECRET"], factory)
        self.assertEqual(kube.call_count, 1)
        factory.assert_not_called()

    def test_invalid_existing_secret_fails_without_overwriting(self):
        factory = Mock()
        with patch.object(
            create_secrets, "kube", return_value='{"type":"Opaque","data":{}}'
        ) as kube:
            with self.assertRaises(ValueError):
                create_secrets.ensure_secret(
                    "search", "searxng-secret", ["SEARXNG_SECRET"], factory
                )
        self.assertEqual(kube.call_count, 1)
        factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
