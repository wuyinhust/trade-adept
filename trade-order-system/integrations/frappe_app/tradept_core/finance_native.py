"""Bounded adapters for ERPNext's accounting controllers.

ERPNext remains the authority for taxes, balances, payment ledgers, ageing and
exchange gains/losses. No total or outstanding balance is accepted from clients.
"""
from __future__ import annotations

import copy
from datetime import date
from decimal import Decimal, InvalidOperation
import frappe

from .domain import APIError

DOCTYPES = {"sales_invoice": "Sales Invoice", "purchase_invoice": "Purchase Invoice", "payment_entry": "Payment Entry"}
SOURCE_TYPES = {"sales_order": "Sales Order", "delivery_note": "Delivery Note", "purchase_order": "Purchase Order", "purchase_receipt": "Purchase Receipt", **DOCTYPES}
PARTY_FIELDS = {"Sales Invoice": "customer", "Purchase Invoice": "supplier", "Sales Order": "customer", "Delivery Note": "customer", "Purchase Order": "supplier", "Purchase Receipt": "supplier", "Payment Entry": "party"}
COMMON_FIELDS = {"name": "name", "docstatus": "docstatus", "company": "nativeCompany", "currency": "currency", "company_currency": "companyCurrency", "grand_total": "grandTotal", "base_grand_total": "baseGrandTotal", "rounded_total": "roundedTotal", "base_rounded_total": "baseRoundedTotal", "outstanding_amount": "outstandingAmount", "conversion_rate": "conversionRate", "net_total": "netTotal", "base_net_total": "baseNetTotal", "total_taxes_and_charges": "totalTaxesAndCharges", "posting_date": "postingDate", "due_date": "dueDate", "modified": "modified", "owner": "owner", "modified_by": "modifiedBy", "status": "status", "is_return": "isReturn", "return_against": "returnAgainst", "amended_from": "amendedFrom", "custom_tradept_order_id": "orderId", "remarks": "remarks", "bill_no": "billNo", "bill_date": "billDate", "debit_to": "debitTo", "credit_to": "creditTo", "cost_center": "costCenter", "taxes_and_charges": "taxesTemplate", "payment_terms_template": "paymentTermsTemplate"}
PAYMENT_FIELDS = {"payment_type": "paymentType", "party_type": "partyType", "party": "party", "paid_amount": "paidAmount", "received_amount": "receivedAmount", "base_paid_amount": "basePaidAmount", "base_received_amount": "baseReceivedAmount", "paid_from": "paidFrom", "paid_to": "paidTo", "paid_from_account_currency": "paidFromCurrency", "paid_to_account_currency": "paidToCurrency", "source_exchange_rate": "sourceExchangeRate", "target_exchange_rate": "targetExchangeRate", "total_allocated_amount": "totalAllocatedAmount", "base_total_allocated_amount": "baseTotalAllocatedAmount", "unallocated_amount": "unallocatedAmount", "difference_amount": "differenceAmount", "reference_no": "referenceNo", "reference_date": "referenceDate", "mode_of_payment": "modeOfPayment", "bank_account": "bankAccount", "party_bank_account": "partyBankAccount", "clearance_date": "clearanceDate"}
ITEM_FIELDS = {"name": "name", "item_code": "itemCode", "item_name": "itemName", "description": "description", "qty": "qty", "uom": "uom", "rate": "rate", "amount": "amount", "base_rate": "baseRate", "base_amount": "baseAmount", "income_account": "incomeAccount", "expense_account": "expenseAccount", "cost_center": "costCenter", "warehouse": "warehouse", "sales_order": "salesOrder", "so_detail": "salesOrderItem", "delivery_note": "deliveryNote", "dn_detail": "deliveryNoteItem", "purchase_order": "purchaseOrder", "po_detail": "purchaseOrderItem", "purchase_receipt": "purchaseReceipt", "pr_detail": "purchaseReceiptItem"}
REFERENCE_FIELDS = {"name": "name", "reference_doctype": "referenceDoctype", "reference_name": "referenceName", "total_amount": "totalAmount", "outstanding_amount": "outstandingAmount", "allocated_amount": "allocatedAmount", "exchange_rate": "exchangeRate", "due_date": "dueDate", "payment_term": "paymentTerm"}
DEDUCTION_FIELDS = {"account": "account", "cost_center": "costCenter", "amount": "amount", "description": "description"}
TAX_FIELDS = {"charge_type": "chargeType", "account_head": "accountHead", "description": "description", "rate": "rate", "tax_amount": "taxAmount", "base_tax_amount": "baseTaxAmount", "total": "total", "cost_center": "costCenter", "included_in_print_rate": "includedInPrintRate"}
SCHEDULE_FIELDS = {"payment_term": "paymentTerm", "due_date": "dueDate", "invoice_portion": "invoicePortion", "payment_amount": "paymentAmount", "outstanding": "outstanding", "paid_amount": "paidAmount", "discount_type": "discountType", "discount": "discount"}


