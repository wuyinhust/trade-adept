"""Scoped Tradept facade for ERPNext's one accounting ledger.

Each mutation runs under the API's locked workspace transaction. Native
controllers perform posting/cancellation/reconciliation; Trade Audit stores
only a replay receipt and provenance, never an independently maintained debt.
"""
from __future__ import annotations

import copy
from decimal import Decimal
import hashlib
import json
import frappe

from .domain import APIError, FINANCE_CAPABILITIES
from .schema import dumps, loads
from . import repository as repo
from . import finance_native as native
from .finance_permissions import Policy, canonical_resource
from .permissions import delegated_finance_operation, delegated_finance_read, bind_finance_reference

REPORTS = {"receivables", "payables", "general_ledger", "ledger", "reconciliation", "bank_reconciliation"}
RESOURCES = {**native.DOCTYPES, "bank_transaction": "Bank Transaction"}
OPERATIONS = {"create": "create", "save": "write", "submit": "submit", "cancel": "cancel", "amend": "amend", "return": "return", "from_order": "create", "payment_from_invoice": "create", "reconcile": "write", "unreconcile": "write"}
READ_ACTIONS = {"read", "export", "print"}


def _resource(value):
    if value not in RESOURCES and value not in REPORTS:
        raise APIError(404, "FINANCE_RESOURCE_NOT_FOUND", "Unknown accounting resource")
    return value


def _version(work):
    return int(work.revision or 0)


def _company(policy, resource, action, supplied):
    company_id = supplied.get("companyId")
    if not isinstance(company_id, str) or not company_id:
        raise APIError(400, "FINANCE_COMPANY_REQUIRED", "Select a legal entity")
    return company_id, policy.require(resource, action, company_id, tenant_scope=resource in REPORTS or resource == "bank_transaction")


def _expected(work, supplied):
    expected = supplied.get("expectedVersion")
    if type(expected) is not int or expected < 0:
        raise APIError(400, "EXPECTED_VERSION_REQUIRED", "Financial operations require the current workspace version")
    if expected != _version(work):
        raise APIError(409, "VERSION_CONFLICT", "Data changed; reload and review the financial document", latestVersion=_version(work))


def _modified(doc, expected):
    if not isinstance(expected, str) or not expected:
        raise APIError(400, "EXPECTED_MODIFIED_REQUIRED", "The native document's current modified timestamp is required")
    if expected != str(doc.modified):
        raise APIError(409, "STALE_DOCUMENT", "The native document changed; reload and review it", latestModified=str(doc.modified))


def _load(resource, name, company, policy, action="read", *, lock=False):
    dt = RESOURCES.get(resource)
    if not dt:
        raise APIError(400, "INVALID_FINANCE_DOCUMENT", "Select a supported native accounting document")
    name = native.text(name, "Document name", required=True)
    if not frappe.db.exists(dt, name):
        raise APIError(404, "FINANCE_DOCUMENT_NOT_FOUND", "The native accounting document does not exist")
    doc = frappe.get_doc(dt, name, for_update=True) if lock else frappe.get_doc(dt, name)
    if doc.company != company:
        raise APIError(403, "FINANCE_COMPANY_DENIED", "The accounting document belongs to another legal entity")
    policy.validate_document(doc, action)
    return doc


def _public(doc, company_id, policy, *, detailed=False):
    if doc.doctype == "Bank Transaction":
        value = native.mapped_fields(doc, {"name": "name", "docstatus": "docstatus", "modified": "modified", "company": "nativeCompany", "date": "date", "bank_account": "bankAccount", "deposit": "deposit", "withdrawal": "withdrawal", "currency": "currency", "description": "description", "reference_number": "referenceNumber", "transaction_id": "transactionId", "allocated_amount": "allocatedAmount", "unallocated_amount": "unallocatedAmount", "status": "status", "included_fee": "includedFee", "excluded_fee": "excludedFee", "party_type": "partyType", "party": "party", "owner": "owner", "modified_by": "modifiedBy"})
        value.update(resource="bank_transaction", companyId=company_id)
        if detailed:
            value["paymentEntries"] = [native.mapped_fields(row, {"payment_document": "paymentDocument", "payment_entry": "paymentEntry", "allocated_amount": "allocatedAmount", "reconciliation_type": "reconciliationType"}) for row in (doc.get("payment_entries") or [])]
    else:
        value = native.detail(doc, company_id) if detailed else native.summary(doc, company_id)
        base = frappe.db.get_value("Company", doc.company, "default_currency")
        value.setdefault("companyCurrency", base)
        if doc.doctype == "Payment Entry":
            value.update(paidFromAccountCurrency=doc.get("paid_from_account_currency"), paidToAccountCurrency=doc.get("paid_to_account_currency"))
            if detailed:
                for reference in value.get("references", []):
                    dt, name = reference.get("referenceDoctype"), reference.get("referenceName")
                    if dt in ("Sales Invoice", "Purchase Invoice", "Sales Order", "Purchase Order") and name:
                        reference["referenceModified"] = str(frappe.db.get_value(dt, name, "modified"))
        value["partyLabel"] = doc.get("customer_name") or doc.get("supplier_name") or doc.get("party_name") or value.get("party")
    return policy.redact(value)


def _master_options(policy, company, doctype, label):
    result = []
    own = frappe.get_all(doctype, filters={"custom_tradept_company": company}, fields=["name"], limit_page_length=1000)
    shared = frappe.get_all("Party Account", filters={"company": company, "parenttype": doctype}, fields=["parent"], limit_page_length=1000)
    names = {row.name for row in own} | {row.parent for row in shared}
    if not names:
        return result
    rows = frappe.get_all(doctype, filters={"name": ["in", sorted(names)]}, fields=["name", label], limit_page_length=1000, order_by=label + " asc")
    for row in rows:
        try:
            policy._party(doctype, row.name, company)
            doc = native.require_party(doctype, row.name, company)
        except APIError:
            continue
        result.append({"name": doc.name, "id": doc.name, "label": row.get(label) or doc.name})
    return result


