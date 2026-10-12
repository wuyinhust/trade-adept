"""Scoped workbench API on one native session and one Frappe transaction."""
from __future__ import annotations

import copy
import json
import math
import uuid
import frappe

from .domain import APIError, Rules, safe_record_id, sensitive, now, FINANCIAL_INPUT, NESTED_COST
from .schema import COLLECTIONS, DOCTYPES, dumps, loads
from .validation import validate_order, validate_shipment, _date
from . import repository as repo
from . import native
from .events import managed
from .permissions import delegated_operation

READ_ACTIONS = {"session", "data", "meta", "snapshots", "backend_status", "context"}
WRITE_ACTIONS = {"changes", "restore", "convert_order", "submit_order", "receive_payment", "cancel_order"}
NATIVE_FIELDS = {"companyId", "customerId", "customerName", "customerOrderNo", "orderDate", "expectedShipDate", "actualShipDate", "shippingStatus", "factoryId", "factoryIds", "factoryName", "orderAmountUSD", "orderAmountRMB", "factoryCostRMB", "factoryCostUSD", "paidAmountUSD", "paymentStatus", "factoryPaidRMB", "factoryPaidStatus", "costPaidUSD", "costPaymentStatus", "erpItems"}
RECEIPT_FIELDS = {"paidAmountUSD", "paymentStatus", "factoryPaidRMB", "factoryPaidStatus", "costPaidUSD", "costPaymentStatus"}


def _identity(lock=False):
    if frappe.session.user == "Guest":
        raise APIError(401, "SESSION_REQUIRED", "Log in to the configured workspace")
    work, cfg = repo.workspace(lock)
    users = repo.profiles()
    actor = next((user for user in users.values() if user["nativeUser"] == frappe.session.user), None)
    if not actor:
        raise APIError(403, "WORKSPACE_ACCOUNT_REQUIRED", "A configured Tradept account is required on this isolated site")
    if actor.get("tenantId") != cfg["id"]:
        raise APIError(403, "TENANT_DENIED", "The account belongs to a different isolated site")
    native_roles = set(frappe.get_roles(frappe.session.user))
    assigned = [key for key in cfg["roles"] if "Tradept " + key.title() in native_roles]
    if len(assigned) != 1:
        raise APIError(403, "WORKSPACE_ROLE_REQUIRED", "Assign exactly one configured native Tradept role")
    actor = {**actor, "role": assigned[0]}
    permissions = frappe.get_all("User Permission", filters={"user": frappe.session.user, "allow": "Company"}, fields=["for_value"])
    actor["visibleCompanyIds"] = sorted({frappe.db.get_value("Company", row.for_value, "custom_tradept_record_id") for row in permissions} - {None, ""})
    if work.frozen and lock:
        raise APIError(503, "WORKSPACE_FROZEN", "This workspace is read-only during migration")
    return work, cfg, actor, Rules(cfg, users), users


def _session(cfg, actor, rules, users):
    company_ids = rules.company_ids(cfg, actor)
    policy = rules._policy(cfg, actor)
    user = {key: value for key, value in actor.items() if key != "nativeUser"}
    user.update(visibleCompanyIds=sorted(company_ids), permissions=policy.get("permissions", []), pages=policy.get("pages", []), scope=policy.get("scope", "self"), readScopes=policy.get("readScopes", {}), baseRole=policy.get("baseRole", actor["role"]))
    displayed = [{key: profile.get(key) for key in ("id", "name", "username", "role", "teamId", "visibleCompanyIds")} for profile in users.values()]
    teams = copy.deepcopy(cfg.get("teams", {}))
    if policy.get("scope") != "tenant":
        teams = {key: value for key, value in teams.items() if key == actor.get("teamId")}
        displayed = [value for value in displayed if value["id"] == actor["id"] or (actor.get("teamId") and value.get("teamId") == actor.get("teamId"))]
    return {"user": user, "users": displayed, "teams": teams, "companies": [company for company in cfg["companies"] if company["id"] in company_ids], "roles": cfg["roles"], "tenant": {"id": cfg["id"], "name": cfg.get("name", cfg["id"]), "branding": cfg.get("branding", {})}, "backend": "erpnext", "singleSystem": True}


