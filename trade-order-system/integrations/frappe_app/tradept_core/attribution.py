"""Preserve the initiating actor across a bounded native workflow transaction."""
from __future__ import annotations

import frappe

LEDGER_TYPES = ("GL Entry", "Payment Ledger Entry", "Advance Payment Ledger Entry")


def _state(row):
    return {key: row.get(key) for key in ("modified", "modified_by", "owner")}


def _rows(references, brief):
    result = {}
    parents = {(row["doctype"], row["name"]) for row in references}
    if getattr(brief, "doctype", None) and getattr(brief, "name", None):
        parents.add((brief.doctype, brief.name))
    for doctype, name in sorted(parents):
        doc = frappe.get_doc(doctype, name, for_update=True)
        result[(doctype, name)] = _state(doc)
        for child in doc.get_all_children():
            result[(child.doctype, child.name)] = _state(child)
    # Ledger writers may use db_insert/bulk_insert and bypass document hooks.
    # Read only rows whose standard voucher links belong to these native docs.
    for doctype in LEDGER_TYPES:
        for voucher_type, voucher_no in sorted(parents):
            if voucher_type.startswith("Trade "):
                continue
            rows = frappe.db.sql(
                f"SELECT name,modified,modified_by,owner FROM `tab{doctype}` WHERE voucher_type=%s AND voucher_no=%s FOR UPDATE",
                (voucher_type, voucher_no), as_dict=True,
            )
            for row in rows:
                result[(doctype, row.name)] = _state(row)
    return result


def capture(references, brief):
    return _rows(references, brief)


def finish(before, references, brief, actor):
    """Stamp only new or changed rows; never rewrite a historical creator."""
    for (doctype, name), after in _rows(references, brief).items():
        prior = before.get((doctype, name))
        if prior is None:
            values = {"owner": actor, "modified_by": actor}
        elif (after["modified"], after["modified_by"]) != (prior["modified"], prior["modified_by"]):
            values = {"modified_by": actor}
        else:
            continue
        # Attribution does not alter modified timestamps, posting dates,
        # document status, amounts, balance or immutable source provenance.
        frappe.db.set_value(doctype, name, values, update_modified=False)
