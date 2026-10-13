"""Administrator-only, hash-bound import into an independently isolated site.

The original Excel-era records are non-accounting history. No Item, receipt or
GL entry is invented. All imported rows use typed DocTypes/native master data.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path
import re
import uuid
import frappe

from .domain import APIError, DEFAULT_ROLES, now, validate_embedded_ids
from .schema import COLLECTIONS, dumps, loads
from .install import install
from . import repository as repo
from .events import managed


def _admin():
    if frappe.session.user != "Administrator":
        raise APIError(403, "ADMINISTRATOR_REQUIRED", "Use the isolated site's Administrator for configuration/import")


def _read(value):
    if isinstance(value, str):
        path = Path(value)
        if not path.is_absolute() or path.is_symlink():
            raise ValueError("Import paths must be absolute regular files")
        raw = path.read_bytes()
        return json.loads(raw), hashlib.sha256(raw).hexdigest()
    raw = dumps(value).encode()
    return copy.deepcopy(value), hashlib.sha256(raw).hexdigest()


def _leaf(doctype, name, key, parent_key, root):
    if not frappe.db.exists(doctype, name):
        frappe.get_doc({"doctype": doctype, key: name, parent_key: root, "is_group": 0}).insert(ignore_permissions=True)


def _company(value):
    existing = repo.native_company(value["id"])
    if not existing and value.get("nativeCompanyName") and frappe.db.exists("Company", value["nativeCompanyName"]):
        existing = value["nativeCompanyName"]
    if existing:
        company = frappe.get_doc("Company", existing)
        if company.custom_tradept_record_id not in (None, "", value["id"]):
            raise ValueError("Native company is already bound to a different stable ID")
        if company.default_currency != value.get("settlementCurrency", "USD"):
            raise ValueError("Existing native company's currency differs from reviewed configuration")
    else:
        country = {"CN": "China", "HK": "Hong Kong", "US": "United States"}.get(value.get("jurisdiction"), value.get("country", "United States"))
        abbr = re.sub(r"[^A-Z0-9]", "", str(value["id"]).upper())[:5] or hashlib.sha256(value["id"].encode()).hexdigest()[:5].upper()
        if frappe.db.exists("Company", {"abbr": abbr}):
            abbr += hashlib.sha256(value["id"].encode()).hexdigest()[:3].upper()
        company = frappe.get_doc({"doctype": "Company", "company_name": value.get("nativeCompanyName") or value["name"], "abbr": abbr, "default_currency": value.get("settlementCurrency", "USD"), "country": country, "create_chart_of_accounts_based_on": "Standard Template", "chart_of_accounts": "Standard"})
    company.custom_tradept_record_id = value["id"]
    company.custom_tradept_configuration = dumps(value)
    company.custom_tradept_profit_policy = value.get("profitPolicy")
    company.custom_tradept_settlement_currency = value.get("settlementCurrency")
    company.save(ignore_permissions=True)
    return company


def _validate_workspace_shape(cfg):
    companies = cfg.get("companies")
    onboarding_status = (cfg.get("onboarding") or {}).get("status")
    if not cfg.get("id") or not isinstance(companies, list):
        raise ValueError("Workspace configuration requires an ID and a legal entity array")
    if not companies and onboarding_status not in ("required", "in_progress"):
        raise ValueError("A completed workspace requires at least one legal entity")


@managed
def configure_workspace(configuration, credentials=None):
    _admin()
    content, _hash = _read(configuration)
    tenants = content.get("tenants", [content])
    if len(tenants) != 1:
        raise ValueError("Each Frappe site must contain exactly one Tradept tenant")
    cfg = copy.deepcopy(tenants[0])
    users = cfg.pop("users", [])
    _validate_workspace_shape(cfg)
    known = [company["id"] for company in cfg["companies"]]
    if len(set(known)) != len(known):
        raise ValueError("Duplicate legal entity ID")
    cfg["roles"] = {**copy.deepcopy(DEFAULT_ROLES), **{name: {**copy.deepcopy(DEFAULT_ROLES.get(policy.get("baseRole", name), {})), **policy} for name, policy in cfg.get("roles", {}).items()}}
    for policy in cfg["roles"].values():
        if policy.get("scope") not in ("self", "team", "tenant"):
            raise ValueError("Role scope must be self/team/tenant")
        if not isinstance(policy.get("pages", []), list):
            raise ValueError("Role pages must be an array")
        permissions = policy.get("permissions", [])
        if not ((isinstance(permissions, list) and all(isinstance(value, str) for value in permissions)) or (isinstance(permissions, dict) and all(isinstance(key, str) and isinstance(value, bool) for key, value in permissions.items()))):
            raise ValueError("Role permissions must be action names or an explicit boolean map")
        if policy.get("collections") is not None and (not isinstance(policy["collections"], list) or any(value not in COLLECTIONS for value in policy["collections"])):
            raise ValueError("Role collections must contain known collection names")
        scopes = policy.get("readScopes", {})
        if not isinstance(scopes, dict) or any(key not in COLLECTIONS or value not in ("self", "team", "entities", "tenant") for key, value in scopes.items()):
            raise ValueError("Invalid record read scopes")
    native_role_names = ["Tradept " + key.title() for key in cfg["roles"]]
    if len(set(native_role_names)) != len(native_role_names):
        raise ValueError("Configured role keys cannot map to duplicate native role names")
    install()
    for key in cfg["roles"]:
        role = "Tradept " + key.title()
        if not frappe.db.exists("Role", role):
            frappe.get_doc({"doctype": "Role", "role_name": role, "desk_access": 0}).insert(ignore_permissions=True)
    if not frappe.db.exists("Customer Group", "All Customer Groups"):
        from erpnext.setup.setup_wizard.operations import install_fixtures
        install_fixtures.install("United States")
    _leaf("Customer Group", "Tradept Customers", "customer_group_name", "parent_customer_group", "All Customer Groups")
    _leaf("Supplier Group", "Tradept Suppliers", "supplier_group_name", "parent_supplier_group", "All Supplier Groups")
    _leaf("Territory", "Tradept Territory", "territory_name", "parent_territory", "All Territories")
    if frappe.db.exists("Trade Workspace", "workspace"):
        work, old = repo.workspace(lock=True)
        if old["id"] != cfg["id"]:
            raise ValueError("Cannot change a site's tenant identity")
        work.configuration = dumps(cfg)
    else:
        work = frappe.get_doc({"doctype": "Trade Workspace", "name": "workspace", "__islocal": 1, "tenant_id": cfg["id"], "configuration": dumps(cfg), "revision": 0, "updated_at_source": now(), "updated_by_id": "configuration", "instance_id": uuid.uuid4().hex})
        work.flags.name_set = True
    if not work.instance_id:
        work.instance_id = uuid.uuid4().hex
    work.save(ignore_permissions=True)
    for company in cfg["companies"]:
        _company(company)
    creds = _read(credentials)[0] if credentials is not None else []
    passwords = {(value.get("tenantId"), value.get("id")): value.get("password") for value in creds}
    configured_users = set()
    for supplied in users:
        profile = copy.deepcopy(supplied)
        uid, username = str(profile["id"]), str(profile["username"]).strip()
        password = profile.pop("password", None) or passwords.get((cfg["id"], uid))
        profile.pop("passwordHash", None)
        if not username or profile.get("role") not in cfg["roles"]:
            raise ValueError("Configured accounts require usernames and valid roles")
        profile.update(id=uid, username=username, tenantId=cfg["id"])
        email = re.sub(r"[^a-zA-Z0-9_.-]", "-", uid).lower() + "@" + cfg["id"] + ".tradept.invalid"
        native = frappe.get_doc("User", email) if frappe.db.exists("User", email) else frappe.get_doc({"doctype": "User", "email": email, "first_name": profile.get("name") or username, "send_welcome_email": 0, "user_type": "Website User"})
        if not frappe.db.exists("User", email) and not password:
            raise ValueError("New native accounts require an explicitly configured private password")
        native.username, native.enabled = username, int(not bool(profile.pop("disabled", False)))
        native.first_name = profile.get("name") or username
        if password:
            if not isinstance(password, str) or len(password) < 12:
                raise ValueError("Configured passwords require at least 12 characters")
            native.new_password = password
        # Standard business roles are deliberately not duplicated. CustomAPI
        # permissions are explicit, and native REST is guarded independently.
        native.set("roles", [{"role": "Tradept " + profile["role"].title()}])
        native.save(ignore_permissions=True)
        configured_users.add(email)
        name = frappe.db.get_value("Trade User Profile", {"user": email}, "name")
        metadata = frappe.get_doc("Trade User Profile", name) if name else frappe.new_doc("Trade User Profile")
        metadata.update({"user": email, "record_id": uid, "profile": dumps(profile), "role_key": profile["role"], "team_id": profile.get("teamId")})
        metadata.save(ignore_permissions=True)
        grants = profile.get("visibleCompanyIds")
        if grants is None:
            grants = cfg.get("teams", {}).get(profile.get("teamId"), {}).get("visibleCompanyIds", [])
        frappe.db.delete("User Permission", {"user": email, "allow": "Company"})
        for company_id in set(grants).intersection(known):
            frappe.get_doc({"doctype": "User Permission", "user": email, "allow": "Company", "for_value": repo.native_company(company_id), "apply_to_all_doctypes": 1}).insert(ignore_permissions=True)
    for existing in frappe.get_all("Trade User Profile", fields=["user"]):
        if existing.user not in configured_users:
            frappe.db.set_value("User", existing.user, "enabled", 0)
    if frappe.get_meta("Website Settings").has_field("disable_signup"):
        frappe.db.set_single_value("Website Settings", "disable_signup", int(not bool(cfg.get("allowNativeSignup", False))))
    return cfg


@managed
def import_workspace(configuration, source, credentials=None, expected_import_hash=None, expected_version=0, source_snapshot_meta=None):
    _admin()
    supplied, source_hash = _read(source)
    if expected_import_hash is not None and source_hash != expected_import_hash:
        raise ValueError("Import SHA256 differs from the reviewed source")
    # Configuration and every record import form one transaction. Callers commit
    # only after the returned lossless verification succeeds (bench execute does).
    cfg = configure_workspace(configuration, credentials)
    work, _ = repo.workspace(lock=True)
    if work.import_hash == source_hash:
        return {"ok": True, "alreadyImported": True, "sourceHash": source_hash, "meta": repo.meta(work)}
    if type(expected_version) is not int or int(work.revision or 0) != expected_version:
        raise ValueError("Import requires the reviewed workspace version")
    if expected_version != 0 or any(repo.payload(native_projection=False).values()):
        raise ValueError("Initial import cannot replace an existing live workspace")
    data = supplied.get("data", supplied.get("payload", supplied))
    normalized = {}
    for collection in COLLECTIONS:
        records = data.get(collection, [])
        if not isinstance(records, list):
            raise ValueError("Import business collections must be arrays")
        seen, normalized[collection] = set(), []
        for original in records:
            if not isinstance(original, dict) or not original.get("id"):
                raise ValueError("Imported records require stable IDs")
            record = copy.deepcopy(original)
            record["id"] = str(record["id"])
            validate_embedded_ids(record)
            if record["id"] in seen:
                raise ValueError("Duplicate source record ID")
            seen.add(record["id"])
            if record.get("tenantId") not in (None, cfg["id"]):
                raise ValueError("Cannot import a record from another tenant")
            record["tenantId"] = cfg["id"]
            normalized[collection].append(record)
            # Missing historical creators remain missing. Soft deletion and
            # historical cross-company references stay intact and quarantined.
            repo.save_record(collection, record, legacy=collection == "orders", historical_contacts=True)
    rates = supplied.get("exchangeRates", {})
    metas = supplied.get("rateMetas", {})
    for company in cfg["companies"]:
        company_id = company["id"]
        rate = rates.get(company_id, company.get("exchangeRate"))
        if rate is not None:
            if type(rate) not in (float, int) or not math.isfinite(rate) or rate <= 0:
                raise ValueError("Imported current exchange rates must be positive")
            repo.save_rate(company_id, rate, metas.get(company_id), company_id in metas, imported=True)
    actual = repo.payload(native_projection=False)
    for collection in COLLECTIONS:
        original_rows = {value["id"]: value for value in normalized[collection]}
        actual_rows = {value["id"]: value for value in actual[collection]}
        if original_rows != actual_rows:
            differences = set()
            for rid in original_rows.keys() & actual_rows.keys():
                original, converted = original_rows[rid], actual_rows[rid]
                for key in original.keys() | converted.keys():
                    if original.get(key) != converted.get(key) or (key in original) != (key in converted):
                        differences.add(key + ":" + type(original.get(key)).__name__ + "->" + type(converted.get(key)).__name__)
            raise ValueError("Lossless import verification failed for " + collection + "; field types: " + ",".join(sorted(differences)) + "; missing count=" + str(len(original_rows.keys() - actual_rows.keys())) + "; added count=" + str(len(actual_rows.keys() - original_rows.keys())))
    source_meta = supplied.get("meta", {})
    source_version = source_meta.get("version", 1)
    revision = max(1, source_version) if type(source_version) is int else 1
    stamp = now()
    frappe.db.set_value("Trade Workspace", work.name, {"revision": revision, "updated_at_source": stamp, "updated_by_id": "migration", "import_hash": source_hash}, update_modified=False)
    counts = {collection: len(records) for collection, records in normalized.items()}
    receipt_meta = {"sourceMeta": source_meta, "sourceSnapshotMeta": source_snapshot_meta} if source_snapshot_meta is not None else source_meta
    frappe.get_doc({"doctype": "Trade Import Receipt", "source_hash": source_hash, "source_counts": dumps(counts), "source_meta": dumps(receipt_meta), "revision": revision, "created_at_source": stamp}).insert(ignore_permissions=True)
    sid = repo.snapshot(revision, "migration", "import")
    return {"ok": True, "sourceHash": source_hash, "counts": counts, "lossless": True, "meta": {"version": revision, "updatedAt": stamp, "updatedBy": "migration"}, "snapshotId": sid, "nativeLedgerDocumentsCreated": 0}


def export_workspace():
    _admin()
    work, cfg = repo.workspace()
    values, metas = repo.rates()
    return {"data": repo.payload(), "exchangeRates": values, "rateMetas": metas, "meta": repo.meta(work), "tenantId": cfg["id"]}


@managed
def attach_existing_native(order_id, sales_order, purchase_orders, delivery_notes=None, payment_entries=None, expected_version=None):
    """Bind independently verified connector fixtures without reposting them.

    This administrator-only migration is limited to exact existing native
    documents. Stable explicit line IDs or unambiguous reviewed item matches
    are required. DB metadata updates do not alter quantities, money, GL or
    stock entries. The new DTO then reflects the existing native paid balance.
    """
    from . import native
    from .schema import ORDER, FACTORY_LINE, field_name, child_encode
    _admin()
    work, cfg = repo.workspace(lock=True)
    if type(expected_version) is not int or int(work.revision or 0) != expected_version:
        raise ValueError("Attach requires the reviewed workspace revision")
    doc = repo.find("orders", order_id)
    if not doc:
        raise ValueError("Imported order reference is missing")
    if doc.sales_order:
        if doc.sales_order != sales_order:
            raise ValueError("Order is already linked to a different native sales order")
        return {"ok": True, "alreadyAttached": True, "meta": repo.meta(work), "documents": native.documents(order_id)}
    value = repo.record(doc, "orders", native_projection=False)
    sale = frappe.get_doc("Sales Order", sales_order)
    company = repo.native_company(value.get("companyId"))
    customer = repo.find("customers", value.get("customerId"))
    if sale.company != company or sale.currency != "USD" or not customer or sale.customer != customer.name or sale.docstatus != 1:
        raise ValueError("Existing sales order company/customer/status differs from reviewed source")
    if abs(float(sale.grand_total) - float(value.get("orderAmountUSD", -1))) > .005:
        raise ValueError("Existing sales order amount differs from source")
    purchase = [frappe.get_doc("Purchase Order", name) for name in purchase_orders]
    if not purchase or any(po.company != company or po.docstatus != 1 for po in purchase):
        raise ValueError("Existing purchase orders must be submitted in the same legal entity")
    source_lines = value.get("erpItems", [])
    if len(source_lines) != len(sale.items):
        raise ValueError("Source/native item lines differ")
    used_purchase_lines = set()
    for line in source_lines:
        sales_matches = [item for item in sale.items if (item.get("custom_trade_line_id") == line["id"] or item.get("custom_tradept_line_id") == line["id"])]
        if len(sales_matches) != 1:
            raise ValueError("Native sales item requires its exact stable source line ID")
        sales_item = sales_matches[0]
        if sales_item.item_code != line["itemCode"] or abs(float(sales_item.qty) - float(line["quantity"])) > .000001 or abs(float(sales_item.rate) - float(line["saleRate"])) > .000001:
            raise ValueError("Native sales line differs from reviewed explicit source")
        supplier = repo.find("factories", line["factoryId"])
        matches = [(po, item) for po in purchase if supplier and po.supplier == supplier.name for item in po.items if item.name not in used_purchase_lines and item.item_code == line["itemCode"] and abs(float(item.qty) - float(line["quantity"])) < .000001 and abs(float(item.rate) - float(line["purchaseRate"])) < .000001]
        if len(matches) != 1:
            raise ValueError("Native purchase line is ambiguous or differs from source")
        po, purchase_item = matches[0]
        used_purchase_lines.add(purchase_item.name)
        frappe.db.set_value("Sales Order Item", sales_item.name, {"custom_tradept_line_id": line["id"], "custom_tradept_supplier_id": line["factoryId"], "custom_tradept_purchase_rate": purchase_item.rate, "custom_tradept_purchase_currency": po.currency}, update_modified=False)
        frappe.db.set_value("Purchase Order Item", purchase_item.name, {"custom_tradept_line_id": line["id"]}, update_modified=False)
    if len(used_purchase_lines) != sum(len(po.items) for po in purchase):
        raise ValueError("Unreviewed purchase lines cannot be silently attached")
    refs = [("Sales Order", sale.name)] + [("Purchase Order", po.name) for po in purchase]
    for name in delivery_notes or []:
        delivery = frappe.get_doc("Delivery Note", name)
        if delivery.company != company or delivery.customer != customer.name or delivery.docstatus != 1 or not all(item.against_sales_order == sale.name for item in delivery.items):
            raise ValueError("Delivery Note is not exclusively bound to this sales order")
        refs.append(("Delivery Note", name))
    for name in payment_entries or []:
        payment = frappe.get_doc("Payment Entry", name)
        if payment.company != company or payment.party != customer.name or payment.docstatus != 1 or payment.payment_type != "Receive" or not payment.references or not all(row.reference_doctype == "Sales Order" and row.reference_name == sale.name for row in payment.references):
            raise ValueError("Payment Entry is not exclusively a receipt for this sales order")
        refs.append(("Payment Entry", name))
    for doctype, name in refs:
        if frappe.db.get_value(doctype, name, "custom_tradept_order_id") not in (None, "", order_id):
            raise ValueError("Native document is already bound to a different order")
        frappe.db.set_value(doctype, name, {"custom_tradept_order_id": order_id, "custom_tradept_operation_key": native.operation_key("attach", order_id, doctype + ":" + name)}, update_modified=False)
    doc.sales_order, doc.historical_balance_basis = sale.name, "Native ledger"
    for key in ("orderAmountUSD", "orderAmountRMB", "factoryCostRMB", "factoryCostUSD", "paidAmountUSD", "factoryPaidRMB", "costPaidUSD", "profitRMB", "profitUSD", "profitRate", "paymentStatus", "factoryPaidStatus", "costPaymentStatus"):
        doc.set(field_name(doc.doctype, ORDER[key][0]), None)
    doc.set("item_lines", [])
    doc.set("factory_lines", [child_encode(row, FACTORY_LINE) for row in native.production_plan(value.get("factories", []))])
    doc.save(ignore_permissions=True)
    for row in frappe.get_all("Trade Shipment", filters={"order_id": order_id}, fields=["name"]):
        if len(delivery_notes or []) == 1:
            frappe.db.set_value("Trade Shipment", row.name, "delivery_note", delivery_notes[0])
    result = repo.finish(work, {"id": "migration"}, "attach-native", {"orderId": order_id, "documents": refs})
    result.update(orderId=order_id, documents=native.documents(order_id), ledgerDocumentsCreated=0)
    return result
