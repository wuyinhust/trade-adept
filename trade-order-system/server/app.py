"""Same-origin loopback HTTP API with an explicit static-file allowlist."""
from __future__ import annotations

import argparse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

from .store import APIError, Store, SESSION_TTL

SOURCE_ROOT = Path(__file__).resolve().parent.parent
PREVIEW_ROOT = SOURCE_ROOT.parent / "local-preview"
DEFAULT_RUNTIME = Path(os.environ.get("TRADE_RUNTIME_DIR", SOURCE_ROOT / "server" / "runtime"))
COOKIE_NAME = "trade_session"
MAX_BODY = 5 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "TradeWorkspace/1"

    def log_message(self, *_args):
        pass  # Never log usernames, credentials, cookie values or record data.

    @property
    def store(self):
        return self.server.store

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
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if host not in allowed:
            raise APIError(403, "HOST_DENIED", "Invalid host")
        origin = self.headers.get("Origin")
        if (required and not origin) or (origin and origin != "http://" + host):
            raise APIError(403, "ORIGIN_DENIED", "Same-origin request required")
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise APIError(403, "ORIGIN_DENIED", "Cross-site request denied")

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
            if path.startswith("/api/"):
                actor = self.store.actor(self._token())
                routes = {"/api/session": self.store.session, "/api/data": self.store.data, "/api/meta": self.store.meta, "/api/snapshots": self.store.snapshots, "/api/erpnext/status": self.store.erp_status}
                action = routes.get(path)
                if not action:
                    raise APIError(404, "NOT_FOUND", "API endpoint not found")
                self._json(200, action(actor))
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
                token = self.store.login(body.get("tenantId"), body.get("username"), body.get("password"))
                actor = self.store.actor(token)
                self._json(200, {"ok": True, "user": self.store.session(actor)["user"]}, f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL}")
                return
            if path == "/api/logout":
                self.store.logout(self._token())
                self._json(200, {"ok": True}, f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
                return
            actor = self.store.actor(self._token())
            if path == "/api/changes":
                result = self.store.changes(actor, body.get("expectedVersion"), body.get("changes"), body.get("exchangeRates"), body.get("rateMetas"))
            elif path == "/api/restore":
                result = self.store.restore(actor, body.get("snapshotId"), body.get("expectedVersion"))
            elif path == "/api/erpnext/queue":
                result = self.store.erp_queue(actor, body.get("orderId"), body.get("expectedVersion"))
            else:
                raise APIError(404, "NOT_FOUND", "API endpoint not found")
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


def create_server(runtime, port=3087):
    store = Store(runtime)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.store = store
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3087)
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    args = parser.parse_args()
    with create_server(args.runtime, args.port) as server:
        print(f"Local trade workspace: http://127.0.0.1:{server.server_port}", flush=True)
        print("Loopback only. Production database connections are disabled.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