def _options(policy, company_id, company, resource):
    from .catalog import selectable_items
    base = frappe.db.get_value("Company", company, "default_currency")
    accounts = [{"name": row.name, "label": row.account_name or row.name, "currency": row.account_currency or base, "accountType": row.account_type, "rootType": row.root_type, "companyId": company_id} for row in frappe.get_all("Account", filters={"company": company, "is_group": 0, "disabled": 0}, fields=["name", "account_name", "account_currency", "account_type", "root_type"], limit_page_length=1000, order_by="account_name asc")]
    if resource in ("sales_invoice", "receivables"):
        accounts = [row for row in accounts if row["accountType"] == "Receivable" or resource == "sales_invoice" and row["rootType"] == "Income"]
    elif resource in ("purchase_invoice", "payables"):
        accounts = [row for row in accounts if row["accountType"] == "Payable" or resource == "purchase_invoice" and row["rootType"] == "Expense"]
    if not policy.allowed("bank_accounts", "read"):
        accounts = [row for row in accounts if row["accountType"] != "Bank"]
    result = {
        "companyCurrency": base, "defaultCurrency": base,
        "customers": [] if resource in ("purchase_invoice", "payables") else _master_options(policy, company, "Customer", "customer_name"),
        "suppliers": [] if resource in ("sales_invoice", "receivables") else _master_options(policy, company, "Supplier", "supplier_name"),
        "accounts": accounts,
        "partyAccounts": [row for row in accounts if row["accountType"] in ("Receivable", "Payable")],
        "items": selectable_items(company, sales=resource == "sales_invoice") if resource in ("sales_invoice", "purchase_invoice") else [],
        "currencies": [{"name": row.name, "label": row.name} for row in frappe.get_all("Currency", filters={"enabled": 1}, fields=["name"], limit_page_length=300)],
        "costCenters": [{"name": row.name, "label": row.cost_center_name or row.name} for row in frappe.get_all("Cost Center", filters={"company": company, "is_group": 0}, fields=["name", "cost_center_name"], limit_page_length=500)],
        "paymentModes": [{"name": row.name, "label": row.name} for row in frappe.get_all("Mode of Payment", filters={"enabled": 1}, fields=["name"], limit_page_length=100)],
        "paymentTerms": [{"name": row.name, "label": row.name, "allocatePaymentBasedOnPaymentTerms": bool(row.allocate_payment_based_on_payment_terms)} for row in frappe.get_all("Payment Terms Template", fields=["name", "allocate_payment_based_on_payment_terms"], limit_page_length=100)],
        "sources": [], "bankAccounts": [], "taxesTemplates": [],
    }
    for dt, kind in (("Sales Taxes and Charges Template", "sales_invoice"), ("Purchase Taxes and Charges Template", "purchase_invoice")):
        rows = frappe.get_all(dt, filters={"company": company, "disabled": 0}, fields=["name"], limit_page_length=100)
        result["taxesTemplates"].extend({"name": row.name, "label": row.name, "resource": kind} for row in rows)
    result["taxTemplates"] = result["taxesTemplates"]
    result["paymentTermsTemplates"] = result["paymentTerms"]
    if policy.allowed("bank_accounts", "read"):
        banks = frappe.get_all("Bank Account", filters={"company": company, "is_company_account": 1, "disabled": 0}, fields=["name", "account", "account_name"], limit_page_length=200)
        for row in banks:
            try:
                policy._bank(row.name, company)
            except APIError:
                continue
            result["bankAccounts"].append({"name": row.name, "label": row.account_name or row.name, "account": row.account, "currency": frappe.db.get_value("Account", row.account, "account_currency") or base})
    # Source names are themselves privileged financial metadata. Each row is
    # separately scoped; report-only grants do not imply invoice read grants.
    for source_resource, dt in native.SOURCE_TYPES.items():
        if resource in REPORTS and resource != "bank_reconciliation":
            continue
        if source_resource == "payment_entry" and resource not in ("bank_reconciliation", "bank_transaction"):
            continue
        if dt in native.DOCTYPES.values() and not policy.allowed(source_resource, "read"):
            continue
        if dt not in native.DOCTYPES.values():
            if not policy.rules.permitted(policy.cfg, policy.actor, "read", "orders"):
                continue
            if resource == "sales_invoice" and source_resource not in ("sales_order", "delivery_note") or resource == "purchase_invoice" and source_resource not in ("purchase_order", "purchase_receipt"):
                continue
        if resource in ("bank_reconciliation", "bank_transaction") and source_resource != "payment_entry":
            continue
        for row in frappe.get_all(dt, filters={"company": company, "docstatus": 1}, fields=["name"], limit_page_length=300, order_by="modified desc"):
            try:
                doc = policy.require_reference(dt, row.name, company)
            except APIError:
                continue
            value = {"resource": source_resource, "name": doc.name, "label": doc.name + " · " + str(doc.get(native.PARTY_FIELDS.get(dt)) or ""), "companyId": company_id, "party": doc.get(native.PARTY_FIELDS.get(dt)), "docstatus": doc.docstatus, "modified": str(doc.modified), "orderId": doc.get("custom_tradept_order_id"), "currency": doc.get("currency"), "grandTotal": doc.get("grand_total"), "outstandingAmount": doc.get("outstanding_amount"), "outstandingCurrency": doc.get("party_account_currency"), "conversionRate": doc.get("conversion_rate"), "paidFrom": doc.get("paid_from"), "paidTo": doc.get("paid_to")}
            if dt in ("Sales Invoice", "Purchase Invoice"):
                value.update(isReturn=bool(doc.get("is_return")), debitTo=doc.get("debit_to"), creditTo=doc.get("credit_to"))
                value.update(native.payment_terms(doc))
            if dt in ("Sales Invoice", "Purchase Invoice", "Sales Order", "Purchase Order"):
                value["paymentType"] = native.payment_direction(doc)
            result["sources"].append(value)
    return policy.redact(result)


