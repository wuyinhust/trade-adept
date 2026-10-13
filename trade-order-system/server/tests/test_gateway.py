"""Gateway protocol/security tests. Real native business acceptance is separate."""
import base64
from email.message import Message
import hashlib
import hmac
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from server.app import create_server, normalize_public_origin
from server.cli import main as cli_main
from server.errors import APIError
from server.exchange_rate import ExchangeRateService, NoRedirect as RateNoRedirect
from server.frappe_client import DISPATCH, FrappeGateway, NoRedirect, canonical_json, needs_live_exchange_rate, normalize_backend_origin


KEY_A = bytes(range(32)).hex()
KEY_B = bytes(range(32, 64)).hex()


class Response(BytesIO):
    def __init__(self, value, status=200, headers=None):
        super().__init__(json.dumps(value).encode())
        self.status = status
        self.headers = headers or Message()


class SequenceOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.runtime = Path(self.directory.name)
        self.config = self.runtime / 'frappe-sites.json'
        self.write_config({'demoMode': True, 'demoTenants': ['grandware', 'example-company'], 'tenants': {
            'grandware': {'origin': 'http://127.0.0.1:3088', 'site': 'grandware.test', 'gatewayHmacKey': KEY_A},
            'example-company': {'origin': 'http://127.0.0.1:3088', 'site': 'frontend', 'gatewayHmacKey': KEY_B},
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
            'a': {'origin': 'http://127.0.0.1:3088', 'site': 'frontend', 'gatewayHmacKey': KEY_A},
            'b': {'origin': 'http://127.0.0.1:3088', 'site': 'frontend', 'gatewayHmacKey': KEY_B},
        }})
        with self.assertRaises(ValueError):
            FrappeGateway(self.runtime)

    def test_each_tenant_requires_an_independent_strong_gateway_key(self):
        for first, second in ((None, KEY_B), ('0' * 64, KEY_B), (KEY_A, KEY_A)):
            with self.subTest(first=first, duplicate=first == second):
                self.write_config({'tenants': {
                    'a': {'origin': 'http://127.0.0.1:3088', 'site': 'a.test', 'gatewayHmacKey': first},
                    'b': {'origin': 'http://127.0.0.1:3088', 'site': 'b.test', 'gatewayHmacKey': second},
                }})
                with self.assertRaises(ValueError):
                    FrappeGateway(self.runtime)

    def test_cli_installs_private_hmac_enabled_routing_configuration(self):
        target = self.runtime / 'installed'
        source = self.runtime / 'source.json'
        source.write_text(json.dumps({'tenants': {
            'grandware': {'origin': 'http://127.0.0.1:3088', 'site': 'grandware.test', 'gatewayHmacKey': KEY_A},
        }}))
        argv = ['tradept-gateway', '--runtime', str(target), 'init', '--sites', str(source)]
        with patch.object(sys, 'argv', argv), patch('builtins.print'):
            cli_main()
        installed = target / 'frappe-sites.json'
        self.assertEqual(installed.stat().st_mode & 0o777, 0o600)
        self.assertEqual(FrappeGateway(target).sites['grandware']['gatewayHmacKey'], bytes.fromhex(KEY_A))

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

    def test_convert_order_uses_gateway_rate_and_overwrites_client_claims(self):
        calls = []
        live = {
            'base': 'USD', 'quote': 'CNY', 'rawRate': 7.25, 'adjustment': -0.02,
            'adjustedRate': 7.23, 'provider': 'ExchangeRate-API', 'source': 'open.er-api.com',
            'publishedAt': '2027-01-15T07:00:00Z', 'fetchedAt': '2027-01-15T07:05:00Z',
            'nextUpdateAt': '2027-01-16T07:00:00Z', 'cached': True, 'stale': False,
        }
        self.gateway.exchange_rates = type('Rates', (), {'get': lambda _self: dict(live)})()
        supplied = {'orderId': 'A', 'liveExchangeRate': 99, 'liveExchangeRateMeta': {'source': 'browser'}}

        def request(req, timeout):
            calls.append(req)
            if req.get_method() == 'GET':
                return Response({'message': {'result': {'user': {'tenantId': 'grandware'}}, 'csrfToken': 'c' * 64}})
            return Response({'message': {'result': {'ok': True}}})

        with patch.object(self.gateway.opener, 'open', side_effect=request):
            result = self.gateway.write(self.gateway.actor(self.token), 'convert_order', supplied)

        self.assertTrue(result['ok'])
        forwarded = json.loads(json.loads(calls[1].data)['payload'])
        self.assertEqual(forwarded['liveExchangeRate'], 7.23)
        self.assertEqual(forwarded['liveExchangeRateMeta'], live)
        assertion = forwarded['gatewayAssertion']
        claims = assertion['claims']
        self.assertEqual((claims['site'], claims['tenant'], claims['action']), ('grandware.test', 'grandware', 'convert_order'))
        self.assertEqual(claims['session'], hashlib.sha256(self.sid.encode()).hexdigest())
        unsigned = {key: value for key, value in forwarded.items() if key != 'gatewayAssertion'}
        self.assertEqual(claims['payloadSha256'], hashlib.sha256(canonical_json(unsigned).encode()).hexdigest())
        expected_signature = hmac.new(bytes.fromhex(KEY_A), canonical_json(claims).encode(), hashlib.sha256).hexdigest()
        self.assertTrue(hmac.compare_digest(assertion['signature'], expected_signature))
        self.assertEqual(supplied['liveExchangeRate'], 99, 'gateway must not mutate the caller payload')

    def test_financial_order_change_uses_gateway_rate_but_plain_note_does_not(self):
        calls = []
        live = {
            'base': 'USD', 'quote': 'CNY', 'rawRate': 7.25, 'adjustment': -0.02,
            'adjustedRate': 7.23, 'provider': 'ExchangeRate-API', 'source': 'open.er-api.com',
            'publishedAt': '2027-01-15T07:00:00Z', 'fetchedAt': '2027-01-15T07:05:00Z',
            'nextUpdateAt': '2027-01-16T07:00:00Z', 'cached': True, 'stale': False,
        }

        def request(req, timeout):
            calls.append(req)
            if req.get_method() == 'GET':
                return Response({'message': {'result': {'user': {'tenantId': 'grandware'}}, 'csrfToken': 'c' * 64}})
            return Response({'message': {'result': {'ok': True, 'meta': {'version': 13}}}})

        financial = {'expectedVersion': 12, 'changes': [{'collection': 'orders', 'id': 'A', 'value': {'orderAmountUSD': 1000}}]}
        note = {'expectedVersion': 13, 'changes': [{'collection': 'orders', 'id': 'A', 'value': {'remarks': 'new'}}]}
        with patch.object(self.gateway, 'current_exchange_rate', return_value=live) as current, patch.object(self.gateway.opener, 'open', side_effect=request):
            self.gateway.write(self.gateway.actor(self.token), 'changes', financial)
            self.gateway.write(self.gateway.actor(self.token), 'changes', note)

        financial_forwarded = json.loads(json.loads(calls[1].data)['payload'])
        note_forwarded = json.loads(json.loads(calls[3].data)['payload'])
        self.assertEqual(financial_forwarded['liveExchangeRate'], 7.23)
        self.assertEqual(financial_forwarded['liveExchangeRateMeta'], live)
        self.assertIn('gatewayAssertion', financial_forwarded)
        self.assertNotIn('liveExchangeRate', note_forwarded)
        self.assertNotIn('gatewayAssertion', note_forwarded)
        current.assert_called_once_with()

    def test_stale_rate_is_visible_to_reads_but_rejected_for_financial_writes(self):
        stale = {
            'base': 'USD', 'quote': 'CNY', 'rawRate': 7.25, 'adjustment': -0.02,
            'adjustedRate': 7.23, 'provider': 'ExchangeRate-API', 'source': 'open.er-api.com',
            'publishedAt': '2027-01-15T07:00:00Z', 'fetchedAt': '2027-01-15T07:05:00Z',
            'nextUpdateAt': '2027-01-16T07:00:00Z', 'cached': True, 'stale': True,
        }
        calls = []
        def request(req, timeout):
            calls.append(req)
            return Response({'message': {'result': {'user': {'tenantId': 'grandware'}}, 'csrfToken': 'c' * 64}})
        self.gateway.exchange_rates = type('Rates', (), {'get': lambda _self: dict(stale)})()
        with patch.object(self.gateway.opener, 'open', side_effect=request):
            self.assertEqual(self.gateway.current_exchange_rate()['stale'], True)
            with self.assertRaises(APIError) as caught:
                self.gateway.write(self.gateway.actor(self.token), 'changes', {
                    'expectedVersion': 1,
                    'changes': [{'collection': 'orders', 'id': 'A', 'value': {'orderAmountUSD': 100}}],
                })
        self.assertEqual((caught.exception.status, caught.exception.code), (503, 'LIVE_RATE_STALE'))
        self.assertEqual(len(calls), 1, 'stale financial write stops before native POST')

    def test_nested_payment_status_changes_require_live_rate_assertion(self):
        for field in ('paymentStatus', 'costPaymentStatus'):
            payload = {'changes': [{'collection': 'orders', 'id': 'A', 'value': {'factories': [{'factoryId': 'F', field: 'paid'}]}}]}
            with self.subTest(field=field):
                self.assertTrue(needs_live_exchange_rate('changes', payload))

    def test_administrator_save_does_not_depend_on_live_rate_or_forward_browser_assertions(self):
        calls = []

        def request(req, timeout):
            calls.append(req)
            if req.get_method() == 'GET':
                return Response({'message': {'result': {'user': {'tenantId': 'grandware'}}, 'csrfToken': 'c' * 64}})
            return Response({'message': {'result': {'meta': {'version': 14}}}})

        supplied = {
            'expectedVersion': 13, 'resource': 'enterprise', 'value': {'name': 'Grandware'},
            'liveExchangeRate': 99, 'liveExchangeRateMeta': {'source': 'browser'},
            'gatewayAssertion': {'signature': 'browser'},
        }
        with patch.object(self.gateway, 'current_exchange_rate', side_effect=APIError(503, 'EXCHANGE_RATE_UNAVAILABLE', 'unavailable')) as current, \
                patch.object(self.gateway.opener, 'open', side_effect=request):
            result = self.gateway.write(self.gateway.actor(self.token), 'admin_update', supplied)

        self.assertEqual(result['meta']['version'], 14)
        self.assertEqual([req.get_method() for req in calls], ['GET', 'POST'])
        forwarded = json.loads(json.loads(calls[1].data)['payload'])
        self.assertEqual(forwarded, {'expectedVersion': 13, 'resource': 'enterprise', 'value': {'name': 'Grandware'}})
        current.assert_not_called()

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

    def test_finance_report_uses_native_csrf_and_keeps_scoped_payload(self):
        payload = {'companyId': 'CO-1', 'report': 'receivables', 'filters': {'report_date': '2026-10-13'}}
        replies = [Response({'message': {'result': {'user': {'tenantId': 'grandware'}}, 'csrfToken': 'c' * 64}}),
                   Response({'message': {'result': {'columns': [], 'data': [], 'currency': 'USD'}}})]
        opener = SequenceOpener(replies)
        self.gateway.opener = opener
        result = self.gateway.read(self.gateway.actor(self.token), 'finance_report', payload)
        self.assertEqual(result['currency'], 'USD')
        first, second = [entry[0] for entry in opener.requests]
        self.assertEqual(first.get_method(), 'GET')
        self.assertEqual(second.get_header('X-frappe-csrf-token'), 'c' * 64)
        self.assertEqual(second.get_header('X-frappe-site-name'), 'grandware.test')
        fields = json.loads(second.data)
        self.assertEqual(fields['action'], 'finance_report')
        self.assertEqual(json.loads(fields['payload']), payload)

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


