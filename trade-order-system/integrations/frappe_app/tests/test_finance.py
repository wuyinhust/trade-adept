"""Boundary tests for the bounded native accounting facade.

Real ledger correctness is exercised by native_finance_probe.py separately.
These checks target tampering, stale saves and controller argument contracts.
"""
import copy
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.domain import APIError


class Row(dict):
    __getattr__ = dict.get
    __setattr__ = dict.__setitem__
    def set(self, key, value):
        self[key] = value
    def as_dict(self):
        return copy.deepcopy(dict(self))


class Document(Row):
    def set_missing_values(self):
        pass
    def calculate_taxes_and_totals(self):
        self["calculatedByNative"] = True
    def setup_party_account_field(self):
        pass
    def set_missing_ref_details(self):
        self["referencesFilledByNative"] = True
    def set_amounts(self):
        self["amountsCalculatedByNative"] = True


class FinanceBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fake = SimpleNamespace(db=Mock(), get_doc=Mock(), get_all=Mock(), session=Row(user="member@example.invalid"), flags=Row(), utils=Row(today=lambda: "2026-10-13"), scrub=lambda value: value.lower().replace(" ", "_"), _dict=Row)
        with patch.dict(sys.modules, {"frappe": fake}):
            cls.native = importlib.import_module("tradept_core.finance_native")
            cls.finance = importlib.import_module("tradept_core.finance")
            cls.order_native = importlib.import_module("tradept_core.native")

    def setUp(self):
        self.frappe = SimpleNamespace(db=Mock(), get_doc=Mock(), get_all=Mock(return_value=[]), session=Row(user="member@example.invalid"), flags=Row(), utils=Row(today=lambda: "2026-10-13"), scrub=lambda value: value.lower().replace(" ", "_"), _dict=Row)
        self.native_patch = patch.object(self.native, "frappe", self.frappe)
        self.finance_patch = patch.object(self.finance, "frappe", self.frappe)
        self.native_patch.start(); self.finance_patch.start()
        self.addCleanup(self.native_patch.stop); self.addCleanup(self.finance_patch.stop)
        self.frappe.db.exists.return_value = True
        def get_value(dt, name, field, **kwargs):
            if dt == "Company": return "USD"
            if dt == "Cost Center": return "Company" if field == "company" else 0
            if dt == "Warehouse": return "Company"
            return None
        self.frappe.db.get_value.side_effect = get_value

    def assert_code(self, code, fn, *args, **kwargs):
        with self.assertRaises(APIError) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_amount_rejects_nonfinite_bool_negative_and_huge(self):
        for value in (True, "NaN", "Infinity", -1, "1e20", None):
            self.assert_code("INVALID_FINANCE_AMOUNT", self.native.amount, value, "Amount")

    def test_signed_deduction_and_return_amounts_are_explicit(self):
        self.assertEqual(self.native.amount(-3, "Fee", signed=True), -3)
        self.assert_code("INVALID_FINANCE_AMOUNT", self.native.amount, 0, "Qty", positive=True)

    def test_calendar_dates_reject_invalid_or_injected_values(self):
        self.assertEqual(self.native.day("2026-10-13", "Posting"), "2026-10-13")
        for value in ("2026-02-30", "2026-10-13 01:00:00", "2026-10-13';", None):
            self.assert_code("INVALID_FINANCE_DATE", self.native.day, value, "Posting")

    def test_calculated_financial_fields_and_native_flags_are_rejected(self):
        for values in ({"outstandingAmount": 0}, {"grandTotal": 0}, {"flags": {"ignore_permissions": True}}, {"docstatus": 1}, {"owner": "Administrator"}):
            self.assert_code("INVALID_FINANCE_FIELDS", self.native.object_values, values, self.native.INVOICE_VALUES)

    def test_existing_invoice_currency_and_rate_are_frozen(self):
        doc = Document(company="Company", currency="CNY", conversion_rate=7)
        self.native.currency_rate(doc, {}, frozen=True)
        self.assertEqual(doc.conversion_rate, 7)
        self.assert_code("FINANCE_RATE_FROZEN", self.native.currency_rate, doc, {"currency": "USD"}, frozen=True)
        self.assert_code("FINANCE_RATE_FROZEN", self.native.currency_rate, doc, {"conversionRate": 8}, frozen=True)

    def test_new_foreign_currency_invoice_requires_explicit_rate(self):
        self.assert_code("INVALID_FINANCE_AMOUNT", self.native.currency_rate, Document(company="Company"), {"currency": "CNY"})

    def test_cross_company_account_and_cost_center_fail_before_native_controller(self):
        self.frappe.get_doc.return_value = Document(company="Other", is_group=0, disabled=0)
        self.assert_code("FINANCE_ACCOUNT_DENIED", self.native.require_account, "Bank", "Company")
        self.frappe.db.get_value.side_effect = lambda *a, **k: "Other"
        self.assert_code("FINANCE_COST_CENTER_DENIED", self.native.require_cost_center, "Center", "Company")

    def test_bank_and_party_account_types_are_checked(self):
        self.frappe.get_doc.return_value = Document(company="Company", is_group=0, account_type="Expense")
        self.assert_code("FINANCE_ACCOUNT_DENIED", self.native.require_account, "Fees", "Company", types={"Bank", "Cash"})

    def invoice(self):
        self.frappe.get_doc.side_effect = lambda dt, name, **kw: Document(doctype=dt, name=name, custom_tradept_company="Company", disabled=0, stock_uom="Nos")
        return Document(doctype="Sales Invoice", company="Company", customer="Customer", currency="USD", conversion_rate=1, items=[Document(name="old-row", item_code="Item", qty=10, rate=10, sales_order="SO", so_detail="SO-item", uom="Nos")])

    def test_mapped_invoice_item_edit_preserves_native_links(self):
        doc = self.invoice()
        self.native.invoice_values(doc, {"items": [{"name": "old-row", "itemCode": "Item", "qty": 4, "rate": 10}]}, frozen=True)
        self.assertEqual(doc["items"][0]["sales_order"], "SO")
        self.assertEqual(doc["items"][0]["so_detail"], "SO-item")
        self.assertEqual(doc["items"][0]["qty"], 4)
        self.assertTrue(doc.calculatedByNative)

    def test_nullable_native_child_tables_return_empty_arrays(self):
        doc = Document(doctype="Sales Invoice", company="Company", currency="USD", customer="Customer", items=None, references=None, deductions=None, taxes=None, payment_schedule=None, advances=None)
        self.assertEqual(self.native.detail(doc, "C")["items"], [])
        self.assertEqual(self.native.detail(doc, "C")["advances"], [])

    def test_outstanding_currency_is_native_party_account_currency(self):
        doc = Document(doctype="Sales Invoice", company="Company", currency="CNY", customer="Customer", grand_total=70, outstanding_amount=10, party_account_currency="USD")
        value = self.native.summary(doc, "C")
        self.assertEqual((value["currency"], value["grandTotal"], value["outstandingCurrency"], value["outstandingAmount"]), ("CNY", 70, "USD", 10))

    def test_empty_optional_accounts_reset_overrides_before_native_default_fill(self):
        doc = self.invoice()
        doc.debit_to, doc.cost_center = "Old Party Account", "Old Cost Center"
        doc["items"][0].income_account = "Old Income"
        doc["items"][0].cost_center = "Old Item Cost Center"
        received = []
        def native_fill():
            line = doc["items"][0]
            received.append((doc.get("debit_to"), doc.get("cost_center"), line.get("income_account"), line.get("cost_center")))
            doc.debit_to = "Native Party Account"
            line["income_account"], line["cost_center"] = "Native Item Income", "Native Item Cost Center"
        with patch.object(Document, "set_missing_values", lambda _doc: native_fill()):
            self.native.invoice_values(doc, {"debitTo": "", "costCenter": None, "items": [{"name": "old-row", "qty": 4, "rate": 10, "incomeAccount": None, "costCenter": ""}]}, frozen=True)
        self.assertEqual(received, [(None, None, None, None)])
        self.assertEqual(doc.debit_to, "Native Party Account")
        self.assertEqual(doc["items"][0]["income_account"], "Native Item Income")
        self.assertEqual(doc["items"][0]["cost_center"], "Native Item Cost Center")
        self.assertEqual(doc["items"][0]["sales_order"], "SO")

    def test_bare_item_fields_use_standard_missing_values_controller(self):
        self.invoice()
        doc = Document(doctype="Purchase Invoice", company="Company", supplier="Supplier", currency="USD", conversion_rate=1, items=None)
        called = []
        def native_fill():
            line = doc["items"][0]
            called.append((doc.get("credit_to"), line.get("expense_account"), line.get("cost_center")))
            doc.credit_to = "Native Supplier Account"
            line["expense_account"], line["cost_center"] = "Native Item Expense", "Native Cost Center"
        with patch.object(Document, "set_missing_values", lambda _doc: native_fill()):
            self.native.invoice_values(doc, {"creditTo": None, "items": [{"itemCode": "Item", "qty": 1, "rate": 2}]})
        self.assertEqual(called, [(None, None, None)])
        self.assertEqual(doc.credit_to, "Native Supplier Account")
        self.assertEqual(doc["items"][0]["expense_account"], "Native Item Expense")

    def test_direct_payment_internal_transfer_uses_company_bank_accounts(self):
        def account(dt, name, **kw):
            if dt == "Account":
                return Document(name=name, company="Company", account_currency="USD", account_type="Bank")
            raise AssertionError(dt)
        self.frappe.get_doc.side_effect = account
        doc = Document(doctype="Payment Entry", company="Company", payment_type="Internal Transfer", paid_from="Bank A", paid_to="Bank B", paid_amount=10, received_amount=10, references=[], deductions=[])
        self.native.payment_values(doc, {"paidAmount": 10, "receivedAmount": 10})
        self.assertTrue(doc.amountsCalculatedByNative)
        self.assertIsNone(doc.get("party"))
        self.assert_code("INVALID_FINANCE_TRANSFER", self.native.payment_values, doc, {"partyType": "Customer", "party": "Customer"})

    def test_mapped_invoice_cannot_invent_replacement_source_row(self):
        doc = self.invoice()
        self.assert_code("FINANCE_SOURCE_ITEM_REQUIRED", self.native.invoice_values, doc, {"items": [{"itemCode": "Item", "qty": 4, "rate": 10}]}, frozen=True)

    def test_item_row_from_another_document_is_rejected(self):
        doc = self.invoice()
        self.assert_code("FINANCE_ITEM_CONFLICT", self.native.invoice_values, doc, {"items": [{"name": "foreign-row", "itemCode": "Item", "qty": 4, "rate": 10}]}, frozen=True)

    def test_mapped_party_cannot_be_reassigned(self):
        self.assert_code("FINANCE_PARTY_FROZEN", self.native.invoice_values, self.invoice(), {"party": "Other"}, frozen=True)

    def payment(self, source_currency="USD", target_currency="USD"):
        def get_doc(dt, name, **kw):
            if dt == "Customer": return Document(name=name, custom_tradept_company="Company")
            if dt == "Account": return Document(name=name, company="Company", account_currency=source_currency if name == "Debtor" else target_currency, account_type="Receivable" if name == "Debtor" else "Bank")
            if dt == "Sales Invoice": return Document(name=name, company="Company", customer="Customer", docstatus=1, is_return=0)
            raise AssertionError(dt)
        self.frappe.get_doc.side_effect = get_doc
        return Document(doctype="Payment Entry", company="Company", party_type="Customer", party="Customer", payment_type="Receive", paid_from="Debtor", paid_to="Bank", paid_amount=100, received_amount=100, references=[], deductions=[])

    def test_same_currency_input_not_silently_overwritten(self):
        doc = self.payment()
        self.assert_code("NATIVE_SAME_CURRENCY_PAYMENT", self.native.payment_values, doc, {"paidAmount": 100, "receivedAmount": 97})

    def test_foreign_payment_requires_actual_payment_rate(self):
        doc = self.payment("USD", "CNY")
        self.assert_code("FINANCE_PAYMENT_RATE_REQUIRED", self.native.payment_values, doc, {"paidAmount": 100, "receivedAmount": 690})

    def test_foreign_payment_records_distinct_paid_and_received_values(self):
        doc = self.payment("USD", "CNY")
        self.native.payment_values(doc, {"paidAmount": 100, "receivedAmount": 690, "sourceExchangeRate": 1, "targetExchangeRate": 0.145, "references": [{"referenceDoctype": "Sales Invoice", "referenceName": "SI", "allocatedAmount": 100}]})
        self.assertEqual((doc.paid_amount, doc.received_amount, doc.target_exchange_rate), (100, 690, 0.145))
        self.assertTrue(doc.referencesFilledByNative)
        self.assertTrue(doc.amountsCalculatedByNative)
        self.assertNotIn("outstanding_amount", doc.references[0])

    def test_one_invoice_accepts_distinct_native_payment_terms_but_not_duplicate_term(self):
        doc = self.payment()
        references = [{"referenceDoctype": "Sales Invoice", "referenceName": "SI", "allocatedAmount": 10, "paymentTerm": term} for term in ("Deposit", "Balance")]
        self.native.payment_values(doc, {"references": references})
        self.assertEqual([row["payment_term"] for row in doc.references], ["Deposit", "Balance"])
        self.assert_code("INVALID_FINANCE_REFERENCE", self.native.payment_values, doc, {"references": [references[0], references[0]]})

    def test_term_balances_use_native_mapping_in_party_account_currency(self):
        doc = Document(doctype="Sales Invoice", name="CNY-SI", currency="CNY", company="Company", party_account_currency="USD", payment_terms_template="Two Terms", payment_schedule=[Row(payment_term="Deposit", due_date="2026-10-13", payment_amount=35, outstanding=35)])
        self.frappe.db.get_value.side_effect = lambda dt, *a, **kw: 1 if dt == "Payment Terms Template" else "USD"
        mapping = Mock(return_value=[{"payment_term": "Deposit", "payment_term_outstanding": 5}])
        controller = SimpleNamespace(get_reference_as_per_payment_terms=mapping, set_grand_total_and_outstanding_amount=Mock(return_value=(10, 10)))
        with patch.dict(sys.modules, {"erpnext.accounts.doctype.payment_entry.payment_entry": controller}):
            result = self.native.payment_terms(doc)
        self.assertTrue(result["allocatePaymentBasedOnPaymentTerms"])
        self.assertEqual(result["paymentSchedule"][0]["paymentAmount"], 35)
        self.assertEqual((result["paymentSchedule"][0]["outstandingAmount"], result["paymentSchedule"][0]["outstandingCurrency"]), (5, "USD"))
        self.assertEqual(mapping.call_args.args[-1], "USD")

    def test_unreconcile_rejects_client_supplied_allocation_amounts(self):
        payment = Row(doctype="Payment Entry", name="PE", company="Company", docstatus=1, payment_type="Receive", party_type="Customer", party="Customer", modified="now")
        invoice = Row(doctype="Sales Invoice", name="SI", company="Company", docstatus=1, customer="Customer", modified="now")
        with patch.object(self.finance, "_load", side_effect=[payment, invoice]):
            self.assert_code("INVALID_FINANCE_FIELDS", self.finance._unreconcile, "Company", {"name": "PE", "expectedModified": "now"}, {"invoices": [{"resource": "sales_invoice", "name": "SI", "expectedModified": "now", "allocatedAmount": 100000}]}, Mock(), "C")

    def test_unreconcile_requires_each_native_invoice_timestamp(self):
        payment = Row(doctype="Payment Entry", name="PE", company="Company", docstatus=1, payment_type="Receive", party_type="Customer", party="Customer", modified="now")
        invoice = Row(doctype="Sales Invoice", name="SI", company="Company", docstatus=1, customer="Customer", modified="latest")
        with patch.object(self.finance, "_load", side_effect=[payment, invoice]):
            self.assert_code("STALE_DOCUMENT", self.finance._unreconcile, "Company", {"name": "PE", "expectedModified": "now"}, {"invoices": [{"resource": "sales_invoice", "name": "SI", "expectedModified": "old"}]}, Mock(), "C")

    def test_reference_cannot_target_arbitrary_doctype(self):
        self.assert_code("INVALID_FINANCE_REFERENCE", self.native.payment_values, self.payment(), {"references": [{"referenceDoctype": "User", "referenceName": "Administrator", "allocatedAmount": 100}]})

    def test_payment_reference_requires_same_party_company_and_submitted_status(self):
        doc = self.payment()
        original = self.frappe.get_doc.side_effect
        self.frappe.get_doc.side_effect = lambda dt, name, **kw: Document(name=name, company="Other", customer="Customer", docstatus=1) if dt == "Sales Invoice" else original(dt, name, **kw)
        self.assert_code("FINANCE_REFERENCE_DENIED", self.native.payment_values, doc, {"references": [{"referenceDoctype": "Sales Invoice", "referenceName": "Other-SI", "allocatedAmount": 100}]})

    def test_ordinary_invoice_refund_negative_allocation_requires_native_credit_balance(self):
        doc = self.payment()
        original = self.frappe.get_doc.side_effect
        reference = Document(name="Overpaid-SI", company="Company", customer="Customer", docstatus=1, is_return=0, outstanding_amount=-25)
        self.frappe.get_doc.side_effect = lambda dt, name, **kw: reference if dt == "Sales Invoice" else original(dt, name, **kw)
        values = {"references": [{"referenceDoctype": "Sales Invoice", "referenceName": "Overpaid-SI", "allocatedAmount": -10}]}
        self.native.payment_values(doc, values)
        self.assertEqual(doc.references[0]["allocated_amount"], -10)
        reference.outstanding_amount = 25
        self.assert_code("INVALID_FINANCE_AMOUNT", self.native.payment_values, doc, values)

    def test_report_company_sql_and_raw_filter_injection_are_rejected(self):
        for value in ({"company": "Other"}, {"filters": "1=1"}, {"doctype": "User"}, {"query": "SELECT *"}):
            self.assert_code("INVALID_FINANCE_FIELDS", self.native.report_filters, "receivables", "Company", value)

    def test_native_v16_age_ranges_and_historical_cutoff_are_preserved(self):
        filters = self.native.report_filters("receivables", "Company", {"range1": 15, "range2": 30, "range3": 60, "range4": 90, "reportDate": "2026-09-01"})
        self.assertEqual(filters["range"], "15, 30, 60, 90")
        self.assertEqual(filters.age_as_on, "Report Date")
        self.assertEqual(filters.report_date, "2026-09-01")
        self.assertEqual(filters.party_type, "Customer")
        self.assertNotIn("range1", filters)

    def test_age_ranges_cannot_repeat_or_decrease(self):
        self.assert_code("INVALID_FINANCE_FILTER", self.native.report_filters, "payables", "Company", {"range1": 30, "range2": 20})

    def test_general_ledger_requires_explicit_date_range(self):
        self.assert_code("FINANCE_REPORT_DATES_REQUIRED", self.native.report_filters, "general_ledger", "Company", {})
        self.assert_code("INVALID_FINANCE_DATE_RANGE", self.native.report_filters, "general_ledger", "Company", {"fromDate": "2026-10-13", "toDate": "2026-10-12"})

    def test_global_and_document_concurrent_save_guards(self):
        work = Row(revision=10)
        self.assert_code("EXPECTED_VERSION_REQUIRED", self.finance._expected, work, {"expectedVersion": True})
        self.assert_code("VERSION_CONFLICT", self.finance._expected, work, {"expectedVersion": 9})
        self.assert_code("EXPECTED_MODIFIED_REQUIRED", self.finance._modified, Row(modified="now"), None)
        self.assert_code("STALE_DOCUMENT", self.finance._modified, Row(modified="now"), "then")

    def test_receipt_hash_preserves_business_intent_but_not_cas_cursor(self):
        request = {"companyId": "C", "resource": "payment_entry", "operation": "create", "idempotencyKey": "key", "expectedVersion": 3, "expectedModified": "old", "values": {"paidAmount": 100}}
        changed_cursor = {**request, "expectedVersion": 4, "expectedModified": "new"}
        self.assertEqual(self.finance._request_hash(request), self.finance._request_hash(changed_cursor))
        self.assertNotEqual(self.finance._request_hash(request), self.finance._request_hash({**request, "values": {"paidAmount": 101}}))

    def test_replay_requires_exact_original_financial_payload(self):
        self.frappe.get_all.return_value = [Row(revision=4, summary='{"requestSha256":"original","result":{},"references":[]}')]
        self.assert_code("IDEMPOTENCY_CONFLICT", self.finance._replay, "key", "different", {"id": "actor"}, Mock(), "C", "Company")

    def test_document_company_validation_precedes_orm_write(self):
        self.frappe.get_doc.return_value = Row(doctype="Sales Invoice", name="SI", company="Other")
        policy = Mock()
        self.assert_code("FINANCE_COMPANY_DENIED", self.finance._load, "sales_invoice", "SI", "Company", policy)
        policy.validate_document.assert_not_called()

    def test_shared_invoice_order_shares_exclude_unlinked_items(self):
        invoice = Document(doctype="Sales Invoice", items=[Row(sales_order="SO-A", base_net_amount=60), Row(sales_order="SO-B", base_net_amount=30), Row(base_net_amount=10)])
        self.assertEqual(self.order_native.invoice_order_share(invoice, Row(doctype="Sales Order", name="SO-A")), .6)
        self.assertEqual(self.order_native.invoice_order_share(invoice, Row(doctype="Sales Order", name="SO-B")), .3)
        invoice.items = [Row(sales_order="SO-A", base_net_amount=-60), Row(sales_order="SO-B", base_net_amount=-40)]
        self.assertEqual(self.order_native.invoice_order_share(invoice, Row(doctype="Sales Order", name="SO-A")), .6)

    def test_order_settlement_uses_native_party_balance_and_frozen_currency(self):
        order = Row(doctype="Sales Order", name="SO-A", company="Company", currency="USD", conversion_rate=7, advance_paid=70, party_account_currency="CNY")
        invoice = Document(doctype="Sales Invoice", name="SI", company="Company", currency="USD", conversion_rate=7, party_account_currency="CNY", items=[Row(sales_order="SO-A", base_net_amount=420), Row(sales_order="SO-B", base_net_amount=280)])
        controller = SimpleNamespace(set_grand_total_and_outstanding_amount=Mock(return_value=(700, 350)))
        with patch.dict(sys.modules, {"erpnext.accounts.doctype.payment_entry.payment_entry": controller}), patch.object(self.order_native.repo, "get_value", return_value="CNY"), patch.object(self.order_native, "_posted_order_invoices", return_value=[invoice]), patch.object(self.order_native, "_order_receipts", return_value=[]):
            result = self.order_native.order_finance(order)
        self.assertEqual(result["advanceBase"], 70)
        self.assertEqual(result["invoiceSettledBase"], 210)
        self.assertEqual(result["invoiceOutstandingBase"], 210)
        controller.set_grand_total_and_outstanding_amount.assert_called_once_with(None, "Sales Invoice", "CNY", invoice)

    def test_return_refund_decreases_order_settlement_without_manufacturing_cash(self):
        order = Row(doctype="Purchase Order", name="PO-A", company="Company", currency="USD", conversion_rate=1, advance_paid=0, party_account_currency="USD")
        invoice = Document(doctype="Purchase Invoice", name="PI-RETURN", company="Company", currency="USD", conversion_rate=1, party_account_currency="USD", items=[Row(purchase_order="PO-A", base_net_amount=-100)])
        controller = SimpleNamespace(set_grand_total_and_outstanding_amount=Mock(return_value=(-100, -90)))
        with patch.dict(sys.modules, {"erpnext.accounts.doctype.payment_entry.payment_entry": controller}), patch.object(self.order_native.repo, "get_value", return_value="USD"), patch.object(self.order_native, "_posted_order_invoices", return_value=[invoice]), patch.object(self.order_native, "_order_receipts", return_value=[]):
            result = self.order_native.order_finance(order)
        self.assertEqual(result["invoiceSettledBase"], -10)
        self.assertEqual(result["invoiceOutstandingBase"], -90)

    def test_order_bank_voucher_summary_is_nonadditive_and_retains_unallocated_cash(self):
        order = Row(doctype="Sales Order", name="SO", company="Company", customer="Customer")
        payment = Row(docstatus=1, company="Company", party="Customer", name="PE", posting_date="2026-10-13", payment_type="Receive", party_type="Customer", paid_amount=100, received_amount=97, paid_from_account_currency="USD", paid_to_account_currency="USD", unallocated_amount=60)
        self.frappe.db.sql.return_value = [Row(parent="PE")]
        with patch.object(self.order_native, "frappe", self.frappe), patch.object(self.order_native.repo, "current_reads", return_value=False), patch.object(self.order_native.repo, "get_doc", return_value=payment):
            result = self.order_native._order_receipts(order, [])
        self.assertEqual((result[0]["bankAmount"], result[0]["unallocatedAmount"]), (97, 60))
        self.assertTrue(result[0]["sharedReceipt"])
        self.assertFalse(result[0]["additiveByOrder"])
        self.assertNotIn("paidTo", result[0])

    def test_zero_net_posted_invoice_remains_order_workflow_evidence(self):
        order = Row(doctype="Sales Order", name="SO", company="Company", currency="USD", conversion_rate=1, advance_paid=0)
        invoice = Document(doctype="Sales Invoice", name="ZERO-SI", currency="USD", conversion_rate=1, party_account_currency="USD", items=[Row(sales_order="SO", base_net_amount=0)])
        controller = SimpleNamespace(set_grand_total_and_outstanding_amount=Mock())
        with patch.dict(sys.modules, {"erpnext.accounts.doctype.payment_entry.payment_entry": controller}), patch.object(self.order_native.repo, "get_value", return_value="USD"), patch.object(self.order_native, "_posted_order_invoices", return_value=[invoice]), patch.object(self.order_native, "_order_receipts", return_value=[]):
            result = self.order_native.order_finance(order)
        self.assertEqual(result["invoiceNames"], ["ZERO-SI"])
        self.assertEqual(result["invoiceSettledBase"], 0)
        controller.set_grand_total_and_outstanding_amount.assert_not_called()


if __name__ == "__main__":
    unittest.main()
