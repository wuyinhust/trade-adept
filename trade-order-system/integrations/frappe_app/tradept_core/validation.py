"""Business validation at the storage boundary, independent of HTTP/auth code.

Raises ValueError; the caller maps it to an atomic HTTP 400. Historical records
may retain missing legacy fields until that field is deliberately changed.
"""

import datetime
import math

ORDER_STATUSES = {"进行中", "已订船", "已取消", "推迟出货"}
PAYMENT_STATUSES = {"未收款", "部分收款", "已收款"}
SHIPPING_STATUSES = {"待出运", "已出运", "已到港", "已签收"}
FACTORY_PAYMENT_STATUSES = {"未付款", "部分付款", "已付清"}
CUSTOMS_STATUSES = {"未报关", "已报关", "清关中", "已清关"}


def _changed(key, patch, creating):
    return creating or key in patch


def _required(value, key):
    if not isinstance(value.get(key), str) or not value[key].strip():
        raise ValueError(f"{key} is required")


def _number(value, key, positive=False, integral=False):
    number = value.get(key)
    if type(number) not in (int, float) or not math.isfinite(number) or number < 0 or (positive and number <= 0):
        raise ValueError(f"{key} must be a finite {'positive' if positive else 'nonnegative'} number")
    if integral and number != int(number):
        raise ValueError(f"{key} must be a whole quantity")


def _date(value, key, required=False):
    raw = value.get(key)
    if raw in (None, "") and not required:
        return
    if not isinstance(raw, str):
        raise ValueError(f"{key} must be a YYYY-MM-DD date")
    try:
        parsed = datetime.date.fromisoformat(raw)
        if parsed.isoformat() != raw:
            raise ValueError()
    except ValueError:
        raise ValueError(f"{key} must be a real YYYY-MM-DD date") from None


def _enum(value, key, allowed, patch, creating):
    if _changed(key, patch, creating) and key in value and (not isinstance(value[key], str) or value[key] not in allowed):
        raise ValueError(f"{key} has an unsupported status")


def _hk(company):
    return company.get("jurisdiction") == "HK" or (not company.get("jurisdiction") and company.get("id") in {"CO-GW", "CO-LK"})


def validate_order(value, patch, creating, company):
    """Validate merged order; patch is the fields explicitly supplied by client."""
    for key in ("customerId", "companyOperationNo", "customerOrderNo", "contactPerson", "loadingPort", "paymentTerms"):
        if _changed(key, patch, creating):
            _required(value, key)
    if creating or "orderAmountUSD" in patch:
        _number(value, "orderAmountUSD", positive=True)
    for key in ("orderDate", "expectedShipDate", "actualShipDate"):
        if _changed(key, patch, creating):
            _date(value, key, required=key == "orderDate")
    if _hk(company) and (creating or "overseasPort" in patch or "companyId" in patch):
        _required(value, "overseasPort")
    for key, allowed in (("status", ORDER_STATUSES), ("orderStatus", ORDER_STATUSES), ("paymentStatus", PAYMENT_STATUSES), ("shippingStatus", SHIPPING_STATUSES), ("factoryPaidStatus", FACTORY_PAYMENT_STATUSES)):
        _enum(value, key, allowed, patch, creating)
    for key in ("factoryCostRMB", "freightCostUSD", "insuranceCostUSD", "otherCostUSD", "paidAmountUSD", "factoryPaidRMB", "costPaidUSD"):
        if key in value and _changed(key, patch, creating):
            _number(value, key)
    if "quantity" in value and _changed("quantity", patch, creating):
        _number(value, "quantity", integral=True)
    if _changed("factories", patch, creating) and "factories" in value:
        if not isinstance(value["factories"], list):
            raise ValueError("factories must be a list")
        for factory in value["factories"]:
            if not isinstance(factory, dict):
                raise ValueError("Each factory must be a record")
            for key in ("factoryId", "productType"):
                _required(factory, key)
            _number(factory, "totalQuantity", positive=True, integral=True)
            supplied = next((row for row in patch.get("factories", []) if isinstance(row, dict) and row.get("factoryId") == factory.get("factoryId")), {})
            for key in ("totalAmount", "prepayment"):
                if key in factory and (creating or key in supplied):
                    _number(factory, key)
            if (creating or any(key in supplied for key in ("totalAmount", "prepayment"))) and factory.get("prepayment", 0) > factory.get("totalAmount", 0):
                raise ValueError("Factory prepayment cannot exceed totalAmount")
            _date(factory, "inspectionDate", required=True)
            _date(factory, "estimatedShipDate", required=True)
            if factory["inspectionDate"] > factory["estimatedShipDate"]:
                raise ValueError("Factory inspectionDate cannot follow estimatedShipDate")


def validate_shipment(value, patch, creating, company):
    """Validate dates separately: ETD is a forecast, never an actual milestone."""
    for key in ("orderId", "loadingPort"):
        if _changed(key, patch, creating):
            _required(value, key)
    if _hk(company) and (creating or "overseasPort" in patch or "companyId" in patch):
        _required(value, "overseasPort")
    _enum(value, "status", SHIPPING_STATUSES, patch, creating)
    _enum(value, "customsStatus", CUSTOMS_STATUSES, patch, creating)
    for key in ("etd", "customsDate", "actualShipDate", "arrivalDate", "receivedDate"):
        if _changed(key, patch, creating):
            _date(value, key, required=key == "etd" and creating)
    for key in ("grossWeight", "netWeight", "volume"):
        if key in value and _changed(key, patch, creating):
            _number(value, key)
    if (creating or any(key in patch for key in ("grossWeight", "netWeight"))) and value.get("netWeight", 0) > value.get("grossWeight", 0):
        raise ValueError("netWeight cannot exceed grossWeight")
    if "status" in patch or creating:
        for status, key in (("已出运", "actualShipDate"), ("已到港", "arrivalDate"), ("已签收", "receivedDate")):
            if value.get("status") == status:
                _date(value, key, required=True)
    dates = [value.get(key) for key in ("actualShipDate", "arrivalDate", "receivedDate") if value.get(key)]
    if any(key in patch for key in ("actualShipDate", "arrivalDate", "receivedDate")) and dates != sorted(dates):
        raise ValueError("Actual shipment milestones must be chronological")
