"""Create a secret-free, hash-bound build context for the isolated ERP image."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil

WHEELS = {
    "setuptools-84.0.0-py3-none-any.whl": "52c5f595b4a3fd09d1b446b744e4a4ddbba848e1b496806b31e6082f7d90dc53",
    "wheel-0.48.0-py3-none-any.whl": "b4c6b05b29b7e1cb5a2553ac02361da004b2b542155b79de89e8f52c9c99b18d",
    "packaging-26.3-py3-none-any.whl": "7416900d1c23a04c6fd1e8d7e89999a43b6e7027b31b54cd4edf78946c62a687",
}


def application_sources(app):
    """Shared selection for local verification and the final release packager."""
    app = Path(app)
    if app.is_symlink():
        raise ValueError('Application root must be a regular directory')
    core = app / 'tradept_core'
    sources = {app / 'pyproject.toml', core / 'modules.txt'}
    for extension in ('*.py', '*.json', '*.csv', '*.txt'):
        sources.update(core.rglob(extension))
    for directory in ('public', 'www'):
        sources.update(path for path in (core / directory).rglob('*') if path.is_symlink() or not path.is_dir())
    sources = sorted(path for path in sources if not any(part in ('tests', '__pycache__') for part in path.relative_to(app).parts))
    for source in sources:
        if source.is_symlink() or not source.is_file():
            raise ValueError('Application build inputs must be regular source files')
        if source.name.startswith('.') or source.name in ('site_config.json', 'frappe-sites.json', 'routing-secret'):
            raise ValueError('Private configuration must not enter the application image')
    return sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--wheels", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.app.is_symlink():
        parser.error('Application root must be a regular directory')
    app = args.app.resolve(strict=True)
    if args.output.exists():
        parser.error("Use a fresh output directory to avoid stale build files")
    try:
        sources = application_sources(app)
    except ValueError as error:
        parser.error(str(error))
    for name, sha in WHEELS.items():
        src = args.wheels / name
        if src.is_symlink() or hashlib.sha256(src.read_bytes()).hexdigest() != sha:
            parser.error("Offline wheel SHA256 differs from the reviewed dependency")
    args.output.mkdir(mode=0o700, parents=True)
    manifest = {"application": {}, "wheels": WHEELS, "baseImage": "frappe/erpnext@sha256:8ef14960b8b4108e764e56e68b2451f200664197686537b74fe39b627e1f6b63"}
    for src in sources:
        rel = src.relative_to(app)
        dest = args.output / "app" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        manifest["application"][rel.as_posix()] = hashlib.sha256(dest.read_bytes()).hexdigest()
    (args.output / "wheels").mkdir()
    for name in WHEELS:
        shutil.copyfile(args.wheels / name, args.output / "wheels" / name)
    shutil.copyfile(Path(__file__).with_name("Unified.Containerfile"), args.output / "Unified.Containerfile")
    manifest['containerfileSHA256'] = hashlib.sha256((args.output / 'Unified.Containerfile').read_bytes()).hexdigest()
    (args.output / "build-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"ok": True, "sourceFiles": len(sources), "privateContext": str(args.output)}))


if __name__ == "__main__":
    main()