def _data(work, cfg, actor, rules):
    all_records = repo.payload()
    result = {collection: [] for collection in COLLECTIONS}
    visible_orders = set()
    # Parent orders are filtered before their operational documents.
    for collection in ("orders", "customers", "factories", "shipments", "invoices"):
        for record in all_records[collection]:
            if record.get("deleted") or not rules.record_allowed(None, cfg, actor, record, collection=collection, payload=all_records):
                continue
            if collection in ("shipments", "invoices") and str(record.get("orderId")) not in visible_orders:
                continue
            visible = rules.visible_record(cfg, actor, record)
            if collection == "orders":
                doc = repo.find("orders", record["id"])
                visible["stage"] = native.stage(doc)
                visible["historicalReference"] = doc.doctype == "Trade Legacy Order" and not bool(doc.sales_order)
                # Native references themselves are finance metadata.
                if not rules.permitted(cfg, actor, "finance.read"):
                    visible.pop("nativeDocuments", None)
                visible_orders.add(str(record["id"]))
            result[collection].append(visible)
    ids = rules.company_ids(cfg, actor)
    rates, metas = repo.rates()
    return {"data": result, "exchangeRates": {key: value for key, value in rates.items() if key in ids}, "rateMetas": {key: value for key, value in metas.items() if key in ids}, "meta": repo.meta(work)}


def _expected(work, supplied):
    if type(supplied) is not int or supplied < 0:
        raise APIError(400, "EXPECTED_VERSION_REQUIRED", "expectedVersion must be a nonnegative integer")
    if supplied != int(work.revision or 0):
        raise APIError(409, "VERSION_CONFLICT", "Data changed; reload and review pending changes", latestVersion=int(work.revision or 0))


def _backend(cfg, actor, rules):
    if not rules.permitted(cfg, actor, "finance.read", "orders"):
        raise APIError(403, "FINANCE_DENIED", "Native documents require financial read permission")
    data = repo.payload()
    orders, documents = [], []
    for value in data["orders"]:
        if value.get("deleted") or not rules.record_allowed(None, cfg, actor, value, collection="orders", payload=data):
            continue
        doc = repo.find("orders", value["id"])
        refs = native.documents(value["id"]) if doc.sales_order else []
        orders.append({"orderId": value["id"], "stage": native.stage(doc), "historicalReference": doc.doctype == "Trade Legacy Order" and not bool(doc.sales_order), "salesOrder": doc.sales_order, "documents": refs})
        documents.extend(refs)
    return {"enabled": True, "backend": "erpnext", "singleSystem": True, "site": frappe.local.site, "jobs": [], "orders": orders, "documents": documents, "capabilities": {"convertOrder": True, "submitOrder": True, "receivePayment": True, "cancelOrder": True}}


def _native_factory_patch(old, patch):
    if "factories" not in patch:
        return
    rows = patch["factories"]
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise APIError(400, "INVALID_FACTORIES", "Factory production plans must be an array of records")
    originals = {row.get("factoryId"): row for row in old.get("factories", [])}
    ids = [row.get("factoryId") for row in rows]
    if any(not safe_record_id(rid) for rid in ids) or len(set(ids)) != len(ids) or set(ids) != set(originals):
        raise APIError(409, "NATIVE_SUPPLIERS_AUTHORITATIVE", "Native suppliers cannot be added, removed or reassigned through production planning")
    for row in rows:
        prior = originals[row["factoryId"]]
        for key, value in row.items():
            if key not in native.PLAN_FIELDS and value != prior.get(key):
                raise APIError(409, "NATIVE_PRODUCTION_AMOUNTS_AUTHORITATIVE", "Native quantities, supplier names, costs and actual prepayments are read-only")
        for key in ("inspectionDate", "estimatedShipDate"):
            if key in row and row[key] != prior.get(key):
                try:
                    _date(row, key, required=False)
                except ValueError as error:
                    raise APIError(400, "BUSINESS_VALIDATION", str(error)) from None
        if "productType" in row and row["productType"] is not None and not isinstance(row["productType"], str):
            raise APIError(400, "BUSINESS_VALIDATION", "Product classification must be text")
        effective = {**prior, **row}
        if effective.get("inspectionDate") and effective.get("estimatedShipDate") and effective["inspectionDate"] > effective["estimatedShipDate"]:
            raise APIError(400, "BUSINESS_VALIDATION", "Factory inspectionDate cannot follow estimatedShipDate")


