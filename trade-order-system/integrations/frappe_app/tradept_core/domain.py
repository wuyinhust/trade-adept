"""Pure authorization and Grandware rules, reused without the previous store."""
from __future__ import annotations
import copy
import json
import math
import re
from datetime import datetime, timezone
from .schema import COLLECTIONS, dumps
NATIVE_ROLE_PREFIX = "Tradept "
CATALOG_CAPABILITIES = {"catalog.read", "catalog.create", "catalog.write", "catalog.disable"}
FINANCE_CAPABILITIES = {
    *(f"finance.{resource}.{action}" for resource in ("sales_invoice", "purchase_invoice", "payment_entry") for action in ("read", "create", "write", "submit", "cancel", "amend", "return", "print", "export") if resource != "payment_entry" or action != "return"),
    *(f"finance.{resource}.{action}" for resource in ("receivables", "payables", "ledger") for action in ("read", "print", "export")),
    "finance.reconciliation.read", "finance.reconciliation.write", "finance.reconciliation.unreconcile", "finance.bank_accounts.read",
    "finance.payment_entry.deductions",
    "finance.bank_reconciliation.read", "finance.bank_reconciliation.write",
    "finance.bank_reconciliation.print", "finance.bank_reconciliation.export",
    *(f"finance.bank_transaction.{action}" for action in ("read", "create", "write", "submit", "cancel", "print", "export")),
}
DEFAULT_ROLES = {
    "admin": {"scope": "tenant", "permissions": ["read", "create", "edit", "delete", "assign", "finance.read", "finance.write", "rates.write", "snapshots.read", "snapshots.restore", "accounts.configure"], "pages": ["dashboard", "orders", "customers", "factories", "shipping", "profit", "settings", "admin"]},
    "finance": {"scope": "tenant", "permissions": ["read", "create", "edit", "assign", "finance.read", "finance.write", "rates.write"], "pages": ["dashboard", "orders", "customers", "factories", "shipping", "profit", "settings"]},
    "manager": {"scope": "team", "permissions": ["read", "create", "edit", "delete"], "pages": ["dashboard", "orders", "customers", "factories", "shipping"]},
    "salesperson": {"scope": "self", "permissions": ["read", "create", "edit", "delete"], "pages": ["dashboard", "orders", "customers", "factories", "shipping"]},
    "document": {"scope": "self", "permissions": ["read", "create", "edit"], "pages": ["dashboard", "orders", "customers", "factories", "shipping"]},
}
DEFAULT_ROLES = {name: {**policy, "readScopes": {"factories": "entities"}} for name, policy in DEFAULT_ROLES.items()}
# Defaults apply only when provisioning a new workspace. Existing tenant role
# JSON is never merged with these grants during migrations or permission checks.
for _role in ("admin", "finance"):
    DEFAULT_ROLES[_role]["permissions"] += sorted(FINANCE_CAPABILITIES)
    DEFAULT_ROLES[_role]["pages"].append("finance")
    DEFAULT_ROLES[_role]["financePolicy"] = {"scope": "tenant", "paymentLimit": None, "allowedBankAccounts": None}
DEFAULT_ROLES["admin"]["permissions"] += sorted(CATALOG_CAPABILITIES)
HIDDEN_FIELDS = {"factoryCostRMB", "factoryCostUSD", "freightCostUSD", "freightCostRMB", "insuranceCostUSD", "otherCostUSD", "otherCostRMB", "orderAmountRMB", "profitRMB", "profitUSD", "profitRate", "margin", "paidAmountUSD", "paymentStatus", "costPaidUSD", "costPaymentStatus", "bankInfo", "bankAccount", "paidCostRMB", "paidCostUSD", "factoryCostPaid", "factoryPaidRMB", "erpItems", "purchaseRate"}
HIDDEN_FIELDS.update({"salesAdvanceAmountUSD", "salesInvoiceSettledAmountUSD", "salesInvoiceOutstandingAmountUSD", "factoryAdvanceAmount", "factoryInvoiceSettledAmount", "factoryInvoiceOutstandingAmount", "nativeReceiptSummary", "salesInvoiceNames", "factoryInvoiceNames", "nativeSettlementCurrency"})
NESTED_COST = {"totalAmount", "prepayment", "paidAmount", "cost", "costUSD", "costRMB", "paidCostRMB", "paidCostUSD", "costPaidUSD", "paymentStatus", "costPaymentStatus", "purchaseRate"}
NESTED_COST.update({"advanceAmount", "invoiceSettledAmount", "invoiceOutstandingAmount"})
DERIVED = {"profitRMB", "profitUSD", "profitRate", "orderAmountRMB"}
FINANCIAL_INPUT = {"orderAmountUSD", "factoryCostRMB", "factoryCostUSD", "freightCostUSD", "freightCostRMB", "insuranceCostUSD", "otherCostUSD", "otherCostRMB", "factories", "companyId"}

