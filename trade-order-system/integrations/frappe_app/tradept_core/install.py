"""Idempotent standard Frappe installation; no SQL business store is created."""
from __future__ import annotations

import json
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

from .schema import MAPS, ORDER, FACTORY_LINE, ITEM_LINE, fields, field_name


def _field(name, kind="Data", **kwargs):
    return {"fieldname": name, "label": name.replace("_", " ").title(), "fieldtype": kind, **kwargs}


def _metadata():
    return [_field("presence_keys", "Long Text", hidden=1), _field("null_keys", "Long Text", hidden=1), _field("empty_keys", "Long Text", hidden=1), _field("extensions", "Long Text", hidden=1)]


def _typed(mapping):
    return [_field(name, kind) for name, kind in dict(mapping.values()).items()]


def _doctype(name, fields, child=False):
    if frappe.db.exists("DocType", name):
        doc = frappe.get_doc("DocType", name)
        current = {row.fieldname for row in doc.fields}
        changed = False
        for definition in fields:
            if definition["fieldname"] not in current:
                doc.append("fields", definition)
                changed = True
        if changed:
            doc.save(ignore_permissions=True)
        return
    frappe.get_doc({
        "doctype": "DocType", "name": name, "module": "Tradept Core", "custom": 1,
        "istable": int(child), "track_changes": int(not child), "autoname": "hash",
        "fields": fields, "permissions": [] if child else [{"role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 1}],
    }).insert(ignore_permissions=True)


def install():
    if not frappe.db.exists("Module Def", "Tradept Core"):
        frappe.get_doc({"doctype": "Module Def", "module_name": "Tradept Core", "app_name": "tradept_core", "custom": 1}).insert(ignore_permissions=True)
    _doctype("Trade Factory Line", _typed(FACTORY_LINE) + _metadata(), child=True)
    _doctype("Trade Item Line", _typed(ITEM_LINE) + _metadata(), child=True)
    _doctype("Trade Factory Reference", [_field("factory_id")], child=True)
    _doctype("Trade Workspace", [
        _field("tenant_id", unique=1, reqd=1), _field("configuration", "Long Text", reqd=1),
        _field("revision", "Int"), _field("updated_at_source"), _field("updated_by_id"),
        _field("import_hash"), _field("frozen", "Check"),
        _field("instance_id", read_only=1),
    ])
    _doctype("Trade User Profile", [
        _field("user", "Link", options="User", unique=1, reqd=1), _field("record_id", unique=1, reqd=1),
        _field("profile", "Long Text", reqd=1), _field("role_key"), _field("team_id"),
    ])
    order_fields = _typed(ORDER) + _metadata() + [
        _field("company", "Link", options="Company"), _field("customer", "Link", options="Customer"),
        _field("factory_lines", "Table", options="Trade Factory Line"),
        _field("factory_references", "Table", options="Trade Factory Reference"),
        _field("item_lines", "Table", options="Trade Item Line"),
        _field("sales_order", "Link", options="Sales Order"),
        _field("historical_balance_basis", "Select", options="\nNon-accounting imported balance\nNative ledger"),
    ]
    for name in ("Trade Order Brief", "Trade Legacy Order"):
        _doctype(name, order_fields)
    _doctype("Trade Shipment", _typed(MAPS["shipments"]) + _metadata() + [
        _field("company", "Link", options="Company"), _field("delivery_note", "Link", options="Delivery Note"),
    ])
    # CI/PL are commercial documents; they are not fictitious Sales Invoices.
    _doctype("Trade Document", _typed(MAPS["invoices"]) + _metadata() + [_field("company", "Link", options="Company")])
    _doctype("Trade Snapshot", [_field("revision", "Int"), _field("created_at_source"), _field("actor_id"), _field("kind"), _field("archive", "Long Text", reqd=1)])
    _doctype("Trade Audit", [_field("revision", "Int"), _field("actor_id"), _field("created_at_source"), _field("kind"), _field("summary", "Long Text")])
    _doctype("Trade Import Receipt", [_field("source_hash", unique=1), _field("source_counts", "Long Text"), _field("source_meta", "Long Text"), _field("revision", "Int"), _field("created_at_source")])
    custom = {}
    for doctype, collection in (("Customer", "customers"), ("Supplier", "factories")):
        mapping = MAPS[collection]
        custom[doctype] = [
            _field(field_name(doctype, name), kind, read_only=1, unique=int(name == "record_id"), hidden=1)
            for name, kind in mapping.values() if field_name(doctype, name) != name
        ] + [_field(field_name(doctype, row["fieldname"]), row["fieldtype"], hidden=1, read_only=1) for row in _metadata()]
        custom[doctype].append(_field("custom_tradept_company", "Link", options="Company", read_only=1))
        custom[doctype] += [_field("custom_tradept_raw_master_name", "Long Text", read_only=1, hidden=1), _field("custom_tradept_master_name_baseline", "Data", read_only=1, hidden=1)]
    custom["Company"] = [
        _field("custom_tradept_record_id", unique=1, read_only=1), _field("custom_tradept_configuration", "Long Text", hidden=1, read_only=1),
        _field("custom_tradept_profit_policy", read_only=1), _field("custom_tradept_settlement_currency", "Link", options="Currency", read_only=1),
    ]
    contact_map = fields(data=("id", "name", "position", "email", "phone", "mobilePhone"), text=("homeAddress",))
    custom["Contact"] = [_field("custom_tradept_" + name, kind, hidden=1, read_only=1) for name, kind in contact_map.values() if name not in ("name", "position", "email", "phone", "mobile_phone")] + [
        _field("custom_tradept_parent_type", "Link", options="DocType", hidden=1),
        _field("custom_tradept_parent", "Dynamic Link", options="custom_tradept_parent_type", hidden=1),
        _field("custom_tradept_index", "Int", hidden=1),
    ] + [_field("custom_tradept_" + row["fieldname"], row["fieldtype"], hidden=1) for row in _metadata()]
    custom["Contact"] += [_field("custom_tradept_raw_" + key, "Long Text", hidden=1, read_only=1) for key in ("phone", "mobile_phone", "email")]
    custom["Contact"].append(_field("custom_tradept_contact_baselines", "Long Text", hidden=1, read_only=1))
    custom["Currency Exchange"] = [
        _field("custom_tradept_company", "Link", options="Company", read_only=1),
        _field("custom_tradept_record_id", read_only=1), _field("custom_tradept_metadata", "Long Text", hidden=1, read_only=1),
        _field("custom_tradept_metadata_present", "Check", hidden=1),
        _field("custom_tradept_source_time", "Data", hidden=1),
        _field("custom_tradept_rate_origin", "Select", options="\nImported current rate\nConfigured current rate", read_only=1),
    ]
    for doctype in ("Sales Order", "Purchase Order", "Payment Entry", "Delivery Note", "Sales Invoice", "Purchase Invoice"):
        custom[doctype] = [_field("custom_tradept_order_id", read_only=1), _field("custom_tradept_operation_key", unique=1, read_only=1)]
    custom["Sales Order Item"] = [_field("custom_tradept_line_id", read_only=1), _field("custom_tradept_supplier_id", read_only=1), _field("custom_tradept_purchase_rate", "Currency", read_only=1), _field("custom_tradept_purchase_currency", "Link", options="Currency", read_only=1)]
    custom["Purchase Order Item"] = [_field("custom_tradept_line_id", read_only=1)]
    create_custom_fields(custom, update=True)
    for key in ("admin", "finance", "manager", "salesperson", "document"):
        name = "Tradept " + key.title()
        if not frappe.db.exists("Role", name):
            frappe.get_doc({"doctype": "Role", "role_name": name, "desk_access": 0}).insert(ignore_permissions=True)
    # Accounts are provisioned by configuration; native public signup stays off.
    if frappe.get_meta("Website Settings").has_field("disable_signup"):
        native_signup = False
        if frappe.db.exists("Trade Workspace", "workspace"):
            configuration = json.loads(frappe.db.get_value("Trade Workspace", "workspace", "configuration") or "{}")
            native_signup = bool(configuration.get("allowNativeSignup", False))
        frappe.db.set_single_value("Website Settings", "disable_signup", int(not native_signup))
    if frappe.get_meta("System Settings").has_field("allow_login_using_user_name"):
        frappe.db.set_single_value("System Settings", "allow_login_using_user_name", 1)
    frappe.clear_cache()
