"""Record ORM adapter. Every live record resides in this Frappe site's DB."""
from __future__ import annotations

import hashlib
import uuid
import frappe

from .domain import APIError, now
from .schema import COLLECTIONS, DOCTYPES, MAPS, FACTORY_LINE, ITEM_LINE, fields, field_name, encode, decode, child_encode, child_decode, loads, dumps

CONTACT = fields(data=("id", "name", "position", "email", "phone", "mobilePhone"), text=("homeAddress",))


def current_reads():
    return bool(getattr(frappe.flags, "tradept_snapshot_current", False))


def get_doc(doctype, name):
    return frappe.get_doc(doctype, name, for_update=True) if current_reads() else frappe.get_doc(doctype, name)


def get_value(doctype, name, field):
    return frappe.db.get_value(doctype, name, field, for_update=True) if current_reads() else frappe.db.get_value(doctype, name, field)


def workspace(lock=False):
    if lock:
        # Frappe's native for_update document load is a current read. Do not
        # establish an RR snapshot with exists()/get_doc() before this lock:
        # a waiter would otherwise observe the pre-commit revision afterward.
        try:
            doc = frappe.get_doc("Trade Workspace", "workspace", for_update=True)
        except frappe.DoesNotExistError:
            raise APIError(503, "WORKSPACE_NOT_CONFIGURED", "The isolated site requires an administrator configuration") from None
        return doc, loads(doc.configuration, {})
    if not frappe.db.exists("Trade Workspace", "workspace"):
        raise APIError(503, "WORKSPACE_NOT_CONFIGURED", "The isolated site requires an administrator configuration")
    doc = frappe.get_doc("Trade Workspace", "workspace")
    return doc, loads(doc.configuration, {})


def profiles():
    rows = frappe.get_all("Trade User Profile", fields=["user", "profile"])
    result = {}
    for row in rows:
        if frappe.db.get_value("User", row.user, "enabled"):
            value = loads(row.profile, {})
            result[value["id"]] = {**value, "nativeUser": row.user}
    return result


def native_company(company_id):
    return frappe.db.get_value("Company", {"custom_tradept_record_id": company_id}, "name")


def find(collection, record_id):
    for doctype in DOCTYPES[collection]:
        name = get_value(doctype, {field_name(doctype, "record_id"): str(record_id)}, "name")
        if name:
            return get_doc(doctype, name)
    return None


def _contact_decode(contact):
    proxy = {key: contact.get("custom_tradept_" + key) for key, _kind in CONTACT.values()}
    proxy.update({key: contact.get("custom_tradept_" + key) for key in ("presence_keys", "null_keys", "empty_keys", "extensions")})
    value = child_decode(proxy, CONTACT)
    # Native master fields are authoritative, including changes performed by a
    # trusted ERPNext Administrator. Source presence retains missing history.
    native_fields = {"name": "full_name", "position": "designation", "email": "email_id", "phone": "phone", "mobilePhone": "mobile_no"}
    null_keys = set(loads(contact.get("custom_tradept_null_keys"), []))
    baselines = loads(contact.get("custom_tradept_contact_baselines"), {})
    for key, field in native_fields.items():
        native = contact.get(field) or ""
        raw_field = {"email": "email", "phone": "phone", "mobilePhone": "mobile_phone"}.get(key)
        if (raw_field and native) or (key in value and key not in null_keys):
            raw = contact.get("custom_tradept_raw_" + raw_field) if raw_field else None
            value[key] = raw if raw is not None and key in baselines and native == baselines[key] else native
    return value