def sensitive(key, nested=False):
    if key == "profitPolicy":
        return False
    lowered = str(key).replace("_", "").lower()
    return key in HIDDEN_FIELDS or (nested and key in NESTED_COST) or lowered.startswith(("profit", "margin", "factorycost", "costpaid", "paidcost", "bank", "paidamount", "costpayment", "paymentstatus", "freightcost", "insurancecost", "othercost", "prepayment")) or (nested and lowered.startswith("cost"))

def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")

def safe_record_id(value):
    return isinstance(value, str) and re.fullmatch(r"[\w.:-]{1,200}", value) is not None

def validate_embedded_ids(value):
    """Legacy UI embeds technical identifiers in inline event attributes."""
    if isinstance(value, dict):
        for key, child in value.items():
            optional_unassigned = key == "factoryId" and child in (None, "")
            if key in ("id", "factoryId") and not optional_unassigned and not safe_record_id(child):
                raise APIError(400, "INVALID_RECORD_ID", "Technical identifiers contain unsafe characters")
            validate_embedded_ids(child)
    elif isinstance(value, list):
        for child in value:
            validate_embedded_ids(child)

class APIError(Exception):
    def __init__(self, status, code, message, **details):
        super().__init__(message)
        self.status, self.code, self.details = status, code, details

    def response(self):
        return {"error": str(self), "code": self.code, **self.details}

