"""Native User passwords/sessions with Tradept invitation and email policy.

No parallel password store. Native reset hashes are single-use and consumed
under a row lock. Tokens travel in URL fragments, never in server access URLs.
"""
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit
import secrets

import frappe
from frappe.rate_limiter import rate_limit
from frappe.utils import now_datetime, get_datetime

from .login_policy import email_address, normalize_policy, permits
from .schema import loads

VERIFIED = 'custom_tradept_email_verified'
CHANGE = 'custom_tradept_password_change_required'
GENERIC = '如该邮箱是已获邀请的有效成员，我们将发送密码设置邮件，请检查收件箱。'


def policy():
    if not frappe.db.exists('Trade Workspace', 'workspace'):
        return {}
    return loads(frappe.db.get_value('Trade Workspace', 'workspace', 'configuration'), {}).get('loginPolicy', {})


def active_policy():
    value = policy()
    return value if value.get('enabled') else None


def _member(email):
    return frappe.db.exists('Trade User Profile', {'user': email}) and frappe.db.get_value('User', email, 'enabled')


def _native_operator(user):
    """Native System Users retain native auth; Tradept identities never bypass."""
    from .permissions import is_workbench_user
    if is_workbench_user(user):
        return False
    if frappe.db.get_value('User', user, 'user_type') != 'System User' or not frappe.db.get_value('User', user, 'enabled'):
        return False
    return True


def require_access(user):
    if user in ('Guest', 'Administrator'):
        return
    if _native_operator(user):
        return
    value = active_policy()
    if not value:
        from . import login_setup
        cfg = login_setup.configuration()
        if login_setup.pending(cfg) and not login_setup.is_bootstrap(cfg, user):
            raise frappe.AuthenticationError('请使用初始管理员账号完成企业配置')
        return
    if (not permits(value, user) or not _member(user)
            or not frappe.db.get_value('User', user, VERIFIED)
            or frappe.db.get_value('User', user, CHANGE)):
        raise frappe.AuthenticationError('请使用获准的企业邮箱，并先完成邮件激活或密码设置')


def before_login(login_manager=None):
    if not active_policy():
        return
    user = frappe.local.form_dict.get('usr')
    # Administrator is a native recovery operator, never a workbench account.
    if user == 'Administrator':
        return
    if isinstance(user, str) and _native_operator(user.strip().lower()):
        return
    try:
        normalized = email_address(user)
    except ValueError:
        raise frappe.AuthenticationError('请使用企业邮箱登录') from None
    if not permits(policy(), normalized):
        raise frappe.AuthenticationError('邮箱或密码无效')
    frappe.local.form_dict.usr = normalized


def on_login(login_manager):
    require_access(login_manager.user)


def check_session():
    # Runs after token validation in request_guard, covers old sessions/API keys.
    require_access(frappe.session.user)


@frappe.whitelist(allow_guest=True, methods=['GET'])
def login_config():
    from . import login_setup
    cfg = login_setup.configuration()
    return {'emailOnly': not login_setup.pending(cfg), 'setupRequired': login_setup.pending(cfg),
            'invitationOnly': True, 'brand': 'Tradept'}


def _queue_link(user, value, invitation=False):
    from .session_security import revoke_user_sessions
    if not frappe.db.exists('Email Account', {'enable_outgoing': 1, 'default_outgoing': 1}):
        raise frappe.ValidationError('请先配置默认发信邮箱，再发送邀请或重置邮件')
    native = frappe.get_doc('User', user)
    issued = native.get('last_reset_password_key_generated_on')
    if issued and get_datetime(issued) > now_datetime() - timedelta(seconds=60):
        return {'emailDelivery': 'recently-requested'}
    link = native._reset_password(send_email=False)
    token = parse_qs(urlsplit(link).query)['key'][0]
    url = value['publicOrigin'] + '/#set-password=' + token
    if invitation:
        native.db_set(CHANGE, 1, update_modified=False)
        revoke_user_sessions(user)
    frappe.sendmail(
        recipients=[user], subject='Tradept · 激活账号并设置密码' if invitation else 'Tradept · 重置密码',
        message='<p>请在 1 小时内打开以下链接，验证邮箱并设置您本人的密码。</p>'
                f'<p><a href="{url}">在 Tradept 中设置密码</a></p>'
                '<p>链接仅可使用一次。若非本人或企业管理员发起，请忽略此邮件。</p>',
        now=False,
    )
    return {'emailDelivery': 'queued'}


@frappe.whitelist(allow_guest=True, methods=['POST'])
@rate_limit(key="email", limit=5, seconds=3600)
def forgot_password(email):
    value = active_policy()
    try:
        email = email_address(email)
    except ValueError:
        return {'ok': True, 'message': GENERIC}
    if value and permits(value, email) and _member(email):
        # Uniform response prevents mailbox membership enumeration. Failures are
        # visible in the native error log, never expose an invitation/reset key.
        try:
            from . import repository as repo
            repo.workspace(lock=True)
            _queue_link(email, value)
        except frappe.ValidationError:
            frappe.log_error(title='Tradept password mail configuration', message='Default outgoing email is unavailable')
    return {'ok': True, 'message': GENERIC}