def state(work, cfg, actor, rules, supplied):
    resource = _resource(supplied.get("resource", "sales_invoice"))
    action = supplied.get("action", "read")
    if action not in READ_ACTIONS:
        raise APIError(400, "INVALID_FINANCE_ACTION", "Select read, print or export")
    policy = Policy(cfg, actor, rules)
    policy.require(resource, action, tenant_scope=resource in REPORTS or resource == "bank_transaction")
    companies = policy.companies()
    allowed_companies = [{**company, "defaultCurrency": frappe.db.get_value("Company", companies[company["id"]], "default_currency")} for company in cfg["companies"] if company["id"] in companies]
    company_id = supplied.get("companyId") or (allowed_companies[0]["id"] if allowed_companies else None)
    company_id, company = _company(policy, resource, action, {"companyId": company_id})
    limit, offset = supplied.get("limit", 40), supplied.get("offset", 0)
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 1000000:
        raise APIError(400, "INVALID_FINANCE_PAGINATION", "Use a limit from one to one hundred and a nonnegative offset")
    result = {"version": _version(work), "companies": allowed_companies, "companyId": company_id, "capabilities": {capability: rules.permitted(cfg, actor, capability) for capability in FINANCE_CAPABILITIES}, "options": _options(policy, company_id, company, resource), "documents": [], "pagination": {"offset": offset, "limit": limit, "hasMore": False}}
    if resource in REPORTS:
        return result
    filters = {"company": company}
    if supplied.get("status") not in (None, ""):
        if supplied["status"] not in (0, 1, 2, "0", "1", "2"):
            raise APIError(400, "INVALID_FINANCE_STATUS", "Select draft, submitted or cancelled")
        filters["docstatus"] = int(supplied["status"])
    if supplied.get("party"):
        field = native.PARTY_FIELDS.get(RESOURCES[resource], "party")
        filters[field] = native.text(supplied["party"], "Party", required=True)
    date_field = "date" if resource == "bank_transaction" else "posting_date"
    if supplied.get("fromDate"):
        filters[date_field] = [">=", native.day(supplied["fromDate"], "fromDate")]
    if supplied.get("toDate"):
        if supplied.get("fromDate"):
            filters[date_field] = ["between", [native.day(supplied["fromDate"], "fromDate"), native.day(supplied["toDate"], "toDate")]]
        else:
            filters[date_field] = ["<=", native.day(supplied["toDate"], "toDate")]
    search = native.text(supplied.get("search"), "Search", limit=200).casefold()
    # Query parent names in bounded chunks, then scope before pagination. A
    # self/team role cannot infer another owner's count through total values.
    visible, scan = [], 0
    while len(visible) <= offset + limit:
        rows = frappe.get_all(RESOURCES[resource], filters=filters, fields=["name"], limit_start=scan, limit_page_length=200, order_by="posting_date desc, name desc" if resource != "bank_transaction" else "date desc, name desc")
        if not rows:
            break
        for row in rows:
            doc = frappe.get_doc(RESOURCES[resource], row.name)
            if not policy.document_allowed(doc, action):
                continue
            public = _public(doc, company_id, policy)
            if search and search not in " ".join(str(public.get(key) or "") for key in ("name", "party", "partyLabel", "referenceNo", "referenceNumber")).casefold():
                continue
            visible.append(public)
        scan += len(rows)
        if len(rows) < 200:
            break
    result["documents"] = visible[offset:offset + limit]
    result["pagination"]["hasMore"] = len(visible) > offset + limit
    return result


def document(work, cfg, actor, rules, supplied):
    resource = _resource(supplied.get("resource"))
    action = supplied.get("action", "read")
    if action not in READ_ACTIONS:
        raise APIError(400, "INVALID_FINANCE_ACTION", "Select read, print or export")
    policy = Policy(cfg, actor, rules)
    company_id, company = _company(policy, resource, action, supplied)
    doc = _load(resource, supplied.get("name"), company, policy, action)
    return {"version": _version(work), "document": _public(doc, company_id, policy, detailed=True)}


RECON_FILTERS = {"partyType", "party", "receivablePayableAccount", "bankCashAccount", "costCenter", "fromDate", "toDate", "fromInvoiceDate", "toInvoiceDate", "fromPaymentDate", "toPaymentDate", "invoiceLimit", "paymentLimit", "invoiceName", "paymentName", "defaultAdvanceAccount"}