def _changes(work, cfg, actor, rules, supplied):
    _expected(work, supplied.get("expectedVersion"))
    changes = supplied.get("changes")
    if not isinstance(changes, list) or len(changes) > 5000:
        raise APIError(400, "INVALID_CHANGES", "changes must be an array with at most 5000 operations")
    purpose = supplied.get("importPurpose")
    if purpose not in (None, "order-brief", "historical-reference"):
        raise APIError(400, "INVALID_IMPORT_PURPOSE", "Select a supported import purpose")
    historical = purpose == "historical-reference"
    if historical:
        if not rules.permitted(cfg, actor, "finance.write", "orders"):
            raise APIError(403, "FINANCE_DENIED", "Historical reference import requires financial permission")
        if supplied.get("exchangeRates") is not None or supplied.get("rateMetas") is not None or any(not isinstance(change, dict) or change.get("collection") != "orders" or change.get("deleted") for change in changes):
            raise APIError(400, "HISTORICAL_IMPORT_BATCH_REQUIRED", "Historical import accepts only order reference create/update operations")
    data = repo.payload()
    rates, metas = repo.rates()
    supplied_rates, supplied_metas = supplied.get("exchangeRates"), supplied.get("rateMetas")
    if supplied_rates is not None or supplied_metas is not None:
        if not rules.permitted(cfg, actor, "rates.write"):
            raise APIError(403, "RATE_DENIED", "Exchange rate configuration requires permission")
        ids = rules.company_ids(cfg, actor)
        for value in (supplied_rates, supplied_metas):
            if value is not None and (not isinstance(value, dict) or not set(value).issubset(ids)):
                raise APIError(403, "COMPANY_DENIED", "Rate configuration contains unauthorized legal entities")
        for key, value in (supplied_rates or {}).items():
            if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
                raise APIError(400, "INVALID_RATE", "Exchange rates must be finite and positive")
            rates[key] = value
        for key, value in (supplied_metas or {}).items():
            if not isinstance(value, dict):
                raise APIError(400, "INVALID_RATE_META", "Rate metadata must be an object")
            metas[key] = {name: child for name, child in value.items() if name in ("source", "updateTime", "isAuto", "note")}
        for key in set(supplied_rates or {}) | set(supplied_metas or {}):
            if key not in rates:
                raise APIError(400, "RATE_REQUIRED", "Metadata requires an existing current exchange rate")
            repo.save_rate(key, rates[key], metas.get(key), key in metas)
    writes = []
    for change in changes:
        if not isinstance(change, dict) or change.get("collection") not in COLLECTIONS:
            raise APIError(400, "INVALID_COLLECTION", "Unknown change collection")
        collection = change["collection"]
        rid = str(change.get("id") or uuid.uuid4())
        if not safe_record_id(rid):
            raise APIError(400, "INVALID_RECORD_ID", "Invalid record identifier")
        old = next((value for value in data[collection] if str(value["id"]) == rid), None)
        deleting = change.get("deleted") is True
        action = "delete" if deleting else "edit" if old else "create"
        if old:
            if not rules.record_allowed(None, cfg, actor, old, action, collection, data):
                raise APIError(403, "RECORD_DENIED", "The record operation is outside the account's scope")
            if old.get("deleted"):
                raise APIError(409, "RECORD_DELETED", "Restore a snapshot to recover a deleted record")
        elif deleting:
            raise APIError(404, "RECORD_NOT_FOUND", "Cannot delete a missing record")
        elif not rules.permitted(cfg, actor, "create", collection):
            raise APIError(403, "CREATE_DENIED", "Cannot create this record")
        doc = repo.find(collection, rid) if old else None
        if historical and doc and (doc.doctype != "Trade Legacy Order" or doc.sales_order):
            raise APIError(409, "HISTORICAL_STAGE_CONFLICT", "A brief or native order cannot become historical reference through Excel import")
        if not historical and collection == "orders" and (not doc or doc.doctype == "Trade Order Brief") and not (doc and doc.sales_order):
            patch = change.get("value", {})
            if isinstance(patch, dict):
                for key in RECEIPT_FIELDS:
                    if key in patch and patch[key] not in (None, 0, "", "未收款", "未付款"):
                        raise APIError(409, "NATIVE_RECEIPT_REQUIRED", "An order brief cannot fabricate receipts; submit native documents and record a Payment Entry")
                if any(float(line.get(key) or 0) > 0 for line in patch.get("factories", []) if isinstance(line, dict) for key in ("paidAmount", "prepayment")):
                    raise APIError(409, "NATIVE_RECEIPT_REQUIRED", "An order brief cannot record supplier payments before native purchase documents exist")
        if collection == "orders" and doc and doc.sales_order:
            if deleting:
                raise APIError(409, "NATIVE_CANCELLATION_REQUIRED", "Linked native orders require ERP cancellation, not a reference deletion")
            patch = change.get("value", {})
            if isinstance(patch, dict):
                _native_factory_patch(old, patch)
                native_status = frappe.db.get_value("Sales Order", doc.sales_order, "docstatus")
                for key in ("status", "orderStatus"):
                    if key in patch and ((patch[key] == "已取消" and native_status != 2) or (native_status == 2 and patch[key] != "已取消")):
                        raise APIError(409, "NATIVE_CANCELLATION_REQUIRED", "Native cancellation or amendment must use the standard document workflow")
            if isinstance(patch, dict) and any(key in patch and patch[key] != old.get(key) for key in NATIVE_FIELDS):
                raise APIError(409, "NATIVE_DOCUMENT_AUTHORITATIVE", "Native items, amounts and receipts are authoritative; use native document operations")
        if deleting:
            value = {**old, "deleted": True, "deletedAt": now(), "updatedAt": now(), "updatedBy": actor["id"]}
            if collection == "orders":
                for related in ("shipments", "invoices"):
                    for child in data[related]:
                        if str(child.get("orderId")) == rid:
                            child.update(deleted=True, deletedAt=value["deletedAt"], updatedBy=actor["id"])
                            writes.append((related, child))
        else:
            patch = change.get("value")
            if historical and old and isinstance(patch, dict):
                # Excel commonly repeats company/customer columns. An equal
                # field is not a legal-entity migration and must not turn a
                # retained historical cross-entity reference into a new link.
                patch = {key: value for key, value in patch.items() if old.get(key) != value}
            native_order = bool(collection == "orders" and doc and doc.sales_order)
            value = rules._prepare_patch(None, cfg, actor, collection, old, patch, historical=historical, native_order=native_order)
            value["id"] = rid
            for metadata in ("stage", "historicalReference", "nativeDocuments", "nativeDeliveryNote", "exchangeRateUsed"):
                value.pop(metadata, None)
            if collection == "orders" and old and value.get("companyId") != old.get("companyId") and any(str(child.get("orderId")) == rid for related in ("shipments", "invoices") for child in data[related]):
                raise APIError(409, "LEGAL_ENTITY_MIGRATION_REQUIRED", "Orders with document history require explicit legal entity migration")
            if not rules.record_allowed(None, cfg, actor, value, "read", collection, data):
                raise APIError(403, "ASSIGNMENT_DENIED", "Cannot save outside the account's scope")
            rules._validate_links(None, cfg, actor, data, collection, value, patch or {}, old is None, old)
            company = next((company for company in cfg["companies"] if company["id"] == value.get("companyId")), {})
            if collection == "shipments":
                parent = next((parent for parent in data["orders"] if str(parent.get("id")) == str(value.get("orderId"))), None)
                parent_doc = repo.find("orders", value.get("orderId")) if parent else None
                if parent_doc and parent_doc.sales_order:
                    if "actualShipDate" in (patch or {}) and (patch["actualShipDate"] or None) != parent.get("actualShipDate"):
                        raise APIError(409, "NATIVE_DEPARTURE_AUTHORITATIVE", "The actual departure date is read from submitted native Delivery Notes")
                    if value.get("status") in ("已出运", "已到港", "已签收") and parent.get("shippingStatus") == "待出运":
                        raise APIError(409, "NATIVE_DELIVERY_REQUIRED", "Record native delivery before its arrival or signature milestones")
                    value["actualShipDate"] = parent.get("actualShipDate")
            try:
                if collection == "orders":
                    if historical:
                        if type(value.get("orderAmountUSD")) not in (int, float) or not math.isfinite(value["orderAmountUSD"]) or value["orderAmountUSD"] <= 0:
                            raise ValueError("Historical reference requires a positive USD order amount")
                        for key in ("profitRMB", "profitUSD", "profitRate", "orderAmountRMB"):
                            if key in value and value[key] is not None and (type(value[key]) not in (int, float) or not math.isfinite(value[key])):
                                raise ValueError("Historical financial references must be finite numbers")
                        for key in ("factoryCostRMB", "factoryCostUSD", "freightCostUSD", "freightCostRMB", "insuranceCostUSD", "otherCostUSD", "otherCostRMB", "orderAmountRMB", "paidAmountUSD", "factoryPaidRMB", "costPaidUSD"):
                            if key in value and value[key] is not None and (type(value[key]) not in (int, float) or not math.isfinite(value[key]) or value[key] < 0):
                                raise ValueError("Historical amount fields must be finite and nonnegative")
                        for row in value.get("factories", []):
                            for key in NESTED_COST - {"paymentStatus", "costPaymentStatus"}:
                                if key in row and row[key] is not None and (type(row[key]) not in (int, float) or not math.isfinite(row[key]) or row[key] < 0):
                                    raise ValueError("Historical production amounts must be finite and nonnegative")
                        for key in ("orderDate", "expectedShipDate", "actualShipDate"):
                            if key in (patch or {}):
                                _date(value, key, required=False)
                    elif not native_order:
                        validate_order(value, change.get("value", {}), old is None, company)
                elif collection == "shipments":
                    validate_shipment(value, change.get("value", {}), old is None, company)
            except ValueError as error:
                raise APIError(400, "BUSINESS_VALIDATION", str(error)) from None
            if not historical and collection == "orders" and rules._financial_changed(old, value) and not (doc and doc.sales_order):
                rules._derive_order(cfg, value, rates)
            if collection in ("shipments", "invoices"):
                parent = next((parent for parent in data["orders"] if str(parent.get("id")) == str(value.get("orderId")) and not parent.get("deleted")), None)
                if not parent or parent.get("companyId") != value.get("companyId") or not rules.record_allowed(None, cfg, actor, parent, collection="orders", payload=data):
                    raise APIError(403, "RELATED_RECORD_DENIED", "The related order is inaccessible or belongs to another legal entity")
                if collection == "shipments" and any(child.get("id") != rid and not child.get("deleted") and child.get("orderId") == value.get("orderId") for child in data["shipments"]):
                    raise APIError(409, "SHIPMENT_EXISTS", "This order already has an active shipment")
        if old:
            data[collection][data[collection].index(old)] = value
        else:
            data[collection].append(value)
        writes.append((collection, value))
    rules._unique_order_numbers(data)
    for collection, value in writes:
        doc = repo.find(collection, value["id"])
        if collection == "orders" and doc and doc.sales_order:
            # Store only the extension values. Native projections remain reads,
            # never copied back as a parallel authoritative financial balance.
            for key in NATIVE_FIELDS - {"companyId", "customerId", "customerName"}:
                value.pop(key, None)
            for key in ("profitRMB", "profitUSD", "profitRate", "exchangeRateUsed", "deliveryProgressPct"):
                value.pop(key, None)
            value["factories"] = native.production_plan(value.get("factories", []))
        if collection == "shipments":
            parent_doc = repo.find("orders", value.get("orderId"))
            if parent_doc and parent_doc.sales_order:
                value.pop("actualShipDate", None)
                value.pop("deliveryProgressPct", None)
                value.pop("nativeDeliveryNote", None)
        repo.save_record(collection, value, legacy=historical and collection == "orders")
    return repo.finish(work, actor, "historical-import" if historical else "changes", [{"collection": value["collection"], "id": str(value.get("id", "new")), "deleted": value.get("deleted") is True} for value in changes])


