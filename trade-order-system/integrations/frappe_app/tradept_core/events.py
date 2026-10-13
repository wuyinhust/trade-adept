"""Include trusted native Desk/import writes in the workspace CAS transaction."""
from __future__ import annotations

from contextlib import contextmanager
from functools import wraps
import frappe

from . import repository as repo


@contextmanager
def managed_write():
    previous = bool(getattr(frappe.flags, "tradept_managed_write", False))
    frappe.flags.tradept_managed_write = True
    try:
        yield
    finally:
        frappe.flags.tradept_managed_write = previous


def managed(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with managed_write():
            return function(*args, **kwargs)
    return wrapped


def _tracked(doc):
    if getattr(frappe.flags, "tradept_managed_write", False):
        return False
    if not frappe.db.exists("Trade Workspace", "workspace"):
        return False
    if doc.doctype in ("Item", "Sales Invoice", "Purchase Invoice", "Payment Entry", "Bank Transaction", "Journal Entry", "Unreconcile Payment"):
        return True
    if doc.doctype in ("Customer", "Supplier", "Company", "Currency Exchange"):
        return bool(doc.get("custom_tradept_record_id"))
    if doc.doctype == "Contact":
        return bool(doc.get("custom_tradept_parent"))
    if doc.doctype.startswith("Trade "):
        return bool(doc.get("record_id"))
    if doc.get("custom_tradept_order_id"):
        return True
    # Standard descendants created through native mapping can omit custom
    # provenance, but their standard item/reference links still identify them.
    if doc.doctype == "Payment Entry":
        return any(row.reference_doctype in ("Sales Order", "Purchase Order") and frappe.db.get_value(row.reference_doctype, row.reference_name, "custom_tradept_order_id") for row in doc.get("references", []))
    links = {"Delivery Note": "against_sales_order", "Sales Invoice": "sales_order", "Purchase Invoice": "purchase_order", "Purchase Receipt": "purchase_order"}
    field = links.get(doc.doctype)
    if field:
        parent_type = "Purchase Order" if field == "purchase_order" else "Sales Order"
        return any(row.get(field) and frappe.db.get_value(parent_type, row.get(field), "custom_tradept_order_id") for row in doc.get("items", []))
    return False


def before_catalog_write(doc, method=None):
    """Bound Item delegation cannot create prices, variants or other parents."""
    from .permissions import delegated_catalog_grant
    from .domain import APIError
    grant = delegated_catalog_grant()
    if not grant:
        return
    if grant["action"] == "read":
        raise APIError(403, "CATALOG_READ_ONLY_DELEGATION", "只读商品流程不能修改原生记录")
    target = grant["document"]
    if doc.doctype != "Item":
        child = any(doc is row for row in target.get_all_children())
        field = target.meta.get_field(doc.get("parentfield")) if child else None
        if not child or not getattr(doc.meta, "istable", False) or not field or field.options != doc.doctype or doc.get("parenttype") != "Item" or doc.get("parent") != target.name or grant["action"] not in ("create", "write") or method in ("before_submit", "before_cancel", "on_trash"):
            raise APIError(403, "CATALOG_UNBOUND_NATIVE_WRITE", "商品流程只能修改目标商品的原生子表")
        child_company = doc.get("company")
        if child_company and (child_company not in grant["policy"].companies().values() or grant["item_company"] and child_company != grant["item_company"]):
            raise APIError(403, "CATALOG_COMPANY_DENIED", "商品子表不能修改未授权公司")
        grant["policy"].require_item(target, grant["action"], company=grant["company"])
        if doc.is_new():
            doc.owner = grant["user"]
        doc.modified_by = grant["user"]
        return
    if doc.doctype != "Item" or doc is not target or grant["original_name"] and doc.name != grant["original_name"]:
        raise APIError(403, "CATALOG_UNBOUND_NATIVE_WRITE", "商品流程不能修改其他商品、价格或库存记录")
    if method in ("before_submit", "before_cancel", "on_trash"):
        raise APIError(403, "CATALOG_UNBOUND_NATIVE_WRITE", "商品流程只支持创建、修改和停用")
    if doc.get("custom_tradept_company") != grant["item_company"]:
        raise APIError(403, "CATALOG_COMPANY_DENIED", "商品所属公司不能通过普通编辑改变")
    if doc.is_new():
        if grant["action"] != "create":
            raise APIError(403, "CATALOG_DELEGATION_DENIED", "创建商品需要独立权限")
        doc.owner = grant["user"]
    elif grant["action"] == "create":
        raise APIError(403, "CATALOG_DELEGATION_DENIED", "创建权限不能修改现有商品")
    grant["policy"].require_item(doc, grant["action"], company=grant["company"])


def before_native_write(doc, method=None):
    from .permissions import delegated_actor, delegated_finance_grant
    actor = delegated_actor()
    financial = delegated_finance_grant()
    if financial:
        from .domain import APIError
        from .finance_permissions import DOCUMENT_RESOURCES
        if doc.doctype == "Unreconcile Payment":
            if financial["resource"] != "reconciliation" or financial["action"] != "unreconcile":
                raise APIError(403, "FINANCE_UNRECONCILE_DENIED", "解除核销需要独立授权的原生写入流程")
            financial["policy"].validate_unreconcile(doc, financial["company"], financial["references"])
        if doc.doctype == "Journal Entry":
            _bounded_exchange_journal(doc, financial)
        if doc.doctype in DOCUMENT_RESOURCES:
            if doc.get("company") != financial["company"]:
                raise APIError(403, "FINANCE_COMPANY_DENIED", "原生财务流程不能写入其他公司")
            if financial["action"] in ("read", "print", "export"):
                raise APIError(403, "FINANCE_READ_ONLY_DELEGATION", "只读财务流程不能修改原生单据")
            expected = DOCUMENT_RESOURCES[doc.doctype] == financial["resource"]
            bound = {"doctype": doc.doctype, "name": doc.name} in financial["references"]
            if not expected and not bound:
                raise APIError(403, "FINANCE_UNBOUND_NATIVE_WRITE", "原生流程试图修改未授权财务单据")
    if actor:
        # Native service delegation must not rewrite the accountable creator
        # or last operator as Administrator. This context can only be issued
        # after the scoped API authorizes the actual configured native user.
        if doc.is_new():
            doc.owner = actor
        doc.modified_by = actor
        for child in doc.get_all_children():
            if child.is_new():
                child.owner = actor
            child.modified_by = actor
    if _tracked(doc):
        repo.workspace(lock=True)


def _bounded_exchange_journal(doc, grant):
    """Allow only ERPNext's generated FX side-effect, within bound vouchers."""
    from .domain import APIError
    from .permissions import bind_finance_reference
    if doc.get("voucher_type") in ("Credit Note", "Debit Note"):
        return _bounded_credit_journal(doc, grant)
    if grant["action"] in ("read", "print", "export"):
        raise APIError(403, "FINANCE_READ_ONLY_DELEGATION", "只读流程不能创建汇兑凭证")
    posting = grant["resource"] in ("sales_invoice", "purchase_invoice", "payment_entry") and grant["action"] in ("submit", "cancel")
    reconciling = grant["resource"] == "reconciliation" and grant["action"] in ("write", "unreconcile")
    if grant["action"] == "unreconcile" and doc.is_new():
        raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "解除核销只能撤销关联原生汇兑凭证，不能新建凭证")
    if not (posting or reconciling) or doc.get("company") != grant["company"] or doc.get("voucher_type") != "Exchange Gain Or Loss" or not doc.get("is_system_generated"):
        raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "只允许授权原生流程产生同公司的汇兑凭证")
    policy = grant["policy"]
    existing = {"doctype": doc.doctype, "name": doc.name}
    initially_bound = {(row["doctype"], row["name"]) for row in grant["references"]}
    refs = set()
    for row in doc.get("accounts", []):
        if row.get("account"):
            policy._account(row.account, grant["company"])
        if row.get("cost_center") and frappe.db.get_value("Cost Center", row.cost_center, "company") != grant["company"]:
            raise APIError(403, "FINANCE_DIMENSION_COMPANY_DENIED", "汇兑凭证成本中心必须属于所选公司")
        kind, name = row.get("reference_type"), row.get("reference_name")
        if kind or name:
            if not kind or not name:
                raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "汇兑凭证必须引用完整的原生来源")
            refs.add((kind, name))
        if row.get("party_type") or row.get("party"):
            policy._party(row.party_type, row.party, grant["company"])
    if not refs.intersection(initially_bound):
        raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "汇兑凭证没有引用本次已授权单据")
    for kind, name in sorted(refs):
        if frappe.db.get_value(kind, name, "company") != grant["company"]:
            raise APIError(403, "FINANCE_REFERENCE_COMPANY_DENIED", "汇兑凭证引用其他公司")
        if (kind, name) not in initially_bound:
            bind_finance_reference(kind, name)
    if not doc.is_new() and existing not in grant["references"]:
        # Capture the persisted historical creator before cancellation/save.
        bind_finance_reference(doc.doctype, doc.name)


