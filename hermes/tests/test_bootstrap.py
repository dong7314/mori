import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bootstrap = load("bootstrap", ROOT / "hermes/bootstrap.py")
configure = load("configure", ROOT / "scripts/runtime/configure.py")


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.plugins = self.root / "image-plugins"
        for name in bootstrap.PLUGINS:
            target = self.plugins / name
            target.mkdir(parents=True)
            (target / "plugin.yaml").write_text("name: " + name)
        self.config = self.root / "config.yaml"
        self.config.write_text("gateway:\n  multiplex_profiles: false\n")

    def run_init(self):
        bootstrap.initialize(self.home, self.config, self.plugins, os.getuid(), os.getgid())

    def test_fresh_pvc_and_repeated_start_preserve_state(self):
        self.run_init()
        memory = self.home / "memory.txt"
        memory.write_text("keep me")
        self.config.write_text("gateway:\n  multiplex_profiles: false\nweb: {}\n")
        self.run_init()
        self.assertEqual(memory.read_text(), "keep me")
        self.assertEqual((self.home / "config.yaml").read_text(), self.config.read_text())
        self.assertEqual((self.home / "config.yaml").stat().st_mode & 0o777, 0o600)
        for name in bootstrap.PLUGINS:
            self.assertEqual(
                (self.home / "plugins" / name).resolve(), (self.plugins / name).resolve()
            )

    def test_projected_configmap_symlink_is_supported(self):
        actual = self.root / "projected-config"
        self.config.rename(actual)
        self.config.symlink_to(actual)
        self.run_init()
        self.assertEqual((self.home / "config.yaml").read_text(), actual.read_text())

    def test_legacy_plugin_never_overwritten(self):
        legacy = self.home / "plugins/mori_images"
        legacy.mkdir(parents=True)
        (legacy / "__init__.py").write_text("user content")
        with self.assertRaisesRegex(ValueError, "Legacy"):
            self.run_init()
        self.assertEqual((legacy / "__init__.py").read_text(), "user content")
        self.assertFalse((self.home / "config.yaml").exists())

    def test_config_destination_symlink_never_followed(self):
        self.home.mkdir()
        unrelated = self.root / "unrelated"
        unrelated.write_text("keep")
        (self.home / "config.yaml").symlink_to(unrelated)
        with self.assertRaises(ValueError):
            self.run_init()
        self.assertEqual(unrelated.read_text(), "keep")

    def test_wrong_plugin_link_rejected(self):
        (self.home / "plugins").mkdir(parents=True)
        (self.home / "plugins/mori_images").symlink_to(self.root / "other")
        with self.assertRaisesRegex(ValueError, "Unexpected plugin link"):
            self.run_init()


class OverlayTests(unittest.TestCase):
    def test_digest_applies_to_same_named_init_and_main_image(self):
        result = configure.configuration(
            "harbor.example:8443/mori/hermes@sha256:" + "a" * 64, "harbor-pull"
        )
        self.assertEqual(result["images"][0]["name"], "mori-hermes")
        self.assertIn("harbor-pull", result["patches"][0]["patch"])

    def test_mutable_or_invalid_image_rejected(self):
        for image in (
            "hermes:latest",
            "h/p/i:dev",
            "h/p/i:dev@sha256:" + "a" * 64,
            "h/p/i@sha256:123",
        ):
            with self.subTest(image=image), self.assertRaises(ValueError):
                configure.configuration(image)

    def test_public_registry_needs_no_pull_secret(self):
        result = configure.configuration("harbor.example/mori/hermes@sha256:" + "a" * 64)
        self.assertNotIn("patches", result)


if __name__ == "__main__":
    unittest.main()
