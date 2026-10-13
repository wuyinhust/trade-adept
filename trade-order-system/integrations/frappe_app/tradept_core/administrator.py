"""Tradept administrator surface backed by native Frappe records.

The browser never receives native administrator credentials or mailbox
passwords. Every mutation is authorized by the configured Tradept role and is
committed in the same Frappe transaction as its audit/revision record.
"""
from __future__ import annotations

import copy
import re
import uuid

import frappe

from .domain import APIError, DEFAULT_ROLES, now, safe_record_id
from .schema import COLLECTIONS, dumps, loads
from . import repository as repo


MANAGE_CAPABILITY = "accounts.configure"
ROLE_SCOPES = {"self", "team", "tenant"}
ROLE_PERMISSIONS = {
    "read", "create", "edit", "delete", "assign",
    "finance.read", "finance.write", "rates.write",
    "snapshots.read", "snapshots.restore", MANAGE_CAPABILITY,
}
ROLE_PAGES = {"dashboard", "orders", "customers", "factories", "shipping", "profit", "settings", "admin"}
ROLE_LABELS = {
    "admin": "企业管理员", "finance": "财务", "manager": "业务经理",
    "salesperson": "业务员", "document": "物流单证",
}
ONBOARDING_STEPS = ("enterprise", "company", "organization", "members", "business", "finish")


def _text(value, label, maximum=200, required=True):
    if value is None:
        value = ""
    value = str(value).strip()
    if required and not value:
        raise APIError(400, "ADMIN_VALIDATION", f"{label}不能为空")
    if len(value) > maximum:
        raise APIError(400, "ADMIN_VALIDATION", f"{label}不能超过 {maximum} 个字符")
    return value


def _list(value, label):
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise APIError(400, "ADMIN_VALIDATION", f"{label}必须是文本列表")
    return list(dict.fromkeys(item.strip() for item in value if item.strip()))


def _port(value, label):
    if value in (None, ""):
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise APIError(400, "ADMIN_VALIDATION", f"{label}必须是有效端口") from None
    if not 1 <= value <= 65535:
        raise APIError(400, "ADMIN_VALIDATION", f"{label}必须在 1 到 65535 之间")
    return value


def _creating(value, existing, label):
    if value.get("create") is True and existing:
        raise APIError(409, "ADMIN_DUPLICATE", f"{label}已存在，请打开现有记录编辑")


def _manage(cfg, actor, rules):
    if not rules.permitted(cfg, actor, MANAGE_CAPABILITY) or rules._policy(cfg, actor).get("scope") != "tenant":
        raise APIError(403, "ADMIN_DENIED", "当前账号没有企业管理权限")


def _expected(work, supplied):
    expected = supplied.get("expectedVersion")
    if type(expected) is not int or expected < 0:
        raise APIError(400, "EXPECTED_VERSION_REQUIRED", "管理操作需要当前数据版本")
    current = int(work.revision or 0)
    if current != expected:
        raise APIError(409, "VERSION_CONFLICT", "其他人已更新企业配置，请刷新后重试", latestVersion=current)


def _company_ids(cfg, value):
    known = {str(item["id"]) for item in cfg.get("companies", [])}
    result = _list(value, "可访问公司")
    if any(item not in known for item in result):
        raise APIError(400, "UNKNOWN_COMPANY", "可访问公司中包含未知公司")
    return result


def _company_details(company):
    """Use the existing native identity when editing legal entities."""
    item = copy.deepcopy(company)
    native_name = repo.native_company(item["id"]) or item.get("nativeCompanyName")
    native = frappe.db.get_value("Company", native_name, ["company_name", "country", "default_currency"], as_dict=True) if native_name else {}
    native = native if isinstance(native, dict) else {}
    item["name"] = native.get("company_name") or item.get("name")
    item["country"] = native.get("country") or item.get("country") or {"CN": "China", "HK": "Hong Kong", "US": "United States"}.get(item.get("jurisdiction"), "United States")
    if native_name:
        item["nativeCompanyName"] = native_name
    return item


def _role_permissions(value):
    values = _list(value, "角色权限")
    if any(item not in ROLE_PERMISSIONS for item in values):
        raise APIError(400, "UNKNOWN_PERMISSION", "角色包含未知权限")
    return values


def _role_pages(value):
    values = _list(value, "可见页面")
    if any(item not in ROLE_PAGES for item in values):
        raise APIError(400, "UNKNOWN_PAGE", "角色包含未知页面")
    return values


def _native_role(key):
    return "Tradept " + key.title()


