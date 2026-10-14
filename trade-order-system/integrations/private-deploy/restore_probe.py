"""CI-only restore of a disposable install; never targets the source site."""
import json
import os
from pathlib import Path
import subprocess
cfg=json.loads(Path('/run/tradept/private.json').read_text())
assert cfg['domain']=='tradept.test' and cfg['tenant']=='smoke' and cfg['tls']=='internal'
bench=Path('/home/frappe/frappe-bench');os.chdir(bench/'sites')
source=bench/'sites'/cfg['site'];dest='smoke-restore.internal'
assert not (bench/'sites'/dest).exists()
backups=source/'private/backups'
db=sorted(backups.glob('*database.sql.gz'))[-1]
public=sorted(p for p in backups.glob('*files*') if 'private-files' not in p.name)[-1]
private=sorted(backups.glob('*private-files*'))[-1]
subprocess.run(['bench','new-site',dest,'--mariadb-user-host-login-scope=%','--db-root-username=root',
                '--db-root-password='+cfg['databasePassword'],'--admin-password='+cfg['nativePassword'],'--install-app','erpnext','--install-app','tradept_core'],check=True)
site_config=bench/'sites'/dest/'site_config.json';values=json.loads(site_config.read_text())
original=json.loads((source/'site_config.json').read_text())
if 'encryption_key' in original:values['encryption_key']=original['encryption_key']
values.update(pause_scheduler=1,mute_emails=1)
site_config.write_text(json.dumps(values))
subprocess.run(['bench','--site',dest,'restore',str(db),'--with-public-files',str(public),'--with-private-files',str(private),
                '--db-root-username','root','--db-root-password',cfg['databasePassword'],'--force'],check=True)
import frappe
frappe.init(site=dest,sites_path=str(bench/'sites'));frappe.connect();frappe.set_user('Administrator')
work=json.loads(frappe.db.get_value('Trade Workspace','workspace','configuration'))
assert work['id']=='smoke' and work['departments']['acceptance']['name']=='Installation acceptance'
assert frappe.db.count('Trade User Profile')==1
assert (bench/'sites'/dest/'public/files/install-proof.txt').read_text()=='Tradept restore proof'
assert frappe.db.exists('Company','Tradept Installation Test')
frappe.destroy()
print('PASS: isolated database restore preserves company, administrator and saved department.')
