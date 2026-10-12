"""Real SQLite + HTTP integration checks; never connect to production."""
from concurrent.futures import ThreadPoolExecutor
import copy
import http.client
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch
import sys
import uuid

from server.app import create_server
from server.store import APIError, Store, password_ok

PASSWORD = "only-a-local-test-password"


def config():
    users = [
        {"id": "a", "username": "admin", "name": "Administrator", "role": "admin", "visibleCompanyIds": ["C1", "C2"], "password": PASSWORD},
        {"id": "f", "username": "finance", "role": "finance", "visibleCompanyIds": ["C1", "C2"], "password": PASSWORD},
        {"id": "m", "username": "manager", "role": "manager", "teamId": "A", "password": PASSWORD},
        {"id": "s", "username": "sales", "role": "salesperson", "teamId": "A", "password": PASSWORD},
        {"id": "d", "username": "document", "role": "document", "teamId": "A", "password": PASSWORD},
        {"id": "b", "username": "other-sales", "role": "salesperson", "teamId": "B", "password": PASSWORD},
    ]
    return {"tenants": [
        {"id": "one", "name": "Example One", "companies": [
            {"id": "C1", "name": "Company One", "settlementCurrency": "CNY", "profitPolicy": "grandware-v40", "exchangeRate": 7.25},
            {"id": "C2", "name": "Company Two", "settlementCurrency": "USD", "profitPolicy": "grandware-v40", "exchangeRate": 7.8}],
            "teams": {"A": {"managerId": "m", "memberIds": ["s", "d"], "visibleCompanyIds": ["C1"]}, "B": {"memberIds": ["b"], "visibleCompanyIds": ["C2"]}}, "users": users},
        {"id": "two", "name": "Example Two", "companies": [{"id": "C1", "name": "Independent Company", "settlementCurrency": "USD", "profitPolicy": "grandware-v40"}], "teams": {}, "users": [{"id": "a", "username": "admin", "role": "admin", "visibleCompanyIds": ["C1"], "password": PASSWORD}]},
    ]}


def factory_line(identifier="factory-1", **values):
    """A valid public production line, with costs supplied only by its caller."""
    return {"factoryId": identifier, "productType": "Public product", "totalQuantity": 10,
            "inspectionDate": "2026-10-20", "estimatedShipDate": "2026-10-25", **values}


def order(identifier, company="C1", owner="s", number=None):
    return {"id": identifier, "companyOperationNo": number or identifier, "companyId": company, "createdBy": owner, "salespersonId": owner, "customerId": "c", "customerOrderNo": "PO-" + identifier, "contactPerson": "Synthetic contact", "loadingPort": "Shanghai", "overseasPort": "Los Angeles", "paymentTerms": "T/T", "orderDate": "2026-10-11", "expectedShipDate": "2026-10-25", "status": "进行中", "shippingStatus": "待出运", "paymentStatus": "部分收款", "factoryPaidStatus": "未付款", "orderAmountUSD": 1000, "factoryCostRMB": 100, "freightCostUSD": 20, "insuranceCostUSD": 13, "otherCostUSD": 10, "profitRMB": 987.65, "orderAmountRMB": 1234.56, "profitRate": 88, "paidAmountUSD": 25, "factories": [factory_line(totalAmount=100, prepayment=20)]}