def _email_for_profile(profile):
    return profile.get("nativeUser") or profile.get("email")


def _configured_profiles():
    """Load enabled and disabled members for administration screens."""
    result = {}
    for row in frappe.get_all("Trade User Profile", fields=["user", "profile"]):
        profile = loads(row.profile, {})
        if profile.get("id"):
            result[profile["id"]] = {**profile, "nativeUser": row.user}
    return result


def _grant_company_to_creator(actor, company_id):
    native_user = actor.get("nativeUser")
    native_company = repo.native_company(company_id)
    if not native_user or not native_company:
        raise APIError(409, "COMPANY_GRANT_FAILED", "无法为当前管理员建立新公司的访问权限")
    filters = {"user": native_user, "allow": "Company", "for_value": native_company}
    if not frappe.db.exists("User Permission", filters):
        frappe.get_doc({
            "doctype": "User Permission", **filters, "apply_to_all_doctypes": 1,
        }).insert(ignore_permissions=True)
    profile = copy.deepcopy(repo.profiles().get(actor.get("id")) or actor)
    profile.pop("nativeUser", None)
    grants = list(dict.fromkeys([*(profile.get("visibleCompanyIds") or []), company_id]))
    profile["visibleCompanyIds"] = grants
    name = frappe.db.get_value("Trade User Profile", {"user": native_user}, "name")
    if not name:
        raise APIError(409, "COMPANY_GRANT_FAILED", "当前管理员缺少企业成员资料")
    metadata = frappe.get_doc("Trade User Profile", name)
    metadata.profile = dumps(profile)
    metadata.save(ignore_permissions=True)


def _onboarding(cfg, profiles):
    configured = copy.deepcopy(cfg.get("onboarding") or {})
    legacy_ready = bool(cfg.get("companies")) and not configured
    completed = set(configured.get("completedSteps", []))
    checks = {
        "enterprise": bool(str(cfg.get("name") or "").strip()),
        "company": bool(cfg.get("companies")),
        "organization": bool(cfg.get("roles")),
        "members": bool(profiles),
        "business": bool(configured.get("businessPrepared")),
    }
    if legacy_ready:
        completed.update(ONBOARDING_STEPS)
    required_ready = all(checks[key] for key in ("enterprise", "company", "organization", "members"))
    status = configured.get("status") or ("complete" if legacy_ready else "required")
    if status == "complete" and not required_ready:
        status = "in_progress"
    return {
        "status": status,
        "currentStep": configured.get("currentStep") or next((key for key in ONBOARDING_STEPS if key not in completed), "finish"),
        "completedSteps": [key for key in ONBOARDING_STEPS if key in completed],
        "checks": checks,
        "requiredReady": required_ready,
        "updatedAt": configured.get("updatedAt"),
    }


def onboarding_state(cfg, profiles):
    """Return the safe onboarding summary used by authenticated sessions."""
    return _onboarding(cfg, profiles)


def _members(cfg, profiles):
    output = []
    for profile in profiles.values():
        native = _email_for_profile(profile)
        output.append({
            **{key: profile.get(key) for key in ("id", "name", "username", "role", "teamId", "departmentId", "visibleCompanyIds")},
            "email": native,
            "enabled": bool(frappe.db.get_value("User", native, "enabled")) if native else False,
        })
    return sorted(output, key=lambda value: (str(value.get("name") or ""), str(value.get("id") or "")))


def _mailboxes(cfg):
    if not frappe.db.exists("DocType", "Email Account"):
        return []
    meta = frappe.get_meta("Email Account")
    candidates = {
        "email_id": "emailId", "email_account_name": "label", "service": "service", "login_id": "loginId",
        "enable_incoming": "enableIncoming", "enable_outgoing": "enableOutgoing",
        "default_incoming": "defaultIncoming", "default_outgoing": "defaultOutgoing",
        "email_server": "incomingServer", "smtp_server": "smtpServer",
        "incoming_port": "incomingPort", "smtp_port": "smtpPort",
        "use_imap": "useImap", "use_ssl": "useSsl", "use_starttls": "useStarttls",
        "use_tls": "useTls", "use_ssl_for_outgoing": "useSslForOutgoing",
        "awaiting_password": "awaitingPassword",
    }
    fields = ["name", "modified"] + [field for field in candidates if meta.has_field(field)]
    allowed = cfg.get("emailAccounts", {})
    rows = []
    for native in frappe.get_all("Email Account", fields=fields, order_by="modified desc"):
        row = {"id": native.name, "modified": str(native.modified)}
        for field, public in candidates.items():
            if meta.has_field(field):
                row[public] = native.get(field)
        row["allowedUserIds"] = list(allowed.get(native.name, {}).get("allowedUserIds", []))
        rows.append(row)
    return rows


