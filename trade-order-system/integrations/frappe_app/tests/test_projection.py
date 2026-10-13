"""Order accounting projections cannot be forged or reveal ungranted vouchers."""
import copy
import importlib
import json
import sys
import unittest
from unittest.mock import Mock, patch

from test_core import Row, fake_frappe
from tradept_core.domain import APIError


class OrderProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch.dict(sys.modules, {"frappe": fake_frappe()}):
            cls.api = importlib.import_module("tradept_core.api")
            cls.finance_permissions = importlib.import_module("tradept_core.finance_permissions")

    def setUp(self):
        self.frappe = fake_frappe()
        self.addCleanup(patch.stopall)
        patch.object(self.api, "frappe", self.frappe).start()
        patch.dict(sys.modules, {"frappe": self.frappe, "tradept_core.finance_permissions": self.finance_permissions}).start()

    def test_even_financial_administrators_cannot_forge_projected_receipts(self):
        for field in self.api.PROJECTED_ORDER_FIELDS:
            with self.subTest(field=field), self.assertRaises(APIError) as caught:
                self.api._check_projection_patch(None, {field: "forged"})
            self.assertEqual(caught.exception.code, "NATIVE_PROJECTION_READ_ONLY")
        for field in self.api.PROJECTED_FACTORY_FIELDS:
            with self.subTest(field=field), self.assertRaises(APIError):
                self.api._check_projection_patch({"factories": [{"factoryId": "F"}]}, {"factories": [{"factoryId": "F", field: 100}]})
        old = {"salesInvoiceNames": ["SI-1"], "factories": [{"factoryId": "F", "invoiceSettledAmount": 20}]}
        self.api._check_projection_patch(old, copy.deepcopy(old))

    def test_business_finance_read_does_not_reveal_new_invoice_and_bank_metadata(self):
        policy = Mock(allowed=Mock(return_value=False))
        record = {"nativeSettlementProjection": True, "paidAmountUSD": 25,
                  "salesInvoiceNames": ["SI-1"], "salesInvoiceSettledAmountUSD": 25,
                  "salesInvoiceOutstandingAmountUSD": 75, "factoryInvoiceNames": ["PI-1"],
                  "factoryInvoiceSettledAmount": 10, "factoryInvoiceOutstandingAmount": 40,
                  "nativeReceiptSummary": [{"name": "PE-1", "bankAmount": 25}],
                  "factories": [{"factoryId": "F", "invoiceNames": ["PI-1"], "invoiceSettledAmount": 10}]}
        with patch.object(self.finance_permissions, "Policy", return_value=policy):
            public = self.api._visible_order_projection({}, {}, Mock(), record)
        self.assertEqual(public["paidAmountUSD"], 25)
        for field in ("salesInvoiceNames", "salesInvoiceSettledAmountUSD", "salesInvoiceOutstandingAmountUSD",
                      "factoryInvoiceNames", "factoryInvoiceSettledAmount", "factoryInvoiceOutstandingAmount", "nativeReceiptSummary"):
            self.assertNotIn(field, public)
        self.assertEqual(public["factories"], [{"factoryId": "F"}])

    def test_company_and_financial_scope_apply_to_each_projected_voucher(self):
        policy = Mock(allowed=Mock(return_value=True), document_allowed=Mock(side_effect=lambda doc, action: doc["name"] != "PRIVATE"))
        record = {"salesInvoiceNames": ["PUBLIC", "PRIVATE"], "salesInvoiceSettledAmountUSD": 100,
                  "nativeReceiptSummary": [{"name": "PUBLIC", "bankAmount": 35}, {"name": "PRIVATE", "bankAmount": 80}]}
        with patch.object(self.finance_permissions, "Policy", return_value=policy), patch.object(self.api.repo, "get_doc", side_effect=lambda dt, name: {"doctype": dt, "name": name}):
            public = self.api._visible_order_projection({}, {}, Mock(), record)
        self.assertNotIn("salesInvoiceNames", public)
        self.assertNotIn("salesInvoiceSettledAmountUSD", public)
        self.assertEqual(public["nativeReceiptSummary"], [{"name": "PUBLIC", "bankAmount": 35}])

    def test_number_allocation_does_not_mutate_signed_request_and_persists_in_same_workspace(self):
        cfg = {"id": "example", "companies": [{"id": "C", "orderPrefix": "EX"}]}
        rules = Mock(profiles={"U": {"name": "User"}})
        rules._prepare_patch.side_effect = lambda db, cfg, actor, collection, old, value, **kwargs: {**value}
        rules.record_allowed.return_value = True
        payload = {key: [] for key in ("orders", "customers", "factories", "shipments", "invoices")}
        request = {"expectedVersion": 0, "changes": [{"collection": "orders", "id": "O", "value": {"companyId": "C", "salespersonId": "U", "companyOperationNo": "preview", "companyOperationNoAuto": True, "orderAmountUSD": 100}}]}
        original = copy.deepcopy(request)
        with patch.object(self.api.repo, "payload", return_value=payload), patch.object(self.api.repo, "rates", return_value=({}, {})), patch.object(self.api.repo, "find", return_value=None), patch.object(self.api.repo, "save_record") as save, patch.object(self.api.repo, "finish", return_value={"ok": True}), patch.object(self.api, "validate_order"):
            self.api._changes(Row(revision=0, name="W"), cfg, {"id": "U"}, rules, request)
        self.assertEqual(request, original)
        record = save.call_args.args[1]
        self.assertEqual(record["companyOperationNo"], "EX26U001")
        self.assertNotIn("companyOperationNoAuto", record)
        written = self.frappe.db.set_value.call_args
        self.assertEqual(written.args[:3], ("Trade Workspace", "W", "configuration"))
        self.assertEqual(json.loads(written.args[3])["operationCounters"]["C:EX26U"], 1)

    def test_failed_validation_cannot_persist_an_allocated_counter(self):
        cfg = {"id": "example", "companies": [{"id": "C"}]}
        rules = Mock(profiles={})
        rules._prepare_patch.side_effect = lambda db, cfg, actor, collection, old, value, **kwargs: {**value}
        rules.record_allowed.return_value = True
        payload = {key: [] for key in ("orders", "customers", "factories", "shipments", "invoices")}
        request = {"expectedVersion": 0, "changes": [{"collection": "orders", "id": "O", "value": {"companyId": "C", "orderAmountUSD": 100}}]}
        with patch.object(self.api.repo, "payload", return_value=payload), patch.object(self.api.repo, "rates", return_value=({}, {})), patch.object(self.api.repo, "find", return_value=None), patch.object(self.api.repo, "save_record") as save, patch.object(self.api, "validate_order", side_effect=ValueError("invalid order")), self.assertRaises(APIError):
            self.api._changes(Row(revision=0, name="W"), cfg, {"id": "U"}, rules, request)
        save.assert_not_called()
        self.frappe.db.set_value.assert_not_called()

    def test_retired_owners_keep_display_names_without_becoming_assignable_accounts(self):
        actor = {"id": "U", "nativeUser": "active@example.test", "role": "manager", "teamId": "T"}
        cfg = {"id": "grandware", "roles": {}, "teams": {"T": {}, "OTHER": {}}, "companies": [{"id": "C"}]}
        rules = Mock(ownership_profiles={
            "OLD": {"id": "OLD", "name": "历史业务员", "teamId": "T", "username": "demo-old", "email": "retired@example.test", "enabled": False},
            "PRIVATE": {"id": "PRIVATE", "name": "其他团队", "teamId": "OTHER", "enabled": False},
        })
        rules.company_ids.return_value = {"C"}
        rules._policy.return_value = {"scope": "team", "permissions": [], "pages": []}
        rules.permitted.return_value = False
        login_setup = importlib.import_module("tradept_core.login_setup")
        with patch.object(login_setup, "is_bootstrap", return_value=False), patch.object(self.api.administrator, "onboarding_state", return_value={}):
            session = self.api._session(cfg, actor, rules, {"U": actor})
        self.assertEqual(session["historicalOwners"], {"OLD": {"teamId": "T", "name": "历史业务员"}})
        self.assertEqual([user["id"] for user in session["users"]], ["U"])
        self.assertNotIn("username", session["historicalOwners"]["OLD"])
        self.assertNotIn("email", session["historicalOwners"]["OLD"])


if __name__ == "__main__":
    unittest.main()
