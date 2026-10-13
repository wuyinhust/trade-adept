"""Validate new contact links without rewriting historical display snapshots."""


def _identifier(value):
    return None if value in (None, '') else str(value)


def validate(order, customer, current=None):
    old = current or {}
    contact_id = order.get('contactId')
    changed = current is None or (
        _identifier(contact_id) != _identifier(old.get('contactId'))
        or _identifier(order.get('customerId')) != _identifier(old.get('customerId'))
    )
    if not changed:
        return
    if contact_id in (None, ''):
        return  # Historical name-only selection does not invent a Contact ID.
    if type(contact_id) not in (str, int):
        raise ValueError('联系人编号必须为文本或整数')
    if not customer or _identifier(customer.get('id')) != _identifier(order.get('customerId')):
        raise ValueError('请先选择获授权的客户，再选择联系人')
    contacts = customer.get('contacts') or []
    contact = next((row for row in contacts if isinstance(row, dict) and _identifier(row.get('id')) == _identifier(contact_id)), None)
    if contact is None:
        raise ValueError('所选联系人不属于当前客户，请重新选择')
    if order.get('contactPerson') != contact.get('name'):
        raise ValueError('联系人信息已变更，请刷新名录后重新选择')