def _reconciliation(company, values, policy):
    native.object_values(values, RECON_FILTERS, "Reconciliation filters")
    party_type, party = values.get("partyType"), values.get("party")
    native.require_party(party_type, party, company)
    policy._party(party_type, party, company)
    account = native.require_account(values.get("receivablePayableAccount"), company, types={"Receivable" if party_type == "Customer" else "Payable"})
    rec = frappe.get_doc("Payment Reconciliation")
    rec.company, rec.party_type, rec.party, rec.receivable_payable_account = company, party_type, party, account.name
    for public, field in (("bankCashAccount", "bank_cash_account"), ("defaultAdvanceAccount", "default_advance_account")):
        if values.get(public):
            native.require_account(values[public], company)
            rec.set(field, values[public])
    if values.get("costCenter"):
        native.require_cost_center(values["costCenter"], company)
        rec.cost_center = values["costCenter"]
    dates = {"fromInvoiceDate": "from_invoice_date", "toInvoiceDate": "to_invoice_date", "fromPaymentDate": "from_payment_date", "toPaymentDate": "to_payment_date"}
    for public, field in dates.items():
        default = values.get("fromDate" if public.startswith("from") else "toDate")
        if values.get(public) or default:
            rec.set(field, native.day(values.get(public) or default, public))
    for public, field in (("invoiceLimit", "invoice_limit"), ("paymentLimit", "payment_limit")):
        number = values.get(public, 100)
        if type(number) is not int or not 1 <= number <= 100:
            raise APIError(400, "INVALID_FINANCE_PAGINATION", "Reconciliation uses at most one hundred invoices/payments")
        rec.set(field, number)
    for public, field in (("invoiceName", "invoice_name"), ("paymentName", "payment_name")):
        if values.get(public):
            rec.set(field, native.text(values[public], public, required=True))
    rec.get_unreconciled_entries()
    return rec


def _reconciliation_public(rec, policy):
    result = {"nativeReport": "Payment Reconciliation", "partyType": rec.party_type, "party": rec.party, "currency": frappe.db.get_value("Account", rec.receivable_payable_account, "account_currency"), "payments": [], "invoices": []}
    for row in (rec.get("payments") or []):
        doc = policy.require_reference(row.reference_type, row.reference_name, rec.company)
        value = native.mapped_fields(row, {"reference_type": "referenceType", "reference_name": "referenceName", "reference_row": "referenceRow", "posting_date": "postingDate", "amount": "amount", "currency": "currency", "is_advance": "isAdvance", "remarks": "remarks"})
        value["modified"] = str(doc.modified)
        result["payments"].append(value)
    for row in (rec.get("invoices") or []):
        doc = policy.require_reference(row.invoice_type, row.invoice_number, rec.company)
        value = native.mapped_fields(row, {"invoice_type": "invoiceType", "invoice_number": "invoiceNumber", "invoice_date": "invoiceDate", "amount": "amount", "currency": "currency", "outstanding_amount": "outstandingAmount"})
        value["modified"] = str(doc.modified)
        result["invoices"].append(value)
    return policy.redact(result)


def _bank_account(policy, name, company):
    policy.require("bank_accounts", "read")
    native.text(name, "Bank Account", required=True)
    return policy._bank(name, company)


def report(work, cfg, actor, rules, supplied):
    name = supplied.get("report")
    if name == "ledger":
        name = "general_ledger"
    if name not in REPORTS:
        raise APIError(404, "FINANCE_REPORT_NOT_FOUND", "Unknown native accounting report")
    action = supplied.get("action", "read")
    if action not in READ_ACTIONS:
        raise APIError(400, "INVALID_FINANCE_ACTION", "Select read, print or export")
    policy = Policy(cfg, actor, rules)
    company_id, company = _company(policy, name, action, supplied)
    filters = supplied.get("filters", {})
    if not isinstance(filters, dict):
        raise APIError(400, "INVALID_FINANCE_FILTER", "Report filters must be an object")
    filters = {key: value for key, value in filters.items() if value not in (None, "")}
    # companyId is a facade selector, never passed to native SQL/report filters.
    if filters.pop("companyId", company_id) != company_id:
        raise APIError(403, "FINANCE_COMPANY_DENIED", "Report filters cannot select a second company")
    if name in ("reconciliation", "bank_reconciliation"):
        filters.pop("reportDate", None)
    with delegated_finance_read(name, policy, company):
        if name == "reconciliation":
            result = _reconciliation_public(_reconciliation(company, filters, policy), policy)
        elif name == "bank_reconciliation":
            native.object_values(filters, {"bankAccount", "fromDate", "toDate", "allTransactions"}, "Bank reconciliation filters")
            _bank_account(policy, filters.get("bankAccount"), company)
            all_transactions = filters.get("allTransactions", False)
            if type(all_transactions) not in (bool, int) or all_transactions not in (0, 1):
                raise APIError(400, "INVALID_FINANCE_FILTER", "allTransactions requires a boolean")
            from erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool import get_bank_transactions
            rows = get_bank_transactions(filters["bankAccount"], from_date=native.day(filters.get("fromDate"), "fromDate", optional=True), to_date=native.day(filters.get("toDate"), "toDate", optional=True), all_transactions=bool(all_transactions))
            transactions = []
            for row in rows:
                doc = _load("bank_transaction", row.name, company, policy)
                transactions.append(_public(doc, company_id, policy, detailed=True))
            result = {"nativeReport": "Bank Reconciliation Tool", "transactions": transactions, "result": transactions, "columns": [{"fieldname": key, "label": label} for key, label in (("date", "日期"), ("referenceNumber", "银行流水号"), ("deposit", "银行实到"), ("withdrawal", "银行支出"), ("currency", "币种"), ("allocatedAmount", "已匹配"), ("unallocatedAmount", "未匹配"), ("status", "状态"))]}
        else:
            result = native.native_report(name, native.report_filters(name, company, filters))
    result.update(version=_version(work), report=name, companyId=company_id)
    return policy.redact(result)


def _key(cfg, actor, supplied):
    key = native.text(supplied.get("idempotencyKey"), "Idempotency key", required=True)
    return "finance:" + hashlib.sha256(dumps([cfg["id"], actor["nativeUser"], supplied.get("companyId"), supplied.get("resource"), supplied.get("operation"), key]).encode()).hexdigest()


def _request_hash(supplied):
    # Native modified + workspace revision are concurrency assertions, not the
    # business intent. A retried acknowledged write may legitimately be stale.
    value = {key: supplied[key] for key in supplied if key not in ("expectedVersion", "expectedModified")}
    try:
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    except (ValueError, TypeError):
        raise APIError(400, "INVALID_FINANCE_PAYLOAD", "Financial values must be finite JSON values") from None


