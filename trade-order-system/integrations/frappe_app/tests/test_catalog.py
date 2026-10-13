"""Exact catalog authorization, immutable SKU fields and native usage gates."""
import copy
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.domain import APIError, Rules


class Row(dict):
    __getattr__ = dict.get
    __setattr__ = dict.__setitem__
    def set(self, key, value):
        self[key] = value


class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tradept_core
        cls.package = tradept_core
        cls.package_before = dict(vars(tradept_core))
        fake = SimpleNamespace(db=Mock(), get_doc=Mock(), get_all=Mock(), flags=Row(), session=Row(user="user@example.invalid"))
        cls.modules_patch = patch.dict(sys.modules, {"frappe": fake})
        cls.modules_patch.start()
        cls.catalog = importlib.import_module("tradept_core.catalog")

    @classmethod
    def tearDownClass(cls):
        cls.modules_patch.stop()
        for name in set(vars(cls.package)) - set(cls.package_before):
            delattr(cls.package, name)
        vars(cls.package).update(cls.package_before)

    def setUp(self):
        self.cfg = {"id": "T", "companies": [{"id": "A"}, {"id": "B"}], "roles": {"operator": {"permissions": list(self.catalog.CAPABILITIES), "scope": "tenant"}}}
        self.actor = {"id": "U", "nativeUser": "user@example.invalid", "tenantId": "T", "role": "operator", "teamId": "TEAM", "visibleCompanyIds": ["A", "B"]}
        self.history = {"OLD": {"id": "OLD", "nativeUser": "old@example.invalid", "teamId": "TEAM", "disabled": True}}
        self.rules = Rules(self.cfg, {"U": self.actor}, self.history)
        self.frappe = SimpleNamespace(db=Mock(), get_doc=Mock(), get_all=Mock(return_value=[Row(for_value="Company A"), Row(for_value="Company B")]), flags=Row(), session=Row(user=self.actor["nativeUser"]))
        self.frappe.db.exists.return_value = True
        self.patch = patch.object(self.catalog, "frappe", self.frappe)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.company_patch = patch.object(self.catalog.repo, "native_company", side_effect=lambda logical: {"A": "Company A", "B": "Company B"}.get(logical))
        self.company_patch.start(); self.addCleanup(self.company_patch.stop)
        self.policy = self.catalog.CatalogPolicy(self.cfg, self.actor, self.rules)

    def denied(self, code, fn, *args, **kwargs):
        with self.assertRaises(APIError) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def item(self, tag="Company A", owner=None):
        return Row(doctype="Item", name="SKU", item_code="SKU", item_name="Product", item_group="Products", stock_uom="Nos", description="Product", custom_tradept_company=tag, owner=owner or self.actor["nativeUser"], modified="now", modified_by=self.actor["nativeUser"], is_stock_item=0, disabled=0, is_sales_item=1, is_purchase_item=1)

    def test_legacy_finance_grants_do_not_implicitly_authorize_catalog(self):
        self.cfg["roles"]["operator"]["permissions"] = ["read", "edit", "finance.write"]
        for action in ("read", "create", "write", "disable"):
            self.denied("CATALOG_PERMISSION_DENIED", self.policy.require, action, "A")

    def test_company_scope_intersects_real_user_permission(self):
        self.frappe.get_all.return_value = [Row(for_value="Company A")]
        self.assertEqual(self.policy.companies(), {"A": "Company A"})
        self.denied("CATALOG_COMPANY_DENIED", self.policy.require, "read", "B")

    def test_cross_tenant_and_native_service_identity_fail_closed(self):
        self.actor["tenantId"] = "OTHER"
        self.denied("CATALOG_PERMISSION_DENIED", self.policy.require, "read", "A")
        self.actor["tenantId"], self.actor["nativeUser"] = "T", "Administrator"
        self.assertEqual(self.policy.companies(), {})

    def test_company_tag_controls_usage_not_item_defaults(self):
        item = self.item()
        item.item_defaults = [Row(company="Company B")]
        self.catalog.require_usable_item(item, "Company A")
        self.denied("CATALOG_ITEM_COMPANY_DENIED", self.catalog.require_usable_item, item, "Company B")
        item.custom_tradept_company = None
        self.catalog.require_usable_item(item, "Company B")

    def test_disabled_and_purchase_sales_flags_gate_new_native_usage(self):
        item = self.item()
        item.disabled = 1
        self.denied("CATALOG_ITEM_DISABLED", self.catalog.require_usable_item, item, "Company A")
        item.disabled, item.is_purchase_item = 0, 0
        self.catalog.require_usable_item(item, "Company A", sales=True)
        self.denied("CATALOG_ITEM_USE_DENIED", self.catalog.require_usable_item, item, "Company A", sales=False)

    def test_company_catalog_read_does_not_require_owning_every_shared_sku(self):
        self.cfg["roles"]["operator"]["scope"] = "self"
        self.policy.require_item(self.item(owner="old@example.invalid"), "read", "Company A")
        self.policy.require_item(self.item(tag=None, owner="Administrator"), "read", "Company A")
        self.denied("CATALOG_SCOPE_DENIED", self.policy.require_item, self.item(owner="old@example.invalid"), "write", "Company A")

    def test_team_ownership_includes_disabled_historical_owner(self):
        self.cfg["roles"]["operator"]["scope"] = "team"
        self.policy.require_item(self.item(owner="old@example.invalid"), "write", "Company A")
        self.denied("CATALOG_SCOPE_DENIED", self.policy.require_item, self.item(owner="stranger@example.invalid"), "write", "Company A")

    def test_shared_modification_requires_tenant_and_all_company_grants(self):
        shared = self.item(tag=None)
        self.policy.require_item(shared, "write", "Company A")
        self.frappe.get_all.return_value = [Row(for_value="Company A")]
        self.denied("CATALOG_SHARED_WRITE_DENIED", self.policy.require_item, shared, "write", "Company A")
        self.cfg["roles"]["operator"]["scope"] = "team"
        self.denied("CATALOG_SHARED_WRITE_DENIED", self.policy.require_item, shared, "disable", "Company A")

    def test_disable_is_independent_from_write(self):
        self.cfg["roles"]["operator"]["permissions"] = ["catalog.read", "catalog.write"]
        self.denied("CATALOG_PERMISSION_DENIED", self.policy.require_item, self.item(), "disable", "Company A")

    def test_new_items_must_be_current_company_nonstock(self):
        self.policy.require_item(self.item(), "create", "Company A")
        self.denied("CATALOG_CREATE_DENIED", self.policy.require_item, self.item(tag=None), "create", "Company A")
        stock = self.item(); stock.is_stock_item = 1
        self.denied("CATALOG_CREATE_DENIED", self.policy.require_item, stock, "create", "Company A")

    def test_stock_sku_basic_edit_keeps_native_stock_attributes(self):
        stock = self.item(); stock.is_stock_item = 1
        self.policy.require_item(stock, "write", "Company A")
        self.catalog._values(stock, {"itemName": "Updated"})
        self.assertEqual(stock.is_stock_item, 1)

    def test_variant_template_cannot_enqueue_cross_sku_updates(self):
        template = self.item(); template.has_variants = 1
        self.denied("CATALOG_NATIVE_TEMPLATE_REQUIRED", self.policy.require_item, template, "write", "Company A")
        self.assertFalse(self.catalog.public(template, self.policy)["canWrite"])

    def test_only_explicit_codes_and_real_group_uom_are_supported(self):
        new = self.item()
        values = {"itemCode": "EXPLICIT", "itemName": "Product", "itemGroup": "Products", "stockUom": "Nos"}
        self.catalog._values(new, values, create=True)
        self.assertEqual(new.item_code, "EXPLICIT")
        self.frappe.db.exists.side_effect = lambda dt, *args: dt != "UOM"
        self.denied("CATALOG_UOM_REQUIRED", self.catalog._values, new, values, create=True)
        self.frappe.db.exists.side_effect = lambda dt, *args: dt != "Item Group"
        self.denied("CATALOG_GROUP_REQUIRED", self.catalog._values, new, values, create=True)

    def test_sku_company_stock_price_and_native_flags_are_not_writable(self):
        for values in ({"itemCode": "OTHER"}, {"companyId": "B"}, {"custom_tradept_company": "Company B"}, {"isStockItem": True}, {"standardRate": 100}, {"openingStock": 5}, {"flags": {"ignore_permissions": True}}):
            self.denied("INVALID_FINANCE_FIELDS", self.catalog._values, self.item(), values)

    def test_public_item_never_exposes_account_cost_or_price_metadata(self):
        item = self.item(); item.valuation_rate = 999; item.item_defaults = [Row(default_expense_account="Secret")]
        result = self.catalog.public(item, self.policy)
        self.assertNotIn("valuation_rate", result)
        self.assertNotIn("item_defaults", result)
        self.assertEqual((result["companyId"], result["shared"]), ("A", False))

    def test_replay_rechecks_exact_action_company_and_real_item_scope(self):
        self.cfg["roles"]["operator"]["permissions"] = ["catalog.read", "catalog.create"]
        self.denied("CATALOG_PERMISSION_DENIED", self.catalog.perform, Row(revision=1), self.cfg, self.actor, self.rules, {"companyId": "A", "operation": "disable", "idempotencyKey": "old-receipt"})

    def test_cas_and_modified_are_required_before_controller_save(self):
        self.frappe.get_all.side_effect = lambda dt, **kw: [] if dt == "Trade Audit" else [Row(for_value="Company A"), Row(for_value="Company B")]
        supplied = {"companyId": "A", "operation": "save", "name": "SKU", "expectedVersion": 1, "idempotencyKey": "save", "values": {"itemName": "Updated"}}
        self.denied("VERSION_CONFLICT", self.catalog.perform, Row(revision=2), self.cfg, self.actor, self.rules, supplied)
        with patch.object(self.catalog, "_load", return_value=self.item()):
            self.denied("EXPECTED_MODIFIED_REQUIRED", self.catalog.perform, Row(revision=1), self.cfg, self.actor, self.rules, supplied)
            self.denied("STALE_DOCUMENT", self.catalog.perform, Row(revision=1), self.cfg, self.actor, self.rules, {**supplied, "expectedModified": "old"})


if __name__ == "__main__":
    unittest.main()
