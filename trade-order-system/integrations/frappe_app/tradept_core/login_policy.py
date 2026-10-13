"""Pure validation for invitation-only, single-enterprise email access."""
import re
from urllib.parse import urlsplit


def email_address(value):
    if not isinstance(value, str):
        raise ValueError("请输入有效的企业邮箱")
    value = value.strip().lower()
    if len(value) > 200 or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value):
        raise ValueError("请输入有效的企业邮箱")
    domain_name(value.rsplit('@', 1)[1])
    return value


def domain_name(value):
    if not isinstance(value, str):
        raise ValueError("邮箱域名格式无效")
    value = value.strip().lower()
    if len(value) > 253 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", value):
        raise ValueError("请填写完整邮箱域名，不包含 @、通配符或网址")
    return value


def normalize_policy(value):
    if not isinstance(value, dict) or value.get('mode') not in ('accounts', 'domains', 'addresses', 'all'):
        raise ValueError("请选择账号登录、域名白名单、邮箱白名单或所有邮箱")
    verification = value.get('emailVerificationRequired', True)
    if type(verification) is not bool:
        raise ValueError("邮箱验证设置必须是布尔值")
    result = {'enabled': value['mode'] != 'accounts', 'mode': value['mode'], 'configured': True,
              'emailVerificationRequired': verification if value['mode'] != 'accounts' else False}
    for field, validate in (('domains', domain_name), ('addresses', email_address)):
        values = value.get(field, [])
        if not isinstance(values, list) or len(values) > 1000:
            raise ValueError("邮箱白名单必须是列表，最多 1000 项")
        result[field] = sorted(set(validate(item) for item in values))
    if result['mode'] in ('domains', 'addresses') and not result[result['mode']]:
        raise ValueError("所选白名单不能为空")
    origin = value.get('publicOrigin', '')
    if not origin and not result['emailVerificationRequired']:
        result['publicOrigin'] = ''
        return result
    if not isinstance(origin, str):
        raise ValueError("请配置企业 HTTPS 登录域名")
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('', '/') or parsed.netloc != parsed.hostname):
        raise ValueError("请配置企业 HTTPS 登录域名，不包含路径或端口")
    domain_name(parsed.hostname)
    result['publicOrigin'] = 'https://' + parsed.hostname
    return result


def verification_required(policy):
    return policy.get('mode') != 'accounts' and policy.get('emailVerificationRequired', True)


def permits(policy, email):
    try:
        email = email_address(email)
    except ValueError:
        return False
    mode = policy.get('mode')
    return (mode == 'all' or (mode == 'addresses' and email in policy.get('addresses', []))
            or (mode == 'domains' and email.rsplit('@', 1)[1] in policy.get('domains', [])))
