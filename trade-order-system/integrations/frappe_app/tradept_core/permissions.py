"""Deny direct native access for configured workbench accounts.

The facade applies record and financial-field grants before privileged ORM calls.
Site Administrator remains the trusted configuration/migration operator.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import frappe

from .domain import APIError, NATIVE_ROLE_PREFIX

_native_grant = ContextVar("tradept_native_grant", default=None)
_missing = object()


def delegated_actor():
    grant = _native_grant.get()
    return grant["user"] if grant and frappe.session.user == "Administrator" else None


def delegated_finance_grant():
    grant = _native_grant.get()
    return grant if grant and grant.get("finance") and frappe.session.user == "Administrator" else None


def delegated_catalog_grant():
    grant = _native_grant.get()
    return grant if grant and grant.get("catalog") and frappe.session.user == "Administrator" else None


@contextmanager
def delegated_catalog_operation(action, policy, document=None, company=None):
    """Authorize one Item lifecycle action while retaining native attribution."""
    from . import attribution
    user = frappe.session.user
    actor, cfg = policy.actor, policy.cfg
    if action not in {"read", "create", "write", "disable"} or _native_grant.get() is not None or user in ("Guest", "Administrator") or actor.get("nativeUser") != user or actor.get("tenantId") != cfg.get("id") or not is_workbench_user(user):
        raise APIError(403, "CATALOG_DELEGATION_DENIED", "商品操作需要当前企业的已配置原生账号")
    if document is None or document.get("doctype") != "Item":
        raise APIError(403, "CATALOG_DELEGATION_DENIED", "商品操作需要明确的原生商品目标")
    policy.require(action)
    policy.require_item(document, action, company=company)
    if action == "create" and not document.is_new() or action != "create" and document.is_new():
        raise APIError(403, "CATALOG_DELEGATION_DENIED", "商品操作与目标记录状态不一致")
    bound = [] if document.is_new() else [{"doctype": "Item", "name": document.name}]
    before = attribution.capture(bound) if action != "read" else None
    token = _native_grant.set({"user": user, "catalog": True, "action": action, "company": company, "document": document, "original_name": document.name if not document.is_new() else None, "item_company": document.get("custom_tradept_company"), "references": bound, "policy": policy})
    cache_defaults = {"cache": {}, "role_permissions": {}, "new_doc_templates": {}, "user_perms": None}
    original_caches = {key: getattr(frappe.local, key, _missing) for key in cache_defaults}
    try:
        frappe.session.user = "Administrator"
        for key, temporary in cache_defaults.items():
            setattr(frappe.local, key, temporary)
        yield bound
        if before is not None:
            target = {"doctype": "Item", "name": document.name}
            if target not in bound:
                bound.append(target)
            if any(reference.get("doctype") != "Item" or reference.get("name") != document.name for reference in bound):
                raise APIError(403, "CATALOG_UNBOUND_NATIVE_WRITE", "商品流程只能修改本次明确的商品目标")
            attribution.finish(before, bound, None, user)
    finally:
        try:
            frappe.session.user = user
            for key, original in original_caches.items():
                if original is _missing:
                    delattr(frappe.local, key)
                else:
                    setattr(frappe.local, key, original)
        finally:
            _native_grant.reset(token)


def bind_finance_reference(doctype, name):
    """Bind an existing source before native allocation mutates it.

    Mapping can discover invoice advances after delegation starts. Capture its
    actual parent/children/ledger metadata now, rather than misclassifying a
    historical voucher as a new record at the end of the operation.
    """
    grant = delegated_finance_grant()
    if not grant or grant["action"] in ("read", "print", "export") or grant.get("before") is None:
        raise APIError(403, "FINANCE_BIND_DENIED", "财务来源只能在获准写入流程内绑定")
    doc = grant["policy"].require_reference(doctype, name, grant["company"])
    reference = {"doctype": doctype, "name": name}
    if reference not in grant["references"]:
        from . import attribution
        for key, value in attribution.capture([reference]).items():
            grant["before"].setdefault(key, value)
        grant["references"].append(reference)
    return doc


@contextmanager
def delegated_finance_operation(resource, action, policy, document=None, references=None, company=None):
    """Delegate one exact, preauthorized native workflow, retaining the SID.

    The yielded reference list may be extended by trusted facade code as new
    documents are created. Client flags and old finance.write grants provide
    no authority here. All new parent, child and ledger rows retain the actor.
    """
    from .finance_permissions import canonical_action, canonical_resource, DOCUMENT_RESOURCES, REPORT_RESOURCES
    from . import attribution
    resource, action = canonical_resource(resource), canonical_action(action)
    user = frappe.session.user
    actor, cfg = policy.actor, policy.cfg
    if _native_grant.get() is not None or user in ("Guest", "Administrator") or actor.get("nativeUser") != user or actor.get("tenantId") != cfg.get("id") or not is_workbench_user(user):
        raise APIError(403, "FINANCE_DELEGATION_DENIED", "财务操作需要当前企业的已配置原生账号")
    policy.require(resource, action, tenant_scope=resource in REPORT_RESOURCES)
    if document is not None:
        if DOCUMENT_RESOURCES.get(document.get("doctype")) != resource:
            raise APIError(403, "FINANCE_DELEGATION_DENIED", "财务操作与目标单据类型不一致")
        target_company = policy.validate_document(document, action)
        if company and company != target_company:
            raise APIError(403, "FINANCE_COMPANY_DENIED", "财务操作公司与目标单据不一致")
        company = target_company
    company = policy.require_company(company)
    bound = list(references or [])
    for reference in bound:
        policy.require_reference(reference.get("doctype"), reference.get("name"), company)
    if document is not None and document.get("name") and not document.is_new():
        target = {"doctype": document.doctype, "name": document.name}
        if target not in bound:
            bound.append(target)
    before = attribution.capture(bound) if action not in ("read", "print", "export") else None
    token = _native_grant.set({"user": user, "company": company, "finance": True, "resource": resource, "action": action, "references": bound, "policy": policy, "before": before})
    cache_defaults = {"cache": {}, "role_permissions": {}, "new_doc_templates": {}, "user_perms": None}
    original_caches = {key: getattr(frappe.local, key, _missing) for key in cache_defaults}
    try:
        frappe.session.user = "Administrator"
        for key, temporary in cache_defaults.items():
            setattr(frappe.local, key, temporary)
        yield bound
        if before is not None:
            if document is not None and document.get("name"):
                target = {"doctype": document.doctype, "name": document.name}
                if target not in bound:
                    bound.append(target)
            attribution.finish(before, bound, None, user)
    finally:
        try:
            frappe.session.user = user
            for key, original in original_caches.items():
                if original is _missing:
                    delattr(frappe.local, key)
                else:
                    setattr(frappe.local, key, original)
        finally:
            _native_grant.reset(token)


@contextmanager
def delegated_finance_read(resource, policy, company):
    """Native report runners require an explicit company-wide read grant."""
    from .finance_permissions import canonical_resource, REPORT_RESOURCES
    if canonical_resource(resource) not in REPORT_RESOURCES:
        raise APIError(403, "FINANCE_DELEGATION_DENIED", "此报表不在授权列表")
    with delegated_finance_operation(resource, "read", policy, company=company):
        yield


@contextmanager
def delegated_email_configuration(cfg, actor, rules):
    """Allow native mailbox controller checks for an authorized tenant manager."""
    user = frappe.session.user
    if user in ("Guest", "Administrator") or actor.get("nativeUser") != user or actor.get("tenantId") != cfg.get("id") or not is_workbench_user(user):
        raise APIError(403, "EMAIL_DELEGATION_DENIED", "Mailbox configuration requires the current configured workspace account")
    if not rules.permitted(cfg, actor, "accounts.configure") or rules._policy(cfg, actor).get("scope") != "tenant":
        raise APIError(403, "EMAIL_DELEGATION_DENIED", "Mailbox configuration requires tenant management permission")
    token = _native_grant.set({"user": user, "action": "administrator:email"})
    cache_defaults = {"cache": {}, "role_permissions": {}, "new_doc_templates": {}, "user_perms": None}
    original_caches = {key: getattr(frappe.local, key, _missing) for key in cache_defaults}
    try:
        # Retain the authenticated session object, SID, CSRF state and form.
        frappe.session.user = "Administrator"
        for key, temporary in cache_defaults.items():
            setattr(frappe.local, key, temporary)
        yield
    finally:
        try:
            frappe.session.user = user
            for key, original in original_caches.items():
                if original is _missing:
                    delattr(frappe.local, key)
                else:
                    setattr(frappe.local, key, original)
        finally:
            _native_grant.reset(token)


@contextmanager
def delegated_operation(action, cfg, actor, rules, value, payload, doc):
    """Delegate one validated native workflow, retaining the real actor.

    Frappe controller permission hooks may only deny, and several ERPNext
    helpers perform their own role checks independently of the target doc's
    ignore_permissions flag. Use the native service identity only within this
    already-authorized operation; no client field or managed-write flag grants
    permission. The session identity is always restored before returning.
    """
    user = frappe.session.user
    if action not in {"convert_order", "submit_order", "receive_payment", "cancel_order"} or user in ("Guest", "Administrator") or actor.get("nativeUser") != user or actor.get("tenantId") != cfg.get("id") or not is_workbench_user(user):
        raise APIError(403, "NATIVE_DELEGATION_DENIED", "Native operations require the current configured workspace account")
    if not rules.permitted(cfg, actor, "finance.write", "orders") or not rules.record_allowed(None, cfg, actor, value, "edit", "orders", payload) or value.get("companyId") not in rules.company_ids(cfg, actor):
        raise APIError(403, "NATIVE_DELEGATION_DENIED", "The native workflow is outside the account's financial and company grants")
    from . import repository as repo
    from .native import documents
    company = repo.native_company(value.get("companyId"))
    if not company:
        raise APIError(403, "NATIVE_DELEGATION_DENIED", "The native company is unavailable")
    refs = documents(value["id"])
    if doc.sales_order and not any(row["doctype"] == "Sales Order" and row["name"] == doc.sales_order for row in refs):
        raise APIError(409, "NATIVE_REFERENCE_CONFLICT", "The linked sales order requires administrator reconciliation")
    if any(frappe.db.get_value(row["doctype"], row["name"], "company") != company for row in refs):
        raise APIError(409, "NATIVE_COMPANY_CONFLICT", "A native document belongs to a different legal entity")
    if action == "receive_payment":
        # The older Orders receipt button is another entry into the same
        # native Payment Entry product, not an exemption from its fine grants.
        from .finance_permissions import Policy
        policy = Policy(cfg, actor, rules, payload)
        policy.require("payment_entry", "create", value.get("companyId"))
        policy.require("payment_entry", "submit", value.get("companyId"))
        if not policy._legacy_scope_allowed(value):
            raise APIError(403, "FINANCE_RECORD_DENIED", "登记收款超出当前财务数据范围")
        if not doc.sales_order:
            raise APIError(409, "NATIVE_ORDER_REQUIRED", "登记收款需要原生销售订单")
        with delegated_finance_operation("payment_entry", "submit", policy, references=[{"doctype": "Sales Order", "name": doc.sales_order}], company=company):
            yield
        return
    from . import attribution
    before = attribution.capture(refs, doc)
    token = _native_grant.set({"user": user, "company": company, "orderId": value["id"], "action": action})
    cache_defaults = {"cache": {}, "role_permissions": {}, "new_doc_templates": {}, "user_perms": None}
    original_caches = {key: getattr(frappe.local, key, _missing) for key in cache_defaults}
    try:
        # Preserve the authenticated HTTP session, SID, CSRF data and form.
        # frappe.set_user() is a bench/task helper that resets those request
        # objects. Only the permission-check identity changes in this scope.
        frappe.session.user = "Administrator"
        for key, temporary in cache_defaults.items():
            setattr(frappe.local, key, temporary)
        yield
        attribution.finish(before, documents(value["id"]), doc, user)
    finally:
        try:
            frappe.session.user = user
            for key, original in original_caches.items():
                if original is _missing:
                    delattr(frappe.local, key)
                else:
                    setattr(frappe.local, key, original)
        finally:
            _native_grant.reset(token)


def is_workbench_user(user=None):
    user = user or frappe.session.user
    if user in ("Administrator", "Guest"):
        return False
    if frappe.db.exists("Trade User Profile", {"user": user}):
        return True
    # Deleting or incompletely migrating a profile must not turn an existing
    # Tradept role account into an unrestricted native ERP operator. Resolve
    # real server-side roles for the authenticated/native-token identity, not
    # browser-supplied roles or a User field in the HTTP form.
    return any(isinstance(role, str) and role.startswith(NATIVE_ROLE_PREFIX) for role in frappe.get_roles(user))


def restricted_user(user=None):
    user = user or frappe.session.user
    if user == "Administrator":
        return False
    if user == "Guest" or is_workbench_user(user):
        return True
    # Optional native registration creates an unprovisioned website account,
    # never an implicit tenant/ERP financial membership through portal roles.
    return frappe.db.get_value("User", user, "user_type") == "Website User"


def native_permission(doc=None, user=None, permission_type=None, **kwargs):
    if restricted_user(user):
        return False
    return None


def native_query(user=None):
    return "1=0" if restricted_user(user) else ""