def _restore(work, cfg, actor, rules, supplied):
    _expected(work, supplied.get("expectedVersion"))
    if not rules.permitted(cfg, actor, "snapshots.restore") or rules._policy(cfg, actor).get("scope") != "tenant" or rules.company_ids(cfg, actor) != {company["id"] for company in cfg["companies"]}:
        raise APIError(403, "RESTORE_DENIED", "Whole-workspace restore requires a fully granted administrator")
    if native.has_native_links():
        raise APIError(409, "NATIVE_RESTORE_REQUIRES_RECONCILIATION", "Native documents cannot be overwritten by reference snapshots; reconcile or amend them first")
    name = supplied.get("snapshotId")
    if not isinstance(name, str) or not frappe.db.exists("Trade Snapshot", name):
        raise APIError(404, "SNAPSHOT_NOT_FOUND", "Snapshot unavailable")
    archive = loads(frappe.get_doc("Trade Snapshot", name).archive, {})
    records = archive["data"]
    for collection in COLLECTIONS:
        restored_ids = {str(value["id"]) for value in records.get(collection, [])}
        for doctype in DOCTYPES[collection]:
            for row in frappe.get_all(doctype, filters={"record_id" if doctype.startswith("Trade ") else "custom_tradept_record_id": ["is", "set"]}, fields=["name"]):
                doc = frappe.get_doc(doctype, row.name)
                value = repo.record(doc, collection)
                if str(value["id"]) not in restored_ids:
                    value.update(deleted=True, deletedAt=now(), updatedBy=actor["id"])
                    repo.save_record(collection, value)
        for value in records.get(collection, []):
            if value.get("tenantId") not in (None, cfg["id"]):
                raise APIError(409, "RESTORE_CONFIG_CONFLICT", "Snapshot belongs to a different workspace")
            historical = archive.get("recordTypes", {}).get(collection, {}).get(value["id"]) == "Trade Legacy Order" or value.get("historicalReference", False)
            repo.save_record(collection, value, legacy=collection == "orders" and historical)
    for company_id, rate in archive.get("exchangeRates", {}).items():
        repo.save_rate(company_id, rate, archive.get("rateMetas", {}).get(company_id), company_id in archive.get("rateMetas", {}), imported=True)
    return repo.finish(work, actor, "restore", {"sourceSnapshotId": name, "sourceVersion": archive.get("meta", {}).get("version")})