def _roles(cfg):
    result = []
    for key, configured in cfg.get("roles", {}).items():
        policy = copy.deepcopy(configured)
        permissions = policy.get("permissions", [])
        if isinstance(permissions, dict):
            permissions = [name for name, allowed in permissions.items() if allowed]
        pages = list(policy.get("pages", []))
        if MANAGE_CAPABILITY in permissions and "admin" not in pages:
            pages.append("admin")
        policy.update(permissions=permissions, pages=pages)
        result.append({"key": key, "label": policy.get("label") or ROLE_LABELS.get(key, key), **policy})
    return result


def state(work, cfg, actor, rules, profiles):
    _manage(cfg, actor, rules)
    onboarding = _onboarding(cfg, profiles)
    configured_profiles = _configured_profiles()
    departments = list((cfg.get("departments") or cfg.get("teams") or {}).values())
    return {
        "meta": repo.meta(work),
        "enterprise": {
            "id": cfg.get("id"), "name": cfg.get("name"),
            "language": cfg.get("language", "zh-CN"), "timezone": cfg.get("timezone", "Asia/Shanghai"),
            "branding": copy.deepcopy(cfg.get("branding", {})),
        },
        "companies": [_company_details(company) for company in cfg.get("companies", [])],
        "departments": copy.deepcopy(departments),
        "members": _members(cfg, configured_profiles),
        "roles": _roles(cfg),
        "emailAccounts": _mailboxes(cfg),
        "onboarding": onboarding,
        "options": {
            "permissions": sorted(ROLE_PERMISSIONS), "pages": sorted(ROLE_PAGES),
            "collections": list(COLLECTIONS),
            "scopes": sorted(ROLE_SCOPES), "emailAvailable": bool(frappe.db.exists("DocType", "Email Account")),
        },
    }


def _save(work, cfg, actor, kind, summary):
    work.configuration = dumps(cfg)
    work.save(ignore_permissions=True)
    return repo.finish(work, actor, "administrator:" + kind, summary)


def _enterprise(cfg, value):
    cfg["name"] = _text(value.get("name"), "企业名称")
    cfg["language"] = _text(value.get("language", cfg.get("language", "zh-CN")), "语言", 20)
    cfg["timezone"] = _text(value.get("timezone", cfg.get("timezone", "Asia/Shanghai")), "时区", 80)
    branding = copy.deepcopy(cfg.get("branding", {}))
    for key in ("displayName", "welcomeText", "logoUrl"):
        if key in value:
            branding[key] = _text(value.get(key), key, 500, required=False)
    cfg["branding"] = branding
    return {"id": cfg["id"], "name": cfg["name"]}


def _company(cfg, actor, value):
    company_id = _text(value.get("id"), "公司编号", 80)
    if not safe_record_id(company_id):
        raise APIError(400, "INVALID_COMPANY_ID", "公司编号只能使用字母、数字、横线、下划线、点或冒号")
    companies = cfg.setdefault("companies", [])
    existing = next((item for item in companies if str(item.get("id")) == company_id), None)
    _creating(value, existing, "公司编号")
    details = _company_details(existing) if existing else {}
    supplied = {
        **(copy.deepcopy(existing) if existing else {}),
        "id": company_id,
        "name": _text(value.get("name", details.get("name")), "公司名称"),
        "country": _text(value.get("country", details.get("country", "China")), "国家", 100),
        "jurisdiction": _text(value.get("jurisdiction", (existing or {}).get("jurisdiction", "CN")), "法域", 20),
        "settlementCurrency": _text(value.get("settlementCurrency", (existing or {}).get("settlementCurrency", "CNY")), "本位币", 10).upper(),
        "orderPrefix": _text(value.get("orderPrefix", (existing or {}).get("orderPrefix", company_id)), "订单前缀", 20),
        "profitPolicy": _text(value.get("profitPolicy", (existing or {}).get("profitPolicy", "generic-native")), "利润策略", 80),
    }
    if not re.fullmatch(r"[A-Z]{3}", supplied["settlementCurrency"]):
        raise APIError(400, "INVALID_CURRENCY", "本位币必须使用三位大写币种代码")
    normalized_prefix = supplied["orderPrefix"].casefold()
    if any(item is not existing and str(item.get("orderPrefix") or "").casefold() == normalized_prefix for item in companies):
        raise APIError(409, "DUPLICATE_ORDER_PREFIX", "订单前缀已被其他公司使用")
    if existing:
        if supplied["name"] != details.get("name"):
            raise APIError(409, "COMPANY_NAME_LOCKED", "公司主体名称建立后固定；当前页面可修改订单前缀")
        if supplied["country"] != details.get("country") or supplied["jurisdiction"] != existing.get("jurisdiction", "CN"):
            raise APIError(409, "COMPANY_JURISDICTION_LOCKED", "公司的国家或地区和法域建立后固定；当前页面可修改订单前缀")
        if existing.get("settlementCurrency") and supplied["settlementCurrency"] != existing["settlementCurrency"]:
            raise APIError(409, "COMPANY_CURRENCY_LOCKED", "已建立的公司不能直接修改本位币")
        existing.clear()
        existing.update(supplied)
    else:
        supplied["country"] = {"CN": "China", "HK": "Hong Kong", "US": "United States"}.get(supplied["jurisdiction"], supplied["country"])
        companies.append(supplied)
    from .migration import _company as configure_native_company
    native = configure_native_company(supplied)
    supplied["nativeCompanyName"] = native.name
    if existing:
        existing["nativeCompanyName"] = native.name
    if not existing:
        _grant_company_to_creator(actor, company_id)
    return copy.deepcopy(supplied)


