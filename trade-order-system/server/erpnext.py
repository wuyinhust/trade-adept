"""A one-way, durable ERPNext bridge. SQLite and ERPNext are separate commits.

Only trusted local configuration selects sites and credentials. Browser requests
select an authorized source order; they never select a URL, DocType or API key.
"""
from __future__ import annotations

import copy
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid

DOCTYPES = {"Customer", "Supplier", "Sales Order", "Purchase Order", "Delivery Note", "Payment Entry"}
EXTERNAL_FIELD = "custom_trade_external_id"


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class BridgeError(Exception):
    def __init__(self, code, message, blocked=False):
        super().__init__(message)
        self.code, self.blocked = code, blocked


def init_schema(db):
    db.executescript("""
      CREATE TABLE IF NOT EXISTS erp_outbox(
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, order_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL, actor_id TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT,
        error_message TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        UNIQUE(tenant_id,order_id,source_revision));
      CREATE TABLE IF NOT EXISTS erp_links(
        tenant_id TEXT NOT NULL, doctype TEXT NOT NULL, source_id TEXT NOT NULL,
        external_id TEXT NOT NULL, name TEXT NOT NULL, modified TEXT NOT NULL,
        managed_payload TEXT NOT NULL, docstatus INTEGER NOT NULL DEFAULT 0, order_id TEXT,
        PRIMARY KEY(tenant_id,doctype,source_id), UNIQUE(tenant_id,doctype,external_id));
    """)
    if "order_id" not in {row[1] for row in db.execute("PRAGMA table_info(erp_links)")}:
        db.execute("ALTER TABLE erp_links ADD COLUMN order_id TEXT")
        # Older mappings have no reliable order ownership; hide and block them
        # until an administrator reviews them instead of guessing ID prefixes.


def load_config(runtime):
    path = Path(runtime) / "erpnext.json"
    if not path.exists():
        return {"tenants": {}}
    if path.is_symlink() or (os.name != "nt" and path.stat().st_mode & 0o077):
        raise ValueError("ERPNext private configuration must be a regular 0600 file")
    config = json.loads(path.read_text())
    sites, origins = set(), set()
    for tid, tenant in config.get("tenants", {}).items():
        if not tenant.get("enabled"):
            continue
        parsed = urlsplit(tenant.get("baseUrl", ""))
        if not parsed.hostname:
            raise ValueError("ERPNext URL requires an explicit hostname")
        try:
            parsed.port
        except ValueError:
            raise ValueError("ERPNext URL has an invalid port") from None
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("ERPNext URL must be an origin without credentials or a path")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
            raise ValueError("ERPNext needs HTTPS or an isolated loopback URL")
        site = tenant.get("site")
        if not isinstance(site, str) or not site or any(c in site for c in "\r\n"):
            raise ValueError("An explicit ERPNext site is required")
        key = (tenant["baseUrl"].rstrip("/"), site)
        if key in sites or key[0] in origins:
            raise ValueError("Each Trade tenant requires its own ERP origin and Frappe site; the local proxy fixes the site header")
        sites.add(key)
        origins.add(key[0])
        if any(not isinstance(tenant.get(field), str) or not tenant[field] or any(c in tenant[field] for c in "\r\n") for field in ("apiKey", "apiSecret")):
            raise ValueError("Enabled ERPNext connection needs private API credentials")
    return config


def tenant_config(configuration, tenant_id):
    return (configuration or {}).get("tenants", {}).get(tenant_id, {})


def external_id(tenant_id, doctype, source_id):
    return "trade-" + hashlib.sha256(dumps([tenant_id, doctype, source_id]).encode()).hexdigest()


def amount(value, label, positive=False):
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise BridgeError("MISSING_ITEM_MAPPING", f"{label} must be an explicit number", True)
    if not number.is_finite() or number < 0 or (positive and number <= 0):
        raise BridgeError("MISSING_ITEM_MAPPING", f"{label} must be finite and {'positive' if positive else 'non-negative'}", True)
    return number


