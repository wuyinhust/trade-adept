import json
from email.message import Message
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server.frappe_client import FrappeGateway
from server.errors import APIError


class PrivateLoginTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        config = root / 'frappe-sites.json'
        config.write_text(json.dumps({'privateTenant': 'enterprise', 'tenants': {
            'enterprise': {'site': 'enterprise.test', 'origin': 'http://127.0.0.1:3088', 'gatewayHmacKey': bytes(range(32)).hex()},
            'legacy': {'site': 'legacy.test', 'origin': 'http://127.0.0.1:3088', 'gatewayHmacKey': bytes(range(32, 64)).hex()},
        }}))
        config.chmod(0o600)
        self.gateway = FrappeGateway(root)

    def tearDown(self):
        self.temp.cleanup()

    def test_no_tenant_picker_or_native_route_disclosure(self):
        self.assertEqual(set(self.gateway.sites), {'enterprise'})
        with patch.object(self.gateway, '_request', return_value=({'message': {'emailOnly': True, 'setupRequired': False, 'bootstrapUser': 'private'}}, Message())):
            self.assertEqual(self.gateway.public_login_config(), {'emailOnly': True, 'setupRequired': False, 'invitationOnly': True, 'brand': 'Tradept'})
        with self.assertRaises(APIError):
            self.gateway.login('legacy', 'a@company.com', 'password')

    def test_email_required_and_native_session_still_validated(self):
        with patch.object(self.gateway, 'public_login_config', return_value={'setupRequired': False}), self.assertRaises(APIError):
            self.gateway.login(None, 'username', 'password')
        headers = Message()
        headers.add_header('Set-Cookie', 'sid=' + 'a' * 64)
        with patch.object(self.gateway, 'public_login_config', return_value={'setupRequired': False}), patch.object(self.gateway, '_request', return_value=({}, headers)) as request, patch.object(self.gateway, '_dispatch', return_value={'result': {'user': {'tenantId': 'enterprise'}, 'emailLoginEnabled': True}}):
            token, _ = self.gateway.login(None, 'A@COMPANY.COM', 'password')
        self.assertEqual(request.call_args.args[3], {'usr': 'a@company.com', 'pwd': 'password'})
        self.assertEqual(self.gateway.actor(token)['tenant'], 'enterprise')

    def test_recovery_forwards_only_fixed_method_and_fields(self):
        with patch.object(self.gateway, '_request', return_value=({'message': {'ok': True}}, Message())) as request:
            self.gateway.public_auth('forgot-password', {'email': 'a@company.com', 'tenantId': 'legacy', 'url': 'https://evil.com'})
        self.assertEqual(request.call_args.args[0], 'enterprise')
        self.assertEqual(request.call_args.args[3], {'email': 'a@company.com'})
        with self.assertRaises(APIError):
            self.gateway.public_auth('arbitrary-rpc', {})

    def test_old_other_tenant_cookie_cannot_restore(self):
        token = self.gateway._sign('legacy', 'a' * 64)
        with self.assertRaises(APIError):
            self.gateway.actor(token)

    def test_initial_account_only_with_native_setup_session(self):
        headers = Message()
        headers.add_header('Set-Cookie', 'sid=' + 'a' * 64)
        with patch.object(self.gateway, 'public_login_config', return_value={'setupRequired': True}), patch.object(self.gateway, '_request', return_value=({}, headers)), patch.object(self.gateway, '_dispatch') as dispatch:
            dispatch.return_value = {'result': {'user': {'tenantId': 'enterprise'}, 'emailLoginEnabled': False, 'loginSetupRequired': True}}
            _, result = self.gateway.login(None, 'initial-admin', 'private-password')
            self.assertTrue(result['ok'])
            dispatch.return_value['result']['loginSetupRequired'] = False
            with self.assertRaises(APIError):
                self.gateway.login(None, 'legacy-user', 'private-password')

    def test_invalid_public_mode_fails_closed(self):
        with patch.object(self.gateway, '_request', return_value=({'message': {'emailOnly': False, 'setupRequired': False}}, Message())), self.assertRaises(APIError):
            self.gateway.public_login_config()

    def test_configured_account_login_requires_native_ready_signal(self):
        native = {'emailOnly': False, 'setupRequired': False, 'mode': 'accounts',
                  'loginPolicyReady': True, 'emailVerificationRequired': False,
                  'passwordRecoveryAvailable': False,
                  'bootstrapUser': 'private-identity'}
        with patch.object(self.gateway, '_request', return_value=({'message': native}, Message())):
            public = self.gateway.public_login_config()
        self.assertEqual(public['mode'], 'accounts')
        self.assertTrue(public['loginPolicyReady'])
        self.assertFalse(public['emailVerificationRequired'])
        self.assertFalse(public['passwordRecoveryAvailable'])
        self.assertNotIn('bootstrapUser', public)
        for changes in ({'loginPolicyReady': False}, {'mode': 'unconfigured'}, {'setupRequired': True, 'emailOnly': True}):
            with self.subTest(changes=changes), patch.object(self.gateway, '_request', return_value=({'message': {**native, **changes}}, Message())), self.assertRaises(APIError):
                self.gateway.public_login_config()

    def test_account_login_after_initialization_still_checks_native_session(self):
        headers = Message()
        headers.add_header('Set-Cookie', 'sid=' + 'a' * 64)
        native = {'user': {'tenantId': 'enterprise'}, 'emailLoginEnabled': False,
                  'loginSetupRequired': False, 'loginPolicyReady': True}
        config = {'setupRequired': False, 'emailOnly': False, 'mode': 'accounts', 'loginPolicyReady': True}
        with patch.object(self.gateway, 'public_login_config', return_value=config), patch.object(self.gateway, '_request', return_value=({}, headers)) as request, patch.object(self.gateway, '_dispatch', return_value={'result': native}) as dispatch:
            token, result = self.gateway.login(None, 'initial-admin', 'private-password')
            self.assertTrue(result['ok'])
            self.assertEqual(self.gateway.actor(token)['tenant'], 'enterprise')
            self.assertEqual(request.call_args.args[3]['usr'], 'initial-admin')
            dispatch.return_value = {'result': {**native, 'loginPolicyReady': False}}
            with self.assertRaises(APIError):
                self.gateway.login(None, 'initial-admin', 'private-password')
