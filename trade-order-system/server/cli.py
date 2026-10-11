"""Administrator-only local configuration/import tools; no registration API."""
import argparse
import getpass
import json
from pathlib import Path

from .app import DEFAULT_RUNTIME
from .store import APIError, Store, password_hash


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="Initialize/update configured tenants and accounts")
    init.add_argument("--config", type=Path, default=Path(__file__).with_name("config.example.json"))
    init.add_argument("--import", dest="source", type=Path)
    init.add_argument("--tenant", default="grandware")
    init.add_argument("--expected-version", type=int, default=0)
    configure = sub.add_parser("configure", help="Apply account/role configuration, revoking disabled or omitted users")
    configure.add_argument("--config", type=Path, required=True)
    importer = sub.add_parser("import", help="Import a read-only archived business export into one tenant")
    importer.add_argument("source", type=Path)
    importer.add_argument("--tenant", required=True)
    importer.add_argument("--expected-version", type=int, required=True)
    reset = sub.add_parser("set-password", help="Reset a configured account and revoke all sessions")
    reset.add_argument("--tenant", required=True)
    reset.add_argument("--user", required=True)
    args = parser.parse_args()
    try:
        store = Store(args.runtime)
        if args.command in ("init", "configure"):
            count = store.configure(json.loads(args.config.read_text(encoding="utf-8")))
            print(f"Configuration applied; {count} random credentials stored privately in runtime/demo-credentials.json")
            if args.command == "init" and args.source:
                result = store.import_data(args.tenant, args.source, args.expected_version)
                print(f"Read-only archive imported as revision {result['meta']['version']}")
        elif args.command == "import":
            result = store.import_data(args.tenant, args.source, args.expected_version)
            print(f"Read-only archive imported as revision {result['meta']['version']}")
        else:
            password = getpass.getpass("New password (at least 12 characters): ")
            if password != getpass.getpass("Confirm new password: "):
                parser.error("Passwords do not match")
            encoded = password_hash(password)
            with store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                result = db.execute("UPDATE users SET password=? WHERE tenant_id=? AND id=?", (encoded, args.tenant, args.user))
                if not result.rowcount:
                    db.rollback()
                    parser.error("Account not found")
                db.execute("DELETE FROM sessions WHERE tenant_id=? AND user_id=?", (args.tenant, args.user))
                db.commit()
            print("Password updated; existing sessions revoked")
    except (APIError, ValueError, RuntimeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