def _department(cfg, value):
    key = _text(value.get("id"), "部门编号", 80)
    if not safe_record_id(key):
        raise APIError(400, "INVALID_DEPARTMENT_ID", "部门编号格式无效")
    departments = cfg.get("departments")
    if not isinstance(departments, dict):
        departments = copy.deepcopy(cfg.get("teams") or {})
        cfg["departments"] = departments
    current = copy.deepcopy(departments.get(key, {}))
    _creating(value, current, "部门编号")
    parent = _text(value.get("parentId", current.get("parentId", "")), "上级部门", 80, required=False)
    if parent == key or (parent and parent not in departments):
        raise APIError(400, "INVALID_DEPARTMENT_PARENT", "请选择有效的上级部门")
    seen = {key}
    cursor = parent
    while cursor:
        if cursor in seen:
            raise APIError(400, "DEPARTMENT_CYCLE", "部门层级不能形成循环")
        seen.add(cursor)
        cursor = departments.get(cursor, {}).get("parentId")
    item = {
        **current, "id": key, "name": _text(value.get("name"), "部门名称"), "parentId": parent or None,
        "managerId": _text(value.get("managerId", current.get("managerId", "")), "负责人", 100, required=False) or None,
        "memberIds": _list(value.get("memberIds", current.get("memberIds", [])), "部门成员"),
        "visibleCompanyIds": _company_ids(cfg, value.get("visibleCompanyIds", current.get("visibleCompanyIds", []))),
    }
    profiles = _configured_profiles()
    assigned = set(item["memberIds"] + ([item["managerId"]] if item["managerId"] else []))
    if not assigned.issubset(profiles):
        raise APIError(400, "UNKNOWN_MEMBER", "部门成员或负责人中包含未知成员")
    if parent and not set(item["visibleCompanyIds"]).issubset(departments[parent].get("visibleCompanyIds", [])):
        raise APIError(400, "DEPARTMENT_COMPANY_MISMATCH", "子部门的公司范围必须包含在上级部门范围内")
    for child in departments.values():
        if child.get("parentId") == key and not set(child.get("visibleCompanyIds", [])).issubset(item["visibleCompanyIds"]):
            raise APIError(409, "DEPARTMENT_HAS_CHILDREN", "请先调整子部门的公司范围，再缩小上级部门范围")
    departments[key] = item
    cfg["teams"] = copy.deepcopy(departments)
    if frappe.db.exists("DocType", "Department"):
        meta = frappe.get_meta("Department")
        root = frappe.db.get_value("Department", {"parent_department": ("is", "not set")}, "name")
        native_names = copy.deepcopy(current.get("nativeNames") or {})
        for index, company_id in enumerate(item["visibleCompanyIds"]):
            native_company = repo.native_company(company_id)
            native_name = native_names.get(company_id)
            if index == 0 and not native_name and (current.get("visibleCompanyIds") or [company_id])[0] == company_id:
                native_name = current.get("nativeName")
            if not native_name:
                native_name = frappe.db.get_value("Department", {"department_name": item["name"], "company": native_company}, "name")
            native = frappe.get_doc("Department", native_name) if native_name and frappe.db.exists("Department", native_name) else frappe.new_doc("Department")
            parent_item = departments.get(parent, {}) if parent else {}
            native_parent = (parent_item.get("nativeNames") or {}).get(company_id)
            if not native_parent and (parent_item.get("visibleCompanyIds") or [None])[0] == company_id:
                native_parent = parent_item.get("nativeName")
            mapping = {
                "department_name": item["name"], "company": native_company,
                "parent_department": native_parent or root,
                "is_group": int(any(child.get("parentId") == key for child in departments.values()) or bool(native.get("is_group"))),
                "disabled": 0,
            }
            if parent and not native_parent:
                raise APIError(409, "DEPARTMENT_PARENT_NOT_NATIVE", "请先保存上级部门，建立对应公司的原生部门")
            if native_parent and not frappe.db.get_value("Department", native_parent, "is_group"):
                native_parent_doc = frappe.get_doc("Department", native_parent)
                native_parent_doc.is_group = 1
                native_parent_doc.save(ignore_permissions=True)
            for field, field_value in mapping.items():
                if meta.has_field(field):
                    native.set(field, field_value)
            native.save(ignore_permissions=True)
            native_names[company_id] = native.name
        for company_id in set(native_names) - set(item["visibleCompanyIds"]):
            if meta.has_field("disabled") and frappe.db.exists("Department", native_names[company_id]):
                native = frappe.get_doc("Department", native_names[company_id])
                native.disabled = 1
                native.save(ignore_permissions=True)
        item["nativeNames"] = native_names
        item["nativeName"] = native_names[item["visibleCompanyIds"][0]] if item["visibleCompanyIds"] else None
        cfg["teams"][key] = copy.deepcopy(item)
    return copy.deepcopy(item)