def amount(value, field, *, positive=False, signed=False):
    if isinstance(value, bool):
        raise APIError(400, "INVALID_FINANCE_AMOUNT", field + " requires a number")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise APIError(400, "INVALID_FINANCE_AMOUNT", field + " requires a finite amount") from None
    if not number.is_finite() or abs(number) > Decimal("1000000000000000") or (not signed and number < 0) or (positive and number <= 0):
        raise APIError(400, "INVALID_FINANCE_AMOUNT", field + " has an invalid amount")
    return float(number)


def text(value, field, *, required=False, limit=200):
    if value in (None, "") and not required:
        return ""
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 for c in value):
        raise APIError(400, "INVALID_FINANCE_VALUE", field + " requires a valid value")
    return value.strip()


def day(value, field, *, optional=False):
    if value in (None, "") and optional:
        return None
    if not isinstance(value, str):
        raise APIError(400, "INVALID_FINANCE_DATE", field + " requires YYYY-MM-DD")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise APIError(400, "INVALID_FINANCE_DATE", field + " requires YYYY-MM-DD") from None


def object_values(value, allowed, field="values"):
    if not isinstance(value, dict) or any(key not in allowed for key in value):
        raise APIError(400, "INVALID_FINANCE_FIELDS", field + " contains unsupported or calculated fields")
    return value


def mapped_fields(row, mapping):
    result = {}
    for native, public in mapping.items():
        value = row.get(native)
        if value is not None:
            result[public] = str(value) if isinstance(value, (date, Decimal)) or public == "modified" else value
    return result


def require_usable_item(item, company, *, sales=None):
    """Company tags authorize new use; untagged native SKUs remain shared."""
    if isinstance(item, str):
        item = frappe.get_doc("Item", item)
    if item.get("custom_tradept_company") not in (None, "", company):
        raise APIError(403, "CATALOG_ITEM_COMPANY_DENIED", "商品属于另一公司，不能用于当前公司的新单据")
    if item.get("disabled"):
        raise APIError(400, "CATALOG_ITEM_DISABLED", "请选择未停用的 ERPNext 商品")
    field = "is_sales_item" if sales is True else "is_purchase_item" if sales is False else None
    if field and item.get(field) == 0:
        raise APIError(400, "CATALOG_ITEM_USE_DENIED", "该商品未启用此销售或采购用途")
    return item


def summary(doc, company_id):
    value = mapped_fields(doc, COMMON_FIELDS)
    value.update(resource=next((key for key, dt in DOCTYPES.items() if dt == doc.doctype), frappe.scrub(doc.doctype)), companyId=company_id)
    if doc.doctype == "Payment Entry":
        value.update(mapped_fields(doc, PAYMENT_FIELDS))
        value["currency"] = doc.get("paid_from_account_currency") if doc.get("payment_type") == "Receive" else doc.get("paid_to_account_currency")
    else:
        field = PARTY_FIELDS.get(doc.doctype)
        value["party"] = doc.get(field) if field else None
        value["partyType"] = "Customer" if field == "customer" else "Supplier"
        value["partyName"] = doc.get("customer_name") or doc.get("supplier_name") or value["party"]
        account = doc.get("debit_to") if doc.doctype == "Sales Invoice" else doc.get("credit_to")
        outstanding_currency = doc.get("party_account_currency") or (frappe.db.get_value("Account", account, "account_currency") if account else None) or doc.get("currency")
        value["partyAccountCurrency"] = value["outstandingCurrency"] = outstanding_currency
    return value


def detail(doc, company_id):
    result = summary(doc, company_id)
    for table, mapping in (("items", ITEM_FIELDS), ("references", REFERENCE_FIELDS), ("deductions", DEDUCTION_FIELDS), ("taxes", TAX_FIELDS), ("payment_schedule", SCHEDULE_FIELDS)):
        result[{"payment_schedule": "paymentSchedule"}.get(table, table)] = [mapped_fields(row, mapping) for row in (doc.get(table) or [])]
    result["advances"] = [mapped_fields(row, {"reference_type": "referenceType", "reference_name": "referenceName", "advance_amount": "advanceAmount", "allocated_amount": "allocatedAmount"}) for row in (doc.get("advances") or [])]
    if doc.doctype in ("Sales Invoice", "Purchase Invoice"):
        result.update(payment_terms(doc))
    return result


