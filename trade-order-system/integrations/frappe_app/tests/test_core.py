"""Fast domain/contract checks; real Frappe acceptance is run separately."""
import copy
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tradept_core.domain import APIError, DEFAULT_ROLES, Rules, validate_embedded_ids
from tradept_core.schema import ORDER, CUSTOMER, FACTORY_LINE, SHIPMENT, encode, decode, child_encode, child_decode, dumps
from tradept_core.validation import validate_order, validate_shipment


class Row(SimpleNamespace):
    def get(self, key, default=None):
        return getattr(self, key, default)


def fake_frappe():
    class ValidationError(Exception):
        pass
    class QueryDeadlockError(Exception):
        pass
    return SimpleNamespace(whitelist=lambda **kwargs: lambda fn: fn, flags=Row(), session=Row(user="user@example.invalid"), local=Row(site="isolated.test", response={}, request=Row(method="POST")), db=Mock(), get_doc=Mock(), get_all=Mock(), sessions=Row(get_csrf_token=lambda: "native-test-token"), ValidationError=ValidationError, QueryDeadlockError=QueryDeadlockError, PermissionError=PermissionError, utils=Row(strip_html=lambda s: s, today=lambda: "2026-10-12"))


class RuleTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {"id": "a", "companies": [{"id": "C1", "settlementCurrency": "CNY", "profitPolicy": "grandware-v40", "exchangeRate": 6.69}, {"id": "C2", "settlementCurrency": "USD", "profitPolicy": "generic-native", "exchangeRate": 7}], "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {"T": {"visibleCompanyIds": ["C1"]}}}
        self.admin = {"id": "U1", "tenantId": "a", "role": "admin", "visibleCompanyIds": ["C1", "C2"]}
        self.sales = {"id": "U2", "tenantId": "a", "role": "salesperson", "teamId": "T"}
        self.others = {"id": "U3", "tenantId": "a", "role": "salesperson", "teamId": "Other"}
        self.rules = Rules(self.cfg, {"U1": self.admin, "U2": self.sales, "U3": self.others})

    def test_self_scope_and_explicit_entity_grants(self):
        self.assertTrue(self.rules.record_allowed(None, self.cfg, self.sales, {"tenantId": "a", "companyId": "C1", "salespersonId": "U2"}, collection="orders"))
        self.assertFalse(self.rules.record_allowed(None, self.cfg, self.sales, {"companyId": "C2", "salespersonId": "U2"}, collection="orders"))
        self.assertFalse(self.rules.record_allowed(None, self.cfg, self.sales, {"companyId": "C1", "salespersonId": "U3"}, collection="orders"))

    def test_missing_historical_creator_not_replaced_by_current_user(self):
        self.assertFalse(self.rules.record_allowed(None, self.cfg, self.sales, {"companyId": "C1"}, collection="orders"))
        self.assertTrue(self.rules.record_allowed(None, self.cfg, self.admin, {"companyId": "C1"}, collection="orders"))

    def test_team_scope_uses_active_owners(self):
        manager = {"id": "U4", "tenantId": "a", "role": "manager", "teamId": "T"}
        self.assertTrue(self.rules.record_allowed(None, self.cfg, manager, {"companyId": "C1", "createdBy": "U2"}, collection="orders"))
        self.assertFalse(self.rules.record_allowed(None, self.cfg, manager, {"companyId": "C1", "createdBy": "U3"}, collection="orders"))

    def test_tenant_and_quarantine_boundary(self):
        self.assertFalse(self.rules.record_allowed(None, self.cfg, self.admin, {"tenantId": "other", "companyId": "C1"}, collection="orders"))
        self.assertTrue(self.rules.record_allowed(None, self.cfg, self.admin, {"companyId": "unknown"}, collection="orders"))
        self.assertFalse(self.rules.record_allowed(None, self.cfg, self.sales, {"companyId": "unknown", "createdBy": "U2"}, collection="orders"))

    def test_operational_documents_follow_order_owner(self):
        data = {"orders": [{"id": "O1", "companyId": "C1", "salespersonId": "U2"}]}
        shipment = {"orderId": "O1", "companyId": "C1", "createdBy": "U1"}
        self.assertTrue(self.rules.record_allowed(None, self.cfg, self.sales, shipment, collection="shipments", payload=data))
        shipment["companyId"] = "C2"
        self.assertFalse(self.rules.record_allowed(None, self.cfg, self.admin, shipment, collection="shipments", payload=data))

    def test_financial_fields_recursively_redacted(self):
        row = {"id": "O1", "orderAmountUSD": 1000, "profitRMB": 12, "factories": [{"factoryId": "F", "productType": "Widgets", "totalAmount": 70, "prepayment": 10}], "extra": {"paidAmount": 100}}
        public = self.rules.visible_record(self.cfg, self.sales, row)
        self.assertEqual(public["orderAmountUSD"], 1000)
        self.assertNotIn("profitRMB", public)
        self.assertEqual(public["factories"], [{"factoryId": "F", "productType": "Widgets"}])
        self.assertEqual(public["extra"], {})

    def test_nested_financial_write_cannot_bypass_permission(self):
        with self.assertRaises(APIError) as caught:
            self.rules._prepare_patch(None, self.cfg, self.sales, "customers", {"companyId": "C1", "createdBy": "U2"}, {"extra": {"bankAccount": "changed"}})
        self.assertEqual(caught.exception.code, "FIELD_DENIED")

    def test_grandware_profit_rule_is_preserved(self):
        order = {"companyId": "C1", "orderAmountUSD": 1000, "factoryCostRMB": 4000, "freightCostUSD": 100, "insuranceCostUSD": 13, "otherCostUSD": 20}
        Rules._derive_order(self.cfg, order, {"C1": 6.69})
        self.assertEqual(order["orderAmountRMB"], 6690)
        self.assertEqual(order["profitRMB"], round(6690 - 4000 - 100 - 20 + 4000 / 1.13 * .13, 2))

    def test_generic_policy_counts_insurance_as_actual_expense(self):
        order = {"companyId": "C2", "orderAmountUSD": 1000, "factoryCostRMB": 700, "freightCostUSD": 20, "insuranceCostUSD": 10, "otherCostUSD": 5}
        Rules._derive_order(self.cfg, order, {"C2": 7})
        self.assertEqual(order["profitRMB"], 265)

