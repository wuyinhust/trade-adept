"""Fixed-site Frappe gateway. Business persistence and authentication stay native."""
from __future__ import annotations

import base64
import hashlib
import hmac
from http.cookies import SimpleCookie
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .errors import APIError
from .exchange_rate import ExchangeRateService

SESSION_TTL = 8 * 3600
GATEWAY_ASSERTION_TTL = 180
MAX_RESPONSE = 10 * 1024 * 1024
DISPATCH = "/api/method/tradept_core.api.dispatch"
TENANT_ID = re.compile(r"[a-zA-Z0-9_-]{1,100}")
SITE_NAME = re.compile(r"[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,198}[a-zA-Z0-9])?")
NATIVE_SID = re.compile(r"[a-zA-Z0-9_-]{16,200}")
ORDER_RATE_FIELDS = {
    "companyId", "orderAmountUSD", "factoryCostRMB", "freightCostUSD",
    "insuranceCostUSD", "otherCostUSD",
}
NESTED_ORDER_RATE_FIELDS = {
    "totalAmount", "prepayment", "paidAmount", "cost", "costUSD", "costRMB",
    "paidCostRMB", "paidCostUSD", "costPaidUSD", "purchaseRate",
    "paymentStatus", "costPaymentStatus",
}
GATEWAY_ASSERTION = "gatewayAssertion"


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def gateway_hmac_key(value):
    """Decode one tenant key while rejecting examples and low-entropy placeholders."""
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise ValueError("Each tenant requires gatewayHmacKey from 32 random bytes (64 hex characters)")
    key = bytes.fromhex(value)
    if len(set(key)) < 16:
        raise ValueError("gatewayHmacKey must be independently generated random data, not a default or placeholder")
    return key


def needs_live_exchange_rate(action, payload):
    """Only pricing writes need a provider publication injected."""
    if action == "convert_order":
        return True
    if action != "changes" or not isinstance(payload, dict) or payload.get("importPurpose") == "historical-reference":
        return False
    for change in payload.get("changes", []):
        if not isinstance(change, dict) or change.get("collection") != "orders" or change.get("deleted") is True:
            continue
        value = change.get("value")
        if not isinstance(value, dict):
            continue
        if ORDER_RATE_FIELDS.intersection(value):
            return True
        rows = value.get("factories")
        if isinstance(rows, list) and any(isinstance(row, dict) and NESTED_ORDER_RATE_FIELDS.intersection(row) for row in rows):
            return True
    return False


