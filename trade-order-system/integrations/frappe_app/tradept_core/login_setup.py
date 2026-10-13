"""One-time account/password bootstrap; email policy activates only on proof."""
import secrets

import frappe

from .domain import APIError
from .login_policy import email_address, permits
from .schema import loads, dumps


def pending(cfg):
    return bool(cfg.get('loginSetup', {}).get('bootstrapUser')) and not cfg.get('loginPolicy', {}).get('enabled')


def configuration():
    if not frappe.db.exists('Trade Workspace', 'workspace'):
        return {}
    return loads(frappe.db.get_value('Trade Workspace', 'workspace', 'configuration'), {})


def is_bootstrap(cfg, user):
    return pending(cfg) and user == cfg['loginSetup']['bootstrapUser']


def guard(cfg, actor, action, supplied):
    if not pending(cfg):
        return
    if not is_bootstrap(cfg, actor.get('nativeUser')):
        raise APIError(403, 'SETUP_ADMIN_REQUIRED', '请使用部署时设置的初始管理员账号')
    allowed = {'session', 'context', 'data', 'meta', 'backend_status', 'admin_state', 'admin_update'}
    resources = {'enterprise', 'company', 'department', 'email', 'login-policy', 'onboarding', 'catalog_template'}
    if action not in allowed or (action == 'admin_update' and supplied.get('resource') not in resources):
        raise APIError(403, 'SETUP_REQUIRED', '请先完成企业邮箱初始化，再添加成员或处理业务')


def configure(cfg, actor, candidate, value):
    from .enterprise_login import _queue_link
    if not is_bootstrap(cfg, actor['nativeUser']):
        raise APIError(403, 'SETUP_ADMIN_REQUIRED', '仅初始管理员可以完成邮箱初始化')
    try:
        email = email_address(value.get('administratorEmail'))
    except ValueError as error:
        raise APIError(400, 'ADMIN_EMAIL_REQUIRED', str(error)) from None
    if not permits(candidate, email) or email.endswith('@bootstrap.invalid'):
        raise APIError(400, 'ADMIN_EMAIL_NOT_ALLOWED', '管理员真实邮箱必须在允许范围内')
    setup = cfg['loginSetup']
    previous = setup.get('pendingUser')
    if frappe.db.exists('User', email) and email != previous:
        raise APIError(409, 'ADMIN_EMAIL_EXISTS', '此邮箱已有账号，请使用尚未注册的管理员邮箱')
    # Any draft change invalidates the previous proof, including origin changes.
    if previous:
        frappe.db.set_value('User', previous, {'reset_password_key': '', 'last_reset_password_key_generated_on': None}, update_modified=False)
    cfg['loginPolicy'] = {**candidate, 'enabled': False}
    setup['administratorEmail'] = email
    if not value.get('sendVerification'):
        setup.pop('pendingUser', None)
        # Retain ownership of a previously created disabled user for resending.
        if previous == email:
            setup['pendingUser'] = previous
        return {'id': 'login-policy', 'activationRequired': True}
    native = frappe.get_doc('User', email) if previous == email else frappe.get_doc({
        'doctype': 'User', 'email': email, 'first_name': '企业管理员',
        'enabled': 0, 'send_welcome_email': 0, 'user_type': 'Website User',
        'new_password': secrets.token_urlsafe(36),
    })
    native.save(ignore_permissions=True)
    setup['pendingUser'] = email
    return {'id': 'login-policy', 'activationRequired': True, **_queue_link(email, candidate, invitation=True)}


def activation_target(cfg, user):
    return pending(cfg) and user == cfg['loginSetup'].get('pendingUser') == cfg['loginSetup'].get('administratorEmail')