    def test_missing_generic_fx_cannot_be_guessed(self):
        self.cfg["companies"][1].update(settlementCurrency="CNY", exchangeRate=None)
        with self.assertRaises(APIError) as caught:
            Rules._derive_order(self.cfg, {"companyId": "C2", "orderAmountUSD": 1000})
        self.assertEqual(caught.exception.code, "RATE_REQUIRED")

    def test_order_numbers_unique_even_for_deleted_history(self):
        with self.assertRaises(APIError) as caught:
            Rules._unique_order_numbers({"orders": [{"companyId": "C1", "companyOperationNo": "a", "deleted": True}, {"companyId": "C1", "companyOperationNo": " A "}]})
        self.assertEqual(caught.exception.code, "DUPLICATE_ORDER_NUMBER")

    def test_history_cross_company_supplier_only_retained_unchanged(self):
        data = {"customers": [{"id": "Customer", "companyId": "C1"}], "factories": [{"id": "Supplier", "companyId": "C2"}]}
        old = {"companyId": "C1", "customerId": "Customer", "factoryId": "Supplier"}
        self.rules._validate_links(None, self.cfg, self.admin, data, "orders", old, {"remarks": "edit"}, False, old)
        with self.assertRaises(APIError):
            self.rules._validate_links(None, self.cfg, self.admin, data, "orders", old, {"companyId": "C1"}, False, old)

    def test_optional_empty_historical_supplier_reference_is_not_a_fake_id(self):
        validate_embedded_ids({"id": "O", "factoryId": "", "factories": []})
        validate_embedded_ids({"id": "O", "factoryId": None})
        with self.assertRaises(APIError):
            validate_embedded_ids({"id": "O", "factoryId": "bad' onclick"})


class SchemaTests(unittest.TestCase):
    def test_typed_legacy_record_preserves_missing_null_and_unknown_fields(self):
        source = {"id": "O1", "companyId": "unknown", "orderAmountUSD": 123.45, "actualShipDate": None, "deleted": True, "unknownExtension": {"preserved": [1, "x"]}}
        restored = decode(encode(source, ORDER, "Trade Legacy Order"), ORDER, "Trade Legacy Order")
        self.assertEqual(restored, source)
        self.assertNotIn("createdBy", restored)

    def test_native_customer_name_is_authoritative(self):
        source = {"id": "C1", "company": "Before", "country": "美国"}
        encoded = encode(source, CUSTOMER, "Customer")
        encoded["customer_name"] = "After native edit"
        self.assertEqual(decode(encoded, CUSTOMER, "Customer")["company"], "After native edit")
        self.assertNotIn("custom_tradept_customer_name", encoded)

    def test_child_production_rows_preserve_fields(self):
        row = {"factoryId": "F1", "totalQuantity": 100, "totalAmount": 10.25, "inspectionDate": "2026-10-12", "estimatedShipDate": "2026-10-13", "legacyUnknown": "value"}
        self.assertEqual(child_decode(child_encode(row, FACTORY_LINE), FACTORY_LINE), row)

    def test_actual_shipping_date_required_for_milestone(self):
        with self.assertRaises(ValueError):
            validate_shipment({"status": "已出运", "etd": "2026-10-12"}, {"status": "已出运"}, False, {})

    def test_empty_source_date_is_distinct_from_null_and_real_native_date(self):
        source = {"id": "S", "arrivalDate": "", "receivedDate": None}
        encoded = encode(source, SHIPMENT, "Trade Shipment")
        encoded["arrival_date"] = None
        self.assertEqual(decode(encoded, SHIPMENT, "Trade Shipment"), source)
        encoded["arrival_date"] = "2026-10-13"
        self.assertEqual(decode(encoded, SHIPMENT, "Trade Shipment")["arrivalDate"], "2026-10-13")


class NativeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frappe = fake_frappe()
        cls.module_patch = patch.dict(sys.modules, {"frappe": cls.frappe})
        cls.module_patch.start()
        cls.api = importlib.import_module("tradept_core.api")
        cls.native = importlib.import_module("tradept_core.native")
        cls.permissions = importlib.import_module("tradept_core.permissions")
        cls.events = importlib.import_module("tradept_core.events")
        cls.guard = importlib.import_module("tradept_core.request_guard")
        cls.attribution = importlib.import_module("tradept_core.attribution")

    @classmethod
    def tearDownClass(cls):
        cls.module_patch.stop()

    def setUp(self):
        self.frappe.local.response = {}
        self.frappe.local.request.method = "POST"
        self.frappe.db.reset_mock()
        self.frappe.flags = Row()

    def test_write_cas_rejects_stale_revision(self):
        with self.assertRaises(APIError) as caught:
            self.api._expected(Row(revision=2), 1)
        self.assertEqual(caught.exception.response()["latestVersion"], 2)
        self.assertEqual(caught.exception.status, 409)

    def test_write_cas_requires_integer(self):
        with self.assertRaises(APIError):
            self.api._expected(Row(revision=2), True)

    def test_deadlock_restarts_whole_action_and_rechecks_real_revision(self):
        attempts = []
        payload = {"expectedVersion": 12, "changes": [{"value": {"remarks": "unchanged retry"}}]}
        def action(name, supplied):
            attempts.append(copy.deepcopy(supplied))
            if len(attempts) == 1:
                supplied["changes"].clear()
                raise self.frappe.QueryDeadlockError()
            self.api._expected(Row(revision=13), supplied["expectedVersion"])
        with patch.object(self.api, "_run_action", side_effect=action):
            result = self.api.dispatch("changes", payload)
        self.assertEqual(attempts, [payload, payload])
        self.assertEqual(result["result"]["code"], "VERSION_CONFLICT")
        self.assertEqual(result["result"]["latestVersion"], 13)
        self.assertEqual(self.frappe.local.response["http_status_code"], 409)
        self.assertEqual(self.frappe.db.rollback.call_count, 2)

    def test_deadlock_retry_can_succeed_without_stale_in_memory_payload(self):
        self.frappe.flags.tradept_native_changes = {"aborted": "discard"}
        with patch.object(self.api, "_run_action", side_effect=[self.frappe.QueryDeadlockError(), {"ok": True, "meta": {"version": 13}}]) as run:
            result = self.api.dispatch("changes", {"expectedVersion": 12})
        self.assertTrue(result["result"]["ok"])
        self.assertEqual(run.call_count, 2)
        self.frappe.db.rollback.assert_called_once()
        self.assertIsNone(self.frappe.flags.tradept_native_changes)

