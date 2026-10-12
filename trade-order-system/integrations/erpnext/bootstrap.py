"""Run inside the isolated ERPNext backend container, from frappe-bench.

Creates only fictional fixtures and one limited integration user. Prints names,
never credentials. API credentials are written to an explicitly private file.
"""
import argparse
from datetime import date
import json
import os
from pathlib import Path
import sys

BENCH = Path.cwd()
for app in ("frappe", "erpnext"):
    sys.path.insert(0, str(BENCH / "apps" / app))

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
from erpnext.setup.setup_wizard.operations import install_fixtures


def ensure(doctype, name, values):
    if frappe.db.exists(doctype, name):
        return frappe.get_doc(doctype, name)
    return frappe.get_doc({"doctype": doctype, **values}).insert()


def bootstrap(output):
    if not frappe.db.exists("Customer Group", "All Customer Groups") or not frappe.db.exists("UOM", "Nos"):
        install_fixtures.install("United States")
    required_fixtures = [("Item Group", "All Item Groups"), ("Customer Group", "All Customer Groups"), ("Supplier Group", "All Supplier Groups"), ("Territory", "All Territories"), ("UOM", "Nos"), ("Party Type", "Customer"), ("Party Type", "Supplier")]
    missing_fixtures = [f"{doctype}: {name}" for doctype, name in required_fixtures if not frappe.db.exists(doctype, name)]
    if missing_fixtures:
        raise RuntimeError("Official ERP setup fixtures are incomplete: " + ", ".join(missing_fixtures))
    # ERPNext forbids a Customer's use of a group node. Keep explicit leaf
    # mappings rather than guessing an enterprise's category hierarchy.
    ensure("Customer Group", "Trade Demo Customers", {"customer_group_name": "Trade Demo Customers", "parent_customer_group": "All Customer Groups", "is_group": 0})
    ensure("Supplier Group", "Trade Demo Suppliers", {"supplier_group_name": "Trade Demo Suppliers", "parent_supplier_group": "All Supplier Groups", "is_group": 0})
    ensure("Territory", "Trade Demo Territory", {"territory_name": "Trade Demo Territory", "parent_territory": "All Territories", "is_group": 0})
    year = date.today().year
    ensure("Fiscal Year", f"Trade Demo {year}", {"year": f"Trade Demo {year}", "year_start_date": f"{year}-01-01", "year_end_date": f"{year}-12-31"})
    company = ensure("Company", "Example Trade Demo", {"company_name": "Example Trade Demo", "abbr": "EX", "default_currency": "USD", "country": "United States", "create_chart_of_accounts_based_on": "Standard Template", "chart_of_accounts": "Standard"})
    install_fixtures.set_global_defaults({"currency": "USD", "company_name": company.name, "country": "United States"})
    install_fixtures.update_stock_settings()
    ensure("Price List", "Trade Demo Selling USD", {"price_list_name": "Trade Demo Selling USD", "currency": "USD", "selling": 1, "enabled": 1})
    ensure("Price List", "Trade Demo Buying USD", {"price_list_name": "Trade Demo Buying USD", "currency": "USD", "buying": 1, "enabled": 1})
    for code in ("TW-DEMO-A", "TW-DEMO-B"):
        ensure("Item", code, {"item_code": code, "item_name": code + " fictional sample", "item_group": "All Item Groups", "stock_uom": "Nos", "is_stock_item": 0, "is_sales_item": 1, "is_purchase_item": 1, "item_defaults": [{"company": company.name, "default_income_account": company.default_income_account, "default_expense_account": company.default_expense_account}]})
    fields = {doctype: [{"fieldname": "custom_trade_external_id", "label": "Trade external ID", "fieldtype": "Data", "unique": 1, "read_only": 1, "no_copy": 1, "insert_after": "amended_from" if doctype not in ("Customer", "Supplier") else "customer_name" if doctype == "Customer" else "supplier_name"}] for doctype in ("Customer", "Supplier", "Sales Order", "Purchase Order", "Delivery Note", "Payment Entry")}
    fields["Sales Order Item"] = [{"fieldname": "custom_trade_line_id", "label": "Trade line ID", "fieldtype": "Data", "read_only": 1, "no_copy": 1, "insert_after": "item_code"}, {"fieldname": "custom_trade_supplier_id", "label": "Trade supplier ID", "fieldtype": "Data", "read_only": 1, "no_copy": 1, "insert_after": "custom_trade_line_id"}]
    create_custom_fields(fields, update=True)
    username = "trade.integration@example.invalid"
    user = ensure("User", username, {"email": username, "first_name": "Trade Integration Demo", "enabled": 1, "send_welcome_email": 0, "user_type": "System User", "new_password": frappe.generate_hash(length=32)})
    for role in ("Sales Manager", "Sales Master Manager", "Purchase Manager", "Purchase Master Manager", "Stock Manager", "Accounts Manager", "Accounts User"):
        if frappe.db.exists("Role", role) and role not in [r.role for r in user.roles]:
            user.append("roles", {"role": role})
    user.api_key = user.api_key or frappe.generate_hash(length=20)
    if not user.get_password("api_secret", raise_exception=False):
        user.api_secret = frappe.generate_hash(length=32)
    user.save()
    required_permissions = [(doctype, "create") for doctype in ("Customer", "Supplier", "Sales Order", "Purchase Order", "Delivery Note", "Payment Entry")] + [("GL Entry", "read")]
    denied = [f"{doctype}.{permission}" for doctype, permission in required_permissions if not frappe.has_permission(doctype, ptype=permission, user=username)]
    if denied:
        raise RuntimeError("Fictional integration roles lack required ERP permissions: " + ", ".join(denied))
    bank = frappe.db.get_value("Account", {"company": company.name, "account_type": "Bank", "is_group": 0}, "name")
    if not bank:
        parent = frappe.db.get_value("Account", {"company": company.name, "account_type": "Bank", "is_group": 1}, "name")
        if not parent:
            parent = frappe.db.get_value("Account", {"company": company.name, "account_name": "Bank Accounts", "is_group": 1}, "name")
        bank = ensure("Account", "Trade Demo Bank - EX", {"account_name": "Trade Demo Bank", "company": company.name, "parent_account": parent, "account_type": "Bank", "account_currency": "USD", "is_group": 0}).name
    company.default_bank_account = bank
    company.save()
    frappe.db.commit()
    result = {"tenants": {"example-company": {"enabled": True, "baseUrl": "http://127.0.0.1:3088", "site": frappe.local.site, "apiKey": user.api_key, "apiSecret": user.get_password("api_secret"), "companies": {"EX-01": {"name": company.name, "currency": "USD", "legacyPurchaseCostCurrency": "USD", "customerGroup": "Trade Demo Customers", "supplierGroup": "Trade Demo Suppliers", "territory": "Trade Demo Territory", "warehouse": "Finished Goods - EX", "receivableAccount": company.default_receivable_account, "payableAccount": company.default_payable_account, "bankAccount": bank, "sellingPriceList": "Trade Demo Selling USD", "buyingPriceList": "Trade Demo Buying USD"}}}}}
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    if path.is_symlink():
        raise ValueError("Refuse a symlink credential output")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)
    print(json.dumps({"site": frappe.local.site, "company": company.name, "items": ["TW-DEMO-A", "TW-DEMO-B"], "user": username, "credentialFileCreated": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    # Frappe CLI commands run from sites; its logger derives bench from cwd.
    os.chdir(BENCH / "sites")
    frappe.init(site=args.site, sites_path=str(BENCH / "sites"))
    frappe.connect()
    frappe.set_user("Administrator")
    try:
        bootstrap(args.output)
    finally:
        frappe.destroy()
