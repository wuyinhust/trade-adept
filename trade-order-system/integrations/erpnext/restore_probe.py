"""Restore a reviewed Example backup into a separate, unrouted local site.

Run inside the ERP container. JSON inputs arrive over stdin; credentials and
Frappe exception locals never enter terminal output. Existing sites are never
overwritten and no business document is submitted.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import traceback

BENCH = Path("/home/frappe/frappe-bench")
SITE = "tradept-restore-check.test"
DOCUMENTS = {
    "Sales Order": ["SAL-ORD-2026-00001"],
    "Purchase Order": ["PUR-ORD-2026-00001", "PUR-ORD-2026-00002"],
    "Delivery Note": ["MAT-DN-2026-00001"],
    "Payment Entry": ["ACC-PAY-2026-00001"],
}


def fingerprint(frappe):
    fields = {
        "Sales Order": ["company", "docstatus", "currency", "grand_total", "per_delivered"],
        "Purchase Order": ["company", "docstatus", "currency", "grand_total"],
        "Delivery Note": ["company", "docstatus", "currency", "grand_total", "total_qty"],
        "Payment Entry": ["company", "docstatus", "paid_amount", "received_amount", "payment_type"],
    }
    values = {}
    for doctype, names in DOCUMENTS.items():
        values[doctype] = [dict(frappe.db.get_value(doctype, name, fields[doctype], as_dict=True)) for name in names]
    values["GL Entry"] = [dict(row) for row in frappe.get_all("GL Entry", filters={"voucher_no": "ACC-PAY-2026-00001"}, fields=["name", "company", "account", "party_type", "party", "debit", "credit", "debit_in_account_currency", "credit_in_account_currency", "account_currency", "is_cancelled"], order_by="name asc")]
    raw = json.dumps(values, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest(), values


def main():
    private = json.load(sys.stdin)
    os.chdir(BENCH / "sites")
    import frappe
    capture = io.StringIO()
    try:
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            target = BENCH / "sites" / SITE
            if target.exists():
                raise ValueError("The probe never overwrites an existing site")
            backup = Path(private["backupDirectory"])
            if not backup.is_absolute() or backup.is_symlink():
                raise ValueError("Backup must be an absolute private directory")
            verified = {}
            for name, sha in private["files"].items():
                path = backup / name
                if path.is_symlink() or path.name != name or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != sha:
                    raise ValueError("Backup manifest verification failed")
                verified[name] = path
            sql = next(p for n, p in verified.items() if n.endswith("-database.sql.gz"))
            config = next(p for n, p in verified.items() if n.endswith("-site_config_backup.json"))
            public = next(p for n, p in verified.items() if n.endswith("-files.tar") and not n.endswith("-private-files.tar"))
            private_files = next(p for n, p in verified.items() if n.endswith("-private-files.tar"))
            frappe.init("frontend")
            frappe.connect()
            before_hash, _ = fingerprint(frappe)
            original_db_hash = hashlib.sha256(str(frappe.conf.db_name).encode()).hexdigest()
            frappe.destroy()
            from frappe.installer import _new_site, extract_files
            frappe.init(SITE, new_site=True)
            _new_site(db_name=None, site=SITE, source_sql=str(sql), db_root_username="root", db_root_password=os.environ["MYSQL_ROOT_PASSWORD"], admin_password=private["adminPassword"], mariadb_user_host_login_scope="%")
            site_config = target / "site_config.json"
            restored_config = json.loads(site_config.read_text())
            original_config = json.loads(config.read_text())
            if "encryption_key" in original_config:
                restored_config["encryption_key"] = original_config["encryption_key"]
            restored_config.update(pause_scheduler=True, maintenance_mode=True)
            site_config.write_text(json.dumps(restored_config, indent=2))
            site_config.chmod(0o600)
            for archive in (public, private_files):
                temporary = Path(extract_files(SITE, str(archive)))
                if temporary.resolve() != archive.resolve():
                    temporary.unlink()
            frappe.destroy()
            frappe.init(SITE)
            frappe.connect()
            restored_hash, values = fingerprint(frappe)
            restored_db_hash = hashlib.sha256(str(frappe.conf.db_name).encode()).hexdigest()
            counts = {doctype: frappe.db.count(doctype) for doctype in (*DOCUMENTS, "GL Entry")}
            expected_counts = {"Sales Order": 1, "Purchase Order": 2, "Delivery Note": 1, "Payment Entry": 1, "GL Entry": 2}
            if restored_hash != before_hash or counts != expected_counts or restored_db_hash == original_db_hash:
                raise ValueError("Restored native financial baseline differs")
            total_debit = sum(float(row["debit"]) for row in values["GL Entry"])
            total_credit = sum(float(row["credit"]) for row in values["GL Entry"])
            if total_debit != 1000 or total_credit != 1000:
                raise ValueError("Restored general ledger is not the reviewed demo")
            result = {"ok": True, "site": SITE, "unrouted": True, "maintenanceMode": True,
                      "schedulerPaused": True, "distinctDatabase": True, "databaseNameSHA256": restored_db_hash,
                      "financialFingerprintSHA256": restored_hash, "counts": counts,
                      "glDebit": total_debit, "glCredit": total_credit,
                      "sqlAndPublicAndPrivateFilesRestored": True, "nativeLedgerDocumentsCreated": 0}
        print(json.dumps(result))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "errorType": type(error).__name__, "frames": [{"file": Path(f.filename).name, "line": f.lineno, "function": f.name} for f in traceback.extract_tb(error.__traceback__)]}))
        return 1
    finally:
        frappe.destroy()


if __name__ == "__main__":
    raise SystemExit(main())