def record(doc, collection, native_projection=True):
    value = decode(doc, MAPS[collection], doc.doctype)
    present = set(loads(doc.get(field_name(doc.doctype, "presence_keys")), []))
    if collection in ("customers", "factories"):
        key, native_field = ("company", "customer_name") if collection == "customers" else ("name", "supplier_name")
        if key in present:
            baseline = doc.get("custom_tradept_master_name_baseline")
            native = doc.get(native_field)
            if baseline and native == baseline:
                value[key] = doc.get("custom_tradept_raw_master_name")
            elif native:
                value[key] = native
    if collection == "customers" and "contacts" in present:
        if current_reads():
            rows = frappe.db.sql("SELECT name FROM `tabContact` WHERE custom_tradept_parent_type='Customer' AND custom_tradept_parent=%s ORDER BY custom_tradept_index FOR UPDATE", (doc.name,), as_dict=True)
        else:
            rows = frappe.get_all("Contact", filters={"custom_tradept_parent_type": "Customer", "custom_tradept_parent": doc.name}, fields=["name"], order_by="custom_tradept_index asc")
        value["contacts"] = [_contact_decode(get_doc("Contact", row.name)) for row in rows]
    if collection == "orders":
        for key, table, mapping in (("factories", "factory_lines", FACTORY_LINE), ("erpItems", "item_lines", ITEM_LINE)):
            if key in present:
                value[key] = [child_decode(row, mapping) for row in doc.get(table, [])]
        if "factoryIds" in present:
            value["factoryIds"] = [row.factory_id for row in doc.get("factory_references", [])]
        if native_projection and doc.sales_order:
            from .native import project_order
            value = project_order(doc, value)
    if collection == "shipments" and native_projection:
        parent = find("orders", value.get("orderId"))
        if parent and parent.sales_order:
            from .native import shipping_projection
            departure = shipping_projection(get_doc("Sales Order", parent.sales_order), {"id": value["orderId"]})
            value["actualShipDate"] = departure.get("actualShipDate")
            value["status"] = value["shippingStatus"] = departure["shippingStatus"]
            value["deliveryProgressPct"] = departure["deliveryProgressPct"]
        if doc.delivery_note:
            delivery = get_doc("Delivery Note", doc.delivery_note)
            value["nativeDeliveryNote"] = {"name": delivery.name, "docstatus": delivery.docstatus}
    return value


def payload(native_projection=True):
    output = {collection: [] for collection in COLLECTIONS}
    for collection, doctypes in DOCTYPES.items():
        for doctype in doctypes:
            field = field_name(doctype, "record_id")
            if current_reads():
                rows = frappe.db.sql(f"SELECT name FROM `tab{doctype}` WHERE `{field}` IS NOT NULL AND `{field}` != '' ORDER BY creation,name FOR UPDATE", as_dict=True)
            else:
                rows = frappe.get_all(doctype, filters={field: ["is", "set"]}, fields=["name"], order_by="creation asc, name asc")
            for row in rows:
                output[collection].append(record(get_doc(doctype, row.name), collection, native_projection))
    return output


def contact_channels(contact, existing, historical=False):
    """Native validated channels plus immutable unresolved source provenance."""
    native, raw, baselines = {}, {}, {}
    for key, field in (("email", "email"), ("phone", "phone"), ("mobilePhone", "mobile_phone")):
        value = contact.get(key)
        raw_field = "custom_tradept_raw_" + field
        if value in (None, ""):
            native[key], raw[field] = "", None
            continue
        if key == "email":
            validated = frappe.utils.validate_email_address(value, throw=False)
        else:
            validated = value if frappe.utils.validate_phone_number(value, throw=False) else None
        same_historical_raw = existing.get(raw_field) == value and raw_field in existing.as_dict() if hasattr(existing, "as_dict") else existing.get(raw_field) == value
        if not validated:
            if not historical and not same_historical_raw:
                if key == "email":
                    frappe.utils.validate_email_address(value, throw=True)
                else:
                    frappe.utils.validate_phone_number(value, throw=True)
            native[key], raw[field], baselines[key] = "", value, ""
        else:
            native[key] = validated
            retain = (historical or same_historical_raw) and validated != value
            raw[field] = value if retain else None
            if retain:
                baselines[key] = validated
    return native, raw, baselines