def _role(cfg, actor, value):
    key = _text(value.get("key"), "角色编号", 80).lower()
    if not safe_record_id(key):
        raise APIError(400, "INVALID_ROLE_KEY", "角色编号格式无效")
    existing = cfg.get("roles", {}).get(key, {})
    _creating(value, existing, "角色编号")
    scope = value.get("scope", "self")
    if scope not in ROLE_SCOPES:
        raise APIError(400, "INVALID_ROLE_SCOPE", "角色数据范围无效")
    permissions = _role_permissions(value.get("permissions", []))
    pages = _role_pages(value.get("pages", []))
    if "profit" in pages and "finance.read" not in permissions:
        raise APIError(400, "ROLE_PAGE_PERMISSION_MISMATCH", "利润页面需要查看财务权限")
    if "settings" in pages and not {"rates.write", "snapshots.read"}.intersection(permissions):
        raise APIError(400, "ROLE_PAGE_PERMISSION_MISMATCH", "业务设置页面需要汇率或快照权限")
    if MANAGE_CAPABILITY in permissions:
        if scope != "tenant":
            raise APIError(400, "ADMIN_SCOPE_REQUIRED", "企业管理角色必须使用企业范围")
        if "admin" not in pages:
            pages.append("admin")
    if key == actor.get("role") and MANAGE_CAPABILITY not in permissions:
        raise APIError(409, "CURRENT_ADMIN_REQUIRED", "不能移除当前账号的企业管理权限")
    scopes = value.get("readScopes", existing.get("readScopes", {}))
    if not isinstance(scopes, dict) or any(name not in COLLECTIONS or selected not in {"self", "team", "entities", "tenant"} for name, selected in scopes.items()):
        raise APIError(400, "INVALID_ROLE_READ_SCOPE", "角色模块读取范围无效")
    collections = value.get("collections", existing.get("collections"))
    if collections is not None:
        collections = _list(collections, "角色业务模块")
        if any(name not in COLLECTIONS for name in collections):
            raise APIError(400, "UNKNOWN_COLLECTION", "角色包含未知业务模块")
    policy = {
        **copy.deepcopy(existing),
        "label": _text(value.get("label", ROLE_LABELS.get(key, key)), "角色名称"),
        "baseRole": _text(value.get("baseRole", key), "基础角色", 80),
        "scope": scope, "permissions": permissions, "pages": pages,
        "readScopes": copy.deepcopy(scopes),
    }
    if collections is not None or "collections" in value:
        policy["collections"] = collections
    cfg.setdefault("roles", {})[key] = policy
    role_name = _native_role(key)
    if not frappe.db.exists("Role", role_name):
        frappe.get_doc({"doctype": "Role", "role_name": role_name, "desk_access": 0}).insert(ignore_permissions=True)
    return {"key": key, **copy.deepcopy(policy)}