def _replay(kind, request_hash, actor, policy, company_id, company):
    rows = frappe.get_all("Trade Audit", filters={"kind": kind, "actor_id": actor["id"]}, fields=["revision", "summary"], limit_page_length=2)
    if not rows:
        return None
    if len(rows) != 1:
        raise APIError(409, "FINANCE_RECEIPT_CONFLICT", "The operation receipt requires administrator review")
    receipt = loads(rows[0].summary, {})
    if receipt.get("requestSha256") != request_hash:
        raise APIError(409, "IDEMPOTENCY_CONFLICT", "This operation key has different financial details")
    for reference in receipt.get("references", []):
        policy.require_reference(reference["doctype"], reference["name"], company)
    result = policy.redact(copy.deepcopy(receipt["result"]))
    result.update(ok=True, version=int(rows[0].revision), replayed=True)
    return result


def _source(supplied, policy, company):
    source = supplied.get("source")
    native.object_values(source, {"resource", "name", "orderId", "expectedModified"}, "Source")
    dt = native.SOURCE_TYPES.get(source.get("resource"))
    if not dt or dt == "Payment Entry":
        raise APIError(400, "FINANCE_SOURCE_DENIED", "Select a submitted native invoice, order, delivery or receipt")
    doc = policy.require_reference(dt, native.text(source.get("name"), "Source name", required=True), company)
    doc = frappe.get_doc(dt, doc.name, for_update=True)
    if source.get("orderId") and source["orderId"] != doc.get("custom_tradept_order_id"):
        raise APIError(403, "FINANCE_SOURCE_DENIED", "The source does not belong to this order")
    if doc.docstatus != 1:
        raise APIError(409, "FINANCE_SUBMITTED_SOURCE_REQUIRED", "Submit the native source document first")
    if source.get("expectedModified") is not None:
        _modified(doc, source["expectedModified"])
    return doc


def _bank_values(doc, values, policy):
    allowed = {"bankAccount", "date", "deposit", "withdrawal", "currency", "description", "referenceNumber", "transactionId", "includedFee", "excludedFee", "partyType", "party"}
    native.object_values(values, allowed)
    bank_name = values.get("bankAccount", doc.get("bank_account"))
    bank = _bank_account(policy, bank_name, doc.company)
    currency = frappe.db.get_value("Account", bank.get("account"), "account_currency") or frappe.db.get_value("Company", doc.company, "default_currency")
    if values.get("currency", currency) != currency:
        raise APIError(400, "FINANCE_BANK_CURRENCY_DENIED", "The bank statement must use its actual account currency")
    doc.bank_account, doc.currency = bank_name, currency
    doc.date = native.day(values.get("date", str(doc.get("date") or frappe.utils.today())), "Bank transaction date")
    for public, field in (("deposit", "deposit"), ("withdrawal", "withdrawal"), ("includedFee", "included_fee"), ("excludedFee", "excluded_fee")):
        if public in values:
            doc.set(field, native.amount(values[public], public))
    if bool(doc.get("deposit")) == bool(doc.get("withdrawal")):
        raise APIError(400, "INVALID_BANK_DIRECTION", "Record exactly one deposit or withdrawal")
    for public, field in (("description", "description"), ("referenceNumber", "reference_number"), ("transactionId", "transaction_id"), ("partyType", "party_type"), ("party", "party")):
        if public in values:
            doc.set(field, native.text(values[public], public, limit=4000 if public == "description" else 200))
    if doc.get("party") or doc.get("party_type"):
        native.require_party(doc.get("party_type"), doc.get("party"), doc.company)
    return doc


def _bind_sources(doc):
    """Capture existing sources before a native controller changes them.

Invoice posting updates prior orders/receipts and allocated advances. Payment
posting updates invoice balances. Capturing late, after those writes, would
mistake existing creators for new rows during delegated attribution.
"""
    sources = set()
    for row in (doc.get("items") or []):
        for field, dt in (("sales_order", "Sales Order"), ("delivery_note", "Delivery Note"), ("purchase_order", "Purchase Order"), ("purchase_receipt", "Purchase Receipt")):
            if row.get(field):
                sources.add((dt, row.get(field)))
    for row in (doc.get("references") or []):
        if row.get("reference_doctype") and row.get("reference_name"):
            sources.add((row.reference_doctype, row.reference_name))
    for row in (doc.get("advances") or []):
        if row.get("reference_type") and row.get("reference_name"):
            sources.add((row.reference_type, row.reference_name))
    for field in ("return_against", "amended_from"):
        if doc.get(field):
            sources.add((doc.doctype, doc.get(field)))
    for dt, name in sorted(sources):
        bind_finance_reference(dt, name)


