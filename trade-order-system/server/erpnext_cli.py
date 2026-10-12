"""Local-only ERP worker; credentials are read from the private runtime."""
import argparse
import json
from .store import Store
from .erpnext import init_schema, load_config, run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    worker = sub.add_parser("run")
    worker.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    store = Store(args.runtime)
    with store.connect() as db:
        init_schema(db)
    if args.command == "run":
        print(json.dumps(run(store, load_config(store.runtime), max(1, min(args.limit, 100))), ensure_ascii=False))


if __name__ == "__main__":
    main()
