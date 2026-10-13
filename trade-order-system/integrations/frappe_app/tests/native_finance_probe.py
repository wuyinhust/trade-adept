"""Real ERPNext 16 accounting acceptance, exclusively in a rollback transaction.

No credentials are read. Fixtures and temporary role grants are never committed.
Run from the isolated image using its normal Frappe/ERPNext/MariaDB services.
HTTP authentication must be verified separately from this bench dispatch probe.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import re
import sys
import traceback

BENCH = Path("/home/frappe/frappe-bench")
FINANCE_SITE = os.environ.get("TRADEPT_FINANCE_SITE", "frontend")
GRANDWARE_SITE = os.environ.get("TRADEPT_GRANDWARE_SITE", "grandware.test")
checks, responses, hidden_errors = {}, [], []


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def fingerprint():
    """Hash every actual native table, including accounting child tables."""
    tables = frappe.db.sql("SHOW TABLES", as_list=True)
    result = {}
    for (table,) in tables:
        if not (table.startswith("tab") or table.startswith("__")):
            continue
        rows = frappe.db.sql("SELECT * FROM `" + table.replace("`", "``") + "`", as_dict=True)
        canonical = sorted((digest(row) for row in rows))
        result[table] = {"rows": len(rows), "sha256": digest(canonical)}
    return result


def check(name, condition):
    checks[name] = bool(condition)
    if not condition:
        raise AssertionError(name)


def acting(user):
    frappe.set_user(user)
    frappe.session.sid = "native-finance-rollback-probe"
    frappe.session.data.csrf_token = secrets.token_hex(24)


def call(action, supplied, expected=200):
    frappe.local.response.clear()
    identity = (frappe.session.user, frappe.session.sid, frappe.session.data.csrf_token)
    def trace(frame, event, arg):
        if event == "exception" and arg[0] in (TypeError, ValueError) and Path(frame.f_code.co_filename).name in ("finance.py", "finance_native.py", "finance_permissions.py", "permissions.py", "attribution.py", "events.py"):
            entry = {"errorType": arg[0].__name__, "message": str(arg[1])[:150], "file": Path(frame.f_code.co_filename).name, "line": frame.f_lineno, "function": frame.f_code.co_name}
            if entry not in hidden_errors:
                hidden_errors.append(entry)
        return trace
    sys.settrace(trace)
    try:
        result = api.dispatch(action, json.dumps(supplied, default=str))["result"]
    finally:
        sys.settrace(None)
    status = int(frappe.local.response.get("http_status_code", 200))
    responses.append({"action": action, "resource": supplied.get("resource"), "operation": supplied.get("operation"), "status": status, "code": result.get("code")})
    check("session-preserved-" + str(len(responses)), identity == (frappe.session.user, frappe.session.sid, frappe.session.data.csrf_token))
    if status != expected:
        # Diagnostic values remain inside root's private probe log.
        raise AssertionError("dispatch-status-" + str(len(responses)) + ":" + str(status) + ":" + str(result.get("code")))
    checks["dispatch-status-" + str(len(responses))] = True
    return result


def operation(resource, operation, *, doc=None, values=None, source=None, key=None, expected=200):
    current, _ = repo.workspace(lock=True)
    supplied = {"companyId": company_id, "resource": resource, "operation": operation, "expectedVersion": int(current.revision), "idempotencyKey": key or secrets.token_hex(16)}
    if doc:
        supplied.update(name=doc["name"], expectedModified=doc["modified"])
    if values is not None:
        supplied["values"] = values
    if source is not None:
        supplied["source"] = source
    result = call("finance_operation", supplied, expected=expected)
    if expected == 200:
        check("audit-receipt-" + str(len(responses)), bool(frappe.db.exists("Trade Audit", {"revision": result["version"]})))
    return result


def attribution(doc):
    native = frappe.get_doc({"sales_invoice": "Sales Invoice", "purchase_invoice": "Purchase Invoice", "payment_entry": "Payment Entry", "bank_transaction": "Bank Transaction"}[doc["resource"]], doc["name"])
    check("parent-real-actor-" + native.name, native.owner == actor["nativeUser"] and native.modified_by == actor["nativeUser"])
    for child in native.get_all_children():
        check("child-real-actor-" + child.name, child.owner == actor["nativeUser"] and child.modified_by == actor["nativeUser"])
    for dt in ("GL Entry", "Payment Ledger Entry", "Advance Payment Ledger Entry"):
        rows = frappe.get_all(dt, filters={"voucher_type": native.doctype, "voucher_no": native.name}, fields=["owner", "modified_by"])
        check("ledger-real-actor-" + dt + "-" + native.name, all(row.owner == actor["nativeUser"] and row.modified_by == actor["nativeUser"] for row in rows))
    return native


def refreshed(resource, name):
    return call("finance_document", {"companyId": company_id, "resource": resource, "name": name})["document"]


def submit(resource, doc):
    result = operation(resource, "submit", doc=doc)["document"]
    check("native-posted-" + result["name"], result["docstatus"] == 1)
    attribution(result)
    return result


def source_doc(kind, name):
    return {"resource": kind, "name": name, "expectedModified": str(frappe.db.get_value({"sales_order": "Sales Order", "purchase_order": "Purchase Order", "sales_invoice": "Sales Invoice", "purchase_invoice": "Purchase Invoice", "delivery_note": "Delivery Note", "purchase_receipt": "Purchase Receipt"}[kind], name, "modified"))}


def ledger_signature():
    return {dt: digest(frappe.get_all(dt, fields=["*"], order_by="name", limit_page_length=0)) for dt in ("GL Entry", "Payment Ledger Entry", "Advance Payment Ledger Entry")}


def direct_denied(supplied, expected_code):
    """Verify a rejected real facade write without aborting all fixture setup.