def prepare_order(tenant_id, order_id, payload, cfg):
    if not cfg.get("enabled"):
        raise BridgeError("NOT_CONNECTED", "ERPNext connection is not configured", True)
    orders = payload.get("orders", [])
    order = next((o for o in orders if o.get("id") == order_id and not o.get("deleted")), None)
    if not order:
        raise BridgeError("ORDER_UNAVAILABLE", "Source order no longer exists", True)
    company = cfg.get("companies", {}).get(order.get("companyId"))
    if not company or not company.get("name") or not company.get("currency"):
        raise BridgeError("MISSING_COMPANY_MAPPING", "Configure the legal entity and currency mapping first", True)
    category_roots = {"customerGroup": "All Customer Groups", "supplierGroup": "All Supplier Groups", "territory": "All Territories"}
    if any(not isinstance(company.get(field), str) or not company[field].strip() or company[field] == root for field, root in category_roots.items()):
        raise BridgeError("MASTER_DATA_MAPPING_REQUIRED", "Configure explicit leaf customer/supplier groups and territory before syncing master data", True)
    customer = next((c for c in payload.get("customers", []) if c.get("id") == order.get("customerId") and not c.get("deleted")), None)
    if not customer or not (customer.get("company") or customer.get("name")):
        raise BridgeError("MISSING_CUSTOMER", "Order needs an existing customer", True)
    delivery_date = order.get("expectedShipDate") or order.get("shippingDate") or order.get("deliveryDate")
    try:
        date.fromisoformat(delivery_date)
    except (ValueError, TypeError):
        raise BridgeError("MISSING_DELIVERY_DATE", "Set an explicit ISO delivery date", True)
    lines = order.get("erpItems")
    if not isinstance(lines, list) or not lines:
        raise BridgeError("MISSING_ITEM_MAPPING", "Add explicit ERP item codes, quantities and sales/purchase rates", True)
    factories, normalized, seen = {}, [], set()
    for i, line in enumerate(lines):
        if not isinstance(line, dict) or not line.get("id") or line["id"] in seen or not line.get("itemCode") or not line.get("factoryId"):
            raise BridgeError("MISSING_ITEM_MAPPING", "Each ERP line needs a unique id, item code and supplier", True)
        seen.add(line["id"])
        factory = next((f for f in payload.get("factories", []) if f.get("id") == line["factoryId"] and not f.get("deleted")), None)
        if not factory or not factory.get("name"):
            raise BridgeError("MISSING_SUPPLIER", "Each ERP line needs an existing supplier", True)
        factories[factory["id"]] = copy.deepcopy(factory)
        normalized.append({**line, "quantity": float(amount(line.get("quantity"), "Quantity", True)), "saleRate": float(amount(line.get("saleRate"), "Sales rate")), "purchaseRate": float(amount(line.get("purchaseRate"), "Purchase rate"))})
    sales_total = sum((amount(l["quantity"], "Quantity") * amount(l["saleRate"], "Sales rate") for l in normalized), Decimal(0))
    purchase_total = sum((amount(l["quantity"], "Quantity") * amount(l["purchaseRate"], "Purchase rate") for l in normalized), Decimal(0))
    # The historical app stores sales in USD and domestic supplier cost in CNY.
    if company["currency"] != "USD":
        raise BridgeError("CURRENCY_MAPPING_REQUIRED", "This bridge requires an explicit USD settlement entity; domestic FX conversion needs a reviewed mapping", True)
    if abs(sales_total - amount(order.get("orderAmountUSD"), "Order sales total")) > Decimal("0.005"):
        raise BridgeError("SALES_TOTAL_MISMATCH", "ERP item sales total differs from the saved order", True)
    expected_cost = order.get("factoryCostUSD")
    if expected_cost is None:
        if company.get("legacyPurchaseCostCurrency") != "USD":
            raise BridgeError("COST_CURRENCY_MAPPING_REQUIRED", "The historical cost field needs an explicit USD source-currency mapping; RMB costs are never converted or relabeled automatically", True)
        expected_cost = order.get("factoryCostRMB")
    if abs(purchase_total - amount(expected_cost, "Order purchase total")) > Decimal("0.005"):
        raise BridgeError("PURCHASE_TOTAL_MISMATCH", "ERP item purchase total differs from the saved order", True)
    return {"tenantId": tenant_id, "order": copy.deepcopy(order), "customer": copy.deepcopy(customer), "factories": factories, "lines": normalized, "company": copy.deepcopy(company)}


def public_job(row):
    return {"id": row["id"], "orderId": row["order_id"], "sourceVersion": row["source_revision"], "state": row["state"], "attempts": row["attempts"], "updatedAt": row["updated_at"], "errorCode": row["error_code"], "message": row["error_message"]}