def _reconcile(company, values, policy):
    native.object_values(values, RECON_FILTERS | {"allocations", "companyId", "reportDate"})
    if values.get("companyId") and policy.companies().get(values["companyId"]) != company:
        raise APIError(403, "FINANCE_COMPANY_DENIED", "The reconciliation belongs to another company")
    allocations = values.get("allocations")
    if not isinstance(allocations, list) or not 1 <= len(allocations) <= 100:
        raise APIError(400, "FINANCE_ALLOCATIONS_REQUIRED", "Select one to one hundred native allocations")
    rec = _reconciliation(company, {key: value for key, value in values.items() if key in RECON_FILTERS and value not in (None, "")}, policy)
    payments = {(row.reference_type, row.reference_name, row.get("reference_row") or ""): row for row in (rec.get("payments") or [])}
    invoices = {(row.invoice_type, row.invoice_number): row for row in (rec.get("invoices") or [])}
    sums_p, sums_i, references, seen = {}, {}, [], set()
    rec.set("allocation", [])
    for supplied in allocations:
        native.object_values(supplied, {"referenceType", "referenceName", "referenceRow", "invoiceType", "invoiceNumber", "allocatedAmount", "paymentModified", "invoiceModified"}, "Allocation")
        pk = (supplied.get("referenceType"), supplied.get("referenceName"), supplied.get("referenceRow") or "")
        ik = (supplied.get("invoiceType"), supplied.get("invoiceNumber"))
        if pk not in payments or ik not in invoices or (pk, ik) in seen:
            raise APIError(409, "FINANCE_ALLOCATION_CONFLICT", "An allocation changed or is no longer available")
        seen.add((pk, ik))
        pay, inv = payments[pk], invoices[ik]
        for kind, name, timestamp in ((pk[0], pk[1], supplied.get("paymentModified")), (ik[0], ik[1], supplied.get("invoiceModified"))):
            doc = policy.require_reference(kind, name, company)
            doc = frappe.get_doc(kind, name, for_update=True)
            _modified(doc, timestamp)
            if doc.docstatus != 1:
                raise APIError(409, "FINANCE_SUBMITTED_SOURCE_REQUIRED", "Only posted native documents can be reconciled")
            reference = {"doctype": kind, "name": name}
            if reference not in references:
                references.append(reference)
        allocated = native.amount(supplied.get("allocatedAmount"), "Allocated amount", positive=True)
        sums_p[pk] = sums_p.get(pk, Decimal(0)) + Decimal(str(allocated))
        sums_i[ik] = sums_i.get(ik, Decimal(0)) + Decimal(str(allocated))
        if sums_p[pk] > Decimal(str(pay.amount)) or sums_i[ik] > Decimal(str(inv.outstanding_amount)):
            raise APIError(409, "FINANCE_OVERALLOCATION", "Allocations exceed the native unallocated payment or invoice outstanding amount")
        pay_value, inv_value = frappe._dict(pay.as_dict()), frappe._dict(inv.as_dict())
        pay_value.unreconciled_amount = pay.amount
        exchange_map = rec.get_invoice_exchange_map([inv_value], [pay_value])
        inv_value.exchange_rate = exchange_map.get(inv.invoice_number)
        if pay.reference_type in ("Sales Invoice", "Purchase Invoice"):
            pay_value.exchange_rate = exchange_map.get(pay.reference_name)
        entry = rec.get_allocated_entry(pay_value, inv_value, allocated)
        entry.exchange_rate = inv_value.exchange_rate
        entry.difference_amount = rec.get_difference_amount(pay_value, inv_value, allocated)
        entry.difference_account = frappe.db.get_value("Company", company, "exchange_gain_loss_account")
        basis = frappe.db.get_single_value("Accounts Settings", "exchange_gain_loss_posting_date")
        entry.gain_loss_posting_date = inv.invoice_date if basis == "Invoice" and not pay.get("is_advance") else frappe.utils.today() if basis == "Reconciliation Date" else pay.posting_date
        rec.append("allocation", entry)
    return rec, references


def _bank_reconcile(company, supplied, values, policy, operation):
    native.object_values(values, {"vouchers"})
    transaction = _load("bank_transaction", supplied.get("name"), company, policy, "read", lock=True)
    _modified(transaction, supplied.get("expectedModified"))
    _bank_account(policy, transaction.bank_account, company)
    if transaction.docstatus != 1:
        raise APIError(409, "FINANCE_SUBMITTED_SOURCE_REQUIRED", "Submit the bank transaction before matching payments")
    vouchers = values.get("vouchers")
    if not isinstance(vouchers, list) or not 1 <= len(vouchers) <= 100:
        raise APIError(400, "FINANCE_VOUCHERS_REQUIRED", "Select native posted Payment Entry vouchers")
    refs = [{"doctype": "Bank Transaction", "name": transaction.name}]
    native_vouchers, seen = [], set()
    bank_gl = frappe.db.get_value("Bank Account", transaction.bank_account, "account")
    for value in vouchers:
        native.object_values(value, {"name", "expectedModified"}, "Voucher")
        payment = policy.require_reference("Payment Entry", value.get("name"), company)
        payment = frappe.get_doc("Payment Entry", payment.name, for_update=True)
        _modified(payment, value.get("expectedModified"))
        if payment.docstatus != 1 or bank_gl not in (payment.paid_from, payment.paid_to) or payment.name in seen:
            raise APIError(403, "FINANCE_BANK_VOUCHER_DENIED", "Match distinct posted payments using the same bank account")
        policy.require_payment(payment)
        seen.add(payment.name)
        refs.append({"doctype": payment.doctype, "name": payment.name})
        native_vouchers.append({"payment_doctype": "Payment Entry", "payment_name": payment.name})
    with delegated_finance_operation("bank_reconciliation", "write", policy, references=refs, company=company):
        if operation == "reconcile":
            from erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool import reconcile_vouchers
            result = reconcile_vouchers(transaction.name, json.dumps(native_vouchers))
        else:
            from erpnext.accounts.doctype.bank_transaction.bank_transaction import unreconcile_transaction_entry
            for voucher in native_vouchers:
                matched = next((row for row in (transaction.get("payment_entries") or []) if row.payment_document == "Payment Entry" and row.payment_entry == voucher["payment_name"]), None)
                if not matched:
                    raise APIError(409, "FINANCE_BANK_MATCH_NOT_FOUND", "The payment is not matched to this bank transaction")
                if matched.get("reconciliation_type") == "Voucher Created":
                    # ERPNext's native unmatch would cancel this voucher. That
                    # requires the separate Payment Entry cancellation grant.
                    policy.validate_document(frappe.get_doc("Payment Entry", voucher["payment_name"]), "cancel")
                unreconcile_transaction_entry(transaction.name, "Payment Entry", voucher["payment_name"])
            result = frappe.get_doc("Bank Transaction", transaction.name)
    return result, refs