Production dispatch rolls back the request transaction. This probe preserves
its larger rollback-only fixture transaction with a database savepoint.
"""
    from tradept_core import finance
    from tradept_core.domain import APIError
    from tradept_core.events import managed_write
    before = ledger_signature()
    identity = (frappe.session.user, frappe.session.sid, frappe.session.data.csrf_token)
    frappe.db.savepoint("finance_probe_denial")
    caught = None
    try:
        work, cfg, current_actor, rules, _ = api._identity(lock=True)
        with managed_write():
            finance.operation(work, cfg, current_actor, rules, supplied)
    except APIError as error:
        caught = error.code
    check("direct-denial-code-" + str(len(checks)), caught == expected_code)
    check("direct-denial-no-ledger-write-" + str(len(checks)), ledger_signature() == before)
    check("direct-denial-session-preserved-" + str(len(checks)), identity == (frappe.session.user, frappe.session.sid, frappe.session.data.csrf_token))
    frappe.db.rollback(save_point="finance_probe_denial")


def installment_and_unreconcile_scenario():
    from tradept_core.events import managed_write
    today, token = frappe.utils.today(), secrets.token_hex(6)
    acting("Administrator")
    with managed_write():
        term_names = []
        for index, days in enumerate((0, 30), 1):
            term_names.append(frappe.get_doc({"doctype": "Payment Term", "payment_term_name": "Finance Probe Term " + token + " " + str(index), "invoice_portion": 50, "due_date_based_on": "Day(s) after invoice date", "credit_days": days}).insert(ignore_permissions=True).name)
        template = frappe.get_doc({"doctype": "Payment Terms Template", "template_name": "Finance Probe Terms " + token, "allocate_payment_based_on_payment_terms": 1, "terms": [{"payment_term": name, "invoice_portion": 50, "due_date_based_on": "Day(s) after invoice date", "credit_days": days} for name, days in zip(term_names, (0, 30))]}).insert(ignore_permissions=True).name
    acting(actor["nativeUser"])
    for resource, party, party_type, party_account, item_account in (("sales_invoice", customer, "Customer", receivable, income), ("purchase_invoice", supplier, "Supplier", payable, expense)):
        account_field = "debitTo" if resource == "sales_invoice" else "creditTo"
        item_field = "incomeAccount" if resource == "sales_invoice" else "expenseAccount"
        invoice_values = {"party": party, "postingDate": today, "currency": "CNY", "conversionRate": 1 / 7, account_field: party_account, "paymentTermsTemplate": template, "items": [{"itemCode": item, "qty": 1, "rate": 70, item_field: item_account, "costCenter": cost_center}]}
        first = submit(resource, operation(resource, "create", values=invoice_values)["document"])
        second = submit(resource, operation(resource, "create", values={**invoice_values, "items": [{"itemCode": item, "qty": 1, "rate": 14, item_field: item_account, "costCenter": cost_center}]})["document"])
        check("native-installment-template-and-party-currency-" + resource, first["allocatePaymentBasedOnPaymentTerms"] is True and len(first["paymentSchedule"]) == 2 and all(row["outstandingCurrency"] == "USD" and row["outstandingAmount"] == 5 for row in first["paymentSchedule"]))
        dt = "Sales Invoice" if resource == "sales_invoice" else "Purchase Invoice"
        references = [{"referenceDoctype": dt, "referenceName": first["name"], "paymentTerm": term, "allocatedAmount": allocated} for term, allocated in zip(term_names, (2, 3))]
        references.append({"referenceDoctype": dt, "referenceName": second["name"], "paymentTerm": term_names[0], "allocatedAmount": 1})
        payment_values = {"partyType": party_type, "party": party, "paymentType": "Receive" if party_type == "Customer" else "Pay", "postingDate": today, "paidFrom": party_account if party_type == "Customer" else bank_gl, "paidTo": bank_gl if party_type == "Customer" else party_account, "paidAmount": 6, "receivedAmount": 6, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "FIN-TERMS-" + resource, "referenceDate": today, "references": references}
        payment = submit("payment_entry", operation("payment_entry", "payment_from_invoice", source=source_doc(resource, first["name"]), values=payment_values)["document"])
        check("native-same-invoice-two-distinct-term-references-" + resource, len([row for row in payment["references"] if row["referenceName"] == first["name"]]) == 2)
        after_first, after_second = refreshed(resource, first["name"]), refreshed(resource, second["name"])
        check("native-installment-partial-balances-" + resource, after_first["outstandingAmount"] == 5 and [row["outstandingAmount"] for row in after_first["paymentSchedule"]] == [3, 2] and after_second["outstandingAmount"] == 1)
        check("native-reference-invoice-modified-readback-" + resource, all(row.get("referenceModified") for row in payment["references"]))
        cash_before = frappe.get_all("GL Entry", filters={"voucher_type": "Payment Entry", "voucher_no": payment["name"], "is_cancelled": 0}, fields=["account", "debit", "credit", "debit_in_account_currency", "credit_in_account_currency"], order_by="name")
        current, _ = repo.workspace(lock=True)
        unlink_request = {"companyId": company_id, "resource": "reconciliation", "operation": "unreconcile", "name": payment["name"], "expectedModified": payment["modified"], "expectedVersion": int(current.revision), "idempotencyKey": secrets.token_hex(16), "values": {"invoices": [{"resource": resource, "name": first["name"], "expectedModified": after_first["modified"]}]}}
        unlinked = call("finance_operation", unlink_request)
        restored_first, preserved_second = refreshed(resource, first["name"]), refreshed(resource, second["name"])
        check("native-unreconcile-retains-posted-payment-" + resource, unlinked["document"]["docstatus"] == 1 and unlinked["document"]["paidAmount"] == 6 and unlinked["document"]["receivedAmount"] == 6 and unlinked["document"]["totalAllocatedAmount"] == 1 and unlinked["document"]["unallocatedAmount"] == 5)
        check("native-unreconcile-selected-invoice-and-periods-restored-" + resource, restored_first["outstandingAmount"] == 10 and [row["outstandingAmount"] for row in restored_first["paymentSchedule"]] == [5, 5])
        check("native-unreconcile-other-invoice-untouched-" + resource, preserved_second["outstandingAmount"] == after_second["outstandingAmount"] and preserved_second["paymentSchedule"] == after_second["paymentSchedule"])
        cash_after = frappe.get_all("GL Entry", filters={"voucher_type": "Payment Entry", "voucher_no": payment["name"], "is_cancelled": 0}, fields=["account", "debit", "credit", "debit_in_account_currency", "credit_in_account_currency"], order_by="name")
        check("native-unreconcile-original-bank-voucher-ledger-unchanged-" + resource, cash_before == cash_after)
        native_unlink = frappe.get_doc("Unreconcile Payment", unlinked["unreconciliation"]["name"])
        check("native-unreconcile-document-actual-actor-" + resource, native_unlink.docstatus == 1 and native_unlink.owner == actor["nativeUser"] and native_unlink.modified_by == actor["nativeUser"] and all(row.owner == actor["nativeUser"] and row.modified_by == actor["nativeUser"] for row in native_unlink.get_all_children()))
        replay = call("finance_operation", unlink_request)
        check("native-unreconcile-idempotent-no-second-period-reversal-" + resource, replay.get("replayed") is True and refreshed(resource, first["name"])["paymentSchedule"] == restored_first["paymentSchedule"])
        work, cfg = repo.workspace(lock=True)
        cfg = copy.deepcopy(cfg)
        saved_permissions = copy.deepcopy(cfg["roles"][actor["role"]]["permissions"])
        cfg["roles"][actor["role"]]["permissions"] = [cap for cap in saved_permissions if cap != "finance.reconciliation.unreconcile"]
        frappe.db.set_value("Trade Workspace", work.name, "configuration", dumps(cfg), update_modified=False)
        direct_denied(unlink_request, "FINANCE_PERMISSION_DENIED")
        cfg["roles"][actor["role"]]["permissions"] = saved_permissions
        frappe.db.set_value("Trade Workspace", work.name, "configuration", dumps(cfg), update_modified=False)


def memo_reconciliation_scenario(first, purchase):
    today = frappe.utils.today()
    for resource, original, party, party_type, account, item_account in (("sales_invoice", first, customer, "Customer", receivable, income), ("purchase_invoice", purchase, supplier, "Supplier", payable, expense)):
        memo = submit(resource, operation(resource, "return", doc=refreshed(resource, original["name"]))["document"])
        target = submit(resource, operation(resource, "create", values={"party": party, "postingDate": today, "dueDate": today, "currency": "USD", "conversionRate": 1, "debitTo" if resource == "sales_invoice" else "creditTo": account, "items": [{"itemCode": item, "qty": 1, "rate": 10, "incomeAccount" if resource == "sales_invoice" else "expenseAccount": item_account, "costCenter": cost_center}]})["document"])
        filters = {"partyType": party_type, "party": party, "receivablePayableAccount": account}
        pool = call("finance_report", {"companyId": company_id, "report": "reconciliation", "filters": filters})
        pay = next(row for row in pool["payments"] if row["referenceName"] == memo["name"])
        inv = next(row for row in pool["invoices"] if row["invoiceNumber"] == target["name"])
        cash_before = digest(frappe.get_all("GL Entry", filters={"account": bank_gl}, fields=["name", "debit", "credit", "is_cancelled"], order_by="name"))
        operation("reconciliation", "reconcile", values={**filters, "allocations": [{"referenceType": pay["referenceType"], "referenceName": pay["referenceName"], "referenceRow": pay.get("referenceRow"), "invoiceType": inv["invoiceType"], "invoiceNumber": inv["invoiceNumber"], "allocatedAmount": 5, "paymentModified": pay["modified"], "invoiceModified": inv["modified"]}]})
        check("native-memo-offset-balances-" + resource, refreshed(resource, target["name"])["outstandingAmount"] == 5 and refreshed(resource, memo["name"])["outstandingAmount"] == memo["outstandingAmount"] + 5)
        rows = frappe.get_all("Journal Entry Account", filters={"reference_type": "Sales Invoice" if resource == "sales_invoice" else "Purchase Invoice", "reference_name": memo["name"]}, fields=["parent"])
        journals = [frappe.get_doc("Journal Entry", row.parent) for row in rows]
        expected_type = "Credit Note" if resource == "sales_invoice" else "Debit Note"
        check("native-memo-offset-journal-" + resource, bool(journals) and any(doc.voucher_type == expected_type and doc.docstatus == 1 for doc in journals))
        for doc in journals:
            check("native-memo-offset-real-actor-" + resource + doc.name, doc.owner == actor["nativeUser"] and doc.modified_by == actor["nativeUser"] and all(row.owner == actor["nativeUser"] and row.modified_by == actor["nativeUser"] for row in doc.get_all_children()))
            for dt in ("GL Entry", "Payment Ledger Entry", "Advance Payment Ledger Entry"):
                rows = frappe.get_all(dt, filters={"voucher_type": "Journal Entry", "voucher_no": doc.name}, fields=["owner", "modified_by"])
                check("native-memo-offset-ledger-actor-" + resource + dt, all(row.owner == actor["nativeUser"] and row.modified_by == actor["nativeUser"] for row in rows))
        check("native-memo-offset-no-bank-movement-" + resource, digest(frappe.get_all("GL Entry", filters={"account": bank_gl}, fields=["name", "debit", "credit", "is_cancelled"], order_by="name")) == cash_before)


def order_settlement_scenario():
    """Grandware's order overview reads native AR/AP, including shared bills."""
    from tradept_core.events import managed_write
    from tradept_core import native as order_native
    from tradept_core.permissions import delegated_operation
    from tradept_core.permissions import delegated_finance_operation
    from tradept_core.finance_permissions import Policy
    from tradept_core.domain import APIError
    from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice
    from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice
    today, token = frappe.utils.today(), secrets.token_hex(6)
    acting("Administrator")
    briefs, sales, purchases = [], [], []
    with managed_write():
        for index, (qty, sale_rate, purchase_rate) in enumerate(((2, 30, 10), (1, 40, 30))):
            order_id = "finance-native-order-" + token + str(index)
            brief = repo.save_record("orders", {"id": order_id, "tenantId": actor["tenantId"], "companyId": company_id, "createdBy": actor["id"], "salespersonId": actor["id"], "companyOperationNo": "FIN-NATIVE-" + token + str(index)})
            sale = frappe.get_doc({"doctype": "Sales Order", "company": company, "customer": customer, "transaction_date": today, "delivery_date": today, "currency": "USD", "conversion_rate": 1, "ignore_pricing_rule": 1, "custom_tradept_order_id": order_id, "items": [{"item_code": item, "qty": qty, "rate": sale_rate, "delivery_date": today}]}).insert(ignore_permissions=True)
            sale.submit()
            purchase = frappe.get_doc({"doctype": "Purchase Order", "company": company, "supplier": supplier, "transaction_date": today, "schedule_date": today, "currency": "USD", "conversion_rate": 1, "ignore_pricing_rule": 1, "custom_tradept_order_id": order_id, "items": [{"item_code": item, "qty": qty, "rate": purchase_rate, "schedule_date": today, "sales_order": sale.name, "sales_order_item": sale.items[0].name}]}).insert(ignore_permissions=True)
            purchase.submit()
            brief.sales_order, brief.customer = sale.name, customer
            brief.save(ignore_permissions=True)
            briefs.append(brief); sales.append(sale); purchases.append(purchase)
    acting(actor["nativeUser"])
    _, cfg, current_actor, rules, _ = api._identity(lock=True)
    policy = Policy(cfg, current_actor, rules)
    native_invoices = []
    for resource, sources, mapper in (("sales_invoice", sales, make_sales_invoice), ("purchase_invoice", purchases, make_purchase_invoice)):
        refs = [{"doctype": source.doctype, "name": source.name} for source in sources]
        with managed_write(), delegated_finance_operation(resource, "create", policy, references=refs, company=company):
            merged = mapper(sources[1].name, target_doc=mapper(sources[0].name))
            merged.owner = actor["nativeUser"]
            policy.validate_document(merged, "create")
            merged.insert(ignore_permissions=True)
            native_invoices.append(merged)
    invoice, bill = native_invoices
    for resource, native_invoice, party, party_type, account, amount, expected in (("sales_invoice", invoice, customer, "Customer", receivable, 60, (36, 24)), ("purchase_invoice", bill, supplier, "Supplier", payable, 20, (8, 12))):
        posted = submit(resource, refreshed(resource, native_invoice.name))
        payment = submit("payment_entry", operation("payment_entry", "payment_from_invoice", source=source_doc(resource, posted["name"]), values={"paidFrom": account if party_type == "Customer" else bank_gl, "paidTo": bank_gl if party_type == "Customer" else account, "paidAmount": amount, "receivedAmount": amount, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "FIN-ORDER-SHARED-" + resource, "referenceDate": today, "references": [{"referenceDoctype": native_invoice.doctype, "referenceName": posted["name"], "allocatedAmount": amount}]})["document"])
        orders = [repo.record(repo.find("orders", "finance-native-order-" + token + str(index)), "orders") for index in range(2)]
        field = "paidAmountUSD" if party_type == "Customer" else "factoryPaidRMB"
        settled_field = "salesInvoiceSettledAmountUSD" if party_type == "Customer" else "factoryInvoiceSettledAmount"
        check("native-shared-invoice-order-settlement-not-double-counted-" + resource, all(abs(row[field] - paid) < .005 and abs(row[settled_field] - paid) < .005 for row, paid in zip(orders, expected)) and abs(sum(row[field] for row in orders) - amount) < .005)
        workbench = call("data", {})["data"]["orders"]
        visible = [next(row for row in workbench if row["id"] == projected["id"]) for projected in orders]
        check("native-workbench-projected-amounts-and-company-scope-" + resource, all(row["companyId"] == company_id and row["nativeSettlementProjection"] and abs(row[field] - paid) < .005 for row, paid in zip(visible, expected)))
        check("native-invoice-payment-does-not-fake-order-advance-" + resource, all(float(frappe.db.get_value("Sales Order" if party_type == "Customer" else "Purchase Order", source.name, "advance_paid")) == 0 for source in (sales if party_type == "Customer" else purchases)))
        check("native-shared-bank-voucher-nonadditive-" + resource, all(any(row["name"] == payment["name"] and row["sharedReceipt"] and not row["additiveByOrder"] for row in order["nativeReceiptSummary"]) for order in orders))
        if party_type == "Customer":
            before = ledger_signature()
            try:
                _, cfg, current_actor, rules, _ = api._identity(lock=True)
                doc = repo.find("orders", orders[0]["id"])
                with managed_write(), delegated_operation("receive_payment", cfg, current_actor, rules, orders[0], repo.payload(), doc):
                    order_native.receive_payment(doc, orders[0], {"amountUSD": 1, "idempotencyKey": secrets.token_hex(16)})
                blocked = False
            except APIError as error:
                blocked = error.code == "FINANCE_INVOICE_PAYMENT_REQUIRED"
            check("native-order-legacy-prepayment-blocked-after-invoice", blocked and before == ledger_signature())
        current, _ = repo.workspace(lock=True)
        unlink = call("finance_operation", {"companyId": company_id, "resource": "reconciliation", "operation": "unreconcile", "name": payment["name"], "expectedModified": refreshed("payment_entry", payment["name"])["modified"], "expectedVersion": int(current.revision), "idempotencyKey": secrets.token_hex(16), "values": {"invoices": [{"resource": resource, "name": posted["name"], "expectedModified": refreshed(resource, posted["name"])["modified"]}]}})
        orders = [repo.record(repo.find("orders", "finance-native-order-" + token + str(index)), "orders") for index in range(2)]
        check("native-order-unlink-reopens-allocation-not-bank-cash-" + resource, all(abs(row[field]) < .005 and any(cash["name"] == payment["name"] and cash["bankAmount"] == amount and cash["unallocatedAmount"] == amount for cash in row["nativeReceiptSummary"]) for row in orders) and unlink["document"]["docstatus"] == 1)
        filters = {"partyType": party_type, "party": party, "receivablePayableAccount": account}
        pool = call("finance_report", {"companyId": company_id, "report": "reconciliation", "filters": filters})
        pay = next(row for row in pool["payments"] if row["referenceName"] == payment["name"])
        inv = next(row for row in pool["invoices"] if row["invoiceNumber"] == posted["name"])
        operation("reconciliation", "reconcile", values={**filters, "allocations": [{"referenceType": pay["referenceType"], "referenceName": pay["referenceName"], "referenceRow": pay.get("referenceRow"), "invoiceType": inv["invoiceType"], "invoiceNumber": inv["invoiceNumber"], "allocatedAmount": amount, "paymentModified": pay["modified"], "invoiceModified": inv["modified"]}]})
        returned = submit(resource, operation(resource, "return", doc=refreshed(resource, posted["name"]))["document"])
        refund = submit("payment_entry", operation("payment_entry", "payment_from_invoice", source=source_doc(resource, returned["name"]), values={"paidFrom": bank_gl if party_type == "Customer" else account, "paidTo": account if party_type == "Customer" else bank_gl, "paidAmount": 5, "receivedAmount": 5, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "FIN-ORDER-REFUND-" + resource, "referenceDate": today, "references": [{"referenceDoctype": native_invoice.doctype, "referenceName": returned["name"], "allocatedAmount": -5}]})["document"])
        orders = [repo.record(repo.find("orders", "finance-native-order-" + token + str(index)), "orders") for index in range(2)]
        check("native-order-return-refund-signed-source-share-" + resource, abs(sum(row[field] for row in orders) - (amount - 5)) < .005 and all(any(cash["name"] == refund["name"] and cash["bankAmount"] == 5 for cash in row["nativeReceiptSummary"]) for row in orders))


