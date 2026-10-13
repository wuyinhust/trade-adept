"""Financial boundary tests; real native ledger acceptance runs separately."""
import copy
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.domain import APIError, DEFAULT_ROLES, FINANCE_CAPABILITIES, Rules


class Doc(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key) from None

    def __setattr__(self, key, value):
        self[key] = value

    def is_new(self):
        return self.get("_new", False)

    def get_all_children(self):
        return [row for value in self.values() if isinstance(value, list) for row in value if isinstance(row, dict)]


class FinancePermissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stub = SimpleNamespace(db=Mock(), session=SimpleNamespace(user="owner@example.invalid"), local=SimpleNamespace(), flags=SimpleNamespace())
        with patch.dict(sys.modules, {"frappe": sys.modules.get("frappe", stub)}):
            cls.module = importlib.import_module("tradept_core.finance_permissions")
            cls.permissions = importlib.import_module("tradept_core.permissions")
            cls.events = importlib.import_module("tradept_core.events")
            cls.attribution = importlib.import_module("tradept_core.attribution")
            cls.administrator = importlib.import_module("tradept_core.administrator")

    def setUp(self):
        self.frappe = SimpleNamespace(db=Mock(), get_all=Mock(), get_doc=Mock(), session=SimpleNamespace(user="owner@example.invalid", sid="unchanged-sid", data={"csrf_token": "unchanged-csrf"}), local=SimpleNamespace(form_dict={"cmd": "tradept_core.api.dispatch"}), flags=SimpleNamespace(tradept_managed_write=True))
        self.patches = [patch.object(module, "frappe", self.frappe) for module in (self.module, self.permissions, self.events, self.attribution, self.administrator)]
        self.patches.append(patch.dict(sys.modules, {"frappe": self.frappe, "tradept_core.finance_permissions": self.module, "tradept_core.permissions": self.permissions, "tradept_core.events": self.events, "tradept_core.attribution": self.attribution}))
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.cfg = {"id": "tenant", "companies": [{"id": "A"}, {"id": "B"}], "roles": copy.deepcopy(DEFAULT_ROLES), "teams": {}}
        self.actor = {"id": "U", "role": "finance", "tenantId": "tenant", "nativeUser": "owner@example.invalid", "visibleCompanyIds": ["A", "B"], "teamId": "T"}
        self.profiles = {"U": self.actor, "Team": {"id": "Team", "nativeUser": "team@example.invalid", "teamId": "T"}, "Other": {"id": "Other", "nativeUser": "other@example.invalid", "teamId": "Else"}}
        self.rules = Rules(self.cfg, self.profiles)
        self.company_grants = ["Company A", "Company B"]
        self.docs = {
            ("Customer", "Customer A"): Doc(name="Customer A", custom_tradept_company="Company A", custom_tradept_record_id="CA"),
            ("Customer", "Customer B"): Doc(name="Customer B", custom_tradept_company="Company B", custom_tradept_record_id="CB"),
            ("Account", "Receivable A"): Doc(company="Company A", account_currency="USD"),
            ("Account", "Bank A"): Doc(company="Company A", account_currency="USD"),
            ("Account", "Bank A CNY"): Doc(company="Company A", account_currency="CNY"),
            ("Account", "Bank B"): Doc(company="Company B", account_currency="USD"),
            ("Bank Account", "Allowed A"): Doc(company="Company A", account="Bank A", is_company_account=1),
            ("Bank Account", "Allowed A CNY"): Doc(company="Company A", account="Bank A CNY", is_company_account=1),
            ("Bank Account", "Disallowed A"): Doc(company="Company A", account="Private A", is_company_account=1),
            ("Bank Account", "Other B"): Doc(company="Company B", account="Bank B", is_company_account=1),
            ("Bank Account", "Party A"): Doc(company=None, is_company_account=0, party_type="Customer", party="Customer A"),
        }
        self.frappe.db.exists.side_effect = lambda kind, name: kind == "Trade User Profile" or (kind, name) in self.docs if isinstance(name, str) else kind == "Trade User Profile"
        self.frappe.db.get_value.side_effect = self._value
        self.frappe.get_all.side_effect = lambda kind, **kwargs: [SimpleNamespace(for_value=company) for company in self.company_grants] if kind == "User Permission" else []
        for item in (patch.object(self.module.repo, "native_company", side_effect=lambda value: {"A": "Company A", "B": "Company B"}.get(value)), patch.object(self.module.repo, "get_doc", side_effect=lambda kind, name: self.docs[(kind, name)])):
            item.start()
            self.addCleanup(item.stop)
        self.payload = {"orders": [], "customers": [{"id": "CA", "companyId": "A", "createdBy": "U"}], "factories": []}
        self.policy = self.module.Policy(self.cfg, self.actor, self.rules, self.payload)

    def _value(self, kind, name, field, **kwargs):
        row = self.docs.get((kind, name), {}) if isinstance(name, str) else {}
        if isinstance(field, (list, tuple)):
            return {key: row.get(key) for key in field}
        return row.get(field)

    def invoice(self, **values):
        return Doc(doctype="Sales Invoice", name="INV-A", company="Company A", owner="owner@example.invalid", customer="Customer A", debit_to="Receivable A", items=[], **values)

    def payment(self, amount=100, account="Bank A", **values):
        return Doc(doctype="Payment Entry", name="PE-A", company="Company A", owner="owner@example.invalid", payment_type="Receive", paid_to=account, paid_from="Receivable A", paid_amount=amount, received_amount=amount, party_type="Customer", party="Customer A", references=[], **values)

    def limit_role(self, scope="self", caps=None, **constraints):
        self.cfg["roles"]["finance"] = {"scope": scope, "permissions": caps or ["read", "edit", "finance.sales_invoice.read", "finance.payment_entry.read"], "financePolicy": {"scope": scope, **constraints}}

    def denied(self, code, call):
        with self.assertRaises(APIError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)

    def test_old_finance_write_does_not_grant_native_actions_and_revocation_is_immediate(self):
        self.cfg["roles"]["finance"]["permissions"] = ["finance.write"]
        self.assertFalse(self.policy.allowed("sales_invoice", "submit"))
        self.cfg["roles"]["finance"]["permissions"].append("finance.sales_invoice.submit")
        self.assertTrue(self.policy.allowed("sales_invoice", "submit"))
        self.cfg["roles"]["finance"]["permissions"].remove("finance.sales_invoice.submit")
        self.denied("FINANCE_PERMISSION_DENIED", lambda: self.policy.require("sales_invoice", "submit"))

    def test_native_company_permission_removal_and_cross_tenant_fail_closed(self):
        self.company_grants = ["Company A"]
        self.assertEqual(self.policy.companies(), {"A": "Company A"})
        self.denied("FINANCE_COMPANY_DENIED", lambda: self.policy.require("sales_invoice", company_id="B"))
        self.company_grants = []
        self.denied("FINANCE_COMPANY_DENIED", lambda: self.policy.require_document(self.invoice()))
        self.actor["tenantId"] = "elsewhere"
        self.assertFalse(self.policy.allowed("sales_invoice"))

    def test_deleted_profile_with_residual_native_tradept_role_stays_restricted(self):
        user = "role-only@example.invalid"
        with patch.object(self.frappe.db, "exists", return_value=False), \
                patch.object(self.frappe, "get_roles", return_value=["Tradept Finance", "Accounts Manager"], create=True) as roles:
            self.assertTrue(self.permissions.is_workbench_user(user))
            self.assertFalse(self.permissions.native_permission(user=user))
            self.assertEqual(self.permissions.native_query(user=user), "1=0")
            roles.assert_called_with(user)

    def test_native_operator_without_tradept_roles_keeps_native_permissions(self):
        user = "native-operator@example.invalid"
        with patch.object(self.frappe.db, "exists", return_value=False), \
                patch.object(self.frappe.db, "get_value", return_value="System User"), \
                patch.object(self.frappe, "get_roles", return_value=["Accounts Manager", "System Manager"], create=True):
            self.assertFalse(self.permissions.is_workbench_user(user))
            self.assertIsNone(self.permissions.native_permission(user=user))
            self.assertEqual(self.permissions.native_query(user=user), "")
            self.assertFalse(self.permissions.native_permission(user="Guest"))
            self.assertIsNone(self.permissions.native_permission(user="Administrator"))

    def test_permission_classifier_uses_resolved_token_owner_not_untrusted_form_claims(self):
        self.frappe.session.user = "Guest"
        self.frappe.local.form_dict = {"user": "Administrator", "roles": ["System Manager"]}
        with patch.object(self.frappe.db, "exists", return_value=False), \
                patch.object(self.frappe.db, "get_value", return_value="System User"), \
                patch.object(self.frappe, "get_roles", side_effect=lambda user: ["Tradept Finance"] if user == "trade-token-owner@example.invalid" else ["Accounts Manager"], create=True) as roles:
            self.assertFalse(self.permissions.native_permission(user="trade-token-owner@example.invalid"))
            roles.assert_called_with("trade-token-owner@example.invalid")
            self.assertIsNone(self.permissions.native_permission(user="native-token-owner@example.invalid"))
            roles.assert_called_with("native-token-owner@example.invalid")
            self.assertFalse(self.permissions.native_permission())

    def test_self_and_team_use_native_creator_not_last_modifier(self):
        self.limit_role()
        other = self.invoice()
        other.owner, other.modified_by = "other@example.invalid", "owner@example.invalid"
        self.assertFalse(self.policy.document_allowed(other))
        self.assertTrue(self.policy.document_allowed(self.invoice()))
        self.limit_role("team")
        other.owner = "team@example.invalid"
        self.assertTrue(self.policy.document_allowed(other))
        other.owner = "unknown@example.invalid"
        self.assertFalse(self.policy.document_allowed(other))

    def test_disabled_native_creator_remains_in_team_financial_scope_without_new_grants(self):
        self.limit_role("team")
        historical = {"Former": {"id": "Former", "nativeUser": "former@example.invalid", "teamId": "T", "enabled": False}, "OtherFormer": {"id": "OtherFormer", "nativeUser": "former-other@example.invalid", "teamId": "Else", "enabled": False}}
        self.rules = Rules(self.cfg, self.profiles, ownership_profiles=historical)
        policy = self.module.Policy(self.cfg, self.actor, self.rules, self.payload)
        invoice = self.invoice()
        invoice.owner = "former@example.invalid"
        self.assertTrue(policy.document_allowed(invoice))
        invoice.owner = "former-other@example.invalid"
        self.assertFalse(policy.document_allowed(invoice))
        invoice.owner = "former@example.invalid"
        self.actor["visibleCompanyIds"] = ["B"]
        self.assertFalse(policy.document_allowed(invoice))
        self.actor["visibleCompanyIds"] = ["A"]
        self.cfg["roles"]["finance"]["permissions"].remove("finance.sales_invoice.read")
        self.assertFalse(policy.document_allowed(invoice))
        self.assertNotIn("Former", self.rules.profiles)

    def test_disabled_original_order_owner_obeys_narrow_financial_team_scope(self):
        self.limit_role("team")
        self.cfg["roles"]["finance"]["scope"] = "tenant"
        historical = {"Former": {"id": "Former", "nativeUser": "former@example.invalid", "teamId": "T", "enabled": False}, "OtherFormer": {"id": "OtherFormer", "nativeUser": "former-other@example.invalid", "teamId": "Else", "enabled": False}}
        self.rules = Rules(self.cfg, self.profiles, ownership_profiles=historical)
        self.payload["orders"] = [{"id": "HISTORY", "companyId": "A", "createdBy": "Former"}]
        self.docs[("Sales Order", "SO-HISTORY")] = Doc(doctype="Sales Order", name="SO-HISTORY", company="Company A", custom_tradept_order_id="HISTORY")
        invoice = self.invoice()
        invoice.items = [Doc(sales_order="SO-HISTORY")]
        policy = self.module.Policy(self.cfg, self.actor, self.rules, self.payload)
        self.assertTrue(policy.document_allowed(invoice))
        self.payload["orders"][0]["createdBy"] = "OtherFormer"
        self.assertFalse(policy.document_allowed(invoice))
        self.payload["orders"][0].update(createdBy="Former", companyId="B")
        self.assertFalse(policy.document_allowed(invoice))

    def test_related_invoice_follows_all_original_order_grants_even_when_owned(self):
        self.limit_role()
        self.payload["orders"] = [{"id": "O1", "companyId": "A", "createdBy": "U"}, {"id": "O2", "companyId": "A", "createdBy": "Other"}]
        self.docs[("Sales Order", "SO-1")] = Doc(doctype="Sales Order", name="SO-1", company="Company A", custom_tradept_order_id="O1")
        self.docs[("Sales Order", "SO-2")] = Doc(doctype="Sales Order", name="SO-2", company="Company A", custom_tradept_order_id="O2")
        invoice = self.invoice()
        invoice.items = [Doc(sales_order="SO-1")]
        self.assertTrue(self.policy.document_allowed(invoice))
        invoice["items"].append(Doc(sales_order="SO-2"))
        self.assertFalse(self.policy.document_allowed(invoice))

    def test_narrow_financial_scope_does_not_borrow_tenant_wide_operational_scope(self):
        self.cfg["roles"]["finance"]["financePolicy"]["scope"] = "self"
        self.payload["orders"] = [{"id": "O", "companyId": "A", "createdBy": "Other"}]
        self.docs[("Sales Order", "SO")] = Doc(doctype="Sales Order", name="SO", company="Company A", custom_tradept_order_id="O")
        invoice = self.invoice()
        invoice.items = [Doc(sales_order="SO")]
        self.assertFalse(self.policy.document_allowed(invoice))
        self.payload["orders"][0]["createdBy"] = "U"
        self.assertTrue(self.policy.document_allowed(invoice))

    def test_purchase_receipt_source_uses_standard_order_chain_without_assumed_custom_columns(self):
        self.cfg["roles"]["finance"]["financePolicy"]["scope"] = "self"
        self.payload["orders"] = [{"id": "O", "companyId": "A", "createdBy": "U"}]
        self.docs[("Purchase Order", "PO")] = Doc(doctype="Purchase Order", name="PO", company="Company A", owner="other@example.invalid", custom_tradept_order_id="O", items=[])
        self.docs[("Purchase Receipt", "PR")] = Doc(doctype="Purchase Receipt", name="PR", company="Company A", owner="other@example.invalid", items=[Doc(purchase_order="PO")])
        invoice = Doc(doctype="Purchase Invoice", name="PI", company="Company A", owner=self.actor["nativeUser"], items=[Doc(purchase_receipt="PR")])
        original = self.frappe.db.get_value.side_effect
        def no_assumed_column(kind, name, field, **kwargs):
            if kind == "Purchase Receipt" and field == "custom_tradept_order_id":
                self.fail("Purchase Receipt has no assumed Tradept custom column")
            return original(kind, name, field, **kwargs)
        self.frappe.db.get_value.side_effect = no_assumed_column
        self.assertTrue(self.policy.document_allowed(invoice))
        self.payload["orders"][0]["createdBy"] = "Other"
        self.assertFalse(self.policy.document_allowed(invoice))

    def test_standard_source_cycles_are_bounded_and_cross_company_hops_rejected(self):
        self.docs[("Sales Invoice", "A")] = self.invoice()
        self.docs[("Sales Invoice", "A")]["name"] = "A"
        self.docs[("Payment Entry", "PE")] = self.payment()
        self.docs[("Payment Entry", "PE")]["name"] = "PE"
        self.docs[("Sales Invoice", "A")]["advances"] = [Doc(reference_type="Payment Entry", reference_name="PE", allocated_amount=0)]
        self.docs[("Payment Entry", "PE")]["references"] = [Doc(reference_doctype="Sales Invoice", reference_name="A")]
        self.assertEqual(self.policy._order_ids(self.docs[("Sales Invoice", "A")]), set())
        self.docs[("Payment Entry", "PE")]["company"] = "Company B"
        self.denied("FINANCE_REFERENCE_COMPANY_DENIED", lambda: self.policy._order_ids(self.docs[("Sales Invoice", "A")]))

    def test_invoice_submit_grant_does_not_require_editing_its_source_order(self):
        self.cfg["roles"]["finance"]["permissions"] = ["read", "finance.sales_invoice.read", "finance.sales_invoice.write", "finance.sales_invoice.submit"]
        self.payload["orders"] = [{"id": "O", "companyId": "A", "createdBy": "U"}]
        self.docs[("Sales Order", "SO")] = Doc(doctype="Sales Order", name="SO", company="Company A", custom_tradept_order_id="O")
        invoice = self.invoice()
        invoice.items = [Doc(sales_order="SO")]
        self.policy.validate_document(invoice, "write")
        self.policy.validate_document(invoice, "submit")
        self.assertFalse(self.rules.permitted(self.cfg, self.actor, "edit", "orders"))

    def test_recursive_company_account_and_party_checks(self):
        invoice = self.invoice()
        invoice.items = [Doc(income_account="Bank B")]
        self.denied("FINANCE_ACCOUNT_COMPANY_DENIED", lambda: self.policy.validate_document(invoice, "write"))
        invoice.items = [Doc(company="Company B")]
        self.denied("FINANCE_CHILD_COMPANY_DENIED", lambda: self.policy.validate_document(invoice, "write"))
        invoice.items = []
        invoice.customer = "Customer B"
        self.denied("FINANCE_PARTY_COMPANY_DENIED", lambda: self.policy.validate_document(invoice, "write"))

    def test_shared_native_party_requires_correct_company_receivable_and_preserves_owner_scope(self):
        self.docs[("Account", "Receivable A")]["account_type"] = "Receivable"
        self.docs[("Customer", "Customer B")]["accounts"] = [Doc(company="Company A", account="Receivable A")]
        self.payload["customers"].append({"id": "CB", "companyId": "B", "createdBy": "U"})
        self.cfg["roles"]["finance"]["scope"] = "self"
        self.cfg["roles"]["finance"]["financePolicy"]["scope"] = "self"
        self.actor["visibleCompanyIds"] = ["A"]
        self.company_grants = ["Company A"]
        self.policy._party("Customer", "Customer B", "Company A")
        self.payload["customers"][-1]["createdBy"] = "Other"
        self.denied("FINANCE_PARTY_DENIED", lambda: self.policy._party("Customer", "Customer B", "Company A"))
        self.payload["customers"][-1]["createdBy"] = "U"
        self.docs[("Account", "Receivable A")]["account_type"] = "Payable"
        self.denied("FINANCE_PARTY_ACCOUNT_DENIED", lambda: self.policy._party("Customer", "Customer B", "Company A"))

    def test_return_amend_payment_references_cannot_point_at_another_company(self):
        self.docs[("Sales Invoice", "INV-B")] = Doc(doctype="Sales Invoice", name="INV-B", company="Company B", owner="owner@example.invalid")
        for field in ("return_against", "amended_from"):
            self.denied("FINANCE_REFERENCE_COMPANY_DENIED", lambda field=field: self.policy.validate_document(self.invoice(**{field: "INV-B"}), "write"))
        payment = self.payment()
        payment.references = [Doc(reference_doctype="Sales Invoice", reference_name="INV-B")]
        self.denied("FINANCE_REFERENCE_COMPANY_DENIED", lambda: self.policy.validate_document(payment, "submit"))

    def test_bank_details_are_hidden_without_independent_bank_grant(self):
        self.cfg["roles"]["finance"]["permissions"].remove("finance.bank_accounts.read")
        output = self.policy.redact({"amount": 100, "bank_account": "Secret", "bankAccountNo": "Secret", "IBAN": "Secret", "SWIFT": "Secret", "details": [{"iban": "Secret", "bankInfo": "Secret", "outstanding_amount": 80}]})
        self.assertEqual(output, {"amount": 100, "details": [{"outstanding_amount": 80}]})

    def test_invoice_native_advance_requires_its_real_reference_and_reconciliation_grant(self):
        invoice = self.invoice()
        invoice.advances = [Doc(reference_type="Payment Entry", reference_name="PE-A", allocated_amount=20)]
        self.docs[("Payment Entry", "PE-A")] = self.payment(20)
        self.policy.validate_document(invoice, "submit")
        self.cfg["roles"]["finance"]["permissions"].remove("finance.reconciliation.write")
        self.denied("FINANCE_PERMISSION_DENIED", lambda: self.policy.validate_document(invoice, "submit"))
        # Read a legitimate native advance without implicitly allowing allocation.
        self.policy.validate_document(invoice, "read")
        self.docs[("Payment Entry", "PE-A")].company = "Company B"
        self.denied("FINANCE_REFERENCE_COMPANY_DENIED", lambda: self.policy.validate_document(invoice, "read"))

    def test_advance_allocation_does_not_bypass_native_payment_limits(self):
        invoice = self.invoice()
        invoice.advances = [Doc(reference_type="Payment Entry", reference_name="PE-A", allocated_amount=20)]
        self.docs[("Payment Entry", "PE-A")] = self.payment(20)
        self.cfg["roles"]["finance"]["financePolicy"]["paymentLimit"] = {"amount": 10, "currency": "USD"}
        self.denied("FINANCE_PAYMENT_LIMIT_EXCEEDED", lambda: self.policy.validate_document(invoice, "submit"))

    def test_bank_names_inside_gl_fields_do_not_bypass_bank_visibility(self):
        self.cfg["roles"]["finance"]["permissions"].remove("finance.bank_accounts.read")
        self.docs[("Account", "Bank A")]["account_type"] = "Bank"
        self.assertEqual(self.policy.redact({"paidTo": "Bank A", "paidFrom": "Receivable A", "account": "Bank A", "against": "Bank A,Receivable A", "amount": 10}), {"paidFrom": "Receivable A", "amount": 10})

    def test_bank_allowlist_cannot_be_bypassed_using_direct_gl_account(self):
        self.cfg["roles"]["finance"]["financePolicy"]["allowedBankAccounts"] = ["Allowed A"]
        self.policy.validate_document(self.payment(), "submit")
        payment = self.payment(account="Bank A CNY")
        self.denied("FINANCE_BANK_ACCOUNT_DENIED", lambda: self.policy.validate_document(payment, "submit"))
        self.assertTrue(self.policy.document_allowed(payment))
        self.cfg["roles"]["finance"]["financePolicy"]["allowedBankAccounts"] = []
        self.denied("FINANCE_BANK_ACCOUNT_DENIED", lambda: self.policy.validate_document(self.payment(), "submit"))

    def test_payment_cap_uses_native_money_currency_not_client_exchange_rate(self):
        self.cfg["roles"]["finance"]["financePolicy"]["paymentLimit"] = {"amount": 100, "currency": "USD"}
        self.policy.validate_document(self.payment(100), "submit")
        self.denied("FINANCE_PAYMENT_LIMIT_EXCEEDED", lambda: self.policy.validate_document(self.payment(100.01), "submit"))
        self.denied("FINANCE_PAYMENT_LIMIT_CURRENCY", lambda: self.policy.validate_document(self.payment(1, account="Bank A CNY", target_exchange_rate=.001), "submit"))
        self.denied("INVALID_FINANCE_PAYMENT_AMOUNT", lambda: self.policy.validate_document(self.payment(float("nan")), "submit"))

    def test_deductions_need_exact_grant_and_gross_allocation_cannot_bypass_payment_cap(self):
        payment = self.payment(1, deductions=[Doc(amount=999)], total_allocated_amount=1000)
        self.cfg["roles"]["finance"]["permissions"].remove("finance.payment_entry.deductions")
        self.denied("FINANCE_PERMISSION_DENIED", lambda: self.policy.validate_document(payment, "submit"))
        self.cfg["roles"]["finance"]["permissions"].append("finance.payment_entry.deductions")
        self.cfg["roles"]["finance"]["financePolicy"]["paymentLimit"] = {"amount": 10, "currency": "USD"}
        self.denied("FINANCE_PAYMENT_LIMIT_EXCEEDED", lambda: self.policy.validate_document(payment, "submit"))
        payment.total_allocated_amount = 10
        self.policy.validate_document(payment, "submit")

    def test_payment_limit_allows_refund_sign_but_caps_native_gross_magnitude(self):
        self.cfg["roles"]["finance"]["financePolicy"]["paymentLimit"] = {"amount": 10, "currency": "USD"}
        refund = self.payment(5)
        refund.payment_type, refund.paid_from, refund.paid_to = "Pay", "Bank A", "Receivable A"
        refund.total_allocated_amount = -5
        self.policy.require_payment(refund)
        refund.total_allocated_amount = -15
        self.denied("FINANCE_PAYMENT_LIMIT_EXCEEDED", lambda: self.policy.require_payment(refund))

    def test_internal_transfer_caps_both_native_money_sides(self):
        self.cfg["roles"]["finance"]["financePolicy"]["paymentLimit"] = {"amount": 100, "currency": "USD"}
        transfer = self.payment(100)
        transfer.payment_type = "Internal Transfer"
        transfer.paid_from = "Bank A"
        transfer.received_amount = 101
        self.denied("FINANCE_PAYMENT_LIMIT_EXCEEDED", lambda: self.policy.validate_document(transfer, "submit"))
        transfer.received_amount = 1
        transfer.paid_to = "Bank A CNY"
        self.denied("FINANCE_PAYMENT_LIMIT_CURRENCY", lambda: self.policy.validate_document(transfer, "submit"))

    def test_report_and_reconciliation_cannot_escape_self_or_team_scope(self):
        self.limit_role("team", ["finance.receivables.read", "finance.reconciliation.write"])
        self.denied("FINANCE_TENANT_SCOPE_REQUIRED", lambda: self.policy.require("receivables", tenant_scope=True))
        self.denied("FINANCE_TENANT_SCOPE_REQUIRED", lambda: self.policy.require("reconciliation", "write", tenant_scope=True))

    def test_bank_transactions_require_tenant_bank_visibility_and_exact_cancel_cap(self):
        transaction = Doc(doctype="Bank Transaction", name="BT", owner=self.actor["nativeUser"], company="Company A", bank_account="Allowed A", payment_entries=[])
        self.assertTrue(self.policy.document_allowed(transaction))
        self.cfg["roles"]["finance"]["permissions"].remove("finance.bank_transaction.cancel")
        self.denied("FINANCE_PERMISSION_DENIED", lambda: self.policy.validate_document(transaction, "cancel"))
        self.cfg["roles"]["finance"]["permissions"].remove("finance.bank_accounts.read")
        self.denied("FINANCE_BANK_SCOPE_REQUIRED", lambda: self.policy.validate_document(transaction, "read"))

    def test_bank_transaction_payment_child_and_party_bank_are_company_bound(self):
        self.docs[("Payment Entry", "PE-B")] = Doc(doctype="Payment Entry", name="PE-B", company="Company B", owner=self.actor["nativeUser"])
        transaction = Doc(doctype="Bank Transaction", name="BT", company="Company A", owner=self.actor["nativeUser"], bank_account="Allowed A", payment_entries=[Doc(payment_document="Payment Entry", payment_entry="PE-B")])
        self.denied("FINANCE_REFERENCE_COMPANY_DENIED", lambda: self.policy.validate_document(transaction, "write"))
        self.docs[("Bank Account", "Party A")]["party"] = "Customer B"
        self.denied("FINANCE_PARTY_BANK_DENIED", lambda: self.policy.validate_document(self.payment(party_bank_account="Party A"), "submit"))

    def test_controller_flags_and_other_document_children_are_rejected(self):
        self.denied("UNSAFE_FINANCE_FLAGS", lambda: self.policy.validate_document(self.invoice(flags={"ignore_permissions": True}), "write"))
        invoice = self.invoice()
        invoice.items = [Doc(doctype="Sales Invoice Item", name="other-child")]
        self.docs[("Sales Invoice Item", "other-child")] = Doc(parent="OTHER-INVOICE", parenttype="Sales Invoice")
        self.denied("FINANCE_CHILD_PARENT_DENIED", lambda: self.policy.validate_document(invoice, "write"))

    def test_cost_center_warehouse_and_source_child_match_the_target_company(self):
        invoice = self.invoice()
        self.docs[("Cost Center", "CC-B")] = Doc(company="Company B")
        invoice.items = [Doc(cost_center="CC-B")]
        self.denied("FINANCE_DIMENSION_COMPANY_DENIED", lambda: self.policy.validate_document(invoice, "write"))
        self.docs[("Sales Order Item", "SO-CHILD-B")] = Doc(parent="SO-B")
        self.docs[("Sales Order", "SO-B")] = Doc(doctype="Sales Order", name="SO-B", company="Company B", owner=self.actor["nativeUser"])
        invoice.items = [Doc(so_detail="SO-CHILD-B")]
        self.denied("FINANCE_REFERENCE_COMPANY_DENIED", lambda: self.policy.validate_document(invoice, "write"))

    def test_delegation_preserves_request_and_restores_permissions_on_failure(self):
        caches = {"cache": {"actor": "old"}, "role_permissions": {"Sales Invoice": False}, "new_doc_templates": {}, "user_perms": {"Company": ["Company A"]}}
        for name, value in caches.items():
            setattr(self.frappe.local, name, value)
        sid, data, form = self.frappe.session.sid, self.frappe.session.data, self.frappe.local.form_dict
        with patch.object(self.attribution, "capture", return_value={}), patch.object(self.attribution, "finish") as finish:
            with self.assertRaises(ValueError):
                with self.permissions.delegated_finance_operation("sales_invoice", "create", self.policy, document=self.invoice(_new=True)):
                    self.assertEqual(self.frappe.session.user, "Administrator")
                    self.assertEqual(self.permissions.delegated_actor(), "owner@example.invalid")
                    child = Doc(_new=True)
                    created = self.invoice(_new=True)
                    created.items = [child]
                    self.events.before_native_write(created)
                    self.assertEqual(created.owner, "owner@example.invalid")
                    self.assertEqual(child.owner, "owner@example.invalid")
                    raise ValueError("native validation")
            finish.assert_not_called()
        self.assertEqual(self.frappe.session.user, "owner@example.invalid")
        self.assertEqual(self.frappe.session.sid, sid)
        self.assertIs(self.frappe.session.data, data)
        self.assertIs(self.frappe.local.form_dict, form)
        self.assertIsNone(self.permissions.delegated_actor())
        for name, value in caches.items():
            self.assertIs(getattr(self.frappe.local, name), value)
        self.assertFalse(self.permissions.native_permission(user="owner@example.invalid"))
        self.assertEqual(self.permissions.native_query(user="owner@example.invalid"), "1=0")

    def test_successful_delegation_attributes_only_exact_bound_native_rows(self):
        invoice = self.invoice(_new=True)
        captured = []
        def capture(references):
            captured.append(copy.deepcopy(references))
            return {}
        with patch.object(self.attribution, "capture", side_effect=capture), patch.object(self.attribution, "finish") as finish:
            with self.permissions.delegated_finance_operation("sales_invoice", "create", self.policy, document=invoice) as references:
                self.events.before_native_write(invoice)
                self.events.after_native_write(invoice)
                self.assertEqual(references, [{"doctype": "Sales Invoice", "name": "INV-A"}])
            self.assertEqual(captured, [[]])
            self.assertEqual(finish.call_args.args, ({}, [{"doctype": "Sales Invoice", "name": "INV-A"}], None, "owner@example.invalid"))

    def test_dynamic_source_binding_preserves_historical_creator_before_allocation(self):
        source = self.payment()
        source.update(modified="old", modified_by="archive-actor", owner="historical-finance-owner")
        self.docs[("Payment Entry", "PE-A")] = source
        invoice = self.invoice(_new=True)
        invoice.update(modified="new", modified_by=self.actor["nativeUser"])
        self.frappe.get_doc.side_effect = lambda kind, name, **kwargs: source if kind == "Payment Entry" else invoice
        self.frappe.db.sql.return_value = []
        with self.permissions.delegated_finance_operation("sales_invoice", "create", self.policy, document=invoice) as bound:
            self.assertIs(self.permissions.bind_finance_reference("Payment Entry", "PE-A"), source)
            before = self.permissions.delegated_finance_grant()["before"]
            self.assertEqual(before[("Payment Entry", "PE-A")]["owner"], "historical-finance-owner")
            source.modified, source.modified_by = "new", "Administrator"
            # Repeated binding must retain the first image, never overwrite it
            # with metadata already changed by the native allocation helper.
            self.permissions.bind_finance_reference("Payment Entry", "PE-A")
            self.assertEqual(before[("Payment Entry", "PE-A")]["modified"], "old")
            bound.append({"doctype": "Sales Invoice", "name": "INV-A"})
        updated = {(call.args[0], call.args[1]): call.args[2] for call in self.frappe.db.set_value.call_args_list}
        self.assertEqual(updated[("Payment Entry", "PE-A")], {"modified_by": self.actor["nativeUser"]})
        self.denied("FINANCE_BIND_DENIED", lambda: self.permissions.bind_finance_reference("Payment Entry", "PE-A"))

    def test_generated_exchange_journal_is_bound_to_posting_company_and_attributed(self):
        payment = self.payment()
        self.docs[("Payment Entry", payment.name)] = payment
        self.docs[("Account", "FX Loss A")] = Doc(company="Company A", account_currency="USD", account_type="Expense")
        journal = Doc(doctype="Journal Entry", name="FX-JE", company="Company A", _new=True, voucher_type="Exchange Gain Or Loss", is_system_generated=1, accounts=[Doc(doctype="Journal Entry Account", name="JE-LINE", _new=True, account="FX Loss A", reference_type="Payment Entry", reference_name=payment.name)])
        with patch.object(self.attribution, "capture", return_value={}), patch.object(self.attribution, "finish") as finish:
            with self.permissions.delegated_finance_operation("payment_entry", "submit", self.policy, document=payment) as bound:
                self.events.before_native_write(journal)
                self.events.after_native_write(journal)
                self.assertIn({"doctype": "Journal Entry", "name": "FX-JE"}, bound)
                self.assertEqual(journal.owner, self.actor["nativeUser"])
                self.assertEqual(journal["accounts"][0].owner, self.actor["nativeUser"])
                unsafe = copy.deepcopy(journal)
                unsafe.is_system_generated = 0
                self.denied("FINANCE_UNBOUND_JOURNAL", lambda: self.events.before_native_write(unsafe))
                unsafe.is_system_generated = 1
                unsafe.company = "Company B"
                self.denied("FINANCE_UNBOUND_JOURNAL", lambda: self.events.before_native_write(unsafe))
            self.assertIn({"doctype": "Journal Entry", "name": "FX-JE"}, finish.call_args.args[1])
        with self.permissions.delegated_finance_read("ledger", self.policy, "Company A"):
            self.denied("FINANCE_READ_ONLY_DELEGATION", lambda: self.events.before_native_write(journal))
            self.denied("FINANCE_BIND_DENIED", lambda: self.permissions.bind_finance_reference("Payment Entry", "PE-A"))

    def _unreconcile_fixture(self):
        invoice = self.invoice()
        invoice.docstatus = 1
        payment = self.payment()
        payment.docstatus = 1
        payment.references = [Doc(reference_doctype="Sales Invoice", reference_name="INV-A", allocated_amount=20)]
        self.docs[("Sales Invoice", invoice.name)] = invoice
        self.docs[("Payment Entry", payment.name)] = payment
        native = Doc(doctype="Unreconcile Payment", name="UR-A", _new=True, company="Company A", voucher_type="Payment Entry", voucher_no=payment.name, allocations=[Doc(doctype="Unreconcile Payment Entries", name="UR-CHILD", _new=True, account="Receivable A", party_type="Customer", party="Customer A", reference_doctype="Sales Invoice", reference_name=invoice.name, allocated_amount=20, account_currency="USD")])
        refs = [{"doctype": "Payment Entry", "name": payment.name}, {"doctype": "Sales Invoice", "name": invoice.name}]
        return native, refs

    def test_unreconcile_has_independent_permission_not_implied_by_reconcile_write(self):
        native, references = self._unreconcile_fixture()
        self.cfg["roles"]["finance"]["permissions"].remove("finance.reconciliation.unreconcile")
        self.assertTrue(self.policy.allowed("reconciliation", "write"))
        self.denied("FINANCE_PERMISSION_DENIED", lambda: self.policy.validate_unreconcile(native, "Company A", references))
        self.denied("FINANCE_PERMISSION_DENIED", lambda: self._unreconcile_context(native, references))

    def _unreconcile_context(self, native, references):
        with self.permissions.delegated_finance_operation("reconciliation", "unreconcile", self.policy, references=references, company="Company A"):
            self.events.before_native_write(native)

    def test_unreconcile_validates_bound_native_payment_invoices_party_and_company(self):
        native, refs = self._unreconcile_fixture()
        self.policy.validate_unreconcile(native, "Company A", refs)
        self.denied("FINANCE_UNRECONCILE_DENIED", lambda: self.policy.validate_unreconcile(native, "Company A", refs[:1]))
        row = native["allocations"][0]
        row.party = "Customer B"
        self.denied("FINANCE_UNRECONCILE_DENIED", lambda: self.policy.validate_unreconcile(native, "Company A", refs))
        row.party = "Customer A"
        row.account = "Bank B"
        self.denied("FINANCE_ACCOUNT_COMPANY_DENIED", lambda: self.policy.validate_unreconcile(native, "Company A", refs))
        row.account = "Receivable A"
        self.docs[("Payment Entry", "PE-A")].docstatus = 2
        self.denied("FINANCE_SUBMITTED_SOURCE_REQUIRED", lambda: self.policy.validate_unreconcile(native, "Company A", refs))

    def test_private_unreconcile_receipt_retains_actor_without_exposing_native_rest(self):
        native, refs = self._unreconcile_fixture()
        with patch.object(self.attribution, "capture", return_value={}), patch.object(self.attribution, "finish") as finish:
            with self.permissions.delegated_finance_operation("reconciliation", "unreconcile", self.policy, references=refs, company="Company A") as bound:
                self.events.before_native_write(native)
                self.events.after_native_write(native)
                self.assertEqual(native.owner, self.actor["nativeUser"])
                self.assertEqual(native["allocations"][0].owner, self.actor["nativeUser"])
                self.assertIn({"doctype": "Unreconcile Payment", "name": native.name}, bound)
            self.assertIn({"doctype": "Unreconcile Payment", "name": native.name}, finish.call_args.args[1])
        self.docs[("Unreconcile Payment", native.name)] = native
        self.assertIs(self.policy.require_reference("Unreconcile Payment", native.name, "Company A"), native)
        self.assertFalse(self.permissions.native_permission(doc=native, user=self.actor["nativeUser"]))
        self.assertNotIn("Unreconcile Payment", self.module.DOCUMENT_RESOURCES)
        with self.permissions.delegated_finance_read("reconciliation", self.policy, "Company A"):
            self.denied("FINANCE_UNRECONCILE_DENIED", lambda: self.events.before_native_write(native))

    def test_native_credit_and_debit_memo_journals_are_bounded_to_balanced_same_party_invoices(self):
        for sales in (True, False):
            invoice_type, account_type, party_type = ("Sales Invoice", "Receivable", "Customer") if sales else ("Purchase Invoice", "Payable", "Supplier")
            party_field = "customer" if sales else "supplier"
            party = "Customer A" if sales else "Supplier A"
            account = "Receivable A" if sales else "Payable A"
            self.docs[("Account", account)] = Doc(company="Company A", account_currency="USD", account_type=account_type)
            self.docs[("Supplier", "Supplier A")] = Doc(name="Supplier A", custom_tradept_company="Company A")
            memo = Doc(doctype=invoice_type, name="MEMO", company="Company A", owner=self.actor["nativeUser"], docstatus=1, is_return=1, **{party_field: party})
            invoice = Doc(doctype=invoice_type, name="ORDINARY", company="Company A", owner=self.actor["nativeUser"], docstatus=1, is_return=0, **{party_field: party})
            self.docs[(invoice_type, memo.name)], self.docs[(invoice_type, invoice.name)] = memo, invoice
            refs = [{"doctype": invoice_type, "name": memo.name}, {"doctype": invoice_type, "name": invoice.name}]
            journal = Doc(doctype="Journal Entry", name="MEMO-JE", company="Company A", _new=True, voucher_type="Credit Note" if sales else "Debit Note", accounts=[Doc(doctype="Journal Entry Account", name="D", _new=True, account=account, party_type=party_type, party=party, reference_type=invoice_type, reference_name=memo.name, debit_in_account_currency=5), Doc(doctype="Journal Entry Account", name="C", _new=True, account=account, party_type=party_type, party=party, reference_type=invoice_type, reference_name=invoice.name, credit_in_account_currency=5)])
            with patch.object(self.attribution, "capture", return_value={}), patch.object(self.attribution, "finish") as finish:
                with self.permissions.delegated_finance_operation("reconciliation", "write", self.policy, references=refs, company="Company A") as bound:
                    self.events.before_native_write(journal)
                    self.events.after_native_write(journal)
                    self.assertEqual(journal.owner, self.actor["nativeUser"])
                    self.assertIn({"doctype": "Journal Entry", "name": journal.name}, bound)
                    self.events.before_native_write(journal)  # Native save then submit.
                    unbalanced = copy.deepcopy(journal)
                    unbalanced["accounts"][1]["credit_in_account_currency"] = 6
                    self.denied("FINANCE_UNBOUND_JOURNAL", lambda: self.events.before_native_write(unbalanced))
                    bank = copy.deepcopy(journal)
                    bank["accounts"][1]["account"] = "Bank A"
                    self.denied("FINANCE_UNBOUND_JOURNAL", lambda: self.events.before_native_write(bank))
                    unrelated = copy.deepcopy(journal)
                    unrelated["accounts"][1]["reference_name"] = "UNBOUND"
                    self.denied("FINANCE_UNBOUND_JOURNAL", lambda: self.events.before_native_write(unrelated))
                self.assertIn({"doctype": "Journal Entry", "name": journal.name}, finish.call_args.args[1])
            with patch.object(self.attribution, "capture", return_value={}), patch.object(self.attribution, "finish"):
                with self.permissions.delegated_finance_operation("reconciliation", "unreconcile", self.policy, references=refs, company="Company A"):
                    self.denied("FINANCE_UNBOUND_JOURNAL", lambda: self.events.before_native_write(journal))

    def test_financial_attribution_covers_new_children_and_all_three_native_ledgers(self):
        invoice = self.invoice()
        invoice.update(modified="old", modified_by="original", owner="historical-owner")
        old_child = Doc(doctype="Sales Invoice Item", name="OLD-CHILD", modified="old", modified_by="original", owner="historical-child-owner")
        invoice.items = [old_child]
        self.frappe.get_doc.side_effect = lambda dt, name, **kwargs: invoice
        phase = [False]
        def ledger_rows(sql, values, **kwargs):
            ledger = next(kind for kind in self.attribution.LEDGER_TYPES if "`tab" + kind + "`" in sql)
            self.assertEqual(values, ("Sales Invoice", "INV-A"))
            row = Doc(name=ledger + "-OLD", modified="new" if phase[0] else "old", modified_by="Administrator" if phase[0] else "original", owner="historical-ledger-owner")
            if phase[0]:
                return [row, Doc(name=ledger + "-NEW", modified="new", modified_by="Administrator", owner="Administrator")]
            return [row]
        self.frappe.db.sql.side_effect = ledger_rows
        references = [{"doctype": "Sales Invoice", "name": "INV-A"}]
        before = self.attribution.capture(references)
        phase[0] = True
        invoice.modified, invoice.modified_by = "new", "Administrator"
        old_child.modified, old_child.modified_by = "new", "Administrator"
        invoice["items"].append(Doc(doctype="Sales Invoice Item", name="NEW-CHILD", modified="new", modified_by="Administrator", owner="Administrator"))
        self.attribution.finish(before, references, None, self.actor["nativeUser"])
        written = {(call.args[0], call.args[1]): call.args[2] for call in self.frappe.db.set_value.call_args_list}
        self.assertEqual(written[("Sales Invoice", "INV-A")], {"modified_by": self.actor["nativeUser"]})
        self.assertEqual(written[("Sales Invoice Item", "OLD-CHILD")], {"modified_by": self.actor["nativeUser"]})
        for dt, name in [("Sales Invoice Item", "NEW-CHILD"), *[(kind, kind + "-NEW") for kind in self.attribution.LEDGER_TYPES]]:
            self.assertEqual(written[(dt, name)], {"modified_by": self.actor["nativeUser"], "owner": self.actor["nativeUser"]})
        for call in self.frappe.db.set_value.call_args_list:
            self.assertFalse(call.kwargs["update_modified"])
            self.assertTrue(set(call.args[2]).issubset({"owner", "modified_by"}))

    def test_delegate_refuses_client_identity_and_unbound_cross_company_writes(self):
        original = self.actor["nativeUser"]
        self.actor["nativeUser"] = "forged@example.invalid"
        self.denied("FINANCE_DELEGATION_DENIED", lambda: self._delegate())
        self.actor["nativeUser"] = original
        with patch.object(self.attribution, "capture", return_value={}), patch.object(self.attribution, "finish"):
            with self.permissions.delegated_finance_operation("sales_invoice", "create", self.policy, document=self.invoice(_new=True)):
                other = self.invoice(_new=True)
                other.company = "Company B"
                self.denied("FINANCE_COMPANY_DENIED", lambda: self.events.before_native_write(other))
                self.denied("FINANCE_UNBOUND_NATIVE_WRITE", lambda: self.events.before_native_write(self.payment()))

    def test_report_read_delegation_cannot_modify_native_documents(self):
        with self.permissions.delegated_finance_read("receivables", self.policy, "Company A"):
            self.denied("FINANCE_READ_ONLY_DELEGATION", lambda: self.events.before_native_write(self.invoice()))
        self.assertEqual(self.frappe.session.user, self.actor["nativeUser"])
        self.assertIsNone(self.permissions.delegated_actor())

    def _delegate(self):
        with self.permissions.delegated_finance_operation("sales_invoice", "create", self.policy, document=self.invoice(_new=True)):
            pass

    def test_explicit_template_leaves_custom_roles_unchanged_and_caps_remain_revocable(self):
        self.cfg["roles"]["admin"]["permissions"] = ["read", "accounts.configure"]
        self.cfg["roles"]["custom"] = {"scope": "tenant", "permissions": ["read", "finance.write"]}
        custom = copy.deepcopy(self.cfg["roles"]["custom"])
        self.administrator._finance_template(self.cfg, self.actor, {"roleKeys": ["admin"]})
        self.assertEqual(self.cfg["roles"]["custom"], custom)
        self.assertTrue(FINANCE_CAPABILITIES.issubset(self.cfg["roles"]["admin"]["permissions"]))
        self.assertEqual(self.cfg["financePermissions"]["version"], 1)
        self.denied("INVALID_FINANCE_TEMPLATE_ROLE", lambda: self.administrator._finance_template(self.cfg, self.actor, {"roleKeys": ["custom"]}))

    def test_policy_validation_refuses_wider_scope_unknown_keys_and_invalid_money(self):
        for value in ({"scope": "tenant"}, {"paymentLimit": {"amount": True, "currency": "USD"}}, {"paymentLimit": {"amount": "nan", "currency": "USD"}}, {"paymentLimit": {"amount": -1, "currency": "USD"}}, {"ignore_permissions": True}):
            with self.assertRaises(APIError):
                self.module.validate_policy(value, "self")


if __name__ == "__main__":
    unittest.main()