def _unreconcile(company, supplied, values, policy, company_id):
    """Unlink selected invoices, retaining the posted native bank voucher."""
    native.object_values(values, {"invoices"})
    payment = _load("payment_entry", supplied.get("name"), company, policy, "read", lock=True)
    _modified(payment, supplied.get("expectedModified"))
    if payment.docstatus != 1 or payment.payment_type not in ("Receive", "Pay"):
        raise APIError(409, "FINANCE_POSTED_PAYMENT_REQUIRED", "Select a posted customer/supplier receipt or payment")
    policy.require_payment(payment)
    selected = values.get("invoices")
    if not isinstance(selected, list) or not 1 <= len(selected) <= 100:
        raise APIError(400, "FINANCE_INVOICES_REQUIRED", "Select one to one hundred invoices to unlink")
    invoice_keys, references, documents = set(), [{"doctype": "Payment Entry", "name": payment.name}], []
    for selection in selected:
        native.object_values(selection, {"resource", "name", "expectedModified"}, "Selected invoice")
        resource = selection.get("resource")
        if resource not in ("sales_invoice", "purchase_invoice"):
            raise APIError(400, "FINANCE_INVOICE_REQUIRED", "Only native sales/purchase invoices can be unlinked")
        invoice = _load(resource, selection.get("name"), company, policy, "read", lock=True)
        _modified(invoice, selection.get("expectedModified"))
        key = (invoice.doctype, invoice.name)
        if key in invoice_keys or invoice.docstatus != 1:
            raise APIError(409, "FINANCE_ALLOCATION_CONFLICT", "Select distinct posted invoices with existing allocations")
        party_type = "Customer" if invoice.doctype == "Sales Invoice" else "Supplier"
        if party_type != payment.party_type or invoice.get(native.PARTY_FIELDS[invoice.doctype]) != payment.party:
            raise APIError(403, "FINANCE_PARTY_DENIED", "The selected invoice belongs to a different payment party")
        invoice_keys.add(key)
        references.append({"doctype": invoice.doctype, "name": invoice.name})
        documents.append(invoice)
    with delegated_finance_operation("reconciliation", "unreconcile", policy, references=references, company=company) as bound:
        doc = frappe.new_doc("Unreconcile Payment")
        doc.company, doc.voucher_type, doc.voucher_no, doc.owner = company, "Payment Entry", payment.name, policy.actor["nativeUser"]
        allocations = doc.get_allocations_from_payment()
        chosen = [row for row in allocations if (row.get("reference_doctype"), row.get("reference_name")) in invoice_keys]
        if {(row.get("reference_doctype"), row.get("reference_name")) for row in chosen} != invoice_keys:
            raise APIError(409, "FINANCE_ALLOCATION_CONFLICT", "The native allocation changed or is already unlinked")
        doc.set("allocations", chosen)
        policy.validate_unreconcile(doc, company, bound)
        # ERPNext's Unreconcile controller clears references and restores total
        # outstanding, but does not reverse Payment Schedule allocations in
        # this version. Reuse its existing cancellation helper on only the
        # selected reference rows, before the Unreconcile controller clears them.
        term_references = [row for row in (payment.get("references") or []) if (row.reference_doctype, row.reference_name) in invoice_keys and row.get("payment_term") and row.get("allocated_amount")]
        if term_references:
            schedule_payment = frappe.get_doc("Payment Entry", payment.name, for_update=True)
            schedule_payment.set("references", [row.as_dict() for row in term_references])
            schedule_payment.update_payment_schedule(cancel=1)
        doc.insert(ignore_permissions=True)
        doc.flags.ignore_permissions = True
        doc.submit()
        native_reference = {"doctype": "Unreconcile Payment", "name": doc.name}
        if native_reference not in bound:
            bound.append(native_reference)
        references = bound
        receipt = {"doctype": "Unreconcile Payment", "name": doc.name, "docstatus": doc.docstatus}
    result = {
        "document": _public(frappe.get_doc("Payment Entry", payment.name), company_id, policy, detailed=True),
        "documents": [_public(frappe.get_doc(row.doctype, row.name), company_id, policy, detailed=True) for row in documents],
        "unreconciliation": receipt,
    }
    return result, references


