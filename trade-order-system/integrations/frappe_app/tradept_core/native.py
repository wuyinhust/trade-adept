"""Native ERPNext documents, invoked in the current request's transaction.

There is no second API, outbox, document mirror or custom accounting ledger.
Historical references are deliberately excluded from native ledger conversion.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import math
import frappe

from .domain import APIError, Rules
from .schema import ORDER, FACTORY_LINE, field_name, dumps, child_encode, child_decode
from . import repository as repo


def decimal(value, name, positive=False):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise APIError(400, "INVALID_NATIVE_AMOUNT", name + " requires an explicit amount") from None
    if not result.is_finite() or result < 0 or (positive and result <= 0):
        raise APIError(400, "INVALID_NATIVE_AMOUNT", name + " must be finite and positive" if positive else name + " must be finite and nonnegative")
    return result


def operation_key(action, order_id, key):
    if not isinstance(key, str) or not key or len(key) > 200:
        raise APIError(400, "IDEMPOTENCY_KEY_REQUIRED", "A stable operation key is required")
    return "TP-" + hashlib.sha256(dumps([action, order_id, key]).encode()).hexdigest()


def documents(order_id):
    result = []
    for doctype in ("Sales Order", "Purchase Order", "Delivery Note", "Sales Invoice", "Purchase Invoice", "Payment Entry"):
        if repo.current_reads():
            rows = frappe.db.sql(f"SELECT name,docstatus FROM `tab{doctype}` WHERE custom_tradept_order_id=%s ORDER BY creation FOR UPDATE", (order_id,), as_dict=True)
        else:
            rows = frappe.get_all(doctype, filters={"custom_tradept_order_id": order_id}, fields=["name", "docstatus"], order_by="creation asc")
        for row in rows:
            result.append({"doctype": doctype, "orderId": order_id, "name": row.name, "docstatus": row.docstatus})
    return result


def stage(doc):
    return "native" if doc.sales_order else "legacy" if doc.doctype == "Trade Legacy Order" else "brief"


PLAN_FIELDS = {"factoryId", "productType", "inspectionDate", "estimatedShipDate"}
LIVE_RATE_SOURCES = {"open.er-api.com", "api.exchangerate-api.com"}
LIVE_RATE_ADJUSTMENT = Decimal("-0.02")


def production_plan(rows):
    """Only foreign-trade production milestones persist beside native PO data."""
    return [{key: value for key, value in row.items() if key in PLAN_FIELDS} for row in rows]


def _live_timestamp(value, name, required=True):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value or len(value) > 40:
        raise APIError(400, "INVALID_LIVE_RATE", name + " must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError:
        raise APIError(400, "INVALID_LIVE_RATE", name + " must be an ISO timestamp") from None
    if parsed.tzinfo is None:
        raise APIError(400, "INVALID_LIVE_RATE", name + " must include a timezone")
    return value


def live_rate_snapshot(rate, metadata):
    """Validate and reduce the gateway assertion used for one native conversion."""
    if type(rate) not in (float, int) or not math.isfinite(rate) or not 5 < rate < 10:
        raise APIError(503, "LIVE_RATE_REQUIRED", "A current USD/CNY publication is required before converting the order")
    if not isinstance(metadata, dict):
        raise APIError(503, "LIVE_RATE_REQUIRED", "A current USD/CNY publication is required before converting the order")
    try:
        raw = Decimal(str(metadata.get("rawRate")))
        adjustment = Decimal(str(metadata.get("adjustment")))
        adjusted = Decimal(str(metadata.get("adjustedRate")))
        supplied = Decimal(str(rate))
    except (InvalidOperation, TypeError, ValueError):
        raise APIError(400, "INVALID_LIVE_RATE", "The live exchange-rate assertion is invalid") from None
    expected = (raw + adjustment).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    if (not raw.is_finite() or not adjusted.is_finite() or not supplied.is_finite()
            or adjustment != LIVE_RATE_ADJUSTMENT or adjusted != expected or supplied != adjusted
            or metadata.get("base") != "USD" or metadata.get("quote") != "CNY"
            or metadata.get("provider") != "ExchangeRate-API" or metadata.get("source") not in LIVE_RATE_SOURCES
            or type(metadata.get("cached")) is not bool or type(metadata.get("stale")) is not bool):
        raise APIError(400, "INVALID_LIVE_RATE", "The live exchange-rate assertion is invalid")
    if metadata["stale"]:
        raise APIError(503, "LIVE_RATE_STALE", "A stale USD/CNY publication cannot be used for a new financial calculation")
    return {
        "base": "USD",
        "quote": "CNY",
        "rawRate": float(raw),
        "adjustment": float(adjustment),
        "adjustedRate": float(adjusted),
        "provider": "ExchangeRate-API",
        "source": metadata["source"],
        "publishedAt": _live_timestamp(metadata.get("publishedAt"), "publishedAt", required=False),
        "fetchedAt": _live_timestamp(metadata.get("fetchedAt"), "fetchedAt"),
        "nextUpdateAt": _live_timestamp(metadata.get("nextUpdateAt"), "nextUpdateAt"),
        "cached": metadata["cached"],
        "stale": metadata["stale"],
    }


def _rate(company, currency, values):
    if currency == company.default_currency:
        return 1.0
    company_id = company.custom_tradept_record_id
    value = values.get(company_id)
    if type(value) not in (float, int) or not math.isfinite(value) or value <= 0:
        raise APIError(400, "RATE_REQUIRED", "Configure the legal entity's exchange rate before converting currencies")
    if currency == "USD" and company.default_currency == "CNY":
        return value
    if currency == "CNY" and company.default_currency == "USD":
        return 1 / value
    raise APIError(400, "UNSUPPORTED_CURRENCY_PAIR", "Configure an explicit conversion for this currency pair")


def convert(doc, value, cfg, key, rate_snapshot=None):
    if doc.sales_order:
        return documents(value["id"])
    if doc.doctype == "Trade Legacy Order":
        raise APIError(409, "HISTORICAL_REFERENCE_ONLY", "Historical Excel balances remain references; create a new native order for new business")
    rate_snapshot = live_rate_snapshot(rate_snapshot.get("adjustedRate") if isinstance(rate_snapshot, dict) else None, rate_snapshot)
    company_name = repo.native_company(value.get("companyId"))
    if not company_name:
        raise APIError(400, "COMPANY_REQUIRED", "Select a configured legal entity")
    company = frappe.get_doc("Company", company_name)
    customer = repo.find("customers", value.get("customerId"))
    if not customer or customer.get("custom_tradept_is_deleted"):
        raise APIError(400, "CUSTOMER_REQUIRED", "Select an active native customer")
    lines = value.get("erpItems")
    if not isinstance(lines, list) or not lines:
        raise APIError(400, "NATIVE_ITEMS_REQUIRED", "Native sales and purchase orders require real Item codes and explicit quantities/rates")
    # This value is frozen into ERPNext's native conversion_rate fields. The
    # provider publication remains an audit snapshot and never restates an
    # existing Sales Order or Purchase Order later.
    values = {company.custom_tradept_record_id: rate_snapshot["adjustedRate"]}
    grouped, sales, seen = {}, [], set()
    for line in lines:
        if not isinstance(line, dict) or not line.get("id") or line["id"] in seen:
            raise APIError(400, "INVALID_NATIVE_ITEMS", "Each item line requires a stable unique ID")
        seen.add(line["id"])
        if not line.get("itemCode") or not frappe.db.exists("Item", line["itemCode"]):
            raise APIError(400, "NATIVE_ITEM_UNAVAILABLE", "Select an existing ERPNext Item; conversion never invents product SKUs")
        from .catalog import require_usable_item
        product = require_usable_item(line["itemCode"], company_name, sales=True)
        require_usable_item(product, company_name, sales=False)
        supplier = repo.find("factories", line.get("factoryId"))
        if not supplier or supplier.get("custom_tradept_is_deleted") or supplier.get("custom_tradept_company_id") != value.get("companyId"):
            raise APIError(403, "RELATED_RECORD_DENIED", "Select an active supplier belonging to this legal entity")
        qty = float(decimal(line.get("quantity"), "Quantity", True))
        sale_rate = float(decimal(line.get("saleRate"), "Sale rate"))
        purchase_rate = float(decimal(line.get("purchaseRate"), "Purchase rate"))
        purchase_currency = line.get("purchaseCurrency") or company.default_currency
        _rate(company, purchase_currency, values)
        common = {"item_code": line["itemCode"], "qty": qty, "delivery_date": value.get("expectedShipDate"), "custom_tradept_line_id": line["id"]}
        if line.get("uom"):
            common["uom"] = line["uom"]
        sales.append({**common, "rate": sale_rate, "custom_tradept_supplier_id": line["factoryId"], "custom_tradept_purchase_rate": purchase_rate, "custom_tradept_purchase_currency": purchase_currency})
        grouped.setdefault((supplier.name, purchase_currency), []).append({**common, "rate": purchase_rate, "schedule_date": value.get("expectedShipDate")})
    if not value.get("expectedShipDate"):
        raise APIError(400, "DELIVERY_DATE_REQUIRED", "Set the planned delivery date before creating native orders")
    total = sum(decimal(line["quantity"], "Quantity") * decimal(line["saleRate"], "Sales rate") for line in lines)
    if abs(total - decimal(value.get("orderAmountUSD"), "Quoted USD total")) > Decimal("0.005"):
        raise APIError(400, "SALES_TOTAL_MISMATCH", "Real item line totals must match the quoted USD order amount")
    sale = frappe.get_doc({"doctype": "Sales Order", "company": company_name, "customer": customer.name, "po_no": value.get("customerOrderNo"), "transaction_date": value.get("orderDate") or frappe.utils.today(), "delivery_date": value["expectedShipDate"], "currency": "USD", "conversion_rate": _rate(company, "USD", values), "ignore_pricing_rule": 1, "items": sales, "custom_tradept_order_id": value["id"], "custom_tradept_operation_key": operation_key("convert", value["id"], key)})
    sale.insert(ignore_permissions=True)
    sale_lines = {line.custom_tradept_line_id: line.name for line in sale.items}
    for (supplier_name, currency), items in grouped.items():
        for line in items:
            line.update(sales_order=sale.name, sales_order_item=sale_lines[line["custom_tradept_line_id"]])
        purchase = frappe.get_doc({"doctype": "Purchase Order", "company": company_name, "supplier": supplier_name, "transaction_date": value.get("orderDate") or frappe.utils.today(), "schedule_date": value["expectedShipDate"], "currency": currency, "conversion_rate": _rate(company, currency, values), "ignore_pricing_rule": 1, "items": items, "custom_tradept_order_id": value["id"], "custom_tradept_operation_key": operation_key("purchase", value["id"], key + ":" + supplier_name + ":" + currency)})
        purchase.insert(ignore_permissions=True)
    # The quote fields cease to be live monetary authority after conversion.
    # Only operational brief fields and native links remain. Audit snapshots
    # preserve the earlier quote as historical, nonlive provenance.
    doc.sales_order, doc.historical_balance_basis = sale.name, "Native ledger"
    for key in ("orderAmountUSD", "orderAmountRMB", "factoryCostRMB", "factoryCostUSD", "paidAmountUSD", "factoryPaidRMB", "costPaidUSD", "profitRMB", "profitUSD", "profitRate", "paymentStatus", "factoryPaidStatus", "costPaymentStatus"):
        doc.set(field_name(doc.doctype, ORDER[key][0]), None)
    doc.set("item_lines", [])
    doc.set("factory_lines", [child_encode(row, FACTORY_LINE) for row in production_plan(value.get("factories", []))])
    doc.save(ignore_permissions=True)
    return documents(value["id"])


def submit(doc, value, key):
    operation_key("submit", value["id"], key)
    if not doc.sales_order:
        raise APIError(409, "NATIVE_ORDER_REQUIRED", "Create native sales and purchase order drafts first")
    for reference in documents(value["id"]):
        if reference["doctype"] not in ("Sales Order", "Purchase Order"):
            continue
        native = frappe.get_doc(reference["doctype"], reference["name"])
        if native.docstatus == 2:
            raise APIError(409, "NATIVE_ORDER_CANCELLED", "Cancelled native orders require an explicit amendment")
        if native.docstatus == 0:
            native.flags.ignore_permissions = True
            native.submit()
    return documents(value["id"])


def cancel(doc, value, key):
    operation_key("cancel", value["id"], key)
    if not doc.sales_order:
        raise APIError(409, "NATIVE_ORDER_REQUIRED", "Select an existing native sales order")
    refs = documents(value["id"])
    if any(row["doctype"] not in ("Sales Order", "Purchase Order") and row["docstatus"] == 1 for row in refs):
        raise APIError(409, "NATIVE_CANCELLATION_REQUIRES_RECONCILIATION", "Reconcile or cancel posted receipt, delivery and invoice documents before cancelling the order")
    # Administrator-created descendants need not carry our provenance custom
    # fields. Native child references are the dependency authority as well.
    checks = [("Payment Entry Reference", "reference_name", doc.sales_order, "Payment Entry", {"reference_doctype": "Sales Order"}), ("Delivery Note Item", "against_sales_order", doc.sales_order, "Delivery Note", {}), ("Sales Invoice Item", "sales_order", doc.sales_order, "Sales Invoice", {})]
    for row in refs:
        if row["doctype"] == "Purchase Order":
            checks.extend((child, "purchase_order", row["name"], parent, {}) for child, parent in (("Purchase Invoice Item", "Purchase Invoice"), ("Purchase Receipt Item", "Purchase Receipt")))
            checks.append(("Payment Entry Reference", "reference_name", row["name"], "Payment Entry", {"reference_doctype": "Purchase Order"}))
    for child, field, name, parent_type, extra in checks:
        for row in frappe.get_all(child, filters={field: name, **extra}, fields=["parent"]):
            if frappe.db.get_value(parent_type, row.parent, "docstatus") == 1:
                raise APIError(409, "NATIVE_CANCELLATION_REQUIRES_RECONCILIATION", "A posted native descendant must be reconciled before order cancellation")
    sale = frappe.get_doc("Sales Order", doc.sales_order)
    if sale.docstatus == 0:
        raise APIError(409, "NATIVE_DRAFT_REVIEW_REQUIRED", "Review a native draft before submitting or deleting it in the administrator workflow")
    if sale.docstatus == 2:
        return refs
    for row in refs:
        if row["doctype"] == "Purchase Order" and row["docstatus"] == 1:
            purchase = frappe.get_doc("Purchase Order", row["name"])
            purchase.flags.ignore_permissions = True
            purchase.cancel()
    sale.flags.ignore_permissions = True
    sale.cancel()
    return documents(value["id"])


def receive_payment(doc, value, payload):
    from .permissions import delegated_finance_grant
    grant = delegated_finance_grant()
    if not grant or grant.get("resource") != "payment_entry" or grant.get("action") != "submit":
        raise APIError(403, "FINANCE_DELEGATION_DENIED", "登记收款需要已授权的原生财务流程")
    policy = grant["policy"]
    company_name = policy.require("payment_entry", "create", value.get("companyId"))
    policy.require("payment_entry", "submit", value.get("companyId"))
    if not policy._legacy_scope_allowed(value):
        raise APIError(403, "FINANCE_RECORD_DENIED", "登记收款超出当前财务数据范围")
    from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry
    from erpnext.accounts.party import get_party_account
    if not doc.sales_order:
        raise APIError(409, "NATIVE_ORDER_REQUIRED", "Receipts require a submitted native sales order")
    sale = frappe.get_doc("Sales Order", doc.sales_order)
    if sale.company != company_name or grant["company"] != company_name:
        raise APIError(403, "FINANCE_COMPANY_DENIED", "登记收款与获准公司不一致")
    key = operation_key("payment", value["id"], payload.get("idempotencyKey"))
    existing = frappe.db.get_value("Payment Entry", {"custom_tradept_operation_key": key}, "name")
    if existing:
        entry = frappe.get_doc("Payment Entry", existing)
        allocated = sum(float(row.allocated_amount or 0) for row in entry.references if row.reference_doctype == "Sales Order" and row.reference_name == sale.name)
        paid_usd = allocated / float(sale.conversion_rate or 1) if entry.paid_from_account_currency == frappe.db.get_value("Company", sale.company, "default_currency") and entry.paid_from_account_currency != "USD" else allocated
        exact_reference = bool(entry.references) and all(row.reference_doctype == "Sales Order" and row.reference_name == sale.name for row in entry.references)
        same_supplied_details = all(payload.get(key) is None or str(payload[key]) == str(entry.get(field)) for key, field in (("bankAccount", "paid_to"), ("referenceNo", "reference_no"), ("referenceDate", "reference_date")))
        if entry.docstatus != 1 or entry.payment_type != "Receive" or entry.company != sale.company or entry.party != sale.customer or not exact_reference or not same_supplied_details or abs(decimal(paid_usd, "Allocated USD receipt") - decimal(payload.get("amountUSD"), "Receipt amount", True)) > Decimal("0.005"):
            raise APIError(409, "IDEMPOTENCY_CONFLICT", "This receipt operation key has different posted details")
        policy.validate_document(entry, "submit")
        return documents(value["id"])
    if sale.docstatus != 1 or sale.currency != "USD":
        raise APIError(409, "SUBMITTED_USD_ORDER_REQUIRED", "Submit the USD sales order before recording its receipt")
    amount = float(decimal(payload.get("amountUSD"), "Receipt amount", True))
    finance = order_finance(sale)
    if finance["invoiceNames"]:
        raise APIError(409, "FINANCE_INVOICE_PAYMENT_REQUIRED", "该订单已开票，请从应收账单登记收款或核销已有款项；订单预收入口不会重复收款")
    outstanding = float(sale.grand_total) - finance["advanceBase"] / float(sale.conversion_rate or 1)
    if amount - outstanding > 0.005:
        raise APIError(400, "RECEIPT_EXCEEDS_OUTSTANDING", "Receipt exceeds the native order's unpaid amount")
    company = frappe.get_doc("Company", sale.company)
    bank = payload.get("bankAccount") or company.default_bank_account
    if not bank or not frappe.db.exists("Account", {"name": bank, "company": sale.company, "account_type": "Bank", "is_group": 0}):
        raise APIError(400, "BANK_ACCOUNT_REQUIRED", "Configure a native bank account for this legal entity")
    bank_currency = frappe.db.get_value("Account", bank, "account_currency")
    party_account = get_party_account("Customer", sale.customer, sale.company)
    party_currency = frappe.db.get_value("Account", party_account, "account_currency")
    if party_currency not in ("USD", company.default_currency):
        raise APIError(400, "PARTY_CURRENCY_UNSUPPORTED", "Configure the customer's native receivable currency explicitly")
    # ERPNext's helper takes party_amount in receivable-account currency and
    # bank_amount in bank-account currency. The order conversion is frozen.
    frozen_rate = float(sale.conversion_rate or 1)
    party_amount = amount * frozen_rate if party_currency == company.default_currency else amount
    bank_amount = amount * frozen_rate if bank_currency == company.default_currency else amount
    if bank_currency not in ("USD", company.default_currency):
        raise APIError(400, "BANK_CURRENCY_UNSUPPORTED", "Configure the receipt's explicit bank currency conversion")
    entry = get_payment_entry("Sales Order", sale.name, party_amount=party_amount, bank_account=bank, bank_amount=bank_amount)
    entry.custom_tradept_order_id, entry.custom_tradept_operation_key = value["id"], key
    entry.reference_no = payload.get("referenceNo") or payload.get("idempotencyKey")
    entry.reference_date = payload.get("referenceDate") or frappe.utils.today()
    entry.source_exchange_rate = 1 if party_currency == company.default_currency else frozen_rate
    entry.target_exchange_rate = 1 if bank_currency == company.default_currency else frozen_rate
    entry.owner = grant["user"]
    entry.set_amounts()
    policy.validate_document(entry, "create")
    entry.flags.ignore_permissions = True
    entry.insert(ignore_permissions=True)
    policy.validate_document(entry, "submit")
    entry.submit()
    # Controllers remain the amount authority. Recheck their final values in
    # the same transaction; any unexpected expansion rolls back atomically.
    policy.validate_document(entry, "submit")
    return documents(value["id"])


def _invoice_order(invoice, line, sales):
    field, detail, source, source_field = ("sales_order", "dn_detail", "Delivery Note Item", "against_sales_order") if sales else ("purchase_order", "pr_detail", "Purchase Receipt Item", "purchase_order")
    return line.get(field) or (repo.get_value(source, line.get(detail), source_field) if line.get(detail) else None)


def invoice_order_share(invoice, order):
    """Allocate a shared native invoice using its real source item net values.

    Tax, discount and rounding follow the native invoice total, pro rata to
    source item net amounts. Unlinked item amounts remain unassigned. The
    ratio is a read projection; it never alters a native balance or ledger.
    """
    rows = invoice.get("items") or []
    total = sum(abs(float(row.get("base_net_amount") or 0)) for row in rows)
    if not total:
        return 0.0
    linked = sum(abs(float(row.get("base_net_amount") or 0)) for row in rows if _invoice_order(invoice, row, order.doctype == "Sales Order") == order.name)
    return linked / total


def _posted_order_invoices(order):
    sales = order.doctype == "Sales Order"
    invoice_type, source_type, field, detail, source_field = ("Sales Invoice", "Delivery Note", "sales_order", "dn_detail", "against_sales_order") if sales else ("Purchase Invoice", "Purchase Receipt", "purchase_order", "pr_detail", "purchase_order")
    suffix = " FOR UPDATE" if repo.current_reads() else ""
    names = frappe.db.sql(f"SELECT DISTINCT i.parent FROM `tab{invoice_type} Item` i LEFT JOIN `tab{source_type} Item` d ON d.name=i.{detail} WHERE i.{field}=%s OR d.{source_field}=%s" + suffix, (order.name, order.name), as_dict=True)
    return [invoice for row in names if (invoice := repo.get_doc(invoice_type, row.parent)).docstatus == 1 and invoice.company == order.company]


def _party_amount_base(doc, amount, currency, company_currency):
    if currency == company_currency:
        return float(amount or 0)
    if currency == doc.currency:
        return float(amount or 0) * float(doc.conversion_rate or 1)
    raise APIError(409, "NATIVE_SETTLEMENT_CURRENCY_UNSUPPORTED", "原生往来账户币种需要与单据币种或公司本位币一致")


def _order_receipts(order, invoices):
    """List actual native vouchers, including retained unallocated receipts.

    A submitted Unreconcile Payment preserves original invoice provenance
    after the controller removes PE references. It is evidence of linkage,
    not another balance. Shared vouchers are explicitly not additive by order.
    """
    invoice_type = "Sales Invoice" if order.doctype == "Sales Order" else "Purchase Invoice"
    invoice_names = {row.name for row in invoices}
    suffix = " FOR UPDATE" if repo.current_reads() else ""
    names = {row.parent for row in frappe.db.sql("SELECT parent FROM `tabPayment Entry Reference` WHERE reference_doctype=%s AND reference_name=%s" + suffix, (order.doctype, order.name), as_dict=True)}
    for name in invoice_names:
        names.update(row.parent for row in frappe.db.sql("SELECT parent FROM `tabPayment Entry Reference` WHERE reference_doctype=%s AND reference_name=%s" + suffix, (invoice_type, name), as_dict=True))
        rows = frappe.db.sql("SELECT u.voucher_no FROM `tabUnreconcile Payment` u INNER JOIN `tabUnreconcile Payment Entries` a ON a.parent=u.name WHERE u.docstatus=1 AND u.company=%s AND u.voucher_type='Payment Entry' AND a.reference_doctype=%s AND a.reference_name=%s" + suffix, (order.company, invoice_type, name), as_dict=True)
        names.update(row.voucher_no for row in rows)
    output = []
    for name in sorted(names):
        payment = repo.get_doc("Payment Entry", name)
        expected_party = order.customer if order.doctype == "Sales Order" else order.supplier
        if payment.docstatus != 1 or payment.company != order.company or payment.party != expected_party or payment.payment_type not in ("Receive", "Pay"):
            continue
        receive = payment.payment_type == "Receive"
        bank_currency = payment.paid_to_account_currency if receive else payment.paid_from_account_currency
        bank_amount = float(payment.received_amount if receive else payment.paid_amount)
        party_currency = payment.paid_from_account_currency if receive else payment.paid_to_account_currency
        # A voucher can settle several invoices, including invoices that each
        # contain several orders. Always mark its full native cash amount as
        # nonadditive in this order projection.
        output.append({"name": payment.name, "postingDate": str(payment.posting_date), "paymentType": payment.payment_type, "partyType": payment.party_type, "bankAmount": bank_amount, "bankCurrency": bank_currency, "paidAmount": float(payment.paid_amount), "receivedAmount": float(payment.received_amount), "paidFromCurrency": payment.paid_from_account_currency, "paidToCurrency": payment.paid_to_account_currency, "unallocatedAmount": float(payment.unallocated_amount or 0), "unallocatedCurrency": party_currency, "sharedReceipt": True, "additiveByOrder": False})
    return output


def order_finance(order):
    """Read native advances and invoice settlement without a second ledger."""
    from erpnext.accounts.doctype.payment_entry.payment_entry import set_grand_total_and_outstanding_amount
    company_currency = repo.get_value("Company", order.company, "default_currency")
    advance_currency = order.get("party_account_currency") or order.currency
    result = {"advanceBase": _party_amount_base(order, order.advance_paid, advance_currency, company_currency), "invoiceSettledBase": 0.0, "invoiceOutstandingBase": 0.0, "invoiceBilledBase": 0.0, "invoiceNames": [], "receipts": []}
    invoices = _posted_order_invoices(order)
    for invoice in invoices:
        result["invoiceNames"].append(invoice.name)
        share = invoice_order_share(invoice, order)
        if not share:
            continue
        party_currency = invoice.party_account_currency or invoice.currency
        total, outstanding = set_grand_total_and_outstanding_amount(None, invoice.doctype, party_currency, invoice)
        total_base = _party_amount_base(invoice, total, party_currency, company_currency)
        outstanding_base = _party_amount_base(invoice, outstanding, party_currency, company_currency)
        result["invoiceBilledBase"] += total_base * share
        result["invoiceSettledBase"] += (total_base - outstanding_base) * share
        result["invoiceOutstandingBase"] += outstanding_base * share
    result["receipts"] = _order_receipts(order, invoices)
    return result


def project_order(doc, value):
    sale = repo.get_doc("Sales Order", doc.sales_order)
    company = repo.get_doc("Company", sale.company)
    value.update(companyId=company.custom_tradept_record_id, customerId=repo.get_value("Customer", sale.customer, "custom_tradept_record_id"), customerName=sale.customer_name, customerOrderNo=sale.po_no, orderDate=str(sale.transaction_date) if sale.transaction_date else None, expectedShipDate=str(sale.delivery_date) if sale.delivery_date else None)
    purchase = [repo.get_doc("Purchase Order", row["name"]) for row in documents(value["id"]) if row["doctype"] == "Purchase Order" and row["docstatus"] != 2]
    amount = float(sale.grand_total)
    sales_finance = order_finance(sale)
    value["nativeHasPostedSalesInvoices"] = bool(sales_finance["invoiceNames"])
    sale_rate = float(sale.conversion_rate or 1)
    paid = (sales_finance["advanceBase"] + sales_finance["invoiceSettledBase"]) / sale_rate
    cost_base = sum(float(order.base_grand_total) for order in purchase)
    purchase_finance = {order.name: order_finance(order) for order in purchase}
    factory_paid_base = sum(row["advanceBase"] + row["invoiceSettledBase"] for row in purchase_finance.values())
    value.update(orderAmountUSD=amount, paidAmountUSD=paid, paymentStatus="已收款" if paid >= amount - .005 else "部分收款" if paid > .005 else "未收款", factoryCostRMB=cost_base, factoryPaidRMB=factory_paid_base, factoryPaidStatus="已付清" if cost_base > 0 and factory_paid_base >= cost_base - .005 else "部分付款" if factory_paid_base > .005 else "未付款")
    receipts = {row["name"]: row for row in sales_finance["receipts"]}
    for projected in purchase_finance.values():
        receipts.update({row["name"]: row for row in projected["receipts"]})
    value.update(nativeSettlementProjection=True, salesAdvanceAmountUSD=sales_finance["advanceBase"] / sale_rate, salesInvoiceSettledAmountUSD=sales_finance["invoiceSettledBase"] / sale_rate, salesInvoiceOutstandingAmountUSD=sales_finance["invoiceOutstandingBase"] / sale_rate, factoryAdvanceAmount=sum(row["advanceBase"] for row in purchase_finance.values()), factoryInvoiceSettledAmount=sum(row["invoiceSettledBase"] for row in purchase_finance.values()), factoryInvoiceOutstandingAmount=sum(row["invoiceOutstandingBase"] for row in purchase_finance.values()), nativeReceiptSummary=list(receipts.values()), salesInvoiceNames=sales_finance["invoiceNames"], factoryInvoiceNames=list(dict.fromkeys(name for row in purchase_finance.values() for name in row["invoiceNames"])), nativeSettlementCurrency=company.default_currency)
    value["erpItems"] = []
    purchase_lines = {}
    for order in purchase:
        for row in order.items:
            key = row.get("sales_order_item") or row.custom_tradept_line_id
            purchase_lines.setdefault(key, []).append((order, row))
    plans = {row.get("factoryId"): row for row in (child_decode(line, FACTORY_LINE) for line in doc.get("factory_lines", []))}
    factory_lines = {}
    for order in purchase:
        supplier_id = repo.get_value("Supplier", order.supplier, "custom_tradept_record_id")
        factory = factory_lines.setdefault(supplier_id, {"factoryId": supplier_id, "factoryName": order.supplier_name, "totalQuantity": 0, "totalAmount": 0, "prepayment": 0, "costCurrency": company.default_currency})
        factory["totalQuantity"] += sum(float(row.qty) for row in order.items)
        factory["totalAmount"] += float(order.base_grand_total)
        projected = purchase_finance[order.name]
        factory["prepayment"] += projected["advanceBase"] + projected["invoiceSettledBase"]
        factory["advanceAmount"] = factory.get("advanceAmount", 0) + projected["advanceBase"]
        factory["invoiceSettledAmount"] = factory.get("invoiceSettledAmount", 0) + projected["invoiceSettledBase"]
        factory["invoiceOutstandingAmount"] = factory.get("invoiceOutstandingAmount", 0) + projected["invoiceOutstandingBase"]
        factory["invoiceNames"] = list(dict.fromkeys(factory.get("invoiceNames", []) + projected["invoiceNames"]))
        plan = plans.get(supplier_id, {})
        factory["productType"] = plan.get("productType") if "productType" in plan else ", ".join(dict.fromkeys(str(row.get("item_name") or row.item_code) for row in order.items))
        factory["inspectionDate"] = plan.get("inspectionDate")
        factory["estimatedShipDate"] = plan.get("estimatedShipDate") if "estimatedShipDate" in plan else str(order.schedule_date) if order.schedule_date else None
    for line in sale.items:
        matches = purchase_lines.get(line.name) or purchase_lines.get(line.custom_tradept_line_id, [])
        po, po_line = matches[0] if len(matches) == 1 else (None, None)
        supplier_id = repo.get_value("Supplier", po.supplier, "custom_tradept_record_id") if po else None
        value["erpItems"].append({"id": line.custom_tradept_line_id or line.name, "itemCode": line.item_code, "uom": line.get("uom"), "factoryId": supplier_id, "quantity": float(line.qty), "saleRate": float(line.rate), "purchaseRate": float(po_line.rate) if po_line else None, "purchaseCurrency": po.currency if po else None})
    value["factories"] = list(factory_lines.values())
    value["factoryIds"] = [factory_id for factory_id in factory_lines if factory_id]
    value["factoryId"] = value["factoryIds"][0] if len(value["factoryIds"]) == 1 else None
    value["factoryName"] = ", ".join(row["factoryName"] for row in value["factories"])
    shipping_projection(sale, value)
    value["stage"], value["nativeDocuments"] = "native", documents(value["id"])
    if sale.docstatus == 2:
        value["status"] = "已取消"
    else:
        value["status"] = value.get("status") if value.get("status") in ("已订船", "推迟出货") else "进行中"
    if company.default_currency == "USD":
        value["factoryCostUSD"] = cost_base
    revenue = float(sale.base_grand_total)
    policy = company.custom_tradept_profit_policy or "generic-native"
    fees = {**value, **Rules._quote_alias_values({"profitPolicy": policy, "settlementCurrency": company.default_currency}, value, conversion=float(sale.conversion_rate or 1))}
    if policy == "grandware-v40":
        if company.default_currency == "CNY":
            profit = revenue - cost_base - float(fees.get("freightCostUSD") or 0) - float(fees.get("otherCostUSD") or 0) + cost_base / 1.13 * float(fees.get("insuranceCostUSD") or 0) / 100
        elif company.default_currency == "USD":
            profit = revenue - cost_base - float(fees.get("otherCostUSD") or 0)
        else:
            raise APIError(400, "UNSUPPORTED_PROFIT_CURRENCY", "Grandware's historical policy only supports its configured settlement currencies")
    elif policy == "generic-native":
        # Native documents freeze their conversion rates at creation. Changing
        # the current FX configuration cannot restate existing order profit.
        profit = revenue - cost_base - sum(float(fees.get(key) or 0) for key in ("freightCostUSD", "insuranceCostUSD", "otherCostUSD")) * float(sale.conversion_rate)
    else:
        raise APIError(400, "UNKNOWN_PROFIT_POLICY", "The native entity requires a configured profit policy")
    value.update(orderAmountRMB=revenue, profitRMB=round(profit, 2), profitRate=round(profit / revenue * 100, 2) if revenue else 0, profitPolicy=policy, settlementCurrency=company.default_currency, exchangeRateUsed=float(sale.conversion_rate or 1))
    if sale.docstatus == 2:
        value.update(profitRMB=0, profitRate=0)
    return value


def shipping_projection(sale, value):
    """Stock departure is native; arrival/signature are dated trade milestones."""
    deliveries = set()
    if repo.current_reads():
        rows = frappe.db.sql("SELECT DISTINCT parent FROM `tabDelivery Note Item` WHERE against_sales_order=%s FOR UPDATE", (sale.name,), as_dict=True)
    else:
        rows = frappe.get_all("Delivery Note Item", filters={"against_sales_order": sale.name}, fields=["parent"])
    for row in rows:
        if repo.get_value("Delivery Note", row.parent, "docstatus") == 1:
            deliveries.add(row.parent)
    dates = [str(repo.get_value("Delivery Note", name, "posting_date")) for name in deliveries]
    progress = float(sale.get("per_delivered") or 0)
    value["deliveryProgressPct"] = progress
    value["shippingStatus"] = "已出运" if deliveries or progress > 0 else "待出运"
    value["actualShipDate"] = min(dates) if dates else None
    milestones = []
    if repo.current_reads():
        rows = frappe.db.sql("SELECT arrival_date,received_date FROM `tabTrade Shipment` WHERE order_id=%s AND COALESCE(is_deleted,0)=0 FOR UPDATE", (value["id"],), as_dict=True)
    else:
        rows = frappe.get_all("Trade Shipment", filters={"order_id": value["id"], "is_deleted": 0}, fields=["arrival_date", "received_date"])
    for row in rows:
        milestones.append(row)
    if deliveries or progress > 0:
        if any(row.get("received_date") for row in milestones):
            value["shippingStatus"] = "已签收"
        elif any(row.get("arrival_date") for row in milestones):
            value["shippingStatus"] = "已到港"
    return value


def has_native_links():
    return any(frappe.db.exists(doctype, {"sales_order": ["is", "set"]}) for doctype in ("Trade Order Brief", "Trade Legacy Order"))
