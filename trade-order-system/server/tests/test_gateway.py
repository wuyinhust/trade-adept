"""Gateway protocol/security tests. Real native business acceptance is separate."""
import base64
from email.message import Message
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from server.app import create_server, normalize_public_origin
from server.errors import APIError
from server.frappe_client import DISPATCH, FrappeGateway, NoRedirect, normalize_backend_origin


class Response(BytesIO):
    def __init__(self, value, status=200, headers=None):
        super().__init__(json.dumps(value).encode())
        self.status = status
        self.headers = headers or Message()


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.runtime = Path(self.directory.name)
        self.config = self.runtime / 'frappe-sites.json'
        self.write_config({'tenants': {
            'grandware': {'origin': 'http://127.0.0.1:3088', 'site': 'grandware.test'},
            'example-company': {'origin': 'http://127.0.0.1:3088', 'site': 'frontend'},
        }})
        self.gateway = FrappeGateway(self.runtime)
        self.sid = 'a' * 64
        self.token = self.gateway._sign('grandware', self.sid)

    def tearDown(self):
        self.directory.cleanup()

    def write_config(self, value):
        self.config.write_text(json.dumps(value))
        os.chmod(self.config, 0o600)

    def test_tenant_cookie_tampering_cannot_select_another_site(self):
        encoded, signature = self.token.split('.')
        value = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        value['tenant'] = 'example-company'
        altered = base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=') + '.' + signature
        with self.assertRaises(APIError) as error:
            self.gateway.actor(altered)
        self.assertEqual(error.exception.status, 401)

    def test_expired_cookie_is_not_accepted(self):
        with patch('server.frappe_client.time.time', return_value=time.time() - 9 * 3600):
            expired = self.gateway._sign('grandware', self.sid)
        with self.assertRaises(APIError):
            self.gateway.actor(expired)

    def test_signing_secret_persists_without_creating_business_database(self):
        reopened = FrappeGateway(self.runtime)
        self.assertEqual(reopened.actor(self.token)['tenant'], 'grandware')
        self.assertEqual(set(path.name for path in self.runtime.iterdir()), {'routing-secret', 'frappe-sites.json'})
        self.assertEqual((self.runtime / 'routing-secret').stat().st_mode & 0o777, 0o600)

    def test_tenants_cannot_share_database_site(self):
        self.write_config({'tenants': {
            'a': {'origin': 'http://127.0.0.1:3088', 'site': 'frontend'},
            'b': {'origin': 'http://127.0.0.1:3088', 'site': 'frontend'},
        }})
        with self.assertRaises(ValueError):
            FrappeGateway(self.runtime)

    def test_world_readable_configuration_rejected(self):
        os.chmod(self.config, 0o644)
        with self.assertRaises(ValueError):
            FrappeGateway(self.runtime)

    def test_native_login_and_context_use_fixed_site(self):
        calls = []
        headers = Message()
        headers.add_header('Set-Cookie', 'sid=' + self.sid + '; HttpOnly')
        def request(req, timeout):
            calls.append(req)
            if req.full_url.endswith('/login'):
                return Response({'message': 'Logged In'}, headers=headers)
            return Response({'message': {'result': {'user': {'id': 'U001', 'tenantId': 'grandware'}}, 'csrfToken': 'c' * 64}})
        with patch.object(self.gateway.opener, 'open', side_effect=request):
            token, result = self.gateway.login('grandware', 'David', 'private-password')
        self.assertTrue(result['ok'])
        self.assertEqual(self.gateway.actor(token)['sid'], self.sid)
        for req in calls:
            self.assertEqual(req.get_header('X-frappe-site-name'), 'grandware.test')
            self.assertTrue(req.full_url.startswith('http://127.0.0.1:3088/'))
        self.assertEqual(calls[1].get_header('Cookie'), 'sid=' + self.sid)

    def test_guest_sid_never_creates_routing_session(self):
        headers = Message()
        headers.add_header('Set-Cookie', 'sid=Guest')
        with patch.object(self.gateway.opener, 'open', return_value=Response({'message': 'Logged In'}, headers=headers)):
            with self.assertRaises(APIError) as error:
                self.gateway.login('grandware', 'David', 'password')
        self.assertEqual(error.exception.code, 'LOGIN_FAILED')

    def test_misrouted_site_cannot_sign_in_to_another_tenants_workspace(self):
        headers = Message()
        headers.add_header('Set-Cookie', 'sid=' + self.sid)
        replies = [Response({'message': 'Logged In'}, headers=headers), Response({'message': {'result': {'user': {'id': 'U001', 'tenantId': 'example-company'}}, 'csrfToken': 'c' * 64}})]
        with patch.object(self.gateway.opener, 'open', side_effect=replies):
            with self.assertRaises(APIError) as error:
                self.gateway.login('grandware', 'David', 'password')
        self.assertEqual(error.exception.code, 'TENANT_ROUTING_MISMATCH')

    def test_native_revocation_is_not_bypassed_by_valid_routing_cookie(self):
        denied = Response({'message': {'result': {'code': 'SESSION_REQUIRED', 'error': 'Please sign in'}}}, 401)
        with patch.object(self.gateway.opener, 'open', return_value=denied):
            with self.assertRaises(APIError) as error:
                self.gateway.read(self.gateway.actor(self.token), 'data')
        self.assertEqual(error.exception.status, 401)

    def test_csrf_and_entire_change_set_go_to_one_native_transaction(self):
        calls = []
        payload = {'expectedVersion': 12, 'changes': [{'collection': 'orders', 'id': 'A', 'value': {'remarks': 'new'}}, {'collection': 'orders', 'id': 'B', 'value': {'remarks': 'new'}}]}
        def request(req, timeout):
            calls.append(req)
            if req.get_method() == 'GET':
                return Response({'message': {'result': {'user': {'tenantId': 'grandware'}}, 'csrfToken': 'c' * 64}})
            return Response({'message': {'result': {'ok': True, 'meta': {'version': 13}}}})
        with patch.object(self.gateway.opener, 'open', side_effect=request):
            result = self.gateway.write(self.gateway.actor(self.token), 'changes', payload)
        self.assertEqual(result['meta']['version'], 13)
        self.assertEqual(len(calls), 2)
        mutation = calls[1]
        self.assertEqual(mutation.full_url, 'http://127.0.0.1:3088' + DISPATCH)
        self.assertEqual(mutation.get_header('X-frappe-csrf-token'), 'c' * 64)
        fields = json.loads(mutation.data)
        self.assertEqual(fields['action'], 'changes')
        self.assertEqual(json.loads(fields['payload']), payload)

    def test_conflict_survives_gateway_with_current_version(self):
        with patch.object(self.gateway.opener, 'open', return_value=Response({'message': {'result': {'code': 'VERSION_CONFLICT', 'error': 'Review your draft', 'latestVersion': 9}}}, 409)):
            with self.assertRaises(APIError) as error:
                self.gateway.read(self.gateway.actor(self.token), 'meta')
        self.assertEqual(error.exception.response(), {'code': 'VERSION_CONFLICT', 'error': 'Review your draft', 'latestVersion': 9})

    def test_lost_write_response_is_not_retried_or_reported_as_unsaved(self):
        calls = []
        def request(req, timeout):
            calls.append(req.get_method())
            if req.get_method() == 'GET':
                return Response({'message': {'result': {'user': {'tenantId': 'grandware'}}, 'csrfToken': 'c' * 64}})
            # A native transaction may have committed before the response was
            # lost. The transport cannot infer rollback or replay this write.
            raise TimeoutError('response lost')
        with patch.object(self.gateway.opener, 'open', side_effect=request):
            with self.assertRaises(APIError) as error:
                self.gateway.write(self.gateway.actor(self.token), 'restore', {'expectedVersion': 2, 'snapshotId': 'S1'})
        self.assertEqual(calls, ['GET', 'POST'])
        self.assertEqual(error.exception.status, 503)
        self.assertIn('unconfirmed', error.exception.response()['error'])
        self.assertIn('refresh', error.exception.response()['error'])

    def test_backend_failure_has_no_local_fallback(self):
        with patch.object(self.gateway.opener, 'open', side_effect=URLError('private network details')):
            with self.assertRaises(APIError) as error:
                self.gateway.read(self.gateway.actor(self.token), 'data')
        self.assertEqual(error.exception.status, 503)
        self.assertNotIn('private network', str(error.exception))
        self.assertFalse((self.runtime / 'workspace.sqlite3').exists())

    def test_upstream_traces_and_html_are_not_forwarded(self):
        with patch.object(self.gateway.opener, 'open', return_value=Response({'exc': 'private stack and SQL password', '_server_messages': 'secret'}, 500)):
            with self.assertRaises(APIError) as error:
                self.gateway.read(self.gateway.actor(self.token), 'data')
        self.assertNotIn('secret', json.dumps(error.exception.response()))

    def test_redirect_does_not_forward_native_credentials(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://another.example'))

    def test_private_origins_and_header_injection_rejected(self):
        for origin in ('http://public.example', 'http://192.168.0.1', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?secret=x', 'https://example.com\r\nHeader:x'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                normalize_backend_origin(origin)
        self.assertEqual(normalize_backend_origin('http://127.0.0.1:3088'), 'http://127.0.0.1:3088')


class HTTPBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.gateway = type('Stub', (), {})()
        self.gateway.actor = lambda token: {'tenant': 'grandware'}
        self.gateway.read = lambda actor, action: {'ok': True, 'action': action}
        self.gateway.write = lambda actor, action, payload: {'ok': True, 'action': action, 'expectedVersion': payload.get('expectedVersion')}
        self.server = create_server(Path(self.directory.name), 0, gateway=self.gateway)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, body=None, origin=True, extra=None):
        headers = extra or {}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if origin:
            headers['Origin'] = self.origin
        request = Request(self.origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def test_cross_origin_write_rejected_before_native_action(self):
        status, value = self.request('/api/changes', {'expectedVersion': 1}, origin=False)
        self.assertEqual((status, value['code']), (403, 'ORIGIN_DENIED'))

    def test_no_arbitrary_native_rest_proxy_or_old_queue(self):
        for path in ('/api/resource/User', '/api/erpnext/queue'):
            with self.subTest(path=path):
                status, _value = self.request(path, {'expectedVersion': 1})
                self.assertEqual(status, 404)

    def test_native_order_action_preserves_expected_version(self):
        status, result = self.request('/api/orders/convert', {'expectedVersion': 7, 'orderId': 'A'})
        self.assertEqual(status, 200)
        self.assertEqual(result['action'], 'convert_order')
        self.assertEqual(result['expectedVersion'], 7)

    def test_static_secrets_and_source_are_not_served(self):
        for path in ('/server/frappe-sites.example.json', '/server/app.py', '/integrations/frappe_app/tradept_core/api.py', '/js/tcb.js'):
            with self.subTest(path=path):
                status, result = self.request(path)
                self.assertEqual(status, 404)

    def test_public_https_cookie_and_fixed_origin(self):
        self.server.public_origin = normalize_public_origin('https://tradept-test.szkuohu.com')
        self.assertIn('; Secure', self.server.RequestHandlerClass._session_cookie(type('H', (), {'server': self.server})(), 'value', 30))
        status, value = self.request('/api/data')
        self.assertEqual((status, value['code']), (403, 'HOST_DENIED'))


if __name__ == '__main__':
    unittest.main()