def operation(work, cfg, actor, rules, supplied):
    native.object_values(supplied, {"companyId", "resource", "operation", "name", "expectedVersion", "expectedModified", "idempotencyKey", "values", "source"}, "Operation")
    resource, op = _resource(supplied.get("resource")), supplied.get("operation")
    if op not in OPERATIONS:
        raise APIError(404, "FINANCE_OPERATION_NOT_FOUND", "Unknown native accounting operation")
    action = "unreconcile" if resource == "reconciliation" and op == "unreconcile" else OPERATIONS[op]
    policy = Policy(cfg, actor, rules)
    company_id, company = _company(policy, resource, action, supplied)
    kind, request_hash = _key(cfg, actor, supplied), _request_hash(supplied)
    replay = _replay(kind, request_hash, actor, policy, company_id, company)
    if replay is not None:
        return replay
    _expected(work, supplied)
    values = supplied.get("values", {})
    if not isinstance(values, dict):
        raise APIError(400, "INVALID_FINANCE_VALUES", "Financial values must be an object")
    if values.get("allocateAdvances"):
        policy.require("reconciliation", "write", company_id, tenant_scope=True)
    references, result = [], None
    if resource == "reconciliation" and op == "reconcile":
        # Fetching the native unreconciled pool is read-only but needs the same
        # authenticated, company-scoped controller delegation as the write.
        with delegated_finance_read(resource, policy, company):
            rec, references = _reconcile(company, values, policy)
        with delegated_finance_operation(resource, "write", policy, references=references, company=company) as bound:
            rec.reconcile()
            references = bound
        with delegated_finance_read(resource, policy, company):
            result = _reconciliation_public(rec, policy)
    elif resource == "reconciliation" and op == "unreconcile":
        result, references = _unreconcile(company, supplied, values, policy, company_id)
    elif resource == "bank_reconciliation" and op in ("reconcile", "unreconcile"):
        doc, references = _bank_reconcile(company, supplied, values, policy, op)
        result = {"document": _public(doc, company_id, policy, detailed=True)}
    elif resource in RESOURCES:
        if op in ("reconcile", "unreconcile"):
            raise APIError(400, "INVALID_FINANCE_OPERATION", "Use the native reconciliation workflow")
        if op in ("from_order", "payment_from_invoice"):
            source = _source(supplied, policy, company)
            references.append({"doctype": source.doctype, "name": source.name})
            if op == "payment_from_invoice" and resource != "payment_entry" or op == "from_order" and resource not in ("sales_invoice", "purchase_invoice"):
                raise APIError(400, "INVALID_FINANCE_OPERATION", "Select a compatible target accounting document")
            doc = None
        elif op == "create":
            if supplied.get("name") or supplied.get("source"):
                raise APIError(400, "INVALID_FINANCE_OPERATION", "New independent documents cannot reuse another document name")
            doc = frappe.new_doc(RESOURCES[resource])
            doc.company, doc.owner = company, actor["nativeUser"]
        else:
            doc = _load(resource, supplied.get("name"), company, policy, action, lock=True)
            _modified(doc, supplied.get("expectedModified"))
            references.append({"doctype": doc.doctype, "name": doc.name})
        if op in ("submit", "cancel") and values:
            raise APIError(400, "INVALID_FINANCE_OPERATION", "Review and save the draft before posting or cancelling it")
        target = doc if op not in ("create", "amend", "return") else None
        with delegated_finance_operation(resource, action, policy, document=target, references=references, company=company) as bound:
            if op == "from_order":
                doc = native.mapped_invoice(resource, source)
                doc.owner = actor["nativeUser"]
            elif op == "payment_from_invoice":
                doc = native.mapped_payment(source, values)
                doc.owner = actor["nativeUser"]
            elif op == "amend":
                if doc.docstatus != 2:
                    raise APIError(409, "FINANCE_CANCELLED_DOCUMENT_REQUIRED", "Only a cancelled native document can be amended")
                original = doc
                doc = frappe.copy_doc(original)
                doc.docstatus, doc.amended_from, doc.owner = 0, original.name, actor["nativeUser"]
                doc.custom_tradept_operation_key = None
            elif op == "return":
                if resource not in ("sales_invoice", "purchase_invoice") or doc.docstatus != 1 or doc.get("is_return"):
                    raise APIError(409, "FINANCE_POSTED_INVOICE_REQUIRED", "Returns require a posted original sales/purchase invoice")
                doc = native.return_invoice(doc)
                doc.owner = actor["nativeUser"]
            if op in ("create", "save", "amend", "return", "from_order", "payment_from_invoice"):
                if doc.docstatus != 0:
                    raise APIError(409, "FINANCE_DRAFT_REQUIRED", "Posted native documents require cancellation/amendment instead of editing")
                frozen = op in ("save", "from_order", "return")
                if resource in ("sales_invoice", "purchase_invoice"):
                    native.invoice_values(doc, values, frozen=frozen)
                elif resource == "payment_entry":
                    native.payment_values(doc, values, frozen=op == "save")
                elif resource == "bank_transaction":
                    _bank_values(doc, values, policy)
                if resource != "bank_transaction":
                    doc.custom_tradept_operation_key = doc.get("custom_tradept_operation_key") or kind.replace("finance:", "TP-FIN-")
                # The operation's exact amend/return grants do not imply create.
                policy.validate_document(doc, action)
                _bind_sources(doc)
                if resource == "payment_entry":
                    policy.require_payment(doc)
                if doc.is_new():
                    doc.insert(ignore_permissions=True)
                else:
                    doc.save(ignore_permissions=True)
                if resource == "payment_entry":
                    policy.require_payment(doc)
            elif op == "submit":
                if doc.docstatus != 0:
                    raise APIError(409, "FINANCE_DRAFT_REQUIRED", "Only a native draft can be submitted")
                _bind_sources(doc)
                doc.flags.ignore_permissions = True
                doc.submit()
                if resource == "payment_entry":
                    policy.require_payment(doc)
            elif op == "cancel":
                if doc.docstatus != 1:
                    raise APIError(409, "FINANCE_POSTED_DOCUMENT_REQUIRED", "Only a submitted native document can be cancelled")
                _bind_sources(doc)
                doc.flags.ignore_permissions = True
                doc.cancel()
            else:
                raise APIError(400, "INVALID_FINANCE_OPERATION", "The operation does not apply to this accounting resource")
            reference = {"doctype": doc.doctype, "name": doc.name}
            if reference not in bound:
                bound.append(reference)
            references = bound
        # Fetch after delegation stamps real actor/ledger attribution.
        doc = frappe.get_doc(doc.doctype, doc.name)
        result = {"document": _public(doc, company_id, policy, detailed=True)}
    else:
        raise APIError(400, "INVALID_FINANCE_OPERATION", "This resource is a read-only native report")
    receipt = {"requestSha256": request_hash, "resource": resource, "operation": op, "companyId": company_id, "references": references, "result": result}
    finished = repo.finish(work, actor, kind, receipt)
    result.update(ok=True, version=finished["meta"]["version"], meta=finished["meta"], snapshotId=finished["snapshotId"])
    return result
