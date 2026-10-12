"""Deny direct native access for configured workbench accounts.

The facade applies record and financial-field grants before privileged ORM calls.
Site Administrator remains the trusted configuration/migration operator.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import frappe

from .domain import APIError

_native_grant = ContextVar("tradept_native_grant", default=None)
_missing = object()


def delegated_actor():
    grant = _native_grant.get()
    return grant["user"] if grant and frappe.session.user == "Administrator" else None


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
    return user not in ("Administrator", "Guest") and bool(frappe.db.exists("Trade User Profile", {"user": user}))


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
