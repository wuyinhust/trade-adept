"""Exact financial grants around ERPNext's standard documents and reports.

Native Desk/REST stay denied for configured workbench accounts.  These checks
run before the short native service delegation, including for report runners
which do not apply Frappe permission query hooks themselves.
"""
from __future__ import annotations

import copy
from decimal import Decimal, InvalidOperation
import re

import frappe

from .domain import APIError, FINANCE_CAPABILITIES
from . import repository as repo

DOCUMENT_RESOURCES = {
    "Sales Invoice": "sales_invoice", "Purchase Invoice": "purchase_invoice",
    "Payment Entry": "payment_entry",
    "Bank Transaction": "bank_transaction",
}
DOCUMENT_ACTIONS = ("read", "create", "write", "submit", "cancel", "amend", "return", "print", "export")
FINANCE_POLICY_VERSION = 1
SCOPES = {"self": 0, "team": 1, "tenant": 2}
RESOURCE_ALIASES = {"general_ledger": "ledger"}
ACTION_ALIASES = {"reconcile": "write"}
REPORT_RESOURCES = {"receivables", "payables", "ledger", "reconciliation", "bank_reconciliation"}
# Only a native document's real owner determines standalone self/team access.
# modified_by is deliberately absent: editing is not ownership assignment.
BANK_FIELDS = {
    "bank_account", "bank_account_no", "bank_account_number", "bank_account_name", "bank",
    "iban", "swift", "swift_number", "branch_code", "bank_branch", "bank_address",
    "party_bank_account", "company_bank_account", "bank_info", "bank_details",
}
ACCOUNT_FIELDS = {
    "debit_to", "credit_to", "paid_from", "paid_to", "income_account", "expense_account",
    "tax_account", "account_head", "round_off_account", "write_off_account", "discount_account",
    "exchange_gain_loss_account", "account", "advance_account", "receivable_account", "payable_account",
}
NATIVE_REFERENCES = {
    "sales_order": "Sales Order", "purchase_order": "Purchase Order", "against_sales_order": "Sales Order",
    "delivery_note": "Delivery Note", "purchase_receipt": "Purchase Receipt",
    "sales_invoice": "Sales Invoice", "purchase_invoice": "Purchase Invoice",
}
REFERENCE_TYPES = {"Sales Invoice", "Purchase Invoice", "Sales Order", "Purchase Order", "Payment Entry", "Delivery Note", "Purchase Receipt", "Journal Entry", "Bank Transaction", "Unreconcile Payment"}


def canonical_resource(value):
    return RESOURCE_ALIASES.get(value, value)


def canonical_action(value):
    return ACTION_ALIASES.get(value, value)


def validate_policy(value, role_scope="self"):
    """Validate administrator-supplied constraints without broadening grants."""
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - {"scope", "paymentLimit", "allowedBankAccounts"}:
        raise APIError(400, "INVALID_FINANCE_POLICY", "财务权限配置包含未知字段")
    selected = value.get("scope", role_scope)
    if selected not in SCOPES or role_scope not in SCOPES or SCOPES[selected] > SCOPES[role_scope]:
        raise APIError(400, "INVALID_FINANCE_SCOPE", "财务范围不能超出角色的数据范围")
    result = {"scope": selected}
    limit = value.get("paymentLimit")
    if limit is not None:
        if not isinstance(limit, dict) or set(limit) != {"amount", "currency"} or isinstance(limit["amount"], bool):
            raise APIError(400, "INVALID_PAYMENT_LIMIT", "收付款限额需要金额和币种")
        try:
            amount = Decimal(str(limit["amount"]))
        except (InvalidOperation, ValueError, TypeError):
            raise APIError(400, "INVALID_PAYMENT_LIMIT", "收付款限额金额无效") from None
        currency = limit.get("currency")
        if not amount.is_finite() or amount < 0 or amount > Decimal("1000000000000000") or not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
            raise APIError(400, "INVALID_PAYMENT_LIMIT", "收付款限额金额或币种无效")
        result["paymentLimit"] = {"amount": float(amount), "currency": currency}
    else:
        result["paymentLimit"] = None
    accounts = value.get("allowedBankAccounts")
    if accounts is not None:
        if not isinstance(accounts, list) or any(not isinstance(name, str) or not name.strip() or len(name) > 200 for name in accounts):
            raise APIError(400, "INVALID_BANK_ACCOUNT_GRANT", "可用银行账户必须是原生账户名称列表")
        result["allowedBankAccounts"] = list(dict.fromkeys(name.strip() for name in accounts))
    else:
        result["allowedBankAccounts"] = None
    return result