def activate(work, cfg, user):
    """Called with workspace and reset User locked, in the password transaction."""
    from . import administrator
    from .enterprise_login import VERIFIED, CHANGE
    from .session_security import revoke_user_sessions
    setup = cfg['loginSetup']
    old = setup['bootstrapUser']
    name = frappe.db.get_value('Trade User Profile', {'user': old}, 'name')
    if not name:
        raise frappe.ValidationError('初始管理员资料缺失，请联系部署管理员')
    metadata = frappe.get_doc('Trade User Profile', name)
    profile = loads(metadata.profile, {})
    source = frappe.get_doc('User', old)
    target = frappe.get_doc('User', user)
    target.enabled = 1
    target.first_name = source.first_name
    target.set('roles', [{'role': row.role} for row in source.roles])
    target.set('user_emails', [{key: row.get(key) for key in ('email_account', 'email_id', 'enable_outgoing', 'awaiting_password', 'used_oauth')} for row in (source.get('user_emails') or [])])
    target.save(ignore_permissions=True)
    frappe.db.set_value('User', user, {VERIFIED: 1, CHANGE: 0})
    profile['username'] = user
    metadata.user = user
    metadata.profile = dumps(profile)
    metadata.save(ignore_permissions=True)
    for row in frappe.get_all('User Permission', filters={'user': old}, fields=['name']):
        frappe.db.set_value('User Permission', row.name, 'user', user)
    frappe.db.set_value('User', old, 'enabled', 0)
    revoke_user_sessions(old)
    frappe.clear_cache(user=old)
    frappe.clear_cache(user=user)
    cfg['loginPolicy']['enabled'] = True
    cfg.pop('loginSetup')
    frappe.db.set_single_value('System Settings', 'allow_login_using_user_name', 0)
    frappe.clear_cache(doctype='System Settings')
    administrator._save(work, cfg, {'id': profile['id']}, 'email-activation', {'emailVerified': True})


def provision(configuration):
    """Bench-only. File contains initial username/password, no domain or SMTP."""
    import json
    import re
    from pathlib import Path
    from . import administrator, repository as repo
    from .events import managed_write
    if frappe.session.user != 'Administrator':
        raise frappe.PermissionError('Native Administrator required')
    path = Path(configuration)
    if not path.is_absolute() or path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('Private configuration must be a regular 0600 file')
    member = json.loads(path.read_text())['administrator']
    username = member.get('username', '')
    password = member.get('password', '')
    if not isinstance(username, str) or not re.fullmatch(r'[a-z][a-z0-9._-]{2,63}', username) or username in ('administrator', 'guest'):
        raise ValueError('Choose a lowercase initial administrator username (3-64 characters)')
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        raise ValueError('Initial password must contain 12-128 characters')
    with managed_write():
        work, cfg = repo.workspace(lock=True)
        _provision_initial(work, cfg, member)
    return {'ok': True, 'setupRequired': True}


def _provision_initial(work, cfg, member, persist=True):
    from . import administrator
    if cfg.get('loginPolicy', {}).get('enabled') or cfg.get('loginSetup'):
        raise ValueError('Private login already provisioned; refusing to reset access')
    email = 'setup-' + secrets.token_hex(12) + '@bootstrap.invalid'
    changed = administrator._member(cfg, {'id': 'native:Administrator'}, {
        'id': member.get('id', 'enterprise-admin'), 'username': member['username'],
        'email': email, 'name': member.get('name', '企业管理员'), 'role': 'admin',
        'temporaryPassword': member['password'], 'visibleCompanyIds': member.get('visibleCompanyIds', []),
    })
    cfg['loginPolicy'] = {'enabled': False}
    cfg['loginSetup'] = {'bootstrapUser': email}
    cfg['onboarding'] = {'status': 'required', 'currentStep': 'enterprise', 'completedSteps': []}
    cfg['allowNativeSignup'] = False
    frappe.db.set_single_value('Website Settings', 'disable_signup', 1)
    frappe.db.set_single_value('System Settings', 'allow_login_using_user_name', 1)
    frappe.clear_cache(doctype='System Settings')
    if persist:
        administrator._save(work, cfg, {'id': 'native:Administrator'}, 'account-bootstrap', {'memberId': changed['id']})
    return email


