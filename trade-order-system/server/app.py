"""Same-origin HTTP API, bound to loopback with an explicit static-file allowlist."""
from __future__ import annotations

import argparse
import ipaddress
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

from .errors import APIError
from .exchange_rate import ExchangeRateService
from .frappe_client import FrappeGateway, SESSION_TTL

SOURCE_ROOT = Path(__file__).resolve().parent.parent
PREVIEW_ROOT = SOURCE_ROOT.parent / "local-preview"
DEFAULT_RUNTIME = Path(os.environ.get("TRADE_RUNTIME_DIR", Path.home() / "Library" / "Application Support" / "Tradept" / "gateway"))
COOKIE_NAME = "trade_session"
MAX_BODY = 5 * 1024 * 1024


def release_info():
    """Expose only fixed source identity, never runtime or tenant configuration."""
    version = json.loads((SOURCE_ROOT / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Invalid product version")
    result = {"version": version, "environment": "test", "sourceCommit": None, "sourceManifestSHA256": None}
    marker = SOURCE_ROOT / "release-build.json"
    if marker.is_file():
        supplied = json.loads(marker.read_text())
        if supplied.get("version") != version:
            raise ValueError("Runtime release marker differs from source version")
        for field, length in (("sourceCommit", 40), ("sourceManifestSHA256", 64)):
            value = supplied.get(field)
            if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{" + str(length) + r"}", value):
                raise ValueError("Runtime release marker requires verified source hashes")
            result[field] = value
    return result


def normalize_public_origin(value):
    """Configure one HTTPS origin behind a same-host loopback reverse proxy."""
    if value is None:
        return None
    if not isinstance(value, str) or any(character.isspace() or ord(character) < 32 for character in value) or "?" in value or "#" in value:
        raise ValueError("Public origin must be one HTTPS origin with a DNS hostname")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise ValueError("Public origin must be one HTTPS origin with a DNS hostname") from None
    hostname = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not hostname or len(hostname) > 253
            or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", hostname)
            or hostname == "localhost" or hostname.endswith(".localhost")
            or (port is not None and not 1 <= port <= 65535)):
        raise ValueError("Public origin must be one HTTPS origin with a DNS hostname")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise ValueError("Public origin requires a DNS hostname, not an IP address")
    authority = hostname if port in (None, 443) else f"{hostname}:{port}"
    return f"https://{authority}"


class Handler(BaseHTTPRequestHandler):
    server_version = "TradeWorkspace/1"

    def log_message(self, *_args):
        pass  # Never log usernames, credentials, cookie values or record data.

    @property
    def gateway(self):
        return self.server.gateway

    def _token(self):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        item = cookies.get(COOKIE_NAME)
        return item.value if item else None

    def _origin(self, required=False):
        host = self.headers.get("Host", "")
        public_origin = self.server.public_origin
        allowed = {urlsplit(public_origin).netloc} if public_origin else {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if len(self.headers.get_all("Host", [])) != 1 or host not in allowed:
            raise APIError(403, "HOST_DENIED", "Invalid host")
        origin = self.headers.get("Origin")
        expected_origin = public_origin or "http://" + host
        if len(self.headers.get_all("Origin", [])) > 1 or (required and not origin) or (origin and origin != expected_origin):
            raise APIError(403, "ORIGIN_DENIED", "Same-origin request required")
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise APIError(403, "ORIGIN_DENIED", "Cross-site request denied")

    def _session_cookie(self, token, max_age):
        cookie = f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        return cookie + "; Secure" if self.server.public_origin else cookie

    def _body(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise APIError(400, "INVALID_BODY", "Invalid request length")
        if size <= 0 or size > MAX_BODY:
            raise APIError(413 if size > MAX_BODY else 400, "INVALID_BODY", "JSON request body required (maximum 5 MiB)")
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            raise APIError(415, "JSON_REQUIRED", "Content-Type must be application/json")
        try:
            value = json.loads(self.rfile.read(size).decode("utf-8"), parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
        except (ValueError, UnicodeError):
            raise APIError(400, "INVALID_JSON", "Request body is not valid JSON")
        if not isinstance(value, dict):
            raise APIError(400, "INVALID_BODY", "Request body must be an object")
        return value

    def _headers(self, status, content_type, size, cookie=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def _json(self, status, value, cookie=None):
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(encoded), cookie)
        self.wfile.write(encoded)

    def do_GET(self):
        try:
            self._origin()
            path = urlsplit(self.path).path
            if path == "/api/version":
                self._json(200, self.server.release_info)
                return
            if path.startswith("/api/"):
                actor = self.gateway.actor(self._token())
                if path == "/api/exchange-rate":
                    self._json(200, self.server.exchange_rates.get())
                    return
                routes = {"/api/session": "session", "/api/data": "data", "/api/meta": "meta", "/api/snapshots": "snapshots", "/api/backend/status": "backend_status", "/api/erpnext/status": "backend_status", "/api/administrator": "admin_state"}
                action = routes.get(path)
                if not action:
                    raise APIError(404, "NOT_FOUND", "API endpoint not found")
                self._json(200, self.gateway.read(actor, action))
                return
            self._static(path)
        except APIError as error:
            self._json(error.status, error.response())
        except Exception:
            self._json(500, {"error": "Internal server error", "code": "INTERNAL_ERROR"})

    def do_POST(self):
        try:
            self._origin(required=True)
            path = urlsplit(self.path).path
            body = {} if path == "/api/logout" and self.headers.get("Content-Length", "0") == "0" else self._body()
            if path == "/api/login":
                token, session = self.gateway.login(body.get("tenantId"), body.get("username"), body.get("password"))
                self._json(200, session, self._session_cookie(token, SESSION_TTL))
                return
            if path == "/api/logout":
                self.gateway.logout(self._token())
                self._json(200, {"ok": True}, self._session_cookie("", 0))
                return
            actor = self.gateway.actor(self._token())
            action = {"/api/changes": "changes", "/api/restore": "restore", "/api/orders/convert": "convert_order", "/api/orders/submit": "submit_order", "/api/orders/payment": "receive_payment", "/api/orders/cancel": "cancel_order", "/api/administrator": "admin_update"}.get(path)
            if action is None:
                raise APIError(404, "NOT_FOUND", "API endpoint not found")
            result = self.gateway.write(actor, action, body)
            self._json(200, result)
        except APIError as error:
            self._json(error.status, error.response())
        except Exception:
            self._json(500, {"error": "Internal server error", "code": "INTERNAL_ERROR"})

    def do_OPTIONS(self):
        self._json(405, {"error": "CORS is not enabled", "code": "METHOD_DENIED"})

    def _static(self, raw_path):
        path = unquote(raw_path)
        if "\\" in path or "\x00" in path or any(part in ("..", ".") for part in path.split("/")):
            raise APIError(404, "NOT_FOUND", "File not found")
        if path == "/":
            path = "/index.html"
        filename = None
        if path in ("/vendor/chart.umd.min.js", "/vendor/xlsx.full.min.js"):
            filename = PREVIEW_ROOT / path.removeprefix("/")
        elif path in ("/index.html", "/manifest.json"):
            filename = SOURCE_ROOT / path.removeprefix("/")
        elif path.startswith("/css/") and Path(path).suffix == ".css":
            filename = SOURCE_ROOT / path.removeprefix("/")
        elif path.startswith("/js/") and Path(path).suffix == ".js" and path not in ("/js/cloudbase-sdk.js", "/js/tcb.js"):
            filename = SOURCE_ROOT / path.removeprefix("/")
        elif path.startswith("/assets/") and Path(path).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".gif"):
            filename = SOURCE_ROOT / path.removeprefix("/")
        if filename is None or not filename.is_file():
            raise APIError(404, "NOT_FOUND", "File not found")
        resolved = filename.resolve()
        allowed_root = PREVIEW_ROOT if path.startswith("/vendor/") else SOURCE_ROOT
        if not resolved.is_relative_to(allowed_root.resolve()):
            raise APIError(404, "NOT_FOUND", "File not found")
        content = resolved.read_bytes()
        if path == "/index.html":
            # Keep offline assets and API traffic on this origin.
            html = content.decode("utf-8")
            html = html.replace("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js", "/vendor/chart.umd.min.js").replace("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", "/vendor/xlsx.full.min.js")
            html = re.sub(r"connect-src [^;]*;", "connect-src 'self';", html)
            content = html.encode("utf-8")
        content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        if Path(path).suffix in (".html", ".css", ".js", ".json"):
            content_type += "; charset=utf-8"
        self._headers(200, content_type, len(content))
        self.wfile.write(content)


def create_server(runtime, port=3087, public_origin=None, configuration=None, gateway=None, exchange_rates=None):
    public_origin = normalize_public_origin(public_origin)
    if exchange_rates is None:
        exchange_rates = getattr(gateway, "exchange_rates", None)
    if exchange_rates is None:
        exchange_rates = ExchangeRateService()
    gateway = gateway if gateway is not None else FrappeGateway(runtime, configuration, exchange_rates=exchange_rates)
    # A supplied gateway and the HTTP endpoint must still share one cache;
    # otherwise settings and order conversion could observe different rates.
    gateway.exchange_rates = exchange_rates
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.gateway = gateway
    server.exchange_rates = exchange_rates
    server.public_origin = public_origin
    server.release_info = release_info()
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3087)
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument("--sites", type=Path, help="Private fixed tenant-to-Frappe site routing JSON (0600)")
    parser.add_argument("--public-origin", help="Fixed HTTPS origin behind a same-host loopback reverse proxy; never trusts forwarded headers")
    args = parser.parse_args()
    try:
        public_origin = normalize_public_origin(args.public_origin)
    except ValueError as error:
        parser.error(str(error))
    with create_server(args.runtime, args.port, public_origin=public_origin, configuration=args.sites) as server:
        print(f"Local trade workspace: http://127.0.0.1:{server.server_port}", flush=True)
        print("Unified Frappe/ERPNext business backend. Listening on loopback only.", flush=True)
        if public_origin:
            print(f"Cloud test reverse proxy origin: {public_origin}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