def unprovisioned_native_role_scenario():
    from tradept_core.events import managed_write
    from tradept_core import permissions
    from tradept_core.domain import APIError
    acting("Administrator")
    with managed_write():
        user = frappe.get_doc({"doctype": "User", "email": "finance-role-probe-" + secrets.token_hex(6) + "@example.invalid", "first_name": "Rollback finance role fixture", "enabled": 1, "user_type": "System User", "send_welcome_email": 0, "roles": [{"role": "Tradept Finance"}, {"role": "Accounts Manager"}]}).insert(ignore_permissions=True).name
    acting(user)
    check("native-role-without-profile-account-detected", not frappe.db.exists("Trade User Profile", {"user": user}) and permissions.is_workbench_user(user))
    check("native-role-without-profile-finance-rest-denied", permissions.native_permission(doc=frappe.get_doc("Company", company), user=user, permission_type="read") is False and permissions.native_query(user=user) == "1=0")
    try:
        api._identity()
        blocked = False
    except APIError as error:
        blocked = error.status == 403
    check("native-role-without-profile-workbench-denied", blocked)
    acting(actor["nativeUser"])


def prepare_fixtures():
    global company_id, company, actor, income, expense, receivable, fx_receivable, payable, cost_center, bank_account, bank_gl, fx_bank_gl, customer, fx_customer, supplier, item, sales_order, purchase_order, delivery, receipt
    current, cfg = repo.workspace(lock=True)
    users = repo.profiles()
    actor = next(profile for profile in users.values() if profile.get("role") == "admin")
    company_id = next(iter(actor.get("visibleCompanyIds") or [cfg["companies"][0]["id"]]))
    company = repo.native_company(company_id)
    check("fixture-company-native-usd", frappe.db.get_value("Company", company, "default_currency") == "USD")
    cfg = copy.deepcopy(cfg)
    role = cfg["roles"][actor["role"]]
    role["permissions"] = sorted(set(role.get("permissions", [])) | set(FINANCE_CAPABILITIES))
    role["financePolicy"] = {"scope": "tenant", "paymentLimit": None, "allowedBankAccounts": None}
    frappe.db.set_value("Trade Workspace", current.name, "configuration", dumps(cfg), update_modified=False)
    frappe.set_user("Administrator")
    token = secrets.token_hex(6)
    account_rows = frappe.get_all("Account", filters={"company": company, "is_group": 0, "disabled": 0}, fields=["name", "account_type", "root_type", "parent_account", "account_currency"])
    income = next(row.name for row in account_rows if row.root_type == "Income" and row.account_currency == "USD")
    expense = next(row.name for row in account_rows if row.root_type == "Expense" and row.account_currency == "USD")
    receivable = next(row.name for row in account_rows if row.account_type == "Receivable" and row.account_currency == "USD")
    payable = next(row.name for row in account_rows if row.account_type == "Payable" and row.account_currency == "USD")
    asset_parent = frappe.db.get_value("Account", {"company": company, "account_type": "Bank", "is_group": 1}, "name") or next(row.parent_account for row in account_rows if row.account_type in ("Bank", "Cash"))
    cost_center = frappe.db.get_value("Cost Center", {"company": company, "is_group": 0}, "name")
    from tradept_core.events import managed_write
    with managed_write():
        bank_gl = frappe.get_doc({"doctype": "Account", "account_name": "Finance Probe USD " + token, "parent_account": asset_parent, "company": company, "account_currency": "USD", "account_type": "Bank", "is_group": 0}).insert(ignore_permissions=True).name
        fx_bank_gl = frappe.get_doc({"doctype": "Account", "account_name": "Finance Probe CNY " + token, "parent_account": asset_parent, "company": company, "account_currency": "CNY", "account_type": "Bank", "is_group": 0}).insert(ignore_permissions=True).name
        fx_receivable = frappe.get_doc({"doctype": "Account", "account_name": "Finance Probe CNY Receivable " + token, "parent_account": frappe.db.get_value("Account", receivable, "parent_account"), "company": company, "account_currency": "CNY", "account_type": "Receivable", "is_group": 0}).insert(ignore_permissions=True).name
        frappe.db.set_value("Company", company, {"exchange_gain_loss_account": expense, "cost_center": cost_center}, update_modified=False)
        bank = frappe.get_doc({"doctype": "Bank", "bank_name": "Finance Probe " + token}).insert(ignore_permissions=True).name
        bank_account = frappe.get_doc({"doctype": "Bank Account", "account_name": "Finance Probe " + token, "bank": bank, "company": company, "is_company_account": 1, "account": bank_gl, "bank_account_no": "TEST-" + token}).insert(ignore_permissions=True).name
        customer = frappe.get_doc({"doctype": "Customer", "customer_name": "Finance Probe Customer " + token, "customer_type": "Company", "customer_group": "Tradept Customers", "territory": "Tradept Territory", "custom_tradept_company": company, "accounts": [{"company": company, "account": receivable}]}).insert(ignore_permissions=True).name
        fx_customer = frappe.get_doc({"doctype": "Customer", "customer_name": "Finance Probe CNY Customer " + token, "customer_type": "Company", "customer_group": "Tradept Customers", "territory": "Tradept Territory", "default_currency": "CNY", "custom_tradept_company": company, "accounts": [{"company": company, "account": fx_receivable}]}).insert(ignore_permissions=True).name
        supplier = frappe.get_doc({"doctype": "Supplier", "supplier_name": "Finance Probe Supplier " + token, "supplier_type": "Company", "supplier_group": "Tradept Suppliers", "custom_tradept_company": company, "accounts": [{"company": company, "account": payable}]}).insert(ignore_permissions=True).name
        item = frappe.get_doc({"doctype": "Item", "item_code": "FIN-PROBE-" + token, "item_name": "Finance Probe Item", "item_group": "All Item Groups", "stock_uom": "Nos", "is_stock_item": 0, "item_defaults": [{"company": company, "default_income_account": income, "default_expense_account": expense, "selling_cost_center": cost_center, "buying_cost_center": cost_center}]}).insert(ignore_permissions=True).name
        today = frappe.utils.today()
        sales_order = frappe.get_doc({"doctype": "Sales Order", "company": company, "customer": customer, "transaction_date": today, "delivery_date": today, "currency": "USD", "conversion_rate": 1, "ignore_pricing_rule": 1, "items": [{"item_code": item, "qty": 10, "rate": 10, "delivery_date": today}]}).insert(ignore_permissions=True)
        sales_order.submit()
        purchase_order = frappe.get_doc({"doctype": "Purchase Order", "company": company, "supplier": supplier, "transaction_date": today, "schedule_date": today, "currency": "USD", "conversion_rate": 1, "ignore_pricing_rule": 1, "items": [{"item_code": item, "qty": 10, "rate": 7, "schedule_date": today}]}).insert(ignore_permissions=True)
        purchase_order.submit()
        delivery = frappe.get_doc({"doctype": "Delivery Note", "company": company, "customer": customer, "posting_date": today, "currency": "USD", "conversion_rate": 1, "ignore_pricing_rule": 1, "items": [{"item_code": item, "qty": 1, "rate": 10, "income_account": income, "cost_center": cost_center}]}).insert(ignore_permissions=True)
        delivery.submit()
        receipt = frappe.get_doc({"doctype": "Purchase Receipt", "company": company, "supplier": supplier, "posting_date": today, "currency": "USD", "conversion_rate": 1, "ignore_pricing_rule": 1, "items": [{"item_code": item, "qty": 1, "rate": 7, "expense_account": expense, "cost_center": cost_center}]}).insert(ignore_permissions=True)
        receipt.submit()
    acting(actor["nativeUser"])
    check("configured-native-actor-company-grant", bool(frappe.db.exists("User Permission", {"user": actor["nativeUser"], "allow": "Company", "for_value": company})))