def payment_terms(doc):
    """Expose original-currency schedules and native party-currency balances.

The ERPNext mapping helper applies the frozen invoice conversion rate where
accounting is in the company currency. A schedule's stored outstanding field
must not be mislabeled as the party account currency.
"""
    template = doc.get("payment_terms_template")
    enabled = bool(template and frappe.db.get_value("Payment Terms Template", template, "allocate_payment_based_on_payment_terms"))
    schedule = [mapped_fields(row, SCHEDULE_FIELDS) for row in (doc.get("payment_schedule") or [])]
    account = doc.get("debit_to") if doc.doctype == "Sales Invoice" else doc.get("credit_to")
    currency = doc.get("party_account_currency") or (frappe.db.get_value("Account", account, "account_currency") if account else None) or doc.get("currency")
    if enabled:
        from erpnext.accounts.doctype.payment_entry.payment_entry import get_reference_as_per_payment_terms, set_grand_total_and_outstanding_amount
        total, outstanding = set_grand_total_and_outstanding_amount(None, doc.doctype, currency, doc)
        references = get_reference_as_per_payment_terms(doc.get("payment_schedule") or [], doc.doctype, doc.name, doc, total, outstanding, currency)
        grouped = {}
        for reference in references:
            grouped.setdefault(reference.get("payment_term"), []).append(reference)
        for row in schedule:
            available = grouped.get(row.get("paymentTerm")) or []
            reference = available.pop(0) if available else None
            row["outstandingAmount"] = reference.get("payment_term_outstanding", 0) if reference else 0
            row["outstandingCurrency"] = currency
    for row in schedule:
        row["currency"] = doc.get("currency")
    return {"paymentTermsTemplate": template, "allocatePaymentBasedOnPaymentTerms": enabled, "paymentSchedule": schedule}


def require_account(name, company, *, types=None):
    name = text(name, "Account", required=True)
    account = frappe.get_doc("Account", name)
    if account.company != company or account.get("is_group") or account.get("disabled") or (types and account.get("account_type") not in types):
        raise APIError(403, "FINANCE_ACCOUNT_DENIED", "Select an active account belonging to this legal entity")
    return account


def require_cost_center(name, company):
    if name and (frappe.db.get_value("Cost Center", name, "company") != company or frappe.db.get_value("Cost Center", name, "is_group")):
        raise APIError(403, "FINANCE_COST_CENTER_DENIED", "The cost center belongs to a different legal entity")


def require_party(party_type, name, company):
    if party_type not in ("Customer", "Supplier"):
        raise APIError(400, "INVALID_FINANCE_PARTY", "Select Customer or Supplier")
    doc = frappe.get_doc(party_type, text(name, "Party", required=True))
    # Native masters created during onboarding carry a single legal entity.
    # A configured accounting company row is an explicit native sharing grant.
    owning = doc.get("custom_tradept_company")
    allowed = owning == company or any(row.get("company") == company for row in (doc.get("accounts") or []))
    if not allowed or doc.get("disabled") or doc.get("custom_tradept_is_deleted"):
        raise APIError(403, "FINANCE_PARTY_DENIED", "Select an active customer or supplier configured for this legal entity")
    return doc


def currency_rate(doc, values, *, frozen=False):
    base = frappe.db.get_value("Company", doc.company, "default_currency")
    currency = values.get("currency", doc.get("currency") or base)
    if not frappe.db.exists("Currency", currency):
        raise APIError(400, "FINANCE_CURRENCY_REQUIRED", "Select a configured currency")
    if frozen and currency != doc.get("currency"):
        raise APIError(409, "FINANCE_RATE_FROZEN", "The document currency is frozen; amend the document instead")
    supplied = values.get("conversionRate", doc.get("conversion_rate"))
    if currency == base:
        if supplied not in (None, "", 1, 1.0, "1"):
            raise APIError(400, "INVALID_FINANCE_RATE", "The company currency has a conversion rate of one")
        rate = 1.0
    else:
        rate = amount(supplied, "Conversion rate", positive=True)
    if frozen and abs(rate - float(doc.get("conversion_rate") or 1)) > 0.000000001:
        raise APIError(409, "FINANCE_RATE_FROZEN", "The document's posted/source exchange rate is frozen")
    doc.currency, doc.conversion_rate = currency, rate