class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template_dir = tempfile.TemporaryDirectory(prefix="trade-service-template-")
        template = Store(cls.template_dir.name)
        template.configure(config())
        cls.template_path = template.path

    @classmethod
    def tearDownClass(cls):
        cls.template_dir.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="trade-service-test-")
        self.addCleanup(self.directory.cleanup)
        shutil.copyfile(self.template_path, Path(self.directory.name) / "workspace.sqlite3")
        self.store = Store(self.directory.name)
        self.actors = {}
        for tenant, uid in (("one", "a"), ("one", "f"), ("one", "m"), ("one", "s"), ("one", "d"), ("one", "b"), ("two", "a")):
            with self.store.connect() as db:
                profile = db.execute("SELECT profile FROM users WHERE tenant_id=? AND id=?", (tenant, uid)).fetchone()
                self.actors[(tenant, uid)] = json.loads(profile[0])

    def actor(self, uid="a", tenant="one"):
        return self.actors[(tenant, uid)]

    def revision(self, tenant="one"):
        return self.store.meta(self.actor(tenant=tenant))["meta"]["version"]

    def seed(self):
        source = Path(self.directory.name) / "business-export.json"
        source.write_text(json.dumps({"data": {"orders": [order("self"), order("team", owner="d"), order("other", company="C2", owner="b"), order("unknown", owner="legacy-unknown"), order("missing", company=None)], "customers": [{"id": "c", "company": "Example Customer", "companyId": "C1", "createdBy": "s", "salespersonId": "s"}], "factories": [{"id": "factory-1", "name": "Example Factory", "companyId": "C1", "createdBy": "s", "bankInfo": "demo bank details"}], "shipments": [{"id": "shipment", "orderId": "team", "companyId": "C1", "createdBy": "d", "salespersonId": "d"}], "invoices": []}, "exchangeRates": {"C1": 7.4, "C2": 7.8}}))
        original = source.read_bytes()
        result = self.store.import_data("one", source)
        self.assertEqual(source.read_bytes(), original)
        return result

    def patch(self, value, uid="a", identifier="self", collection="orders", expected=None):
        return self.store.changes(self.actor(uid), self.revision() if expected is None else expected, [{"collection": collection, "id": identifier, "value": value}])

    def error(self, status, code, call):
        with self.assertRaises(APIError) as raised:
            call()
        self.assertEqual(raised.exception.status, status)
        self.assertEqual(raised.exception.code, code)

    def business_state(self):
        """All persisted business/ERP side effects, for atomic rejection checks."""
        with self.store.connect() as db:
            return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                    for table in ("tenants", "audit", "snapshots", "erp_outbox", "erp_links")}

    def admin_documents(self):
        self.seed()
        self.patch({"ownerId": "d"})
        self.store.changes(self.actor(), 2, [
            {"collection": "shipments", "id": "admin-shipment", "value": {
                "companyId": "C1", "orderId": "self", "loadingPort": "Shanghai",
                "etd": "2026-10-25", "status": "待出运", "customsStatus": "未报关"}},
            {"collection": "invoices", "id": "admin-invoice", "value": {
                "companyId": "C1", "orderId": "self"}},
        ])

    def test_admin_created_documents_follow_sales_and_document_order_assignments(self):
        self.admin_documents()
        for uid in ("s", "d"):
            for collection, identifier in (("shipments", "admin-shipment"), ("invoices", "admin-invoice")):
                visible = self.store.data(self.actor(uid))["data"][collection]
                document = next(row for row in visible if row["id"] == identifier)
                self.assertEqual(document["createdBy"], "a")
                self.patch({"remarks": f"Public update by {uid}"}, uid=uid,
                           identifier=identifier, collection=collection)
                full = self.store.data(self.actor())["data"][collection]
                document = next(row for row in full if row["id"] == identifier)
                self.assertEqual(document["remarks"], f"Public update by {uid}")
                self.assertEqual(document["createdBy"], "a")
                self.assertEqual(document["updatedBy"], uid)
        self.assertEqual(self.revision(), 7)

    def test_parent_document_grants_do_not_extend_to_other_sales_or_tenants(self):
        cfg = config()
        for tenant in cfg["tenants"]:
            for user in tenant["users"]:
                user.pop("password", None)
        cfg["tenants"][0]["users"].append({"id": "outsider", "username": "outsider",
            "role": "salesperson", "visibleCompanyIds": ["C1"], "password": PASSWORD})
        self.store.configure(cfg)
        outsider = self.store.actor(self.store.login("one", "outsider", PASSWORD))
        self.admin_documents()
        before = self.business_state()
        for actor in (outsider, self.actor("b"), self.actor(tenant="two")):
            visible = self.store.data(actor)["data"]
            for collection, identifier in (("shipments", "admin-shipment"), ("invoices", "admin-invoice")):
                self.assertNotIn(identifier, {row["id"] for row in visible[collection]})
                expected = 0 if actor["tenantId"] == "two" else 3
                code = "ASSIGNMENT_DENIED" if actor["tenantId"] == "two" else "RECORD_DENIED"
                value = {"companyId": "C1", "orderId": "self", "loadingPort": "Shanghai", "etd": "2026-10-25", "remarks": "Unauthorized"}
                self.error(403, code, lambda actor=actor, expected=expected, collection=collection,
                    identifier=identifier, value=value: self.store.changes(actor, expected,
                        [{"collection": collection, "id": identifier, "value": value}]))
        self.assertEqual(self.business_state(), before)

    def test_parent_scope_does_not_bypass_document_collection_permissions(self):
        self.admin_documents()
        cfg = config()
        cfg["tenants"][0]["roles"] = {"salesperson": {"collections": ["orders"]}}
        for tenant in cfg["tenants"]:
            for user in tenant["users"]:
                user.pop("password", None)
        self.store.configure(cfg)
        before = self.business_state()
        visible = self.store.data(self.actor("s"))["data"]
        self.assertIn("self", {row["id"] for row in visible["orders"]})
        for collection, identifier in (("shipments", "admin-shipment"), ("invoices", "admin-invoice")):
            self.assertEqual(visible[collection], [])
            self.error(403, "RECORD_DENIED", lambda collection=collection, identifier=identifier:
                self.patch({"remarks": "Collection denied"}, uid="s", identifier=identifier, collection=collection))
        self.assertEqual(self.business_state(), before)

    def test_deleted_parent_denies_documents_even_if_legacy_child_remains_active(self):
        self.admin_documents()
        self.store.changes(self.actor(), 3, [{"collection": "orders", "id": "self", "deleted": True}])
        with self.store.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM tenants WHERE id='one'").fetchone()[0])
            for collection, identifier in (("shipments", "admin-shipment"), ("invoices", "admin-invoice")):
                child = next(row for row in payload[collection] if row["id"] == identifier)
                self.assertTrue(child["deleted"])
                child["deleted"] = False  # Simulate an old imported orphan, never a customer database.
            db.execute("UPDATE tenants SET payload=? WHERE id='one'", (json.dumps(payload),))
        before = self.business_state()
        for uid in ("a", "s", "d"):
            visible = self.store.data(self.actor(uid))["data"]
            for collection, identifier in (("shipments", "admin-shipment"), ("invoices", "admin-invoice")):
                self.assertNotIn(identifier, {row["id"] for row in visible[collection]})
                self.error(403, "RECORD_DENIED", lambda uid=uid, collection=collection, identifier=identifier:
                    self.patch({"remarks": "Parent deleted"}, uid=uid, identifier=identifier, collection=collection))
        self.assertEqual(self.business_state(), before)

    def test_parent_and_documents_can_be_created_in_one_atomic_batch(self):
        self.seed()
        self.store.changes(self.actor(), 1, [
            {"collection": "orders", "id": "new-parent", "value": order("new-parent")},
            {"collection": "shipments", "id": "new-shipment", "value": {
                "companyId": "C1", "orderId": "new-parent", "loadingPort": "Shanghai", "etd": "2026-10-25"}},
            {"collection": "invoices", "id": "new-invoice", "value": {"companyId": "C1", "orderId": "new-parent"}},
        ])
        visible = self.store.data(self.actor("s"))["data"]
        self.assertIn("new-parent", {row["id"] for row in visible["orders"]})
        self.assertIn("new-shipment", {row["id"] for row in visible["shipments"]})
        self.assertIn("new-invoice", {row["id"] for row in visible["invoices"]})
        self.assertEqual(self.revision(), 2)

    def test_import_refuses_any_erp_job_state_without_source_or_database_changes(self):
        self.seed()
        job = self.store.erp_queue(self.actor(), "self", 1)["job"]
        source = Path(self.directory.name) / "replacement-business.json"
        source.write_text(json.dumps({"customers": [{"id": "replacement", "companyId": "C1"}],
                                     "exchangeRates": {"C1": 99}, "rateMetas": {"C1": {"source": "replacement"}}}))
        original = source.read_bytes()
        for state in ("pending", "running", "synced", "failed", "blocked"):
            with self.subTest(state=state):
                with self.store.connect() as db:
                    db.execute("UPDATE erp_outbox SET state=? WHERE id=?", (state, job["id"]))
                before = self.business_state()
                self.error(409, "ERP_RESTORE_REQUIRES_RECONCILIATION",
                    lambda: self.store.import_data("one", source, expected=1))
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(self.business_state(), before)

    def test_import_refuses_erp_links_without_jobs_but_other_tenant_remains_independent(self):
        self.seed()
        with self.store.connect() as db:
            db.execute("INSERT INTO erp_links(tenant_id,doctype,source_id,external_id,name,modified,managed_payload,docstatus,order_id) VALUES(?,?,?,?,?,?,?,?,?)",
                       ("one", "Sales Order", "self", "synthetic-external", "SYNTHETIC-SO", "2026-10-11", "{}", 0, "self"))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM erp_outbox").fetchone()[0], 0)
        source = Path(self.directory.name) / "replacement-business.json"
        source.write_text(json.dumps({"customers": [{"id": "independent", "companyId": "C1"}]}))
        original = source.read_bytes()
        before = self.business_state()
        self.error(409, "ERP_RESTORE_REQUIRES_RECONCILIATION", lambda: self.store.import_data("one", source, expected=1))
        self.assertEqual(self.business_state(), before)
        result = self.store.import_data("two", source, expected=0)
        self.assertEqual(result["meta"]["version"], 1)
        self.assertEqual(self.revision(), 1)
        self.assertEqual(source.read_bytes(), original)
        with self.store.connect() as db:
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM erp_links ORDER BY rowid")], before["erp_links"])

    def test_passwords_private_and_random_session_not_user_id(self):
        token = self.store.login("one", "admin", PASSWORD)
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(self.store.actor(token)["id"], "a")
        self.error(401, "SESSION_REQUIRED", lambda: self.store.actor("a"))
        self.error(401, "SESSION_REQUIRED", lambda: self.store.actor("a" * 43))
        self.error(401, "INVALID_CREDENTIALS", lambda: self.store.login("one", "admin", "wrong-password"))
        text = json.dumps(self.store.session(self.actor()))
        self.assertNotIn("password", text)
        self.assertNotIn("pbkdf2", text)
        with self.store.connect() as db:
            encoded = db.execute("SELECT password FROM users WHERE tenant_id='one' AND id='a'").fetchone()[0]
        self.assertNotEqual(encoded, PASSWORD)
        self.assertTrue(password_ok(PASSWORD, encoded))
        self.store.logout(token)
        self.error(401, "SESSION_REQUIRED", lambda: self.store.actor(token))

    def test_login_lockout_is_server_side_and_allows_four_failures(self):
        for _ in range(5):
            self.error(401, "INVALID_CREDENTIALS", lambda: self.store.login("one", "admin", "wrong"))
        self.error(429, "LOGIN_LOCKED", lambda: self.store.login("one", "admin", PASSWORD))

    def test_disabled_account_revokes_session(self):
        token = self.store.login("one", "admin", PASSWORD)
        cfg = config()
        cfg["tenants"][0]["users"][0]["disabled"] = True
        self.store.configure(cfg)
        self.error(401, "SESSION_REQUIRED", lambda: self.store.actor(token))
        self.error(401, "SESSION_REQUIRED", lambda: self.store.changes(self.actor(), 0, []))
        self.error(401, "INVALID_CREDENTIALS", lambda: self.store.login("one", "admin", PASSWORD))

    def test_data_persists_in_database_after_new_store(self):
        self.seed()
        reopened = Store(self.directory.name)
        self.assertEqual(len(reopened.data(self.actor())["data"]["orders"]), 5)
        self.assertEqual(reopened.meta(self.actor())["meta"]["version"], 1)

    def test_tenants_with_identical_user_company_ids_are_isolated(self):
        self.seed()
        self.assertEqual(self.store.data(self.actor(tenant="two"))["data"]["orders"], [])
        self.error(403, "TENANT_DENIED", lambda: self.patch({"tenantId": "two"}))
        self.assertEqual(self.revision("two"), 0)

    def test_company_scope_and_unknown_legacy_ownership_fail_closed(self):
        self.seed()
        sales = self.store.data(self.actor("s"))["data"]["orders"]
        manager = self.store.data(self.actor("m"))["data"]["orders"]
        self.assertEqual([r["id"] for r in sales], ["self"])
        self.assertEqual({r["id"] for r in manager}, {"self", "team"})
        self.error(403, "RECORD_DENIED", lambda: self.patch({"remarks": "bad"}, uid="s", identifier="other"))
        self.error(403, "RECORD_DENIED", lambda: self.patch({"remarks": "bad"}, uid="s", identifier="unknown"))
        self.error(403, "COMPANY_DENIED", lambda: self.patch({"companyId": "C2"}, uid="s"))
        self.assertEqual(self.revision(), 1)

    def test_sensitive_fields_not_returned_and_modifications_rejected(self):
        self.seed()
        output = self.store.data(self.actor("s"))["data"]
        row = output["orders"][0]
        for key in ("profitRMB", "factoryCostRMB", "paidAmountUSD", "paymentStatus", "costPaymentStatus"):
            self.assertNotIn(key, row)
        self.assertNotIn("totalAmount", row["factories"][0])
        self.assertNotIn("prepayment", row["factories"][0])
        self.assertNotIn("bankInfo", output["factories"][0])
        self.error(403, "FIELD_DENIED", lambda: self.patch({"factoryCostRMB": 0}, uid="s"))
        self.error(403, "FIELD_DENIED", lambda: self.patch({"paidAmountUSD": 999}, uid="s"))
        self.assertEqual(self.revision(), 1)

    def test_public_patch_and_nested_arrays_preserve_hidden_fields(self):
        self.seed()
        self.patch({"remarks": "new note", "factories": [factory_line(productType="Changed public product")]}, uid="s")
        full = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(full["factoryCostRMB"], 100)
        self.assertEqual(full["paidAmountUSD"], 25)
        self.assertEqual(full["factories"][0]["totalAmount"], 100)
        self.assertEqual(full["profitRMB"], 987.65)  # Public notes must not rewrite historical formula values.
        self.assertEqual(full["factories"][0]["productType"], "Changed public product")
        self.error(403, "FIELD_DENIED", lambda: self.patch({"factories": []}, uid="s"))

    def test_server_derived_profit_uses_imported_rate_and_company_policy(self):
        self.seed()
        self.patch({"orderAmountUSD": 2000, "profitRMB": -999999, "orderAmountRMB": -42})
        row = self.store.data(self.actor())["data"]["orders"][0]
        expected = 2000 * 7.4 - 100 - 20 - 10 + 100 / 1.13 * .13
        self.assertEqual(row["orderAmountRMB"], 14800)
        self.assertEqual(row["profitRMB"], round(expected, 2))
        self.patch({"orderAmountUSD": 2000}, identifier="other")
        other = next(r for r in self.store.data(self.actor())["data"]["orders"] if r["id"] == "other")
        self.assertEqual(other["profitRMB"], 1890)

    def test_two_concurrent_changes_exactly_one_commits(self):
        self.seed()
        barrier = threading.Barrier(2)
        def write(note):
            barrier.wait()
            try:
                self.patch({"remarks": note}, expected=1)
                return 200
            except APIError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            codes = list(pool.map(write, ("A", "B")))
        self.assertEqual(sorted(codes), [200, 409])
        self.assertEqual(self.revision(), 2)

    def test_atomic_batch_rolls_back_earlier_changes_on_failure(self):
        self.seed()
        self.error(403, "RECORD_DENIED", lambda: self.store.changes(self.actor("s"), 1, [{"collection": "orders", "id": "self", "value": {"remarks": "first change"}}, {"collection": "orders", "id": "other", "value": {"remarks": "forbidden"}}]))
        row = self.store.data(self.actor())["data"]["orders"][0]
        self.assertNotIn("remarks", row)
        self.assertEqual(self.revision(), 1)

    def test_soft_delete_snapshot_restore_creates_new_revision(self):
        initial = self.seed()
        self.store.changes(self.actor(), 1, [{"collection": "orders", "id": "self", "deleted": True}])
        self.assertNotIn("self", {r["id"] for r in self.store.data(self.actor())["data"]["orders"]})
        self.error(409, "RECORD_DELETED", lambda: self.patch({"remarks": "no resurrection"}))
        self.error(409, "VERSION_CONFLICT", lambda: self.store.restore(self.actor(), initial["snapshotId"], 1))
        restored = self.store.restore(self.actor(), initial["snapshotId"], 2)
        self.assertEqual(restored["meta"]["version"], 3)
        self.assertIn("self", {r["id"] for r in self.store.data(self.actor())["data"]["orders"]})
        with self.store.connect() as db:
            audit = db.execute("SELECT kind,summary FROM audit WHERE tenant_id='one' ORDER BY revision DESC LIMIT 1").fetchone()
        self.assertEqual(audit["kind"], "restore")
        self.assertIn(initial["snapshotId"], audit["summary"])

    def test_snapshot_restore_cannot_cross_tenant_or_finance_permissions(self):
        initial = self.seed()
        self.error(404, "SNAPSHOT_NOT_FOUND", lambda: self.store.restore(self.actor(tenant="two"), initial["snapshotId"], 0))
        self.error(403, "RESTORE_DENIED", lambda: self.store.restore(self.actor("f"), initial["snapshotId"], 1))
        self.error(403, "SNAPSHOT_DENIED", lambda: self.store.snapshots(self.actor("s")))
        self.assertEqual(len(self.store.snapshots(self.actor(tenant="two"))["snapshots"]), 1)

    def test_duplicate_number_is_case_insensitive_per_company_including_soft_deleted(self):
        self.seed()
        self.store.changes(self.actor(), 1, [{"collection": "orders", "id": "self", "deleted": True}])
        new_order = order("new", number="  SELF  ")
        self.error(409, "DUPLICATE_ORDER_NUMBER", lambda: self.store.changes(self.actor(), 2, [{"collection": "orders", "id": "new", "value": new_order}]))
        self.assertEqual(self.revision(), 2)
        new_order["companyId"] = "C2"
        new_order["customerId"] = "c2"
        new_order["factories"] = []
        self.store.changes(self.actor(), 2, [{"collection": "customers", "id": "c2", "value": {"company": "Second customer", "companyId": "C2"}}, {"collection": "orders", "id": "new", "value": new_order}])
        self.assertEqual(self.revision(), 3)

    def test_finance_has_no_delete_and_document_can_create_own_customer(self):
        self.seed()
        self.error(403, "RECORD_DENIED", lambda: self.store.changes(self.actor("f"), 1, [{"collection": "orders", "id": "self", "deleted": True}]))
        self.store.changes(self.actor("d"), 1, [{"collection": "customers", "id": "new-c", "value": {"company": "Demo customer", "companyId": "C1"}}])
        visible = self.store.data(self.actor("d"))["data"]["customers"]
        self.assertEqual([r["id"] for r in visible], ["new-c"])
        self.error(403, "RECORD_DENIED", lambda: self.store.changes(self.actor("d"), 2, [{"collection": "customers", "id": "new-c", "deleted": True}]))

    def test_server_assigns_actor_and_validates_created_by_and_amounts(self):
        self.seed()
        self.error(403, "IMMUTABLE_FIELD", lambda: self.patch({"createdBy": "a"}, uid="s"))
        self.error(400, "INVALID_AMOUNT", lambda: self.patch({"orderAmountUSD": -1}))
        self.error(403, "ASSIGNMENT_DENIED", lambda: self.patch({"salespersonId": "b"}, uid="s"))
        self.assertEqual(self.revision(), 1)

    def test_exchange_rates_authorized_and_do_not_recalculate_history(self):
        self.seed()
        self.error(403, "RATE_DENIED", lambda: self.store.changes(self.actor("s"), 1, [], {"C1": 8}))
        self.store.changes(self.actor("f"), 1, [], {"C1": 8.1}, {"C1": {"source": "manual", "isAuto": False}})
        row = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(row["profitRMB"], 987.65)
        self.assertEqual(self.store.data(self.actor())["exchangeRates"]["C1"], 8.1)
        self.error(400, "INVALID_RATE", lambda: self.store.changes(self.actor(), 2, [], {"C1": 0}))

    def test_configurable_roles_and_no_team_fail_closed(self):
        cfg = config()
        cfg["tenants"][0]["roles"] = {"reviewer": {"baseRole": "document", "scope": "self", "permissions": ["read"], "pages": ["dashboard", "orders"]}}
        cfg["tenants"][0]["users"][3]["role"] = "reviewer"
        cfg["tenants"][0]["users"][3].pop("teamId")
        cfg["tenants"][0]["users"][3]["visibleCompanyIds"] = ["C1"]
        self.store.configure(cfg)
        token = self.store.login("one", "sales", PASSWORD)
        session = self.store.session(self.store.actor(token))
        self.assertEqual(session["user"]["baseRole"], "document")
        self.assertEqual(session["user"]["permissions"], ["read"])
        self.assertEqual(session["user"]["pages"], ["dashboard", "orders"])
        self.assertEqual(len(session["companies"]), 1)
        cfg["tenants"][0]["users"][3].pop("visibleCompanyIds")
        for tenant in cfg["tenants"]:
            for user in tenant["users"]:
                user.pop("password", None)
        self.store.configure(cfg)
        self.assertEqual(self.store.session(self.store.actor(token))["companies"], [])
        cfg["tenants"][0]["roles"]["reviewer"]["pages"] = "orders"
        with self.assertRaisesRegex(ValueError, "pages must be an array"):
            self.store.configure(cfg)

    def test_runtime_permissions_and_generated_credentials(self):
        self.assertEqual(os.stat(self.store.path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.directory.name).st_mode & 0o777, 0o700)
        cfg = config()
        for tenant in cfg["tenants"]:
            for user in tenant["users"]:
                user.pop("password")
        # Existing passwords are preserved, not reset by reconfiguration.
        self.assertEqual(self.store.configure(cfg), 0)
        cfg["tenants"][1]["users"].append({"id": "new-admin", "username": "new-admin", "role": "admin", "visibleCompanyIds": ["C1"]})
        self.assertEqual(self.store.configure(cfg), 1)
        secret_path = Path(self.directory.name) / "demo-credentials.json"
        self.assertEqual(secret_path.stat().st_mode & 0o777, 0o600)
        self.assertGreaterEqual(len(json.loads(secret_path.read_text())[0]["password"]), 20)

    def test_references_cannot_guess_missing_or_other_company_records(self):
        self.seed()
        self.error(403, "RELATED_RECORD_DENIED", lambda: self.patch({"customerId": "does-not-exist"}, uid="s"))
        self.error(403, "RELATED_RECORD_DENIED", lambda: self.patch({"factoryIds": ["does-not-exist"]}, uid="s"))
        self.store.changes(self.actor(), 1, [{"collection": "customers", "id": "foreign-c", "value": {"company": "Other company customer", "companyId": "C2", "salespersonId": "b"}}])
        self.error(403, "RELATED_RECORD_DENIED", lambda: self.patch({"customerId": "foreign-c"}, uid="s"))
        self.error(403, "ASSIGNMENT_DENIED", lambda: self.store.changes(self.actor("s"), 2, [{"collection": "shipments", "id": "fake-link", "value": {"companyId": "C1", "orderId": "other", "loadingPort": "Shanghai", "etd": "2026-10-25"}}]))

    def test_unknown_nested_costs_and_embedded_financial_fields_protected(self):
        self.seed()
        self.patch({"factories": [factory_line(totalAmount=100, prepayment=20, paidCostEUR=33)], "financialSummary": {"profitUSD": 123, "note": "Public note"}})
        row = self.store.data(self.actor("s"))["data"]["orders"][0]
        self.assertNotIn("paidCostEUR", row["factories"][0])
        self.assertNotIn("profitUSD", row["financialSummary"])
        self.error(403, "FIELD_DENIED", lambda: self.patch({"financialSummary": {"profitUSD": 0}}, uid="s"))
        self.patch({"factories": [factory_line(productType="New public label")], "financialSummary": {"note": "Updated public note"}}, uid="s")
        full = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(full["factories"][0]["paidCostEUR"], 33)
        self.assertEqual(full["financialSummary"]["profitUSD"], 123)

    def test_factory_reads_are_shared_only_inside_authorized_entities(self):
        self.seed()
        self.store.changes(self.actor(), 1, [
            {"collection": "factories", "id": "admin-factory", "value": {"name": "Shared public supplier", "companyId": "C1", "bankInfo": "Hidden supplier details"}},
            {"collection": "factories", "id": "outside-factory", "value": {"name": "Other entity supplier", "companyId": "C2"}},
        ])
        for uid in ("s", "d", "m"):
            visible = self.store.data(self.actor(uid))["data"]["factories"]
            self.assertEqual({f["id"] for f in visible}, {"factory-1", "admin-factory"})
            self.assertNotIn("bankInfo", next(f for f in visible if f["id"] == "admin-factory"))
        self.assertEqual(self.store.data(self.actor(tenant="two"))["data"]["factories"], [])
        self.error(403, "RECORD_DENIED", lambda: self.patch({"name": "Unauthorized"}, uid="s", identifier="admin-factory", collection="factories"))
        self.error(403, "RECORD_DENIED", lambda: self.store.changes(self.actor("s"), 2, [{"collection": "factories", "id": "admin-factory", "deleted": True}]))
        self.patch({"factories": [factory_line("admin-factory", productType="New public supplier")]})
        # Read override is an explicit role configuration, not a client role-name switch.
        cfg = config()
        cfg["tenants"][0]["roles"] = {"salesperson": {"readScopes": {"factories": "self"}}}
        for tenant in cfg["tenants"]:
            for user in tenant["users"]:
                user.pop("password", None)
        self.store.configure(cfg)
        self.assertEqual({f["id"] for f in self.store.data(self.actor("s"))["data"]["factories"]}, {"factory-1"})

    def test_duplicate_factory_lines_cannot_copy_hidden_costs(self):
        self.seed()
        self.error(400, "DUPLICATE_FACTORY_ENTRY", lambda: self.patch({"factories": [{"factoryId": "factory-1"}, {"factoryId": "factory-1"}]}, uid="s"))
        full = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(len(full["factories"]), 1)
        self.assertEqual(full["factories"][0]["totalAmount"], 100)
        self.assertEqual(full["profitRMB"], 987.65)
        self.assertEqual(self.revision(), 1)

    def test_protected_container_cannot_be_replaced_by_null_or_scalar(self):
        self.seed()
        self.patch({"financialSummary": {"profitUSD": 123, "note": "Visible note"}})
        for replacement in (None, "replace object", 0, [], {"profitUSD": None}):
            self.error(403, "FIELD_DENIED", lambda replacement=replacement: self.patch({"financialSummary": replacement}, uid="s"))
        self.assertEqual(self.revision(), 2)
        full = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(full["financialSummary"]["profitUSD"], 123)

    def test_unknown_protected_array_cannot_be_reordered_or_trimmed(self):
        self.seed()
        self.patch({"financialSummary": [{"id": "a", "profitUSD": 100}, {"id": "b", "profitUSD": 200}]})
        for value in ([{"id": "b"}, {"id": "a"}], [{"id": "a"}], None):
            self.error(403, "FIELD_DENIED", lambda value=value: self.patch({"financialSummary": value}, uid="s"))
        full = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(full["financialSummary"], [{"id": "a", "profitUSD": 100}, {"id": "b", "profitUSD": 200}])
        self.assertEqual(self.revision(), 2)

    def test_factory_nested_sensitive_fields_are_guarded_and_omissions_preserved(self):
        self.seed()
        self.patch({"factories": [factory_line(totalAmount=100, prepayment=20, details={"bankAccount": "Private bank", "cost": 55, "note": "Visible note"})]})
        public = self.store.data(self.actor("s"))["data"]["orders"][0]["factories"][0]
        self.assertEqual(public["details"], {"note": "Visible note"})
        for details in ({"bankAccount": "Unauthorized"}, {"cost": 0}, None):
            self.error(403, "FIELD_DENIED", lambda details=details: self.patch({"factories": [{"factoryId": "factory-1", "details": details}]}, uid="s"))
        self.patch({"factories": [factory_line(productType="Updated public label")]}, uid="s")
        full = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(full["factories"][0]["details"]["bankAccount"], "Private bank")
        self.assertEqual(full["factories"][0]["details"]["cost"], 55)
        self.error(403, "FIELD_DENIED", lambda: self.patch({"factories": [{"factoryId": "factory-1", "details": {"nested": {"bankAccount": "New hidden value"}}}]}, uid="s"))

    def test_public_factory_reordering_does_not_recalculate_historical_profit(self):
        self.seed()
        with self.store.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM tenants WHERE id='one'").fetchone()[0])
            payload["factories"].append({"id": "factory-2", "companyId": "C1", "createdBy": "a", "tenantId": "one"})
            payload["orders"][0]["factories"].append(factory_line("factory-2", productType="Second line", totalAmount=200))
            db.execute("UPDATE tenants SET payload=? WHERE id='one'", (json.dumps(payload),))
        self.patch({"factories": [factory_line("factory-2", productType="Second line"), factory_line(productType="First line")]}, uid="s")
        full = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(full["profitRMB"], 987.65)
        self.assertEqual(full["factories"][0]["totalAmount"], 200)
        self.assertEqual(full["factories"][1]["totalAmount"], 100)

    def test_order_reference_legal_entity_consistency_and_entity_changes_recheck_links(self):
        self.seed()
        self.store.changes(self.actor(), 1, [
            {"collection": "customers", "id": "customer-2", "value": {"company": "Second entity", "companyId": "C2"}},
            {"collection": "factories", "id": "factory-2", "value": {"name": "Second entity", "companyId": "C2"}},
        ])
        for patch_value in ({"customerId": "customer-2"}, {"factoryIds": ["factory-2"]}, {"factories": [factory_line("factory-2")]}, {"companyId": "C2"}):
            self.error(403, "RELATED_RECORD_DENIED", lambda patch_value=patch_value: self.patch(patch_value))
        self.assertEqual(self.revision(), 2)
        self.patch({"companyId": "C2", "customerId": "customer-2", "factories": [factory_line("factory-2")]})
        self.assertEqual(self.store.data(self.actor())["data"]["orders"][0]["companyId"], "C2")

    def test_historical_cross_entity_edits_preserve_finance_but_new_links_entity_and_erp_stay_strict(self):
        """Grandware-shaped legacy references, using wholly fictional records."""
        legacy = order("legacy-production", company="C2", owner="b")
        legacy.update(customerId="customer-2", factoryCostRMB=150,
            factories=[factory_line("historical-factory", totalAmount=100, prepayment=20),
                       factory_line("local-factory", totalAmount=50, prepayment=10)],
            erpItems=[{"id": "legacy-line", "itemCode": "SYNTHETIC-A", "quantity": 10,
                       "saleRate": 50, "purchaseRate": 10, "factoryId": "historical-factory"},
                      {"id": "local-line", "itemCode": "SYNTHETIC-B", "quantity": 10,
                       "saleRate": 50, "purchaseRate": 5, "factoryId": "local-factory"}])
        legacy_customer = order("legacy-customer", company="C2", owner="b")
        legacy_customer.update(customerId="historical-customer",
            factories=[factory_line("local-factory", totalAmount=100, prepayment=20)],
            erpItems=[{"id": "customer-line", "itemCode": "SYNTHETIC-A", "quantity": 10,
                       "saleRate": 100, "purchaseRate": 10, "factoryId": "local-factory"}])
        source = Path(self.directory.name) / "fictional-legacy-business.json"
        source.write_text(json.dumps({"data": {
            "orders": [legacy, legacy_customer],
            "customers": [{"id": "customer-2", "company": "Local customer", "companyId": "C2", "createdBy": "b"},
                          {"id": "historical-customer", "company": "Historical customer", "companyId": "C1", "createdBy": "s"},
                          {"id": "other-foreign-customer", "company": "New foreign customer", "companyId": "C1", "createdBy": "s"}],
            "factories": [{"id": "historical-factory", "name": "Historical supplier", "companyId": "C1", "createdBy": "s"},
                          {"id": "other-foreign-factory", "name": "New foreign supplier", "companyId": "C1", "createdBy": "s"},
                          {"id": "local-factory", "name": "Local supplier", "companyId": "C2", "createdBy": "b"}],
            "shipments": [], "invoices": []}}))
        original = source.read_bytes()
        self.store.import_data("one", source)
        self.assertEqual(source.read_bytes(), original)
        public = self.store.data(self.actor("b"))["data"]
        self.assertNotIn("historical-factory", {row["id"] for row in public["factories"]})
        old = copy.deepcopy(self.store.data(self.actor())["data"]["orders"][0])
        self.patch({"remarks": "Continue historical production",
                    "factories": [factory_line("historical-factory", totalQuantity=12, inspectionDate="2026-10-21"),
                                  factory_line("local-factory")]}, uid="b", identifier="legacy-production")
        updated = self.store.data(self.actor())["data"]["orders"][0]
        self.assertEqual(updated["factories"][0]["totalQuantity"], 12)
        self.assertEqual(updated["factories"][0]["inspectionDate"], "2026-10-21")
        for key in ("factoryCostRMB", "paidAmountUSD", "profitRMB", "orderAmountRMB", "profitRate", "erpItems"):
            self.assertEqual(updated[key], old[key])
        for index in (0, 1):
            for key in ("totalAmount", "prepayment"):
                self.assertEqual(updated["factories"][index][key], old["factories"][index][key])
        self.patch({"customerId": "historical-customer", "remarks": "Retain historical customer"},
                   uid="b", identifier="legacy-customer")
        before = self.business_state()
        for identifier, value in (
            ("legacy-production", {"factories": [factory_line("other-foreign-factory", totalAmount=100, prepayment=20),
                                                  factory_line("local-factory", totalAmount=50, prepayment=10)]}),
            # The old local supplier becomes foreign after this entity change.
            # Keeping both supplier IDs must not bypass revalidation.
            ("legacy-production", {"companyId": "C1", "customerId": "historical-customer"}),
            ("legacy-production", {"companyId": "C2"}),
            ("legacy-customer", {"customerId": "other-foreign-customer"}),
        ):
            with self.subTest(identifier=identifier, value=value):
                self.error(403, "RELATED_RECORD_DENIED", lambda identifier=identifier, value=value:
                    self.patch(value, identifier=identifier))
                self.assertEqual(self.business_state(), before)
        # A fully configured, otherwise valid USD mapping is still forbidden:
        # legacy editing compatibility is never an ERP authorization grant.
        configuration = {"tenants": {"one": {"enabled": True, "baseUrl": "http://127.0.0.1:3999",
            "site": "fictional.test", "apiKey": "fictional-key", "apiSecret": "fictional-secret",
            "companies": {"C2": {"name": "Fictional Trade", "currency": "USD"}}}}}
        path = Path(self.directory.name) / "erpnext.json"
        path.write_text(json.dumps(configuration))
        path.chmod(0o600)
        for identifier in ("legacy-production", "legacy-customer"):
            with self.subTest(erp_order=identifier):
                self.error(403, "RELATED_RECORD_DENIED", lambda identifier=identifier:
                    self.store.erp_queue(self.actor(), identifier, 3))
                self.assertEqual(self.business_state(), before)
        self.assertEqual(self.revision(), 3)

    def test_orders_with_shipping_or_invoice_history_cannot_change_legal_entity(self):
        self.seed()
        self.store.changes(self.actor(), 1, [
            {"collection": "customers", "id": "customer-2", "value": {"company": "Second entity", "companyId": "C2"}},
            {"collection": "invoices", "id": "invoice-self", "value": {"companyId": "C1", "orderId": "self"}},
        ])
        for identifier in ("self", "team"):
            self.error(409, "LEGAL_ENTITY_MIGRATION_REQUIRED", lambda identifier=identifier: self.patch({"companyId": "C2", "customerId": "customer-2", "factories": []}, identifier=identifier))
        self.assertEqual(self.revision(), 2)
        full = self.store.data(self.actor())["data"]
        self.assertEqual(next(r for r in full["shipments"] if r["id"] == "shipment")["companyId"], "C1")
        self.assertEqual(next(r for r in full["invoices"] if r["id"] == "invoice-self")["companyId"], "C1")

    def test_whole_tenant_restore_requires_every_company_grant(self):
        initial = self.seed()
        self.patch({"remarks": "Second entity latest state"}, identifier="other")
        cfg = config()
        cfg["tenants"][0]["users"][0]["visibleCompanyIds"] = ["C1"]
        for tenant in cfg["tenants"]:
            for user in tenant["users"]:
                user.pop("password", None)
        self.store.configure(cfg)
        self.error(403, "RESTORE_DENIED", lambda: self.store.restore(self.actor(), initial["snapshotId"], 2))
        self.assertEqual(self.revision(), 2)
        with self.store.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM tenants WHERE id='one'").fetchone()[0])
        self.assertEqual(next(r for r in payload["orders"] if r["id"] == "other")["remarks"], "Second entity latest state")

    def test_tenant_scope_requires_explicit_company_grants(self):
        self.seed()
        cfg = config()
        cfg["tenants"][0]["users"][0].pop("visibleCompanyIds")
        for tenant in cfg["tenants"]:
            for user in tenant["users"]:
                user.pop("password", None)
        self.store.configure(cfg)
        actor = self.store.actor(self.store.login("one", "admin", PASSWORD))
        self.assertEqual(self.store.session(actor)["companies"], [])
        self.assertEqual(self.store.data(actor)["data"]["orders"], [])
        self.assertEqual(self.store.data(actor)["exchangeRates"], {})
        self.error(403, "COMPANY_DENIED", lambda: self.store.changes(actor, 1, [{"collection": "customers", "id": "new-customer", "value": {"companyId": "C1"}}]))

    def test_unsafe_record_ids_are_rejected_and_roll_back_the_entire_batch(self):
        self.seed()
        for identifier in ("bad'quote", 'bad"quote', "bad\\slash", "bad<element>", "bad\ncontrol", "", "a" * 201):
            self.error(400, "INVALID_RECORD_ID", lambda identifier=identifier: self.store.changes(self.actor(), 1, [
                {"collection": "customers", "id": "valid-before-error", "value": {"companyId": "C1", "company": "First pending change"}},
                {"collection": "customers", "id": identifier, "value": {"companyId": "C1", "company": "Second pending change"}},
            ]))
        self.assertEqual(self.revision(), 1)
        self.assertNotIn("valid-before-error", {r["id"] for r in self.store.data(self.actor())["data"]["customers"]})
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM audit WHERE tenant_id='one'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM snapshots WHERE tenant_id='one'").fetchone()[0], 2)
        identifiers = ("C001", "GW-2026.10:订单_01", str(uuid.uuid4()))
        self.store.changes(self.actor(), 1, [{"collection": "customers", "id": rid, "value": {"companyId": "C1", "company": "Display names may contain 'quotes' and <markup>"}} for rid in identifiers])
        self.assertTrue(set(identifiers).issubset({r["id"] for r in self.store.data(self.actor())["data"]["customers"]}))

    def test_unsafe_embedded_contact_and_factory_ids_are_rejected(self):
        self.seed()
        self.error(400, "INVALID_RECORD_ID", lambda: self.patch({"contacts": [{"id": "contact');alert(1);//", "name": "Display name"}]}, uid="s", identifier="c", collection="customers"))
        self.error(400, "INVALID_RECORD_ID", lambda: self.patch({"factories": [{"factoryId": "factory-1'", "productType": "Display label"}]}, uid="s"))
        self.assertEqual(self.revision(), 1)
        self.patch({"contacts": [{"id": "contact_01-legacy", "name": "Free text 'name'"}]}, uid="s", identifier="c", collection="customers")
        contact = self.store.data(self.actor("s"))["data"]["customers"][0]["contacts"][0]
        self.assertEqual(contact["id"], "contact_01-legacy")

    def test_import_refuses_unsafe_ids_without_changing_source_or_database(self):
        for identifier, nested in (("bad'record", None), ("safe-record", "bad'contact"), ("safe-record", "bad\\contact")):
            record = {"id": identifier, "companyId": "C1", "createdBy": "s"}
            if nested:
                record["contacts"] = [{"id": nested, "name": "Synthetic contact"}]
            source = Path(self.directory.name) / "unsafe-import.json"
            source.write_text(json.dumps({"customers": [record]}))
            before = source.read_bytes()
            with self.assertRaisesRegex(ValueError, "unsafe characters"):
                self.store.import_data("one", source)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(self.revision(), 0)
        source.write_text(json.dumps({"customers": [{"id": "C001", "companyId": "C1", "contacts": [{"id": str(uuid.uuid4())}]}]}))
        self.store.import_data("one", source)
        self.assertEqual(self.revision(), 1)

    def test_password_configuration_revokes_existing_session_and_expiry_checked(self):
        token = self.store.login("one", "admin", PASSWORD)
        self.store.configure(config())
        self.error(401, "SESSION_REQUIRED", lambda: self.store.actor(token))
        fresh = self.store.login("one", "admin", PASSWORD)
        with self.store.connect() as db:
            db.execute("UPDATE sessions SET expires=0")
        self.error(401, "SESSION_REQUIRED", lambda: self.store.actor(fresh))

    def test_snapshot_finance_metadata_denied_and_missing_expected_version_rejected(self):
        self.seed()
        self.error(403, "SNAPSHOT_DENIED", lambda: self.store.snapshots(self.actor("f")))
        self.error(400, "EXPECTED_VERSION_REQUIRED", lambda: self.store.changes(self.actor(), None, []))
        self.error(400, "EXPECTED_VERSION_REQUIRED", lambda: self.store.changes(self.actor(), True, []))
        self.error(403, "IMMUTABLE_FIELD", lambda: self.patch({"profitPolicy": "fake-policy"}))

    @unittest.skipUnless(sys.platform == "darwin", "macOS mount table check")
    def test_network_runtime_is_refused_even_if_chmod_reports_private_mode(self):
        mount = str(Path(self.directory.name).resolve())
        with patch("server.store.subprocess.check_output", return_value=f"example:/share on {mount} (smbfs, local)\n"):
            with self.assertRaisesRegex(RuntimeError, "not a network share"):
                Store(self.directory.name)


