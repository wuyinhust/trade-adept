import copy
import unittest

from server.validation import validate_order, validate_shipment


class BusinessValidationTest(unittest.TestCase):
    def setUp(self):
        self.company = {'id': 'TEST-CN', 'jurisdiction': 'CN', 'settlementCurrency': 'CNY'}
        self.order = {'customerId': 'TEST-CUSTOMER', 'companyOperationNo': 'TEST-001',
                      'customerOrderNo': 'PO-001', 'contactPerson': 'Fictional Person',
                      'loadingPort': '上海港', 'paymentTerms': 'T/T', 'orderDate': '2026-10-11',
                      'orderAmountUSD': 1000, 'status': '进行中', 'shippingStatus': '待出运',
                      'paymentStatus': '未收款', 'factories': []}
        self.factory = {'factoryId': 'TEST-FACTORY', 'productType': 'Sample', 'totalQuantity': 10,
                        'totalAmount': 200, 'prepayment': 20, 'inspectionDate': '2026-10-15',
                        'estimatedShipDate': '2026-10-20'}
        self.shipment = {'orderId': 'TEST-ORDER', 'loadingPort': '上海港', 'etd': '2026-10-20',
                         'status': '待出运', 'customsStatus': '未报关', 'grossWeight': 10,
                         'netWeight': 8, 'volume': 1}

    def test_complete_creation_and_historical_remarks(self):
        validate_order(self.order, self.order, True, self.company)
        validate_order({'companyOperationNo': 'LEGACY', 'remarks': 'After'}, {'remarks': 'After'}, False, self.company)

    def test_new_required_fields(self):
        for key in ('customerOrderNo', 'contactPerson', 'loadingPort', 'paymentTerms', 'orderDate'):
            with self.subTest(key=key):
                value = {**self.order, key: ''}
                with self.assertRaises(ValueError):
                    validate_order(value, value, True, self.company)

    def test_hk_port_requirement_is_jurisdiction_specific(self):
        with self.assertRaises(ValueError):
            validate_order(self.order, self.order, True, {'id': 'HK-ONE', 'jurisdiction': 'HK', 'settlementCurrency': 'USD'})
        validate_order(self.order, self.order, True, {'id': 'US-ONE', 'jurisdiction': 'US', 'settlementCurrency': 'USD'})

    def test_real_dates_and_positive_amounts(self):
        for key, invalid in [('orderDate', '2026-02-30'), ('orderAmountUSD', 0), ('orderAmountUSD', float('nan')), ('paidAmountUSD', -1)]:
            with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                validate_order({**self.order, key: invalid}, {key: invalid}, False, self.company)

    def test_invalid_status_changes(self):
        for key in ('status', 'orderStatus', 'paymentStatus', 'shippingStatus', 'factoryPaidStatus'):
            for invalid in ('arbitrary', None, 1, {}, []):
                with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                    validate_order({**self.order, key: invalid}, {key: invalid}, False, self.company)

    def test_unmodified_legacy_status_does_not_block_remarks(self):
        validate_order({'status': 'historical-custom', 'remarks': 'After'}, {'remarks': 'After'}, False, self.company)

    def test_factory_quantity_prepayment_and_dates(self):
        for changes in ({'totalQuantity': 0}, {'totalQuantity': 1.5}, {'prepayment': 201}, {'prepayment': -1}, {'inspectionDate': '2026-10-21'}, {'estimatedShipDate': 'invalid'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                factory = {**self.factory, **changes}
                validate_order({**self.order, 'factories': [factory]}, {'factories': [factory]}, False, self.company)

    def test_public_factory_without_hidden_cost_is_valid(self):
        factory = copy.deepcopy(self.factory)
        del factory['totalAmount']
        del factory['prepayment']
        validate_order({**self.order, 'factories': [factory]}, {'factories': [factory]}, False, self.company)

    def test_shipment_create_and_hk_port(self):
        validate_shipment(self.shipment, self.shipment, True, self.company)
        with self.assertRaises(ValueError):
            validate_shipment(self.shipment, self.shipment, True, {'jurisdiction': 'HK'})

    def test_etd_cannot_substitute_for_actual_milestone(self):
        for status in ('已出运', '已到港', '已签收'):
            with self.subTest(status=status), self.assertRaises(ValueError):
                validate_shipment({**self.shipment, 'status': status}, {'status': status}, False, self.company)

    def test_actual_dates_are_real_and_chronological(self):
        value = {**self.shipment, 'actualShipDate': '2026-10-20', 'arrivalDate': '2026-10-19'}
        with self.assertRaises(ValueError):
            validate_shipment(value, {'arrivalDate': '2026-10-19'}, False, self.company)
        value['arrivalDate'] = '2026-11-20'
        value['receivedDate'] = '2026-11-21'
        value['status'] = '已签收'
        validate_shipment(value, value, False, self.company)

    def test_weight_and_volume_validation(self):
        for changes in ({'netWeight': 11}, {'volume': -1}, {'grossWeight': float('inf')}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_shipment({**self.shipment, **changes}, changes, False, self.company)


if __name__ == '__main__':
    unittest.main()
