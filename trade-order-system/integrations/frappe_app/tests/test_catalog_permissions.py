"""Native Item delegation boundaries; catalog business tests live separately."""
import copy
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.domain import APIError, CATALOG_CAPABILITIES, DEFAULT_ROLES, Rules
from test_finance_permissions import Doc


class CatalogDelegationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stub = SimpleNamespace(db=Mock(), session=SimpleNamespace(user="owner@example.invalid"), local=SimpleNamespace(), flags=SimpleNamespace())
        cls.package = sys.modules["tradept_core"]
        original = dict(vars(cls.package))
        with patch.dict(sys.modules, {"frappe": sys.modules.get("frappe", stub)}):
            cls.permissions = importlib.import_module("tradept_core.permissions")
            cls.events = importlib.import_module("tradept_core.events")
            cls.attribution = importlib.import_module("tradept_core.attribution")
            cls.catalog = importlib.import_module("tradept_core.catalog")
            cls.administrator = importlib.import_module("tradept_core.administrator")
        # patch.dict restores sys.modules but import also sets package attrs.
        # Keep stub-backed module instances private to this test class.
        for key in set(vars(cls.package)) - set(original):
            delattr(cls.package, key)
        for key, value in original.items():
            setattr(cls.package, key, value)

    def setUp(self):
        self.frappe = SimpleNamespace(db=Mock(), get_all=Mock(), session=SimpleNamespace(user="owner@example.invalid", sid="same-native-sid", data={"csrf_token": "same-csrf"}), local=SimpleNamespace(form_dict={"operation": "save"}, cache={"original": True}), flags=SimpleNamespace(tradept_managed_write=True))
        for module in (self.permissions, self.events, self.attribution, self.catalog, self.administrator, self.catalog.repo):
            change = patch.object(module, "frappe", self.frappe)
            change.start()
            self.addCleanup(change.stop)
        for name, module in {"permissions": self.permissions, "events": self.events, "attribution": self.attribution, "catalog": self.catalog, "administrator": self.administrator, "repository": self.catalog.repo}.items():
            change = patch.object(self.package, name, module, create=True)
            change.start()
            self.addCleanup(change.stop)
        modules = patch.dict(sys.modules, {"frappe": self.frappe, "tradept_core.permissions": self.permissions, "tradept_core.events": self.events, "tradept_core.attribution": self.attribution, "tradept_core.catalog": self.catalog})
        modules.start()
        self.addCleanup(modules.stop)
        self.cfg = {"id": "tenant", "companies": [{"id": "A"}, {"id": "B"}], "roles": {"catalog": {"scope": "tenant", "permissions": sorted(CATALOG_CAPABILITIES)}}, "teams": {}}
        self.actor = {"id": "Owner", "nativeUser": self.frappe.session.user, "tenantId": "tenant", "role": "catalog", "teamId": "T", "visibleCompanyIds": ["A", "B"]}
        self.rules = Rules(self.cfg, {"Owner": self.actor})
        self.company_grants = ["Company A", "Company B"]
        self.frappe.get_all.side_effect = lambda kind, **kwargs: [SimpleNamespace(for_value=name) for name in self.company_grants] if kind == "User Permission" else []
        self.frappe.db.exists.return_value = True
        native = patch.object(self.catalog.repo, "native_company", side_effect=lambda company: {"A": "Company A", "B": "Company B"}.get(company))
        native.start()
        self.addCleanup(native.stop)
        self.policy = self.catalog.CatalogPolicy(self.cfg, self.actor, self.rules)
        self.capture = patch.object(self.attribution, "capture", return_value={}).start()
        self.finish = patch.object(self.attribution, "finish").start()
        self.addCleanup(patch.stopall)

    def item(self, **values):
        return Doc(doctype="Item", name="ITEM-A", owner="owner@example.invalid", custom_tradept_company="Company A", is_stock_item=0, **values)

    def denied(self, code, function):
        with self.assertRaises(APIError) as caught:
            function()
        self.assertEqual(caught.exception.code, code)

    def test_defaults_and_explicit_template_do_not_expand_other_roles(self):
        self.assertTrue(CATALOG_CAPABILITIES.issubset(DEFAULT_ROLES["admin"]["permissions"]))
        self.assertFalse(CATALOG_CAPABILITIES.intersection(DEFAULT_ROLES["finance"]["permissions"]))
        cfg = {"roles": {"admin": {"scope": "tenant", "permissions": {"read": True, "finance.write": False}}, "custom": {"scope": "tenant", "permissions": []}, "finance": {"scope": "tenant", "permissions": ["finance.read"]}}}
        before = copy.deepcopy(cfg)
        self.assertFalse(self.administrator._catalog_options(cfg)["initialized"])
        self.denied("INVALID_CATALOG_TEMPLATE_ROLE", lambda: self.administrator._catalog_template(cfg, self.actor, {"roleKeys": ["custom"]}))
        result = self.administrator._catalog_template(cfg, self.actor, {"roleKeys": ["admin"]})
        self.assertEqual(result["roleKeys"], ["admin"])
        self.assertTrue(self.administrator._catalog_options(cfg)["initialized"])
        self.assertEqual(cfg["roles"]["custom"], before["roles"]["custom"])
        self.assertEqual(cfg["roles"]["finance"], before["roles"]["finance"])
        self.assertNotIn("finance.write", cfg["roles"]["admin"]["permissions"])
        self.assertEqual(set(self.administrator._role_permissions(sorted(CATALOG_CAPABILITIES))), CATALOG_CAPABILITIES)

    def test_exact_capabilities_and_company_grants_apply_before_delegation(self):
        self.cfg["roles"]["catalog"]["permissions"] = ["catalog.create"]
        for action in ("read", "write", "disable"):
            with self.subTest(action=action):
                self.denied("CATALOG_PERMISSION_DENIED", lambda: self._delegate(action, self.item()))
        self.cfg["roles"]["catalog"]["permissions"] = sorted(CATALOG_CAPABILITIES)
        self.company_grants = ["Company B"]
        self.denied("CATALOG_COMPANY_DENIED", lambda: self._delegate("write", self.item()))
        self.assertEqual(self.frappe.session.user, self.actor["nativeUser"])
        self.assertIsNone(self.permissions.delegated_catalog_grant())
        self.capture.assert_not_called()

    def _delegate(self, action, item):
        with self.permissions.delegated_catalog_operation(action, self.policy, item, "Company A"):
            pass

    def test_success_preserves_sid_csrf_existing_owner_and_stamps_new_children(self):
        item = self.item()
        item.owner = "historical-owner@example.invalid"
        item.defaults = [Doc(doctype="Item Default", name="NEW-ROW", owner="Administrator", _new=True)]
        old_cache = self.frappe.local.cache
        with self.permissions.delegated_catalog_operation("write", self.policy, item, "Company A") as references:
            self.assertEqual(self.frappe.session.user, "Administrator")
            self.events.before_catalog_write(item, "before_save")
            self.events.before_native_write(item, "before_save")
            self.assertEqual(item.owner, "historical-owner@example.invalid")
            self.assertEqual(item.modified_by, self.actor["nativeUser"])
            self.assertEqual(item.defaults[0].owner, self.actor["nativeUser"])
            self.assertEqual(references, [{"doctype": "Item", "name": "ITEM-A"}])
        self.assertEqual(self.frappe.session.user, self.actor["nativeUser"])
        self.assertEqual(self.frappe.session.sid, "same-native-sid")
        self.assertEqual(self.frappe.session.data["csrf_token"], "same-csrf")
        self.assertIs(self.frappe.local.cache, old_cache)
        self.finish.assert_called_once_with({}, [{"doctype": "Item", "name": "ITEM-A"}], None, self.actor["nativeUser"])

    def test_new_item_owner_is_restored_after_native_administrator_timestamping(self):
        self.cfg["roles"]["catalog"]["scope"] = "self"
        item = self.item(_new=True)
        with self.permissions.delegated_catalog_operation("create", self.policy, item, "Company A") as references:
            item.owner = "Administrator"
            self.events.before_catalog_write(item, "before_insert")
            self.assertEqual(item.owner, self.actor["nativeUser"])
            self.events.after_native_write(item, "on_update")
            self.assertEqual(references, [{"doctype": "Item", "name": "ITEM-A"}])
        self.finish.assert_called_once()

    def test_read_and_write_delegations_cannot_write_another_parent_or_variant(self):
        target = self.item()
        with self.permissions.delegated_catalog_operation("read", self.policy, target, "Company A"):
            self.denied("CATALOG_READ_ONLY_DELEGATION", lambda: self.events.before_catalog_write(target, "before_save"))
        for doc in (Doc(doctype="Item Price", name="PRICE"), Doc(doctype="Stock Entry", name="STOCK"), self.item(_new=True)):
            with self.subTest(doctype=doc.doctype):
                with self.permissions.delegated_catalog_operation("write", self.policy, target, "Company A"):
                    self.denied("CATALOG_UNBOUND_NATIVE_WRITE", lambda: self.events.before_catalog_write(doc, "before_insert"))

    def test_native_child_is_bound_to_target_metadata_and_authorized_company(self):
        target = self.item()
        child = Doc(doctype="Item Default", name="ROW", parent="ITEM-A", parenttype="Item", parentfield="item_defaults", company="Company A", _new=True, meta=SimpleNamespace(istable=True))
        target.item_defaults = [child]
        target.meta = SimpleNamespace(get_field=lambda field: SimpleNamespace(options="Item Default") if field == "item_defaults" else None)
        with self.permissions.delegated_catalog_operation("write", self.policy, target, "Company A"):
            self.events.before_catalog_write(child, "before_insert")
            self.assertEqual(child.owner, self.actor["nativeUser"])
            child.company = "Company B"
            self.denied("CATALOG_COMPANY_DENIED", lambda: self.events.before_catalog_write(child, "before_save"))
            child.company, child.parent = "Company A", "UNRELATED-ITEM"
            self.denied("CATALOG_UNBOUND_NATIVE_WRITE", lambda: self.events.before_catalog_write(child, "before_save"))

    def test_failure_restores_native_session_and_no_context_leaks_to_next_request(self):
        item = self.item()
        old_cache = self.frappe.local.cache
        with self.assertRaises(ValueError):
            with self.permissions.delegated_catalog_operation("write", self.policy, item, "Company A"):
                raise ValueError("Native save failed")
        self.assertEqual(self.frappe.session.user, self.actor["nativeUser"])
        self.assertIs(self.frappe.local.cache, old_cache)
        self.assertIsNone(self.permissions.delegated_actor())
        self.assertIsNone(self.permissions.delegated_catalog_grant())
        self.finish.assert_not_called()
        self.events.before_catalog_write(Doc(doctype="Item Price", name="PRICE"), "before_save")
        self.assertFalse(self.permissions.native_permission(user=self.actor["nativeUser"]))

    def test_item_native_operator_changes_enter_workspace_audit_and_cas(self):
        self.frappe.flags.tradept_managed_write = False
        item = self.item()
        with patch.object(self.events.repo, "workspace", return_value=(Doc(revision=7), {})) as workspace, patch.object(self.events.repo, "finish") as finish:
            self.events.before_native_write(item, "before_save")
            self.events.after_native_write(item, "on_update")
            workspace.assert_called_with(lock=True)
            self.frappe.db.before_commit.add.assert_called_once_with(self.events._finish_native_changes)
            self.events._finish_native_changes()
        self.assertEqual(finish.call_args.args[2], "native-change")
        self.assertEqual(finish.call_args.args[3], [{"doctype": "Item", "name": "ITEM-A", "event": "on_update"}])


if __name__ == "__main__":
    unittest.main()