INVOICE_VALUES = {"party", "postingDate", "dueDate", "currency", "conversionRate", "costCenter", "remarks", "items", "taxesTemplate", "paymentTermsTemplate", "billNo", "billDate", "debitTo", "creditTo", "updateStock", "additionalDiscountPercentage", "discountAmount", "applyDiscountOn", "allocateAdvances"}
ITEM_VALUES = {"name", "itemCode", "qty", "quantity", "rate", "uom", "incomeAccount", "expenseAccount", "costCenter", "warehouse", "description"}


def invoice_values(doc, values, *, frozen=False):
    object_values(values, INVOICE_VALUES)
    party_type = "Customer" if doc.doctype == "Sales Invoice" else "Supplier"
    party_field = "customer" if party_type == "Customer" else "supplier"
    party = values.get("party", doc.get(party_field))
    if frozen and party != doc.get(party_field):
        raise APIError(409, "FINANCE_PARTY_FROZEN", "The source customer or supplier cannot be reassigned")
    require_party(party_type, party, doc.company)
    doc.set(party_field, party)
    currency_rate(doc, values, frozen=frozen)
    for public, native in (("postingDate", "posting_date"), ("dueDate", "due_date"), ("billDate", "bill_date")):
        if public in values:
            doc.set(native, day(values[public], public, optional=public != "postingDate"))
    doc.posting_date = doc.get("posting_date") or frappe.utils.today()
    for public, native in (("remarks", "remarks"), ("billNo", "bill_no"), ("paymentTermsTemplate", "payment_terms_template")):
        if public in values:
            doc.set(native, text(values[public], public, limit=4000 if public == "remarks" else 200))
    if values.get("paymentTermsTemplate") and not frappe.db.exists("Payment Terms Template", values["paymentTermsTemplate"]):
        raise APIError(400, "FINANCE_TERMS_REQUIRED", "Select an existing native payment terms template")
    if "costCenter" in values:
        require_cost_center(values["costCenter"], doc.company)
        doc.cost_center = text(values["costCenter"], "costCenter") or None
    for public, native, types in (("debitTo", "debit_to", {"Receivable"}), ("creditTo", "credit_to", {"Payable"})):
        if public in values:
            if (public == "debitTo") != (doc.doctype == "Sales Invoice"):
                raise APIError(400, "INVALID_FINANCE_FIELDS", "The account does not apply to this invoice type")
            account = text(values[public], public) or None
            if account:
                require_account(account, doc.company, types=types)
            # ERPNext's invoice controller fills a missing party account from
            # its configured Customer/Supplier Company Account. An explicit
            # empty selection resets an earlier override to that native default.
            doc.set(native, account)
    for public, native in (("additionalDiscountPercentage", "additional_discount_percentage"), ("discountAmount", "discount_amount")):
        if public in values:
            doc.set(native, amount(values[public], public))
    if "applyDiscountOn" in values:
        if values["applyDiscountOn"] not in ("Grand Total", "Net Total"):
            raise APIError(400, "INVALID_FINANCE_FIELDS", "Select Grand Total or Net Total for discounts")
        doc.apply_discount_on = values["applyDiscountOn"]
    if "updateStock" in values:
        if type(values["updateStock"]) not in (int, bool) or values["updateStock"] not in (0, 1):
            raise APIError(400, "INVALID_FINANCE_FIELDS", "updateStock must be a boolean")
        doc.update_stock = int(values["updateStock"])
    if "items" in values:
        items = values["items"]
        if not isinstance(items, list) or not 1 <= len(items) <= 200:
            raise APIError(400, "FINANCE_ITEMS_REQUIRED", "Invoices require one to two hundred real item lines")
        prior = {row.name: row.as_dict() for row in (doc.get("items") or []) if row.get("name")}
        result, seen = [], set()
        linked = any(any(row.get(field) for field in ("sales_order", "delivery_note", "purchase_order", "purchase_receipt")) for row in (doc.get("items") or []))
        for supplied in items:
            object_values(supplied, ITEM_VALUES, "Item")
            key = supplied.get("name")
            if key and (key not in prior or key in seen):
                raise APIError(409, "FINANCE_ITEM_CONFLICT", "An item row changed; reload the document")
            if linked and not key:
                raise APIError(400, "FINANCE_SOURCE_ITEM_REQUIRED", "Mapped invoice lines require their native source row identifiers")
            seen.add(key)
            line = copy.deepcopy(prior.get(key, {}))
            code = supplied.get("itemCode", line.get("item_code"))
            if line and code != line.get("item_code"):
                raise APIError(409, "FINANCE_ITEM_FROZEN", "Amend the source item instead of changing its identity")
            item = frappe.get_doc("Item", text(code, "Item code", required=True))
            if item.get("disabled"):
                raise APIError(400, "FINANCE_ITEM_DISABLED", "Select an active native Item")
            # Existing return rows retain their native historical identity.
            # Company tags authorize new usage, never rebind old documents.
            if not (doc.get("is_return") and line):
                require_usable_item(item, doc.company, sales=doc.doctype == "Sales Invoice")
            qty = amount(supplied.get("qty", supplied.get("quantity", line.get("qty"))), "Quantity", signed=bool(doc.get("is_return")))
            if qty == 0 or (doc.get("is_return") and qty > 0):
                raise APIError(400, "INVALID_FINANCE_QUANTITY", "Return quantities must be negative; invoice quantities must be positive")
            rate = amount(supplied.get("rate", line.get("rate")), "Rate")
            if doc.get("is_return") and line and rate != float(line.get("rate") or 0):
                raise APIError(409, "FINANCE_RETURN_RATE_FROZEN", "Returns retain the original native item rate")
            line.update(item_code=code, qty=qty, rate=rate)
            for public, native in (("uom", "uom"), ("description", "description"), ("warehouse", "warehouse"), ("costCenter", "cost_center"), ("incomeAccount", "income_account"), ("expenseAccount", "expense_account")):
                if public in supplied:
                    value = text(supplied[public], public, limit=4000 if public == "description" else 200)
                    # Standard AccountsController.set_missing_item_details
                    # fills default income/account fields only when None.
                    # Empty strings would suppress real Item/Group/Company
                    # defaults, especially when an editor resets an override.
                    line[native] = value if public == "description" else value or None
            for field in ("income_account", "expense_account"):
                if line.get(field):
                    require_account(line[field], doc.company)
            require_cost_center(line.get("cost_center"), doc.company)
            if line.get("warehouse") and frappe.db.get_value("Warehouse", line["warehouse"], "company") != doc.company:
                raise APIError(403, "FINANCE_WAREHOUSE_DENIED", "The warehouse belongs to a different legal entity")
            result.append(line)
        doc.set("items", result)
    if not doc.get("items"):
        raise APIError(400, "FINANCE_ITEMS_REQUIRED", "A real native Item is required; balances are never fabricated")
    if "taxesTemplate" in values:
        template = values["taxesTemplate"]
        template_type = "Sales Taxes and Charges Template" if party_type == "Customer" else "Purchase Taxes and Charges Template"
        if template:
            tax_doc = frappe.get_doc(template_type, text(template, "Tax template", required=True))
            if tax_doc.company != doc.company or tax_doc.get("disabled"):
                raise APIError(403, "FINANCE_TAX_TEMPLATE_DENIED", "The tax template belongs to a different legal entity")
            from erpnext.controllers.accounts_controller import get_taxes_and_charges
            doc.set("taxes", get_taxes_and_charges(template_type, template))
        else:
            doc.set("taxes", [])
        doc.taxes_and_charges = template or None
    doc.ignore_pricing_rule = 1
    doc.set_missing_values()
    doc.calculate_taxes_and_totals()
    if "allocateAdvances" in values and type(values["allocateAdvances"]) is not bool:
        raise APIError(400, "INVALID_FINANCE_FIELDS", "allocateAdvances must be a boolean")
    if values.get("allocateAdvances"):
        doc.set_advances()
    return doc


