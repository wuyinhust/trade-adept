import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.login_policy import normalize_policy, permits, email_address


class EmailPolicyTests(unittest.TestCase):
    def policy(self, **kwargs):
        return normalize_policy({'mode': 'domains', 'domains': ['Company.com', 'second.com'], 'publicOrigin': 'https://trade.company.com', **kwargs})

    def test_exact_domains_and_case_normalization(self):
        policy = self.policy()
        self.assertTrue(permits(policy, 'Alice@COMPANY.COM'))
        self.assertTrue(permits(policy, 'a@second.com'))
        for address in ['a@evilcompany.com', 'a@company.com.evil.org', 'a@sub.company.com', 'admin', 'a@company.com\r\nBcc:x@evil.org']:
            self.assertFalse(permits(policy, address), address)

    def test_addresses_only_and_all_mailboxes(self):
        policy = self.policy(mode='addresses', addresses=['A@Company.com'])
        self.assertTrue(permits(policy, 'a@company.com'))
        self.assertFalse(permits(policy, 'b@company.com'))
        self.assertTrue(permits(self.policy(mode='all'), 'outside@other.com'))
        self.assertFalse(permits(self.policy(mode='all'), 'Administrator'))

    def test_invalid_configuration_cannot_create_open_or_redirecting_policy(self):
        for override in [{'mode': 'domains', 'domains': []}, {'mode': 'unknown'}, {'domains': ['*.company.com']}, {'domains': ['company.com/']}, {'publicOrigin': 'https://evil.com@company.com'}, {'publicOrigin': 'http://company.com'}, {'publicOrigin': 'https://company.com/#redirect'}, {'publicOrigin': 'https://company.com/login'}]:
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.policy(**override)

    def test_normalized_email_and_no_display_name(self):
        self.assertEqual(email_address(' A@Company.com '), 'a@company.com')
        with self.assertRaises(ValueError):
            email_address('Alice <a@company.com>')


if __name__ == '__main__':
    unittest.main()