def _save_contacts(parent, contacts, historical=False):
    existing = frappe.get_all("Contact", filters={"custom_tradept_parent_type": "Customer", "custom_tradept_parent": parent.name}, fields=["name"])
    names = set()
    for index, contact in enumerate(contacts):
        name = "TP-CON-" + hashlib.sha256((parent.name + ":" + str(contact.get("id", index))).encode()).hexdigest()[:32]
        doc = frappe.get_doc("Contact", name) if frappe.db.exists("Contact", name) else frappe.new_doc("Contact")
        doc.name = name
        doc.flags.name_set = True
        doc.first_name = contact.get("name") or parent.customer_name
        doc.designation = contact.get("position")
        encoded = child_encode(contact, CONTACT)
        for key, value in encoded.items():
            if key not in ("name", "position", "email", "phone", "mobile_phone"):
                doc.set("custom_tradept_" + key, value)
        doc.custom_tradept_parent_type, doc.custom_tradept_parent, doc.custom_tradept_index = "Customer", parent.name, index
        native, raw, baselines = contact_channels(contact, doc, historical)
        for key, value in raw.items():
            doc.set("custom_tradept_raw_" + key, value)
        doc.custom_tradept_contact_baselines = dumps(baselines)
        doc.set("links", [{"link_doctype": "Customer", "link_name": parent.name}])
        doc.set("email_ids", [{"email_id": native["email"], "is_primary": 1}] if native.get("email") else [])
        doc.set("phone_nos", [{"phone": native["phone"], "is_primary_phone": 1}] if native.get("phone") else [])
        if native.get("mobilePhone"):
            doc.append("phone_nos", {"phone": native["mobilePhone"], "is_primary_mobile_no": 1})
        doc.save(ignore_permissions=True)
        names.add(name)
    for row in existing:
        if row.name not in names:
            frappe.delete_doc("Contact", row.name, ignore_permissions=True)


def save_record(collection, value, legacy=False, historical_contacts=False):
    doc = find(collection, value["id"])
    if not doc and collection in ("customers", "factories"):
        # The previous isolated connector already created legitimate native
        # master records. Claim only its exact stable, tenant-bound external ID
        # rather than creating duplicate customers/suppliers by display name.
        doctype = DOCTYPES[collection][0]
        if frappe.get_meta(doctype).has_field("custom_trade_external_id"):
            external = "trade-" + hashlib.sha256(dumps([value["tenantId"], doctype, value["id"]]).encode()).hexdigest()
            name = frappe.db.get_value(doctype, {"custom_trade_external_id": external}, "name")
            if name:
                doc = frappe.get_doc(doctype, name)
    if not doc:
        doctype = "Trade Legacy Order" if collection == "orders" and legacy else DOCTYPES[collection][0]
        doc = frappe.new_doc(doctype)
        doc.name = "TP-" + uuid.uuid4().hex
    doc.update(encode(value, MAPS[collection], doc.doctype))
    company = native_company(value.get("companyId"))
    if collection in ("customers", "factories"):
        doc.custom_tradept_company = company
        key = "company" if collection == "customers" else "name"
        native_field = "customer_name" if collection == "customers" else "supplier_name"
        keep_source_name = historical_contacts or (doc.get("custom_tradept_master_name_baseline") and value.get(key) == doc.get("custom_tradept_raw_master_name"))
        if keep_source_name and key in value:
            doc.custom_tradept_raw_master_name = value[key]
        else:
            doc.custom_tradept_raw_master_name = None
            doc.custom_tradept_master_name_baseline = None
        if collection == "customers":
            doc.customer_name = value.get("company") or value.get("name") or "Historical customer " + value["id"]
            doc.customer_type, doc.customer_group, doc.territory = "Company", "Tradept Customers", "Tradept Territory"
        else:
            doc.supplier_name = value.get("name") or "Historical supplier " + value["id"]
            doc.supplier_group, doc.supplier_type = "Tradept Suppliers", "Company"
        if doc.meta.has_field("disabled"):
            doc.disabled = int(bool(value.get("deleted")))
    else:
        doc.company = company
    if collection == "orders":
        customer = find("customers", value.get("customerId")) if value.get("customerId") else None
        doc.customer = customer.name if customer else None
        doc.set("factory_lines", [child_encode(line, FACTORY_LINE) for line in value.get("factories", [])])
        doc.set("factory_references", [{"factory_id": str(rid)} for rid in value.get("factoryIds", [])])
        doc.set("item_lines", [child_encode(line, ITEM_LINE) for line in value.get("erpItems", [])])
        if legacy and not doc.sales_order:
            doc.historical_balance_basis = "Non-accounting imported balance"
    doc.save(ignore_permissions=True)
    if collection in ("customers", "factories") and keep_source_name and key in value:
        # Native sanitization remains enabled. A readonly provenance baseline
        # makes the imported source spelling lossless until a real master edit.
        frappe.db.set_value(doc.doctype, doc.name, "custom_tradept_master_name_baseline", doc.get(native_field), update_modified=False)
    if collection == "customers" and "contacts" in value:
        _save_contacts(doc, value["contacts"], historical_contacts)
    return doc


