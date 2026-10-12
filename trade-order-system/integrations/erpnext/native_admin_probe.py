"""Explicit native Administrator probes for the isolated fictional Example.

Private JSON on stdin supplies the action, stable IDs and reviewed revision.
This uses native controllers/events, without the Tradept managed-write flag.
The original submitted connector fixtures are never changed or re-posted.
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
SITE = "frontend"
NEW_ORDER = "EX-UNIFIED-FLOW-20261012"
PAYMENT_REFERENCE = "TRADEPT-EX-ADV-20261012"
SUFFIX = " (Native verified)"


def main():
    private = json.load(sys.stdin)
    action = private["action"]
    if action not in ("rename-customer", "restore-customer", "supplier-advance"):
        raise ValueError("Unknown explicit probe action")
    os.chdir(BENCH / "sites")
    import frappe
    capture = io.StringIO()
    try:
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            frappe.init(SITE)
            frappe.connect()
            frappe.set_user("Administrator")
            from tradept_core import repository as repo
            work, configuration = repo.workspace(lock=True)
            before = int(work.revision)
            if configuration["id"] != "example-company" or before != private["expectedRevision"]:
                raise ValueError("Probe requires the reviewed isolated Example revision")
            state_dir = BENCH / "sites" / SITE / "private" / "tradept-native-verification"
            state_dir.mkdir(mode=0o700, exist_ok=True)
            state_dir.chmod(0o700)
            if action in ("rename-customer", "restore-customer"):
                record = repo.find("customers", private["customerId"])
                if not record:
                    raise ValueError("Configured fictional customer is missing")
                customer = frappe.get_doc("Customer", record.name, for_update=True)
                state_file = state_dir / "customer-name.json"
                if action == "rename-customer":
                    if state_file.exists():
                        raise ValueError("Existing name probe state must be reviewed first")
                    state = {"customerId": private["customerId"], "nativeName": customer.name, "original": customer.customer_name}
                    fd = os.open(state_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "w") as stream:
                        json.dump(state, stream)
                    customer.customer_name = state["original"] + SUFFIX
                else:
                    state = json.loads(state_file.read_text())
                    if state["nativeName"] != customer.name or state["customerId"] != private["customerId"] or customer.customer_name != state["original"] + SUFFIX:
                        raise ValueError("Native customer differs from the controlled probe")
                    customer.customer_name = state["original"]
                customer.save()
                frappe.db.commit()
                after = int(repo.workspace()[0].revision)
                if after <= before:
                    raise ValueError("Native master change did not advance the workspace")
                if action == "restore-customer":
                    state_file.rename(state_dir / "customer-name-restored.json")
                result = {"ok": True, "action": action, "revisionBefore": before, "revisionAfter": after,
                          "nativeNameSHA256": hashlib.sha256(customer.customer_name.encode()).hexdigest(),
                          "nativeControllerSave": True, "nativeEventsEnabled": True}
            else:
                if private["orderId"] != NEW_ORDER or private["purchaseOrder"] in ("PUR-ORD-2026-00001", "PUR-ORD-2026-00002"):
                    raise ValueError("Only the new fictional unified order is allowed")
                brief = repo.find("orders", NEW_ORDER)
                po = frappe.get_doc("Purchase Order", private["purchaseOrder"], for_update=True)
                if not brief or po.docstatus != 1 or po.currency != "USD" or po.company != "Example Trade Demo" or po.custom_tradept_order_id != NEW_ORDER:
                    raise ValueError("New submitted native purchase order mapping differs")
                existing = frappe.get_all("Payment Entry", filters={"reference_no": PAYMENT_REFERENCE}, fields=["name"])
                if len(existing) > 1:
                    raise ValueError("Ambiguous native probe payment reference")
                if existing:
                    pe = frappe.get_doc("Payment Entry", existing[0].name)
                else:
                    from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry
                    pe = get_payment_entry("Purchase Order", po.name, party_amount=10, bank_amount=10)
                    pe.reference_no = PAYMENT_REFERENCE
                    pe.reference_date = frappe.utils.today()
                    pe.remarks = "Isolated fictional Tradept native verification; no bank transfer"
                    pe.insert()
                    pe.submit()
                references = [row for row in pe.references if row.reference_doctype == "Purchase Order" and row.reference_name == po.name]
                if pe.docstatus != 1 or pe.payment_type != "Pay" or len(pe.references) != 1 or len(references) != 1 or float(references[0].allocated_amount) != 10 or float(pe.paid_amount) != 10 or float(pe.received_amount) != 10:
                    raise ValueError("Native supplier advance differs from the explicit USD10 probe")
                frappe.db.commit()
                advance = float(frappe.db.get_value("Purchase Order", po.name, "advance_paid"))
                result = {"ok": advance == 10, "action": action, "paymentEntry": pe.name,
                          "revisionBefore": before, "revisionAfter": int(repo.workspace()[0].revision),
                          "purchaseAdvancePaidUSD": advance, "nativeControllerSubmit": True,
                          "actualBankTransfer": False, "reusedExistingPayment": bool(existing)}
        print(json.dumps(result))
        return 0
    except Exception as error:
        try:
            frappe.db.rollback()
        except Exception:
            pass
        print(json.dumps({"ok": False, "action": action, "errorType": type(error).__name__, "frames": [{"file": Path(f.filename).name, "line": f.lineno, "function": f.name} for f in traceback.extract_tb(error.__traceback__)]}))
        return 1
    finally:
        frappe.destroy()


if __name__ == "__main__":
    raise SystemExit(main())