class Rules:
    def __init__(self, configuration, profiles, ownership_profiles=None):
        self.configuration, self.profiles = configuration, profiles
        # Historical ownership is not an account grant. Authentication and new
        # assignments continue to use the separate active profile collection.
        self.ownership_profiles = {**(ownership_profiles or {}), **profiles}

    def _policy(self, cfg, actor):
        return cfg.get("roles", {}).get(actor.get("role"), {"scope": "self", "permissions": []})

    def permitted(self, cfg, actor, action, collection=None):
        policy = self._policy(cfg, actor)
        permissions = policy.get("permissions", [])
        allowed = bool(permissions.get(action)) if isinstance(permissions, dict) else action in permissions
        restricted = policy.get("collections")
        return allowed and (not collection or restricted is None or collection in restricted)

    def company_ids(self, cfg, actor):
        known = {str(c["id"]) for c in cfg["companies"]}
        if actor.get("visibleCompanyIds") is not None:
            return known.intersection(map(str, actor["visibleCompanyIds"]))
        team = cfg.get("teams", {}).get(actor.get("teamId"))
        return known.intersection(map(str, team["visibleCompanyIds"])) if team and team.get("visibleCompanyIds") is not None else set()

    def record_allowed(self, db, cfg, actor, record, action="read", collection=None, payload=None):
        if not self.permitted(cfg, actor, action, collection):
            return False
        if record.get("tenantId") not in (None, actor["tenantId"]):
            return False
        policy = self._policy(cfg, actor)
        company = record.get("companyId")
        if company not in self.company_ids(cfg, actor):
            known = {c["id"] for c in cfg["companies"]}
            return company not in known and self.company_ids(cfg, actor) == known and policy.get("scope") == "tenant" and self.permitted(cfg, actor, "accounts.configure") and action in ("read", "edit", "delete")
        if collection in ("shipments", "invoices"):
            parent = next((r for r in (payload or {}).get("orders", []) if str(r.get("id")) == str(record.get("orderId")) and not r.get("deleted")), None)
            return bool(parent and parent.get("companyId") == company and self.record_allowed(db, cfg, actor, parent, "read" if action == "read" else "edit", "orders", payload))
        scope = policy.get("readScopes", {}).get(collection, policy.get("scope")) if action == "read" else policy.get("scope")
        if scope in ("tenant", "entities"):
            return True
        owners = {str(record[k]) for k in ("createdBy", "salespersonId", "ownerId") if record.get(k) is not None}.intersection(self.ownership_profiles)
        if scope == "self":
            return actor["id"] in owners
        return bool(actor.get("teamId") and any(self.ownership_profiles[uid].get("teamId") == actor["teamId"] for uid in owners))

    def visible_record(self, cfg, actor, record):
        value = copy.deepcopy(record)
        if not self.permitted(cfg, actor, "finance.read"):
            def redact(current, nested=False):
                if isinstance(current, dict):
                    return {key: redact(child, True) for key, child in current.items() if not sensitive(key, nested)}
                if isinstance(current, list):
                    return [redact(child, nested) for child in current]
                return current
            value = redact(value)
        return value

    def _prepare_patch(self, db, cfg, actor, collection, old, patch, historical=False, native_order=False, derive_order=True):
        if not isinstance(patch, dict):
            raise APIError(400, "INVALID_PATCH", "Record value must be an object")
        patch = copy.deepcopy(patch)
        validate_embedded_ids(patch)
        if patch.get("tenantId", actor["tenantId"]) != actor["tenantId"]:
            raise APIError(403, "TENANT_DENIED", "Cannot change tenant")
        for key in (("tenantId", "id", "revision") if historical else ("tenantId", "id", "updatedAt", "updatedBy", "revision")):
            patch.pop(key, None)
        if "deleted" in patch or "deletedAt" in patch:
            raise APIError(400, "USE_DELETE_OPERATION", "Use deleted:true change operation")
        for key in ("createdBy", "createdAt"):
            if old and key in patch and patch[key] != old.get(key):
                raise APIError(403, "IMMUTABLE_FIELD", "Cannot change record origin")
        for key in ("profitPolicy", "settlementCurrency"):
            if key in patch and patch[key] != (old or {}).get(key):
                raise APIError(403, "IMMUTABLE_FIELD", "Company financial policy is configured on the server")
        if not self.permitted(cfg, actor, "assign"):
            for key in ("salespersonId", "ownerId", "createdBy"):
                if key in patch and patch[key] not in (actor["id"], (old or {}).get(key), None):
                    raise APIError(403, "ASSIGNMENT_DENIED", "Cannot assign another user's records")
        if not historical:
            for key in ("createdBy", "salespersonId", "ownerId"):
                if key in patch and patch[key] not in (None, "") and patch[key] != (old or {}).get(key) and str(patch[key]) not in self.profiles:
                    raise APIError(403, "ASSIGNMENT_DENIED", "New assignments require an active configured account")
        can_finance = self.permitted(cfg, actor, "finance.write")
        for key in list(patch):
            if sensitive(key):
                if key in DERIVED or key.lower().startswith(("profit", "margin")):
                    # Calculated fields are never client authority.
                    if not can_finance and patch[key] != (old or {}).get(key):
                        raise APIError(403, "FIELD_DENIED", "Financial fields require permission")
                    if not historical:
                        patch.pop(key)
                elif not can_finance and patch[key] != (old or {}).get(key):
                    raise APIError(403, "FIELD_DENIED", "Financial fields require permission")
        if "factories" in patch:
            if not isinstance(patch["factories"], list) or any(not isinstance(f, dict) for f in patch["factories"]):
                raise APIError(400, "INVALID_FACTORIES", "Factory entries must be an array of objects")
            factory_ids = [str(f.get("factoryId") or "").strip() for f in patch["factories"]]
            if any(not rid for rid in factory_ids) or len(set(factory_ids)) != len(factory_ids):
                raise APIError(400, "DUPLICATE_FACTORY_ENTRY", "Factory entries require unique factoryId values; multiple lines need a separate stable detail-ID schema")
            old_entries = (old or {}).get("factories", [])
            if not can_finance:
                old_ids = [str(f.get("factoryId") or "").strip() for f in old_entries]
                if any(not rid for rid in old_ids) or len(set(old_ids)) != len(old_ids):
                    raise APIError(403, "FIELD_DENIED", "Legacy factory lines need a schema-aware financial correction")
                old_by_id = {str(f.get("factoryId")): f for f in old_entries}
                new_ids = {str(f.get("factoryId")) for f in patch["factories"]}
                if any(str(f.get("factoryId")) not in new_ids and self._protected(f) for f in old_entries):
                    raise APIError(403, "FIELD_DENIED", "Cannot remove an entry containing financial amounts")
                for entry in patch["factories"]:
                    prior = old_by_id.get(str(entry.get("factoryId")), {})
                    for key in {k for k in set(entry) | set(prior) if sensitive(k, True)}:
                        if key in entry and entry[key] != prior.get(key):
                            raise APIError(403, "FIELD_DENIED", "Factory financial fields require permission")
                        if key in prior:
                            entry[key] = prior[key]
                    guarded = self._guard_embedded(prior, entry, array_item=True)
                    entry.clear()
                    entry.update(guarded)
        if not can_finance:
            for key in list(patch):
                if key != "factories" and (isinstance(patch[key], (dict, list)) or self._protected((old or {}).get(key))):
                    patch[key] = self._guard_embedded((old or {}).get(key), patch[key])
        value = {**(old or {}), **patch}
        company_id = value.get("companyId")
        if company_id not in self.company_ids(cfg, actor):
            raise APIError(403, "COMPANY_DENIED", "Legal entity is missing, unknown or unauthorized")
        if old is None and not historical:
            value["createdBy"] = actor["id"]
            value["createdAt"] = now()
            value.setdefault("salespersonId", actor["id"])
            if collection == "orders":
                value.setdefault("paidAmountUSD", 0)
                value.setdefault("paymentStatus", "未收款")
                value.setdefault("factoryPaidRMB", 0)
                value.setdefault("factoryPaidStatus", "未付款")
        value["tenantId"] = actor["tenantId"]
        if not historical:
            value["updatedBy"] = actor["id"]
            value["updatedAt"] = now()
        else:
            value["importedBy"] = actor["id"]
            value["importedAt"] = now()
        if collection == "orders":
            if historical:
                number = value.get("companyOperationNo")
                if not isinstance(number, str) or not number.strip():
                    raise APIError(400, "ORDER_NUMBER_REQUIRED", "Company operation number is required")
                value["companyOperationNo"] = number.strip()
            else:
                self._validate_order(value)
                if not native_order:
                    self._prepare_quote_aliases(cfg, old, value, patch)
            raw_changed = self._financial_changed(old, value)
            # A public nested-array edit that preserves all costs does not
            # rewrite historical derived amounts under a different formula.
            if raw_changed and not historical and not native_order and derive_order:
                self._derive_order(cfg, value)
        return value

    @staticmethod
    def _protected(value):
        if isinstance(value, dict):
            return any(sensitive(k, True) or Rules._protected(v) for k, v in value.items())
        if isinstance(value, list):
            return any(Rules._protected(v) for v in value)
        return False

    def _guard_embedded(self, prior, supplied, array_item=False):
        """Prevent hiding protected changes inside otherwise public objects."""
        if isinstance(prior, (dict, list)) and self._protected(prior) and type(prior) is not type(supplied):
            raise APIError(403, "FIELD_DENIED", "Cannot replace a container holding protected data")
        if isinstance(supplied, dict):
            old = prior if isinstance(prior, dict) else {}
            result = {k: copy.deepcopy(v) for k, v in old.items() if not array_item or sensitive(k, True) or self._protected(v)}
            for key, value in supplied.items():
                if sensitive(key, True) and value != old.get(key):
                    raise APIError(403, "FIELD_DENIED", "Embedded financial fields require permission")
                result[key] = self._guard_embedded(old.get(key), value)
            return result
        if isinstance(supplied, list):
            old = prior if isinstance(prior, list) else []
            # Unknown protected array schemas cannot safely be matched by
            # index. factories has an explicit unique factoryId path above.
            if self._protected(old) and old != supplied:
                raise APIError(403, "FIELD_DENIED", "Protected arrays require a schema-aware financial editor")
            return [self._guard_embedded(old[index] if index < len(old) else None, value, array_item=True) for index, value in enumerate(supplied)]
        return supplied

    @staticmethod
    def _financial_changed(old, value):
        if old is None:
            return True
        if any(value.get(key) != old.get(key) for key in FINANCIAL_INPUT - {"factories"}):
            return True
        def amounts(record):
            return {str(entry.get("factoryId")): {k: entry.get(k) for k in NESTED_COST} for entry in record.get("factories", [])}
        return amounts(old) != amounts(value)

    @staticmethod
    def _validate_order(order):
        number = order.get("companyOperationNo")
        if not isinstance(number, str) or not number.strip():
            raise APIError(400, "ORDER_NUMBER_REQUIRED", "Company operation number is required")
        order["companyOperationNo"] = number.strip()
        for key in ("orderAmountUSD", "factoryCostRMB", "factoryCostUSD", "freightCostUSD", "freightCostRMB", "insuranceCostUSD", "otherCostUSD", "otherCostRMB", "paidAmountUSD", "costPaidUSD"):
            if key in order:
                value = order[key]
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise APIError(400, "INVALID_AMOUNT", "Amounts must be finite, nonnegative numbers")

    @staticmethod
    def _quote_alias_pairs(company):
        """Return aliases for the existing policy's input units, not a new formula."""
        currency = company.get("settlementCurrency", "CNY" if company.get("profitPolicy") == "grandware-v40" else "USD")
        if currency == "USD":
            # Grandware's old factoryCostRMB column holds USD for HK entities.
            return (("factoryCostUSD", "factoryCostRMB"),)
        if currency == "CNY":
            return (("freightCostRMB", "freightCostUSD"), ("otherCostRMB", "otherCostUSD"))
        return ()

    @staticmethod
    def _prepare_quote_aliases(cfg, old, value, patch):
        company = next(c for c in cfg["companies"] if c["id"] == value["companyId"])
        pairs = Rules._quote_alias_pairs(company)
        applicable = {alias for alias, _ in pairs}
        for alias in {"factoryCostUSD", "freightCostRMB", "otherCostRMB"} - applicable:
            if alias in patch and (old is None or patch[alias] != old.get(alias)):
                raise APIError(400, "UNSUPPORTED_AMOUNT_CURRENCY", "This amount field does not apply to the company's quote currency", field=alias)
        for alias, legacy in pairs:
            # A full form may repeat the untouched partner. Only actual changes
            # choose authority; an old stored alias must never shadow an edit.
            changed = {key for key in (alias, legacy) if key in patch and (old is None or patch[key] != old.get(key))}
            if changed == {alias}:
                value.pop(legacy, None)
            elif changed == {legacy}:
                value.pop(alias, None)

    @staticmethod
    def _quote_alias_values(company, order, conversion=1):
        """Normalize aliases with the conversion already used by the quote."""
        result = {}
        for alias, legacy in Rules._quote_alias_pairs(company):
            if alias not in order and legacy not in order:
                continue
            # Generic CNY fees use USD in the legacy columns; Grandware v40
            # domestic fees already use RMB despite their USD column suffix.
            multiplier = conversion if company.get("profitPolicy") == "generic-native" and company.get("settlementCurrency") == "CNY" else 1
            if alias in order:
                amount = order[alias] / multiplier
                if legacy in order and not math.isclose(amount, order[legacy], rel_tol=1e-9, abs_tol=1e-9):
                    raise APIError(400, "FINANCIAL_ALIAS_CONFLICT", "Equivalent amount fields contain different values", fields=[alias, legacy])
            else:
                amount = order[legacy]
            result[legacy] = amount
            result[alias] = amount * multiplier
        return result

    def _validate_links(self, db, cfg, actor, payload, collection, value, patch, creating, prior=None):
        if collection != "orders":
            return
        references = []
        changing_entity = creating or "companyId" in patch
        if changing_entity or "customerId" in patch:
            if not value.get("customerId"):
                raise APIError(400, "CUSTOMER_REQUIRED", "An order requires a customer")
            if changing_entity or value["customerId"] != (prior or {}).get("customerId"):
                references.append(("customers", value["customerId"]))
        if changing_entity or any(key in patch for key in ("factoryId", "factoryIds", "factories", "erpItems")):
            factory_ids = set(map(str, value.get("factoryIds", [])))
            if value.get("factoryId"):
                factory_ids.add(str(value["factoryId"]))
            factory_ids.update(str(f["factoryId"]) for f in value.get("factories", []) if f.get("factoryId"))
            if "erpItems" in value:
                if not isinstance(value["erpItems"], list) or any(not isinstance(f, dict) or not f.get("factoryId") for f in value["erpItems"]):
                    raise APIError(400, "INVALID_ERP_ITEMS", "ERP item mappings need explicit supplier references")
                factory_ids.update(str(f["factoryId"]) for f in value["erpItems"])
            previous = prior or {}
            previous_ids = set(map(str, previous.get("factoryIds", [])))
            if previous.get("factoryId"):
                previous_ids.add(str(previous["factoryId"]))
            previous_ids.update(str(f["factoryId"]) for f in previous.get("factories", []) if f.get("factoryId"))
            # Imported Grandware orders can retain historical cross-entity
            # suppliers. Public quantity/date edits preserve that reference;
            # adding a supplier, moving an entity or ERP mapping stays strict.
            strict_erp_ids = {str(f["factoryId"]) for f in value.get("erpItems", [])} if changing_entity or "erpItems" in patch else set()
            references.extend(("factories", rid) for rid in factory_ids if changing_entity or rid not in previous_ids or rid in strict_erp_ids)
        for target, rid in references:
            related = next((r for r in payload[target] if str(r["id"]) == str(rid) and not r.get("deleted")), None)
            if not related or related.get("companyId") != value.get("companyId") or related.get("companyId") not in self.company_ids(cfg, actor) or not self.record_allowed(db, cfg, actor, related, collection=target):
                raise APIError(403, "RELATED_RECORD_DENIED", "Referenced record is missing or unauthorized")

    @staticmethod
    def _derive_order(cfg, order, rates=None):
        company = next(c for c in cfg["companies"] if c["id"] == order["companyId"])
        policy = company.get("profitPolicy")
        if policy == "generic-native":
            currency = company.get("settlementCurrency", "USD")
            rate = (rates or {}).get(company["id"], company.get("exchangeRate"))
            if currency == "CNY" and (type(rate) not in (float, int) or not math.isfinite(rate) or rate <= 0):
                raise APIError(400, "RATE_REQUIRED", "Configure a current currency rate before quoting this legal entity")
            if currency not in ("CNY", "USD"):
                raise APIError(400, "UNSUPPORTED_CURRENCY", "Quote currency requires an explicit conversion policy")
            conversion = rate if currency == "CNY" else 1
            aliases = Rules._quote_alias_values(company, order, conversion)
            inputs = {**order, **aliases}
            if currency == "CNY":
                # Keep one authoritative currency for generic fees. Persisting
                # a converted shadow would conflict at a later quote rate or
                # silently revalue a fixed RMB expense.
                for alias, legacy in Rules._quote_alias_pairs(company):
                    if alias in order:
                        order.pop(legacy, None)
            else:
                order.update(aliases)
            revenue = inputs.get("orderAmountUSD", 0) * conversion
            cost = inputs.get("factoryCostRMB", 0)
            expenses = sum(inputs.get(key, 0) or 0 for key in ("freightCostUSD", "insuranceCostUSD", "otherCostUSD")) * conversion
            profit = revenue - cost - expenses
            order.update(orderAmountRMB=round(revenue, 2), profitRMB=round(profit, 2), profitRate=round(profit / revenue * 100, 2) if revenue else 0, profitPolicy=policy, settlementCurrency=currency)
            return
        if policy != "grandware-v40":
            raise APIError(400, "UNKNOWN_PROFIT_POLICY", "Configure a supported company profit policy before editing financial inputs")
        order.update(Rules._quote_alias_values(company, order))
        amount = order.get("orderAmountUSD", 0)
        cost = order.get("factoryCostRMB", 0)
        rate = (rates or {}).get(company["id"], company.get("exchangeRate", 7.25))
        currency = company.get("settlementCurrency", "CNY")
        if currency == "CNY":
            revenue = amount * rate
            profit = revenue - cost - order.get("freightCostUSD", 0) - order.get("otherCostUSD", 0) + cost / 1.13 * order.get("insuranceCostUSD", 0) / 100
        elif currency == "USD":
            revenue = amount
            profit = amount - cost - order.get("otherCostUSD", 0)
        else:
            raise APIError(400, "UNSUPPORTED_CURRENCY", "Settlement currency policy is unsupported")
        order["orderAmountRMB"] = round(revenue, 2)
        order["profitRMB"] = round(profit, 2)
        order["profitRate"] = round(profit / revenue * 100, 2) if revenue else 0
        order["profitPolicy"] = policy
        order["settlementCurrency"] = currency

    @staticmethod
    def _unique_order_numbers(payload):
        seen = set()
        for order in payload.get("orders", []):
            number = order.get("companyOperationNo")
            if not isinstance(number, str) or not number.strip():
                continue  # Quarantined legacy imports remain inspectable by admin.
            key = (order.get("companyId"), number.strip().casefold())
            if key in seen:
                raise APIError(409, "DUPLICATE_ORDER_NUMBER", "Company operation number already exists, including archived orders")
            seen.add(key)