def _bounded_credit_journal(doc, grant):
    """Permit native memo allocation, never arbitrary Journal Entry posting."""
    from decimal import Decimal, InvalidOperation
    from .domain import APIError
    if grant["resource"] != "reconciliation" or grant["action"] != "write" or doc.get("company") != grant["company"]:
        raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "贷项或借项核销需要获准公司的原生核销流程")
    target = {"doctype": doc.doctype, "name": doc.name}
    if not doc.is_new() and target not in grant["references"]:
        raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "不能修改未绑定授权的历史贷项核销凭证")
    sales = doc.get("voucher_type") == "Credit Note"
    invoice_type, party_type, account_type = ("Sales Invoice", "Customer", "Receivable") if sales else ("Purchase Invoice", "Supplier", "Payable")
    rows = doc.get("accounts", [])
    if len(rows) != 2:
        raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "原生贷项核销必须使用两条应收或应付明细")
    bound = {(row["doctype"], row["name"]) for row in grant["references"]}
    policy = grant["policy"]
    accounts, parties, kinds, references, debits, credits = set(), set(), set(), set(), Decimal(0), Decimal(0)
    for row in rows:
        account = row.get("account")
        policy._account(account, grant["company"])
        if frappe.db.get_value("Account", account, "account_type") != account_type:
            raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "贷项核销只能在同一应收或应付科目内部匹配")
        if row.get("cost_center") and frappe.db.get_value("Cost Center", row.cost_center, "company") != grant["company"]:
            raise APIError(403, "FINANCE_DIMENSION_COMPANY_DENIED", "核销成本中心必须属于所选公司")
        kind, name = row.get("reference_type"), row.get("reference_name")
        if kind != invoice_type or (kind, name) not in bound:
            raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "贷项核销只能引用已绑定授权的同类账单")
        invoice = policy.require_reference(kind, name, grant["company"])
        expected_party = invoice.get("customer" if sales else "supplier")
        if invoice.docstatus != 1 or row.get("party_type") != party_type or not expected_party or row.get("party") != expected_party:
            raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "贷项核销的账单状态或往来方不一致")
        accounts.add(account)
        parties.add(expected_party)
        kinds.add(bool(invoice.get("is_return")))
        references.add((kind, name))
        try:
            debit = Decimal(str(row.get("debit_in_account_currency") or 0))
            credit = Decimal(str(row.get("credit_in_account_currency") or 0))
        except (InvalidOperation, ValueError, TypeError):
            raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "原生贷项核销金额无效") from None
        if not debit.is_finite() or not credit.is_finite() or debit < 0 or credit < 0 or bool(debit) == bool(credit):
            raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "贷项核销明细必须具有有效单向金额")
        debits += debit
        credits += credit
    if len(accounts) != 1 or len(parties) != 1 or len(references) != 2 or kinds != {True, False} or debits <= 0 or abs(debits - credits) > Decimal("0.000001"):
        raise APIError(403, "FINANCE_UNBOUND_JOURNAL", "贷项核销必须是同一往来方的退货账单与普通账单平衡匹配")