def queue_order(db, tenant_id, actor_id, order_id, revision, payload, configuration=None):
    """Caller supplies an authorized source snapshot inside its SQLite transaction."""
    if not db.in_transaction:
        raise RuntimeError("ERP outbox must be queued in the source transaction")
    old = db.execute("SELECT * FROM erp_outbox WHERE tenant_id=? AND order_id=? AND source_revision=?", (tenant_id, order_id, revision)).fetchone()
    if old and old["state"] in ("running", "synced", "pending"):
        return public_job(old)
    state, code, message = "pending", None, None
    try:
        prepared = prepare_order(tenant_id, order_id, payload, tenant_config(configuration, tenant_id))
    except BridgeError as e:
        state, code, message, prepared = "blocked", e.code, str(e), {}
    stamp, job_id = now(), str(uuid.uuid4())
    if old:
        job_id = old["id"]
        db.execute("UPDATE erp_outbox SET actor_id=?,payload=?,state=?,updated_at=?,error_code=?,error_message=? WHERE id=?", (actor_id, dumps(prepared), state, stamp, code, message, job_id))
    else:
        db.execute("INSERT INTO erp_outbox(id,tenant_id,order_id,source_revision,actor_id,payload,state,created_at,updated_at,error_code,error_message) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (job_id, tenant_id, order_id, revision, actor_id, dumps(prepared), state, stamp, stamp, code, message))
    return public_job(db.execute("SELECT * FROM erp_outbox WHERE id=?", (job_id,)).fetchone())


def has_jobs(db, tenant_id):
    return db.execute("SELECT 1 FROM erp_outbox WHERE tenant_id=? LIMIT 1", (tenant_id,)).fetchone() is not None or db.execute("SELECT 1 FROM erp_links WHERE tenant_id=? LIMIT 1", (tenant_id,)).fetchone() is not None


def status(db, tenant_id, visible_order_ids, configuration=None):
    cfg = tenant_config(configuration, tenant_id)
    ids = set(visible_order_ids)
    rows = db.execute("SELECT * FROM erp_outbox WHERE tenant_id=? ORDER BY created_at DESC", (tenant_id,)).fetchall()
    links = db.execute("SELECT doctype,source_id,order_id,name,docstatus FROM erp_links WHERE tenant_id=?", (tenant_id,)).fetchall()
    return {"enabled": bool(cfg.get("enabled")), "site": cfg.get("site") if cfg.get("enabled") else None, "jobs": [public_job(r) for r in rows if r["order_id"] in ids], "documents": [{"doctype": r["doctype"], "sourceId": r["source_id"], "orderId": r["order_id"], "name": r["name"], "docstatus": r["docstatus"]} for r in links if r["order_id"] in ids]}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class FrappeClient:
    def __init__(self, cfg):
        self.cfg = cfg

    def request(self, method, path, payload=None, query=None):
        url = self.cfg["baseUrl"].rstrip("/") + path
        if query:
            url += "?" + urlencode(query)
        headers = {"Authorization": "token " + self.cfg["apiKey"] + ":" + self.cfg["apiSecret"], "Content-Type": "application/json", "X-Frappe-Site-Name": self.cfg["site"]}
        body = dumps(payload).encode() if payload is not None else None
        try:
            # Never forward API credentials across an HTTP redirect.
            handlers = [NoRedirect()]
            if urlsplit(self.cfg["baseUrl"]).hostname in ("127.0.0.1", "localhost", "::1"):
                # Loopback API credentials must not traverse a global proxy.
                handlers.append(ProxyHandler({}))
            with build_opener(*handlers).open(Request(url, data=body, headers=headers, method=method), timeout=30) as response:
                result = json.load(response)
                return result.get("data", result.get("message", result))
        except HTTPError as e:
            # Do not echo ERP server traceback or response bodies into logs/UI.
            e.close()
            if e.code == 409:
                raise BridgeError("ERP_MODIFIED", "ERP document changed; review it before retrying", True) from None
            raise BridgeError("ERP_HTTP_" + str(e.code), "ERPNext rejected the request; inspect the isolated ERP administrator console", e.code in (400, 401, 403, 404, 417)) from None
        except (URLError, TimeoutError, OSError):
            raise BridgeError("ERP_UNAVAILABLE", "ERPNext is unavailable; a retry will reuse stable external IDs") from None

    def resource(self, doctype, name=None):
        if doctype not in DOCTYPES:
            raise ValueError("Unsupported ERPNext DocType")
        return "/api/resource/" + quote(doctype, safe="") + ("/" + quote(name, safe="") if name else "")

    def find(self, doctype, eid):
        rows = self.request("GET", self.resource(doctype), query={"filters": dumps([[EXTERNAL_FIELD, "=", eid]]), "fields": dumps(["name"]), "limit_page_length": 2})
        if len(rows) > 1:
            raise BridgeError("EXTERNAL_ID_DUPLICATE", "ERP contains duplicate external IDs", True)
        return self.get(doctype, rows[0]["name"]) if rows else None

    def get(self, doctype, name):
        return self.request("GET", self.resource(doctype, name))

    def create(self, doctype, payload):
        return self.request("POST", self.resource(doctype), payload)

    def update(self, doctype, name, payload):
        return self.request("PUT", self.resource(doctype, name), payload)


def _managed_values(doc, template):
    """Compare only managed fields; ERP adds taxes, names and calculations."""
    if isinstance(template, dict):
        return {k: _managed_values(doc.get(k), v) for k, v in template.items() if k not in ("modified",)}
    if isinstance(template, list):
        if not isinstance(doc, list) or len(doc) != len(template):
            return doc
        return [_managed_values(d, t) for d, t in zip(doc, template)]
    if isinstance(template, (float, int)) and not isinstance(template, bool):
        try:
            return float(doc)
        except (TypeError, ValueError):
            return doc
    return doc


def upsert(store, client, tenant_id, doctype, source_id, values, order_id=None):
    if doctype in ("Sales Order", "Purchase Order", "Delivery Note", "Payment Entry") and (not isinstance(order_id, str) or not order_id):
        raise BridgeError("ERP_ORDER_LINK_REQUIRED", "Transactional ERP documents require an explicit source order", True)
    eid = external_id(tenant_id, doctype, source_id)
    values = {**values, EXTERNAL_FIELD: eid}
    with store.connect() as db:
        link = db.execute("SELECT * FROM erp_links WHERE tenant_id=? AND doctype=? AND source_id=?", (tenant_id, doctype, source_id)).fetchone()
    if link:
        if link["order_id"] != order_id:
            raise BridgeError("ERP_SOURCE_COLLISION", "ERP source ID ownership differs; review the existing mapping", True)
        doc = client.get(doctype, link["name"])
        if doc.get("modified") != link["modified"]:
            raise BridgeError("ERP_MODIFIED", "ERP document was changed outside this bridge; review before resynchronizing", True)
        if dumps(_managed_values(doc, values)) != dumps(_managed_values(values, values)):
            if int(doc.get("docstatus", 0)) != 0:
                raise BridgeError("ERP_SUBMITTED", "Submitted ERP documents require an explicit cancel/amend workflow", True)
            update_values = copy.deepcopy(values)
            if doctype == "Sales Order":
                old_items = {i.get("custom_trade_line_id"): i for i in doc.get("items", [])}
                old_ids = set(old_items)
                new_ids = {i["custom_trade_line_id"] for i in update_values.get("items", [])}
                with store.connect() as db:
                    has_purchase = db.execute("SELECT 1 FROM erp_links WHERE tenant_id=? AND doctype='Purchase Order' AND order_id=? LIMIT 1", (tenant_id, order_id)).fetchone()
                if old_ids != new_ids and has_purchase:
                    raise BridgeError("ERP_LINE_LINKED", "Linked ERP order lines require an explicit cancel/amend workflow before adding or removing lines", True)
                for item in update_values.get("items", []):
                    old_item = old_items.get(item["custom_trade_line_id"])
                    if old_item:
                        item["name"] = old_item["name"]
            doc = client.update(doctype, doc["name"], {**update_values, "modified": link["modified"]})
    else:
        doc = client.find(doctype, eid)
        if doc:
            if dumps(_managed_values(doc, values)) != dumps(_managed_values(values, values)):
                raise BridgeError("ERP_RECOVERY_MISMATCH", "External ID exists with different source values; review before recovery", True)
        else:
            doc = client.create(doctype, values)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT INTO erp_links(tenant_id,doctype,source_id,external_id,name,modified,managed_payload,docstatus,order_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,doctype,source_id) DO UPDATE SET name=excluded.name,modified=excluded.modified,managed_payload=excluded.managed_payload,docstatus=excluded.docstatus,order_id=excluded.order_id", (tenant_id, doctype, source_id, eid, doc["name"], doc["modified"], dumps(values), int(doc.get("docstatus", 0)), order_id))
        db.execute("COMMIT")
    return doc


def guard_supplier_ownership(store, client, prepared):
    tid, oid = prepared["tenantId"], prepared["order"]["id"]
    prefix = oid + "::"
    with store.connect() as db:
        sales_link = db.execute("SELECT * FROM erp_links WHERE tenant_id=? AND doctype='Sales Order' AND source_id=?", (tid, oid)).fetchone()
        purchase_links = db.execute("SELECT * FROM erp_links WHERE tenant_id=? AND doctype='Purchase Order' AND order_id=?", (tid, oid)).fetchall()
    if not purchase_links:
        return
    if not sales_link:
        raise BridgeError("ERP_LINK_INCOMPLETE", "Existing purchase documents require their original sales mapping", True)
    sales = client.get("Sales Order", sales_link["name"])
    if sales.get("modified") != sales_link["modified"]:
        raise BridgeError("ERP_MODIFIED", "ERP sales document changed outside this bridge", True)
    source_lines = {row["name"]: row.get("custom_trade_line_id") for row in sales["items"]}
    sales_ownership = {row.get("custom_trade_line_id"): row.get("custom_trade_supplier_id") for row in sales["items"]}
    previous = {}
    for link in purchase_links:
        if not link["source_id"].startswith(prefix):
            raise BridgeError("ERP_LINK_INCOMPLETE", "Purchase source mapping requires review", True)
        supplier_id = link["source_id"][len(prefix):]
        for row in json.loads(link["managed_payload"]).get("items", []):
            line_id = source_lines.get(row.get("sales_order_item"))
            if not line_id or line_id in previous:
                raise BridgeError("ERP_LINK_INCOMPLETE", "Purchase ownership mapping needs review", True)
            previous[line_id] = supplier_id
    desired = {line["id"]: line["factoryId"] for line in prepared["lines"]}
    if sales_ownership != desired or any(desired.get(line_id) != supplier_id for line_id, supplier_id in previous.items()):
        raise BridgeError("ERP_SUPPLIER_LINKED", "Existing ERP purchase orders require an explicit cancel/amend workflow before moving, adding or removing supplier-owned lines", True)


def check_erp_total(doc, expected, currency):
    try:
        total = Decimal(str(doc.get("grand_total")))
    except (InvalidOperation, TypeError, ValueError):
        raise BridgeError("ERP_TOTAL_MISMATCH", "ERPNext did not return a verifiable order total", True)
    if not total.is_finite() or doc.get("currency") != currency or abs(total - expected) > Decimal("0.005"):
        raise BridgeError("ERP_TOTAL_MISMATCH", "ERPNext calculated a different currency or total; review pricing and tax settings before retrying", True)


def process_order(store, client, prepared):
    tid, order, company = prepared["tenantId"], prepared["order"], prepared["company"]
    guard_supplier_ownership(store, client, prepared)
    customer = prepared["customer"]
    customer_doc = upsert(store, client, tid, "Customer", customer["id"], {"customer_name": customer.get("company") or customer["name"], "customer_type": "Company", "customer_group": company["customerGroup"], "territory": company["territory"]})
    suppliers = {}
    for fid, factory in prepared["factories"].items():
        suppliers[fid] = upsert(store, client, tid, "Supplier", fid, {"supplier_name": factory["name"], "supplier_group": company["supplierGroup"], "supplier_type": "Company"})
    delivery_date = order.get("expectedShipDate") or order.get("shippingDate") or order.get("deliveryDate")
    try:
        date.fromisoformat(delivery_date)
    except (ValueError, TypeError):
        raise BridgeError("MISSING_DELIVERY_DATE", "Set an explicit ISO delivery date", True)
    rows = [{"item_code": line["itemCode"], "qty": line["quantity"], "rate": line["saleRate"], "delivery_date": delivery_date, "custom_trade_line_id": line["id"], "custom_trade_supplier_id": line["factoryId"]} for line in prepared["lines"]]
    sales = upsert(store, client, tid, "Sales Order", order["id"], {"company": company["name"], "customer": customer_doc["name"], "currency": company["currency"], "selling_price_list": company.get("sellingPriceList", "Standard Selling"), "conversion_rate": 1, "delivery_date": delivery_date, "transaction_date": order.get("orderDate") or date.today().isoformat(), "po_no": order.get("customerOrderNo") or order.get("poNumber", ""), "items": rows}, order_id=order["id"])
    check_erp_total(sales, amount(order["orderAmountUSD"], "Source sales total"), company["currency"])
    # Preserve line-to-supplier ownership; never call make_purchase_order which
    # inserts immediately and groups its selected items by item_code.
    for fid, supplier in suppliers.items():
        items = []
        for position, line in enumerate(prepared["lines"]):
            if line["factoryId"] != fid:
                continue
            items.append({"item_code": line["itemCode"], "qty": line["quantity"], "rate": line["purchaseRate"], "schedule_date": delivery_date, "sales_order": sales["name"], "sales_order_item": sales["items"][position]["name"]})
        purchase = upsert(store, client, tid, "Purchase Order", order["id"] + "::" + fid, {"company": company["name"], "supplier": supplier["name"], "currency": company["currency"], "buying_price_list": company.get("buyingPriceList", "Standard Buying"), "conversion_rate": 1, "schedule_date": delivery_date, "transaction_date": sales["transaction_date"], "items": items}, order_id=order["id"])
        expected_purchase = sum(amount(row["qty"], "Purchase quantity") * amount(row["rate"], "Purchase rate") for row in items)
        check_erp_total(purchase, expected_purchase, company["currency"])


def run(store, configuration, limit=10, client_factory=FrappeClient):
    results = []
    for _ in range(limit):
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            job = db.execute("SELECT * FROM erp_outbox WHERE state IN ('pending','failed') OR (state='running' AND lease_until<?) ORDER BY created_at LIMIT 1", (int(time.time()),)).fetchone()
            if not job:
                db.execute("COMMIT")
                break
            db.execute("UPDATE erp_outbox SET state='running',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=?", (int(time.time()) + 300, now(), job["id"]))
            db.execute("COMMIT")
        state, code, message = "synced", None, None
        try:
            cfg = tenant_config(configuration, job["tenant_id"])
            if not cfg.get("enabled"):
                raise BridgeError("NOT_CONNECTED", "ERPNext connection is not configured", True)
            prepared = json.loads(job["payload"])
            with store.connect() as db:
                tenant = db.execute("SELECT payload FROM tenants WHERE id=?", (job["tenant_id"],)).fetchone()
            if not tenant:
                raise BridgeError("SOURCE_CHANGED", "Source tenant is no longer available", True)
            current = prepare_order(job["tenant_id"], job["order_id"], json.loads(tenant["payload"]), cfg)
            if dumps(current) != dumps(prepared):
                raise BridgeError("SOURCE_CHANGED", "Source order, customer, supplier or mapping changed after queueing; save and explicitly queue the current version", True)
            process_order(store, client_factory(cfg), prepared)
            with store.connect() as db:
                tenant_after = db.execute("SELECT payload FROM tenants WHERE id=?", (job["tenant_id"],)).fetchone()
            latest = prepare_order(job["tenant_id"], job["order_id"], json.loads(tenant_after["payload"]), cfg) if tenant_after else None
            if dumps(latest) != dumps(prepared):
                raise BridgeError("SOURCE_CHANGED_DURING_SYNC", "Source changed while ERP drafts were being created; review those drafts and explicitly queue the saved current version", True)
        except BridgeError as e:
            state, code, message = ("blocked" if e.blocked else "failed"), e.code, str(e)
        except Exception:
            state, code, message = "failed", "ERP_WORKER_ERROR", "ERP worker failed; inspect local server diagnostics"
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE erp_outbox SET state=?,error_code=?,error_message=?,lease_until=0,updated_at=? WHERE id=?", (state, code, message, now(), job["id"]))
            result = public_job(db.execute("SELECT * FROM erp_outbox WHERE id=?", (job["id"],)).fetchone())
            db.execute("COMMIT")
        results.append(result)
        if state == "failed":
            break  # Avoid immediate retries repeatedly selecting the same job.
    return results