def success_scenario():
    today = frappe.utils.today()
    management = call("admin_state", {})
    check("native-admin-finance-matrix-and-bank-field", "finance.payment_entry.deductions" in management["options"]["permissions"] and any(row["name"] == bank_account for row in management["options"]["finance"]["bankAccounts"]))
    invoice_values = {"party": customer, "postingDate": today, "dueDate": today, "currency": "USD", "conversionRate": 1, "debitTo": receivable, "items": [{"itemCode": item, "qty": 10, "rate": 10, "incomeAccount": income, "costCenter": cost_center}]}
    for resource, party, party_field, account, item_field, item_account in (("sales_invoice", customer, "debitTo", receivable, "incomeAccount", income), ("purchase_invoice", supplier, "creditTo", payable, "expenseAccount", expense)):
        bare = operation(resource, "create", values={"party": party, "postingDate": today, "dueDate": today, "currency": "USD", "conversionRate": 1, party_field: "", "costCenter": "", "items": [{"itemCode": item, "qty": 1, "rate": 2, item_field: "", "costCenter": ""}]})["document"]
        check("native-default-party-account-" + resource, bare[party_field] == account)
        check("native-default-item-account-and-cost-center-" + resource, bare["items"][0][item_field] == item_account and bare["items"][0]["costCenter"] == cost_center)
        line = bare["items"][0]
        reset = operation(resource, "save", doc=bare, values={party_field: None, "costCenter": None, "items": [{"name": line["name"], "itemCode": item, "qty": 1, "rate": 2, item_field: None, "costCenter": None}]})["document"]
        check("native-default-reset-null-" + resource, reset[party_field] == account and reset["items"][0][item_field] == item_account and reset["items"][0]["costCenter"] == cost_center)
        default_posted = submit(resource, reset)
        check("native-default-bare-invoice-posted-" + resource, default_posted["grandTotal"] == 2 and default_posted["docstatus"] == 1)
    stable = secrets.token_hex(16)
    first = operation("sales_invoice", "create", values=invoice_values, key=stable)["document"]
    check("real-native-sales-invoice-draft", first["docstatus"] == 0 and first["grandTotal"] == 100)
    replay = operation("sales_invoice", "create", values=invoice_values, key=stable)
    check("invoice-idempotency-one-document", replay.get("replayed") is True and replay["document"]["name"] == first["name"])
    first = submit("sales_invoice", first)
    second = submit("sales_invoice", operation("sales_invoice", "create", values={**invoice_values, "items": [{"itemCode": item, "qty": 5, "rate": 10, "incomeAccount": income, "costCenter": cost_center}]})["document"])
    purchase = submit("purchase_invoice", operation("purchase_invoice", "create", values={"party": supplier, "postingDate": today, "dueDate": today, "currency": "USD", "conversionRate": 1, "creditTo": payable, "billNo": "FIN-PROBE", "billDate": today, "items": [{"itemCode": item, "qty": 10, "rate": 7, "expenseAccount": expense, "costCenter": cost_center}]})["document"])
    receipt_values = {"partyType": "Customer", "party": customer, "paymentType": "Receive", "postingDate": today, "paidFrom": receivable, "paidTo": bank_gl, "paidAmount": 35, "receivedAmount": 35, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "FIN-RECEIPT", "referenceDate": today, "costCenter": cost_center, "references": [{"referenceDoctype": "Sales Invoice", "referenceName": first["name"], "allocatedAmount": 25}, {"referenceDoctype": "Sales Invoice", "referenceName": second["name"], "allocatedAmount": 10}]}
    payment = submit("payment_entry", operation("payment_entry", "create", values=receipt_values)["document"])
    check("partial-multi-invoice-native-balances", abs(refreshed("sales_invoice", first["name"])["outstandingAmount"] - 75) < .005 and abs(refreshed("sales_invoice", second["name"])["outstandingAmount"] - 40) < .005)
    supplier_pay = submit("payment_entry", operation("payment_entry", "payment_from_invoice", source=source_doc("purchase_invoice", purchase["name"]), values={"paidFrom": bank_gl, "paidTo": payable, "paidAmount": 20, "receivedAmount": 20, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "FIN-SUPPLIER", "referenceDate": today, "references": [{"referenceDoctype": "Purchase Invoice", "referenceName": purchase["name"], "allocatedAmount": 20}]})["document"])
    check("supplier-native-outstanding", abs(refreshed("purchase_invoice", purchase["name"])["outstandingAmount"] - 50) < .005)
    for resource, source_kind, source in (("sales_invoice", "sales_order", sales_order), ("purchase_invoice", "purchase_order", purchase_order), ("sales_invoice", "delivery_note", delivery), ("purchase_invoice", "purchase_receipt", receipt)):
        draft = operation(resource, "from_order", source=source_doc(source_kind, source.name))["document"]
        check("native-mapped-" + source_kind, draft["docstatus"] == 0 and bool(draft["items"]))
        attribution(draft)
        if source_kind == "sales_order":
            row = draft["items"][0]
            edited = operation(resource, "save", doc=draft, values={"items": [{"name": row["name"], "itemCode": row["itemCode"], "qty": 2, "rate": row["rate"]}]})["document"]
            check("native-source-row-links-retained", edited["items"][0].get("salesOrder") == sales_order.name)
    fx = submit("payment_entry", operation("payment_entry", "create", values={"partyType": "Customer", "party": customer, "paymentType": "Receive", "postingDate": today, "paidFrom": receivable, "paidTo": fx_bank_gl, "paidAmount": 10, "receivedAmount": 70, "sourceExchangeRate": 1, "targetExchangeRate": 1 / 7, "referenceNo": "FIN-FX", "referenceDate": today, "references": []})["document"])
    check("actual-distinct-payment-currencies", fx["paidAmount"] == 10 and fx["receivedAmount"] == 70 and fx["paidFromAccountCurrency"] == "USD" and fx["paidToAccountCurrency"] == "CNY")
    foreign_invoice = submit("sales_invoice", operation("sales_invoice", "create", values={**invoice_values, "currency": "CNY", "conversionRate": 1 / 7, "items": [{"itemCode": item, "qty": 1, "rate": 70, "incomeAccount": income, "costCenter": cost_center}]})["document"])
    check("foreign-invoice-amount-and-native-outstanding-currency", foreign_invoice["currency"] == "CNY" and foreign_invoice["grandTotal"] == 70 and foreign_invoice["outstandingCurrency"] == "USD" and abs(foreign_invoice["outstandingAmount"] - 10) < .005 and abs(foreign_invoice["conversionRate"] - 1 / 7) < .000001)
    transfer = submit("payment_entry", operation("payment_entry", "create", values={"paymentType": "Internal Transfer", "postingDate": today, "paidFrom": bank_gl, "paidTo": fx_bank_gl, "paidAmount": 10, "receivedAmount": 70, "sourceExchangeRate": 1, "targetExchangeRate": 1 / 7, "referenceNo": "FIN-INTERNAL-TRANSFER", "referenceDate": today, "references": []})["document"])
    check("company-native-internal-transfer-without-party", transfer["paymentType"] == "Internal Transfer" and not transfer.get("party") and transfer["paidAmount"] == 10 and transfer["receivedAmount"] == 70)
    gain_invoice = submit("sales_invoice", operation("sales_invoice", "create", values={**invoice_values, "party": fx_customer, "currency": "CNY", "conversionRate": 1 / 7, "debitTo": fx_receivable, "items": [{"itemCode": item, "qty": 1, "rate": 70, "incomeAccount": income, "costCenter": cost_center}]})["document"])
    gain_payment = submit("payment_entry", operation("payment_entry", "create", values={"partyType": "Customer", "party": fx_customer, "paymentType": "Receive", "postingDate": today, "paidFrom": fx_receivable, "paidTo": bank_gl, "paidAmount": 70, "receivedAmount": 11, "sourceExchangeRate": 11 / 70, "targetExchangeRate": 1, "referenceNo": "FIN-EXCHANGE-GAIN", "referenceDate": today, "costCenter": cost_center, "references": [{"referenceDoctype": "Sales Invoice", "referenceName": gain_invoice["name"], "allocatedAmount": 70}]})["document"])
    journals = frappe.get_all("Journal Entry Account", filters={"reference_type": "Payment Entry", "reference_name": gain_payment["name"]}, fields=["parent"])
    check("native-exchange-gain-loss-journal-created", bool(journals))
    for journal_row in journals:
        journal = frappe.get_doc("Journal Entry", journal_row.parent)
        check("native-system-fx-journal-bound", journal.voucher_type == "Exchange Gain Or Loss" and bool(journal.is_system_generated) and journal.company == company and journal.docstatus == 1)
        check("native-fx-journal-real-actor", journal.owner == actor["nativeUser"] and journal.modified_by == actor["nativeUser"] and all(row.owner == actor["nativeUser"] and row.modified_by == actor["nativeUser"] for row in journal.get_all_children()))
        for ledger_type in ("GL Entry", "Payment Ledger Entry", "Advance Payment Ledger Entry"):
            journal_ledger = frappe.get_all(ledger_type, filters={"voucher_type": "Journal Entry", "voucher_no": journal.name}, fields=["owner", "modified_by"])
            check("native-fx-journal-ledger-real-actor-" + ledger_type, all(row.owner == actor["nativeUser"] and row.modified_by == actor["nativeUser"] for row in journal_ledger))
    advance = submit("payment_entry", operation("payment_entry", "payment_from_invoice", source=source_doc("sales_order", sales_order.name), values={"paidFrom": receivable, "paidTo": bank_gl, "paidAmount": 15, "receivedAmount": 15, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "FIN-ADVANCE", "referenceDate": today, "references": [{"referenceDoctype": "Sales Order", "referenceName": sales_order.name, "allocatedAmount": 15}]})["document"])
    check("native-so-prepayment-separate-from-invoice-debt", float(frappe.db.get_value("Sales Order", sales_order.name, "advance_paid")) == 15 and refreshed("sales_invoice", first["name"])["outstandingAmount"] == 75)
    recon_filters = {"partyType": "Customer", "party": customer, "receivablePayableAccount": receivable}
    pool = call("finance_report", {"companyId": company_id, "report": "reconciliation", "filters": recon_filters})
    pay = next(row for row in pool["payments"] if row["referenceName"] == advance["name"])
    inv = next(row for row in pool["invoices"] if row["invoiceNumber"] == first["name"])
    reconciled = operation("reconciliation", "reconcile", values={**recon_filters, "allocations": [{"referenceType": pay["referenceType"], "referenceName": pay["referenceName"], "referenceRow": pay.get("referenceRow"), "invoiceType": inv["invoiceType"], "invoiceNumber": inv["invoiceNumber"], "allocatedAmount": 5, "paymentModified": pay["modified"], "invoiceModified": inv["modified"]}]})
    check("native-prepayment-invoice-reconciliation", reconciled["ok"] is True and refreshed("sales_invoice", first["name"])["outstandingAmount"] == 70)
    for report_name, party, expected_name, expected_outstanding in (("receivables", customer, first["name"], 70), ("payables", supplier, purchase["name"], 50)):
        rows = call("finance_report", {"companyId": company_id, "report": report_name, "filters": {"party": party, "reportDate": today, "inPartyCurrency": True}})["result"]
        selected = [row for row in rows if row.get("voucher_no") == expected_name]
        check("native-report-" + report_name, bool(selected) and abs(sum(float(row.get("outstanding") or 0) for row in selected) - expected_outstanding) < .005)
    ledger = call("finance_report", {"companyId": company_id, "report": "general_ledger", "filters": {"fromDate": today, "toDate": today, "partyType": "Customer", "party": customer}})
    check("native-general-ledger-real-vouchers", bool(ledger["columns"]) and bool(ledger["result"]))
    bank_doc = submit("bank_transaction", operation("bank_transaction", "create", values={"bankAccount": bank_account, "date": today, "deposit": 35, "withdrawal": 0, "currency": "USD", "referenceNumber": "FIN-BANK-RECEIPT", "description": "Rollback-only actual bank receipt fixture"})["document"])
    payment = refreshed("payment_entry", payment["name"])
    matched = operation("bank_reconciliation", "reconcile", doc=bank_doc, values={"vouchers": [{"name": payment["name"], "expectedModified": payment["modified"]}]})["document"]
    check("native-bank-reconciliation-actual-receipt", matched["deposit"] == 35 and matched["allocatedAmount"] == 35 and matched["unallocatedAmount"] == 0)
    bank_report = call("finance_report", {"companyId": company_id, "report": "bank_reconciliation", "filters": {"bankAccount": bank_account, "allTransactions": True}})
    check("native-bank-statement-readback", any(row["name"] == bank_doc["name"] and row["deposit"] == 35 for row in bank_report["transactions"]))
    unmatched = operation("bank_reconciliation", "unreconcile", doc=matched, values={"vouchers": [{"name": payment["name"], "expectedModified": refreshed("payment_entry", payment["name"])["modified"]}]})["document"]
    check("native-bank-unmatch-without-payment-cancellation", unmatched["unallocatedAmount"] == 35 and refreshed("payment_entry", payment["name"])["docstatus"] == 1)
    fee_payment = submit("payment_entry", operation("payment_entry", "create", values={**receipt_values, "paidAmount": 9, "receivedAmount": 9, "referenceNo": "FIN-BANK-FEE", "references": [{"referenceDoctype": "Sales Invoice", "referenceName": second["name"], "allocatedAmount": 10}], "deductions": [{"account": expense, "costCenter": cost_center, "amount": 1, "description": "Native same-currency bank fee"}]})["document"])
    fee_gl = frappe.get_all("GL Entry", filters={"voucher_type": "Payment Entry", "voucher_no": fee_payment["name"], "is_cancelled": 0}, fields=["account", "debit", "credit"])
    check("native-same-currency-bank-fee-net-and-gross", fee_payment["paidAmount"] == 9 and fee_payment["receivedAmount"] == 9 and fee_payment["totalAllocatedAmount"] == 10 and refreshed("sales_invoice", second["name"])["outstandingAmount"] == 30 and any(row.account == bank_gl and float(row.debit) == 9 for row in fee_gl) and any(row.account == expense and float(row.debit) == 1 for row in fee_gl))
    auto_advance = operation("sales_invoice", "create", values={**invoice_values, "allocateAdvances": True, "items": [{"itemCode": item, "qty": 1, "rate": 10, "incomeAccount": income, "costCenter": cost_center}]})["document"]
    check("native-invoice-advance-draft-linked", bool(auto_advance["advances"]) and sum(float(row["allocatedAmount"]) for row in auto_advance["advances"]) == 10)
    auto_advance = submit("sales_invoice", auto_advance)
    check("native-invoice-advance-allocated-on-submit", refreshed("sales_invoice", auto_advance["name"])["outstandingAmount"] == 0)
    for advance_row in auto_advance["advances"]:
        if advance_row["referenceType"] == "Payment Entry":
            attribution(refreshed("payment_entry", advance_row["referenceName"]))
    for resource, original in (("sales_invoice", first), ("purchase_invoice", purchase)):
        returned = operation(resource, "return", doc=refreshed(resource, original["name"]))["document"]
        check("native-return-linked-" + resource, returned["isReturn"] == 1 and returned["returnAgainst"] == original["name"] and returned["grandTotal"] < 0)
        returned = submit(resource, returned)
        returned = refreshed(resource, returned["name"])
        check("native-return-own-credit-balance-" + resource, returned["outstandingAmount"] < 0)
        refund_amount = min(5, abs(float(returned["outstandingAmount"])))
        customer_refund = resource == "sales_invoice"
        work, limit_cfg = repo.workspace(lock=True)
        limit_cfg = copy.deepcopy(limit_cfg)
        original_policy = copy.deepcopy(limit_cfg["roles"][actor["role"]]["financePolicy"])
        limit_cfg["roles"][actor["role"]]["financePolicy"]["paymentLimit"] = {"amount": 10, "currency": "USD"}
        frappe.db.set_value("Trade Workspace", work.name, "configuration", dumps(limit_cfg), update_modified=False)
        direct_denied({"companyId": company_id, "resource": "payment_entry", "operation": "payment_from_invoice", "expectedVersion": int(work.revision), "idempotencyKey": secrets.token_hex(16), "source": source_doc(resource, returned["name"]), "values": {"paymentType": "Pay" if customer_refund else "Receive", "paidFrom": bank_gl if customer_refund else payable, "paidTo": receivable if customer_refund else bank_gl, "paidAmount": 15, "receivedAmount": 15, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "FIN-REFUND-LIMIT-DENIED", "referenceDate": today, "references": [{"referenceDoctype": "Sales Invoice" if customer_refund else "Purchase Invoice", "referenceName": returned["name"], "allocatedAmount": -15}]}}, "FINANCE_PAYMENT_LIMIT_EXCEEDED")
        refund = submit("payment_entry", operation("payment_entry", "payment_from_invoice", source=source_doc(resource, returned["name"]), values={"paymentType": "Pay" if customer_refund else "Receive", "paidFrom": bank_gl if customer_refund else payable, "paidTo": receivable if customer_refund else bank_gl, "paidAmount": refund_amount, "receivedAmount": refund_amount, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "FIN-PARTIAL-REFUND-" + resource, "referenceDate": today, "references": [{"referenceDoctype": "Sales Invoice" if customer_refund else "Purchase Invoice", "referenceName": returned["name"], "allocatedAmount": -refund_amount}]})["document"])
        # ERPNext normalizes the voucher allocation total with abs(), while
        # retaining the credit/debit invoice reference's signed allocation.
        check("native-negative-allocation-refund-within-actual-limit-" + resource, refund["docstatus"] == 1 and refund["paidAmount"] == 5 and refund["totalAllocatedAmount"] == 5 and sum(float(row["allocatedAmount"]) for row in refund["references"]) == -5)
        work, restored_cfg = repo.workspace(lock=True)
        restored_cfg = copy.deepcopy(restored_cfg)
        restored_cfg["roles"][actor["role"]]["financePolicy"] = original_policy
        frappe.db.set_value("Trade Workspace", work.name, "configuration", dumps(restored_cfg), update_modified=False)
        check("native-return-partial-refund-" + resource, refund["paymentType"] == ("Pay" if customer_refund else "Receive") and abs(refreshed(resource, returned["name"])["outstandingAmount"] - (returned["outstandingAmount"] + refund_amount)) < .005)
        cancelled_refund = operation("payment_entry", "cancel", doc=refreshed("payment_entry", refund["name"]))["document"]
        check("native-refund-cancelled-before-return-" + resource, cancelled_refund["docstatus"] == 2 and abs(refreshed(resource, returned["name"])["outstandingAmount"] - returned["outstandingAmount"]) < .005)
        cancelled = operation(resource, "cancel", doc=refreshed(resource, returned["name"]))["document"]
        check("native-return-cancelled-" + resource, cancelled["docstatus"] == 2)
        amended = operation(resource, "amend", doc=cancelled)["document"]
        check("native-amended-return-" + resource, amended["docstatus"] == 0 and amended["amendedFrom"] == returned["name"])
    installment_and_unreconcile_scenario()
    memo_reconciliation_scenario(first, purchase)
    order_settlement_scenario()
    unprovisioned_native_role_scenario()
    check("all-finance-resources-state", all(call("finance_state", {"companyId": company_id, "resource": resource})["version"] >= 0 for resource in ("sales_invoice", "purchase_invoice", "payment_entry", "receivables", "payables", "general_ledger", "reconciliation", "bank_transaction", "bank_reconciliation")))
    legacy_receipt_scenario()