def _member(cfg, actor, value):
    profiles = _configured_profiles()
    uid = _text(value.get("id"), "成员编号", 100)
    if not safe_record_id(uid):
        raise APIError(400, "INVALID_MEMBER_ID", "成员编号格式无效")
    existing = profiles.get(uid)
    _creating(value, existing, "成员编号")
    role = _text(value.get("role", (existing or {}).get("role", "salesperson")), "角色", 80).lower()
    if role not in cfg.get("roles", {}):
        raise APIError(400, "UNKNOWN_ROLE", "请选择有效角色")
    email = _text(value.get("email", _email_for_profile(existing or {})), "登录邮箱", 200).lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise APIError(400, "INVALID_MEMBER_EMAIL", "请填写有效的登录邮箱")
    username = _text(value.get("username", (existing or {}).get("username", email)), "登录名", 200)
    disabled = bool(value.get("disabled", False))
    if uid == actor.get("id") and disabled:
        raise APIError(409, "CURRENT_ADMIN_REQUIRED", "不能停用当前登录账号")
    if uid == actor.get("id"):
        own_policy = cfg.get("roles", {}).get(role, {})
        permissions = own_policy.get("permissions", [])
        can_manage = bool(permissions.get(MANAGE_CAPABILITY)) if isinstance(permissions, dict) else MANAGE_CAPABILITY in permissions
        if not can_manage or own_policy.get("scope") != "tenant":
            raise APIError(409, "CURRENT_ADMIN_REQUIRED", "不能移除当前账号的企业管理角色")
    if existing and email != _email_for_profile(existing):
        raise APIError(409, "MEMBER_EMAIL_LOCKED", "已有成员的登录邮箱不能直接修改")
    department = _text(value.get("departmentId", value.get("teamId", (existing or {}).get("teamId", ""))), "部门", 80, required=False)
    if department and department not in (cfg.get("departments") or cfg.get("teams") or {}):
        raise APIError(400, "UNKNOWN_DEPARTMENT", "请选择有效部门")
    grants = _company_ids(cfg, value.get("visibleCompanyIds", (existing or {}).get("visibleCompanyIds", [])))
    password = value.get("temporaryPassword")
    is_new = not existing
    if is_new and frappe.db.exists("User", email):
        raise APIError(409, "MEMBER_EMAIL_EXISTS", "登录邮箱已有账号，请编辑原成员，或使用其他邮箱")
    if any(profile.get("id") != uid and str(profile.get("username") or "").casefold() == username.casefold() for profile in profiles.values()):
        raise APIError(409, "MEMBER_USERNAME_EXISTS", "登录名已被其他成员使用")
    if is_new and (not isinstance(password, str) or len(password) < 12):
        raise APIError(400, "TEMPORARY_PASSWORD_REQUIRED", "新成员需要至少 12 位的临时密码")
    native = frappe.get_doc("User", email) if frappe.db.exists("User", email) else frappe.get_doc({
        "doctype": "User", "email": email, "first_name": value.get("name") or username,
        "send_welcome_email": 0, "user_type": "Website User",
    })
    native.username = username
    native.first_name = _text(value.get("name", (existing or {}).get("name", username)), "成员姓名")
    native.enabled = int(not disabled)
    if password:
        if not isinstance(password, str) or len(password) < 12:
            raise APIError(400, "INVALID_TEMPORARY_PASSWORD", "临时密码至少需要 12 位")
        native.new_password = password
    native.set("roles", [{"role": _native_role(role)}])
    native.save(ignore_permissions=True)
    profile = {
        **({key: val for key, val in existing.items() if key != "nativeUser"} if existing else {}),
        "id": uid, "name": native.first_name, "username": username, "tenantId": cfg["id"],
        "role": role, "teamId": department or None, "departmentId": department or None,
        "visibleCompanyIds": grants,
    }
    name = frappe.db.get_value("Trade User Profile", {"user": email}, "name")
    metadata = frappe.get_doc("Trade User Profile", name) if name else frappe.new_doc("Trade User Profile")
    metadata.update({"user": email, "record_id": uid, "profile": dumps(profile), "role_key": role, "team_id": department or None})
    metadata.save(ignore_permissions=True)
    frappe.db.delete("User Permission", {"user": email, "allow": "Company"})
    for company_id in grants:
        frappe.get_doc({"doctype": "User Permission", "user": email, "allow": "Company", "for_value": repo.native_company(company_id), "apply_to_all_doctypes": 1}).insert(ignore_permissions=True)
    departments = cfg.get("departments") or cfg.get("teams") or {}
    for key, item in departments.items():
        members = [member for member in item.get("memberIds", []) if member != uid]
        if key == department:
            members.append(uid)
        item["memberIds"] = list(dict.fromkeys(members))
    if cfg.get("departments") is not None:
        cfg["teams"] = copy.deepcopy(cfg["departments"])
    return {**profile, "email": email, "enabled": not disabled}