def after_native_write(doc, method=None):
    from .permissions import delegated_finance_grant, delegated_catalog_grant
    catalog = delegated_catalog_grant()
    if catalog and doc.doctype == "Item" and doc is catalog["document"] and doc.name:
        target = {"doctype": "Item", "name": doc.name}
        if target not in catalog["references"]:
            catalog["references"].append(target)
    financial = delegated_finance_grant()
    if financial and doc.doctype in ("Sales Invoice", "Purchase Invoice", "Payment Entry", "Bank Transaction", "Journal Entry", "Unreconcile Payment") and doc.name:
        target = {"doctype": doc.doctype, "name": doc.name}
        if target not in financial["references"]:
            financial["references"].append(target)
    if not _tracked(doc):
        return
    pending = getattr(frappe.flags, "tradept_native_changes", None)
    if pending is None:
        pending = {}
        frappe.flags.tradept_native_changes = pending
        frappe.db.before_commit.add(_finish_native_changes)
        frappe.db.after_rollback.add(_clear_pending)
    pending[(doc.doctype, doc.name)] = {"doctype": doc.doctype, "name": doc.name, "event": method}


def _clear_pending():
    frappe.flags.tradept_native_changes = None


def _finish_native_changes():
    pending = getattr(frappe.flags, "tradept_native_changes", None)
    if not pending:
        return
    with managed_write():
        work, _cfg = repo.workspace(lock=True)
        # A native operator is audited by its actual identity; it is never
        # rewritten as a fabricated imported salesperson/creator.
        repo.finish(work, {"id": "native:" + frappe.session.user}, "native-change", list(pending.values()))
    _clear_pending()