    def test_deadlock_exhaustion_is_busy_not_invented_version_conflict(self):
        with patch.object(self.api, "_run_action", side_effect=self.frappe.QueryDeadlockError()) as run:
            result = self.api.dispatch("receive_payment", {"expectedVersion": 12, "idempotencyKey": "stable"})
        self.assertEqual(run.call_count, 3)
        self.assertEqual(result["result"]["code"], "DATABASE_BUSY")
        self.assertNotIn("latestVersion", result["result"])
        self.assertEqual(self.frappe.local.response["http_status_code"], 503)

    def test_workspace_lock_is_one_native_current_read_before_any_exists(self):
        work = Row(revision=12, configuration='{"id":"tenant"}')
        self.frappe.db.exists.return_value = False
        with patch.object(self.frappe, "get_doc", return_value=work) as load:
            actual, config = self.api.repo.workspace(lock=True)
        load.assert_called_once_with("Trade Workspace", "workspace", for_update=True)
        self.frappe.db.exists.assert_not_called()
        self.assertEqual(config["id"], "tenant")
        with self.assertRaises(APIError) as caught:
            self.api._expected(actual, 10)
        self.assertEqual(caught.exception.details["latestVersion"], 12)

    def test_snapshot_reads_current_rows_and_restores_request_flag(self):
        work = Row(revision=12, updated_at_source="now", updated_by_id="actor")
        def current_payload():
            self.assertTrue(self.api.repo.current_reads())
            return {key: [] for key in ("customers", "factories", "orders", "shipments", "invoices")}
        created = {}
        def document(value):
            created.update(value)
            return Row(insert=lambda **kwargs: Row(name="snapshot"))
        with patch.object(self.api.repo, "workspace", return_value=(work, {})) as lock, patch.object(self.api.repo, "rates", return_value=({}, {})), patch.object(self.api.repo, "payload", side_effect=current_payload), patch.object(self.frappe, "get_doc", side_effect=document):
            self.assertEqual(self.api.repo.snapshot(12, "actor", "change"), "snapshot")
        lock.assert_called_once_with(lock=True)
        self.assertFalse(self.api.repo.current_reads())
        self.assertEqual(__import__("json").loads(created["archive"])["meta"]["version"], 12)

    def test_native_factory_plan_keeps_public_fields_only(self):
        row = {"factoryId": "F", "productType": "Widgets", "inspectionDate": "2026-10-12", "estimatedShipDate": "2026-10-14", "factoryName": "Native supplier", "totalQuantity": 100, "totalAmount": 500, "prepayment": 50}
        self.assertEqual(self.native.production_plan([row]), [{"factoryId": "F", "productType": "Widgets", "inspectionDate": "2026-10-12", "estimatedShipDate": "2026-10-14"}])
        changed = {**row, "inspectionDate": "2026-10-13"}
        self.api._native_factory_patch({"factories": [row]}, {"factories": [changed]})
        for key in ("totalQuantity", "totalAmount", "prepayment"):
            with self.assertRaises(APIError) as caught:
                self.api._native_factory_patch({"factories": [row]}, {"factories": [{**row, key: row[key] + 1}]})
            self.assertEqual(caught.exception.code, "NATIVE_PRODUCTION_AMOUNTS_AUTHORITATIVE")
        with self.assertRaises(APIError):
            self.api._native_factory_patch({"factories": [row]}, {"factories": []})
        with self.assertRaises(APIError) as caught:
            self.api._native_factory_patch({"factories": [row]}, {"factories": [{**row, "inspectionDate": "2026-10-15"}]})
        self.assertEqual(caught.exception.code, "BUSINESS_VALIDATION")

