"""Keep native business RPC helpers behind the same workbench authorization."""
from __future__ import annotations

from urllib.parse import unquote
import frappe

from .permissions import restricted_user

AUTH_METHODS = {
    "login", "logout", "frappe.auth.get_logged_user",
    "frappe.core.doctype.user.user.update_password",
    "frappe.core.doctype.user.user.reset_password",
    "frappe.core.doctype.user.user.sign_up",
    "frappe.website.doctype.website_settings.website_settings.sign_up",
    "frappe.integrations.oauth2.authorize", "frappe.integrations.oauth2.approve",
    "frappe.integrations.oauth2.get_token", "frappe.integrations.oauth2.revoke_token",
    "frappe.integrations.oauth2.openid_profile",
    "frappe.integrations.oauth2_logins.login_via_google",
    "frappe.integrations.oauth2_logins.login_via_github",
    "frappe.integrations.oauth2_logins.login_via_microsoft",
}
ALLOWED_METHODS = AUTH_METHODS | {"tradept_core.api.dispatch"}


def _rpc(path):
    for prefix in ("/api/method/", "/api/v1/method/", "/api/v2/method/"):
        if path.startswith(prefix):
            return path[len(prefix):].rstrip("/")
    return None


def check_request():
    request = getattr(frappe.local, "request", None)
    if not request:
        return
    # Frappe's before_request hook runs after sid session initialization; token
    # authentication is resolved here too so trusted native operators retain
    # their standard API access instead of being classified as Guest.
    authorization = request.headers.get("Authorization", "")
    if authorization:
        from frappe.auth import validate_auth
        validate_auth()
    if not restricted_user(frappe.session.user):
        return
    path = unquote(request.path)
    method = _rpc(path)
    command = getattr(frappe.local, "form_dict", {}).get("cmd")
    if command and command not in ALLOWED_METHODS:
        raise frappe.PermissionError("Native business methods require an authorized ERP operator")
    if path.startswith("/api/") and method not in ALLOWED_METHODS:
        raise frappe.PermissionError("Use the scoped Tradept workspace API")
    if method is not None and method not in ALLOWED_METHODS:
        raise frappe.PermissionError("Native business methods require an authorized ERP operator")
