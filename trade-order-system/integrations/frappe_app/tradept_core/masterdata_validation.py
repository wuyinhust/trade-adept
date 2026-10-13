"""Pure checks for customer/supplier input, retaining incomplete historical rows.

Call after authorization and merging an update with its current record. Do not
call for a deletion. This module never normalizes or mutates input strings.
"""
from __future__ import annotations

import math
import re


CONTACT_FIELDS = ("name", "position", "email", "phone", "mobilePhone", "homeAddress")
CONTACT_REQUIRED = {
    "name": "姓名", "position": "职位", "email": "邮箱",
    "phone": "电话", "mobilePhone": "手机号码",
}
CUSTOMER_FIELDS = {
    "company": "公司名称", "companyName": "公司名称", "companyAddress": "公司地址",
    "country": "国家", "position": "职位", "contact": "联系人",
    "email": "邮箱", "phone": "电话", "mobilePhone": "手机号码",
    "homeAddress": "家庭地址", "paymentTerms": "付款条件",
}
FACTORY_FIELDS = {
    "name": "工厂名称", "contact": "工厂联系人", "phone": "工厂电话",
    "mobilePhone": "工厂手机号码", "products": "产品类型",
    "productType": "产品类型", "address": "工厂地址", "bankInfo": "银行信息",
}


def _changed(row, current, key):
    return key in row and (current is None or row[key] != current.get(key))


def _text(value, label, required=False):
    if value is None and not required:
        return
    if not isinstance(value, str):
        raise ValueError(f"{label}须填写文字")
    if required and not value.strip():
        raise ValueError(f"请填写{label}")


def _identifier(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("联系人编号须为有效文字或数字")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError("联系人编号须为有限整数或文字")
        value = int(value)
    result = str(value)
    if not re.fullmatch(r"[\w.:-]{1,200}", result):
        raise ValueError("联系人编号为空或包含不支持的字符")
    return result


def _contact_values(contact):
    return tuple(contact.get(key) for key in CONTACT_FIELDS)


def _contacts(value, current):
    if not isinstance(value, list) or not value:
        raise ValueError("客户至少需要一位联系人")
    old_rows = current if isinstance(current, list) else []
    old_by_id = {}
    for contact in old_rows:
        if isinstance(contact, dict) and contact.get("id") not in (None, ""):
            try:
                old_by_id.setdefault(_identifier(contact["id"]), []).append(contact)
            except ValueError:
                pass  # Old malformed identities must not be rewritten on a read.
    used_old, ids = set(), set()
    for index, contact in enumerate(value, 1):
        if not isinstance(contact, dict):
            raise ValueError(f"第{index}位联系人资料须为对象")
        identifier = _identifier(contact["id"]) if contact.get("id") not in (None, "") else None
        if identifier is not None:
            if identifier in ids:
                raise ValueError("联系人编号重复，请分别核对每位联系人")
            ids.add(identifier)
        candidates = old_by_id.get(identifier, []) if identifier is not None else []
        prior = candidates[0] if len(candidates) == 1 else None
        if prior is not None and id(prior) in used_old:
            prior = None
        # Assigning an ID to an otherwise unchanged old row is metadata only.
        # Match its full values, never a name shared by different people.
        if prior is None:
            for old in old_rows:
                if isinstance(old, dict) and id(old) not in used_old and old.get("id") in (None, "") and _contact_values(old) == _contact_values(contact):
                    prior = old
                    break
        if prior is not None:
            used_old.add(id(prior))
        unchanged = prior is not None and _contact_values(prior) == _contact_values(contact)
        if unchanged:
            continue
        if identifier is None:
            raise ValueError(f"第{index}位联系人需要稳定的联系人编号")
        for key, label in CONTACT_REQUIRED.items():
            _text(contact.get(key), f"第{index}位联系人的{label}", required=True)
        _text(contact.get("homeAddress"), f"第{index}位联系人的家庭地址")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", contact["email"].strip()):
            raise ValueError(f"第{index}位联系人的邮箱格式不正确")


def validate_masterdata(collection, row, current=None):
    """Validate a new/merged row; unchanged historical omissions stay unchanged.

    Customer authority is ``company``; ``companyName`` is an explicit alias.
    ``companyId`` is a legal-entity reference and can never replace that name.
    Products may use the current ``products`` or historical ``productType``.
    New/changed contacts require complete channels and stable unique IDs; old
    incomplete contacts may survive unchanged, including metadata-only ID fill.
    """
    if collection not in ("customers", "factories"):
        raise ValueError("仅支持校验客户或工厂资料")
    if not isinstance(row, dict) or current is not None and not isinstance(current, dict):
        raise ValueError("客户或工厂资料须为对象")
    labels = CUSTOMER_FIELDS if collection == "customers" else FACTORY_FIELDS
    for key, label in labels.items():
        if _changed(row, current, key):
            _text(row[key], label)
    if collection == "customers":
        names_changed = current is None or any(_changed(row, current, key) for key in ("company", "companyName"))
        if names_changed:
            company, alias = row.get("company"), row.get("companyName")
            if isinstance(company, str) and company.strip() and isinstance(alias, str) and alias.strip() and company != alias:
                raise ValueError("公司名称字段不一致，请核对公司名称")
            _text(company if isinstance(company, str) and company.strip() else alias, "客户公司名称", required=True)
        if current is None or _changed(row, current, "companyAddress"):
            _text(row.get("companyAddress"), "客户公司地址", required=True)
        if current is None or _changed(row, current, "contacts"):
            _contacts(row.get("contacts"), (current or {}).get("contacts"))
    else:
        for key in ("name", "contact", "phone", "mobilePhone", "address"):
            if current is None or _changed(row, current, key):
                _text(row.get(key), labels[key], required=True)
        if current is None or any(_changed(row, current, key) for key in ("products", "productType")):
            products, alias = row.get("products"), row.get("productType")
            _text(products if isinstance(products, str) and products.strip() else alias, "工厂产品类型", required=True)