def mapped_invoice(resource, source):
    if resource == "sales_invoice" and source.doctype == "Sales Order":
        from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice
        doc = make_sales_invoice(source.name)
    elif resource == "sales_invoice" and source.doctype == "Delivery Note":
        from erpnext.stock.doctype.delivery_note.delivery_note import make_sales_invoice
        doc = make_sales_invoice(source.name)
    elif resource == "purchase_invoice" and source.doctype == "Purchase Order":
        from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice
        doc = make_purchase_invoice(source.name)
    elif resource == "purchase_invoice" and source.doctype == "Purchase Receipt":
        from erpnext.stock.doctype.purchase_receipt.purchase_receipt import make_purchase_invoice
        doc = make_purchase_invoice(source.name)
    else:
        raise APIError(400, "FINANCE_SOURCE_DENIED", "Select a compatible native order or delivery/receipt")
    doc.custom_tradept_order_id = source.get("custom_tradept_order_id")
    return doc


PAYMENT_VALUES = {"partyType", "party", "paymentType", "postingDate", "paidFrom", "paidTo", "paidAmount", "receivedAmount", "sourceExchangeRate", "targetExchangeRate", "referenceNo", "referenceDate", "modeOfPayment", "bankAccount", "partyBankAccount", "costCenter", "remarks", "references", "deductions"}


