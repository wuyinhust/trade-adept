"""Configure the stateless gateway; use Frappe for accounts and business imports."""
import argparse
import json
import os
from pathlib import Path

from .app import DEFAULT_RUNTIME
from .frappe_client import FrappeGateway, secure_runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="Install fixed site routing; does not create accounts or business data")
    init.add_argument("--sites", type=Path, required=True)
    sub.add_parser("check", help="Validate private fixed site routing")
    args = parser.parse_args()
    try:
        runtime = secure_runtime(args.runtime)
        if args.command == "init":
            data = json.loads(args.sites.read_text(encoding="utf-8"))
            if (not isinstance(data, dict) or set(data) != {"tenants"}
                    or not isinstance(data["tenants"], dict)
                    or any(not isinstance(site, dict) or set(site) != {"origin", "site", "gatewayHmacKey"} for site in data["tenants"].values())):
                raise ValueError("Routing accepts only tenants with origin, site and gatewayHmacKey; credentials belong to Frappe")
            temporary = runtime / "frappe-sites.pending.json"
            descriptor = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)
            os.chmod(temporary, 0o600)
            try:
                FrappeGateway(runtime, temporary)
                os.replace(temporary, runtime / "frappe-sites.json")
            finally:
                temporary.unlink(missing_ok=True)
        gateway = FrappeGateway(runtime)
        print(f"Validated {len(gateway.sites)} independent native sites; no local business database")
    except (ValueError, RuntimeError, OSError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