def _native_operation(action, work, cfg, actor, rules, supplied):
    expected = supplied.get("expectedVersion")
    if type(expected) is not int or expected < 0:
        raise APIError(400, "EXPECTED_VERSION_REQUIRED", "expectedVersion must be a nonnegative integer")
    if not rules.permitted(cfg, actor, "finance.write", "orders"):
        raise APIError(403, "FINANCE_DENIED", "Native document operations require financial write permission")
    order_id = supplied.get("orderId")
    if not isinstance(order_id, str) or not safe_record_id(order_id):
        raise APIError(400, "INVALID_ORDER", "Select a saved order")
    data = repo.payload()
    value = next((value for value in data["orders"] if value["id"] == order_id and not value.get("deleted")), None)
    if not value or not rules.record_allowed(None, cfg, actor, value, "edit", "orders", data):
        raise APIError(403, "RECORD_DENIED", "Order unavailable in the account's scope")
    doc = repo.find("orders", order_id)
    operation = native.operation_key("payment" if action == "receive_payment" else "convert" if action == "convert_order" else "cancel" if action == "cancel_order" else "submit", order_id, supplied.get("idempotencyKey"))
    already_applied = False
    if action == "receive_payment" and frappe.db.exists("Payment Entry", {"custom_tradept_operation_key": operation}):
        # Recheck receipt fingerprint and current authorization before allowing
        # a lost-response retry to acknowledge an already posted operation.
        refs = native.receive_payment(doc, value, supplied)
        already_applied = True
    elif action == "convert_order" and doc.sales_order and frappe.db.get_value("Sales Order", doc.sales_order, "custom_tradept_operation_key") == operation:
        refs, already_applied = native.documents(order_id), True
    elif action == "submit_order" and doc.sales_order:
        rows = native.documents(order_id)
        order_rows = [row for row in rows if row["doctype"] in ("Sales Order", "Purchase Order")]
        if order_rows and all(row["docstatus"] == 1 for row in order_rows):
            refs, already_applied = rows, True
    elif action == "cancel_order" and doc.sales_order and frappe.db.get_value("Sales Order", doc.sales_order, "docstatus") == 2:
        refs, already_applied = native.documents(order_id), True
    if already_applied:
        return {"ok": True, "alreadyApplied": True, "meta": repo.meta(work), "orderId": order_id, "nativeDocuments": refs}
    _expected(work, expected)
    if action == "convert_order":
        rules._validate_links(None, cfg, actor, data, "orders", value, {"companyId": value.get("companyId"), "erpItems": value.get("erpItems")}, False, value)
    with delegated_operation(action, cfg, actor, rules, value, data, doc):
        if action == "convert_order":
            refs = native.convert(doc, value, cfg, supplied.get("idempotencyKey"))
        elif action == "submit_order":
            refs = native.submit(doc, value, supplied.get("idempotencyKey"))
        elif action == "cancel_order":
            refs = native.cancel(doc, value, supplied.get("idempotencyKey"))
        else:
            refs = native.receive_payment(doc, value, supplied)
    result = repo.finish(work, actor, action, {"orderId": order_id, "documents": refs})
    result.update(orderId=order_id, nativeDocuments=refs)
    return result


