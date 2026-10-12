"""Typed record schema. Unknown extension keys are retained per record only.

presence_keys distinguishes historical missing/null values without inventing
owners, dates, rates or payments. It is metadata, never a business aggregate.
"""
from __future__ import annotations

import copy
import json
import re

COLLECTIONS = ("customers", "factories", "orders", "shipments", "invoices")
COMMON = {
    "id": ("record_id", "Data"), "tenantId": ("tenant_id", "Data"),
    "companyId": ("company_id", "Data"), "createdBy": ("created_by_id", "Data"),
    "createdAt": ("created_at_source", "Data"), "updatedBy": ("updated_by_id", "Data"),
    "updatedAt": ("updated_at_source", "Data"), "deleted": ("is_deleted", "Check"),
    "deletedAt": ("deleted_at_source", "Data"), "salespersonId": ("salesperson_id", "Data"),
    "ownerId": ("owner_id", "Data"),
}


def fields(data=(), text=(), currency=(), number=(), dates=()):
    result = {}
    for keys, kind in ((data, "Data"), (text, "Long Text"), (currency, "Currency"), (number, "Float"), (dates, "Date")):
        for key in keys:
            result[key] = (re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(), kind)
    return result


ORDER = {**COMMON, **fields(
    data=("companyOperationNo", "customerOrderNo", "customerId", "customerName", "contactPerson", "factoryId", "factoryName", "productName", "productCategory", "unit", "status", "orderStatus", "paymentStatus", "shippingStatus", "factoryPaidStatus", "costPaymentStatus", "loadingPort", "destinationPort", "overseasPort", "profitPolicy", "settlementCurrency"),
    text=("paymentTerms", "remarks"),
    currency=("orderAmountUSD", "orderAmountRMB", "factoryCostRMB", "factoryCostUSD", "freightCostUSD", "freightCostRMB", "insuranceCostUSD", "otherCostUSD", "otherCostRMB", "paidAmountUSD", "factoryPaidRMB", "costPaidUSD", "profitRMB", "profitUSD"),
    number=("quantity", "profitRate"), dates=("orderDate", "expectedShipDate", "actualShipDate"))}
CUSTOMER = {**COMMON, **fields(data=("country", "contact", "position", "phone", "mobilePhone", "email"), text=("companyAddress", "homeAddress", "paymentTerms", "remarks")), "company": ("customer_name", "Data")}
SUPPLIER = {**COMMON, **fields(data=("contact", "phone", "mobilePhone", "email"), text=("address", "products", "bankInfo", "bankAccount", "remarks")), "name": ("supplier_name", "Data")}
SHIPMENT = {**COMMON, **fields(data=("orderId", "customerName", "companyOperationNo", "invoiceNo", "status", "shippingStatus", "customsStatus", "loadingPort", "destinationPort", "overseasPort", "blNumber", "containerNo", "vessel", "voyage"), text=("cargoDesc", "remarks"), number=("grossWeight", "netWeight", "volume"), dates=("etd", "customsDate", "actualShipDate", "arrivalDate", "receivedDate"))}
DOCUMENT = {**COMMON, **fields(data=("orderId", "docType", "docNumber", "status", "customerName", "companyOperationNo", "currency"), text=("remarks", "content"), currency=("amount", "totalAmount"), dates=("docDate", "date"))}
FACTORY_LINE = fields(data=("factoryId", "factoryName", "productType", "paymentStatus", "costPaymentStatus"), currency=("totalAmount", "prepayment", "paidAmount", "cost", "costUSD", "costRMB", "paidCostRMB", "paidCostUSD", "costPaidUSD", "purchaseRate"), number=("totalQuantity",), dates=("inspectionDate", "estimatedShipDate"))
ITEM_LINE = fields(data=("id", "itemCode", "factoryId", "purchaseCurrency", "uom"), currency=("saleRate", "purchaseRate"), number=("quantity",))
MAPS = {"customers": CUSTOMER, "factories": SUPPLIER, "orders": ORDER, "shipments": SHIPMENT, "invoices": DOCUMENT}
DOCTYPES = {"customers": ("Customer",), "factories": ("Supplier",), "orders": ("Trade Order Brief", "Trade Legacy Order"), "shipments": ("Trade Shipment",), "invoices": ("Trade Document",)}
NATIVE_STANDARD = {"Customer": {"customer_name"}, "Supplier": {"supplier_name"}}


def field_name(doctype, name):
    return name if not (doctype in NATIVE_STANDARD and name not in NATIVE_STANDARD[doctype]) else "custom_tradept_" + name


def loads(value, default=None):
    if value in (None, ""):
        return copy.deepcopy(default)
    return json.loads(value) if isinstance(value, str) else copy.deepcopy(value)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def encode(value, mapping, doctype):
    known = set(mapping) | {"contacts", "factories", "factoryIds", "erpItems"}
    fields_out = {}
    for key, (name, _kind) in mapping.items():
        fields_out[field_name(doctype, name)] = value.get(key)
    fields_out[field_name(doctype, "presence_keys")] = dumps(list(value))
    fields_out[field_name(doctype, "null_keys")] = dumps([key for key in value if value[key] is None])
    fields_out[field_name(doctype, "empty_keys")] = dumps([key for key in value if value[key] == ""])
    fields_out[field_name(doctype, "extensions")] = dumps({key: val for key, val in value.items() if key not in known})
    return fields_out


def decode(doc, mapping, doctype):
    present = loads(doc.get(field_name(doctype, "presence_keys")), [])
    nulls = set(loads(doc.get(field_name(doctype, "null_keys")), []))
    empty = set(loads(doc.get(field_name(doctype, "empty_keys")), []))
    value = loads(doc.get(field_name(doctype, "extensions")), {})
    for key, (name, kind) in mapping.items():
        if key not in present:
            continue
        raw = doc.get(field_name(doctype, name))
        if key in nulls:
            raw = None
        elif key in empty and raw is None:
            raw = ""
        elif kind == "Check":
            raw = bool(raw)
        elif kind == "Date" and raw:
            raw = str(raw)
        value[key] = raw
    return value


def child_encode(value, mapping):
    return encode(value, mapping, "Trade Child")


def child_decode(doc, mapping):
    return decode(doc, mapping, "Trade Child")