def payment_values(doc, values, *, frozen=False):
    object_values(values, PAYMENT_VALUES)
    for public, native in (("partyType", "party_type"), ("party", "party"), ("paymentType", "payment_type"), ("paidFrom", "paid_from"), ("paidTo", "paid_to"), ("modeOfPayment", "mode_of_payment"), ("bankAccount", "bank_account"), ("partyBankAccount", "party_bank_account"), ("costCenter", "cost_center"), ("referenceNo", "reference_no"), ("remarks", "remarks")):
        if public in values:
            new = text(values[public], public, limit=4000 if public == "remarks" else 200)
            if frozen and public in ("party", "partyType", "paymentType") and new != doc.get(native):
                raise APIError(409, "FINANCE_PARTY_FROZEN", "The payment's source party and direction are immutable")
            doc.set(native, new)
    internal = doc.get("payment_type") == "Internal Transfer"
    if doc.get("payment_type") not in ("Receive", "Pay", "Internal Transfer") or not internal and doc.get("party_type") not in ("Customer", "Supplier"):
        raise APIError(400, "INVALID_FINANCE_PAYMENT", "Select a customer/supplier receipt, payment or company internal transfer")
    if internal:
        if doc.get("party") or doc.get("party_type") or values.get("references") or doc.get("references"):
            raise APIError(400, "INVALID_FINANCE_TRANSFER", "Internal transfers use company bank/cash accounts without a customer, supplier or invoice references")
        doc.party_type, doc.party = None, None
    else:
        require_party(doc.party_type, doc.party, doc.company)
    source = require_account(doc.get("paid_from"), doc.company)
    target = require_account(doc.get("paid_to"), doc.company)
    company_currency = frappe.db.get_value("Company", doc.company, "default_currency")
    party_account = source if doc.payment_type == "Receive" else target
    bank_account = target if doc.payment_type == "Receive" else source
    if internal and (source.get("account_type") not in ("Bank", "Cash") or target.get("account_type") not in ("Bank", "Cash") or source.name == target.name):
        raise APIError(403, "FINANCE_ACCOUNT_DENIED", "Internal transfers use distinct company bank/cash accounts")
    if not internal and (party_account.get("account_type") != ("Receivable" if doc.party_type == "Customer" else "Payable") or bank_account.get("account_type") not in ("Bank", "Cash")):
        raise APIError(403, "FINANCE_ACCOUNT_DENIED", "Use the party receivable/payable account and an authorized bank/cash account")
    doc.paid_from_account_currency = source.get("account_currency") or company_currency
    doc.paid_to_account_currency = target.get("account_currency") or company_currency
    doc.posting_date = day(values.get("postingDate", str(doc.get("posting_date") or frappe.utils.today())), "Posting date")
    if "referenceDate" in values:
        doc.reference_date = day(values["referenceDate"], "Reference date", optional=True)
    for public, native in (("paidAmount", "paid_amount"), ("receivedAmount", "received_amount")):
        doc.set(native, amount(values.get(public, doc.get(native)), public, positive=True))
    for public, native, currency in (("sourceExchangeRate", "source_exchange_rate", doc.paid_from_account_currency), ("targetExchangeRate", "target_exchange_rate", doc.paid_to_account_currency)):
        supplied = values.get(public)
        if currency == company_currency:
            if supplied not in (None, "", 1, 1.0, "1"):
                raise APIError(400, "INVALID_FINANCE_RATE", "Company-currency payment rates must equal one")
            rate = 1.0
        else:
            # Every new foreign-currency payment records an explicit rate. An
            # invoice's historical conversion is never used as today's FX.
            if supplied is None and not frozen:
                raise APIError(400, "FINANCE_PAYMENT_RATE_REQUIRED", "Record the actual exchange rate for this payment")
            rate = amount(supplied if supplied is not None else doc.get(native), public, positive=True)
        doc.set(native, rate)
    if doc.paid_from_account_currency == doc.paid_to_account_currency and not internal:
        if abs(doc.paid_amount - doc.received_amount) > 0.000000001 or abs(doc.source_exchange_rate - doc.target_exchange_rate) > 0.000000001:
            raise APIError(400, "NATIVE_SAME_CURRENCY_PAYMENT", "ERPNext records equal paid/received amounts and rates for same-currency accounts; record fees as native deductions and reconcile the bank statement")
    require_cost_center(doc.get("cost_center"), doc.company)
    if "references" in values:
        if not isinstance(values["references"], list) or len(values["references"]) > 200:
            raise APIError(400, "INVALID_FINANCE_REFERENCES", "Payment references must be an array")
        rows, seen = [], set()
        for value in values["references"]:
            object_values(value, {"referenceDoctype", "referenceName", "allocatedAmount", "paymentTerm"}, "Reference")
            dt, name = value.get("referenceDoctype"), text(value.get("referenceName"), "Reference name", required=True)
            term = text(value.get("paymentTerm"), "Payment term") or None
            allowed = {"Sales Invoice", "Sales Order"} if doc.party_type == "Customer" else {"Purchase Invoice", "Purchase Order"}
            if dt not in allowed or (dt, name, term) in seen:
                raise APIError(400, "INVALID_FINANCE_REFERENCE", "Select distinct compatible invoice/order references")
            seen.add((dt, name, term))
            reference = frappe.get_doc(dt, name, for_update=True)
            if reference.company != doc.company or reference.get(PARTY_FIELDS[dt]) != doc.party or reference.docstatus != 1:
                raise APIError(403, "FINANCE_REFERENCE_DENIED", "The reference must be a submitted document for the same party and legal entity")
            negative_balance = dt in ("Sales Invoice", "Purchase Invoice") and float(reference.get("outstanding_amount") or 0) < 0
            rows.append({"reference_doctype": dt, "reference_name": name, "allocated_amount": amount(value.get("allocatedAmount"), "Allocated amount", signed=bool(reference.get("is_return")) or negative_balance), "payment_term": term})
        doc.set("references", rows)
    if "deductions" in values:
        if not isinstance(values["deductions"], list) or len(values["deductions"]) > 100:
            raise APIError(400, "INVALID_FINANCE_DEDUCTIONS", "Payment deductions must be an array")
        rows = []
        for value in values["deductions"]:
            object_values(value, set(DEDUCTION_FIELDS.values()), "Deduction")
            account = require_account(value.get("account"), doc.company)
            if account.get("account_type") in ("Bank", "Cash", "Receivable", "Payable") or account.get("root_type") == "Equity":
                raise APIError(403, "FINANCE_DEDUCTION_ACCOUNT_DENIED", "Fees and adjustments cannot move money through another bank, cash or party account")
            require_cost_center(value.get("costCenter"), doc.company)
            rows.append({"account": value["account"], "cost_center": value.get("costCenter"), "amount": amount(value.get("amount"), "Deduction", signed=True), "description": text(value.get("description"), "Description", limit=1000)})
        doc.set("deductions", rows)
    if doc.get("mode_of_payment") and not frappe.db.exists("Mode of Payment", doc.mode_of_payment):
        raise APIError(400, "FINANCE_PAYMENT_MODE_REQUIRED", "Select an existing payment mode")
    for field in ("bank_account", "party_bank_account"):
        if doc.get(field):
            bank = frappe.get_doc("Bank Account", doc.get(field))
            if bank.get("disabled") or (field == "bank_account" and (bank.get("company") != doc.company or bank.get("account") != bank_account.name)) or (field == "party_bank_account" and (bank.get("party_type") != doc.party_type or bank.get("party") != doc.party)):
                raise APIError(403, "FINANCE_BANK_ACCOUNT_DENIED", "Select a bank account for this company or the same payment party")
    doc.setup_party_account_field()
    doc.set_missing_values()
    doc.set_missing_ref_details()
    doc.set_amounts()
    return doc