def _email_account(cfg, value):
    if not frappe.db.exists("DocType", "Email Account"):
        raise APIError(409, "EMAIL_UNAVAILABLE", "当前 ERP 环境没有启用邮箱账户功能")
    meta = frappe.get_meta("Email Account")
    identifier = _text(value.get("id"), "邮箱账户编号", 200, required=False)
    if identifier and not frappe.db.exists("Email Account", identifier):
        raise APIError(404, "EMAIL_ACCOUNT_NOT_FOUND", "邮箱账户已不存在，请刷新后重试")
    profiles = _configured_profiles()
    allowed = _list(value.get("allowedUserIds", []), "邮箱授权成员")
    if not set(allowed).issubset(profiles):
        raise APIError(400, "UNKNOWN_MEMBER", "邮箱授权成员中包含未知成员")
    email_id = _text(value.get("emailId"), "邮箱地址").lower()
    if not identifier and frappe.db.exists("Email Account", {"email_id": email_id}):
        raise APIError(409, "EMAIL_ACCOUNT_EXISTS", "邮箱地址已配置，请打开现有邮箱编辑")
    native = frappe.get_doc("Email Account", identifier) if identifier else frappe.new_doc("Email Account")
    service = _text(value.get("service", ""), "邮箱服务", 80, required=False)
    if service == "Outlook":
        service = "Outlook.com"
    login_id = _text(value.get("loginId", email_id), "邮箱登录名", 200)
    password = value.get("password")
    fields = {
        "email_account_name": _text(value.get("label", value.get("emailId")), "邮箱名称"),
        "email_id": email_id, "auth_method": "Basic",
        "service": service, "login_id": login_id,
        "login_id_is_different": int(login_id.casefold() != email_id.casefold()),
        "awaiting_password": int(bool(value.get("awaitingPassword", native.get("awaiting_password") if identifier else not password))),
        "enable_incoming": int(bool(value.get("enableIncoming", True))),
        "enable_outgoing": int(bool(value.get("enableOutgoing", True))),
        "default_incoming": int(bool(value.get("defaultIncoming", False))),
        "default_outgoing": int(bool(value.get("defaultOutgoing", False))),
        "email_server": _text(value.get("incomingServer", ""), "收信服务器", 200, required=False),
        "incoming_port": _port(value.get("incomingPort"), "收信端口"),
        "use_imap": int(bool(value.get("useImap", True))),
        "use_ssl": int(bool(value.get("useSsl", True))),
        "use_starttls": int(bool(value.get("useStarttls", False))),
        "smtp_server": _text(value.get("smtpServer", ""), "发信服务器", 200, required=False),
        "smtp_port": _port(value.get("smtpPort"), "发信端口"),
        "use_tls": int(bool(value.get("useTls", True))),
        "use_ssl_for_outgoing": int(bool(value.get("useSslForOutgoing", False))),
    }
    for field, field_value in fields.items():
        if meta.has_field(field) and field_value is not None:
            native.set(field, field_value)
    if fields["enable_incoming"] and fields["use_imap"] and meta.has_field("imap_folder") and not native.get("imap_folder"):
        native.append("imap_folder", {"folder_name": "INBOX"})
    if password:
        if not isinstance(password, str) or len(password) > 1000:
            raise APIError(400, "INVALID_EMAIL_PASSWORD", "邮箱密码格式无效")
        if meta.has_field("password"):
            native.set("password", password)
            if meta.has_field("awaiting_password"):
                native.awaiting_password = 0
    _clear_email_defaults(native, fields)
    native.save(ignore_permissions=True)
    _sync_mailbox_members(native, profiles, allowed)
    cfg.setdefault("emailAccounts", {})[native.name] = {"allowedUserIds": allowed}
    return {"id": native.name, "emailId": fields["email_id"], "label": fields["email_account_name"]}


