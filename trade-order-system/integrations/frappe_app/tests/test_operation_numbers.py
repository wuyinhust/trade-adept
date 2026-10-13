import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.operation_numbers import allocate


class OperationNumberTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {'id': 'grandware', 'companies': [{'id': 'C1', 'orderPrefix': 'GR'}, {'id': 'C2', 'orderPrefix': 'WY'}]}
        self.profiles = {'U1': {'name': 'Alice'}, 'U2': {'name': 'Amy'}}

    def order(self, **kwargs):
        return {'companyId': 'C1', 'salespersonId': 'U1', **kwargs}

    def test_deleted_and_other_owner_numbers_seed_server_counter_without_reusing_numbers(self):
        rows = [{'companyId': 'C1', 'companyOperationNo': 'GR26A009', 'deleted': True},
                {'companyId': 'C1', 'companyOperationNo': 'GR26A015', 'salespersonId': 'U2'},
                {'companyId': 'C2', 'companyOperationNo': 'GR26A999'}]
        order = self.order(companyOperationNo='GR26A001', companyOperationNoAuto=True)
        self.assertTrue(allocate(self.cfg, order, self.profiles, rows, '2026'))
        self.assertEqual(order['companyOperationNo'], 'GR26A016')
        self.assertNotIn('companyOperationNoAuto', order)
        self.assertEqual(rows[0]['companyOperationNo'], 'GR26A009')

    def test_two_allocations_with_partial_or_empty_client_data_use_independent_counter(self):
        one = self.order()
        two = self.order(salespersonId='U2')
        allocate(self.cfg, one, self.profiles, [], '2026')
        allocate(self.cfg, two, self.profiles, [], '2026')
        self.assertEqual((one['companyOperationNo'], two['companyOperationNo']), ('GR26A001', 'GR26A002'))

    def test_company_and_year_series_are_independent(self):
        orders = [self.order(), self.order(companyId='C2'), self.order()]
        for order, year in zip(orders, ('2026', '2026', '2027')):
            allocate(self.cfg, order, self.profiles, [], year)
        self.assertEqual([o['companyOperationNo'] for o in orders], ['GR26A001', 'WY26A001', 'GR27A001'])

    def test_manual_number_is_not_changed_and_does_not_consume_counter(self):
        order = self.order(companyOperationNo='Customer-supplied-reference')
        before = copy.deepcopy(self.cfg)
        self.assertFalse(allocate(self.cfg, order, self.profiles, [], '2026'))
        self.assertEqual(order['companyOperationNo'], 'Customer-supplied-reference')
        self.assertEqual(self.cfg, before)

    def test_transaction_rollback_can_discard_counter_and_new_number_together(self):
        candidate = copy.deepcopy(self.cfg)
        failed = self.order()
        allocate(candidate, failed, self.profiles, [], '2026')
        accepted = self.order()
        allocate(self.cfg, accepted, self.profiles, [], '2026')
        self.assertEqual(accepted['companyOperationNo'], failed['companyOperationNo'])
        self.assertEqual(self.cfg['operationCounters'], candidate['operationCounters'])

    def test_invalid_counter_or_flag_does_not_allocate(self):
        with self.assertRaises(ValueError):
            allocate(self.cfg, self.order(companyOperationNoAuto='false'), self.profiles, [], '2026')
        self.cfg['operationCounters'] = {'C1:GR26A': True}
        with self.assertRaises(ValueError):
            allocate(self.cfg, self.order(), self.profiles, [], '2026')


if __name__ == '__main__':
    unittest.main()
