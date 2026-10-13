"""Pure regression cases for master-data API validation and old omissions."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradept_core.masterdata_validation import validate_masterdata


def contact(identifier="C-1", **changes):
    return {"id": identifier, "name": "同名联系人", "position": "采购", "email": "buyer@example.invalid",
            "phone": "+86 (21) 5555 / 123 ext. 9", "mobilePhone": "138 0000 0000", "homeAddress": "", **changes}


def customer(**changes):
    return {"company": "虚构客户", "companyAddress": "虚构公司地址", "contacts": [contact()], **changes}


def factory(**changes):
    return {"name": "虚构工厂", "contact": "生产联系人", "phone": "021-5555 ext. 9",
            "mobilePhone": "+86 138-0000-0000", "products": "陶瓷、玻璃", "address": "虚构工厂地址", **changes}


class MasterdataValidationTests(unittest.TestCase):
    def test_valid_records_and_contact_strings_are_not_mutated(self):
        for collection, value in (("customers", customer()), ("factories", factory())):
            before = copy.deepcopy(value)
            self.assertIsNone(validate_masterdata(collection, value))
            self.assertEqual(value, before)

    def test_customer_name_alias_is_supported_but_entity_id_is_not_a_name(self):
        value = customer()
        value["companyName"] = value.pop("company")
        validate_masterdata("customers", value)
        for value in (customer(company="", companyId="CO-GR"), customer(company="", companyName="")):
            with self.assertRaisesRegex(ValueError, "公司名称"):
                validate_masterdata("customers", value)

    def test_conflicting_name_aliases_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "不一致"):
            validate_masterdata("customers", customer(companyName="其他公司"))

    def test_new_customer_requires_name_address_and_contacts(self):
        for key in ("company", "companyAddress", "contacts"):
            value = customer()
            value.pop(key)
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_masterdata("customers", value)

    def test_every_new_contact_requires_all_five_channels(self):
        for key in ("name", "position", "email", "phone", "mobilePhone"):
            for missing in (None, "", "  "):
                value = customer(contacts=[contact(**{key: missing})])
                with self.subTest(key=key, missing=missing), self.assertRaises(ValueError):
                    validate_masterdata("customers", value)

    def test_two_same_names_with_different_ids_are_valid(self):
        validate_masterdata("customers", customer(contacts=[contact("A"), contact("B", email="other@example.invalid")]))

    def test_string_and_numeric_duplicate_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "编号重复"):
            validate_masterdata("customers", customer(contacts=[contact(7), contact("7")]))

    def test_new_contact_without_stable_id_is_rejected(self):
        row = contact()
        row.pop("id")
        with self.assertRaisesRegex(ValueError, "稳定"):
            validate_masterdata("customers", customer(contacts=[row]))

    def test_dangerous_contact_ids_and_types_cannot_bypass_the_ui(self):
        for identifier in (True, {}, [], float("inf"), "bad' onclick=", " "):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                validate_masterdata("customers", customer(contacts=[contact(identifier)]))
        for contacts in ({"name": "假对象"}, [None], ["字符串"], []):
            with self.subTest(contacts=contacts), self.assertRaises(ValueError):
                validate_masterdata("customers", customer(contacts=contacts))

    def test_new_invalid_email_is_rejected_but_source_phone_formats_survive(self):
        with self.assertRaisesRegex(ValueError, "邮箱格式"):
            validate_masterdata("customers", customer(contacts=[contact(email="not an email")]))
        value = customer()
        validate_masterdata("customers", value)
        self.assertEqual(value["contacts"][0]["phone"], "+86 (21) 5555 / 123 ext. 9")

    def test_unrelated_edit_does_not_force_old_omissions_or_alias_conflicts(self):
        current = {"id": "OLD", "company": "原名称", "companyName": "旧别名", "contacts": [{"name": "原联系人"}]}
        value = {**current, "remarks": "只改备注"}
        before = copy.deepcopy(value)
        validate_masterdata("customers", value, current)
        self.assertEqual(value, before)
        validate_masterdata("factories", {"remarks": "只改备注"}, {"name": "旧工厂"})

    def test_explicitly_clearing_existing_required_fields_is_rejected(self):
        for collection, current, key in (("customers", customer(), "companyAddress"), ("customers", customer(), "company"),
                                          ("factories", factory(), "contact"), ("factories", factory(), "products")):
            with self.subTest(collection=collection, key=key), self.assertRaises(ValueError):
                validate_masterdata(collection, {**current, key: ""}, current)

    def test_adding_complete_contact_preserves_other_incomplete_historical_rows(self):
        current = customer(contacts=[{"name": "旧联系人", "phone": "来源旧原文"}])
        value = {**current, "contacts": [contact("NEW"), *copy.deepcopy(current["contacts"])]}
        validate_masterdata("customers", value, current)

    def test_assigning_id_to_unchanged_incomplete_row_does_not_require_migration(self):
        current = customer(contacts=[{"name": "旧联系人", "phone": "原电话"}])
        value = {**current, "contacts": [{**current["contacts"][0], "id": "NOW-STABLE"}]}
        validate_masterdata("customers", value, current)
        self.assertEqual(value["contacts"][0]["phone"], "原电话")

    def test_changed_contact_requires_complete_details_not_just_same_name(self):
        current = customer(contacts=[{"id": "OLD", "name": "旧联系人", "phone": "原电话"}])
        with self.assertRaises(ValueError):
            validate_masterdata("customers", {**current, "contacts": [{**current["contacts"][0], "name": "改名"}]}, current)

    def test_reordering_or_removing_other_old_contacts_preserves_unchanged_rows(self):
        rows = [{"id": "A", "name": "旧甲"}, {"id": "B", "name": "旧乙"}]
        current = customer(contacts=rows)
        validate_masterdata("customers", {**current, "contacts": list(reversed(rows))}, current)
        validate_masterdata("customers", {**current, "contacts": [rows[1]]}, current)
        with self.assertRaisesRegex(ValueError, "至少"):
            validate_masterdata("customers", {**current, "contacts": []}, current)

    def test_new_factory_required_fields_and_product_alias(self):
        for key in ("name", "contact", "phone", "mobilePhone", "address", "products"):
            row = factory()
            row.pop(key)
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_masterdata("factories", row)
        row = factory()
        row["productType"] = row.pop("products")
        validate_masterdata("factories", row)

    def test_changed_known_field_types_are_rejected_without_mutation(self):
        for collection, value, key in (("customers", customer(), "companyAddress"), ("factories", factory(), "phone")):
            for bad in (True, 123, {}, []):
                row = {**value, key: bad}
                before = copy.deepcopy(row)
                with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                    validate_masterdata(collection, row, value)
                self.assertEqual(row, before)

    def test_invalid_collection_row_or_current_is_rejected(self):
        for args in (("orders", {}), ("customers", []), ("factories", {}, [])):
            with self.subTest(args=args), self.assertRaises(ValueError):
                validate_masterdata(*args)


if __name__ == "__main__":
    unittest.main()
