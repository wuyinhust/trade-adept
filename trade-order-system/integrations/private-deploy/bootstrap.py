"""Run only inside the new enterprise's ERP container; no credential output."""
import json
import os
from pathlib import Path
import subprocess
import sys

CONTROL = Path('/run/tradept')
BENCH = Path('/home/frappe/frappe-bench')


def main():
    cfg = json.loads((CONTROL / 'private.json').read_text())
    site = cfg['site']
    os.chdir(BENCH)
    common = BENCH / 'sites/common_site_config.json'
    values = json.loads(common.read_text()) if common.exists() else {}
    values.update(db_host='db', db_port=3306, redis_cache='redis://redis-cache:6379',
                  redis_queue='redis://redis-queue:6379', redis_socketio='redis://redis-queue:6379', socketio_port=9000)
    common.write_text(json.dumps(values))
    (BENCH / 'sites/apps.txt').write_text('frappe\nerpnext\ntradept_core\n')
    site_path = BENCH / 'sites' / site
    if not site_path.exists():
        subprocess.run(['bench', 'new-site', site, '--mariadb-user-host-login-scope=%',
                        '--db-root-username=root', '--db-root-password='+cfg['databasePassword'],
                        '--admin-password='+cfg['nativePassword'], '--install-app', 'erpnext'], check=True)
    elif not (site_path / 'site_config.json').is_file():
        raise RuntimeError('Incomplete site directory; inspect it before resuming. Nothing was deleted.')
    import frappe
    frappe.init(site=site, sites_path=str(BENCH / 'sites'))
    frappe.connect()
    apps = frappe.get_installed_apps()
    frappe.destroy()
    if 'erpnext' not in apps:
        raise RuntimeError('Existing site has no ERPNext; inspect failed new-site before continuing')
    if 'tradept_core' not in apps:
        subprocess.run(['bench', '--site', site, 'install-app', 'tradept_core'], check=True)
    subprocess.run(['bench', '--site', site, 'migrate'], check=True)
    site_config = site_path / 'site_config.json'
    data = json.loads(site_config.read_text())
    data.update(tradept_gateway_hmac_key=cfg['hmacKey'], host_name=cfg['origin'], disable_signup=1)
    site_config.write_text(json.dumps(data, indent=2))
    site_config.chmod(0o600)
    frappe.init(site=site, sites_path=str(BENCH / 'sites'))
    frappe.connect()
    frappe.set_user('Administrator')
    try:
        from tradept_core.migration import configure_workspace
        from tradept_core.login_setup import provision, configuration
        from tradept_core.assets import ensure
        if not frappe.db.exists('Trade Workspace', 'workspace'):
            configure_workspace({'id': cfg['tenant'], 'name': cfg['name'], 'companies': [],
                                 'users': [], 'allowNativeSignup': False, 'onboarding': {'status': 'required'}})
        work = configuration()
        if work.get('id') != cfg['tenant']:
            raise RuntimeError('Existing tenant differs; refusing replacement')
        if not work.get('loginSetup') and not work.get('loginPolicy', {}).get('configured') and not work.get('loginPolicy', {}).get('enabled'):
            # Resume only the fresh empty tenant created by this installer.
            if frappe.db.count('Trade User Profile'):
                raise RuntimeError('Existing members found; refusing to reprovision credentials')
            provision(str(CONTROL / 'admin-input.json'))
        ensure()
        frappe.db.commit()
    except Exception:
        frappe.db.rollback()
        raise
    finally:
        frappe.destroy()
    subprocess.run(['bench', '--site', site, 'enable-scheduler'], check=True)
    print('Enterprise site ready; credentials remain in the private host file.')


if __name__ == '__main__':
    main()
