app_name = "tradept_core"
app_title = "Tradept Core"
app_publisher = "Tradept"
app_description = "One ERPNext database with the Tradept foreign-trade workbench"
app_email = "support@tradept.invalid"
app_license = "GPL-3.0"
required_apps = ["erpnext"]
after_install = "tradept_core.install.install"
after_migrate = "tradept_core.install.install"
before_request = ["tradept_core.request_guard.check_request"]

# Configured Tradept users operate through the scoped facade. Even an accidental
# standard ERP role grant must not expose native REST / Desk financial records.
_guarded = (
    "Company", "Customer", "Supplier", "Contact", "Address", "Currency Exchange",
    "User", "User Permission", "Role", "Role Profile", "Custom DocPerm",
    "Sales Order", "Purchase Order", "Sales Invoice", "Purchase Invoice",
    "Delivery Note", "Purchase Receipt", "Payment Entry", "Journal Entry",
    "GL Entry", "Payment Ledger Entry", "Advance Payment Ledger Entry", "Stock Ledger Entry", "Account",
    "Warehouse", "Item", "Item Price", "Bank Account", "Bank Transaction",
    "Quotation", "Supplier Quotation", "Material Request", "Stock Entry",
    "Trade Workspace", "Trade User Profile", "Trade Order Brief", "Trade Legacy Order",
    "Trade Shipment", "Trade Document", "Trade Snapshot", "Trade Audit",
    "Trade Import Receipt",
)
has_permission = {name: "tradept_core.permissions.native_permission" for name in _guarded}
permission_query_conditions = {name: "tradept_core.permissions.native_query" for name in _guarded}

_business_documents = ("Company", "Customer", "Supplier", "Contact", "Currency Exchange", "Sales Order", "Purchase Order", "Delivery Note", "Sales Invoice", "Purchase Invoice", "Purchase Receipt", "Payment Entry", "Trade Order Brief", "Trade Legacy Order", "Trade Shipment", "Trade Document")
doc_events = {name: {
    "before_insert": "tradept_core.events.before_native_write",
    "before_save": "tradept_core.events.before_native_write",
    "before_submit": "tradept_core.events.before_native_write",
    "before_cancel": "tradept_core.events.before_native_write",
    "on_trash": "tradept_core.events.before_native_write",
    "on_update": "tradept_core.events.after_native_write",
    "on_submit": "tradept_core.events.after_native_write",
    "on_cancel": "tradept_core.events.after_native_write",
    "on_change": "tradept_core.events.after_native_write",
    "after_delete": "tradept_core.events.after_native_write",
} for name in _business_documents}