def _run_action(action, supplied):
    work, cfg, actor, rules, users = _identity(action in WRITE_ACTIONS)
    if action in ("session", "context"):
        result = _session(cfg, actor, rules, users)
        result["backendIdentity"] = frappe.local.site + ":" + work.instance_id
        result["backendInstanceId"] = work.instance_id
        if action == "context":
            result["meta"] = repo.meta(work)
        return result
    if action == "data":
        return _data(work, cfg, actor, rules)
    if action == "meta":
        return {"ok": True, "meta": repo.meta(work)}
    if action == "snapshots":
        if not rules.permitted(cfg, actor, "snapshots.read"):
            raise APIError(403, "SNAPSHOT_DENIED", "Snapshot access requires permission")
        rows = frappe.get_all("Trade Snapshot", fields=["name", "revision", "created_at_source", "actor_id", "kind"], order_by="revision desc", limit=200)
        return {"snapshots": [{"id": row.name, "version": row.revision, "createdAt": row.created_at_source, "createdBy": row.actor_id, "kind": row.kind} for row in rows]}
    if action == "backend_status":
        return _backend(cfg, actor, rules)
    if action == "changes":
        return _changes(work, cfg, actor, rules, supplied)
    if action == "restore":
        return _restore(work, cfg, actor, rules, supplied)
    return _native_operation(action, work, cfg, actor, rules, supplied)


