"""Run inside the isolated ERP container; private inputs arrive over stdin.

This deliberately avoids bench's traceback-with-variables for imports, where
configured passwords must never enter terminal output or command arguments.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import traceback

BENCH = Path("/home/frappe/frappe-bench")
SITES = {"frontend", "grandware.test"}


def lossless_diagnostics(source, site):
    """Compare in memory and return field paths/types, never business values."""
    from tradept_core import repository
    from tradept_core.migration import _read
    from tradept_core.schema import COLLECTIONS
    raw, _ = _read(source)
    data = raw.get("data", raw.get("payload", raw))
    actual = repository.payload(native_projection=False)
    findings = []

    def walk(left, right, path):
        if left == right or len(findings) >= 40:
            return
        if isinstance(left, dict) and isinstance(right, dict):
            for key in sorted(set(left) | set(right)):
                if key not in left or key not in right:
                    findings.append({"path": path + "." + key, "sourcePresent": key in left, "nativePresent": key in right})
                else:
                    walk(left[key], right[key], path + "." + key)
        elif isinstance(left, list) and isinstance(right, list):
            if len(left) != len(right):
                findings.append({"path": path, "sourceCount": len(left), "nativeCount": len(right)})
            for index, (before, after) in enumerate(zip(left, right)):
                walk(before, after, f"{path}[{index}]")
        else:
            findings.append({"path": path, "sourceType": type(left).__name__, "nativeType": type(right).__name__})

    tenant = "grandware" if site == "grandware.test" else "example-company"
    for collection in COLLECTIONS:
        expected = [{**row, "id": str(row["id"]), "tenantId": tenant} for row in data.get(collection, [])]
        actual_by_id = {row["id"]: row for row in actual[collection]}
        if len(expected) != len(actual_by_id):
            findings.append({"path": collection, "sourceCount": len(expected), "nativeCount": len(actual_by_id)})
        for index, row in enumerate(expected):
            walk(row, actual_by_id.get(row["id"], {}), f"{collection}[{index}]")
    return findings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("create-site", "install", "import", "attach", "metadata", "retire-bridge", "finish-console"))
    parser.add_argument("--site", required=True, choices=sorted(SITES))
    args = parser.parse_args()
    private = json.load(sys.stdin) if args.action != "metadata" else {}
    os.chdir(BENCH / "sites")
    import frappe
    capture = io.StringIO()
    try:
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            if args.action == "create-site":
                if args.site != "grandware.test":
                    raise ValueError("The existing Example site is preserved")
                if not (BENCH / "sites" / args.site).exists():
                    from frappe.installer import _new_site
                    # Match the installed Frappe new-site command's lifecycle.
                    frappe.init(args.site, new_site=True)
                    _new_site(
                        db_name=None, site=args.site, db_root_username="root",
                        db_root_password=os.environ["MYSQL_ROOT_PASSWORD"],
                        admin_password=private["adminPassword"],
                        install_apps=["erpnext", "tradept_core"],
                        mariadb_user_host_login_scope="%",
                    )
                result = {"ok": True, "site": args.site, "siteExists": True}
            else:
                frappe.init(site=args.site)
                frappe.connect()
                frappe.set_user("Administrator")
                if args.action == "install":
                    from frappe.installer import install_app
                    if "tradept_core" not in frappe.get_installed_apps():
                        install_app("tradept_core")
                    from tradept_core.install import install
                    install()
                    frappe.db.commit()
                    result = {"ok": True, "site": args.site, "schemaInstalled": True}
                elif args.action == "import":
                    from tradept_core.migration import import_workspace
                    result = import_workspace(**private)
                    frappe.db.commit()
                elif args.action == "attach":
                    from tradept_core.migration import attach_existing_native
                    result = attach_existing_native(**private)
                    frappe.db.commit()
                elif args.action == "retire-bridge":
                    if args.site != "frontend":
                        raise ValueError("Only the old Example bridge is retired")
                    name = "trade.integration@example.invalid"
                    if frappe.db.exists("User", name):
                        frappe.db.set_value("User", name, {"enabled": 0, "api_key": None})
                        frappe.db.delete("__Auth", {"doctype": "User", "name": name, "fieldname": "api_secret"})
                        from frappe.sessions import clear_sessions
                        clear_sessions(user=name, keep_current=False, force=True)
                        frappe.clear_cache(user=name)
                        frappe.db.commit()
                    disabled = not frappe.db.exists("User", name) or not frappe.db.get_value("User", name, "enabled")
                    revoked = not frappe.db.get_value("User", name, "api_key") and not frappe.db.count("__Auth", {"doctype": "User", "name": name, "fieldname": "api_secret"})
                    result = {"ok": bool(disabled and revoked), "oldIntegrationAccountDisabled": bool(disabled), "oldIntegrationTokenRevoked": bool(revoked), "oldIntegrationSessionsCleared": True}
                elif args.action == "finish-console":
                    # Existing companies were already installed and imported.
                    # Complete only the native Desk gate, without replaying
                    # setup_company, setup_defaults or any setup fixtures.
                    if args.site != "grandware.test":
                        raise ValueError("Only the reviewed Grandware console gate is configured")
                    from tradept_core import repository
                    work, configuration = repository.workspace(lock=True)
                    before = int(work.revision)
                    expected = {"国润": ("CNY", "China"), "为语": ("CNY", "China"),
                                "Grandware HK": ("USD", "Hong Kong"), "Likeing HK": ("USD", "Hong Kong")}
                    actual = {row.name: row for row in frappe.get_all("Company", fields=["name", "default_currency", "country", "default_receivable_account", "default_payable_account", "default_bank_account"])}
                    if configuration["id"] != "grandware" or before != private["expectedRevision"] or set(actual) != set(expected):
                        raise ValueError("Reviewed Grandware revision or four companies differ")
                    for name, (currency, country) in expected.items():
                        row = actual[name]
                        if row.default_currency != currency or row.country != country or not row.default_receivable_account or not row.default_payable_account or frappe.db.count("Account", {"company": name}) < 90:
                            raise ValueError("Existing native company configuration is incomplete")
                    documents = {dt: frappe.db.count(dt) for dt in ("Item", "Sales Order", "Purchase Order", "Delivery Note", "Payment Entry", "GL Entry")}
                    if any(documents.values()):
                        raise ValueError("The reviewed historical Grandware has no native ledger workflow")
                    from frappe.desk.page.setup_wizard.setup_wizard import enable_setup_wizard_complete, disable_future_access
                    for app in ("frappe", "erpnext"):
                        enable_setup_wizard_complete(app)
                    disable_future_access()
                    frappe.db.commit()
                    frappe.clear_cache()
                    after = int(frappe.db.get_value("Trade Workspace", "workspace", "revision"))
                    current_documents = {dt: frappe.db.count(dt) for dt in documents}
                    result = {"ok": before == after and documents == current_documents and bool(frappe.is_setup_complete()),
                              "site": args.site, "revisionBefore": before, "revisionAfter": after,
                              "nativeDocumentsBefore": documents, "nativeDocumentsAfter": current_documents,
                              "companyCount": len(actual), "existingCompaniesReused": True,
                              "nativeSetupHelpersOnly": True, "setupFixturesExecuted": False,
                              "defaultBankConfiguredCount": sum(bool(row.default_bank_account) for row in actual.values()),
                              "accountingWorkflowAccepted": False}
                else:
                    from tradept_core import repository
                    work, configuration = repository.workspace()
                    result = {
                        "ok": True, "site": args.site,
                        "databaseNameSHA256": hashlib.sha256(str(frappe.conf.db_name).encode()).hexdigest(),
                        "tenantId": configuration["id"],
                        "revision": int(work.revision), "sourceImportSHA256": work.import_hash,
                        "installedApps": frappe.get_installed_apps(),
                        "counts": {dt: frappe.db.count(dt) for dt in ("Customer", "Supplier", "Item", "Sales Order", "Purchase Order", "Delivery Note", "Payment Entry", "GL Entry", "Trade Workspace", "Trade User Profile", "Trade Legacy Order", "Trade Order Brief", "Trade Snapshot", "Trade Import Receipt")},
                    }
        # Migration results contain metadata, counts and document IDs only.
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        # Do not print the captured Frappe output, exception body or locals.
        diagnostics = []
        if args.action == "import" and type(error) is ValueError and str(error).startswith("Lossless import verification failed for "):
            try:
                diagnostics = lossless_diagnostics(private["source"], args.site)
            except Exception:
                pass
        try:
            frappe.db.rollback()
        except Exception:
            pass
        print(json.dumps({"ok": False, "action": args.action, "site": args.site,
                          "errorType": type(error).__name__,
                          "losslessFieldDifferences": diagnostics,
                          "frames": [{"file": Path(f.filename).name, "line": f.lineno,
                                      "function": f.name}
                                     for f in traceback.extract_tb(error.__traceback__)]}))
        return 1
    finally:
        try:
            frappe.destroy()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