def rates():
    values, metas = {}, {}
    if current_reads():
        rows = frappe.db.sql("SELECT name,custom_tradept_record_id,exchange_rate,custom_tradept_metadata,custom_tradept_metadata_present FROM `tabCurrency Exchange` WHERE custom_tradept_record_id IS NOT NULL AND custom_tradept_record_id!='' ORDER BY creation FOR UPDATE", as_dict=True)
    else:
        rows = frappe.get_all("Currency Exchange", filters={"custom_tradept_record_id": ["is", "set"]}, fields=["name", "custom_tradept_record_id", "exchange_rate", "custom_tradept_metadata", "custom_tradept_metadata_present"], order_by="creation asc")
    for row in rows:
        values[row.custom_tradept_record_id] = row.exchange_rate
        if row.custom_tradept_metadata_present:
            metas[row.custom_tradept_record_id] = loads(row.custom_tradept_metadata, {})
    return values, metas


def save_rate(company_id, value, metadata=None, metadata_present=False, imported=False):
    company = native_company(company_id)
    if not company:
        raise APIError(400, "COMPANY_REQUIRED", "Exchange rate requires a configured legal entity")
    name = frappe.db.get_value("Currency Exchange", {"custom_tradept_record_id": company_id}, "name")
    doc = frappe.get_doc("Currency Exchange", name) if name else frappe.new_doc("Currency Exchange")
    # date is the effective current configuration date, not a fabricated past
    # transaction date; the unknown source time remains absent in metadata.
    doc.update({"date": frappe.utils.today(), "from_currency": "USD", "to_currency": "CNY", "exchange_rate": value, "for_buying": 1, "for_selling": 1, "custom_tradept_company": company, "custom_tradept_record_id": company_id, "custom_tradept_rate_origin": "Imported current rate" if imported else "Configured current rate"})
    if metadata_present:
        doc.custom_tradept_metadata, doc.custom_tradept_metadata_present = dumps(metadata), 1
        doc.custom_tradept_source_time = (metadata or {}).get("updateTime")
    elif imported:
        doc.custom_tradept_metadata, doc.custom_tradept_metadata_present, doc.custom_tradept_source_time = None, 0, None
    # ERPNext's default autoname omits Company. Explicit names retain separate
    # rates for legal entities that share a currency pair and effective date.
    if not name:
        doc.name = "TP-FX-" + hashlib.sha256(company_id.encode()).hexdigest()[:24]
        doc.flags.name_set = True
    doc.save(ignore_permissions=True)
    return doc


def meta(doc):
    return {"version": int(doc.revision or 0), "updatedAt": doc.updated_at_source, "updatedBy": doc.updated_by_id}


def snapshot(revision, actor_id, kind):
    previous = current_reads()
    frappe.flags.tradept_snapshot_current = True
    try:
        current, _cfg = workspace(lock=True)
        values, metas = rates()
        data = payload()
        record_types = {collection: {value["id"]: find(collection, value["id"]).doctype for value in records} for collection, records in data.items()}
        archive = {"data": data, "recordTypes": record_types, "exchangeRates": values, "rateMetas": metas, "meta": meta(current)}
        return frappe.get_doc({"doctype": "Trade Snapshot", "revision": revision, "actor_id": actor_id, "kind": kind, "created_at_source": now(), "archive": dumps(archive)}).insert(ignore_permissions=True).name
    finally:
        frappe.flags.tradept_snapshot_current = previous


def finish(work, actor, kind, summary):
    revision = int(work.revision or 0) + 1
    stamp = now()
    frappe.db.set_value("Trade Workspace", work.name, {"revision": revision, "updated_at_source": stamp, "updated_by_id": actor["id"]}, update_modified=False)
    sid = snapshot(revision, actor["id"], kind)
    frappe.get_doc({"doctype": "Trade Audit", "revision": revision, "actor_id": actor["id"], "kind": kind, "created_at_source": stamp, "summary": dumps(summary)}).insert(ignore_permissions=True)
    return {"ok": True, "meta": {"version": revision, "updatedAt": stamp, "updatedBy": actor["id"]}, "snapshotId": sid}