def _retire_workspace_users(except_users=()):
    from .permissions import is_workbench_user
    from .session_security import revoke_user_sessions
    from frappe.utils.password import delete_all_passwords_for
    count = 0
    for user in frappe.get_all('User', pluck='name'):
        if user in except_users or not is_workbench_user(user):
            continue
        # Keep User/Profile identity and historical ownership. Revoke credentials.
        frappe.db.set_value('User', user, {'enabled': 0, 'api_key': None,
            'reset_password_key': '', 'last_reset_password_key_generated_on': None})
        delete_all_passwords_for('User', user)
        if frappe.db.exists('DocType', 'OAuth Bearer Token'):
            frappe.db.set_value('OAuth Bearer Token', {'user': user}, {'status': 'Revoked', 'refresh_token': None})
        revoke_user_sessions(user)
        frappe.clear_cache(user=user)
        count += 1
    return count


def retire_workspace_access():
    """Bench-only retirement for the removed demo site; never deletes profiles."""
    from . import administrator, repository as repo
    from .events import managed_write
    if frappe.session.user != 'Administrator':
        raise frappe.PermissionError('Native Administrator required')
    with managed_write():
        work, cfg = repo.workspace(lock=True)
        if pending(cfg) or cfg.get('loginPolicy', {}).get('enabled'):
            raise ValueError('Refusing demo retirement on a provisioned private site')
        count = _retire_workspace_users()
        cfg['allowNativeSignup'] = False
        frappe.db.set_single_value('Website Settings', 'disable_signup', 1)
        administrator._save(work, cfg, {'id': 'native:Administrator'}, 'retire-demo-access', {'retiredAccounts': count})
    return {'ok': True, 'retiredAccounts': count}


def provision_deployment(credentials_output):
    """Bench-only private deployment. Return no credentials; write once to 0600.

    Caller commits the transaction and verifies the generated account before
    handing over the private file. Existing output or configured access aborts.
    """
    import json
    import os
    from pathlib import Path
    from . import administrator, repository as repo
    from .events import managed_write
    if frappe.session.user != 'Administrator':
        raise frappe.PermissionError('Native Administrator required')
    path = Path(credentials_output)
    parent = path.parent
    if (not path.is_absolute() or not parent.is_dir() or parent.is_symlink()
            or parent.resolve() != parent or parent.stat().st_mode & 0o077):
        raise ValueError('Credentials require an absolute file in a private 0700 directory without symlinks')
    savepoint = 'tradept_provision_' + secrets.token_hex(8)
    frappe.db.savepoint(savepoint)
    written = False
    try:
        with managed_write():
            work, cfg = repo.workspace(lock=True)
            if cfg.get('loginPolicy', {}).get('enabled') or cfg.get('loginSetup'):
                raise ValueError('Private login already provisioned; refusing to reset access')
            member = {'id': 'initial-admin-' + secrets.token_hex(8),
                'username': 'initial-' + secrets.token_hex(8), 'password': secrets.token_urlsafe(36),
                'visibleCompanyIds': [company['id'] for company in cfg.get('companies', [])]}
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            written = True
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump({'username': member['username'], 'password': member['password'], 'tenantId': cfg['id']}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            # Rollback must not leave a credential file that looks activated.
            frappe.db.after_rollback.add(lambda: path.unlink(missing_ok=True))
            administrator._finance_template(cfg, {'id': 'native:Administrator'}, {'roleKeys': ['admin']})
            administrator._catalog_template(cfg, {'id': 'native:Administrator'}, {'roleKeys': ['admin']})
            user = _provision_initial(work, cfg, member, persist=False)
            count = _retire_workspace_users(except_users=(user,))
            administrator._save(work, cfg, {'id': member['id']}, 'private-deployment-access', {'retiredAccounts': count})
        return {'ok': True, 'setupRequired': True, 'credentialFileWritten': True, 'retiredAccounts': count}
    except Exception:
        frappe.db.rollback(save_point=savepoint)
        if written:
            path.unlink(missing_ok=True)
        raise