def _run_transaction(action, supplied):
    # InnoDB aborts the victim's whole transaction on a deadlock. Restart the
    # whole action, never just its failed statement: authorization, current
    # revision and native idempotency must all be evaluated again. Rollback
    # also discards Frappe's deferred commit jobs from the aborted attempt.
    for attempt in range(3):
        try:
            return _run_action(action, copy.deepcopy(supplied))
        except frappe.QueryDeadlockError:
            frappe.db.rollback()
            frappe.flags.tradept_native_changes = None
            if action not in WRITE_ACTIONS or attempt == 2:
                raise APIError(503, "DATABASE_BUSY", "The database is busy; retry the unchanged operation") from None


@frappe.whitelist()
@managed
def dispatch(action, payload=None):
    """Frappe wraps this return value under message; the facade unwraps result."""
    try:
        if action not in READ_ACTIONS | WRITE_ACTIONS:
            raise APIError(404, "ACTION_NOT_FOUND", "Unknown workbench operation")
        method = getattr(getattr(frappe.local, "request", None), "method", None)
        if method and ((action in WRITE_ACTIONS and method != "POST") or (action in READ_ACTIONS and method not in ("GET", "POST"))):
            raise APIError(405, "METHOD_NOT_ALLOWED", "This operation requires the appropriate request method")
        supplied = loads(payload, {})
        if not isinstance(supplied, dict):
            raise APIError(400, "INVALID_PAYLOAD", "The request payload must be an object")
        result = _run_transaction(action, supplied)
    except APIError as error:
        if action in WRITE_ACTIONS:
            frappe.db.rollback()
        frappe.local.response["http_status_code"] = error.status
        result = error.response()
    except (ValueError, TypeError, json.JSONDecodeError):
        if action in WRITE_ACTIONS:
            frappe.db.rollback()
        frappe.local.response["http_status_code"] = 400
        result = {"error": "Invalid request value", "code": "INVALID_PAYLOAD"}
    except frappe.PermissionError:
        if action in WRITE_ACTIONS:
            frappe.db.rollback()
        frappe.local.response["http_status_code"] = 403
        result = {"error": "The native operation is outside this account's permissions", "code": "NATIVE_PERMISSION_DENIED"}
    except frappe.ValidationError as error:
        if action in WRITE_ACTIONS:
            frappe.db.rollback()
        frappe.local.response["http_status_code"] = 400
        result = {"error": frappe.utils.strip_html(str(error))[:500], "code": "NATIVE_VALIDATION"}
    return {"result": result, "csrfToken": frappe.sessions.get_csrf_token()}
