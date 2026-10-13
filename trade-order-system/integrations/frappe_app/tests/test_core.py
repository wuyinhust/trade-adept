"""Fast domain/contract checks; real Frappe acceptance is run separately."""
import copy
from contextlib import nullcontext
import hashlib
import hmac
import importlib
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tradept_core.domain import APIError, DEFAULT_ROLES, Rules, validate_embedded_ids
from tradept_core.schema import ORDER, CUSTOMER, FACTORY_LINE, SHIPMENT, encode, decode, child_encode, child_decode, dumps
from tradept_core.validation import validate_order, validate_shipment


TEST_GATEWAY_KEY = bytes(range(32)).hex()


class Row(SimpleNamespace):
    def get(self, key, default=None):
        return getattr(self, key, default)


def fake_frappe():
    class ValidationError(Exception):
        pass
    class QueryDeadlockError(Exception):
        pass
    return SimpleNamespace(whitelist=lambda **kwargs: lambda fn: fn, flags=Row(), session=Row(user="user@example.invalid", sid="native-session-id-for-tests"), local=Row(site="isolated.test", response={}, request=Row(method="POST")), conf=Row(tradept_gateway_hmac_key=TEST_GATEWAY_KEY), db=Mock(), get_doc=Mock(), get_all=Mock(), get_roles=Mock(return_value=[]), sessions=Row(get_csrf_token=lambda: "native-test-token"), ValidationError=ValidationError, QueryDeadlockError=QueryDeadlockError, PermissionError=PermissionError, utils=Row(strip_html=lambda s: s, today=lambda: "2026-10-12"))


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

    def test_disabled_historical_owner_remains_within_authorized_team_and_company(self):
        history = {"Former": {"id": "Former", "teamId": "T", "tenantId": "a", "nativeUser": "former@example.invalid", "enabled": False}, "OtherFormer": {"id": "OtherFormer", "teamId": "Other", "tenantId": "a", "enabled": False}}
        rules = Rules(self.cfg, self.rules.profiles, ownership_profiles=history)
        manager = {"id": "Manager", "tenantId": "a", "role": "manager", "teamId": "T"}
        original = {"companyId": "C1", "createdBy": "Former"}
        self.assertTrue(rules.record_allowed(None, self.cfg, manager, original, collection="orders"))
        self.assertFalse(rules.record_allowed(None, self.cfg, manager, {**original, "createdBy": "OtherFormer"}, collection="orders"))
        self.assertFalse(rules.record_allowed(None, self.cfg, manager, {**original, "companyId": "C2"}, collection="orders"))
        self.assertFalse(rules.record_allowed(None, self.cfg, self.sales, original, collection="orders"))
        self.assertNotIn("Former", rules.profiles)
        self.assertFalse(rules.ownership_profiles["Former"]["enabled"])
        self.assertEqual(original["createdBy"], "Former")

    def test_history_cannot_override_active_profile_or_grant_new_assignment(self):
        history = {"Former": {"id": "Former", "teamId": "T", "enabled": False}, "U2": {"id": "U2", "teamId": "Other", "role": "admin", "enabled": False}}
        rules = Rules(self.cfg, self.rules.profiles, ownership_profiles=history)
        self.assertEqual(rules.ownership_profiles["U2"], self.sales)
        old = {"companyId": "C1", "companyOperationNo": "HISTORY", "orderAmountUSD": 1000, "createdBy": "Former", "salespersonId": "Former", "profitRMB": 123}
        for key in ("ownerId", "salespersonId"):
            with self.subTest(field=key):
                current = {**old, "salespersonId": "U2"}
                with self.assertRaises(APIError) as caught:
                    rules._prepare_patch(None, self.cfg, self.admin, "orders", current, {key: "Former"})
                self.assertEqual(caught.exception.code, "ASSIGNMENT_DENIED")
        retained = rules._prepare_patch(None, self.cfg, self.admin, "orders", old, {"salespersonId": "Former", "remarks": "Historical record"})
        self.assertEqual(retained["createdBy"], "Former")
        self.assertEqual(retained["salespersonId"], "Former")
        assigned = rules._prepare_patch(None, self.cfg, self.admin, "orders", old, {"salespersonId": "U2"})
        self.assertEqual(assigned["salespersonId"], "U2")
        historical = rules._prepare_patch(None, self.cfg, self.admin, "orders", None, old, historical=True)
        self.assertEqual(historical["createdBy"], "Former")
        self.assertEqual(historical["profitRMB"], 123)

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

    def test_canonical_amounts_match_legacy_profit_for_all_company_policies(self):
        cases = [
            ("CO-GR", "grandware-v40", "CNY", 6.69, {"factoryCostRMB": 4000, "freightCostUSD": 100, "insuranceCostUSD": 13, "otherCostUSD": 20}, {"factoryCostRMB": 4000, "freightCostRMB": 100, "insuranceCostUSD": 13, "otherCostRMB": 20}, round(6690 - 4000 - 100 - 20 + 4000 / 1.13 * .13, 2)),
            ("CO-WY", "grandware-v40", "CNY", 6.9, {"factoryCostRMB": 4000, "freightCostUSD": 100, "insuranceCostUSD": 13, "otherCostUSD": 20}, {"factoryCostRMB": 4000, "freightCostRMB": 100, "insuranceCostUSD": 13, "otherCostRMB": 20}, round(6900 - 4000 - 100 - 20 + 4000 / 1.13 * .13, 2)),
            ("CO-GW", "grandware-v40", "USD", 999, {"factoryCostRMB": 700, "otherCostUSD": 20}, {"factoryCostUSD": 700, "otherCostUSD": 20}, 280),
            ("CO-LK", "grandware-v40", "USD", 7.25, {"factoryCostRMB": 700, "otherCostUSD": 20}, {"factoryCostUSD": 700, "otherCostUSD": 20}, 280),
            ("GEN-USD", "generic-native", "USD", 999, {"factoryCostRMB": 700, "freightCostUSD": 20, "insuranceCostUSD": 10, "otherCostUSD": 5}, {"factoryCostUSD": 700, "freightCostUSD": 20, "insuranceCostUSD": 10, "otherCostUSD": 5}, 265),
            ("GEN-CNY", "generic-native", "CNY", 6.69, {"factoryCostRMB": 4000, "freightCostUSD": 20, "insuranceCostUSD": 10, "otherCostUSD": 5}, {"factoryCostRMB": 4000, "freightCostRMB": 133.8, "insuranceCostUSD": 10, "otherCostRMB": 33.45}, round(6690 - 4000 - 35 * 6.69, 2)),
        ]
        for company_id, policy, currency, rate, legacy, canonical, expected in cases:
            with self.subTest(company=company_id):
                cfg = {"companies": [{"id": company_id, "settlementCurrency": currency, "profitPolicy": policy, "exchangeRate": rate}]}
                old = {"companyId": company_id, "orderAmountUSD": 1000, **legacy}
                new = {"companyId": company_id, "orderAmountUSD": 1000, **canonical}
                Rules._derive_order(cfg, old)
                Rules._derive_order(cfg, new)
                self.assertEqual(new["profitRMB"], expected)
                self.assertEqual({key: new[key] for key in ("orderAmountRMB", "profitRMB", "profitRate")}, {key: old[key] for key in ("orderAmountRMB", "profitRMB", "profitRate")})

    def test_quote_alias_edits_choose_this_change_and_cannot_leave_stale_partner(self):
        cases = [
            ("grandware-v40", "USD", "factoryCostUSD", "factoryCostRMB", 1),
            ("generic-native", "USD", "factoryCostUSD", "factoryCostRMB", 1),
            ("grandware-v40", "CNY", "freightCostRMB", "freightCostUSD", 1),
            ("grandware-v40", "CNY", "otherCostRMB", "otherCostUSD", 1),
            ("generic-native", "CNY", "freightCostRMB", "freightCostUSD", 7),
            ("generic-native", "CNY", "otherCostRMB", "otherCostUSD", 7),
        ]
        for policy, currency, alias, legacy, multiplier in cases:
            with self.subTest(policy=policy, currency=currency, alias=alias):
                self.cfg["companies"][0].update(profitPolicy=policy, settlementCurrency=currency, exchangeRate=7)
                old = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", None, {"companyId": "C1", "companyOperationNo": "QUOTE", "orderAmountUSD": 1000, legacy: 10})
                # The full-form legacy partner may repeat its previous value.
                patch = {alias: 20 * multiplier, legacy: old[legacy]}
                canonical = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", old, patch)
                self.assertEqual(canonical[alias], 20 * multiplier)
                expected = 1000 * (7 if currency == "CNY" else 1) - (20 * multiplier if alias != "factoryCostUSD" else 20)
                self.assertEqual(canonical["profitRMB"], expected)
                legacy_edit = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", canonical, {legacy: 30, alias: canonical[alias]})
                self.assertEqual(legacy_edit[legacy], 30)
                expected = 1000 * (7 if currency == "CNY" else 1) - (30 * multiplier if alias != "factoryCostUSD" else 30)
                self.assertEqual(legacy_edit["profitRMB"], expected)
                if multiplier == 1:
                    self.assertEqual(legacy_edit[alias], 30)
                else:
                    self.assertNotIn(alias, legacy_edit)
                    self.assertNotIn(legacy, canonical)

    def test_both_quote_alias_changes_must_have_equivalent_amounts(self):
        for currency, policy, alias, legacy, multiplier in (("USD", "grandware-v40", "factoryCostUSD", "factoryCostRMB", 1), ("CNY", "generic-native", "freightCostRMB", "freightCostUSD", 7)):
            with self.subTest(currency=currency):
                self.cfg["companies"][0].update(settlementCurrency=currency, profitPolicy=policy, exchangeRate=7)
                base = {"companyId": "C1", "companyOperationNo": "QUOTE", "orderAmountUSD": 1000, legacy: 10}
                for old in (None, base):
                    with self.assertRaises(APIError) as caught:
                        self.rules._prepare_patch(None, self.cfg, self.admin, "orders", old, {**base, legacy: 20, alias: 25 * multiplier})
                    self.assertEqual(caught.exception.code, "FINANCIAL_ALIAS_CONFLICT")
                accepted = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", base, {legacy: 20, alias: 20 * multiplier})
                self.assertEqual(accepted[alias], 20 * multiplier)

    def test_generic_rmb_fee_remains_rmb_when_later_quote_rate_changes(self):
        self.cfg["companies"][0].update(profitPolicy="generic-native", exchangeRate=7)
        order = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", None, {"companyId": "C1", "companyOperationNo": "QUOTE", "orderAmountUSD": 1000, "freightCostRMB": 140, "otherCostRMB": 35})
        self.assertNotIn("freightCostUSD", order)
        self.assertNotIn("otherCostUSD", order)
        merged = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", order, {"orderAmountUSD": 2000}, derive_order=False)
        Rules._derive_order(self.cfg, merged, {"C1": 8})
        self.assertEqual(merged["profitRMB"], 16000 - 140 - 35)
        self.assertEqual(merged["freightCostRMB"], 140)
        self.assertEqual(merged["otherCostRMB"], 35)
        self.assertNotIn("freightCostUSD", merged)

    def test_canonical_financial_fields_trigger_recalculation_but_require_permission(self):
        old = {"companyId": "C1", "companyOperationNo": "QUOTE", "orderAmountUSD": 1000, "createdBy": "U2", "profitRMB": 123}
        for alias in ("factoryCostUSD", "freightCostRMB", "otherCostRMB"):
            with self.subTest(field=alias):
                self.assertTrue(self.rules._financial_changed(old, {**old, alias: 10}))
                with self.assertRaises(APIError) as caught:
                    self.rules._prepare_patch(None, self.cfg, self.sales, "orders", old, {alias: 10})
                self.assertEqual(caught.exception.status, 403)
                self.assertEqual(caught.exception.code, "FIELD_DENIED")
                for invalid in (float("nan"), float("inf"), -1, True, "10"):
                    with self.assertRaises(APIError) as caught:
                        self.rules._prepare_patch(None, self.cfg, self.admin, "orders", old, {alias: invalid})
                    self.assertEqual(caught.exception.code, "INVALID_AMOUNT")
        recalculated = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", old, {"freightCostRMB": 10})
        self.assertEqual(recalculated["profitRMB"], 6690 - 10)

    def test_aliases_for_another_quote_currency_are_rejected_on_live_edit(self):
        base = {"companyId": "C1", "companyOperationNo": "QUOTE", "orderAmountUSD": 1000}
        for currency, alias in (("CNY", "factoryCostUSD"), ("USD", "freightCostRMB"), ("USD", "otherCostRMB")):
            with self.subTest(currency=currency, field=alias):
                self.cfg["companies"][0]["settlementCurrency"] = currency
                with self.assertRaises(APIError) as caught:
                    self.rules._prepare_patch(None, self.cfg, self.admin, "orders", None, {**base, alias: 10})
                self.assertEqual(caught.exception.code, "UNSUPPORTED_AMOUNT_CURRENCY")

    def test_alias_normalization_does_not_rewrite_historical_or_native_records(self):
        original = {"companyId": "C1", "companyOperationNo": "HISTORY", "orderAmountUSD": 1000, "factoryCostRMB": 4000, "freightCostRMB": 10, "freightCostUSD": 20, "factoryCostUSD": 700, "profitRMB": 123, "profitRate": 12.3}
        for flags in ({}, {"historical": True}, {"native_order": True}):
            with self.subTest(flags=flags):
                with patch.object(self.rules, "_derive_order", side_effect=AssertionError("Must retain original profit")):
                    result = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", original, {"remarks": "Checked"}, **flags)
                for key in original:
                    self.assertEqual(result[key], original[key])
        historical = self.rules._prepare_patch(None, self.cfg, self.admin, "orders", None, original, historical=True)
        self.assertEqual(historical["profitRMB"], 123)
        self.assertEqual(historical["freightCostRMB"], 10)
        self.assertEqual(historical["freightCostUSD"], 20)

    def test_native_receipt_summaries_are_financial_including_nested_writes(self):
        summaries = {"salesAdvanceAmountUSD": 100, "salesInvoiceSettledAmountUSD": 20, "salesInvoiceOutstandingAmountUSD": 80, "factoryAdvanceAmount": 70, "factoryInvoiceSettledAmount": 5, "factoryInvoiceOutstandingAmount": 65, "nativeReceiptSummary": [{"amount": 100, "currency": "USD"}], "salesInvoiceNames": ["SI-1"], "nativeSettlementCurrency": "CNY"}
        original = {"companyId": "C1", "companyOperationNo": "QUOTE", "orderAmountUSD": 1000, "createdBy": "U2", "factories": [{"factoryId": "F", "productType": "Widgets", "advanceAmount": 70, "invoiceSettledAmount": 5, "invoiceOutstandingAmount": 65}], **summaries}
        self.assertFalse(set(summaries).intersection(self.rules.visible_record(self.cfg, self.sales, original)))
        self.assertEqual(self.rules.visible_record(self.cfg, self.sales, original)["factories"], [{"factoryId": "F", "productType": "Widgets"}])
        self.assertEqual(self.rules.visible_record(self.cfg, self.admin, original)["nativeReceiptSummary"], summaries["nativeReceiptSummary"])
        for key in summaries:
            with self.subTest(field=key):
                with self.assertRaises(APIError) as caught:
                    self.rules._prepare_patch(None, self.cfg, self.sales, "orders", original, {"extra": {key: summaries[key]}})
                self.assertEqual(caught.exception.code, "FIELD_DENIED")

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
        cls.module_patch = patch.dict(sys.modules, {"frappe": cls.frappe, "frappe.rate_limiter": SimpleNamespace(rate_limit=lambda **kwargs: lambda fn: fn), "frappe.utils": SimpleNamespace(now_datetime=lambda: None, get_datetime=lambda value: value)})
        cls.module_patch.start()
        cls.api = importlib.import_module("tradept_core.api")
        cls.native = importlib.import_module("tradept_core.native")
        cls.permissions = importlib.import_module("tradept_core.permissions")
        cls.events = importlib.import_module("tradept_core.events")
        cls.guard = importlib.import_module("tradept_core.request_guard")
        cls.login = importlib.import_module("tradept_core.enterprise_login")
        cls.login_policy_patch = patch.object(cls.login, "active_policy", return_value=None)
        cls.login_policy_patch.start()
        cls.setup_patch = patch("tradept_core.login_setup.configuration", return_value={})
        cls.setup_patch.start()
        cls.attribution = importlib.import_module("tradept_core.attribution")
        cls.administrator = importlib.import_module("tradept_core.administrator")

    @classmethod
    def tearDownClass(cls):
        cls.setup_patch.stop()
        cls.login_policy_patch.stop()
        cls.module_patch.stop()

    def setUp(self):
        self.frappe.local.response = {}
        self.frappe.local.request.method = "POST"
        self.frappe.db.reset_mock()
        self.frappe.db.exists.reset_mock()
        self.frappe.flags = Row()

    def gateway_assertion(self, action, payload, tenant="a", site="isolated.test", issued_at=None):
        issued_at = int(time.time()) if issued_at is None else issued_at
        claims = {
            "v": 1,
            "site": site,
            "tenant": tenant,
            "action": action,
            "session": hashlib.sha256(self.frappe.session.sid.encode()).hexdigest(),
            "expectedVersion": payload.get("expectedVersion"),
            "idempotencyKey": payload.get("idempotencyKey"),
            "payloadSha256": hashlib.sha256(self.api._canonical_json(payload).encode()).hexdigest(),
            "rate": {"value": payload.get("liveExchangeRate"), "metadata": payload.get("liveExchangeRateMeta")},
            "iat": issued_at,
            "exp": issued_at + 180,
            "nonce": "0123456789abcdef0123456789abcdef",
        }
        signature = hmac.new(bytes.fromhex(TEST_GATEWAY_KEY), self.api._canonical_json(claims).encode(), hashlib.sha256).hexdigest()
        return {"claims": claims, "signature": signature}

    def sign_gateway_payload(self, action, payload, **kwargs):
        payload[self.api.GATEWAY_ASSERTION] = self.gateway_assertion(action, payload, **kwargs)
        return payload

    @staticmethod
    def live_rate(stale=False):
        return {
            "base": "USD", "quote": "CNY", "rawRate": 7.25, "adjustment": -0.02,
            "adjustedRate": 7.23, "provider": "ExchangeRate-API", "source": "open.er-api.com",
            "publishedAt": "2026-10-12T00:00:00Z", "fetchedAt": "2026-10-12T00:05:00Z",
            "nextUpdateAt": "2026-10-13T00:00:00Z", "cached": False, "stale": stale,
        }

    def test_write_cas_rejects_stale_revision(self):
        with self.assertRaises(APIError) as caught:
            self.api._expected(Row(revision=2), 1)
        self.assertEqual(caught.exception.response()["latestVersion"], 2)
        self.assertEqual(caught.exception.status, 409)

    def test_write_cas_requires_integer(self):
        with self.assertRaises(APIError):
            self.api._expected(Row(revision=2), True)

    def test_existing_workspace_skips_new_enterprise_wizard_without_recreating_data(self):
        cfg = {
            "id": "grandware", "name": "Grandware", "companies": [{"id": "C1"}],
            "roles": copy.deepcopy(DEFAULT_ROLES),
        }
        progress = self.administrator._onboarding(cfg, {"U": {"id": "U", "role": "admin"}})
        self.assertEqual(progress["status"], "complete")
        self.assertTrue(progress["requiredReady"])
        self.assertEqual(progress["completedSteps"], list(self.administrator.ONBOARDING_STEPS))

    def test_new_enterprise_wizard_remains_required_until_first_company_exists(self):
        cfg = {
            "id": "new-company", "name": "New Company", "companies": [],
            "roles": copy.deepcopy(DEFAULT_ROLES),
            "onboarding": {"status": "in_progress", "completedSteps": ["enterprise"]},
        }
        progress = self.administrator._onboarding(cfg, {"U": {"id": "U", "role": "admin"}})
        self.assertEqual(progress["status"], "in_progress")
        self.assertFalse(progress["requiredReady"])
        self.assertFalse(progress["checks"]["company"])

    def test_onboarding_moves_to_the_next_unfinished_step(self):
        cfg = {
            "id": "new-company", "name": "New Company", "companies": [],
            "roles": copy.deepcopy(DEFAULT_ROLES),
            "onboarding": {"status": "in_progress", "currentStep": "enterprise", "completedSteps": []},
        }
        updated = self.administrator._onboarding_update(
            cfg, {"U": {"id": "U", "role": "admin"}},
            {"currentStep": "enterprise", "completedSteps": ["enterprise"]},
        )
        self.assertEqual(updated["currentStep"], "company")

    def test_session_exposes_onboarding_and_management_pages_only_to_tenant_manager(self):
        cfg = {
            "id": "tenant", "name": "New Enterprise", "companies": [],
            "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {},
            "onboarding": {"status": "required", "completedSteps": []},
        }
        administrator = {"id": "A", "tenantId": "tenant", "role": "admin", "visibleCompanyIds": []}
        salesperson = {"id": "S", "tenantId": "tenant", "role": "salesperson", "visibleCompanyIds": []}
        users = {"A": administrator, "S": salesperson}
        rules = Rules(cfg, users)

        admin_session = self.api._session(cfg, administrator, rules, users)
        sales_session = self.api._session(cfg, salesperson, rules, users)

        self.assertEqual(admin_session["onboarding"]["status"], "required")
        self.assertIn("admin", admin_session["user"]["pages"])
        self.assertIn("onboarding", admin_session["user"]["pages"])
        self.assertNotIn("admin", sales_session["user"]["pages"])
        self.assertNotIn("onboarding", sales_session["user"]["pages"])

    def test_finance_session_keeps_bank_allowlists_in_admin_configuration_only(self):
        cfg = {"id": "tenant", "companies": [], "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {}}
        cfg["roles"]["finance"]["financePolicy"]["allowedBankAccounts"] = ["Bank Company A", "Bank Company B"]
        actor = {"id": "F", "tenantId": "tenant", "role": "finance", "visibleCompanyIds": []}
        session = self.api._session(cfg, actor, Rules(cfg, {"F": actor}), {"F": actor})
        self.assertIn("finance", session["user"]["pages"])
        self.assertNotIn("allowedBankAccounts", session["user"]["financePolicy"])
        self.assertNotIn("allowedBankAccounts", session["roles"]["finance"]["financePolicy"])
        self.assertEqual(cfg["roles"]["finance"]["financePolicy"]["allowedBankAccounts"], ["Bank Company A", "Bank Company B"])

    def test_api_routes_administrator_state_and_update_through_locked_action(self):
        work = Row(revision=4)
        cfg = {"id": "tenant", "roles": copy.deepcopy(DEFAULT_ROLES), "companies": []}
        actor = {"id": "A", "role": "admin", "tenantId": "tenant", "visibleCompanyIds": []}
        users = {"A": actor}
        rules = Rules(cfg, users)
        identity = (work, cfg, actor, rules, users)
        with patch.object(self.api, "_identity", return_value=identity) as identify, \
                patch.object(self.administrator, "state", return_value={"meta": {"version": 4}}) as read, \
                patch.object(self.administrator, "update", return_value={"meta": {"version": 5}}) as write:
            self.assertEqual(self.api._run_action("admin_state", {}), {"meta": {"version": 4}})
            self.assertEqual(self.api._run_action("admin_update", {"expectedVersion": 4}), {"meta": {"version": 5}})
        self.assertEqual(identify.call_args_list[0].args, (False,))
        self.assertEqual(identify.call_args_list[1].args, (True,))
        read.assert_called_once_with(work, cfg, actor, rules, users)
        write.assert_called_once_with(work, cfg, actor, rules, {"expectedVersion": 4})

    def test_current_administrator_cannot_remove_own_management_capability(self):
        cfg = {"roles": copy.deepcopy(DEFAULT_ROLES)}
        actor = {"id": "U", "role": "admin"}
        with self.assertRaises(APIError) as caught:
            self.administrator._role(cfg, actor, {
                "key": "admin", "label": "Administrator", "scope": "tenant",
                "permissions": ["read"], "pages": ["dashboard"],
            })
        self.assertEqual(caught.exception.code, "CURRENT_ADMIN_REQUIRED")

    def test_management_role_must_use_tenant_scope(self):
        cfg = {"roles": copy.deepcopy(DEFAULT_ROLES)}
        with self.assertRaises(APIError) as caught:
            self.administrator._role(cfg, {"id": "U", "role": "salesperson"}, {
                "key": "custom-admin", "label": "Custom admin", "scope": "team",
                "permissions": ["read", "accounts.configure"], "pages": ["dashboard", "admin"],
            })
        self.assertEqual(caught.exception.code, "ADMIN_SCOPE_REQUIRED")

    def test_management_role_view_always_exposes_its_admin_page(self):
        roles = self.administrator._roles({"roles": {
            "owner": {"scope": "tenant", "permissions": {"read": True, "accounts.configure": True}, "pages": ["dashboard"]}
        }})
        self.assertEqual(roles[0]["permissions"], ["read", "accounts.configure"])
        self.assertIn("admin", roles[0]["pages"])

    def test_email_ports_are_bounded_before_native_email_configuration(self):
        self.assertEqual(self.administrator._port("993", "IMAP"), 993)
        with self.assertRaises(APIError):
            self.administrator._port(70000, "SMTP")

    def test_company_order_prefix_must_be_unique(self):
        cfg = {"companies": [{"id": "C1", "orderPrefix": "GW"}]}
        with self.assertRaises(APIError) as caught:
            self.administrator._company(cfg, {"id": "U"}, {
                "id": "C2", "name": "Second", "country": "China", "jurisdiction": "CN",
                "settlementCurrency": "CNY", "orderPrefix": "gw",
            })
        self.assertEqual(caught.exception.code, "DUPLICATE_ORDER_PREFIX")

    def test_current_administrator_cannot_assign_self_a_non_management_role(self):
        cfg = {"id": "tenant", "roles": copy.deepcopy(DEFAULT_ROLES), "companies": []}
        current = {"id": "U", "nativeUser": "admin@example.invalid", "role": "admin"}
        with patch.object(self.administrator, "_configured_profiles", return_value={"U": current}):
            with self.assertRaises(APIError) as caught:
                self.administrator._member(cfg, current, {
                    "id": "U", "email": "admin@example.invalid", "username": "admin",
                    "name": "Admin", "role": "salesperson", "visibleCompanyIds": [],
                })
        self.assertEqual(caught.exception.code, "CURRENT_ADMIN_REQUIRED")

    def test_disabled_member_remains_visible_for_reactivation_in_administrator(self):
        profile = {
            "id": "U2", "name": "Disabled User", "username": "disabled",
            "role": "salesperson", "tenantId": "tenant", "visibleCompanyIds": [],
        }
        with patch.object(self.frappe, "get_all", return_value=[Row(user="disabled@example.invalid", profile=dumps(profile))]), \
                patch.object(self.frappe.db, "get_value", return_value=0):
            configured = self.administrator._configured_profiles()
            members = self.administrator._members({"id": "tenant"}, configured)
        self.assertEqual(members[0]["id"], "U2")
        self.assertFalse(members[0]["enabled"])

    def test_existing_member_native_save_cannot_commit_before_profile_failure(self):
        cfg = {"id": "tenant", "roles": copy.deepcopy(DEFAULT_ROLES), "companies": []}
        existing = {"id": "Member", "name": "Existing", "username": "member", "role": "finance", "tenantId": "tenant", "nativeUser": "member@example.invalid", "visibleCompanyIds": []}
        for changes in ({"disabled": True}, {"role": "salesperson"}, {"temporaryPassword": "test-password-12345"}, {"name": "Renamed member"}):
            with self.subTest(changes=changes):
                calls = []
                remaining_sids = ["actual-session-row-placeholder"]
                native = Row(name=existing["nativeUser"], user_type="System User")
                native.set = Mock(side_effect=lambda key, value: setattr(native, key, value))
                # Models the independently inspected native lifecycle: if SID
                # rows reach User.save, logout/type/password cleanup commits.
                def native_save(**kwargs):
                    calls.append("native-save")
                    if remaining_sids:
                        self.frappe.db.commit()
                native.save = Mock(side_effect=native_save)
                metadata = Row(update=Mock())
                def fail_profile(**kwargs):
                    calls.append("profile-failure")
                    raise ValueError("Deliberate later profile failure")
                metadata.save = Mock(side_effect=fail_profile)
                def revoke(user):
                    self.assertEqual(user, existing["nativeUser"])
                    calls.append("revoke")
                    remaining_sids.clear()
                    return 1
                self.frappe.db.commit.reset_mock()
                with patch.object(self.administrator, "_configured_profiles", return_value={"Member": existing}), patch.object(self.frappe.db, "exists", return_value=True), patch.object(self.frappe.db, "get_value", return_value="PROFILE"), patch.object(self.frappe, "get_doc", side_effect=lambda kind, name: native if kind == "User" else metadata), patch("tradept_core.session_security.revoke_user_sessions", side_effect=revoke) as revoke_sessions:
                    with self.assertRaises(ValueError):
                        self.administrator._member(cfg, {"id": "Admin", "role": "admin"}, {"id": "Member", "email": existing["nativeUser"], "username": "member", "visibleCompanyIds": [], **changes})
                self.assertEqual(calls, ["revoke", "native-save", "profile-failure"])
                self.frappe.db.commit.assert_not_called()
                revoke_sessions.assert_called_once_with(existing["nativeUser"])

    def test_member_creation_does_not_revoke_unrelated_sessions(self):
        cfg = {"id": "tenant", "roles": copy.deepcopy(DEFAULT_ROLES), "companies": []}
        native = Row(name="new-member@example.invalid", set=Mock(), save=Mock())
        metadata = Row(update=Mock(), save=Mock())
        with patch.object(self.administrator, "_configured_profiles", return_value={}), patch.object(self.frappe.db, "exists", return_value=False), patch.object(self.frappe.db, "get_value", return_value=None), patch.object(self.frappe, "get_doc", return_value=native), patch.object(self.frappe, "new_doc", return_value=metadata, create=True), patch("tradept_core.session_security.revoke_user_sessions") as revoke_sessions:
            result = self.administrator._member(cfg, {"id": "Admin", "role": "admin"}, {"id": "New", "email": native.name, "username": "new-member", "name": "New member", "role": "salesperson", "temporaryPassword": "test-password-12345", "visibleCompanyIds": []})
        self.assertTrue(result["enabled"])
        native.save.assert_called_once_with(ignore_permissions=True)
        metadata.save.assert_called_once_with(ignore_permissions=True)
        revoke_sessions.assert_not_called()

    def test_current_administrator_disable_is_rejected_before_session_changes(self):
        cfg = {"id": "tenant", "roles": copy.deepcopy(DEFAULT_ROLES), "companies": []}
        current = {"id": "Admin", "role": "admin", "nativeUser": "admin@example.invalid"}
        with patch.object(self.administrator, "_configured_profiles", return_value={"Admin": current}), patch("tradept_core.session_security.revoke_user_sessions") as revoke_sessions, patch.object(self.frappe, "get_doc") as get_doc:
            with self.assertRaises(APIError) as caught:
                self.administrator._member(cfg, current, {"id": "Admin", "email": current["nativeUser"], "username": "admin", "role": "admin", "disabled": True})
        self.assertEqual(caught.exception.code, "CURRENT_ADMIN_REQUIRED")
        revoke_sessions.assert_not_called()
        get_doc.assert_not_called()

    def test_ownership_profiles_preserve_disabled_owner_without_active_account(self):
        rows = [Row(user="active@example.invalid", profile=dumps({"id": "Active", "tenantId": "a", "teamId": "T", "enabled": False})), Row(user="former@example.invalid", profile=dumps({"id": "Former", "tenantId": "a", "teamId": "T", "enabled": True}))]
        with patch.object(self.frappe, "get_all", return_value=rows), patch.object(self.frappe.db, "get_value", side_effect=lambda dt, user, field: 1 if user == "active@example.invalid" else 0):
            active = self.api.repo.profiles()
            history = self.api.repo.ownership_profiles()
        self.assertEqual(set(active), {"Active"})
        self.assertEqual(set(history), {"Active", "Former"})
        self.assertTrue(history["Active"]["enabled"])
        self.assertFalse(history["Former"]["enabled"])
        self.assertEqual(history["Former"]["nativeUser"], "former@example.invalid")
        self.assertEqual(history["Former"]["teamId"], "T")

    def test_disabled_historical_owner_cannot_obtain_workbench_session(self):
        cfg = {"id": "a", "companies": [{"id": "C1"}], "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {}}
        former = {"id": "Former", "tenantId": "a", "teamId": "T", "role": "admin", "enabled": True}
        row = Row(user=self.frappe.session.user, profile=dumps(former))
        with patch.object(self.api.repo, "workspace", return_value=(Row(frozen=False), cfg)), patch.object(self.frappe, "get_all", return_value=[row]), patch.object(self.frappe.db, "get_value", return_value=0), patch.object(self.api.repo, "ownership_profiles") as history:
            with self.assertRaises(APIError) as caught:
                self.api._identity()
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.code, "WORKSPACE_ACCOUNT_REQUIRED")
        history.assert_not_called()

    def test_editing_a_role_preserves_its_existing_collection_boundary(self):
        cfg = {"roles": {"limited": {
            "scope": "self", "permissions": ["read"], "pages": ["orders"],
            "collections": ["orders"], "readScopes": {"factories": "entities"},
        }}}
        with patch.object(self.frappe.db, "exists", return_value=True):
            changed = self.administrator._role(cfg, {"role": "admin"}, {
                "key": "limited", "label": "Limited Sales", "scope": "team",
                "permissions": ["read", "edit"], "pages": ["orders"],
            })
        self.assertEqual(changed["collections"], ["orders"])
        self.assertEqual(changed["readScopes"], {"factories": "entities"})
        self.assertFalse(Rules(cfg, {}).permitted(cfg, {"role": "limited"}, "read", "customers"))

    def test_new_member_cannot_take_over_an_existing_native_user(self):
        cfg = {"id": "tenant", "roles": copy.deepcopy(DEFAULT_ROLES), "companies": []}
        with patch.object(self.administrator, "_configured_profiles", return_value={}), \
                patch.object(self.frappe.db, "exists", return_value=True):
            with self.assertRaises(APIError) as caught:
                self.administrator._member(cfg, {"id": "A", "role": "admin"}, {
                    "id": "new-member", "email": "existing@example.com", "username": "new-user",
                    "name": "New member", "role": "salesperson", "temporaryPassword": "private-temp-password",
                })
        self.assertEqual(caught.exception.code, "MEMBER_EMAIL_EXISTS")

    def test_new_company_form_rejects_reusing_an_existing_stable_id(self):
        cfg = {"companies": [{"id": "C1", "name": "Original", "settlementCurrency": "CNY"}]}
        with self.assertRaises(APIError) as caught:
            self.administrator._company(cfg, {}, {"id": "C1", "create": True, "name": "Duplicate"})
        self.assertEqual(caught.exception.code, "ADMIN_DUPLICATE")
        self.assertEqual(cfg["companies"][0]["name"], "Original")

    def test_child_department_promotes_its_native_parent_to_group(self):
        class Doc(Row):
            def set(self, field, value):
                setattr(self, field, value)
            def save(self, **kwargs):
                return self
        parent = Doc(name="Sales - EX", is_group=0)
        child = Doc(name="Sales East - EX", is_group=0)
        cfg = {"companies": [{"id": "C1"}], "departments": {"D1": {
            "id": "D1", "name": "Sales", "visibleCompanyIds": ["C1"], "nativeNames": {"C1": parent.name},
        }}}
        def get_value(doctype, filters, field):
            if field == "is_group":
                return parent.is_group
            return "All Departments" if isinstance(filters, dict) and "parent_department" in filters else None
        with patch.object(self.administrator, "_configured_profiles", return_value={}), \
                patch.object(self.administrator.repo, "native_company", return_value="Example"), \
                patch.object(self.frappe, "get_meta", create=True, return_value=Row(has_field=lambda field: True)), \
                patch.object(self.frappe, "new_doc", create=True, return_value=child), \
                patch.object(self.frappe, "get_doc", return_value=parent), \
                patch.object(self.frappe.db, "exists", side_effect=lambda kind, name: kind == "DocType" or name == parent.name), \
                patch.object(self.frappe.db, "get_value", side_effect=get_value):
            changed = self.administrator._department(cfg, {
                "id": "D2", "name": "Sales East", "parentId": "D1", "visibleCompanyIds": ["C1"],
            })
        self.assertEqual(parent.is_group, 1)
        self.assertEqual(child.parent_department, parent.name)
        self.assertEqual(changed["nativeNames"], {"C1": child.name})

    def test_email_uses_native_server_login_and_imap_fields(self):
        class Doc(Row):
            def set(self, field, value):
                setattr(self, field, value)
            def append(self, field, value):
                setattr(self, field, [*(self.get(field) or []), value])
            def save(self, **kwargs):
                return self
        native = Doc(name="Sales Mail", imap_folder=[])
        profiles = {"U": {"id": "U", "nativeUser": "sales@example.com"}}
        with patch.object(self.administrator, "_configured_profiles", return_value=profiles), \
                patch.object(self.administrator, "_sync_mailbox_members") as sync, \
                patch.object(self.administrator, "_clear_email_defaults"), \
                patch.object(self.frappe, "get_meta", create=True, return_value=Row(has_field=lambda field: True)), \
                patch.object(self.frappe, "new_doc", create=True, return_value=native), \
                patch.object(self.frappe.db, "exists", side_effect=lambda kind, filters: kind == "DocType"):
            changed = self.administrator._email_account({}, {
                "label": "Sales Mail", "emailId": "sales@example.com", "loginId": "smtp-user",
                "incomingServer": "imap.example.com", "smtpServer": "smtp.example.com", "service": "Outlook",
                "password": "private-mail-password", "allowedUserIds": ["U"],
            })
        self.assertEqual(native.email_server, "imap.example.com")
        self.assertEqual(native.service, "Outlook.com")
        self.assertEqual(native.login_id_is_different, 1)
        self.assertEqual(native.imap_folder, [{"folder_name": "INBOX"}])
        self.assertEqual(native.awaiting_password, 0)
        self.assertNotIn("password", changed)
        sync.assert_called_once_with(native, profiles, ["U"])

    def test_existing_hk_company_without_country_can_edit_prefix_using_native_identity(self):
        migration = Row(_company=Mock(return_value=Row(name="HK Trading Limited")))
        cfg = {"companies": [{
            "id": "HK1", "name": "Legacy Display", "jurisdiction": "HK",
            "settlementCurrency": "USD", "orderPrefix": "HK",
        }]}
        native_identity = {"company_name": "HK Trading Limited", "country": "Hong Kong", "default_currency": "USD"}
        with patch.object(self.administrator.repo, "native_company", return_value="HK Trading Limited"), \
                patch.object(self.frappe.db, "get_value", return_value=native_identity), \
                patch.dict(sys.modules, {"tradept_core.migration": migration}):
            viewed = self.administrator._company_details(cfg["companies"][0])
            changed = self.administrator._company(cfg, {}, {
                "id": "HK1", "name": viewed["name"], "orderPrefix": "HKT",
            })
        self.assertEqual(viewed["country"], "Hong Kong")
        self.assertEqual(changed["name"], "HK Trading Limited")
        self.assertEqual(changed["country"], "Hong Kong")
        self.assertEqual(changed["orderPrefix"], "HKT")
        self.assertEqual(cfg["companies"][0]["nativeCompanyName"], "HK Trading Limited")
        migration._company.assert_called_once()

    def test_existing_company_name_change_is_rejected_before_native_save(self):
        cfg = {"companies": [{"id": "C1", "name": "Original", "country": "China", "jurisdiction": "CN", "settlementCurrency": "CNY"}]}
        with patch.object(self.administrator.repo, "native_company", return_value=None):
            with self.assertRaises(APIError) as caught:
                self.administrator._company(cfg, {}, {"id": "C1", "name": "Renamed"})
        self.assertEqual(caught.exception.code, "COMPANY_NAME_LOCKED")
        self.assertEqual(cfg["companies"][0]["name"], "Original")

    def test_email_default_switch_explicitly_authorizes_only_prior_default_save(self):
        previous = Mock()
        with patch.object(self.frappe, "get_all", return_value=[Row(name="Previous Mail"), Row(name="New Mail")]), \
                patch.object(self.frappe, "get_doc", return_value=previous) as load:
            self.administrator._clear_email_defaults(Row(name="New Mail"), {
                "enable_incoming": 1, "default_incoming": 1, "enable_outgoing": 0, "default_outgoing": 1,
            })
        load.assert_called_once_with("Email Account", "Previous Mail")
        previous.set.assert_called_once_with("default_incoming", 0)
        previous.save.assert_called_once_with(ignore_permissions=True)

    def test_mailbox_access_updates_native_user_emails_and_revokes_removed_members(self):
        class User(Row):
            def set(self, field, value):
                setattr(self, field, value)
            def append(self, field, value):
                getattr(self, field).append(value)
            def save(self, **kwargs):
                return self
        added = User(user_emails=[{"email_account": "Other Mail"}])
        removed = User(user_emails=[{"email_account": "Sales Mail"}, {"email_account": "Other Mail"}])
        users = {"a@example.com": added, "b@example.com": removed}
        mailbox = Row(name="Sales Mail", email_id="sales@example.com", enable_outgoing=1, awaiting_password=0, auth_method="Basic")
        with patch.object(self.frappe, "get_meta", create=True, return_value=Row(has_field=lambda field: True)), \
                patch.object(self.frappe, "get_doc", side_effect=lambda doctype, name: users[name]):
            self.administrator._sync_mailbox_members(mailbox, {
                "A": {"nativeUser": "a@example.com"}, "B": {"nativeUser": "b@example.com"},
            }, ["A"])
        self.assertEqual(added.user_emails[0], {"email_account": "Other Mail"})
        self.assertEqual(added.user_emails[1]["email_account"], "Sales Mail")
        self.assertEqual(removed.user_emails, [{"email_account": "Other Mail"}])

    def test_regular_management_edits_do_not_restart_completed_onboarding(self):
        cfg = {
            "id": "tenant", "name": "Existing", "companies": [{"id": "C1"}],
            "roles": copy.deepcopy(DEFAULT_ROLES),
        }
        changed = self.administrator._onboarding_update(cfg, {"A": {"role": "admin"}}, {
            "currentStep": "enterprise", "completedSteps": ["enterprise"],
        })
        self.assertEqual(changed["status"], "complete")

    def test_mailbox_delegation_preserves_actor_and_restores_authenticated_request_on_failure(self):
        user = self.frappe.session.user
        actor = {"id": "A", "nativeUser": user, "tenantId": "tenant", "role": "admin"}
        cfg = {"id": "tenant", "roles": copy.deepcopy(DEFAULT_ROLES)}
        rules = Rules(cfg, {"A": actor})
        sid = self.frappe.session.sid
        data = self.frappe.session.data = {"csrf_token": "original-csrf"}
        form = self.frappe.local.form_dict = {"cmd": "tradept_core.api.dispatch"}
        cache = self.frappe.local.role_permissions = {"Email Account": False}
        self.frappe.flags.tradept_managed_write = True
        with patch.object(self.permissions, "is_workbench_user", return_value=True), \
                patch.object(self.frappe, "set_user", create=True) as set_user:
            with self.assertRaises(ValueError):
                with self.permissions.delegated_email_configuration(cfg, actor, rules):
                    self.assertEqual(self.frappe.session.user, "Administrator")
                    self.assertEqual(self.permissions.delegated_actor(), user)
                    self.assertEqual(self.frappe.local.role_permissions, {})
                    created = Row(is_new=lambda: True, get_all_children=lambda: [])
                    with patch.object(self.events, "_tracked", return_value=False):
                        self.events.before_native_write(created)
                    self.assertEqual(created.owner, user)
                    self.assertEqual(created.modified_by, user)
                    raise ValueError("native mailbox validation failure")
            set_user.assert_not_called()
        self.assertEqual(self.frappe.session.user, user)
        self.assertEqual(self.frappe.session.sid, sid)
        self.assertIs(self.frappe.session.data, data)
        self.assertIs(self.frappe.local.form_dict, form)
        self.assertIs(self.frappe.local.role_permissions, cache)
        self.assertTrue(self.frappe.flags.tradept_managed_write)
        self.assertIsNone(self.permissions.delegated_actor())

    def test_mailbox_service_context_denies_unprovisioned_or_non_management_accounts(self):
        user = self.frappe.session.user
        cfg = {"id": "tenant", "roles": copy.deepcopy(DEFAULT_ROLES)}
        rules = Rules(cfg, {})
        with patch.object(self.permissions, "is_workbench_user", return_value=True):
            for actor in (
                {"nativeUser": "different@example.com", "tenantId": "tenant", "role": "admin"},
                {"nativeUser": user, "tenantId": "other", "role": "admin"},
                {"nativeUser": user, "tenantId": "tenant", "role": "salesperson"},
            ):
                with self.assertRaises(APIError):
                    with self.permissions.delegated_email_configuration(cfg, actor, rules):
                        self.fail("Unauthorized mailbox service identity")
                self.assertEqual(self.frappe.session.user, user)

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
        self.assertTrue({"Department", "Email Account"}.issubset(hooks.has_permission))

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
        value = {"companyId": "C1", "customerId": "C", "companyOperationNo": "H1", "orderAmountUSD": 1000, "orderAmountRMB": None, "factoryCostRMB": 4000, "factoryCostUSD": 700, "freightCostRMB": 100, "freightCostUSD": 20, "otherCostRMB": 15, "otherCostUSD": 5, "paidAmountUSD": 300, "profitRMB": 777.77, "profitRate": 11.5}
        with patch.object(self.api.repo, "payload", return_value=data), patch.object(self.api.repo, "rates", return_value=({"C1": 9}, {})), patch.object(self.api.repo, "find", return_value=None), patch.object(self.api.repo, "save_record") as save, patch.object(self.api.repo, "finish", return_value={"ok": True}) as finish:
            self.api._changes(Row(revision=0), cfg, actor, rules, {"expectedVersion": 0, "importPurpose": "historical-reference", "changes": [{"collection": "orders", "id": "H1", "value": value}]})
        saved = save.call_args.args[1]
        self.assertTrue(save.call_args.kwargs["legacy"])
        self.assertEqual(saved["profitRMB"], 777.77)
        self.assertEqual(saved["paidAmountUSD"], 300)
        for key in ("factoryCostRMB", "factoryCostUSD", "freightCostRMB", "freightCostUSD", "otherCostRMB", "otherCostUSD"):
            self.assertEqual(saved[key], value[key])
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

    def test_current_brief_financials_use_gateway_rate_instead_of_persisted_rate(self):
        cfg = {
            "id": "a",
            "companies": [{"id": "C1", "jurisdiction": "CN", "profitPolicy": "grandware-v40", "settlementCurrency": "CNY"}],
            "roles": copy.deepcopy(DEFAULT_ROLES),
            "teams": {},
        }
        actor = {"id": "U", "role": "admin", "tenantId": "a", "visibleCompanyIds": ["C1"]}
        rules = Rules(cfg, {"U": actor})
        data = {key: [] for key in ("customers", "factories", "orders", "shipments", "invoices")}
        data["customers"] = [{"id": "C", "companyId": "C1", "createdBy": "U"}]
        value = {
            "companyId": "C1", "customerId": "C", "companyOperationNo": "N1",
            "customerOrderNo": "PO-1", "contactPerson": "Buyer", "loadingPort": "Shanghai",
            "paymentTerms": "T/T", "orderDate": "2026-10-12", "orderAmountUSD": 1000,
            "factoryCostRMB": 4000, "freightCostUSD": 100, "insuranceCostUSD": 13,
            "otherCostUSD": 20,
        }
        meta = {
            "base": "USD", "quote": "CNY", "rawRate": 7.25, "adjustment": -0.02,
            "adjustedRate": 7.23, "provider": "ExchangeRate-API", "source": "open.er-api.com",
            "publishedAt": "2026-10-12T00:00:00Z", "fetchedAt": "2026-10-12T00:05:00Z",
            "nextUpdateAt": "2026-10-13T00:00:00Z", "cached": False, "stale": False,
        }
        supplied = {
            "expectedVersion": 0, "changes": [{"collection": "orders", "id": "N1", "value": value}],
            "liveExchangeRate": 7.23, "liveExchangeRateMeta": meta,
        }
        self.sign_gateway_payload("changes", supplied)
        with patch.object(self.api.repo, "payload", return_value=data), \
                patch.object(self.api.repo, "rates", return_value=({"C1": 9}, {})), \
                patch.object(self.api.repo, "find", return_value=None), \
                patch.object(self.api.repo, "save_record") as save, \
                patch.object(self.api.repo, "finish", return_value={"ok": True}) as finish:
            self.api._changes(Row(revision=0), cfg, actor, rules, supplied)
        saved = save.call_args.args[1]
        self.assertEqual(saved["orderAmountRMB"], 7230)
        self.assertNotEqual(saved["orderAmountRMB"], 9000)
        self.assertEqual(finish.call_args.args[3]["exchangeRate"]["adjustedRate"], 7.23)

    def test_hk_canonical_factory_cost_is_used_by_actual_order_save(self):
        for policy in ("grandware-v40", "generic-native"):
            with self.subTest(policy=policy):
                cfg = {"id": "a", "companies": [{"id": "C1", "jurisdiction": "HK", "profitPolicy": policy, "settlementCurrency": "USD", "exchangeRate": 999}], "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {}}
                actor = {"id": "U", "role": "admin", "tenantId": "a", "visibleCompanyIds": ["C1"]}
                rules = Rules(cfg, {"U": actor})
                data = {key: [] for key in ("customers", "factories", "orders", "shipments", "invoices")}
                data["customers"] = [{"id": "C", "companyId": "C1", "createdBy": "U"}]
                value = {"companyId": "C1", "customerId": "C", "companyOperationNo": "HK-1", "customerOrderNo": "PO-1", "contactPerson": "Buyer", "loadingPort": "Shanghai", "overseasPort": "Los Angeles", "paymentTerms": "T/T", "orderDate": "2026-10-12", "orderAmountUSD": 1000, "factoryCostUSD": 700, "otherCostUSD": 20}
                with patch.object(self.api.repo, "payload", return_value=data), patch.object(self.api.repo, "rates", return_value=({"C1": 999}, {})), patch.object(self.api.repo, "find", return_value=None), patch.object(self.api.repo, "save_record") as save, patch.object(self.api.repo, "finish", return_value={"ok": True}):
                    self.api._changes(Row(revision=0), cfg, actor, rules, {"expectedVersion": 0, "changes": [{"collection": "orders", "id": "HK-1", "value": value}]})
                saved = save.call_args.args[1]
                self.assertEqual(saved["profitRMB"], 280)
                self.assertEqual(saved["orderAmountRMB"], 1000)
                self.assertEqual(saved["factoryCostRMB"], 700)
                self.assertEqual(saved["factoryCostUSD"], 700)
                self.assertEqual(decode(encode(saved, ORDER, "Trade Order Brief"), ORDER, "Trade Order Brief")["profitRMB"], 280)

    def test_native_role_and_company_permission_are_current_authority(self):
        cfg = {"id": "a", "roles": {"admin": copy.deepcopy(DEFAULT_ROLES["admin"]), "auditor": {**copy.deepcopy(DEFAULT_ROLES["finance"]), "baseRole": "finance"}}, "companies": [{"id": "C1"}], "teams": {}}
        actor = {"id": "U", "tenantId": "a", "nativeUser": self.frappe.session.user, "role": "admin", "visibleCompanyIds": ["C1", "C2"]}
        with patch.object(self.api.repo, "workspace", return_value=(Row(frozen=False), cfg)), patch.object(self.api.repo, "profiles", return_value={"U": actor}), patch.object(self.api.repo, "ownership_profiles", return_value={"U": actor}), patch.object(self.frappe, "get_roles", return_value=["Tradept Auditor", "Sales Manager"], create=True), patch.object(self.frappe, "get_all", return_value=[Row(for_value="Company")]):
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

    def test_live_rate_snapshot_accepts_gateway_publication_and_rejects_tampering(self):
        metadata = {
            "base": "USD", "quote": "CNY", "rawRate": 7.25, "adjustment": -0.02,
            "adjustedRate": 7.23, "provider": "ExchangeRate-API", "source": "open.er-api.com",
            "publishedAt": "2026-10-12T00:00:00Z", "fetchedAt": "2026-10-12T00:05:00Z",
            "nextUpdateAt": "2026-10-13T00:00:00Z", "cached": True, "stale": False,
        }
        self.assertEqual(self.native.live_rate_snapshot(7.23, metadata)["adjustedRate"], 7.23)
        for patch_value in ({"source": "browser"}, {"adjustedRate": 7.24}, {"fetchedAt": "no timezone"}):
            with self.assertRaises(APIError) as caught:
                self.native.live_rate_snapshot(7.23, {**metadata, **patch_value})
            self.assertEqual(caught.exception.code, "INVALID_LIVE_RATE")
        with self.assertRaises(APIError) as caught:
            self.native.live_rate_snapshot(7.23, {**metadata, "stale": True})
        self.assertEqual((caught.exception.status, caught.exception.code), (503, "LIVE_RATE_STALE"))

    def test_gateway_assertion_binds_request_identity_and_rate(self):
        actor = {"id": "U", "tenantId": "a"}
        def supplied():
            value = {
                "expectedVersion": 4, "orderId": "O", "idempotencyKey": "convert-O",
                "liveExchangeRate": 7.23, "liveExchangeRateMeta": self.live_rate(),
            }
            return self.sign_gateway_payload("convert_order", value)

        valid = supplied()
        self.api._verify_gateway_assertion("convert_order", valid, {"id": "a"}, actor)
        self.assertNotIn("gatewayAssertion", valid)

        for name, mutate in (
            ("payload", lambda value: value.update(orderId="OTHER")),
            ("version", lambda value: value.update(expectedVersion=5)),
            ("idempotency", lambda value: value.update(idempotencyKey="other")),
            ("rate", lambda value: value.update(liveExchangeRate=7.24)),
        ):
            value = supplied()
            mutate(value)
            with self.subTest(binding=name), self.assertRaises(APIError) as caught:
                self.api._verify_gateway_assertion("convert_order", value, {"id": "a"}, actor)
            self.assertEqual(caught.exception.code, "GATEWAY_ASSERTION_INVALID")

        for name, value, action, cfg in (
            ("action", self.sign_gateway_payload("changes", {"expectedVersion": 4, "orderId": "O", "idempotencyKey": "convert-O", "liveExchangeRate": 7.23, "liveExchangeRateMeta": self.live_rate()}), "convert_order", {"id": "a"}),
            ("tenant", self.sign_gateway_payload("convert_order", {"expectedVersion": 4, "orderId": "O", "idempotencyKey": "convert-O", "liveExchangeRate": 7.23, "liveExchangeRateMeta": self.live_rate()}, tenant="other"), "convert_order", {"id": "a"}),
            ("site", self.sign_gateway_payload("convert_order", {"expectedVersion": 4, "orderId": "O", "idempotencyKey": "convert-O", "liveExchangeRate": 7.23, "liveExchangeRateMeta": self.live_rate()}, site="other.test"), "convert_order", {"id": "a"}),
        ):
            with self.subTest(binding=name), self.assertRaises(APIError) as caught:
                self.api._verify_gateway_assertion(action, value, cfg, actor)
            self.assertEqual(caught.exception.code, "GATEWAY_ASSERTION_INVALID")

        expired = {
            "expectedVersion": 4, "orderId": "O", "idempotencyKey": "convert-O",
            "liveExchangeRate": 7.23, "liveExchangeRateMeta": self.live_rate(),
        }
        self.sign_gateway_payload("convert_order", expired, issued_at=int(time.time()) - 181)
        with self.assertRaises(APIError) as caught:
            self.api._verify_gateway_assertion("convert_order", expired, {"id": "a"}, actor)
        self.assertEqual(caught.exception.code, "GATEWAY_ASSERTION_EXPIRED")

        session_bound = supplied()
        with patch.object(self.frappe.session, "sid", "another-native-session"), self.assertRaises(APIError) as caught:
            self.api._verify_gateway_assertion("convert_order", session_bound, {"id": "a"}, actor)
        self.assertEqual(caught.exception.code, "GATEWAY_ASSERTION_INVALID")

    def test_gateway_assertion_fails_closed_without_site_key(self):
        supplied = {
            "expectedVersion": 1, "orderId": "O", "idempotencyKey": "convert-O",
            "liveExchangeRate": 7.23, "liveExchangeRateMeta": self.live_rate(),
        }
        self.sign_gateway_payload("convert_order", supplied)
        with patch.object(self.frappe, "conf", Row()), self.assertRaises(APIError) as caught:
            self.api._verify_gateway_assertion("convert_order", supplied, {"id": "a"}, {"id": "U", "tenantId": "a"})
        self.assertEqual((caught.exception.status, caught.exception.code), (503, "GATEWAY_ASSERTION_CONFIG"))

    def test_direct_dispatch_cannot_forge_live_rate_but_accepts_gateway_assertion(self):
        cfg = {"id": "a"}
        actor = {"id": "U", "tenantId": "a"}
        rules = Mock(permitted=Mock(return_value=True), record_allowed=Mock(return_value=True), _validate_links=Mock())
        work = Row(revision=4)
        base = {
            "expectedVersion": 4, "orderId": "O", "idempotencyKey": "convert-O",
            "liveExchangeRate": 7.23, "liveExchangeRateMeta": self.live_rate(),
        }
        with patch.object(self.api, "_identity", return_value=(work, cfg, actor, rules, {})), \
                patch.object(self.api.native, "live_rate_snapshot") as validate:
            forged = self.api.dispatch("convert_order", json.dumps(base))
        self.assertEqual(forged["result"]["code"], "GATEWAY_ASSERTION_REQUIRED")
        validate.assert_not_called()

        signed = self.sign_gateway_payload("convert_order", copy.deepcopy(base))
        order = {"id": "O", "companyId": "C", "erpItems": []}
        refs = [{"doctype": "Sales Order", "name": "SO", "docstatus": 0}]
        with patch.object(self.api, "_identity", return_value=(work, cfg, actor, rules, {})), \
                patch.object(self.api.repo, "payload", return_value={"orders": [order]}), \
                patch.object(self.api.repo, "find", return_value=Row(sales_order=None)), \
                patch.object(self.api.native, "convert", return_value=refs), \
                patch.object(self.api, "delegated_operation", return_value=nullcontext()), \
                patch.object(self.api.repo, "finish", return_value={"ok": True, "meta": {"version": 5}}) as finish:
            accepted = self.api.dispatch("convert_order", json.dumps(signed))
        self.assertTrue(accepted["result"]["ok"])
        self.assertNotIn("gatewayAssertion", finish.call_args.args[3])

    def test_gateway_assertion_fields_cannot_be_persisted_as_order_extensions(self):
        payload = {
            "expectedVersion": 1,
            "changes": [{"collection": "orders", "id": "O", "value": {"remarks": "ok", "gatewayAssertion": {"claims": "browser"}}}],
        }
        with patch.object(self.api, "_identity") as identity:
            result = self.api.dispatch("changes", json.dumps(payload))
        self.assertEqual(result["result"]["code"], "RESERVED_GATEWAY_FIELD")
        identity.assert_not_called()

    def test_convert_uses_and_audits_gateway_rate_snapshot(self):
        supplied = {
            "expectedVersion": 4, "orderId": "O", "idempotencyKey": "convert-O",
            "liveExchangeRate": 7.23,
            "liveExchangeRateMeta": {
                "base": "USD", "quote": "CNY", "rawRate": 7.25, "adjustment": -0.02,
                "adjustedRate": 7.23, "provider": "ExchangeRate-API", "source": "open.er-api.com",
                "publishedAt": "2026-10-12T00:00:00Z", "fetchedAt": "2026-10-12T00:05:00Z",
                "nextUpdateAt": "2026-10-13T00:00:00Z", "cached": False, "stale": False,
            },
        }
        self.sign_gateway_payload("convert_order", supplied)
        order = {"id": "O", "companyId": "C", "erpItems": []}
        rules = Mock(permitted=Mock(return_value=True), record_allowed=Mock(return_value=True), _validate_links=Mock())
        refs = [{"doctype": "Sales Order", "name": "SO", "docstatus": 0}]
        with patch.object(self.api.repo, "payload", return_value={"orders": [order]}), \
                patch.object(self.api.repo, "find", return_value=Row(sales_order=None)), \
                patch.object(self.api.native, "convert", return_value=refs) as convert, \
                patch.object(self.api, "delegated_operation", return_value=nullcontext()), \
                patch.object(self.api.repo, "finish", return_value={"ok": True, "meta": {"version": 5}}) as finish:
            result = self.api._native_operation("convert_order", Row(revision=4), {"id": "a"}, {"id": "U", "tenantId": "a"}, rules, supplied)
        snapshot = convert.call_args.args[4]
        self.assertEqual(snapshot["adjustedRate"], 7.23)
        self.assertEqual(finish.call_args.args[3]["exchangeRate"], snapshot)
        self.assertNotIn("gatewayAssertion", finish.call_args.args[3])
        self.assertEqual(result["nativeDocuments"], refs)

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

    def _legacy_receipt_policy(self):
        cfg = {"id": "a", "companies": [{"id": "C"}], "roles": copy.deepcopy(DEFAULT_ROLES)}
        actor = {"id": "U", "role": "finance", "tenantId": "a", "nativeUser": self.frappe.session.user, "visibleCompanyIds": ["C"]}
        value = {"id": "O", "companyId": "C", "createdBy": "U"}
        data = {"orders": [value]}
        return cfg, actor, Rules(cfg, {"U": actor, "Other": {"id": "Other"}}), value, data

    def test_legacy_receipt_requires_new_create_submit_and_financial_record_scope(self):
        for case in ("old-grant-only", "submit-revoked", "narrow-scope"):
            cfg, actor, rules, value, data = self._legacy_receipt_policy()
            if case == "old-grant-only":
                cfg["roles"]["finance"]["permissions"] = [cap for cap in cfg["roles"]["finance"]["permissions"] if not cap.startswith("finance.payment_entry.")]
            elif case == "submit-revoked":
                cfg["roles"]["finance"]["permissions"].remove("finance.payment_entry.submit")
            else:
                cfg["roles"]["finance"]["financePolicy"]["scope"] = "self"
                value["createdBy"] = "Other"
            with patch.object(self.native.repo, "native_company", return_value="Company"), \
                    patch.object(self.native, "documents", return_value=[{"doctype": "Sales Order", "name": "SO"}]), \
                    patch.object(self.native, "order_finance", return_value={"advanceBase": 0, "invoiceNames": []}), \
                    patch.object(self.frappe.db, "exists", return_value=True), \
                    patch.object(self.frappe.db, "get_value", return_value="Company"), \
                    patch.object(self.frappe, "get_all", return_value=[Row(for_value="Company")]), \
                    patch.object(self.frappe, "get_doc") as load:
                with self.assertRaises(APIError) as caught:
                    with self.permissions.delegated_operation("receive_payment", cfg, actor, rules, value, data, Row(sales_order="SO")):
                        self.fail("An old receipt entry point bypassed financial grants")
                self.assertEqual(caught.exception.code, "FINANCE_RECORD_DENIED" if case == "narrow-scope" else "FINANCE_PERMISSION_DENIED")
                load.assert_not_called()
            self.assertEqual(self.frappe.session.user, actor["nativeUser"])
            self.assertIsNone(self.permissions.delegated_actor())

    def test_legacy_receipt_native_helper_requires_authorized_financial_context(self):
        with self.assertRaises(APIError) as caught:
            self.native.receive_payment(Row(sales_order="SO"), {"id": "O", "companyId": "C"}, {"amountUSD": 20, "idempotencyKey": "key"})
        self.assertEqual(caught.exception.code, "FINANCE_DELEGATION_DENIED")

    def test_legacy_receipt_cannot_bypass_bank_allowlist_or_native_amount_cap(self):
        for constraint, expected in (({"paymentLimit": {"amount": 10, "currency": "USD"}}, "FINANCE_PAYMENT_LIMIT_EXCEEDED"), ({"allowedBankAccounts": ["Allowed Bank"]}, "FINANCE_BANK_ACCOUNT_DENIED")):
            cfg, actor, rules, value, data = self._legacy_receipt_policy()
            cfg["roles"]["finance"]["financePolicy"].update(constraint)
            sale = Row(doctype="Sales Order", name="SO", company="Company", currency="USD", customer="Customer", docstatus=1, grand_total=100, advance_paid=0, conversion_rate=1, custom_tradept_order_id="O", get_all_children=lambda: [])
            company = Row(default_currency="USD", default_bank_account="Bank")
            reference = Row(reference_doctype="Sales Order", reference_name="SO", allocated_amount=20)
            entry = Row(doctype="Payment Entry", name=None, company="Company", owner="Administrator", payment_type="Receive", party_type="Customer", party="Customer", paid_from="Receivable", paid_to="Bank", paid_amount=20, received_amount=20, total_allocated_amount=20, references=[reference], flags=Row(), is_new=lambda: True, get_all_children=lambda: [reference], set_amounts=Mock(), insert=Mock(), submit=Mock())
            def db_value(doctype, name, field, **kwargs):
                if doctype == "Payment Entry":
                    return None
                if doctype == "Bank Account":
                    return {"company": "Company", "is_company_account": 1, "account": "Allowed Bank GL"}
                if doctype == "Account":
                    return "USD" if field == "account_currency" else "Company" if field == "company" else None
                if doctype == "Customer":
                    return "Company" if field == "custom_tradept_company" else "Customer"
                if doctype == "Company":
                    return "USD"
                return "Company"
            modules = {"erpnext.accounts.doctype.payment_entry.payment_entry": Row(get_payment_entry=Mock(return_value=entry)), "erpnext.accounts.party": Row(get_party_account=lambda *args: "Receivable")}
            with patch.dict(sys.modules, modules), \
                    patch.object(self.native, "order_finance", return_value={"advanceBase": 0, "invoiceNames": []}), \
                    patch.object(self.native.repo, "native_company", return_value="Company"), \
                    patch.object(self.native, "documents", return_value=[{"doctype": "Sales Order", "name": "SO"}]), \
                    patch.object(self.frappe.db, "exists", return_value=True), \
                    patch.object(self.frappe.db, "get_value", side_effect=db_value), \
                    patch.object(self.frappe, "get_all", return_value=[Row(for_value="Company")]), \
                    patch.object(self.frappe, "get_doc", side_effect=lambda doctype, name, **kwargs: sale if doctype == "Sales Order" else company), \
                    patch.object(self.attribution, "capture", return_value={}):
                with self.assertRaises(APIError) as caught:
                    with self.permissions.delegated_operation("receive_payment", cfg, actor, rules, value, data, Row(sales_order="SO")):
                        self.native.receive_payment(Row(sales_order="SO"), value, {"amountUSD": 20, "idempotencyKey": "legacy-receipt"})
                self.assertEqual(caught.exception.code, expected)
                entry.set_amounts.assert_called_once()
                entry.insert.assert_not_called()
                entry.submit.assert_not_called()
            self.assertEqual(self.frappe.session.user, actor["nativeUser"])
            self.assertIsNone(self.permissions.delegated_actor())

    def test_successful_payment_retry_acknowledges_before_stale_cas(self):
        rules = Row(permitted=lambda *args: True, record_allowed=lambda *args: True)
        self.frappe.db.exists.return_value = True
        with patch.object(self.api.repo, "payload", return_value={"orders": [{"id": "O", "companyId": "C"}]}), patch.object(self.api.repo, "find", return_value=Row(sales_order="SO")), patch.object(self.api, "delegated_operation", return_value=nullcontext()) as delegate, patch.object(self.api.native, "receive_payment", return_value=[{"doctype": "Payment Entry", "name": "PE"}]), patch.object(self.api.repo, "finish") as finish:
            result = self.api._native_operation("receive_payment", Row(revision=3, updated_at_source="now", updated_by_id="U"), {}, {"id": "U"}, rules, {"expectedVersion": 1, "orderId": "O", "idempotencyKey": "receipt", "amountUSD": 100})
        self.assertTrue(result["alreadyApplied"])
        self.assertEqual(result["meta"]["version"], 3)
        finish.assert_not_called()
        self.assertEqual(delegate.call_args.args[0], "receive_payment")

    def test_idempotent_legacy_receipt_retry_still_enforces_current_financial_grants(self):
        rules = Row(permitted=lambda *args: True, record_allowed=lambda *args: True)
        with patch.object(self.frappe.db, "exists", return_value=True), \
                patch.object(self.api.repo, "payload", return_value={"orders": [{"id": "O", "companyId": "C"}]}), \
                patch.object(self.api.repo, "find", return_value=Row(sales_order="SO")), \
                patch.object(self.api, "delegated_operation", side_effect=APIError(403, "FINANCE_PERMISSION_DENIED", "Revoked financial permission")), \
                patch.object(self.api.native, "receive_payment") as receive:
            with self.assertRaises(APIError) as caught:
                self.api._native_operation("receive_payment", Row(revision=3), {}, {"id": "U"}, rules, {"expectedVersion": 1, "orderId": "O", "idempotencyKey": "receipt", "amountUSD": 100})
            self.assertEqual(caught.exception.code, "FINANCE_PERMISSION_DENIED")
            receive.assert_not_called()

    def test_administrator_finance_options_use_native_v16_bank_account_label(self):
        cfg, actor, rules, _value, _data = self._legacy_receipt_policy()
        def accounts(doctype, **kwargs):
            if doctype == "User Permission":
                return [Row(for_value="Company")]
            self.assertEqual(doctype, "Bank Account")
            self.assertIn("account_name", kwargs["fields"])
            self.assertNotIn("bank_account_name", kwargs["fields"])
            return [Row(name="BANK-ACCOUNT", account_name="Test corporate USD bank", company="Company", account="Bank")]
        with patch.object(self.native.repo, "native_company", return_value="Company"), \
                patch.object(self.frappe, "get_all", side_effect=accounts), \
                patch.object(self.frappe.db, "exists", return_value=True), \
                patch.object(self.frappe.db, "get_value", return_value="USD"):
            options = self.administrator._finance_options(cfg, actor, rules)
        self.assertEqual(options["bankAccounts"], [{"name": "BANK-ACCOUNT", "label": "Test corporate USD bank", "currency": "USD", "companyId": "C"}])
        self.assertIn("finance.payment_entry.submit", options["capabilities"])

    def test_native_projection_freezes_conversion_and_reads_live_paid_balance(self):
        sale = Row(name="SO", company="Company", customer="Customer", customer_name="Native customer", po_no="Native-PO", transaction_date="2026-10-01", delivery_date="2026-10-13", currency="USD", grand_total=1000, base_grand_total=6690, conversion_rate=6.69, advance_paid=250, docstatus=1, per_delivered=0, items=[Row(name="SO-L", custom_tradept_line_id="L", custom_tradept_supplier_id="F", item_code="ITEM", uom="Box", qty=10, rate=100)])
        po = Row(name="PO", company="Company", currency="CNY", base_grand_total=4000, conversion_rate=1, advance_paid=0, supplier="Supplier", supplier_name="Supplier", schedule_date="2026-10-13", items=[Row(custom_tradept_line_id="L", item_code="ITEM", qty=10, rate=400, base_amount=4000)])
        company = Row(default_currency="CNY", custom_tradept_profit_policy="generic-native", custom_tradept_record_id="C1")
        lookup = {("Sales Order", "SO"): sale, ("Purchase Order", "PO"): po, ("Company", "Company"): company}
        with patch.object(self.frappe, "get_doc", side_effect=lambda dt, name: lookup[(dt, name)]), patch.object(self.frappe, "get_all", return_value=[]), patch.object(self.frappe.db, "get_value", side_effect=lambda dt, name, field: "C" if dt == "Customer" else "F"), patch.object(self.native, "documents", return_value=[{"doctype": "Sales Order", "name": "SO", "docstatus": 1}, {"doctype": "Purchase Order", "name": "PO", "docstatus": 1}]), patch.object(self.native.repo, "rates", side_effect=AssertionError("Current FX must not restate native order")):
            plan = child_encode({"factoryId": "F", "productType": "Production category", "inspectionDate": "2026-10-12", "estimatedShipDate": "2026-10-14"}, FACTORY_LINE)
            with patch.object(self.native, "order_finance", side_effect=lambda order: {"advanceBase": float(order.advance_paid or 0) * float(order.conversion_rate), "invoiceSettledBase": 0, "invoiceOutstandingBase": 0, "invoiceBilledBase": 0, "invoiceNames": [], "receipts": []}):
                projected = self.native.project_order(Row(sales_order="SO", factory_lines=[plan]), {"id": "O", "customerName": "stale quote", "customerOrderNo": "stale quote", "orderDate": "2000-01-01", "freightCostUSD": 100, "insuranceCostUSD": 10, "otherCostUSD": 0})
        self.assertEqual(projected["erpItems"][0]["uom"], "Box")
        self.assertAlmostEqual(projected["paidAmountUSD"], 250)
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
            with patch.object(self.native, "order_finance", side_effect=lambda order: {"advanceBase": float(order.advance_paid or 0) * float(order.conversion_rate), "invoiceSettledBase": 0, "invoiceOutstandingBase": 0, "invoiceBilledBase": 0, "invoiceNames": [], "receipts": []}):
                projected = self.native.project_order(Row(sales_order="SO", factory_lines=[]), {"id": "O"})
        self.assertEqual(len(projected["factories"]), 1)
        self.assertEqual(projected["factories"][0]["totalQuantity"], 15)
        self.assertAlmostEqual(projected["factories"][0]["totalAmount"], 1001.4)
        self.assertAlmostEqual(projected["factories"][0]["prepayment"], 116.9)


if __name__ == "__main__":
    unittest.main()
