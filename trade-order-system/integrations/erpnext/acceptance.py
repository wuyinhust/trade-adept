"""Real isolated ERPNext acceptance, after an Example order is queued/synced.

This script explicitly submits fictional ERP documents and creates a real
Delivery Note and advance Payment Entry through standard ERPNext APIs. It must
never be pointed at a production site or the Grandware tenant.
"""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from server.store import Store
from server.erpnext import FrappeClient, dumps, load_config, tenant_config, upsert


def store_link(store, tid, doctype, source_id, doc, order_id):
    with store.connect() as db:
        result = db.execute("UPDATE erp_links SET modified=?,docstatus=? WHERE tenant_id=? AND doctype=? AND source_id=? AND order_id=?", (doc["modified"], int(doc.get("docstatus", 0)), tid, doctype, source_id, order_id))
        if result.rowcount != 1:
            raise RuntimeError("Fictional ERP document ownership does not match the exact source order")


def submit(store, client, tid, doctype, source_id, doc, order_id):
    if int(doc.get("docstatus", 0)) == 0:
        doc = client.request("POST", "/api/method/frappe.client.submit", {"doc": doc})
    if int(doc.get("docstatus", 0)) != 1:
        raise RuntimeError("Expected a submitted fictional ERP document")
    store_link(store, tid, doctype, source_id, doc, order_id)
    return doc


