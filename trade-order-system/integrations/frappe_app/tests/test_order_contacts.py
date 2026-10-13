import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.order_contacts import validate


class ContactLinkTests(unittest.TestCase):
    def setUp(self):
        self.customer = {'id': 1, 'contacts': [{'id': 'A', 'name': 'Alex'}, {'id': 2, 'name': 'Alex'}]}

    def test_id_links_one_of_two_same_name_contacts_and_accepts_string_ids(self):
        validate({'customerId': '1', 'contactId': '2', 'contactPerson': 'Alex'}, self.customer)

    def test_same_name_does_not_authorize_a_contact_from_another_customer(self):
        with self.assertRaises(ValueError):
            validate({'customerId': 1, 'contactId': 'another-customer-contact', 'contactPerson': 'Alex'}, self.customer)
        with self.assertRaises(ValueError):
            validate({'customerId': 99, 'contactId': 'A', 'contactPerson': 'Alex'}, self.customer)

    def test_unchanged_historical_orphan_link_and_name_are_preserved(self):
        old = {'customerId': 1, 'contactId': 'removed', 'contactPerson': 'Original name'}
        validate({**old, 'remarks': 'Nonfinancial edit'}, self.customer, old)

    def test_customer_change_must_not_keep_previous_customers_contact(self):
        old = {'customerId': 9, 'contactId': 'old-id', 'contactPerson': 'Alex'}
        with self.assertRaises(ValueError):
            validate({**old, 'customerId': 1}, self.customer, old)

    def test_name_only_legacy_selection_is_not_guessed_or_rewritten(self):
        order = {'customerId': 1, 'contactPerson': 'Historical Alex'}
        validate(order, self.customer)
        self.assertNotIn('contactId', order)

    def test_new_link_rejects_stale_name_and_unsafe_identifier_type(self):
        for values in [{'contactId': 'A', 'contactPerson': 'Old name'},
                       {'contactId': {'id': 'A'}, 'contactPerson': 'Alex'}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate({'customerId': 1, **values}, self.customer)


if __name__ == '__main__':
    unittest.main()
