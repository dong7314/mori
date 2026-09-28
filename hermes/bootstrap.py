"""Init-container setup: authoritative config and image-owned plugin links on a PVC."""

import argparse
import os
from pathlib import Path

PLUGINS = ("mori_images", "mori_extract")


def initialize(home: Path, config: Path, plugins: Path, uid=10000, gid=10000):
    if home.is_symlink():
        raise ValueError("Unexpected symlink for home")
    # Projected ConfigMap files are symlinks; the read-only source is intentional.
    content = config.read_bytes()
    if not content or b"REPLACE_" in content:
        raise ValueError("Configure the runtime before deploying")
    home.mkdir(parents=True, exist_ok=True)
    target = home / "plugins"
    if target.is_symlink():
        raise ValueError("Plugin directory must not be a symlink")
    # Check all paths before changing any existing installation.
    for name in PLUGINS:
        source = plugins / name
        link = target / name
        if not (source / "plugin.yaml").is_file():
            raise ValueError(f"Image plugin missing: {name}")
        if link.is_symlink():
            if link.resolve() != source.resolve():
                raise ValueError(f"Unexpected plugin link: {name}")
        elif link.exists():
            raise ValueError(
                f"Legacy plugin directory {name}; use a fresh PVC or migrate explicitly"
            )
    destination = home / "config.yaml"
    if destination.is_symlink() or (destination.exists() and not destination.is_file()):
        raise ValueError("Unexpected config destination")
    target.mkdir(exist_ok=True)
    for name in PLUGINS:
        link = target / name
        if not link.is_symlink():
            link.symlink_to(plugins / name, target_is_directory=True)
    # Only config is managed; sessions, memories and other plugins are left alone.
    temp = home / f".mori-config-{os.getpid()}"
    try:
        with temp.open("xb") as stream:
            stream.write(content)
        temp.chmod(0o600)
        os.chown(temp, uid, gid)
        temp.replace(destination)
    finally:
        temp.unlink(missing_ok=True)
    os.chown(home, uid, gid)
    os.chown(target, uid, gid)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, default=Path("/opt/data"))
    parser.add_argument("--config", type=Path, default=Path("/bootstrap/config.yaml"))
    parser.add_argument("--plugins", type=Path, default=Path("/opt/mori/plugins"))
    args = parser.parse_args()
    initialize(args.home, args.config, args.plugins)
    print("Mori config and image plugin links ready")