def _clear_email_defaults(native, fields):
    """Switch native defaults inside the already authorized admin transaction."""
    for default, enabled in (("default_incoming", "enable_incoming"), ("default_outgoing", "enable_outgoing")):
        if not fields.get(default) or not fields.get(enabled):
            continue
        for row in frappe.get_all("Email Account", filters={default: 1}, fields=["name"]):
            if row.name == native.name:
                continue
            previous = frappe.get_doc("Email Account", row.name)
            previous.set(default, 0)
            previous.save(ignore_permissions=True)


def _sync_mailbox_members(mailbox, profiles, allowed):
    """Persist mailbox access in Frappe's native User Email child table."""
    if not frappe.get_meta("User").has_field("user_emails"):
        raise APIError(409, "EMAIL_AUTHORIZATION_UNAVAILABLE", "当前 ERP 环境不支持原生邮箱成员授权")
    for uid, profile in profiles.items():
        user = frappe.get_doc("User", _email_for_profile(profile))
        rows = list(user.get("user_emails") or [])
        matching = [row for row in rows if row.get("email_account") == mailbox.name]
        if uid not in allowed and not matching:
            continue
        retained = [row for row in rows if row.get("email_account") != mailbox.name]
        user.set("user_emails", retained)
        if uid in allowed:
            user.append("user_emails", {
                "email_account": mailbox.name, "email_id": mailbox.email_id,
                "enable_outgoing": int(bool(mailbox.get("enable_outgoing"))),
                "awaiting_password": int(bool(mailbox.get("awaiting_password"))),
                "used_oauth": int(mailbox.get("auth_method") == "OAuth"),
            })
        user.save(ignore_permissions=True)


def _onboarding_update(cfg, profiles, value):
    current = _onboarding(cfg, profiles)
    step = value.get("currentStep", current["currentStep"])
    if step not in ONBOARDING_STEPS:
        raise APIError(400, "INVALID_ONBOARDING_STEP", "初始化步骤无效")
    completed = set(current["completedSteps"])
    completed.update(key for key in _list(value.get("completedSteps", []), "已完成步骤") if key in ONBOARDING_STEPS)
    if value.get("complete"):
        checked = _onboarding(cfg, repo.profiles())
        if not checked["requiredReady"]:
            raise APIError(409, "ONBOARDING_INCOMPLETE", "请先完成企业资料、公司、角色和管理员配置")
        completed.update(ONBOARDING_STEPS)
        status = "complete"
    else:
        status = "complete" if current["status"] == "complete" and current["requiredReady"] else "in_progress"
    if step in completed and status != "complete":
        step = next((key for key in ONBOARDING_STEPS if key not in completed), "finish")
    cfg["onboarding"] = {
        "status": status, "currentStep": step, "completedSteps": [key for key in ONBOARDING_STEPS if key in completed],
        "businessPrepared": bool(value.get("businessPrepared", current["checks"].get("business"))), "updatedAt": now(),
    }
    return copy.deepcopy(cfg["onboarding"])


def update(work, cfg, actor, rules, supplied):
    _manage(cfg, actor, rules)
    _expected(work, supplied)
    resource = supplied.get("resource")
    value = supplied.get("value")
    if not isinstance(value, dict):
        raise APIError(400, "ADMIN_VALIDATION", "管理配置必须是对象")
    cfg = copy.deepcopy(cfg)
    if resource == "enterprise":
        changed = _enterprise(cfg, value)
    elif resource == "company":
        changed = _company(cfg, actor, value)
    elif resource == "department":
        changed = _department(cfg, value)
    elif resource == "role":
        changed = _role(cfg, actor, value)
    elif resource == "member":
        changed = _member(cfg, actor, value)
    elif resource == "email":
        from .permissions import delegated_email_configuration
        with delegated_email_configuration(cfg, actor, rules):
            changed = _email_account(cfg, value)
    elif resource == "onboarding":
        changed = _onboarding_update(cfg, repo.profiles(), value)
    else:
        raise APIError(400, "UNKNOWN_ADMIN_RESOURCE", "未知的管理配置类型")
    step = supplied.get("completedStep")
    if resource != "onboarding" and step is not None:
        if step not in ONBOARDING_STEPS:
            raise APIError(400, "INVALID_ONBOARDING_STEP", "初始化步骤无效")
        progress = {"currentStep": step, "completedSteps": [step]}
        if step == "business":
            progress["businessPrepared"] = True
        _onboarding_update(cfg, repo.profiles(), progress)
    result = _save(work, cfg, actor, resource, {"resource": resource, "id": changed.get("id") or changed.get("key")})
    result["changed"] = changed
    result["onboarding"] = _onboarding(cfg, repo.profiles())
    return result