def secure_runtime(path):
    """Routing secrets must be on a local filesystem that enforces permissions."""
    directory = Path(path).resolve()
    mounts = []
    if sys.platform == "darwin":
        try:
            listing = subprocess.check_output(["/sbin/mount"], text=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            raise RuntimeError("Cannot verify local runtime filesystem") from None
        for line in listing.splitlines():
            match = re.search(r" on (.+?) \(([^, )]+)", line)
            if match:
                mounts.append((match[1], match[2]))
    elif Path("/proc/mounts").exists():
        for line in Path("/proc/mounts").read_text().splitlines():
            parts = line.split()
            if len(parts) > 2:
                mounts.append((parts[1].replace("\\040", " "), parts[2]))
    candidates = [(mount, kind) for mount, kind in mounts if str(directory) == mount or str(directory).startswith(mount.rstrip("/") + "/")]
    if candidates and max(candidates, key=lambda pair: len(pair[0]))[1] in {"smbfs", "cifs", "nfs", "nfs4", "afpfs", "fuse.sshfs", "9p"}:
        raise RuntimeError("Routing secrets require a private local filesystem; use an APFS or local block-disk runtime")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    if os.name != "nt" and directory.stat().st_mode & 0o077:
        raise RuntimeError("Runtime filesystem cannot enforce private permissions")
    return directory


def normalize_backend_origin(value):
    if not isinstance(value, str) or any(character.isspace() or ord(character) < 32 for character in value):
        raise ValueError("Backend origin must be a fixed HTTPS origin or loopback HTTP origin")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError("Invalid backend origin") from None
    host = parsed.hostname
    if (not host or parsed.username is not None or parsed.password is not None or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or "?" in value or "#" in value or (port is not None and not 1 <= port <= 65535)):
        raise ValueError("Backend origin must not contain paths, credentials or query strings")
    if parsed.scheme == "http":
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host == "localhost"
        if not loopback:
            raise ValueError("Unencrypted backend HTTP is limited to loopback")
    elif parsed.scheme != "https":
        raise ValueError("Backend origin requires HTTPS")
    if not re.fullmatch(r"[a-zA-Z0-9.:-]+", host):
        raise ValueError("Invalid backend hostname")
    authority = f"[{host}]" if ":" in host else host
    if port is not None:
        authority += f":{port}"
    return f"{parsed.scheme}://{authority}"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class FrappeGateway:
    """No account database, business cache, queue, or SQLite fallback."""
    def __init__(self, runtime, configuration=None, exchange_rates=None):
        self.runtime = secure_runtime(runtime)
        path = Path(configuration) if configuration else self.runtime / "frappe-sites.json"
        if path.is_symlink() or (os.name != "nt" and path.stat().st_mode & 0o077):
            raise ValueError("Frappe site configuration must be a private regular file (0600)")
        if path.stat().st_size > 1024 * 1024:
            raise ValueError("Site configuration is too large")
        config = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(config, dict) or "tenants" not in config or set(config) - {"tenants", "privateTenant", "demoMode", "demoTenants"} or not isinstance(config["tenants"], dict):
            raise ValueError("Routing configuration accepts only a tenants object")
        self.sites = {}
        native_sites = set()
        gateway_keys = set()
        for tenant, site in config.get("tenants", {}).items():
            if (not TENANT_ID.fullmatch(tenant) or not isinstance(site, dict)
                    or set(site) != {"origin", "site", "gatewayHmacKey"}
                    or not SITE_NAME.fullmatch(site.get("site", ""))):
                raise ValueError("Each tenant needs a valid fixed Frappe site")
            origin = normalize_backend_origin(site.get("origin"))
            identity = (origin, site["site"])
            if identity in native_sites:
                raise ValueError("Tenants must not share a Frappe site/database")
            native_sites.add(identity)
            gateway_key = gateway_hmac_key(site.get("gatewayHmacKey"))
            if gateway_key in gateway_keys:
                raise ValueError("Each tenant requires an independent gatewayHmacKey")
            gateway_keys.add(gateway_key)
            self.sites[tenant] = {"origin": origin, "site": site["site"], "gatewayHmacKey": gateway_key}
        if not self.sites:
            raise ValueError("At least one Frappe site is required")
        self.demo_mode = config.get("demoMode", False)
        if type(self.demo_mode) is not bool:
            raise ValueError("demoMode must be a boolean")
        self.demo_tenants = config.get("demoTenants")
        if self.demo_mode:
            if ("privateTenant" in config or not isinstance(self.demo_tenants, list) or not self.demo_tenants
                    or any(not isinstance(tenant, str) or tenant not in self.sites for tenant in self.demo_tenants)
                    or len(set(self.demo_tenants)) != len(self.demo_tenants)):
                raise ValueError("Demo mode requires explicit unique demoTenants and cannot set privateTenant")
            self.sites = {tenant: self.sites[tenant] for tenant in self.demo_tenants}
        elif "demoTenants" in config:
            raise ValueError("demoTenants requires explicit demoMode true")
        self.private_tenant = None if self.demo_mode else config.get("privateTenant") or (next(iter(self.sites)) if len(self.sites) == 1 else None)
        if self.private_tenant is not None:
            if self.private_tenant not in self.sites:
                raise ValueError("privateTenant must name a configured site")
            self.sites = {self.private_tenant: self.sites[self.private_tenant]}
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.exchange_rates = exchange_rates if exchange_rates is not None else ExchangeRateService()
        secret_path = self.runtime / "routing-secret"
        try:
            descriptor = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(secrets.token_bytes(32))
        if secret_path.is_symlink() or (os.name != "nt" and secret_path.stat().st_mode & 0o077):
            raise ValueError("Routing secret must be a private regular file (0600)")
        self.secret = secret_path.read_bytes()
        if len(self.secret) != 32:
            raise ValueError("Invalid routing secret")

    def _site(self, tenant):
        site = self.sites.get(tenant) if isinstance(tenant, str) else None
        if site is None:
            raise APIError(401, "LOGIN_FAILED", "Invalid workspace or credentials")
        return site

    def _request(self, tenant, path, method="GET", fields=None, sid=None, csrf=None):
        site = self._site(tenant)
        headers = {"Accept": "application/json", "X-Frappe-Site-Name": site["site"]}
        if sid:
            if not isinstance(sid, str) or not NATIVE_SID.fullmatch(sid):
                raise APIError(401, "SESSION_REQUIRED", "Please sign in")
            headers["Cookie"] = f"sid={sid}"
        if csrf:
            if not isinstance(csrf, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{16,200}", csrf):
                raise APIError(502, "BACKEND_PROTOCOL_ERROR", "Invalid business service response")
            headers["X-Frappe-CSRF-Token"] = csrf
        data = None
        if method == "GET" and fields:
            path += "?" + urlencode(fields)
        elif fields is not None:
            data = json.dumps(fields, ensure_ascii=False, allow_nan=False).encode()
            headers["Content-Type"] = "application/json"
        request = Request(site["origin"] + path, data=data, headers=headers, method=method)
        try:
            # Native restores and accounting controllers can outlast a read.
            # Keep one transaction in flight; never retry a write here.
            response = self.opener.open(request, timeout=120 if method == "POST" else 30)
        except HTTPError as error:
            response = error
        except (URLError, TimeoutError, OSError):
            message = "Business request result is unconfirmed; refresh the workspace before retrying" if method == "POST" else "Business service is unavailable; your unsaved changes are retained"
            raise APIError(503, "BACKEND_UNAVAILABLE", message) from None
        with response:
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise APIError(502, "BACKEND_PROTOCOL_ERROR", "Business service response exceeds the limit")
            status = response.status
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError):
                value = {}
            message = value.get("message") if isinstance(value, dict) else None
            envelope = message if isinstance(message, dict) else {}
            result = envelope.get("result")
            if status >= 300:
                if isinstance(result, dict) and isinstance(result.get("code"), str):
                    details = {"latestVersion": result["latestVersion"]} if isinstance(result.get("latestVersion"), int) else {}
                    raise APIError(status, result["code"], str(result.get("error", "Business request rejected"))[:500], **details)
                if status in (401, 403):
                    raise APIError(status, "SESSION_REQUIRED" if status == 401 else "FORBIDDEN", "Sign in or check your access permissions")
                if status in (429,):
                    raise APIError(429, "LOGIN_RATE_LIMIT", "Too many requests; try again later")
                raise APIError(502 if status < 500 else 503, "BACKEND_REQUEST_FAILED", "Business service rejected the request")
            return value, response.headers

    def _dispatch(self, tenant, sid, action, payload=None, csrf=None):
        fields = {"action": action}
        if payload is not None:
            fields["payload"] = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        value, _headers = self._request(tenant, DISPATCH, "POST" if payload is not None else "GET", fields, sid, csrf)
        message = value.get("message") if isinstance(value, dict) else None
        if not isinstance(message, dict) or "result" not in message:
            raise APIError(502, "BACKEND_PROTOCOL_ERROR", "Business service did not return a valid workspace response")
        if action in ("session", "context"):
            result = message["result"]
            user = result.get("user") if isinstance(result, dict) else None
            if not isinstance(user, dict) or user.get("tenantId") != tenant:
                raise APIError(503, "TENANT_ROUTING_MISMATCH", "The workspace routing does not match its native tenant")
        return message

    def public_login_config(self):
        if self.demo_mode:
            return {"demoMode": True, "demoTenants": list(self.demo_tenants), "emailOnly": False,
                    "setupRequired": False, "invitationOnly": True, "brand": "Tradept"}
        if not self.private_tenant:
            raise APIError(503, "PRIVATE_SITE_REQUIRED", "请由部署管理员配置当前企业的独立登录入口")
        value, _ = self._request(self.private_tenant, "/api/method/tradept_core.enterprise_login.login_config", "GET")
        result = value.get("message") if isinstance(value, dict) else None
        if not isinstance(result, dict) or type(result.get("setupRequired")) is not bool or type(result.get("emailOnly")) is not bool or result["emailOnly"] == result["setupRequired"]:
            raise APIError(503, "PRIVATE_LOGIN_NOT_READY", "企业登录服务尚未配置")
        return {"emailOnly": result["emailOnly"], "setupRequired": result["setupRequired"], "invitationOnly": True, "brand": "Tradept"}

    def public_auth(self, action, body):
        if self.demo_mode:
            raise APIError(503, "DEMO_EMAIL_UNAVAILABLE", "演示站点尚未启用邮件激活或找回密码，请使用原账号登录")
        if not self.private_tenant:
            raise APIError(503, "PRIVATE_SITE_REQUIRED", "请配置独立企业入口")
        methods = {"forgot-password": ("forgot_password", ("email",)), "set-password": ("complete_password", ("key", "password"))}
        if action not in methods:
            raise APIError(404, "NOT_FOUND", "Unknown authentication action")
        method, keys = methods[action]
        fields = {key: body.get(key) for key in keys}
        if any(not isinstance(value, str) or len(value) > 200 for value in fields.values()):
            raise APIError(400, "INVALID_AUTH_INPUT", "请检查邮箱、链接或密码格式")
        value, _ = self._request(self.private_tenant, "/api/method/tradept_core.enterprise_login." + method, "POST", fields)
        result = value.get("message") if isinstance(value, dict) else None
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise APIError(502, "AUTH_RESPONSE_INVALID", "账号服务返回无效，请稍后重试")
        return result

    def login(self, tenant, username, password):
        if not self.private_tenant and not self.demo_mode:
            self.public_login_config()
        if self.private_tenant:
            if tenant not in (None, "", self.private_tenant):
                raise APIError(401, "LOGIN_FAILED", "邮箱或密码无效")
            tenant = self.private_tenant
            setup = self.public_login_config()["setupRequired"]
            if not setup and (not isinstance(username, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", username.strip())):
                raise APIError(401, "EMAIL_REQUIRED", "请使用企业邮箱登录")
            username = username.strip().lower() if isinstance(username, str) else username
        self._site(tenant)
        if not isinstance(username, str) or not 1 <= len(username) <= 200 or not isinstance(password, str) or not 1 <= len(password) <= 1000:
            raise APIError(401, "LOGIN_FAILED", "Invalid workspace or credentials")
        try:
            _value, headers = self._request(tenant, "/api/method/login", "POST", {"usr": username, "pwd": password})
        except APIError as error:
            if error.status in (401, 403, 502):
                raise APIError(401, "LOGIN_FAILED", "Invalid workspace or credentials") from None
            raise
        cookies = SimpleCookie()
        for header in headers.get_all("Set-Cookie", []):
            cookies.load(header)
        sid = cookies.get("sid")
        if not sid or not NATIVE_SID.fullmatch(sid.value):
            raise APIError(401, "LOGIN_FAILED", "Invalid workspace or credentials")
        session = self._dispatch(tenant, sid.value, "session")["result"]
        if self.private_tenant and (not isinstance(session, dict) or session.get("emailLoginEnabled") is not True and session.get("loginSetupRequired") is not True):
            raise APIError(503, "PRIVATE_LOGIN_NOT_READY", "企业邮箱登录尚未初始化，请联系部署管理员")
        if not isinstance(session, dict) or not isinstance(session.get("user"), dict):
            raise APIError(403, "WORKSPACE_ACCESS_REQUIRED", "This account is not configured for the workspace")
        return self._sign(tenant, sid.value), {"ok": True, "user": session["user"]}

    def _sign(self, tenant, sid):
        value = {"v": 1, "tenant": tenant, "sid": sid, "expires": int(time.time()) + SESSION_TTL}
        encoded = base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
        signature = hmac.new(self.secret, encoded.encode(), hashlib.sha256).hexdigest()
        return encoded + "." + signature

    def actor(self, token):
        try:
            if not isinstance(token, str) or len(token) > 2000:
                raise ValueError()
            encoded, signature = token.split(".")
            if not hmac.compare_digest(signature, hmac.new(self.secret, encoded.encode(), hashlib.sha256).hexdigest()):
                raise ValueError()
            value = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            if value.get("v") != 1 or not isinstance(value.get("expires"), int) or value["expires"] <= time.time() or not NATIVE_SID.fullmatch(value.get("sid", "")):
                raise ValueError()
            self._site(value.get("tenant"))
            return value
        except (ValueError, TypeError, KeyError, AttributeError):
            raise APIError(401, "SESSION_REQUIRED", "Please sign in") from None

    def read(self, actor, action, payload=None):
        if payload is None:
            return self._dispatch(actor["tenant"], actor["sid"], action)["result"]
        # Parameterised reads use POST, so Frappe's native CSRF check still
        # applies even though the scoped action cannot change business data.
        context = self._dispatch(actor["tenant"], actor["sid"], "context")
        return self._dispatch(actor["tenant"], actor["sid"], action, payload, context.get("csrfToken"))["result"]

    def current_exchange_rate(self):
        """Return the shared server-side publication used for conversions."""
        return self.exchange_rates.get()

    def _gateway_assertion(self, actor, action, payload, rate):
        site = self._site(actor["tenant"])
        now = int(time.time())
        claims = {
            "v": 1,
            "site": site["site"],
            "tenant": actor["tenant"],
            "action": action,
            "session": hashlib.sha256(actor["sid"].encode()).hexdigest(),
            "expectedVersion": payload.get("expectedVersion"),
            "idempotencyKey": payload.get("idempotencyKey"),
            "payloadSha256": hashlib.sha256(canonical_json(payload).encode()).hexdigest(),
            "rate": {"value": payload["liveExchangeRate"], "metadata": rate},
            "iat": now,
            "exp": now + GATEWAY_ASSERTION_TTL,
            "nonce": secrets.token_hex(16),
        }
        signature = hmac.new(site["gatewayHmacKey"], canonical_json(claims).encode(), hashlib.sha256).hexdigest()
        return {"claims": claims, "signature": signature}

    def write(self, actor, action, payload):
        # Native authorization and CSRF are checked for every transaction. The
        # facade never reads a version then performs multiple REST updates.
        context = self._dispatch(actor["tenant"], actor["sid"], "context")
        csrf = context.get("csrfToken")
        if not csrf:
            raise APIError(502, "BACKEND_PROTOCOL_ERROR", "Business service did not return a CSRF token")
        if not isinstance(payload, dict):
            raise APIError(400, "INVALID_BODY", "Business payload must be an object")
        # Browser-supplied assertion material is never forwarded. Assertions
        # are minted only after the native session and tenant route are known.
        payload = {
            key: value for key, value in payload.items()
            if key not in (GATEWAY_ASSERTION, "liveExchangeRate", "liveExchangeRateMeta")
        }
        if needs_live_exchange_rate(action, payload):
            # Live rate fields are gateway assertions. Never let a browser
            # choose, override, or replay them into a quote or accounting write.
            rate = self.current_exchange_rate()
            if rate.get("stale") is True:
                raise APIError(503, "LIVE_RATE_STALE", "The latest USD/CNY publication is not available for a new financial calculation")
            payload = {
                **payload,
                "liveExchangeRate": rate["adjustedRate"],
                "liveExchangeRateMeta": dict(rate),
            }
            payload[GATEWAY_ASSERTION] = self._gateway_assertion(actor, action, payload, rate)
        return self._dispatch(actor["tenant"], actor["sid"], action, payload, csrf)["result"]

    def logout(self, token):
        try:
            actor = self.actor(token)
        except APIError:
            return
        context = self._dispatch(actor["tenant"], actor["sid"], "context")
        self._request(actor["tenant"], "/api/method/logout", "POST", {}, actor["sid"], context.get("csrfToken"))
