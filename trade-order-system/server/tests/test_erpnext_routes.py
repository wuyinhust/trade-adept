"""ERP routes against synthetic tenants, real HTTP and temporary SQLite only."""
import http.client
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

from server import erpnext
from server.app import create_server
from server.store import Store
from server.tests.test_erpnext import FakeFrappe
from server.tests.test_service import PASSWORD, config, order


def route_config():
    result = config()
    first = result["tenants"][0]
    first["roles"] = {
        "finance_reader": {"scope": "tenant", "permissions": ["read", "finance.read"], "pages": ["orders"]},
        "customer_finance": {"scope": "tenant", "permissions": ["read", "edit", "finance.read", "finance.write"], "collections": ["customers"], "pages": ["customers"]},
        "scoped_finance": {"scope": "self", "permissions": ["read", "edit", "finance.read", "finance.write"], "pages": ["orders"]},
    }
    for uid, role in (("reader", "finance_reader"), ("customer-only", "customer_finance"), ("scoped", "scoped_finance")):
        first["users"].append({"id": uid, "username": uid, "role": role, "visibleCompanyIds": ["C2"], "password": PASSWORD})
    second = result["tenants"][1]
    second["companies"][0]["id"] = "C2"
    second["users"][0]["visibleCompanyIds"] = ["C2"]
    return result


def bridge_config():
    return {"tenants": {
        tid: {"enabled": True, "baseUrl": "http://127.0.0.1:" + ("3088" if tid == "one" else "3089"), "site": tid + ".test",
              "apiKey": "synthetic-private-key-" + tid, "apiSecret": "synthetic-private-secret-" + tid,
              "companies": {"C2": {"name": "Synthetic ERP Company " + tid, "currency": "USD", "legacyPurchaseCostCurrency": "USD", "customerGroup": "Synthetic Customers", "supplierGroup": "Synthetic Suppliers", "territory": "Synthetic Territory"}}}
        for tid in ("one", "two")
    }}


class ERPNextRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = tempfile.TemporaryDirectory(prefix="trade-erp-routes-template-")
        store = Store(cls.template.name)
        store.configure(route_config())
        cls.template_path = store.path

    @classmethod
    def tearDownClass(cls):
        cls.template.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="trade-erp-routes-test-")
        self.addCleanup(self.directory.cleanup)
        shutil.copyfile(self.template_path, Path(self.directory.name) / "workspace.sqlite3")
        self.store = Store(self.directory.name)
        self.configuration = bridge_config()
        self.config_path = Path(self.directory.name) / "erpnext.json"
        self.write_configuration()
        for tenant in ("one", "two"):
            source = Path(self.directory.name) / (tenant + "-synthetic.json")
            records = []
            for identifier, owner in (("shared-order", "a"), ("scoped-order", "scoped")):
                record = order(identifier, company="C2", owner=owner)
                record.update(erpItems=[{"id": "ERP-line-1", "itemCode": "DEMO-ITEM", "quantity": 10,
                                        "saleRate": 100, "purchaseRate": 10, "factoryId": "factory-1"}],
                              shippingDate="2026-10-25", deliveryDate="2026-10-25", poNumber="ERP-PO-" + tenant)
                records.append(record)
            source.write_text(json.dumps({"data": {
                "orders": records,
                "customers": [{"id": "c", "company": "Synthetic Buyer " + tenant, "name": "Synthetic Buyer " + tenant,
                               "companyId": "C2", "createdBy": "scoped"}],
                "factories": [{"id": "factory-1", "name": "Synthetic Supplier " + tenant, "companyId": "C2", "createdBy": "scoped"}],
                "shipments": [], "invoices": [],
            }}))
            self.store.import_data(tenant, source)
        self.server = create_server(self.directory.name, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_port
        self.cookie = None
        # Route tests must never contact ERPNext, even when configuration enables it.
        blocker = patch("server.erpnext.FrappeClient.request", side_effect=AssertionError("Unexpected external ERP request"))
        blocker.start()
        self.addCleanup(blocker.stop)

    def write_configuration(self):
        self.config_path.write_text(json.dumps(self.configuration))
        os.chmod(self.config_path, 0o600)

    def request(self, method, path, body=None, cookie=True, origin=True):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        if cookie and self.cookie:
            headers["Cookie"] = self.cookie
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, None if body is None else json.dumps(body), headers)
        response = connection.getresponse()
        raw, status = response.read(), response.status
        response_headers = dict(response.getheaders())
        connection.close()
        if "Set-Cookie" in response_headers:
            self.cookie = response_headers["Set-Cookie"].split(";", 1)[0]
        result = json.loads(raw) if "application/json" in response_headers.get("Content-Type", "") else raw.decode()
        return status, result

    def login(self, username="admin", tenant="one"):
        code, result = self.request("POST", "/api/login", {"tenantId": tenant, "username": username, "password": PASSWORD})
        self.assertEqual(code, 200, result)

    def queue(self, identifier="shared-order", expected=1, **external):
        return self.request("POST", "/api/erpnext/queue", {"orderId": identifier, "expectedVersion": expected, **external})

    def database_state(self):
        with self.store.connect() as db:
            return {table: [tuple(row) for row in db.execute("SELECT * FROM " + table + " ORDER BY rowid")]
                    for table in ("tenants", "erp_outbox", "erp_links", "audit", "snapshots")}

    def replace_synthetic_payload(self, mutate):
        """Model an imported legacy fixture without bypassing production routes."""
        with self.store.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM tenants WHERE id='one'").fetchone()[0])
            mutate(payload)
            db.execute("UPDATE tenants SET payload=? WHERE id='one'", (json.dumps(payload),))

    def test_status_document_sources_cannot_alias_authorized_order_ids(self):
        # Colons are valid technical IDs. A hidden order can share the string
        # prefix of an authorized order without becoming its child document.
        def add_valid_aliases(payload):
            payload["orders"][0].update(id="scoped-order::hidden")
            payload["customers"].append({"id": "scoped-order", "company": "Unrelated customer",
                "companyId": "C2", "createdBy": "a", "salespersonId": "a", "tenantId": "one"})
            payload["factories"].append({"id": "scoped-order", "name": "Unrelated supplier",
                "companyId": "C2", "createdBy": "a", "tenantId": "one"})
            payload["orders"].append(order("legacy-order", company="C2", owner="scoped"))
        self.replace_synthetic_payload(add_valid_aliases)
        links = [
            ("Sales Order", "scoped-order", "VISIBLE-SO", "scoped-order"),
            ("Purchase Order", "scoped-order::factory-1", "VISIBLE-PO", "scoped-order"),
            ("Sales Order", "scoped-order::hidden", "UNAUTHORIZED-SO", "scoped-order::hidden"),
            ("Purchase Order", "scoped-order::hidden::factory-1", "UNAUTHORIZED-PO", "scoped-order::hidden"),
            ("Customer", "scoped-order", "UNRELATED-CUSTOMER", None),
            ("Supplier", "scoped-order", "UNRELATED-SUPPLIER", None),
            ("Sales Order", "legacy-order", "LEGACY-NO-ORIGIN", None),
        ]
        with self.store.connect() as db:
            for index, (doctype, source_id, name, origin) in enumerate(links):
                managed = {"items": [{"sales_order": "VISIBLE-SO" if name == "VISIBLE-PO" else "UNAUTHORIZED-SO",
                                      "sales_order_item": "synthetic-item"}]} if doctype == "Purchase Order" else {}
                db.execute("INSERT INTO erp_links(tenant_id,doctype,source_id,external_id,name,modified,managed_payload,docstatus,order_id) VALUES(?,?,?,?,?,?,?,?,?)",
                    ("one", doctype, source_id, f"synthetic-alias-{index}", name, "synthetic", json.dumps(managed), 0, origin))
        self.login("scoped")
        code, result = self.request("GET", "/api/erpnext/status")
        self.assertEqual(code, 200, result)
        self.assertEqual({row["name"] for row in result["documents"]}, {"VISIBLE-SO", "VISIBLE-PO"})

    def test_erp_mapping_and_purchase_rates_are_not_returned_to_nonfinance_owner(self):
        def owned_by_sales(payload):
            payload["orders"][0].update(createdBy="b", salespersonId="b")
        self.replace_synthetic_payload(owned_by_sales)
        self.login("other-sales")
        code, result = self.request("GET", "/api/data")
        self.assertEqual(code, 200)
        record = next(row for row in result["data"]["orders"] if row["id"] == "shared-order")
        self.assertNotIn("erpItems", record)
        self.assertNotIn("purchaseRate", json.dumps(record))
        before = self.database_state()
        for mapping in ([{"id": "ERP-line-1", "itemCode": "FORGED", "quantity": 10, "saleRate": 100,
                          "purchaseRate": 999, "factoryId": "factory-1"}], [], None):
            code, result = self.request("POST", "/api/changes", {"expectedVersion": 1, "changes": [
                {"collection": "orders", "id": "shared-order", "value": {"erpItems": mapping}}]})
            self.assertEqual((code, result["code"]), (403, "FIELD_DENIED"))
        self.assertEqual(self.database_state(), before)

    def test_finance_reader_can_read_mapping_but_cannot_change_it(self):
        self.login("reader")
        code, result = self.request("GET", "/api/data")
        self.assertEqual(code, 200)
        self.assertEqual(result["data"]["orders"][0]["erpItems"][0]["purchaseRate"], 10)
        before = self.database_state()
        code, result = self.request("POST", "/api/changes", {"expectedVersion": 1, "changes": [
            {"collection": "orders", "id": "shared-order", "value": {"erpItems": []}}]})
        self.assertEqual((code, result["code"]), (403, "RECORD_DENIED"))
        self.assertEqual(self.database_state(), before)

    def test_finance_writer_can_save_valid_mapping_and_queue_new_revision(self):
        self.login("finance")
        mapping = [{"id": "ERP-line-1", "itemCode": "NEW-DEMO-ITEM", "quantity": 10,
                    "saleRate": 100, "purchaseRate": 10, "factoryId": "factory-1"}]
        code, result = self.request("POST", "/api/changes", {"expectedVersion": 1, "changes": [
            {"collection": "orders", "id": "shared-order", "value": {"erpItems": mapping}}]})
        self.assertEqual(code, 200, result)
        self.assertEqual(result["meta"]["version"], 2)
        code, result = self.queue(expected=2)
        self.assertEqual(code, 200, result)
        self.assertEqual(result["job"]["state"], "pending")
        with self.store.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM erp_outbox").fetchone()[0])
        self.assertEqual(payload["lines"][0]["itemCode"], "NEW-DEMO-ITEM")

    def test_cross_entity_erp_supplier_is_rejected_even_for_fully_granted_admin(self):
        self.login()
        code, result = self.request("POST", "/api/changes", {"expectedVersion": 1, "changes": [
            {"collection": "factories", "id": "other-entity-supplier", "value": {
                "name": "Synthetic C1 supplier", "companyId": "C1"}}]})
        self.assertEqual(code, 200, result)
        before = self.database_state()
        mapping = [{"id": "ERP-line-1", "itemCode": "DEMO-ITEM", "quantity": 10,
                    "saleRate": 100, "purchaseRate": 10, "factoryId": "other-entity-supplier"}]
        code, result = self.request("POST", "/api/changes", {"expectedVersion": 2, "changes": [
            {"collection": "orders", "id": "shared-order", "value": {"erpItems": mapping}}]})
        self.assertEqual((code, result["code"]), (403, "RELATED_RECORD_DENIED"))
        self.assertEqual(self.database_state(), before)

    def test_legacy_invalid_erp_supplier_cannot_bypass_queue_authorization(self):
        def invalid_import(payload):
            payload["factories"].append({"id": "hidden-supplier", "name": "Synthetic C1 supplier",
                                         "companyId": "C1", "createdBy": "a", "tenantId": "one"})
            payload["orders"][1]["erpItems"][0]["factoryId"] = "hidden-supplier"
        self.replace_synthetic_payload(invalid_import)
        self.login("scoped")
        before = self.database_state()
        code, result = self.queue("scoped-order")
        self.assertEqual((code, result["code"]), (403, "RELATED_RECORD_DENIED"))
        self.assertEqual(self.database_state(), before)

    def test_legacy_invalid_customer_and_deleted_supplier_cannot_be_queued(self):
        self.login()
        for field in ("foreign_customer", "deleted_supplier"):
            def invalid_import(payload):
                payload["customers"][0]["companyId"] = "C1" if field == "foreign_customer" else "C2"
                payload["factories"][0]["deleted"] = field == "deleted_supplier"
            self.replace_synthetic_payload(invalid_import)
            before = self.database_state()
            code, result = self.queue()
            self.assertEqual((code, result["code"]), (403, "RELATED_RECORD_DENIED"))
            self.assertEqual(self.database_state(), before)

    def test_routes_require_authenticated_session_and_same_origin(self):
        self.assertEqual(self.request("GET", "/api/erpnext/status")[0], 401)
        self.assertEqual(self.queue()[0], 401)
        self.login()
        self.assertEqual(self.request("POST", "/api/erpnext/queue", {"orderId": "shared-order", "expectedVersion": 1}, origin=False)[0], 403)
        self.assertEqual(self.database_state()["erp_outbox"], [])

    def test_document_and_sales_roles_cannot_read_or_queue_erp(self):
        before = self.database_state()
        for username in ("document", "sales", "manager"):
            self.login(username)
            for code, result in (self.request("GET", "/api/erpnext/status"), self.queue()):
                self.assertEqual((code, result["code"]), (403, "FINANCE_DENIED"))
        self.assertEqual(self.database_state(), before)

    def test_finance_read_without_write_cannot_queue(self):
        self.login("reader")
        self.assertEqual(self.request("GET", "/api/erpnext/status")[0], 200)
        code, result = self.queue()
        self.assertEqual((code, result["code"]), (403, "FINANCE_DENIED"))
        self.assertEqual(self.database_state()["erp_outbox"], [])

    def test_financial_capability_does_not_bypass_order_collection_grant(self):
        self.login("customer-only")
        for code, result in (self.request("GET", "/api/erpnext/status"), self.queue()):
            self.assertEqual((code, result["code"]), (403, "FINANCE_DENIED"))

    def test_authorized_finance_role_can_queue_saved_source(self):
        self.login("finance")
        code, result = self.queue()
        self.assertEqual(code, 200, result)
        self.assertEqual(result["job"]["state"], "pending")
        self.assertEqual(result["meta"]["version"], 1)
        self.assertEqual(self.request("GET", "/api/erpnext/status")[1]["jobs"], [result["job"]])

    def test_queue_uses_private_configuration_and_saved_source_only(self):
        self.login()
        code, result = self.queue(tenantId="two", baseUrl="https://attacker.invalid", site="attacker.test",
                                  apiKey="attacker-key", apiSecret="attacker-secret", doctype="User",
                                  payload={"orderAmountUSD": 1}, erpItems=[])
        self.assertEqual(code, 200, result)
        with self.store.connect() as db:
            job = db.execute("SELECT * FROM erp_outbox").fetchone()
        prepared = json.loads(job["payload"])
        self.assertEqual((job["tenant_id"], job["actor_id"], job["source_revision"]), ("one", "a", 1))
        self.assertEqual(prepared["company"]["name"], "Synthetic ERP Company one")
        self.assertEqual(prepared["order"]["orderAmountUSD"], 1000)
        self.assertEqual(prepared["customer"]["name"], "Synthetic Buyer one")
        self.assertNotIn("attacker", job["payload"])
        output = json.dumps(self.request("GET", "/api/erpnext/status")[1])
        self.assertNotIn("apiSecret", output)
        self.assertNotIn("synthetic-private", output)

    def test_same_version_queue_is_idempotent_and_does_not_change_business_revision(self):
        self.login()
        before = self.database_state()
        first, second = self.queue(), self.queue()
        self.assertEqual(first, second)
        after = self.database_state()
        self.assertEqual(len(after["erp_outbox"]), 1)
        for table in ("tenants", "snapshots", "audit"):
            self.assertEqual(after[table], before[table])

    def test_queue_rejects_stale_or_invalid_version_without_writing(self):
        self.login()
        before = self.database_state()
        for expected, wanted in ((0, (409, "VERSION_CONFLICT")), (None, (400, "EXPECTED_VERSION_REQUIRED")),
                                 (True, (400, "EXPECTED_VERSION_REQUIRED")), ("1", (400, "EXPECTED_VERSION_REQUIRED"))):
            code, result = self.queue(expected=expected)
            self.assertEqual((code, result["code"]), wanted)
        self.assertEqual(self.database_state(), before)

    def test_missing_deleted_or_unsafe_order_cannot_be_queued(self):
        self.login()
        for identifier in ("does-not-exist", "bad'identifier"):
            code, result = self.queue(identifier)
            self.assertEqual(code, 400 if "'" in identifier else 403)
        code, result = self.request("POST", "/api/changes", {"expectedVersion": 1, "changes": [{"collection": "orders", "id": "shared-order", "deleted": True}]})
        self.assertEqual(code, 200, result)
        self.assertEqual(self.queue(expected=2)[0], 403)
        self.assertEqual(self.database_state()["erp_outbox"], [])

    def test_tenants_with_identical_ids_have_separate_sites_jobs_and_status(self):
        self.login()
        first = self.queue()[1]["job"]
        self.login(tenant="two")
        self.assertEqual(self.request("GET", "/api/erpnext/status")[1]["jobs"], [])
        second = self.queue()[1]["job"]
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(self.request("GET", "/api/erpnext/status")[1]["site"], "two.test")
        self.assertEqual(self.request("GET", "/api/erpnext/status")[1]["jobs"], [second])
        self.login()
        self.assertEqual(self.request("GET", "/api/erpnext/status")[1]["jobs"], [first])

    def test_record_scope_filters_status_and_denies_other_order_queue(self):
        self.login()
        self.queue()
        own_job = self.queue("scoped-order")[1]["job"]
        self.login("scoped")
        self.assertEqual(self.request("GET", "/api/erpnext/status")[1]["jobs"], [own_job])
        self.assertEqual(self.queue()[0], 403)
        self.assertEqual(self.queue("scoped-order")[1]["job"]["id"], own_job["id"])

    def test_private_configuration_permissions_are_checked_without_leaking_secrets(self):
        self.login()
        self.assertEqual(self.config_path.stat().st_mode & 0o777, 0o600)
        before = self.database_state()
        os.chmod(self.config_path, 0o644)
        for code, result in (self.request("GET", "/api/erpnext/status"), self.queue()):
            self.assertEqual(code, 500)
            self.assertNotIn("synthetic-private", json.dumps(result))
        self.assertEqual(self.database_state(), before)

    def test_unconfigured_bridge_is_explicitly_blocked_without_remote_work(self):
        self.config_path.unlink()
        self.login()
        status = self.request("GET", "/api/erpnext/status")[1]
        self.assertFalse(status["enabled"])
        code, result = self.queue()
        self.assertEqual(code, 200)
        self.assertEqual((result["job"]["state"], result["job"]["errorCode"]), ("blocked", "NOT_CONNECTED"))

    def test_queue_exception_rolls_back_insert_and_source_is_unchanged(self):
        self.login()
        before = self.database_state()
        original = erpnext.queue_order
        def fail_after_insert(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("Synthetic failure before SQLite commit")
        with patch("server.erpnext.queue_order", side_effect=fail_after_insert):
            self.assertEqual(self.queue()[0], 500)
        self.assertEqual(self.database_state(), before)

    def test_pending_queue_prevents_restore_but_not_other_tenant_restore(self):
        self.login()
        snapshots = self.request("GET", "/api/snapshots")[1]["snapshots"]
        initial = next(item for item in snapshots if item["version"] == 0)
        self.queue()
        before = self.database_state()
        code, result = self.request("POST", "/api/restore", {"snapshotId": initial["id"], "expectedVersion": 1})
        self.assertEqual((code, result["code"]), (409, "ERP_RESTORE_REQUIRES_RECONCILIATION"))
        self.assertEqual(self.database_state(), before)
        self.login(tenant="two")
        own_initial = next(item for item in self.request("GET", "/api/snapshots")[1]["snapshots"] if item["version"] == 0)
        code, result = self.request("POST", "/api/restore", {"snapshotId": own_initial["id"], "expectedVersion": 1})
        self.assertEqual(code, 200, result)
        self.assertEqual(result["meta"]["version"], 2)

    def test_fake_erp_worker_creates_linked_drafts_and_restore_stays_guarded(self):
        self.login()
        self.queue()
        client = FakeFrappe()
        results = erpnext.run(self.store, erpnext.load_config(self.directory.name), client_factory=lambda _: client)
        self.assertEqual([row["state"] for row in results], ["synced"])
        self.assertEqual(client.creates, ["Customer", "Supplier", "Sales Order", "Purchase Order"])
        code, status = self.request("GET", "/api/erpnext/status")
        self.assertEqual(code, 200)
        self.assertEqual(status["jobs"][0]["state"], "synced")
        self.assertEqual(len(status["documents"]), 2)  # Order-scoped Sales/Purchase links only.
        with self.store.connect() as db:
            db.execute("DELETE FROM erp_outbox WHERE tenant_id='one'")
        initial = next(item for item in self.request("GET", "/api/snapshots")[1]["snapshots"] if item["version"] == 0)
        code, result = self.request("POST", "/api/restore", {"snapshotId": initial["id"], "expectedVersion": 1})
        self.assertEqual((code, result["code"]), (409, "ERP_RESTORE_REQUIRES_RECONCILIATION"))


if __name__ == "__main__":
    unittest.main()