def mapped_payment(source, values):
    from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry, set_payment_type
    payment_type = values.get("paymentType")
    if source.doctype not in ("Sales Invoice", "Purchase Invoice", "Sales Order", "Purchase Order"):
        raise APIError(400, "FINANCE_SOURCE_DENIED", "Payments originate from a submitted invoice or order")
    direction = payment_type or set_payment_type(source.doctype, source)
    bank = values.get("paidTo" if direction == "Receive" else "paidFrom")
    bank_amount = values.get("receivedAmount" if direction == "Receive" else "paidAmount")
    doc = get_payment_entry(source.doctype, source.name, bank_account=bank, bank_amount=bank_amount, payment_type=direction, reference_date=values.get("referenceDate"))
    doc.custom_tradept_order_id = source.get("custom_tradept_order_id")
    return doc


def payment_direction(source):
    from erpnext.accounts.doctype.payment_entry.payment_entry import set_payment_type
    return set_payment_type(source.doctype, source)


def return_invoice(source):
    from erpnext.controllers.sales_and_purchase_return import make_return_doc
    doc = make_return_doc(source.doctype, source.name)
    doc.custom_tradept_order_id = source.get("custom_tradept_order_id")
    doc.custom_tradept_operation_key = None
    return doc


REPORT_FILTERS = {"reportDate": "report_date", "fromDate": "from_date", "toDate": "to_date", "partyType": "party_type", "party": "party", "account": "account", "costCenter": "cost_center", "voucherNo": "voucher_no", "currency": "presentation_currency", "basedOnPaymentTerms": "based_on_payment_terms", "showFuturePayments": "show_future_payments", "showCancelledEntries": "show_cancelled_entries", "groupBy": "group_by", "ageingBasedOn": "ageing_based_on", "ageAsOn": "age_as_on", "inPartyCurrency": "in_party_currency", "range1": "range1", "range2": "range2", "range3": "range3", "range4": "range4"}