def verify(runtime, order_id, report_path):
    store = Store(runtime)
    tid = "example-company"
    config = tenant_config(load_config(store.runtime), tid)
    origin = urlsplit(config.get("baseUrl", ""))
    if origin.hostname not in ("127.0.0.1", "localhost", "::1") or config.get("site") != "frontend":
        raise RuntimeError("Acceptance only permits the isolated loopback frontend site")
    client = FrappeClient(config)
    with store.connect() as db:
        tenant = db.execute("SELECT revision,payload FROM tenants WHERE id=?", (tid,)).fetchone()
        other_tenants_before = {row["id"]: (row["revision"], hashlib.sha256(row["payload"].encode()).hexdigest()) for row in db.execute("SELECT id,revision,payload FROM tenants WHERE id!=?", (tid,))}
        links = db.execute("SELECT * FROM erp_links WHERE tenant_id=?", (tid,)).fetchall()
    payload = json.loads(tenant["payload"])
    original_business_payload = tenant["payload"]
    order = next(o for o in payload["orders"] if o["id"] == order_id)
    company = config["companies"][order["companyId"]]
    if company["name"] != "Example Trade Demo" or float(order["orderAmountUSD"]) != 1000 or float(order.get("factoryCostUSD", order.get("factoryCostRMB"))) != 700:
        raise RuntimeError("Acceptance expects the exact fictional USD 1000/700 order")
    sales_link = next(l for l in links if l["doctype"] == "Sales Order" and l["source_id"] == order_id and l["order_id"] == order_id)
    sales = submit(store, client, tid, "Sales Order", order_id, client.get("Sales Order", sales_link["name"]), order_id)
    source_customer = next(c for c in payload["customers"] if c["id"] == order["customerId"])
    erp_customer = client.get("Customer", sales["customer"])
    if erp_customer["customer_name"] != (source_customer.get("company") or source_customer.get("name")) or sales.get("po_no", "") != (order.get("customerOrderNo") or order.get("poNumber", "")):
        raise RuntimeError("ERP customer name or buyer PO number differs from the actual Trade source fields")
    purchase_links = [l for l in links if l["doctype"] == "Purchase Order" and l["order_id"] == order_id]
    if len(purchase_links) != 2:
        raise RuntimeError("Acceptance expects two separate supplier purchase orders")
    purchases = [submit(store, client, tid, "Purchase Order", l["source_id"], client.get("Purchase Order", l["name"]), order_id) for l in purchase_links]
    if sum(float(p["grand_total"]) for p in purchases) != 700 or float(sales["grand_total"]) != 1000:
        raise RuntimeError("Standard ERPNext totals differ from explicit source totals")
    source_factories = {factory["id"]: factory for factory in payload["factories"]}
    expected_purchase_totals = {}
    for row in order["erpItems"]:
        supplier_name = source_factories[row["factoryId"]]["name"]
        expected_purchase_totals[supplier_name] = expected_purchase_totals.get(supplier_name, 0) + float(row["quantity"]) * float(row["purchaseRate"])
    actual_purchase_totals = {client.get("Supplier", purchase["supplier"])["supplier_name"]: float(purchase["grand_total"]) for purchase in purchases}
    if actual_purchase_totals != expected_purchase_totals:
        raise RuntimeError("ERP supplier purchase totals differ from the actual Trade item ownership")
    delivery_source = order_id + "::delivery-demo"
    with store.connect() as db:
        delivery_link = db.execute("SELECT * FROM erp_links WHERE tenant_id=? AND doctype='Delivery Note' AND source_id=? AND order_id=?", (tid, delivery_source, order_id)).fetchone()
    if delivery_link:
        delivery = client.get("Delivery Note", delivery_link["name"])
    else:
        blueprint = client.request("POST", "/api/method/erpnext.selling.doctype.sales_order.sales_order.make_delivery_note", {"source_name": sales["name"]})
        values = {"company": company["name"], "customer": sales["customer"], "currency": "USD", "conversion_rate": 1, "selling_price_list": company.get("sellingPriceList", "Standard Selling"), "posting_date": date.today().isoformat(), "items": [{key: row[key] for key in ("item_code", "qty", "rate", "against_sales_order", "so_detail", "warehouse") if row.get(key) is not None} for row in blueprint["items"]]}
        delivery = upsert(store, client, tid, "Delivery Note", delivery_source, values, order_id=order_id)
    delivery = submit(store, client, tid, "Delivery Note", delivery_source, delivery, order_id)
    payment_source = order_id + "::receipt-demo"
    with store.connect() as db:
        payment_link = db.execute("SELECT * FROM erp_links WHERE tenant_id=? AND doctype='Payment Entry' AND source_id=? AND order_id=?", (tid, payment_source, order_id)).fetchone()
    if payment_link:
        payment = client.get("Payment Entry", payment_link["name"])
    else:
        blueprint = client.request("POST", "/api/method/erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry", {"dt": "Sales Order", "dn": sales["name"], "bank_account": company["bankAccount"], "bank_amount": 1000})
        values = {key: blueprint[key] for key in ("company", "payment_type", "party_type", "party", "paid_from", "paid_to", "paid_from_account_currency", "paid_to_account_currency", "source_exchange_rate", "target_exchange_rate", "paid_amount", "received_amount") if blueprint.get(key) is not None}
        values.update({"posting_date": date.today().isoformat(), "reference_date": date.today().isoformat(), "reference_no": "TW-DEMO-RECEIPT", "references": [{key: row[key] for key in ("reference_doctype", "reference_name", "total_amount", "outstanding_amount", "allocated_amount") if row.get(key) is not None} for row in blueprint["references"]]})
        payment = upsert(store, client, tid, "Payment Entry", payment_source, values, order_id=order_id)
    payment = submit(store, client, tid, "Payment Entry", payment_source, payment, order_id)
    ledger = client.request("GET", "/api/resource/GL%20Entry", query={"filters": dumps([["voucher_type", "=", "Payment Entry"], ["voucher_no", "=", payment["name"]], ["is_cancelled", "=", 0]]), "fields": dumps(["account", "debit", "credit", "voucher_no"]), "limit_page_length": 100})
    if not ledger or sum(float(row["debit"]) for row in ledger) != 1000 or sum(float(row["credit"]) for row in ledger) != 1000:
        raise RuntimeError("Expected balanced real Payment Entry general-ledger posting")
    final_sales = client.get("Sales Order", sales["name"])
    if float(final_sales.get("per_delivered", 0)) != 100 or float(final_sales.get("advance_paid", 0)) != 1000:
        raise RuntimeError("ERPNext sales order lacks delivered/advance-payment downstream proof")
    expected_quantity = sum(float(row["quantity"]) for row in order["erpItems"])
    if float(delivery.get("total_qty", 0)) != expected_quantity:
        raise RuntimeError("ERP delivery quantity differs from the actual Trade item quantity")
    store_link(store, tid, "Sales Order", order_id, final_sales, order_id)
    with store.connect() as db:
        final_tenant = db.execute("SELECT revision,payload FROM tenants WHERE id=?", (tid,)).fetchone()
        other_tenants_after = {row["id"]: (row["revision"], hashlib.sha256(row["payload"].encode()).hexdigest()) for row in db.execute("SELECT id,revision,payload FROM tenants WHERE id!=?", (tid,))}
    business_unchanged = final_tenant["payload"] == original_business_payload and final_tenant["revision"] == tenant["revision"]
    if not business_unchanged:
        raise RuntimeError("Trade business data changed during real ERP acceptance")
    if other_tenants_before != other_tenants_after:
        raise RuntimeError("Another Trade tenant changed during fictional ERP acceptance")
    report = {"acceptedAt": datetime.now(timezone.utc).isoformat(), "site": config["site"], "tenant": tid, "company": company["name"], "sourceOrderId": order_id, "customer": {"name": sales["customer"], "company": erp_customer["customer_name"]}, "salesOrder": {"name": sales["name"], "customerOrderNo": sales.get("po_no"), "docstatus": 1, "grandTotalUSD": float(sales["grand_total"]), "deliveredPercent": float(final_sales["per_delivered"]), "advancePaidUSD": float(final_sales["advance_paid"])}, "purchaseOrders": [{"name": p["name"], "supplier": p["supplier"], "docstatus": int(p["docstatus"]), "grandTotalUSD": float(p["grand_total"])} for p in purchases], "deliveryNote": {"name": delivery["name"], "docstatus": int(delivery["docstatus"]), "totalQuantity": float(delivery["total_qty"])}, "paymentEntry": {"name": payment["name"], "docstatus": int(payment["docstatus"]), "receivedUSD": float(payment["received_amount"]), "ledgerEntries": ledger}, "sqliteBusinessUnchangedByERPSubmit": business_unchanged, "productionDeployment": False}
    report.update({"sourceRevision": tenant["revision"], "tradePaidAmountUSD": order.get("paidAmountUSD", 0), "nonDemoTenantsUnchangedByERPSubmit": True, "otherTenantRevisions": {tenant_id: values[0] for tenant_id, values in other_tenants_after.items()}})
    Path(report_path).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--order-id", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--submit-fictional-demo", action="store_true", required=True)
    args = parser.parse_args()
    verify(args.runtime, args.order_id, args.report)