class HTTPTest(ServiceTest):
    # Avoid duplicating inherited unit tests in unittest discovery.
    def setUp(self):
        super().setUp()
        self.server = create_server(self.directory.name, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_port
        self.cookie = None

    def request(self, method, path, body=None, origin=True, cookie=True, extra_headers=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        if cookie and self.cookie:
            headers["Cookie"] = self.cookie
        headers.update(extra_headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request(method, path, None if body is None else json.dumps(body), headers)
        response = connection.getresponse()
        data = response.read()
        result_headers = dict(response.getheaders())
        code = response.status
        connection.close()
        if "Set-Cookie" in result_headers:
            self.cookie = result_headers["Set-Cookie"].split(";")[0]
        value = json.loads(data) if "application/json" in result_headers.get("Content-Type", "") else data.decode(errors="replace")
        return code, value, result_headers

    def sign_in(self):
        result = self.request("POST", "/api/login", {"tenantId": "one", "username": "admin", "password": PASSWORD})
        self.assertEqual(result[0], 200)
        return result

    def test_http_login_cookie_session_and_logout(self):
        self.assertEqual(self.request("GET", "/api/session")[0], 401)
        _, _, headers = self.sign_in()
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        code, session, _ = self.request("GET", "/api/session")
        self.assertEqual(code, 200)
        self.assertEqual(session["tenant"]["id"], "one")
        self.assertNotIn("password", json.dumps(session))
        self.assertEqual(self.request("POST", "/api/logout", {})[0], 200)
        self.assertEqual(self.request("GET", "/api/session")[0], 401)

    def test_http_csrf_host_and_fake_cookie_denied(self):
        self.sign_in()
        self.assertEqual(self.request("POST", "/api/changes", {"expectedVersion": 0, "changes": []}, origin=False)[0], 403)
        self.assertEqual(self.request("POST", "/api/changes", {"expectedVersion": 0, "changes": []}, extra_headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/data", extra_headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/data", extra_headers={"Cookie": "trade_session=U001"})[0], 401)

    def test_http_data_changes_cas_snapshots_restore(self):
        self.sign_in()
        code, result, _ = self.request("GET", "/api/data")
        self.assertEqual(code, 200)
        self.assertIn("orders", result["data"])
        change = {"expectedVersion": 0, "changes": [{"collection": "customers", "id": "c1", "value": {"company": "Demo", "companyId": "C1"}}]}
        self.assertEqual(self.request("POST", "/api/changes", change)[0], 200)
        code, conflict, _ = self.request("POST", "/api/changes", change)
        self.assertEqual(code, 409)
        self.assertEqual(conflict["latestVersion"], 1)
        snapshots = self.request("GET", "/api/snapshots")[1]["snapshots"]
        initial = next(s for s in snapshots if s["version"] == 0)
        code, restored, _ = self.request("POST", "/api/restore", {"snapshotId": initial["id"], "expectedVersion": 1})
        self.assertEqual(code, 200)
        self.assertEqual(restored["meta"]["version"], 2)
        self.assertEqual(self.request("GET", "/api/data")[1]["data"]["customers"], [])

    def test_http_static_allowlist_blocks_private_files_and_traversal(self):
        for path in ("/server/runtime/demo-credentials.json", "/server/config.example.json", "/cloudfunctions/customLogin/index.js", "/docs/REVIEW-IDENTITY.md", "/tests/auth.test.js", "/js/cloudbase-sdk.js", "/js/tcb.js", "/js/../server/store.py", "/assets/%2e%2e/server/store.py", "/", "/sw.js"):
            code = self.request("GET", path)[0]
            self.assertEqual(code, 200 if path == "/" else 404, path)
        self.assertEqual(self.request("GET", "/js/app.js")[0], 200)
        self.assertEqual(self.request("GET", "/css/design-v1.css")[0], 200)
        self.assertEqual(self.request("GET", "/vendor/chart.umd.min.js")[0], 200)

    def test_http_concurrent_writes_return_conflict_without_retry(self):
        self.sign_in()
        barrier = threading.Barrier(2)
        def write(identifier):
            barrier.wait()
            return self.request("POST", "/api/changes", {"expectedVersion": 0, "changes": [{"collection": "customers", "id": identifier, "value": {"company": identifier, "companyId": "C1"}}]})[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(write, ("customer-a", "customer-b"))), [200, 409])
        self.assertEqual(self.request("GET", "/api/meta")[1]["meta"]["version"], 1)


# unittest normally inherits methods; HTTP fixtures need only their own tests.
for _name in tuple(name for name in ServiceTest.__dict__ if name.startswith("test_")):
    setattr(HTTPTest, _name, None)

if __name__ == "__main__":
    unittest.main()
