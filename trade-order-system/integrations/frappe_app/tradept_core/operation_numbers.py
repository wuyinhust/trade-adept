"""Allocate business numbers inside the locked workspace write transaction."""
import re


def allocate(configuration, order, profiles, all_orders, year):
    """Only for new non-historical orders; caller persists configuration atomically.

    A manually supplied number is retained. The UI's preview is replaced only
    when explicitly marked automatic, or when the number was left blank.
    Existing and deleted records seed the counter so old numbers are never reused.
    """
    automatic = order.pop('companyOperationNoAuto', False)
    if not isinstance(automatic, bool):
        raise ValueError('单号自动生成标记必须为布尔值')
    number = order.get('companyOperationNo')
    if number is not None and not isinstance(number, str):
        raise ValueError('公司操作单号必须为文本')
    if number and number.strip() and not automatic:
        return False
    company_id = str(order.get('companyId') or '')
    company = next((row for row in configuration.get('companies', []) if str(row.get('id')) == company_id), None)
    if company is None:
        raise ValueError('请先选择获授权的公司')
    if not isinstance(year, str) or not re.fullmatch(r'\d{4}', year):
        raise ValueError('服务器单号年份无效')
    legacy_prefix = {'CO-GR': 'GR', 'CO-WY': 'WY'} if configuration.get('id') == 'grandware' else {}
    prefix = company.get('orderPrefix') or legacy_prefix.get(company_id, 'OP')
    if not isinstance(prefix, str) or not prefix.strip():
        raise ValueError('公司单号前缀无效')
    owner = profiles.get(str(order.get('salespersonId')), {})
    name = owner.get('name') or owner.get('username') or '?'
    if not isinstance(name, str):
        raise ValueError('业务员姓名无效')
    pattern = prefix + year[-2:] + name[:1].upper()
    series = company_id + ':' + pattern
    counters = configuration.setdefault('operationCounters', {})
    if not isinstance(counters, dict):
        raise ValueError('服务器单号计数器无效')
    previous = counters.get(series, 0)
    if type(previous) is not int or previous < 0:
        raise ValueError('服务器单号计数器无效')
    matcher = re.compile(re.escape(pattern) + r'(\d+)$')
    for existing in all_orders:
        if str(existing.get('companyId')) != company_id:
            continue
        match = matcher.fullmatch(str(existing.get('companyOperationNo') or ''))
        if match:
            previous = max(previous, int(match.group(1)))
    counters[series] = previous + 1
    order['companyOperationNo'] = pattern + str(previous + 1).zfill(3)
    return True
