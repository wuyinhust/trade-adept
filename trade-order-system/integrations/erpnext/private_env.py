"""Create a private, random local Docker env without printing credentials."""
import argparse
import json
import os
from pathlib import Path
import secrets
import stat

ERP_IMAGE = "frappe/erpnext@sha256:a9dea1cc498aa08010eb3567f1808c7bed98e4b9d17dcbd4265791c9ad00971e"


def create_private_env(output):
    path = Path(output).absolute()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or stat.S_IMODE(path.parent.stat().st_mode) != 0o700:
        raise ValueError("Use a private 0700 directory; shared source storage is unsuitable")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(f"ADMIN_PASSWORD={secrets.token_urlsafe(32)}\n")
        stream.write(f"DB_ROOT_PASSWORD={secrets.token_urlsafe(32)}\n")
        stream.write(f"ERPNEXT_IMAGE={ERP_IMAGE}\n")
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError("Filesystem did not retain private 0600 file permissions")
    print(json.dumps({"created": True, "path": str(path), "permissions": "0600"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    create_private_env(args.output)
