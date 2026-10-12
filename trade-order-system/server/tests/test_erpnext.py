import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from server.store import Store
from server import erpnext as bridge


class FakeFrappe:
    """Fault-injected transport only; real integration is separately verified."""
    def __init__(self):
        self.docs, self.sequence, self.fail_after, self.fail_before = {}, 0, None, None
        self.creates = []

    def find(self, doctype, eid):
        return next((copy.deepcopy(doc) for (dt, _), doc in self.docs.items() if dt == doctype and doc.get(bridge.EXTERNAL_FIELD) == eid), None)

    def get(self, doctype, name):
        return copy.deepcopy(self.docs[(doctype, name)])

    def create(self, doctype, values):
        if self.fail_before == doctype:
            self.fail_before = None
            raise bridge.BridgeError("ERP_UNAVAILABLE", "Transport unavailable")
        self.sequence += 1
        doc = {**copy.deepcopy(values), "name": f"{doctype}-{self.sequence}", "modified": str(self.sequence), "docstatus": 0}
        if "items" in doc:
            doc["items"] = [{**item, "name": f"line-{self.sequence}-{i}"} for i, item in enumerate(doc["items"])]
            if doctype in ("Sales Order", "Purchase Order"):
                doc["grand_total"] = sum(item["qty"] * item["rate"] for item in doc["items"])
        self.docs[(doctype, doc["name"])] = doc
        self.creates.append(doctype)
        if self.fail_after == doctype:
            self.fail_after = None
            raise bridge.BridgeError("ERP_UNAVAILABLE", "Lost POST response")
        return copy.deepcopy(doc)

    def update(self, doctype, name, values):
        doc = self.docs[(doctype, name)]
        if values["modified"] != doc["modified"]:
            raise bridge.BridgeError("ERP_MODIFIED", "ERP changed", True)
        self.sequence += 1
        doc.update(copy.deepcopy(values))
        doc["modified"] = str(self.sequence)
        return copy.deepcopy(doc)


class ERPNextBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(self.tmp.name)
        self.configuration = {"tenants": {"demo": {"enabled": True, "baseUrl": "http://127.0.0.1:3088", "site": "frontend", "apiKey": "private-key", "apiSecret": "private-secret", "companies": {"EX-01": {"name": "Example Trade Demo", "currency": "USD", "customerGroup": "Trade Demo Customers", "supplierGroup": "Trade Demo Suppliers", "territory": "Trade Demo Territory"}}}}}
        self.payload = {"orders": [{"id": "O1", "companyId": "EX-01", "customerId": "C1", "orderAmountUSD": 1000, "factoryCostUSD": 700, "shippingDate": "2026-12-01", "orderDate": "2026-10-11", "customerOrderNo": "DEMO-PO-2026", "erpItems": [{"id": "L1", "itemCode": "A", "quantity": 50, "saleRate": 10, "purchaseRate": 7, "factoryId": "F1"}, {"id": "L2", "itemCode": "B", "quantity": 50, "saleRate": 10, "purchaseRate": 7, "factoryId": "F2"}]}], "customers": [{"id": "C1", "company": "Fictional Buyer"}], "factories": [{"id": "F1", "name": "Fictional Supplier A"}, {"id": "F2", "name": "Fictional Supplier B"}], "shipments": [], "invoices": []}
        with self.store.connect() as db:
            bridge.init_schema(db)
            db.execute("INSERT INTO tenants VALUES(?,?,?,?,?,?,?,?)", ("demo", "{}", bridge.dumps(self.payload), "{}", "{}", 1, bridge.now(), "fixture"))
        self.client = FakeFrappe()

    def tearDown(self):
        self.tmp.cleanup()

    def queue(self, version=1):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            result = bridge.queue_order(db, "demo", "actor", "O1", version, self.payload, self.configuration)
            db.execute("COMMIT")
        return result

    def run_worker(self):
        return bridge.run(self.store, self.configuration, client_factory=lambda _: self.client)

    def save_source(self):
        with self.store.connect() as db:
            db.execute("UPDATE tenants SET payload=? WHERE id='demo'", (bridge.dumps(self.payload),))

    def test_requires_source_transaction(self):
        with self.store.connect() as db:
            with self.assertRaises(RuntimeError):
                bridge.queue_order(db, "demo", "actor", "O1", 1, self.payload, self.configuration)

    def test_queue_rolls_back_with_source_transaction(self):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            bridge.queue_order(db, "demo", "actor", "O1", 1, self.payload, self.configuration)
            db.execute("ROLLBACK")
            self.assertFalse(bridge.has_jobs(db, "demo"))

    def test_disconnected_is_explicit_and_has_no_jobs_for_other_scope(self):
        self.configuration["tenants"]["demo"]["enabled"] = False
        self.assertEqual(self.queue()["errorCode"], "NOT_CONNECTED")
        with self.store.connect() as db:
            result = bridge.status(db, "demo", [], self.configuration)
        self.assertFalse(result["enabled"])
        self.assertEqual(result["jobs"], [])

    def test_missing_item_mapping_blocks_without_erp(self):
        del self.payload["orders"][0]["erpItems"]
        self.assertEqual(self.queue()["errorCode"], "MISSING_ITEM_MAPPING")
        self.assertEqual(self.run_worker(), [])
        self.assertEqual(self.client.creates, [])

    def test_missing_or_root_master_categories_block_before_any_erp_write(self):
        company = self.configuration["tenants"]["demo"]["companies"]["EX-01"]
        roots = {"customerGroup": "All Customer Groups", "supplierGroup": "All Supplier Groups", "territory": "All Territories"}
        for field, root in roots.items():
            original = company[field]
            for bad_value in (None, "", root):
                with self.subTest(field=field, value=bad_value):
                    company[field] = bad_value
                    self.assertEqual(self.queue()["errorCode"], "MASTER_DATA_MAPPING_REQUIRED")
                    self.assertEqual(self.run_worker(), [])
                    self.assertEqual(self.client.creates, [])
            company[field] = original

    def test_sales_total_mismatch_blocks(self):
        self.payload["orders"][0]["erpItems"][0]["saleRate"] = 11
        self.assertEqual(self.queue()["errorCode"], "SALES_TOTAL_MISMATCH")

    def test_purchase_total_mismatch_blocks(self):
        self.payload["orders"][0]["erpItems"][0]["purchaseRate"] = 8
        self.assertEqual(self.queue()["errorCode"], "PURCHASE_TOTAL_MISMATCH")

    def test_erp_sales_tax_or_pricing_change_blocks_before_purchase(self):
        original = self.client.create

        def altered(doctype, values):
            doc = original(doctype, values)
            if doctype == "Sales Order":
                doc["grand_total"] += 15
                self.client.docs[(doctype, doc["name"])] = copy.deepcopy(doc)
            return doc

        self.client.create = altered
        self.queue()
        self.assertEqual(self.run_worker()[0]["errorCode"], "ERP_TOTAL_MISMATCH")
        self.assertNotIn("Purchase Order", self.client.creates)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM erp_links WHERE doctype='Sales Order'").fetchone()[0], 1)

    def test_erp_purchase_total_change_preserves_partial_mapping_and_blocks(self):
        original = self.client.create

        def altered(doctype, values):
            doc = original(doctype, values)
            if doctype == "Purchase Order":
                doc["grand_total"] += 5
                self.client.docs[(doctype, doc["name"])] = copy.deepcopy(doc)
            return doc

        self.client.create = altered
        self.queue()
        self.assertEqual(self.run_worker()[0]["errorCode"], "ERP_TOTAL_MISMATCH")
        self.assertEqual(self.client.creates.count("Purchase Order"), 1)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM erp_links WHERE doctype='Purchase Order'").fetchone()[0], 1)

    def test_domestic_currency_is_not_guessed(self):
        self.configuration["tenants"]["demo"]["companies"]["EX-01"]["currency"] = "CNY"
        self.assertEqual(self.queue()["errorCode"], "CURRENCY_MAPPING_REQUIRED")

    def client_server(self, redirect=False):
        class Handler(BaseHTTPRequestHandler):
            calls = []

            def log_message(self, *args):
                pass

            def do_GET(self):
                self.calls.append(self.path)
                if redirect and self.path != "/target":
                    self.send_response(302)
                    self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/target")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"data":{"name":"C1"}}')

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        cfg = {**self.configuration["tenants"]["demo"], "baseUrl": f"http://127.0.0.1:{server.server_port}"}
        return bridge.FrappeClient(cfg), Handler.calls

    def test_loopback_api_ignores_global_proxy_for_private_credentials(self):
        client, calls = self.client_server()
        with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:1", "no_proxy": "", "NO_PROXY": ""}), patch("urllib.request.proxy_bypass", return_value=False):
            self.assertEqual(client.get("Customer", "C1"), {"name": "C1"})
        self.assertEqual(calls, ["/api/resource/Customer/C1"])

    def test_erp_redirect_is_not_followed_with_api_credentials(self):
        client, calls = self.client_server(redirect=True)
        with self.assertRaises(bridge.BridgeError) as caught:
            client.get("Customer", "C1")
        self.assertEqual(caught.exception.code, "ERP_HTTP_302")
        self.assertEqual(calls, ["/api/resource/Customer/C1"])

    def test_legacy_cost_without_explicit_currency_mapping_is_blocked(self):
        order = self.payload["orders"][0]
        order["factoryCostRMB"] = order.pop("factoryCostUSD")
        self.assertEqual(self.queue()["errorCode"], "COST_CURRENCY_MAPPING_REQUIRED")
        self.assertEqual(self.client.creates, [])

    def test_explicit_rmb_legacy_cost_is_not_converted_to_usd(self):
        order = self.payload["orders"][0]
        order["factoryCostRMB"] = order.pop("factoryCostUSD")
        self.configuration["tenants"]["demo"]["companies"]["EX-01"]["legacyPurchaseCostCurrency"] = "CNY"
        self.assertEqual(self.queue()["errorCode"], "COST_CURRENCY_MAPPING_REQUIRED")

    def test_explicit_usd_legacy_cost_mapping_can_sync(self):
        order = self.payload["orders"][0]
        order["factoryCostRMB"] = order.pop("factoryCostUSD")
        self.configuration["tenants"]["demo"]["companies"]["EX-01"]["legacyPurchaseCostCurrency"] = "USD"
        self.save_source()
        self.assertEqual(self.queue()["state"], "pending")
        self.assertEqual(self.run_worker()[0]["state"], "synced")

    def test_source_edit_after_queue_blocks_before_any_remote_write(self):
        self.queue()
        self.payload["orders"][0]["remarks"] = "newer saved edit"
        self.save_source()
        self.assertEqual(self.run_worker()[0]["errorCode"], "SOURCE_CHANGED")
        self.assertEqual(self.client.creates, [])

    def test_mapping_change_after_queue_blocks(self):
        self.queue()
        self.configuration["tenants"]["demo"]["companies"]["EX-01"]["name"] = "Changed company"
        self.assertEqual(self.run_worker()[0]["errorCode"], "SOURCE_CHANGED")
        self.assertEqual(self.client.creates, [])

    def test_real_document_shape_two_suppliers_and_idempotent_queue(self):
        first = self.queue()
        self.assertEqual(first["id"], self.queue()["id"])
        self.assertEqual(self.run_worker()[0]["state"], "synced")
        self.assertEqual(self.client.creates.count("Customer"), 1)
        customer = next(doc for (dt, _), doc in self.client.docs.items() if dt == "Customer")
        sales = next(doc for (dt, _), doc in self.client.docs.items() if dt == "Sales Order")
        self.assertEqual(customer["customer_name"], "Fictional Buyer")
        self.assertEqual(sales["po_no"], "DEMO-PO-2026")
        self.assertEqual(self.client.creates.count("Supplier"), 2)
        self.assertEqual(self.client.creates.count("Sales Order"), 1)
        self.assertEqual(self.client.creates.count("Purchase Order"), 2)
        orders = [doc for (dt, _), doc in self.client.docs.items() if dt == "Purchase Order"]
        self.assertEqual({doc["items"][0]["item_code"] for doc in orders}, {"A", "B"})
        self.assertTrue(all(doc["items"][0]["sales_order_item"] for doc in orders))
        self.assertTrue(all(doc["docstatus"] == 0 for doc in orders))
        self.assertEqual(self.run_worker(), [])

    def test_lost_create_response_recovers_same_external_id(self):
        self.client.fail_after = "Sales Order"
        self.queue()
        self.assertEqual(self.run_worker()[0]["state"], "failed")
        self.assertEqual(self.run_worker()[0]["state"], "synced")
        self.assertEqual(self.client.creates.count("Sales Order"), 1)

    def test_partial_remote_commit_is_preserved_and_retry_is_safe(self):
        self.client.fail_before = "Purchase Order"
        self.queue()
        self.assertEqual(self.run_worker()[0]["state"], "failed")
        self.assertEqual(self.client.creates.count("Sales Order"), 1)
        self.assertEqual(self.run_worker()[0]["state"], "synced")
        self.assertEqual(self.client.creates.count("Customer"), 1)
        self.assertEqual(self.client.creates.count("Sales Order"), 1)

    def test_external_modification_blocks_no_silent_overwrite(self):
        self.queue()
        self.run_worker()
        sales = next(doc for (dt, _), doc in self.client.docs.items() if dt == "Sales Order")
        sales["modified"] = "edited-in-erp"
        sales["po_no"] = "ERP owns this change"
        self.payload["orders"][0]["poNumber"] = "new local PO"
        self.save_source()
        self.queue(2)
        self.assertEqual(self.run_worker()[0]["errorCode"], "ERP_MODIFIED")
        self.assertEqual(sales["po_no"], "ERP owns this change")

    def test_corrected_mapping_can_explicitly_requeue_same_version(self):
        cfg = self.configuration["tenants"]["demo"]
        cfg["enabled"] = False
        blocked = self.queue()
        cfg["enabled"] = True
        pending = self.queue()
        self.assertEqual(blocked["id"], pending["id"])
        self.assertEqual(pending["state"], "pending")
        self.assertEqual(self.run_worker()[0]["state"], "synced")

    def test_private_config_permissions_and_distinct_sites(self):
        path = Path(self.tmp.name) / "erpnext.json"
        path.write_text(json.dumps(self.configuration))
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            bridge.load_config(self.tmp.name)
        path.chmod(0o600)
        config = bridge.load_config(self.tmp.name)
        config["tenants"]["another"] = copy.deepcopy(config["tenants"]["demo"])
        path.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            bridge.load_config(self.tmp.name)

    def test_status_does_not_leak_other_tenants_or_hidden_records(self):
        self.queue()
        self.run_worker()
        with self.store.connect() as db:
            hidden = bridge.status(db, "demo", [], self.configuration)
            other = bridge.status(db, "other", ["O1"], self.configuration)
        self.assertEqual(hidden["jobs"], [])
        self.assertEqual(hidden["documents"], [])
        self.assertEqual(other["jobs"], [])
        self.assertNotIn("private-secret", bridge.dumps(hidden))

    def test_reordering_lines_preserves_existing_purchase_references(self):
        self.queue()
        self.run_worker()
        sales = next(doc for (dt, _), doc in self.client.docs.items() if dt == "Sales Order")
        original_ids = {item["custom_trade_line_id"]: item["name"] for item in sales["items"]}
        self.payload["orders"][0]["erpItems"].reverse()
        self.save_source()
        self.queue(2)
        self.assertEqual(self.run_worker()[0]["state"], "synced")
        sales = next(doc for (dt, _), doc in self.client.docs.items() if dt == "Sales Order")
        self.assertEqual({item["custom_trade_line_id"]: item["name"] for item in sales["items"]}, original_ids)
        self.assertEqual(self.client.creates.count("Purchase Order"), 2)

    def test_source_changes_during_network_work_are_not_reported_synced(self):
        self.queue()
        create = self.client.create
        def concurrent_edit(doctype, values):
            doc = create(doctype, values)
            if doctype == "Sales Order":
                self.payload["orders"][0]["remarks"] = "Edited while network request completed"
                self.save_source()
            return doc
        self.client.create = concurrent_edit
        self.assertEqual(self.run_worker()[0]["errorCode"], "SOURCE_CHANGED_DURING_SYNC")
        self.assertEqual(self.client.creates.count("Sales Order"), 1)

    def test_same_origin_with_different_site_cannot_bypass_tenant_isolation(self):
        config = copy.deepcopy(self.configuration)
        config["tenants"]["another"] = copy.deepcopy(config["tenants"]["demo"])
        config["tenants"]["another"]["site"] = "different-site"
        path = Path(self.tmp.name) / "erpnext.json"
        path.write_text(json.dumps(config))
        path.chmod(0o600)
        with self.assertRaises(ValueError):
            bridge.load_config(self.tmp.name)

    def test_missing_delivery_date_blocks_before_master_data_creation(self):
        del self.payload["orders"][0]["shippingDate"]
        self.assertEqual(self.queue()["errorCode"], "MISSING_DELIVERY_DATE")
        self.assertEqual(self.client.creates, [])

    def test_changing_line_supplier_blocks_before_duplicate_purchase_is_created(self):
        self.queue()
        self.run_worker()
        original_docs = copy.deepcopy(self.client.docs)
        self.payload["orders"][0]["erpItems"][0]["factoryId"] = "F2"
        self.save_source()
        self.queue(2)
        self.assertEqual(self.run_worker()[0]["errorCode"], "ERP_SUPPLIER_LINKED")
        self.assertEqual(self.client.docs, original_docs)
        self.assertEqual(self.client.creates.count("Purchase Order"), 2)

    def test_second_supplier_failure_retries_partial_purchase_links(self):
        create = self.client.create
        should_fail = [True]
        def second_supplier_failure(doctype, values):
            if doctype == "Purchase Order" and self.client.creates.count("Purchase Order") == 1 and should_fail[0]:
                should_fail[0] = False
                raise bridge.BridgeError("ERP_UNAVAILABLE", "Second supplier unavailable")
            return create(doctype, values)
        self.client.create = second_supplier_failure
        self.queue()
        self.assertEqual(self.run_worker()[0]["state"], "failed")
        self.assertEqual(self.client.creates.count("Purchase Order"), 1)
        self.assertEqual(self.run_worker()[0]["state"], "synced")
        self.assertEqual(self.client.creates.count("Purchase Order"), 2)

    def test_record_id_colon_prefix_cannot_leak_hidden_order_documents(self):
        with self.store.connect() as db:
            db.execute("INSERT INTO erp_links VALUES(?,?,?,?,?,?,?,?,?)", ("demo", "Sales Order", "O1::hidden", "external-hidden", "hidden-financial-document", "1", "{}", 0, "O1::hidden"))
            result = bridge.status(db, "demo", ["O1"], self.configuration)
        self.assertEqual(result["documents"], [])

    def test_composite_source_collision_cannot_change_order_ownership(self):
        self.queue()
        self.run_worker()
        before = copy.deepcopy(self.client.docs)
        with self.assertRaises(bridge.BridgeError) as error:
            bridge.upsert(self.store, self.client, "demo", "Purchase Order", "O1::F1", {}, order_id="O1::different")
        self.assertEqual(error.exception.code, "ERP_SOURCE_COLLISION")
        self.assertEqual(self.client.docs, before)


if __name__ == "__main__":
    unittest.main()