def legacy_receipt_scenario():
    """The existing Orders button must respect every new payment boundary."""
    from types import SimpleNamespace
    from tradept_core import native
    from tradept_core.permissions import delegated_operation
    from tradept_core.domain import Rules, APIError
    _, configured = repo.workspace()
    cfg = copy.deepcopy(configured)
    profiles = repo.profiles()
    key = "FIN-LEGACY-" + secrets.token_hex(5)
    frappe.db.set_value("Sales Order", sales_order.name, "custom_tradept_order_id", key, update_modified=False)
    value = {"id": key, "companyId": company_id, "createdBy": actor["id"]}
    data = {"orders": [value], "customers": [], "factories": []}
    brief = SimpleNamespace(sales_order=sales_order.name, doctype="Trade Order Brief", name="native-probe-brief")
    role = cfg["roles"][actor["role"]]
    allowed = copy.deepcopy(role)
    request = {"idempotencyKey": secrets.token_hex(16), "amountUSD": 2, "bankAccount": bank_gl, "referenceNo": "FIN-LEGACY-RECEIPT", "referenceDate": frappe.utils.today()}

    def run():
        with delegated_operation("receive_payment", cfg, actor, Rules(cfg, profiles), value, data, brief):
            return native.receive_payment(brief, value, request)

    def denied(name, code):
        before = frappe.db.count("Payment Entry")
        try:
            run()
        except APIError as error:
            check(name, error.code == code and frappe.db.count("Payment Entry") == before)
        else:
            raise AssertionError(name)

    role["permissions"] = ["read", "edit", "finance.write"]
    denied("legacy-finance-write-cannot-bypass-exact-grants", "FINANCE_PERMISSION_DENIED")
    cfg["roles"][actor["role"]] = role = copy.deepcopy(allowed)
    role["financePolicy"]["paymentLimit"] = {"amount": 1, "currency": "USD"}
    denied("legacy-order-receipt-enforces-native-payment-limit", "FINANCE_PAYMENT_LIMIT_EXCEEDED")
    role["financePolicy"]["paymentLimit"] = None
    role["financePolicy"]["allowedBankAccounts"] = []
    denied("legacy-order-receipt-enforces-bank-allowlist", "FINANCE_BANK_ACCOUNT_DENIED")
    role["financePolicy"]["allowedBankAccounts"] = [bank_account]
    references = run()
    entry = next(row for row in references if row["doctype"] == "Payment Entry")
    check("legacy-order-receipt-native-posting", frappe.db.get_value("Payment Entry", entry["name"], "docstatus") == 1)
    attribution({"resource": "payment_entry", "name": entry["name"]})
    role["permissions"].remove("finance.payment_entry.submit")
    denied("legacy-lost-response-retry-honours-withdrawn-submit", "FINANCE_PERMISSION_DENIED")