def report_filters(report, company, values):
    object_values(values, set(REPORT_FILTERS), "Report filters")
    filters = {"company": company}
    for public, value in values.items():
        native = REPORT_FILTERS[public]
        if public.endswith("Date"):
            value = day(value, public)
        elif public in ("basedOnPaymentTerms", "showFuturePayments", "showCancelledEntries", "inPartyCurrency"):
            if type(value) not in (bool, int) or value not in (0, 1):
                raise APIError(400, "INVALID_FINANCE_FILTER", public + " requires a boolean")
            value = int(value)
        elif public.startswith("range"):
            if type(value) is not int or not 1 <= value <= 3650:
                raise APIError(400, "INVALID_FINANCE_FILTER", "Ageing ranges must be positive day counts")
        elif public == "account":
            selected = value if isinstance(value, list) else [value]
            if len(selected) > 100:
                raise APIError(400, "INVALID_FINANCE_FILTER", "Too many accounts selected")
            for name in selected:
                require_account(name, company)
            value = selected if report == "general_ledger" else value
        elif public == "party":
            party_type = "Customer" if report == "receivables" else "Supplier" if report == "payables" else values.get("partyType")
            selected = value if isinstance(value, list) else [value]
            for name in selected:
                require_party(party_type, name, company)
            value = selected if report == "general_ledger" else selected
        elif public == "costCenter":
            require_cost_center(value, company)
        elif public == "groupBy" and value not in ("", "Group by Voucher", "Group by Voucher (Consolidated)", "Group by Account", "Group by Party"):
            raise APIError(400, "INVALID_FINANCE_FILTER", "Select a supported native grouping")
        elif public == "ageingBasedOn" and value not in ("Posting Date", "Due Date", "Supplier Invoice Date"):
            raise APIError(400, "INVALID_FINANCE_FILTER", "Select a supported native ageing basis")
        elif public == "ageAsOn" and value not in ("Report Date", "Today"):
            raise APIError(400, "INVALID_FINANCE_FILTER", "Ageing is measured as of Report Date or Today")
        elif public == "partyType" and value not in ("Customer", "Supplier"):
            raise APIError(400, "INVALID_FINANCE_PARTY", "Select Customer or Supplier")
        filters[native] = value
    if report in ("receivables", "payables"):
        filters.setdefault("report_date", frappe.utils.today())
        filters.setdefault("ageing_based_on", "Due Date")
        filters.setdefault("age_as_on", "Report Date")
        filters["party_type"] = "Customer" if report == "receivables" else "Supplier"
        ranges = [filters.pop("range" + str(index), value) for index, value in enumerate((30, 60, 90, 120), 1)]
        if ranges != sorted(set(ranges)):
            raise APIError(400, "INVALID_FINANCE_FILTER", "Ageing ranges must increase without duplicates")
        filters["range"] = ", ".join(str(value) for value in ranges)
    else:
        if not filters.get("from_date") or not filters.get("to_date"):
            raise APIError(400, "FINANCE_REPORT_DATES_REQUIRED", "The general ledger requires fromDate and toDate")
        if filters["from_date"] > filters["to_date"]:
            raise APIError(400, "INVALID_FINANCE_DATE_RANGE", "fromDate must precede toDate")
        filters.setdefault("group_by", "Group by Voucher (Consolidated)")
    return frappe._dict(filters)


def native_report(report, filters):
    if report == "receivables":
        from erpnext.accounts.report.accounts_receivable.accounts_receivable import execute
        title = "Accounts Receivable"
    elif report == "payables":
        from erpnext.accounts.report.accounts_payable.accounts_payable import execute
        title = "Accounts Payable"
    elif report == "general_ledger":
        from erpnext.accounts.report.general_ledger.general_ledger import execute
        title = "General Ledger"
    else:
        raise APIError(404, "FINANCE_REPORT_NOT_FOUND", "Unknown native accounting report")
    result = execute(filters)
    return {"nativeReport": title, "columns": result[0], "result": result[1], "message": result[2] if len(result) > 2 else None, "chart": result[3] if len(result) > 3 else None, "reportSummary": result[4] if len(result) > 4 else None}
