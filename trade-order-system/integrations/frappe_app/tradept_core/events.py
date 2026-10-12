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


def before_native_write(doc, method=None):
    from .permissions import delegated_actor
    actor = delegated_actor()
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


def after_native_write(doc, method=None):
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