    def test_native_public_plan_persist_has_no_duplicate_finance_or_fx_rederive(self):
        cfg = {"id": "a", "companies": [{"id": "C1", "profitPolicy": "generic-native", "settlementCurrency": "USD", "exchangeRate": 99}], "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {}}
        actor = {"id": "U", "role": "admin", "tenantId": "a", "visibleCompanyIds": ["C1"]}
        rules = Rules(cfg, {"U": actor})
        original = {"id": "O", "companyId": "C1", "customerId": "C", "companyOperationNo": "O", "orderAmountUSD": 100, "factoryCostRMB": 70, "paidAmountUSD": 10, "profitRMB": 30, "profitRate": 30, "exchangeRateUsed": 1, "factories": [{"factoryId": "F", "factoryName": "Supplier", "productType": "Before", "totalQuantity": 1, "totalAmount": 70, "prepayment": 0, "inspectionDate": "2026-10-12", "estimatedShipDate": "2026-10-14"}]}
        data = {key: [] for key in ("customers", "factories", "orders", "shipments", "invoices")}
        data["orders"] = [original]
        plan = {**original["factories"][0], "productType": "After"}
        with patch.object(self.api.repo, "payload", return_value=data), patch.object(self.api.repo, "rates", return_value=({"C1": 99}, {})), patch.object(self.api.repo, "find", return_value=Row(doctype="Trade Order Brief", sales_order="SO")), patch.object(self.api.repo, "save_record") as save, patch.object(self.api.repo, "finish", return_value={"ok": True}), patch.object(rules, "_derive_order", side_effect=AssertionError("Native planning must not use current FX")):
            self.frappe.db.get_value.return_value = 1
            self.api._changes(Row(revision=5), cfg, actor, rules, {"expectedVersion": 5, "changes": [{"collection": "orders", "id": "O", "value": {"factories": [plan]}}]})
        saved = save.call_args.args[1]
        self.assertEqual(saved["factories"], [{"factoryId": "F", "productType": "After", "inspectionDate": "2026-10-12", "estimatedShipDate": "2026-10-14"}])
        for key in ("orderAmountUSD", "factoryCostRMB", "paidAmountUSD", "profitRMB", "profitRate", "exchangeRateUsed"):
            self.assertNotIn(key, saved)

    def test_historical_raw_contact_is_lossless_but_native_correction_wins(self):
        repo = self.api.repo
        source = {"id": "CT", "phone": "legacy phone / extension", "email": None}
        encoded = {"custom_tradept_" + key: value for key, value in child_encode(source, repo.CONTACT).items()}
        contact = Row(**encoded, custom_tradept_raw_phone=source["phone"], custom_tradept_contact_baselines=dumps({"phone": ""}), phone="", email_id="", full_name="", designation="", mobile_no="")
        self.assertEqual(repo._contact_decode(contact)["phone"], source["phone"])
        self.assertIsNone(repo._contact_decode(contact)["email"])
        contact.phone, contact.email_id, contact.mobile_no = "+12025550100", "corrected@example.invalid", "+12025550101"
        decoded = repo._contact_decode(contact)
        self.assertEqual(decoded["phone"], "+12025550100")
        self.assertEqual(decoded["email"], "corrected@example.invalid")
        self.assertEqual(decoded["mobilePhone"], "+12025550101")

    def test_historical_contact_channels_never_invent_or_normalize_source(self):
        repo = self.api.repo
        def phone(value, throw=False):
            valid = value.startswith("+")
            if throw and not valid:
                raise ValueError("Invalid phone")
            return valid
        with patch.object(self.frappe.utils, "validate_phone_number", side_effect=phone, create=True), patch.object(self.frappe.utils, "validate_email_address", side_effect=lambda value, throw=False: value.strip(), create=True):
            native, raw, baseline = repo.contact_channels({"phone": "legacy phone / extension", "email": " Buyer@example.invalid "}, Row(), historical=True)
            self.assertEqual(native["phone"], "")
            self.assertEqual(raw["phone"], "legacy phone / extension")
            self.assertEqual(raw["email"], " Buyer@example.invalid ")
            self.assertEqual(baseline["email"], "Buyer@example.invalid")
            with self.assertRaises(ValueError):
                repo.contact_channels({"phone": "new invalid phone"}, Row())

    def test_imported_master_spelling_is_provenance_until_real_native_change(self):
        source = {"id": "C", "company": " Customer "}
        doc = Row(doctype="Customer", **encode(source, CUSTOMER, "Customer"), custom_tradept_raw_master_name=" Customer ", custom_tradept_master_name_baseline="Customer")
        doc.customer_name = "Customer"
        self.assertEqual(self.api.repo.record(doc, "customers")["company"], " Customer ")
        doc.customer_name = "Native corrected name"
        self.assertEqual(self.api.repo.record(doc, "customers")["company"], "Native corrected name")

    def test_unmarked_native_supplier_receipt_participates_in_workspace_cas(self):
        self.frappe.db.exists.return_value = True
        self.frappe.db.get_value.return_value = "O"
        payment = Row(doctype="Payment Entry", name="PE", references=[Row(reference_doctype="Purchase Order", reference_name="PO")])
        self.assertTrue(self.events._tracked(payment))

    def test_native_stock_date_and_dated_arrival_have_one_shipping_status(self):
        sale = Row(name="SO", per_delivered=100)
        def rows(doctype, **kwargs):
            return [Row(parent="DN")] if doctype == "Delivery Note Item" else [Row(arrival_date="2026-10-13", received_date=None)]
        with patch.object(self.frappe, "get_all", side_effect=rows), patch.object(self.frappe.db, "get_value", side_effect=lambda dt, name, field: 1 if field == "docstatus" else "2026-10-12"):
            value = self.native.shipping_projection(sale, {"id": "O", "actualShipDate": "fake-old"})
        self.assertEqual(value["actualShipDate"], "2026-10-12")
        self.assertEqual(value["shippingStatus"], "已到港")

    def test_guest_has_no_workspace_action(self):
        with patch.object(self.frappe.session, "user", "Guest"):
            result = self.api.dispatch("data")
        self.assertEqual(self.frappe.local.response["http_status_code"], 401)
        self.assertEqual(result["result"]["code"], "SESSION_REQUIRED")

    def test_mutation_via_get_is_rejected(self):
        self.frappe.local.request.method = "GET"
        result = self.api.dispatch("changes", {})
        self.assertEqual(result["result"]["code"], "METHOD_NOT_ALLOWED")
        self.assertEqual(self.frappe.local.response["http_status_code"], 405)

    def test_failed_change_rolls_back_entire_frappe_transaction(self):
        error = APIError(409, "VERSION_CONFLICT", "Changed", latestVersion=3)
        with patch.object(self.api, "_identity", side_effect=error):
            result = self.api.dispatch("changes", {})
        self.frappe.db.rollback.assert_called_once()
        self.assertEqual(result["result"]["latestVersion"], 3)
        self.assertEqual(result["csrfToken"], "native-test-token")

    def test_native_rest_permission_cannot_bypass_workbench_roles(self):
        self.frappe.db.exists.return_value = True
        self.assertFalse(self.permissions.native_permission(user="native-user@example.invalid"))
        self.assertEqual(self.permissions.native_query(user="native-user@example.invalid"), "1=0")
        self.assertIsNone(self.permissions.native_permission(user="Administrator"))

    def test_native_delegation_restores_identity_and_attributes_actual_actor(self):
        user = self.frappe.session.user
        actor = {"id": "U", "nativeUser": user, "tenantId": "a"}
        cfg, value, doc = {"id": "a"}, {"id": "O", "companyId": "C"}, Row(sales_order=None)
        rules = Mock(permitted=Mock(return_value=True), record_allowed=Mock(return_value=True), company_ids=Mock(return_value={"C"}))
        self.frappe.db.exists.return_value = True
        self.frappe.session.sid = "authenticated-native-sid"
        self.frappe.session.data = {"csrf_token": "original-csrf"}
        form = self.frappe.local.form_dict = {"cmd": "tradept_core.api.dispatch"}
        session_data = self.frappe.session.data
        caches = {"cache": {"native-user": user}, "role_permissions": {"Item": False}, "new_doc_templates": {"original": True}, "user_perms": {"Company": ["Company"]}}
        for key, cache in caches.items():
            setattr(self.frappe.local, key, cache)
        with patch.object(self.api.repo, "native_company", return_value="Company"), patch.object(self.native, "documents", return_value=[]):
            with self.assertRaises(ValueError):
                with self.permissions.delegated_operation("convert_order", cfg, actor, rules, value, {}, doc):
                    self.assertEqual(self.frappe.session.user, "Administrator")
                    self.assertEqual(self.permissions.delegated_actor(), user)
                    self.assertEqual(self.frappe.local.role_permissions, {})
                    self.assertIsNone(self.frappe.local.user_perms)
                    new_child = Row(is_new=lambda: True)
                    old_child = Row(is_new=lambda: False, owner="historical-child-owner")
                    created = Row(is_new=lambda: True, get_all_children=lambda: [new_child])
                    updated = Row(is_new=lambda: False, owner="original-owner", get_all_children=lambda: [old_child])
                    with patch.object(self.events, "_tracked", return_value=False):
                        self.events.before_native_write(created)
                        self.events.before_native_write(updated)
                    self.assertEqual(created.owner, user)
                    self.assertEqual(updated.owner, "original-owner")
                    self.assertEqual(created.modified_by, user)
                    self.assertEqual(updated.modified_by, user)
                    self.assertEqual(new_child.owner, user)
                    self.assertEqual(new_child.modified_by, user)
                    self.assertEqual(old_child.owner, "historical-child-owner")
                    self.assertEqual(old_child.modified_by, user)
                    raise ValueError("native validation failed")
        self.assertEqual(self.frappe.session.user, user)
        self.assertIsNone(self.permissions.delegated_actor())
        self.assertEqual(self.frappe.session.sid, "authenticated-native-sid")
        self.assertIs(self.frappe.session.data, session_data)
        self.assertEqual(self.frappe.session.data["csrf_token"], "original-csrf")
        self.assertIs(self.frappe.local.form_dict, form)
        for key, cache in caches.items():
            self.assertIs(getattr(self.frappe.local, key), cache)
        self.assertFalse(self.permissions.native_permission(user=user))

    def test_native_delegation_requires_auth_scope_and_same_native_company(self):
        user = self.frappe.session.user
        actor = {"id": "U", "nativeUser": user, "tenantId": "a"}
        rules = Mock(permitted=Mock(return_value=True), record_allowed=Mock(return_value=True), company_ids=Mock(return_value={"C"}))
        self.frappe.flags.tradept_managed_write = True
        self.frappe.db.exists.return_value = True
        refs = [{"doctype": "Sales Order", "name": "SO"}]
        with patch.object(self.frappe, "set_user", create=True) as switched, patch.object(self.api.repo, "native_company", return_value="Company"), patch.object(self.native, "documents", return_value=refs):
            for denied in ({**actor, "nativeUser": "different"}, {**actor, "tenantId": "other"}):
                with self.assertRaises(APIError):
                    with self.permissions.delegated_operation("convert_order", {"id": "a"}, denied, rules, {"id": "O", "companyId": "C"}, {}, Row(sales_order=None)):
                        self.fail("Forbidden delegation")
            with patch.object(self.frappe.session, "user", "Guest"), self.assertRaises(APIError):
                with self.permissions.delegated_operation("convert_order", {"id": "a"}, {**actor, "nativeUser": "Guest"}, rules, {"id": "O", "companyId": "C"}, {}, Row(sales_order=None)):
                    self.fail("Guest must not delegate")
            self.frappe.db.get_value.return_value = "Other Company"
            with self.assertRaises(APIError) as caught:
                with self.permissions.delegated_operation("submit_order", {"id": "a"}, actor, rules, {"id": "O", "companyId": "C"}, {}, Row(sales_order="SO")):
                    self.fail("Cross-company native document")
            self.assertEqual(caught.exception.code, "NATIVE_COMPANY_CONFLICT")
            rules.permitted.return_value = False
            with self.assertRaises(APIError):
                with self.permissions.delegated_operation("convert_order", {"id": "a"}, actor, rules, {"id": "O", "companyId": "C"}, {}, Row(sales_order=None)):
                    self.fail("Missing financial grant")
            rules.permitted.return_value = True
            rules.company_ids.return_value = {"Other"}
            with self.assertRaises(APIError):
                with self.permissions.delegated_operation("convert_order", {"id": "a"}, actor, rules, {"id": "O", "companyId": "C"}, {}, Row(sales_order=None)):
                    self.fail("Missing company grant")
        switched.assert_not_called()

    def test_attribution_only_stamps_new_or_changed_bound_rows(self):
        before = {
            ("Sales Order", "SO"): {"owner": "historical-owner", "modified_by": "historical-user", "modified": "old"},
            ("Purchase Order", "PO"): {"owner": "historical-owner", "modified_by": "historical-user", "modified": "old"},
            ("GL Entry", "old-gl"): {"owner": "historical-owner", "modified_by": "historical-user", "modified": "old"},
        }
        after = {**before, ("Sales Order", "SO"): {"owner": "historical-owner", "modified_by": "Administrator", "modified": "new"}}
        for doctype, name in (("Payment Entry", "PE"), ("Payment Entry Reference", "ref"), ("GL Entry", "new-gl"), ("Payment Ledger Entry", "new-ple")):
            after[(doctype, name)] = {"owner": "Administrator", "modified_by": "Administrator", "modified": "new"}
        with patch.object(self.attribution, "_rows", return_value=after):
            self.attribution.finish(before, [], Row(), "actual-actor")
        written = {tuple(call.args[:2]): call for call in self.frappe.db.set_value.call_args_list}
        self.assertEqual(set(written), {("Sales Order", "SO"), ("Payment Entry", "PE"), ("Payment Entry Reference", "ref"), ("GL Entry", "new-gl"), ("Payment Ledger Entry", "new-ple")})
        self.assertEqual(written[("Sales Order", "SO")].args[2], {"modified_by": "actual-actor"})
        for key, call in written.items():
            self.assertEqual(call.kwargs, {"update_modified": False})
            if key != ("Sales Order", "SO"):
                self.assertEqual(call.args[2], {"owner": "actual-actor", "modified_by": "actual-actor"})

    def test_attribution_reads_native_children_and_exact_standard_vouchers(self):
        child = Row(doctype="Sales Order Item", name="line", owner="source", modified_by="source", modified="time")
        doc = Row(owner="source", modified_by="source", modified="time", get_all_children=lambda: [child])
        gl = Row(name="gl", owner="source", modified_by="source", modified="time")
        def ledger(sql, params, **kwargs):
            self.assertEqual(params, ("Sales Order", "SO"))
            self.assertTrue(sql.endswith("FOR UPDATE"))
            return [gl] if "`tabGL Entry`" in sql else []
        with patch.object(self.frappe, "get_doc", return_value=doc) as read, patch.object(self.frappe.db, "sql", side_effect=ledger):
            actual = self.attribution.capture([{"doctype": "Sales Order", "name": "SO"}], Row())
        read.assert_called_once_with("Sales Order", "SO", for_update=True)
        self.assertEqual(set(actual), {("Sales Order", "SO"), ("Sales Order Item", "line"), ("GL Entry", "gl")})

    def test_advance_payment_ledger_is_exact_voucher_scoped_and_preserves_history(self):
        parent = Row(owner="actor", modified_by="actor", modified="time", get_all_children=lambda: [])
        advance = Row(name="new-advance", owner="Administrator", modified_by="Administrator", modified="time")
        queried = []
        def ledger(sql, params, **kwargs):
            queried.append((sql, params))
            self.assertEqual(params, ("Payment Entry", "PE"))
            self.assertIn("WHERE voucher_type=%s AND voucher_no=%s FOR UPDATE", sql)
            return [advance] if "`tabAdvance Payment Ledger Entry`" in sql else []
        with patch.object(self.frappe, "get_doc", return_value=parent), patch.object(self.frappe.db, "sql", side_effect=ledger):
            actual = self.attribution.capture([{"doctype": "Payment Entry", "name": "PE"}], Row())
        self.assertEqual(len(queried), 3)
        self.assertIn(("Advance Payment Ledger Entry", "new-advance"), actual)
        historical = {"owner": "historical-creator", "modified_by": "historical-user", "modified": "old"}
        before = {("Payment Entry", "PE"): actual[("Payment Entry", "PE")], ("Advance Payment Ledger Entry", "historical"): historical}
        actual[("Advance Payment Ledger Entry", "historical")] = historical
        with patch.object(self.attribution, "_rows", return_value=actual):
            self.attribution.finish(before, [], Row(), "real-actor")
        self.frappe.db.set_value.assert_called_once_with("Advance Payment Ledger Entry", "new-advance", {"owner": "real-actor", "modified_by": "real-actor"}, update_modified=False)
        hooks = importlib.import_module("tradept_core.hooks")
        self.assertTrue(set(self.attribution.LEDGER_TYPES).issubset(hooks.has_permission))

    def test_unprovisioned_native_signup_has_no_business_permission(self):
        self.frappe.db.exists.return_value = False
        self.frappe.db.get_value.return_value = "Website User"
        self.assertFalse(self.permissions.native_permission(user="new-signup@example.invalid"))
        self.assertEqual(self.permissions.native_query(user="new-signup@example.invalid"), "1=0")
        self.assertFalse(self.permissions.native_permission(user="Guest"))
        self.frappe.db.get_value.return_value = "System User"
        self.assertIsNone(self.permissions.native_permission(user="trusted-native-admin@example.invalid"))

    def test_restricted_native_rpc_helpers_reports_and_v2_are_denied(self):
        blocked = ("/api/method/erpnext.stock.get_item_details.get_item_details", "/api/method/erpnext.accounts.party.get_party_account", "/api/v2/method/erpnext.accounts.party.get_party_account", "/api/method/frappe.desk.query_report.run", "/api/method/frappe.desk.reportview.export_query", "/api/v2/document/Customer/Secret", "/api/resource/Sales%20Order")
        self.frappe.local.form_dict = {}
        with patch.object(self.guard, "restricted_user", return_value=True):
            for method in ("GET", "POST"):
                for path in blocked:
                    self.frappe.local.request = Row(method=method, path=path, headers={})
                    with self.assertRaises(PermissionError):
                        self.guard.check_request()

    def test_scoped_dispatch_native_auth_and_html_assets_remain_available(self):
        self.frappe.local.form_dict = {}
        paths = ("/api/method/login", "/api/method/logout", "/api/method/tradept_core.api.dispatch", "/api/v2/method/tradept_core.api.dispatch", "/api/method/frappe.core.doctype.user.user.reset_password", "/api/method/frappe.core.doctype.user.user.sign_up", "/api/method/frappe.website.doctype.website_settings.website_settings.sign_up", "/login", "/assets/frappe/css/desk.css")
        with patch.object(self.guard, "restricted_user", return_value=True):
            for path in paths:
                self.frappe.local.request = Row(method="GET", path=path, headers={})
                self.guard.check_request()

    def test_native_command_cannot_hide_behind_allowed_login_path(self):
        self.frappe.local.form_dict = {"cmd": "frappe.client.get_list"}
        self.frappe.local.request = Row(method="POST", path="/api/method/login", headers={})
        with patch.object(self.guard, "restricted_user", return_value=True):
            with self.assertRaises(PermissionError):
                self.guard.check_request()

    def test_native_operator_keeps_standard_rpc(self):
        self.frappe.local.request = Row(method="POST", path="/api/method/frappe.client.get_list", headers={})
        with patch.object(self.guard, "restricted_user", return_value=False):
            self.guard.check_request()

    def test_token_auth_resolved_before_restricted_classification(self):
        self.frappe.local.request = Row(method="GET", path="/api/method/erpnext.accounts.party.get_party_account", headers={"Authorization": "token native-key:native-secret"})
        calls = []
        auth = SimpleNamespace(validate_auth=lambda: calls.append("auth"))
        with patch.dict(sys.modules, {"frappe.auth": auth}), patch.object(self.guard, "restricted_user", side_effect=lambda user: calls.append("classify") or False):
            self.guard.check_request()
        self.assertEqual(calls, ["auth", "classify"])

    def test_historical_excel_preserves_reference_profit_and_unknown_origin(self):
        cfg = {"id": "a", "companies": [{"id": "C1", "profitPolicy": "grandware-v40", "settlementCurrency": "CNY", "exchangeRate": 9}], "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {}}
        actor = {"id": "U", "role": "admin", "tenantId": "a", "visibleCompanyIds": ["C1"]}
        rules = Rules(cfg, {"U": actor})
        data = {key: [] for key in ("customers", "factories", "orders", "shipments", "invoices")}
        data["customers"] = [{"id": "C", "companyId": "C1"}]
        value = {"companyId": "C1", "customerId": "C", "companyOperationNo": "H1", "orderAmountUSD": 1000, "orderAmountRMB": None, "factoryCostRMB": 4000, "paidAmountUSD": 300, "profitRMB": 777.77, "profitRate": 11.5}
        with patch.object(self.api.repo, "payload", return_value=data), patch.object(self.api.repo, "rates", return_value=({"C1": 9}, {})), patch.object(self.api.repo, "find", return_value=None), patch.object(self.api.repo, "save_record") as save, patch.object(self.api.repo, "finish", return_value={"ok": True}) as finish:
            self.api._changes(Row(revision=0), cfg, actor, rules, {"expectedVersion": 0, "importPurpose": "historical-reference", "changes": [{"collection": "orders", "id": "H1", "value": value}]})
        saved = save.call_args.args[1]
        self.assertTrue(save.call_args.kwargs["legacy"])
        self.assertEqual(saved["profitRMB"], 777.77)
        self.assertEqual(saved["paidAmountUSD"], 300)
        self.assertIsNone(saved["orderAmountRMB"])
        self.assertNotIn("orderDate", saved)
        self.assertNotIn("createdBy", saved)
        self.assertNotIn("createdAt", saved)
        self.assertNotIn("salespersonId", saved)
        self.assertEqual(saved["importedBy"], "U")
        self.assertEqual(finish.call_args.args[2], "historical-import")

    def test_historical_excel_cannot_reclassify_linked_native_legacy(self):
        cfg = {"id": "a", "companies": [{"id": "C1"}], "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {}}
        actor = {"id": "U", "role": "admin", "tenantId": "a", "visibleCompanyIds": ["C1"]}
        rules = Rules(cfg, {"U": actor})
        data = {key: [] for key in ("customers", "factories", "orders", "shipments", "invoices")}
        data["orders"] = [{"id": "H1", "companyId": "C1"}]
        with patch.object(self.api.repo, "payload", return_value=data), patch.object(self.api.repo, "rates", return_value=({}, {})), patch.object(self.api.repo, "find", return_value=Row(doctype="Trade Legacy Order", sales_order="SO")), patch.object(self.api.repo, "save_record") as save:
            with self.assertRaises(APIError) as caught:
                self.api._changes(Row(revision=0), cfg, actor, rules, {"expectedVersion": 0, "importPurpose": "historical-reference", "changes": [{"collection": "orders", "id": "H1", "value": {"profitRMB": 123}}]})
        self.assertEqual(caught.exception.code, "HISTORICAL_STAGE_CONFLICT")
        save.assert_not_called()

    def test_native_role_and_company_permission_are_current_authority(self):
        cfg = {"id": "a", "roles": {"admin": copy.deepcopy(DEFAULT_ROLES["admin"]), "auditor": {**copy.deepcopy(DEFAULT_ROLES["finance"]), "baseRole": "finance"}}, "companies": [{"id": "C1"}], "teams": {}}
        actor = {"id": "U", "tenantId": "a", "nativeUser": self.frappe.session.user, "role": "admin", "visibleCompanyIds": ["C1", "C2"]}
        with patch.object(self.api.repo, "workspace", return_value=(Row(frozen=False), cfg)), patch.object(self.api.repo, "profiles", return_value={"U": actor}), patch.object(self.frappe, "get_roles", return_value=["Tradept Auditor", "Sales Manager"], create=True), patch.object(self.frappe, "get_all", return_value=[Row(for_value="Company")]):
            self.frappe.db.get_value.return_value = "C1"
            _work, current_cfg, current, rules, _users = self.api._identity()
        self.assertEqual(current["role"], "auditor")
        self.assertEqual(current["visibleCompanyIds"], ["C1"])
        self.assertTrue(rules.permitted(current_cfg, current, "finance.read"))
        self.assertFalse(rules.permitted(current_cfg, current, "accounts.configure"))

    def test_external_native_changes_schedule_one_before_commit_revision(self):
        self.frappe.db.exists.return_value = True
        customer = Row(doctype="Customer", name="C", custom_tradept_record_id="C1")
        supplier = Row(doctype="Supplier", name="S", custom_tradept_record_id="S1")
        with patch.object(self.events.repo, "workspace", return_value=(Row(revision=7), {})), patch.object(self.events.repo, "finish") as finish:
            self.events.before_native_write(customer)
            self.events.after_native_write(customer, "on_update")
            self.events.after_native_write(supplier, "on_update")
            self.frappe.db.before_commit.add.assert_called_once_with(self.events._finish_native_changes)
            self.events._finish_native_changes()
        finish.assert_called_once()
        self.assertEqual(finish.call_args.args[2], "native-change")
        self.assertEqual(len(finish.call_args.args[3]), 2)
        self.assertIsNone(self.frappe.flags.tradept_native_changes)

    def test_facade_managed_native_writes_do_not_double_bump_revision(self):
        self.frappe.db.exists.return_value = True
        with patch.object(self.events.repo, "workspace") as workspace:
            with self.events.managed_write():
                self.events.before_native_write(Row(doctype="Customer", name="C", custom_tradept_record_id="C1"))
                self.events.after_native_write(Row(doctype="Customer", name="C", custom_tradept_record_id="C1"))
        workspace.assert_not_called()
        self.frappe.db.before_commit.add.assert_not_called()

    def test_historical_order_never_invents_native_skus_or_postings(self):
        self.frappe.get_doc = Mock()
        with self.assertRaises(APIError) as caught:
            self.native.convert(Row(sales_order=None, doctype="Trade Legacy Order"), {"id": "OLD"}, {}, "k")
        self.assertEqual(caught.exception.code, "HISTORICAL_REFERENCE_ONLY")
        self.frappe.get_doc.assert_not_called()

    def test_operation_keys_bound_to_action_and_order(self):
        self.assertNotEqual(self.native.operation_key("payment", "A", "same"), self.native.operation_key("payment", "B", "same"))
        self.assertNotEqual(self.native.operation_key("payment", "A", "same"), self.native.operation_key("convert", "A", "same"))

    def test_cancel_refuses_posted_receipt_without_touching_native_documents(self):
        self.frappe.get_doc = Mock()
        with patch.object(self.native, "documents", return_value=[{"doctype": "Sales Order", "name": "SO", "docstatus": 1}, {"doctype": "Payment Entry", "name": "PE", "docstatus": 1}]):
            with self.assertRaises(APIError) as caught:
                self.native.cancel(Row(sales_order="SO"), {"id": "O"}, "cancel-key")
        self.assertEqual(caught.exception.code, "NATIVE_CANCELLATION_REQUIRES_RECONCILIATION")
        self.frappe.get_doc.assert_not_called()

    def test_cancel_delegates_purchase_then_sales_to_native_cancel(self):
        calls = []
        sale = Row(docstatus=1, flags=Row(), cancel=lambda: calls.append("SO"))
        purchase = Row(flags=Row(), cancel=lambda: calls.append("PO"))
        references = [{"doctype": "Sales Order", "name": "SO", "docstatus": 1}, {"doctype": "Purchase Order", "name": "PO", "docstatus": 1}]
        with patch.object(self.native, "documents", return_value=references), patch.object(self.frappe, "get_doc", side_effect=lambda dt, name: sale if dt == "Sales Order" else purchase), patch.object(self.frappe, "get_all", return_value=[], create=True):
            self.native.cancel(Row(sales_order="SO"), {"id": "O"}, "cancel-key")
        self.assertEqual(calls, ["PO", "SO"])
        self.assertTrue(sale.flags.ignore_permissions)
        self.assertTrue(purchase.flags.ignore_permissions)

    def test_successful_payment_retry_acknowledges_before_stale_cas(self):
        rules = Row(permitted=lambda *args: True, record_allowed=lambda *args: True)
        self.frappe.db.exists.return_value = True
        with patch.object(self.api.repo, "payload", return_value={"orders": [{"id": "O", "companyId": "C"}]}), patch.object(self.api.repo, "find", return_value=Row(sales_order="SO")), patch.object(self.api.native, "receive_payment", return_value=[{"doctype": "Payment Entry", "name": "PE"}]), patch.object(self.api.repo, "finish") as finish:
            result = self.api._native_operation("receive_payment", Row(revision=3, updated_at_source="now", updated_by_id="U"), {}, {"id": "U"}, rules, {"expectedVersion": 1, "orderId": "O", "idempotencyKey": "receipt", "amountUSD": 100})
        self.assertTrue(result["alreadyApplied"])
        self.assertEqual(result["meta"]["version"], 3)
        finish.assert_not_called()

    def test_native_projection_freezes_conversion_and_reads_live_paid_balance(self):
        sale = Row(name="SO", company="Company", customer="Customer", customer_name="Native customer", po_no="Native-PO", transaction_date="2026-10-01", delivery_date="2026-10-13", currency="USD", grand_total=1000, base_grand_total=6690, conversion_rate=6.69, advance_paid=250, docstatus=1, per_delivered=0, items=[Row(name="SO-L", custom_tradept_line_id="L", custom_tradept_supplier_id="F", item_code="ITEM", uom="Box", qty=10, rate=100)])
        po = Row(name="PO", company="Company", currency="CNY", base_grand_total=4000, conversion_rate=1, advance_paid=0, supplier="Supplier", supplier_name="Supplier", schedule_date="2026-10-13", items=[Row(custom_tradept_line_id="L", item_code="ITEM", qty=10, rate=400, base_amount=4000)])
        company = Row(default_currency="CNY", custom_tradept_profit_policy="generic-native", custom_tradept_record_id="C1")
        lookup = {("Sales Order", "SO"): sale, ("Purchase Order", "PO"): po, ("Company", "Company"): company}
        with patch.object(self.frappe, "get_doc", side_effect=lambda dt, name: lookup[(dt, name)]), patch.object(self.frappe, "get_all", return_value=[]), patch.object(self.frappe.db, "get_value", side_effect=lambda dt, name, field: "C" if dt == "Customer" else "F"), patch.object(self.native, "documents", return_value=[{"doctype": "Sales Order", "name": "SO", "docstatus": 1}, {"doctype": "Purchase Order", "name": "PO", "docstatus": 1}]), patch.object(self.native.repo, "rates", side_effect=AssertionError("Current FX must not restate native order")):
            plan = child_encode({"factoryId": "F", "productType": "Production category", "inspectionDate": "2026-10-12", "estimatedShipDate": "2026-10-14"}, FACTORY_LINE)
            projected = self.native.project_order(Row(sales_order="SO", factory_lines=[plan]), {"id": "O", "customerName": "stale quote", "customerOrderNo": "stale quote", "orderDate": "2000-01-01", "freightCostUSD": 100, "insuranceCostUSD": 10, "otherCostUSD": 0})
        self.assertEqual(projected["erpItems"][0]["uom"], "Box")
        self.assertEqual(projected["paidAmountUSD"], 250)
        self.assertEqual(projected["paymentStatus"], "部分收款")
        self.assertEqual(projected["exchangeRateUsed"], 6.69)
        self.assertEqual(projected["profitRMB"], round(6690 - 4000 - 110 * 6.69, 2))
        self.assertEqual(projected["customerName"], "Native customer")
        self.assertEqual(projected["customerOrderNo"], "Native-PO")
        self.assertEqual(projected["orderDate"], "2026-10-01")
        self.assertEqual(projected["factories"][0]["productType"], "Production category")
        self.assertEqual(projected["factories"][0]["inspectionDate"], "2026-10-12")

    def test_native_multiple_purchase_currencies_aggregate_one_supplier_plan(self):
        sale = Row(name="SO", company="Company", customer="Customer", customer_name="Native customer", po_no=None, transaction_date="2026-10-01", delivery_date="2026-10-13", currency="USD", grand_total=1000, base_grand_total=6690, conversion_rate=6.69, advance_paid=0, docstatus=1, per_delivered=0, items=[Row(name="SO-L", custom_tradept_line_id="L", custom_tradept_supplier_id="F", item_code="ITEM", qty=15, rate=1000/15)])
        po1 = Row(name="PO1", currency="USD", base_grand_total=401.4, conversion_rate=6.69, advance_paid=10, supplier="Supplier", supplier_name="Supplier", schedule_date="2026-10-13", items=[Row(custom_tradept_line_id="L", sales_order_item="SO-L", item_code="ITEM", qty=10, rate=6, base_amount=401.4)])
        po2 = Row(name="PO2", currency="CNY", base_grand_total=600, conversion_rate=1, advance_paid=50, supplier="Supplier", supplier_name="Supplier", schedule_date="2026-10-14", items=[Row(custom_tradept_line_id="L", sales_order_item="SO-L", item_code="ITEM", qty=5, rate=120, base_amount=600)])
        company = Row(default_currency="CNY", custom_tradept_profit_policy="generic-native", custom_tradept_record_id="C1")
        lookup = {("Sales Order", "SO"): sale, ("Company", "Company"): company, ("Purchase Order", "PO1"): po1, ("Purchase Order", "PO2"): po2}
        with patch.object(self.frappe, "get_doc", side_effect=lambda dt, name: lookup[(dt, name)]), patch.object(self.frappe, "get_all", return_value=[]), patch.object(self.frappe.db, "get_value", side_effect=lambda dt, name, field: "C" if dt == "Customer" else "F"), patch.object(self.native, "documents", return_value=[{"doctype": "Purchase Order", "name": "PO1", "docstatus": 1}, {"doctype": "Purchase Order", "name": "PO2", "docstatus": 1}]):
            projected = self.native.project_order(Row(sales_order="SO", factory_lines=[]), {"id": "O"})
        self.assertEqual(len(projected["factories"]), 1)
        self.assertEqual(projected["factories"][0]["totalQuantity"], 15)
        self.assertAlmostEqual(projected["factories"][0]["totalAmount"], 1001.4)
        self.assertAlmostEqual(projected["factories"][0]["prepayment"], 116.9)


if __name__ == "__main__":
    unittest.main()
