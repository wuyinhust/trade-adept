"""Explicit demo routing preserves native sessions without disclosing site secrets."""
import json
from email.message import Message
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server.errors import APIError
from server.frappe_client import FrappeGateway


class DemoLoginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = {'demoMode': True, 'demoTenants': ['grandware', 'example-company'], 'tenants': {
            tenant: {'site': tenant + '.test', 'origin': 'http://127.0.0.1:3088', 'gatewayHmacKey': bytes(range(index * 32, index * 32 + 32)).hex()}
            for index, tenant in enumerate(['grandware', 'example-company', 'unlisted'])
        }}
        self.gateway = self.build(self.config)

    def tearDown(self):
        self.temp.cleanup()

    def build(self, value):
        path = self.root / 'frappe-sites.json'
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return FrappeGateway(self.root)

    def test_only_explicit_demo_ids_are_public(self):
        value = self.gateway.public_login_config()
        self.assertEqual(value, {'demoMode': True, 'demoTenants': ['grandware', 'example-company'], 'emailOnly': False, 'setupRequired': False, 'invitationOnly': True, 'brand': 'Tradept'})
        self.assertEqual(set(self.gateway.sites), {'grandware', 'example-company'})
        for tenant in (None, 'unlisted'):
            with self.assertRaises(APIError):
                self.gateway.login(tenant, 'David', 'unused')
        with self.assertRaises(APIError):
            self.gateway.actor(self.gateway._sign('unlisted', 'a' * 64))

    def test_both_demo_accounts_keep_native_username_and_tenant_binding(self):
        for tenant, username in [('grandware', 'David'), ('example-company', 'demo-admin')]:
            with self.subTest(tenant=tenant):
                headers = Message()
                headers.add_header('Set-Cookie', 'sid=' + 'a' * 64)
                replies = [({}, headers), ({'message': {'result': {'user': {'tenantId': tenant}}, 'csrfToken': 'c' * 64}}, Message())]
                with patch.object(self.gateway, '_request', side_effect=replies) as request:
                    token, result = self.gateway.login(tenant, username, 'synthetic-test-password')
                self.assertEqual(request.call_args_list[0].args[3]['usr'], username)
                self.assertTrue(all(call.args[0] == tenant for call in request.call_args_list))
                self.assertEqual(result['user']['tenantId'], tenant)
                self.assertEqual(self.gateway.actor(token)['tenant'], tenant)

    def test_demo_requires_explicit_unambiguous_configuration(self):
        for override in ({'demoMode': 'true'}, {'demoTenants': []}, {'demoTenants': ['grandware', 'grandware']}, {'demoTenants': ['unknown']}, {'demoMode': False}, {'privateTenant': 'grandware'}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.build({**self.config, **override})
        gateway = self.build({'tenants': self.config['tenants']})
        with self.assertRaises(APIError):
            gateway.public_login_config()
        with self.assertRaises(APIError):
            gateway.login('grandware', 'David', 'unused')

    def test_demo_never_guesses_a_password_reset_site(self):
        with patch.object(self.gateway, '_request') as request, self.assertRaises(APIError) as failure:
            self.gateway.public_auth('forgot-password', {'email': 'person@example.com', 'tenantId': 'grandware'})
        self.assertEqual(failure.exception.code, 'DEMO_EMAIL_UNAVAILABLE')
        request.assert_not_called()