class ExchangeRateServiceTest(unittest.TestCase):
    def success(self, rate=7.25, published=1_800_000_000, next_update=1_800_003_600):
        return Response({
            'result': 'success',
            'base_code': 'USD',
            'time_last_update_unix': published,
            'time_next_update_unix': next_update,
            'rates': {'CNY': rate},
        })

    def test_caches_until_provider_next_update_then_refreshes(self):
        now = [1_800_000_100]
        opener = SequenceOpener([
            self.success(),
            self.success(rate=7.3, published=1_800_003_600, next_update=1_800_007_200),
        ])
        service = ExchangeRateService(opener=opener, clock=lambda: now[0])

        first = service.get()
        cached = service.get()
        now[0] = 1_800_003_601
        refreshed = service.get()

        self.assertEqual((first['rawRate'], first['adjustedRate'], first['cached'], first['stale']), (7.25, 7.23, False, False))
        self.assertEqual((cached['cached'], cached['fetchedAt']), (True, first['fetchedAt']))
        self.assertEqual((refreshed['rawRate'], refreshed['adjustedRate'], refreshed['cached']), (7.3, 7.28, False))
        self.assertEqual([item[0].full_url for item in opener.requests], [
            'https://open.er-api.com/v6/latest/USD',
            'https://open.er-api.com/v6/latest/USD',
        ])

    def test_failed_refresh_returns_stale_cache_and_applies_retry_backoff(self):
        now = [1_800_000_100]
        opener = SequenceOpener([
            self.success(next_update=1_800_000_200),
            URLError('private DNS failure'),
            URLError('private fallback failure'),
        ])
        service = ExchangeRateService(opener=opener, clock=lambda: now[0])
        original = service.get()
        now[0] = 1_800_000_201

        stale = service.get()
        repeated = service.get()

        self.assertEqual((stale['rawRate'], stale['cached'], stale['stale']), (original['rawRate'], True, True))
        self.assertEqual((repeated['cached'], repeated['stale']), (True, True))
        self.assertEqual(len(opener.requests), 3, 'retry backoff prevents one upstream attempt per page request')

    def test_past_provider_schedule_is_stale_without_request_loop(self):
        now = 1_800_000_100
        opener = SequenceOpener([self.success(next_update=1_800_000_050)])
        service = ExchangeRateService(opener=opener, clock=lambda: now)

        first = service.get()
        repeated = service.get()

        self.assertTrue(first['stale'])
        self.assertEqual((repeated['cached'], repeated['stale']), (True, True))
        self.assertEqual(len(opener.requests), 1)

    def test_falls_back_to_v4_with_derived_next_check(self):
        now = 1_800_000_100
        opener = SequenceOpener([
            URLError('primary unavailable'),
            Response({'base': 'USD', 'date': '2027-01-15', 'rates': {'CNY': 7.25}}),
        ])
        result = ExchangeRateService(opener=opener, clock=lambda: now).get()
        self.assertEqual(result['source'], 'api.exchangerate-api.com')
        self.assertEqual(result['provider'], 'ExchangeRate-API')
        self.assertIsNotNone(result['publishedAt'])
        self.assertGreater(result['nextUpdateAt'], result['fetchedAt'])

    def test_rejects_unreasonably_distant_next_update_and_uses_v4(self):
        now = 1_800_000_100
        opener = SequenceOpener([
            self.success(next_update=now + 365 * 24 * 60 * 60),
            Response({
                'base': 'USD',
                'time_last_updated': now - 100,
                'time_next_update_unix': now + 3600,
                'rates': {'CNY': 7.25},
            }),
        ])
        result = ExchangeRateService(opener=opener, clock=lambda: now).get()
        self.assertEqual(result['source'], 'api.exchangerate-api.com')
        self.assertEqual(len(opener.requests), 2)

    def test_malformed_rate_collections_use_fallback_instead_of_crashing(self):
        now = 1_800_000_100
        for rates in (None, [], 'invalid'):
            with self.subTest(rates=rates):
                primary = Response({
                    'result': 'success', 'base_code': 'USD',
                    'time_last_update_unix': now - 100,
                    'time_next_update_unix': now + 3600, 'rates': rates,
                })
                opener = SequenceOpener([
                    primary,
                    Response({'base': 'USD', 'time_last_updated': now - 100, 'rates': {'CNY': 7.25}}),
                ])
                result = ExchangeRateService(opener=opener, clock=lambda: now).get()
                self.assertEqual(result['source'], 'api.exchangerate-api.com')
                self.assertEqual(len(opener.requests), 2)

    def test_rejects_implausibly_future_or_old_publications(self):
        now = 1_800_000_100
        for published in (now + 601, now - 7 * 24 * 60 * 60 - 1):
            with self.subTest(published=published):
                opener = SequenceOpener([
                    self.success(published=published, next_update=now + 3600),
                    URLError('fallback unavailable'),
                ])
                with self.assertRaises(APIError):
                    ExchangeRateService(opener=opener, clock=lambda: now).get()
                self.assertEqual(len(opener.requests), 2)

    def test_no_cache_failure_is_sanitized_and_redirects_are_disabled(self):
        opener = SequenceOpener([URLError('secret primary detail'), URLError('secret fallback detail')])
        service = ExchangeRateService(opener=opener, clock=lambda: 1_800_000_100)
        errors = []
        for _attempt in range(2):
            with self.assertRaises(APIError) as error:
                service.get()
            errors.append(error.exception.response())
        expected = {
            'error': 'Live exchange rate is temporarily unavailable',
            'code': 'EXCHANGE_RATE_UNAVAILABLE',
        }
        self.assertEqual(errors, [expected, expected])
        self.assertEqual(len(opener.requests), 2, 'initial failure backoff must suppress a second provider chain')
        self.assertIsNone(RateNoRedirect().redirect_request(None, None, 302, '', {}, 'https://attacker.example'))

    def test_concurrent_cache_miss_makes_one_upstream_request(self):
        opener = SequenceOpener([self.success()])
        service = ExchangeRateService(opener=opener, clock=lambda: 1_800_000_100)
        barrier = threading.Barrier(6)
        results = []

        def load():
            barrier.wait()
            results.append(service.get())

        threads = [threading.Thread(target=load) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(sum(not value['cached'] for value in results), 1)


class HTTPBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.gateway = type('Stub', (), {})()
        self.gateway.actor = lambda token: {'tenant': 'grandware'}
        self.gateway.read = lambda actor, action, payload=None: {'ok': True, 'action': action, 'payload': payload}
        self.gateway.write = lambda actor, action, payload: {'ok': True, 'action': action, 'expectedVersion': payload.get('expectedVersion')}
        self.rate_calls = 0

        class Rates:
            def get(inner):
                self.rate_calls += 1
                return {'base': 'USD', 'quote': 'CNY', 'rawRate': 7.25, 'adjustment': -0.02,
                        'adjustedRate': 7.23, 'provider': 'ExchangeRate-API', 'source': 'open.er-api.com',
                        'publishedAt': '2027-01-15T07:00:00Z', 'fetchedAt': '2027-01-15T07:05:00Z',
                        'nextUpdateAt': '2027-01-16T07:00:00Z', 'cached': True, 'stale': False}

        self.rates = Rates()
        self.server = create_server(Path(self.directory.name), 0, gateway=self.gateway, exchange_rates=self.rates)
        self.assertIs(self.server.exchange_rates, self.rates)
        self.assertIs(self.gateway.exchange_rates, self.rates)
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

    def test_finance_routes_are_scoped_and_do_not_accept_native_method_names(self):
        status, value = self.request('/api/finance/state?companyId=CO-1&resource=sales_invoice&offset=5')
        self.assertEqual((status, value['action']), (200, 'finance_state'))
        self.assertEqual(value['payload'], {'companyId': 'CO-1', 'resource': 'sales_invoice', 'offset': 5})
        for query in ('companyId=CO-1&companyId=CO-2', 'method=frappe.get_doc', 'doctype=User', 'limit=Infinity', 'offset=-1'):
            with self.subTest(query=query):
                status, value = self.request('/api/finance/document?' + query)
                self.assertEqual((status, value['code']), (400, 'INVALID_QUERY'))
        report = {'companyId': 'CO-1', 'report': 'payables', 'filters': {'report_date': '2026-10-13'}}
        status, value = self.request('/api/finance/report', report)
        self.assertEqual((status, value['action'], value['payload']), (200, 'finance_report', report))
        status, value = self.request('/api/finance/operation', {'expectedVersion': 3})
        self.assertEqual((status, value['action']), (200, 'finance_operation'))

    def test_finance_post_reads_and_writes_require_same_origin(self):
        for path in ('/api/finance/report', '/api/finance/operation'):
            status, value = self.request(path, {'companyId': 'CO-1'}, origin=False)
            self.assertEqual((status, value['code']), (403, 'ORIGIN_DENIED'))

    def test_catalog_route_preserves_scoped_values_and_rejects_native_parameters(self):
        status, value = self.request('/api/catalog/state?companyId=CO-1&includeDisabled=1&offset=4&name=A%26B')
        self.assertEqual((status, value['action']), (200, 'catalog_state'))
        self.assertEqual(value['payload'], {'companyId': 'CO-1', 'includeDisabled': True, 'offset': 4, 'name': 'A&B'})
        for query in ('companyId=CO-1&companyId=CO-2', 'doctype=User', 'method=frappe.client.insert', 'limit=Infinity', 'offset=-1', 'includeDisabled=yes'):
            with self.subTest(query=query):
                status, value = self.request('/api/catalog/state?' + query)
                self.assertEqual((status, value['code']), (400, 'INVALID_QUERY'))
        request = {'companyId': 'CO-1', 'operation': 'create', 'expectedVersion': 4, 'idempotencyKey': 'stable-item'}
        forwarded = []
        self.gateway.write = lambda actor, action, payload: forwarded.append((action, payload)) or {'ok': True, 'action': action}
        status, value = self.request('/api/catalog/operation', request)
        self.assertEqual((status, value['action']), (200, 'catalog_operation'))
        self.assertEqual(forwarded, [('catalog_operation', request)])
        status, value = self.request('/api/catalog/operation', request, origin=False)
        self.assertEqual((status, value['code']), (403, 'ORIGIN_DENIED'))
        self.assertEqual(len(forwarded), 1)

    def test_version_readback_has_no_tenant_data_or_login_dependency(self):
        self.gateway.actor = lambda token: (_ for _ in ()).throw(AssertionError('release read must not open a session'))
        status, value = self.request('/api/version')
        self.assertEqual(status, 200)
        self.assertEqual(value['version'], self.server.release_info['version'])
        self.assertEqual(set(value), {'version', 'environment', 'sourceCommit', 'sourceManifestSHA256'})

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

    def test_administrator_routes_keep_read_and_versioned_write_separate(self):
        read_status, current = self.request('/api/administrator')
        write_status, saved = self.request('/api/administrator', {
            'expectedVersion': 7, 'resource': 'enterprise', 'value': {'name': 'Example'},
        })
        self.assertEqual((read_status, current['action']), (200, 'admin_state'))
        self.assertEqual((write_status, saved['action'], saved['expectedVersion']), (200, 'admin_update', 7))

    def test_exchange_rate_requires_session_then_returns_server_rate(self):
        tokens = []

        def actor(token):
            tokens.append(token)
            if token != 'logged-in':
                raise APIError(401, 'SESSION_REQUIRED', 'Please sign in')
            return {'tenant': 'grandware'}

        self.gateway.actor = actor
        denied_status, denied = self.request('/api/exchange-rate')
        ok_status, value = self.request('/api/exchange-rate', extra={'Cookie': 'trade_session=logged-in'})

        self.assertEqual((denied_status, denied['code']), (401, 'SESSION_REQUIRED'))
        self.assertEqual((ok_status, value['adjustedRate'], value['source']), (200, 7.23, 'open.er-api.com'))
        self.assertEqual(tokens, [None, 'logged-in'])
        self.assertEqual(self.rate_calls, 1)

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