def grandware_catalog_scenario():
    """Establish an explicit SKU through Tradept in Grandware's empty QA site."""
    from tradept_core.catalog import CAPABILITIES, CatalogPolicy
    from tradept_core import catalog
    from tradept_core.domain import APIError
    from tradept_core.events import managed_write
    check("catalog-company-schema-migrated-before-probe", frappe.get_meta("Item").has_field("custom_tradept_company"))
    check("grandware-catalog-starts-without-invented-skus", frappe.db.count("Item") == 0)
    work, cfg = repo.workspace(lock=True)
    profile = next(row for row in repo.profiles().values() if row.get("role") == "admin")
    cfg = copy.deepcopy(cfg)
    role = cfg["roles"][profile["role"]]
    role["permissions"] = sorted(set(role.get("permissions", [])) | set(CAPABILITIES) | set(FINANCE_CAPABILITIES))
    role["financePolicy"] = {"scope": "tenant", "paymentLimit": None, "allowedBankAccounts": None}
    frappe.db.set_value("Trade Workspace", work.name, "configuration", dumps(cfg), update_modified=False)
    acting(profile["nativeUser"])
    _, cfg, who, rules, _ = api._identity(lock=True)
    companies = CatalogPolicy(cfg, who, rules).companies()
    logical, native_company = next((logical, native) for logical, native in companies.items() if frappe.db.get_value("Company", native, "default_currency") == "USD")
    state = call("catalog_state", {"companyId": logical})
    check("empty-grandware-catalog-real-group-uom-options", not state["items"] and bool(state["options"]["itemGroups"]) and bool(state["options"]["uoms"]))
    groups = {row["name"] for row in state["options"]["itemGroups"]}; uoms = {row["name"] for row in state["options"]["uoms"]}
    group, uom = "Products" if "Products" in groups else sorted(groups)[0], "Nos" if "Nos" in uoms else sorted(uoms)[0]
    code = "FIN-CATALOG-" + secrets.token_hex(6)
    request = {"companyId": logical, "operation": "create", "expectedVersion": int(work.revision), "idempotencyKey": secrets.token_hex(16), "values": {"itemCode": code, "itemName": "Rollback explicit trade product", "itemGroup": group, "stockUom": uom, "description": "Explicit product maintained through Tradept", "isSalesItem": True, "isPurchaseItem": True}}
    response = call("catalog_operation", request)
    created = response["document"]
    native_item = frappe.get_doc("Item", code)
    check("catalog-explicit-sku-company-nonstock-real-actor", native_item.name == code and native_item.custom_tradept_company == native_company and native_item.is_stock_item == 0 and native_item.owner == profile["nativeUser"] and native_item.modified_by == profile["nativeUser"] and all(row.owner == profile["nativeUser"] and row.modified_by == profile["nativeUser"] for row in native_item.get_all_children()))
    check("catalog-public-per-action-capabilities", created["canWrite"] and created["canDisable"] and created["isSalesItem"] is True and created["isPurchaseItem"] is True)
    check("catalog-snapshot-does-not-claim-item-restoration", response["snapshotRestoresItem"] is False)
    check("catalog-create-replay-no-duplicate-native-sku", call("catalog_operation", request).get("replayed") is True and frappe.db.count("Item") == 1)
    revoked = copy.deepcopy(cfg)
    revoked["roles"][profile["role"]]["permissions"].remove("catalog.create")
    frappe.db.set_value("Trade Workspace", work.name, "configuration", dumps(revoked), update_modified=False)
    frappe.db.savepoint("catalog_replay_cap_denial")
    try:
        current, current_cfg, current_actor, current_rules, _ = api._identity(lock=True)
        with managed_write():
            catalog.perform(current, current_cfg, current_actor, current_rules, request)
        revoked_denied = False
    except APIError as error:
        revoked_denied = error.code == "CATALOG_PERMISSION_DENIED"
    frappe.db.rollback(save_point="catalog_replay_cap_denial")
    check("catalog-replay-rechecks-current-exact-capability", revoked_denied and frappe.db.count("Item") == 1)
    frappe.db.set_value("Trade Workspace", work.name, "configuration", dumps(cfg), update_modified=False)
    other = next((other for other in companies if other != logical), None)
    if other:
        check("tagged-sku-hidden-from-other-company-selectors", all(row["itemCode"] != code for row in call("catalog_state", {"companyId": other})["items"]) and all(row["itemCode"] != code for row in call("finance_state", {"companyId": other, "resource": "sales_invoice"})["options"]["items"]))
    acting("Administrator")
    with managed_write():
        accounts = frappe.get_all("Account", filters={"company": native_company, "is_group": 0, "disabled": 0, "account_currency": "USD"}, fields=["name", "account_type"])
        receivable_account = next(row.name for row in accounts if row.account_type == "Receivable")
        payable_account = next(row.name for row in accounts if row.account_type == "Payable")
        cash_account = next(row.name for row in accounts if row.account_type in ("Bank", "Cash"))
        token, today = secrets.token_hex(6), frappe.utils.today()
        buyer = frappe.get_doc({"doctype": "Customer", "customer_name": "Catalogue probe buyer " + token, "customer_type": "Company", "customer_group": "Tradept Customers", "territory": "Tradept Territory", "custom_tradept_company": native_company, "accounts": [{"company": native_company, "account": receivable_account}]}).insert(ignore_permissions=True).name
        vendor = frappe.get_doc({"doctype": "Supplier", "supplier_name": "Catalogue probe vendor " + token, "supplier_type": "Company", "supplier_group": "Tradept Suppliers", "custom_tradept_company": native_company, "accounts": [{"company": native_company, "account": payable_account}]}).insert(ignore_permissions=True).name
        so = frappe.get_doc({"doctype": "Sales Order", "company": native_company, "customer": buyer, "transaction_date": today, "delivery_date": today, "currency": "USD", "conversion_rate": 1, "ignore_pricing_rule": 1, "items": [{"item_code": code, "qty": 1, "rate": 10, "delivery_date": today}]}).insert(ignore_permissions=True); so.submit()
        po = frappe.get_doc({"doctype": "Purchase Order", "company": native_company, "supplier": vendor, "transaction_date": today, "schedule_date": today, "currency": "USD", "conversion_rate": 1, "ignore_pricing_rule": 1, "items": [{"item_code": code, "qty": 1, "rate": 7, "schedule_date": today}]}).insert(ignore_permissions=True); po.submit()
        price_list = frappe.db.get_value("Price List", {"selling": 1, "enabled": 1, "currency": "USD"}, "name")
        price = frappe.get_doc({"doctype": "Item Price", "item_code": code, "price_list": price_list, "price_list_rate": 123, "currency": "USD"}).insert(ignore_permissions=True) if price_list else None
    acting(profile["nativeUser"])
    for resource, source, party_account, customer_side in (("sales_invoice", so, receivable_account, True), ("purchase_invoice", po, payable_account, False)):
        current, _ = repo.workspace(lock=True)
        draft = call("finance_operation", {"companyId": logical, "resource": resource, "operation": "from_order", "expectedVersion": int(current.revision), "idempotencyKey": secrets.token_hex(16), "source": source_doc("sales_order" if customer_side else "purchase_order", source.name)})["document"]
        check("catalog-native-company-default-accounts-" + resource, bool(draft["items"][0].get("incomeAccount" if customer_side else "expenseAccount")) and bool(draft["items"][0].get("costCenter")))
        current, _ = repo.workspace(lock=True)
        invoice = call("finance_operation", {"companyId": logical, "resource": resource, "operation": "submit", "name": draft["name"], "expectedModified": draft["modified"], "expectedVersion": int(current.revision), "idempotencyKey": secrets.token_hex(16)})["document"]
        current, _ = repo.workspace(lock=True)
        amount = 10 if customer_side else 7
        payment = call("finance_operation", {"companyId": logical, "resource": "payment_entry", "operation": "payment_from_invoice", "expectedVersion": int(current.revision), "idempotencyKey": secrets.token_hex(16), "source": source_doc(resource, invoice["name"]), "values": {"paidFrom": party_account if customer_side else cash_account, "paidTo": cash_account if customer_side else party_account, "paidAmount": amount, "receivedAmount": amount, "sourceExchangeRate": 1, "targetExchangeRate": 1, "referenceNo": "CATALOG-" + resource, "referenceDate": today}})["document"]
        current, _ = repo.workspace(lock=True)
        payment = call("finance_operation", {"companyId": logical, "resource": "payment_entry", "operation": "submit", "name": payment["name"], "expectedModified": payment["modified"], "expectedVersion": int(current.revision), "idempotencyKey": secrets.token_hex(16)})["document"]
        native_invoice = frappe.get_doc("Sales Invoice" if customer_side else "Purchase Invoice", invoice["name"])
        check("catalog-first-real-native-invoice-payment-" + resource, native_invoice.outstanding_amount == 0 and payment["docstatus"] == 1)
    current, _ = repo.workspace(lock=True)
    edited = call("catalog_operation", {"companyId": logical, "operation": "save", "name": code, "expectedModified": created["modified"], "expectedVersion": int(current.revision), "idempotencyKey": secrets.token_hex(16), "values": {"itemName": "Updated trade product", "description": "Updated native SKU metadata"}})["document"]
    check("catalog-edit-keeps-sku-company-stock-owner", edited["itemCode"] == code and edited["companyId"] == logical and edited["isStockItem"] is False and edited["owner"] == profile["nativeUser"])
    if price:
        price.reload()
        check("catalog-native-price-label-only-no-amount-change", price.price_list_rate == 123 and price.currency == "USD" and price.item_name == "Updated trade product")
    current, _ = repo.workspace(lock=True)
    disabled = call("catalog_operation", {"companyId": logical, "operation": "disable", "name": code, "expectedModified": edited["modified"], "expectedVersion": int(current.revision), "idempotencyKey": secrets.token_hex(16), "values": {"disabled": True}})["document"]
    check("catalog-disabled-not-selectable-for-new-invoices", disabled["disabled"] is True and all(row["itemCode"] != code for row in call("finance_state", {"companyId": logical, "resource": "sales_invoice"})["options"]["items"]))
    check("catalog-no-generated-inventory-or-prices", frappe.db.count("Stock Ledger Entry") == 0 and frappe.db.count("Item Price", {"item_code": code}) == (1 if price else 0))