@frappe.whitelist(allow_guest=True, methods=['POST'])
@rate_limit(limit=100, seconds=3600)
def complete_password(key, password):
    import hashlib
    from frappe.utils.password import update_password, check_password
    from frappe.core.doctype.user.user import test_password_strength
    from .events import managed_write
    if not isinstance(key, str) or not 16 <= len(key) <= 200:
        raise frappe.ValidationError('链接无效或已过期，请重新申请')
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        raise frappe.ValidationError('密码长度须为 12 至 128 位')
    hashed = hashlib.sha256(key.encode()).hexdigest()
    # Lock the workspace before User to match administrator lock ordering.
    from . import repository as repo
    work, cfg = repo.workspace(lock=True)
    rows = frappe.db.sql('SELECT name, reset_password_key, last_reset_password_key_generated_on FROM `tabUser` WHERE reset_password_key=%s FOR UPDATE', (hashed,), as_dict=True)
    if len(rows) != 1:
        raise frappe.ValidationError('链接无效或已过期，请重新申请')
    user = rows[0].name
    issued = rows[0].last_reset_password_key_generated_on
    value = cfg.get('loginPolicy', {})
    from . import login_setup
    setup_activation = login_setup.activation_target(cfg, user)
    if ((not value.get('enabled') and not setup_activation) or not permits(value, user)
            or (not setup_activation and not _member(user)) or not issued
            or not now_datetime() - timedelta(hours=1) <= get_datetime(issued) <= now_datetime()):
        raise frappe.ValidationError('链接无效或已过期，请联系企业管理员')
    previous_users = [user]
    if setup_activation:
        previous_users.append(cfg['loginSetup']['bootstrapUser'])
    for previous_user in previous_users:
        try:
            check_password(previous_user, password)
        except frappe.AuthenticationError:
            pass
        else:
            raise frappe.ValidationError('请设置一个不同于原密码的新密码')
    feedback = test_password_strength(password).get('feedback', {})
    if feedback and not feedback.get('password_policy_validation_passed', False):
        raise frappe.ValidationError('密码强度不足，请使用更长且不易猜测的密码')
    with managed_write():
        update_password(user, password, logout_all_sessions=False)
        from .session_security import revoke_user_sessions
        revoke_user_sessions(user)
        frappe.db.set_value('User', user, {VERIFIED: 1, CHANGE: 0, 'reset_password_key': '', 'last_password_reset_date': now_datetime().date()})
        if setup_activation:
            login_setup.activate(work, cfg, user)
        else:
            repo.finish(work, {'id': 'email:' + user}, 'account:password-set', {'emailVerified': True})
    # Do not auto-login from a reset link; a fresh email/password login follows.
    return {'ok': True, 'message': '密码已设置，请使用企业邮箱和新密码登录。'}


def configure(cfg, actor, value):
    from .domain import APIError
    try:
        candidate = normalize_policy(value)
    except ValueError as error:
        raise APIError(400, 'LOGIN_POLICY_INVALID', str(error)) from None
    from . import login_setup
    if login_setup.pending(cfg):
        return login_setup.configure(cfg, actor, candidate, value)
    if not permits(candidate, actor['nativeUser']):
        raise APIError(409, 'ADMIN_EMAIL_REQUIRED', '新规则必须允许当前管理员的真实邮箱')
    if not frappe.db.get_value('User', actor['nativeUser'], VERIFIED):
        raise APIError(409, 'ADMIN_VERIFICATION_REQUIRED', '请先通过部署初始化邀请验证管理员邮箱')
    cfg['loginPolicy'] = candidate
    frappe.db.set_single_value('Website Settings', 'disable_signup', 1)
    frappe.db.set_single_value('System Settings', 'allow_login_using_user_name', 0)
    return {'id': 'login-policy'}


def prepare_member(cfg, value, existing):
    from .domain import APIError
    value = dict(value)
    try:
        email = email_address(value.get('email') or (existing or {}).get('nativeUser'))
    except ValueError as error:
        raise APIError(400, 'INVALID_MEMBER_EMAIL', str(error)) from None
    if not permits(cfg['loginPolicy'], email):
        raise APIError(403, 'EMAIL_NOT_ALLOWED', '此邮箱不符合企业登录白名单')
    value['email'] = email
    # Preserve legacy native username internally; it is never accepted at login.
    value['username'] = (existing or {}).get('username') or email
    value.pop('temporaryPassword', None)
    if not existing:
        value['temporaryPassword'] = secrets.token_urlsafe(36)
    return value


def member_saved(cfg, user, is_new, value):
    if cfg.get('loginPolicy', {}).get('enabled') and (is_new or value.get('sendInvitation')) and not value.get('disabled'):
        return _queue_link(user, cfg['loginPolicy'], invitation=True)
    return {}


def install():
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
    create_custom_fields({'User': [
        {'fieldname': VERIFIED, 'label': 'Tradept Email Verified', 'fieldtype': 'Check', 'default': '0', 'hidden': 1, 'read_only': 1},
        {'fieldname': CHANGE, 'label': 'Tradept Password Change Required', 'fieldtype': 'Check', 'default': '0', 'hidden': 1, 'read_only': 1},
    ]}, update=True)


def provision_private_access(configuration):
    """Bench-only initial account/password; enterprise settings follow in UI."""
    from .login_setup import provision
    return provision(configuration)
