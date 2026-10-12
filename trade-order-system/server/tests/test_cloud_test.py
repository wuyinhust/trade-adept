"""Cloud-test origin boundary using real loopback HTTP and synthetic SQLite."""
import http.client
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

from server.app import SOURCE_ROOT, PREVIEW_ROOT, create_server, normalize_public_origin
from server.store import Store
from server.tests.test_service import PASSWORD, config


PUBLIC_ORIGIN = "https://tradept.example.test"


class CloudTestOriginTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = tempfile.TemporaryDirectory(prefix="trade-cloud-origin-template-")
        cls.template_path = Store(cls.template.name).path
        Store(cls.template.name).configure(config())

    @classmethod
    def tearDownClass(cls):
        cls.template.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="trade-cloud-origin-")
        self.addCleanup(self.directory.cleanup)
        shutil.copyfile(self.template_path, Path(self.directory.name) / "workspace.sqlite3")
        self.server = create_server(self.directory.name, 0, public_origin=PUBLIC_ORIGIN)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method="GET", path="/api/session", host="tradept.example.test", origin=PUBLIC_ORIGIN, extra=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        self.addCleanup(connection.close)
        headers = {"Host": host}
        if origin is not None:
            headers["Origin"] = origin
        if extra:
            headers.update(extra)
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, None if body is None else json.dumps(body), headers)
        response = connection.getresponse()
        raw = response.read()
        content = json.loads(raw) if "application/json" in response.getheader("Content-Type", "") else raw.decode()
        return response.status, content, dict(response.getheaders())

    def login(self, **kwargs):
        return self.request(method="POST", path="/api/login", body={"tenantId": "one", "username": "admin", "password": PASSWORD}, **kwargs)

    def test_public_mode_keeps_loopback_bind(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_authorized_static_origin_is_served_but_business_still_requires_login(self):
        status, html, _ = self.request(path="/", origin=None)
        self.assertEqual(status, 200)
        self.assertIn("<html", html)
        status, result, _ = self.request(origin=None)
        self.assertEqual(status, 401)
        self.assertEqual(result["code"], "SESSION_REQUIRED")

    def test_localhost_and_unknown_hosts_do_not_bypass_public_host(self):
        for host in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}", "attacker.test", "tradept.example.test:443"):
            with self.subTest(host=host):
                status, result, _ = self.request(host=host, path="/")
                self.assertEqual((status, result["code"]), (403, "HOST_DENIED"))

    def test_forwarded_headers_cannot_authorize_wrong_host_or_origin(self):
        forwarded = {"X-Forwarded-Host": "tradept.example.test", "X-Forwarded-Proto": "https", "Forwarded": 'proto=https;host="tradept.example.test"'}
        status, result, _ = self.request(host="attacker.test", extra=forwarded)
        self.assertEqual((status, result["code"]), (403, "HOST_DENIED"))
        status, result, _ = self.login(origin="http://tradept.example.test", extra=forwarded)
        self.assertEqual((status, result["code"]), (403, "ORIGIN_DENIED"))

    def test_missing_or_cross_origin_login_is_denied_without_creating_session(self):
        for origin in (None, "http://tradept.example.test", "https://attacker.test", PUBLIC_ORIGIN + "/", "null"):
            with self.subTest(origin=origin):
                status, result, headers = self.login(origin=origin)
                self.assertEqual((status, result["code"]), (403, "ORIGIN_DENIED"))
                self.assertNotIn("Set-Cookie", headers)
        with Store(self.directory.name).connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)

    def test_cross_site_fetch_is_denied_even_with_exact_origin(self):
        status, result, _ = self.login(extra={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual((status, result["code"]), (403, "ORIGIN_DENIED"))

    def test_secure_cookie_login_session_and_logout(self):
        status, _, headers = self.login()
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"]
        for flag in ("; Secure", "; HttpOnly", "; SameSite=Strict", "; Path=/"):
            self.assertIn(flag, cookie)
        self.assertNotIn("Domain=", cookie)
        session_cookie = cookie.split(";", 1)[0]
        status, result, _ = self.request(extra={"Cookie": session_cookie})
        self.assertEqual(status, 200)
        self.assertEqual(result["user"]["username"], "admin")
        status, _, headers = self.request(method="POST", path="/api/logout", extra={"Cookie": session_cookie})
        self.assertEqual(status, 200)
        self.assertIn("Max-Age=0; Secure", headers["Set-Cookie"])
        status, _, _ = self.request(extra={"Cookie": session_cookie})
        self.assertEqual(status, 401)

    def test_duplicate_host_headers_are_denied(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        self.addCleanup(connection.close)
        connection.putrequest("GET", "/", skip_host=True)
        connection.putheader("Host", "tradept.example.test")
        connection.putheader("Host", "attacker.test")
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 403)
        self.assertEqual(json.loads(response.read())["code"], "HOST_DENIED")

    def test_duplicate_origin_headers_are_denied(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        self.addCleanup(connection.close)
        connection.putrequest("GET", "/api/session", skip_host=True)
        connection.putheader("Host", "tradept.example.test")
        connection.putheader("Origin", PUBLIC_ORIGIN)
        connection.putheader("Origin", "https://attacker.test")
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 403)
        self.assertEqual(json.loads(response.read())["code"], "ORIGIN_DENIED")


class OriginConfigurationTest(unittest.TestCase):
    def test_canonical_https_origin(self):
        self.assertIsNone(normalize_public_origin(None))
        self.assertEqual(normalize_public_origin("https://Tradept.Example.Test:443/"), PUBLIC_ORIGIN)
        self.assertEqual(normalize_public_origin("https://tradept.example.test:8443"), PUBLIC_ORIGIN + ":8443")

    def test_rejects_untrusted_origin_forms_before_creating_database(self):
        invalid = ("", "http://tradept.example.test", "https://*.example.test", "https://localhost", "https://tradept.localhost", "https://127.0.0.1", "https://[::1]", "https://tradept.example.test/path", "https://user:pass@tradept.example.test", "https://tradept.example.test?", "https://tradept.example.test#", "https://tradept.example.test:0", "https://tradept.example.test:65536", "https://tradept.example.test:bad", " https://tradept.example.test", "https://tradept.example.test\n", "https://tradept.example.test,https://other.test")
        with tempfile.TemporaryDirectory(prefix="trade-cloud-config-") as directory:
            for value in invalid:
                with self.subTest(value=value):
                    with self.assertRaises(ValueError):
                        create_server(directory, 0, public_origin=value)
                    self.assertFalse((Path(directory) / "workspace.sqlite3").exists())

    def test_default_local_mode_remains_same_origin_and_http_cookie(self):
        with tempfile.TemporaryDirectory(prefix="trade-local-cookie-") as directory:
            Store(directory).configure(config())
            server = create_server(directory, 0)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                try:
                    connection.request("POST", "/api/login", json.dumps({"tenantId": "one", "username": "admin", "password": PASSWORD}), {"Origin": f"http://127.0.0.1:{server.server_port}", "Content-Type": "application/json"})
                    response = connection.getresponse()
                    response.read()
                    self.assertEqual(response.status, 200)
                    self.assertNotIn("; Secure", response.getheader("Set-Cookie"))
                finally:
                    connection.close()
            finally:
                server.shutdown()
                server.server_close()


class CloudTestSeedTest(unittest.TestCase):
    def test_fresh_cli_seed_is_fictional_and_persists_in_an_independent_runtime(self):
        source = PREVIEW_ROOT / "seed.json"
        original_digest = hashlib.sha256(source.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory(prefix="trade-cloud-seed-") as directory:
            result = subprocess.run([sys.executable, "-m", "server.cli", "--runtime", directory, "init", "--import", str(source), "--tenant", "grandware"], cwd=SOURCE_ROOT, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("revision 1", result.stdout)
            private_path = Path(directory) / "demo-credentials.json"
            credentials = json.loads(private_path.read_text())
            self.assertEqual(private_path.stat().st_mode & 0o777, 0o600)
            admin = next(item for item in credentials if item["tenantId"] == "grandware" and item["id"] == "U001")
            other = next(item for item in credentials if item["tenantId"] == "example-company" and item["id"] == "EX-ADMIN")
            self.assertNotEqual(admin["password"], other["password"])
            # Re-open SQLite after the CLI exits, rather than inspecting an in-memory seed.
            store = Store(directory)
            actor = store.actor(store.login(admin["tenantId"], admin["username"], admin["password"]))
            payload = store.data(actor)["data"]
            self.assertEqual({key: len(payload[key]) for key in ("orders", "customers", "factories", "shipments", "invoices")}, {"orders": 4, "customers": 4, "factories": 4, "shipments": 4, "invoices": 0})
            self.assertEqual({record["companyId"] for record in payload["orders"]}, {"CO-GR", "CO-GW", "CO-LK", "CO-WY"})
            self.assertEqual({record["id"] for record in payload["orders"]}, {"GR26D001", "WY26D001", "GW26D001", "LK26D001"})
            self.assertTrue(all("DEMO" in record["id"] for key in ("customers", "factories", "shipments") for record in payload[key]))
            self.assertTrue(all("示例" in record["company"] for record in payload["customers"]))
            self.assertEqual(store.meta(actor)["meta"]["version"], 1)
            other_actor = store.actor(store.login(other["tenantId"], other["username"], other["password"]))
            self.assertTrue(all(not records for records in store.data(other_actor)["data"].values()))
            self.assertEqual(store.meta(other_actor)["meta"]["version"], 0)
            self.assertEqual(store.erp_status(actor)["enabled"], False)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_digest)


if __name__ == "__main__":
    unittest.main()