def main():
    global frappe, api, repo, dumps, FINANCE_CAPABILITIES
    os.chdir(BENCH / "sites")
    result = {"site": FINANCE_SITE, "grandwareSite": GRANDWARE_SITE, "mode": "real-native-finance-dispatch-transaction-rollback", "httpAuthenticationVerified": False, "committedFixtures": False}
    captured = io.StringIO()
    baseline = None
    try:
        if FINANCE_SITE == GRANDWARE_SITE or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,139}", name) or ".." in name for name in (FINANCE_SITE, GRANDWARE_SITE)):
            raise ValueError("Distinct safe local Frappe site names are required")
        import frappe
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            from tradept_core import api, repository as repo, __version__
            from tradept_core.domain import FINANCE_CAPABILITIES
            from tradept_core.schema import dumps
            result["applicationVersion"] = __version__
            frappe.init(site=GRANDWARE_SITE); frappe.connect(); frappe.set_user("Administrator")
            grand_before = fingerprint()
            grandware_catalog_scenario()
            frappe.db.rollback()
            check("grandware-catalog-all-tables-rolled-back", fingerprint() == grand_before)
            frappe.db.rollback(); frappe.destroy()
            frappe.init(site=FINANCE_SITE); frappe.connect(); frappe.set_user("Administrator")
            frappe.clear_cache()
            baseline = fingerprint()
            start_revision = int(repo.workspace()[0].revision)
            prepare_fixtures()
            success_scenario()
            frappe.db.rollback()
            acting(actor["nativeUser"])
            after = fingerprint()
            check("all-native-tables-rolled-back", after == baseline)
            result.update(rollbackBusinessPreserved=after == baseline, before=baseline, after=after, startRevision=start_revision, endRevision=int(repo.workspace()[0].revision), nativeTableCount=len(baseline))
            frappe.db.rollback(); frappe.destroy()
            frappe.init(site=GRANDWARE_SITE); frappe.connect(); frappe.set_user("Administrator")
            grand_after = fingerprint()
            check("grandware-other-site-unchanged", grand_after == grand_before)
            result.update(grandwarePreserved=True, ok=True, checks=checks, responses=responses, inTransactionNativeWritesVerified=True)
            frappe.db.rollback()
    except Exception as error:
        traceback.print_exc()
        if "frappe" in globals() and getattr(frappe.local, "db", None):
            frappe.db.rollback()
            if baseline is not None:
                result["rollbackBusinessPreserved"] = fingerprint() == baseline
        result.update(ok=False, checks=checks, responses=responses, hiddenErrors=hidden_errors[:12], errorType=type(error).__name__, errorMessage=str(error)[:250] if isinstance(error, AssertionError) else None, frames=[{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name} for frame in traceback.extract_tb(error.__traceback__)])
    finally:
        if "frappe" in globals():
            frappe.destroy()
    print(json.dumps(result, ensure_ascii=False, default=str))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