def _get(value, field, default=None):
    if hasattr(value, "get"):
        return value.get(field, default)
    return getattr(value, field, default)


def _rows(value):
    """Walk supplied/native children, never evaluate client flags as authority."""
    yield value
    if isinstance(value, dict):
        for child in value.values():
            if isinstance(child, list):
                for row in child:
                    if isinstance(row, dict):
                        yield from _rows(row)
    elif hasattr(value, "get_all_children"):
        yield from value.get_all_children()


class Policy:
    def __init__(self, cfg, actor, rules, payload=None):
        self.cfg, self.actor, self.rules = cfg, actor, rules
        self.payload = payload

    @property
    def scope(self):
        role = self.rules._policy(self.cfg, self.actor)
        configured = (role.get("financePolicy") or {}).get("scope", role.get("scope", "self"))
        # Malformed or formerly broader configs fail closed after scope changes.
        return configured if configured in SCOPES and SCOPES[configured] <= SCOPES.get(role.get("scope"), -1) else "self"

    def allowed(self, resource, action="read"):
        capability = f"finance.{canonical_resource(resource)}.{canonical_action(action)}"
        return self.actor.get("tenantId") == self.cfg.get("id") and capability in FINANCE_CAPABILITIES and self.rules.permitted(self.cfg, self.actor, capability)

    def companies(self):
        user = self.actor.get("nativeUser")
        if not user or user in ("Administrator", "Guest") or self.actor.get("tenantId") != self.cfg.get("id"):
            return {}
        # Absence of Company User Permissions never means unrestricted access.
        grants = {row.for_value for row in frappe.get_all("User Permission", filters={"user": user, "allow": "Company"}, fields=["for_value"])}
        result = {}
        for logical in self.rules.company_ids(self.cfg, self.actor):
            native = repo.native_company(logical)
            if native and native in grants:
                result[logical] = native
        return result

    def require(self, resource, action="read", company_id=None, tenant_scope=False):
        if not self.allowed(resource, action):
            raise APIError(403, "FINANCE_PERMISSION_DENIED", "当前角色没有此财务操作权限")
        if tenant_scope and self.scope != "tenant":
            raise APIError(403, "FINANCE_TENANT_SCOPE_REQUIRED", "公司财务报表和核销需要企业范围权限")
        if canonical_resource(resource) in ("bank_transaction", "bank_reconciliation"):
            if self.scope != "tenant" or not self.allowed("bank_accounts", "read"):
                raise APIError(403, "FINANCE_BANK_SCOPE_REQUIRED", "银行流水和对账需要企业范围及银行账户查看权限")
        if company_id is not None:
            company = self.companies().get(company_id)
            if not company:
                raise APIError(403, "FINANCE_COMPANY_DENIED", "当前账号没有此公司的原生财务授权")
            return company
        return None

    def require_company(self, company):
        if not company or company not in self.companies().values():
            raise APIError(403, "FINANCE_COMPANY_DENIED", "财务记录属于未授权公司")
        return company

    def _owned(self, doc, action):
        if self.scope == "tenant":
            return True
        user = self.actor.get("nativeUser")
        owner = _get(doc, "owner")
        if action == "create" and (not _get(doc, "name") or callable(getattr(doc, "is_new", None)) and doc.is_new()):
            return owner in (None, "", user)
        if owner == user:
            return True
        if self.scope == "team" and self.actor.get("teamId"):
            return any(profile.get("nativeUser") == owner and profile.get("teamId") == self.actor["teamId"] for profile in self.rules.ownership_profiles.values())
        return False

    def _order_ids(self, doc):
        # Not every native source has Tradept custom fields (for example,
        # Purchase Receipt). Read optional values from native documents, then
        # follow their standard item/voucher links back to the original order.
        # Never SELECT an assumed custom column from an unrelated DocType.
        ids, visited = set(), set()
        company = _get(doc, "company")
        def visit(current):
            identity = (_get(current, "doctype"), _get(current, "name") or id(current))
            if identity in visited:
                return
            if len(visited) >= 1000:
                raise APIError(400, "FINANCE_REFERENCE_LIMIT", "财务来源链过长，请管理员检查关联记录")
            visited.add(identity)
            if _get(current, "company") not in (None, "", company):
                raise APIError(403, "FINANCE_REFERENCE_COMPANY_DENIED", "原生来源链包含其他公司的单据")
            order_id = _get(current, "custom_tradept_order_id")
            if order_id:
                ids.add(order_id)
            references = set()
            for row in _rows(current):
                for field, kind in NATIVE_REFERENCES.items():
                    if _get(row, field):
                        references.add((kind, _get(row, field)))
                kind = _get(row, "reference_doctype") or _get(row, "reference_type") or _get(row, "payment_document")
                name = _get(row, "reference_name") or _get(row, "payment_entry")
                if kind in REFERENCE_TYPES and name:
                    references.add((kind, name))
            for field in ("return_against", "amended_from"):
                if _get(current, field) and _get(current, "doctype") in REFERENCE_TYPES:
                    references.add((_get(current, "doctype"), _get(current, field)))
            for kind, name in sorted(references):
                if not frappe.db.exists(kind, name):
                    raise APIError(404, "FINANCE_REFERENCE_NOT_FOUND", "原生来源链包含不存在的单据")
                visit(repo.get_doc(kind, name))
        visit(doc)
        return ids

    def _scope_allowed(self, doc, action):
        ids = self._order_ids(doc)
        if ids:
            payload = self.payload if self.payload is not None else repo.payload(native_projection=False)
            for order_id in ids:
                value = next((row for row in payload.get("orders", []) if row.get("id") == order_id and not row.get("deleted")), None)
                if not value or repo.native_company(value.get("companyId")) != _get(doc, "company") or not self._legacy_scope_allowed(value) or not self.rules.record_allowed(None, self.cfg, self.actor, value, "read", "orders", payload):
                    return False
            return True
        return self._owned(doc, action)

    def _legacy_scope_allowed(self, value):
        # A tenant-wide operational role may have a deliberately narrower
        # financial range. It must not borrow the role's broader order scope.
        if self.scope == "tenant":
            return True
        owners = {str(value[key]) for key in ("createdBy", "salespersonId", "ownerId") if value.get(key) is not None}.intersection(self.rules.ownership_profiles)
        if self.scope == "self":
            return self.actor.get("id") in owners
        return bool(self.actor.get("teamId") and any(self.rules.ownership_profiles[uid].get("teamId") == self.actor["teamId"] for uid in owners))

    def document_allowed(self, doc, action="read"):
        try:
            self.validate_document(doc, action)
            return True
        except APIError:
            return False

    def require_document(self, doc, action="read"):
        resource = DOCUMENT_RESOURCES.get(_get(doc, "doctype"))
        if not resource:
            raise APIError(400, "UNSUPPORTED_FINANCE_DOCUMENT", "不支持的财务单据")
        self.require(resource, action)
        self.require_company(_get(doc, "company"))
        if not self._scope_allowed(doc, action):
            raise APIError(403, "FINANCE_RECORD_DENIED", "财务单据超出本人、部门或订单授权范围")
        return _get(doc, "company")

    def require_reference(self, doctype, name, company, action="read"):
        self.require_company(company)
        if doctype not in REFERENCE_TYPES or not isinstance(name, str) or not name:
            raise APIError(400, "INVALID_FINANCE_REFERENCE", "财务引用类型或编号无效")
        if not frappe.db.exists(doctype, name):
            raise APIError(404, "FINANCE_REFERENCE_NOT_FOUND", "财务引用不存在")
        doc = repo.get_doc(doctype, name)
        if _get(doc, "company") != company:
            raise APIError(403, "FINANCE_REFERENCE_COMPANY_DENIED", "不能引用其他公司的单据")
        if doctype == "Unreconcile Payment":
            # This is an internal native operation receipt, never a public
            # document resource or a route to arbitrary accounting actions.
            self.validate_unreconcile(doc, company)
            return doc
        if doctype in DOCUMENT_RESOURCES:
            self.require_document(doc, action)
        else:
            if doctype == "Journal Entry":
                self.require("ledger", "read", tenant_scope=True)
            elif not self.rules.permitted(self.cfg, self.actor, "read", "orders"):
                raise APIError(403, "FINANCE_REFERENCE_DENIED", "订单及出入库来源需要原有订单查看权限")
            if not self._scope_allowed(doc, action):
                raise APIError(403, "FINANCE_REFERENCE_DENIED", "财务引用超出账号的记录范围")
        return doc

    def validate_unreconcile(self, doc, company, bound=None):
        self.require("reconciliation", "unreconcile", tenant_scope=True)
        self.require_company(company)
        if _get(doc, "company") != company or _get(doc, "voucher_type") != "Payment Entry":
            raise APIError(403, "FINANCE_UNRECONCILE_DENIED", "解除核销只能处理获授权公司的原生收付款单")
        payment_name = _get(doc, "voucher_no")
        authorized = None if bound is None else {(row["doctype"], row["name"]) for row in bound}
        if authorized is not None and ("Payment Entry", payment_name) not in authorized:
            raise APIError(403, "FINANCE_UNRECONCILE_DENIED", "解除核销的收付款单没有绑定授权")
        payment = self.require_reference("Payment Entry", payment_name, company)
        if _get(payment, "docstatus") != 1:
            raise APIError(409, "FINANCE_SUBMITTED_SOURCE_REQUIRED", "解除核销需要已提交的原生收付款单")
        allocations = _get(doc, "allocations", []) or []
        if not allocations:
            raise APIError(400, "FINANCE_UNRECONCILE_DENIED", "请选择当前收付款单的原生发票核销引用")
        for row in allocations:
            kind, name = _get(row, "reference_doctype"), _get(row, "reference_name")
            if kind not in ("Sales Invoice", "Purchase Invoice") or authorized is not None and (kind, name) not in authorized:
                raise APIError(403, "FINANCE_UNRECONCILE_DENIED", "解除核销不能涉及未绑定授权的账单")
            invoice = self.require_reference(kind, name, company)
            if _get(invoice, "docstatus") != 1:
                raise APIError(409, "FINANCE_SUBMITTED_SOURCE_REQUIRED", "解除核销需要已提交的原生账单")
            party_type = "Customer" if kind == "Sales Invoice" else "Supplier"
            party = _get(invoice, "customer" if kind == "Sales Invoice" else "supplier")
            if _get(row, "party_type") != party_type or _get(row, "party") != party or _get(payment, "party_type") != party_type or _get(payment, "party") != party:
                raise APIError(403, "FINANCE_UNRECONCILE_DENIED", "解除核销的往来方与原生单据不一致")
            self._account(_get(row, "account"), company)
        return company

    def _account(self, name, company):
        if not frappe.db.exists("Account", name) or frappe.db.get_value("Account", name, "company") != company:
            raise APIError(403, "FINANCE_ACCOUNT_COMPANY_DENIED", "会计科目必须属于所选公司")

    def _bank(self, name, company, usage=True):
        if not frappe.db.exists("Bank Account", name):
            raise APIError(404, "FINANCE_BANK_ACCOUNT_NOT_FOUND", "银行账户不存在")
        bank = frappe.db.get_value("Bank Account", name, ["company", "is_company_account", "party_type", "party", "account"], as_dict=True)
        if not bank or bank.get("company") != company or not bank.get("is_company_account"):
            raise APIError(403, "FINANCE_BANK_COMPANY_DENIED", "公司银行账户必须属于所选公司")
        if bank.get("account"):
            self._account(bank["account"], company)
        configured = (self.rules._policy(self.cfg, self.actor).get("financePolicy") or {}).get("allowedBankAccounts")
        if usage and configured is not None and name not in configured:
            raise APIError(403, "FINANCE_BANK_ACCOUNT_DENIED", "当前角色不能使用此银行账户")
        return bank

    def _party(self, doctype, name, company):
        if doctype not in ("Customer", "Supplier") or not frappe.db.exists(doctype, name):
            raise APIError(403, "FINANCE_PARTY_DENIED", "请使用有效的客户或供应商")
        assigned = frappe.db.get_value(doctype, name, "custom_tradept_company")
        shared = False
        if assigned != company:
            party = repo.get_doc(doctype, name)
            for row in _get(party, "accounts", []) or []:
                if _get(row, "company") != company or not _get(row, "account"):
                    continue
                account = _get(row, "account")
                self._account(account, company)
                expected = "Receivable" if doctype == "Customer" else "Payable"
                if frappe.db.get_value("Account", account, "account_type") != expected:
                    raise APIError(403, "FINANCE_PARTY_ACCOUNT_DENIED", "共享客户或供应商需要正确的应收应付科目")
                shared = True
            if not shared:
                raise APIError(403, "FINANCE_PARTY_COMPANY_DENIED", "客户或供应商未授权给所选公司")
        if assigned and assigned != company and not shared:
            raise APIError(403, "FINANCE_PARTY_COMPANY_DENIED", "客户或供应商属于其他公司")
        if self.scope != "tenant":
            collection = "customers" if doctype == "Customer" else "factories"
            record_id = frappe.db.get_value(doctype, name, "custom_tradept_record_id")
            payload = self.payload if self.payload is not None else repo.payload(native_projection=False)
            value = next((row for row in payload.get(collection, []) if row.get("id") == record_id and not row.get("deleted")), None)
            if value and shared:
                # The validated native Party Account grants this same master
                # to the selected entity; preserve its actual creator/team,
                # while checking a logical copy within the current company.
                value = {**value, "companyId": next((key for key, native in self.companies().items() if native == company), None)}
            if not value or not self.rules.record_allowed(None, self.cfg, self.actor, value, "read", collection, payload):
                raise APIError(403, "FINANCE_PARTY_DENIED", "客户或供应商超出当前账号的记录范围")

    def validate_document(self, doc, action="read"):
        company = self.require_document(doc, action)
        doctype = _get(doc, "doctype")
        writing = action not in ("read", "print", "export")
        for field, party_type in (("customer", "Customer"), ("supplier", "Supplier")):
            if _get(doc, field):
                self._party(party_type, _get(doc, field), company)
        if _get(doc, "party_type") or _get(doc, "party"):
            self._party(_get(doc, "party_type"), _get(doc, "party"), company)
        for row in _rows(doc):
            # Client-supplied controller flags are never part of the API schema.
            if isinstance(row, dict) and any(key in row for key in ("flags", "ignore_permissions", "ignore_validate", "ignore_links", "ignore_mandatory")):
                raise APIError(400, "UNSAFE_FINANCE_FLAGS", "不能传入原生控制器权限或校验开关")
            row_company = _get(row, "company")
            if row_company and row_company != company:
                raise APIError(403, "FINANCE_CHILD_COMPANY_DENIED", "单据明细不能属于其他公司")
            for field in ACCOUNT_FIELDS:
                if _get(row, field):
                    self._account(_get(row, field), company)
            for field, linked in (("cost_center", "Cost Center"), ("warehouse", "Warehouse"), ("set_warehouse", "Warehouse"), ("return_warehouse", "Warehouse")):
                if _get(row, field) and frappe.db.get_value(linked, _get(row, field), "company") != company:
                    raise APIError(403, "FINANCE_DIMENSION_COMPANY_DENIED", "财务成本中心或仓库必须属于所选公司")
            if _get(row, "taxes_and_charges"):
                template_type = "Sales Taxes and Charges Template" if doctype == "Sales Invoice" else "Purchase Taxes and Charges Template"
                if frappe.db.get_value(template_type, _get(row, "taxes_and_charges"), "company") != company:
                    raise APIError(403, "FINANCE_TAX_TEMPLATE_COMPANY_DENIED", "税费模板必须属于所选公司")
            if _get(row, "project"):
                project_company = frappe.db.get_value("Project", _get(row, "project"), "company")
                if project_company and project_company != company:
                    raise APIError(403, "FINANCE_PROJECT_COMPANY_DENIED", "项目不能属于其他公司")
            for field in ("bank_account", "company_bank_account"):
                if _get(row, field):
                    self._bank(_get(row, field), company, usage=writing)
            party_bank = _get(row, "party_bank_account")
            if party_bank:
                bank = frappe.db.get_value("Bank Account", party_bank, ["company", "is_company_account", "party_type", "party"], as_dict=True)
                party_type = _get(doc, "party_type") or ("Customer" if _get(doc, "customer") else "Supplier")
                party = _get(doc, "party") or _get(doc, "customer") or _get(doc, "supplier")
                if not bank or bank.get("is_company_account") or bank.get("party_type") != party_type or bank.get("party") != party or bank.get("company") not in (None, "", company):
                    raise APIError(403, "FINANCE_PARTY_BANK_DENIED", "对方银行账户必须属于本单据客户或供应商")
            for field, kind in NATIVE_REFERENCES.items():
                if _get(row, field):
                    self.require_reference(kind, _get(row, field), company)
            kind = _get(row, "reference_doctype") or _get(row, "reference_type")
            name = _get(row, "reference_name")
            if kind or name:
                referenced = self.require_reference(kind, name, company)
                if writing and _get(row, "reference_type") and doctype in ("Sales Invoice", "Purchase Invoice") and _get(row, "allocated_amount"):
                    # Native invoice advance allocation is a reconciliation;
                    # submitting an invoice cannot silently grant it.
                    self.require("reconciliation", "write", tenant_scope=True)
                    if kind == "Payment Entry":
                        self.require_payment(referenced)
            if _get(row, "payment_document") or _get(row, "payment_entry"):
                if _get(row, "payment_document") != "Payment Entry":
                    raise APIError(400, "FINANCE_BANK_VOUCHER_DENIED", "银行流水仅支持原生收付款单核销")
                self.require_reference("Payment Entry", _get(row, "payment_entry"), company)
            for field, child_type, parent_type in (("so_detail", "Sales Order Item", "Sales Order"), ("po_detail", "Purchase Order Item", "Purchase Order"), ("dn_detail", "Delivery Note Item", "Delivery Note"), ("pr_detail", "Purchase Receipt Item", "Purchase Receipt")):
                if _get(row, field):
                    parent = frappe.db.get_value(child_type, _get(row, field), "parent")
                    referenced = self.require_reference(parent_type, parent, company)
                    expected_parent = _get(row, "sales_order" if field == "so_detail" else "purchase_order" if field == "po_detail" else "delivery_note" if field == "dn_detail" else "purchase_receipt")
                    if expected_parent and expected_parent != _get(referenced, "name"):
                        raise APIError(403, "FINANCE_CHILD_REFERENCE_DENIED", "原生明细引用与父单据不一致")
            child_type, child_name = _get(row, "doctype"), _get(row, "name")
            if row is not doc and child_type and child_name and frappe.db.exists(child_type, child_name):
                parent = frappe.db.get_value(child_type, child_name, ["parent", "parenttype"], as_dict=True)
                if not parent or parent.get("parent") != _get(doc, "name") or parent.get("parenttype") != doctype:
                    raise APIError(403, "FINANCE_CHILD_PARENT_DENIED", "不能复用其他单据的明细记录")
        for field in ("return_against", "amended_from"):
            if _get(doc, field):
                self.require_reference(doctype, _get(doc, field), company)
        if doctype == "Payment Entry" and action not in ("read", "export", "print"):
            self.require_payment(doc)
        return company

    def require_payment(self, doc):
        company = self.require_company(_get(doc, "company"))
        configured = self.rules._policy(self.cfg, self.actor).get("financePolicy") or {}
        deductions = _get(doc, "deductions", []) or []
        for row in deductions:
            try:
                value = Decimal(str(_get(row, "amount", 0) or 0))
            except (InvalidOperation, ValueError, TypeError):
                raise APIError(400, "INVALID_FINANCE_PAYMENT_AMOUNT", "收付款扣款金额无效") from None
            if not value.is_finite():
                raise APIError(400, "INVALID_FINANCE_PAYMENT_AMOUNT", "收付款扣款金额无效")
            if value:
                self.require("payment_entry", "deductions")
        allowed = configured.get("allowedBankAccounts")
        # An allowlist cannot be bypassed by selecting its linked GL account
        # directly instead of supplying a Bank Account link.
        if allowed is not None:
            permitted_accounts = {self._bank(name, company).get("account") for name in allowed if frappe.db.get_value("Bank Account", name, "company") == company}
            payment_type = _get(doc, "payment_type")
            bank_fields = ("paid_to",) if payment_type == "Receive" else ("paid_from",) if payment_type == "Pay" else ("paid_from", "paid_to")
            for field in bank_fields:
                account = _get(doc, field)
                if not account or account not in permitted_accounts:
                    raise APIError(403, "FINANCE_BANK_ACCOUNT_DENIED", "付款会计科目必须来自获准银行账户")
        limit = configured.get("paymentLimit")
        if limit is not None:
            # Amounts are native controller amounts in the actual money-side
            # account currency. No client FX can convert around approval caps.
            checked = validate_policy({"paymentLimit": limit}, "tenant")["paymentLimit"]
            money_sides = (("received_amount", "paid_to"),) if _get(doc, "payment_type") == "Receive" else (("paid_amount", "paid_from"),) if _get(doc, "payment_type") == "Pay" else (("paid_amount", "paid_from"), ("received_amount", "paid_to"))
            for field, account_field in money_sides:
                currency = frappe.db.get_value("Account", _get(doc, account_field), "account_currency")
                try:
                    amount = Decimal(str(_get(doc, field)))
                except (InvalidOperation, ValueError, TypeError):
                    raise APIError(400, "INVALID_FINANCE_PAYMENT_AMOUNT", "原生收付款金额无效") from None
                if not amount.is_finite() or amount < 0:
                    raise APIError(400, "INVALID_FINANCE_PAYMENT_AMOUNT", "原生收付款金额无效")
                if currency != checked["currency"]:
                    raise APIError(403, "FINANCE_PAYMENT_LIMIT_CURRENCY", "收付款账户币种不符合当前审批限额币种")
                if amount > Decimal(str(checked["amount"])):
                    raise APIError(403, "FINANCE_PAYMENT_LIMIT_EXCEEDED", "收付款金额超出当前角色的单笔限额")
            # ERPNext may settle the gross party debt with a smaller bank
            # movement plus discount/write-off deductions. Approval caps must
            # cover that actual native allocation, not only net cash flow.
            gross = _get(doc, "total_allocated_amount")
            if gross not in (None, "") and _get(doc, "payment_type") in ("Receive", "Pay"):
                party_side = "paid_from" if _get(doc, "payment_type") == "Receive" else "paid_to"
                currency = frappe.db.get_value("Account", _get(doc, party_side), "account_currency")
                try:
                    gross_amount = Decimal(str(gross))
                except (InvalidOperation, ValueError, TypeError):
                    raise APIError(400, "INVALID_FINANCE_PAYMENT_AMOUNT", "原生核销金额无效") from None
                if not gross_amount.is_finite():
                    raise APIError(400, "INVALID_FINANCE_PAYMENT_AMOUNT", "原生核销金额无效")
                # A customer refund / supplier reimbursement allocates a
                # negative credit/debit-note balance. Approval limits apply
                # to its magnitude, while bank-side amounts remain positive.
                gross_amount = abs(gross_amount)
                if gross_amount and currency != checked["currency"]:
                    raise APIError(403, "FINANCE_PAYMENT_LIMIT_CURRENCY", "应收应付核销币种不符合当前审批限额币种")
                if gross_amount > Decimal(str(checked["amount"])):
                    raise APIError(403, "FINANCE_PAYMENT_LIMIT_EXCEEDED", "核销应收应付金额超出当前角色的单笔限额")
        return company

    def redact(self, value):
        if self.allowed("bank_accounts", "read"):
            return copy.deepcopy(value)
        def visible(current):
            if isinstance(current, dict):
                result = {}
                for key, child in current.items():
                    compact = re.sub(r"[^a-z0-9]", "", str(key).lower())
                    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key)).lower()
                    if compact in ("iban", "swift", "swiftnumber", "branchcode") or normalized in BANK_FIELDS or normalized.startswith(("bank_", "party_bank_", "company_bank_")):
                        continue
                    if normalized in ("account", "paid_from", "paid_to", "against_account") and isinstance(child, str) and frappe.db.get_value("Account", child, "account_type") == "Bank":
                        # GL labels can contain an account number as part of
                        # their user-defined name. A bank-info deny must also
                        # cover that indirect presentation in native reports.
                        continue
                    if normalized == "against" and isinstance(child, str):
                        continue
                    result[key] = visible(child)
                return result
            if isinstance(current, (list, tuple)):
                return [visible(child) for child in current]
            return copy.deepcopy(current)
        return visible(value)

