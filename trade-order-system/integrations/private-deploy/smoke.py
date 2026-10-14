"""Disposable CI-only HTTPS acceptance. Refuses ordinary enterprise deployments."""
from pathlib import Path
import http.cookiejar
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
import shutil
import subprocess
import deploy

state=Path(sys.argv[1]); cfg=deploy.config(state)
assert cfg['domain']=='tradept.test' and cfg['tenant']=='smoke' and cfg['tls']=='internal', 'CI fixture only'
for attempt in range(90):
    try:
        deploy.dc(state,'cp','https:/data/caddy/pki/authorities/local/root.crt',str(state/'internal-root.crt'),capture=True)
        break
    except RuntimeError:time.sleep(2)
else:raise RuntimeError('Private test certificate not ready')
context=ssl.create_default_context(cafile=str(state/'internal-root.crt'))
jar=http.cookiejar.CookieJar()
client=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context),urllib.request.HTTPCookieProcessor(jar))
def request(path,body=None,status=200):
    req=urllib.request.Request(cfg['origin']+path,data=json.dumps(body).encode() if body is not None else None,
                              headers={'Origin':cfg['origin'],'Content-Type':'application/json'})
    try:res=client.open(req,timeout=120)
    except urllib.error.HTTPError as error:res=error
    with res:
        raw=res.read(); value=json.loads(raw) if res.headers.get('Content-Type','').startswith('application/json') else raw
        if res.status!=status:raise RuntimeError(f'{path}: expected {status}, got {res.status}: '+str(value)[:500])
        return value
for attempt in range(90):
    try:
        assert request('/api/login-config')['setupRequired'] is True
        break
    except Exception:
        if attempt==89:raise
        time.sleep(2)
assert request('/api/version')['sourceCommit']==cfg['sourceCommit']
for path in ['/','/vendor/chart.umd.min.js','/vendor/xlsx.full.min.js','/assets/brand/tradept-logo.png']:
    assert request(path)
request('/api/data',status=401)
creds=json.loads((state/'initial-admin.json').read_text())
request('/api/login',{'username':creds['username'],'password':creds['password']})
def admin(resource,value,version=None,status=200):
    revision=request('/api/administrator')['meta']['version'] if version is None else version
    return request('/api/administrator',{'expectedVersion':revision,'resource':resource,'value':value},status=status)
admin('login-policy',{'mode':'accounts','emailVerificationRequired':False,'publicOrigin':cfg['origin']})
assert request('/api/login-config')['setupRequired'] is False
admin('company',{'id':'CI','name':'Tradept Installation Test','country':'China','jurisdiction':'CN','settlementCurrency':'CNY','orderPrefix':'CI'})
admin('onboarding',{'complete':True,'businessPrepared':True})
revision=request('/api/administrator')['meta']['version']
admin('department',{'id':'acceptance','name':'Installation acceptance'},version=revision)
admin('department',{'id':'stale','name':'Must reject'},version=revision,status=409)
assert any(x['id']=='acceptance' for x in request('/api/administrator')['departments'])
assert request('/api/data')
# Recreate the database and queues too, proving named volumes survive replacement.
deploy.dc(state,'up','-d','--wait','--wait-timeout','300','--force-recreate','db','redis-cache','redis-queue')
deploy.dc(state,'up','-d','--no-deps','--force-recreate',*deploy.SERVICES)
assert deploy.run(['systemctl','is-enabled','tradept-private-smoke'],capture=True)=='enabled'
time.sleep(15)
request('/api/login',{'username':creds['username'],'password':creds['password']})
assert any(x['id']=='acceptance' for x in request('/api/administrator')['departments'])
# Back up actual application data and attachments, then restore to an isolated site.
shutil.copyfile(Path(__file__).with_name('restore_probe.py'),state/'control/restore_probe.py')
deploy.dc(state,'stop','scheduler','queue-long','queue-short')
deploy.dc(state,'exec','-T','backend','/home/frappe/frappe-bench/env/bin/python','-c',
          "from pathlib import Path; p=Path('sites/smoke.internal/public/files/install-proof.txt'); p.parent.mkdir(parents=True,exist_ok=True); p.write_text('Tradept restore proof')")
deploy.dc(state,'exec','-T','backend','bench','--site',cfg['site'],'backup','--with-files')
with (state/'restore.log').open('w') as log:
    (state/'restore.log').chmod(0o600)
    restored=subprocess.run(['docker','compose','-p',cfg['project'],'-f',str(state/'compose.json'),
        'run','--rm','--no-deps','init','/home/frappe/frappe-bench/env/bin/python','/run/tradept/restore_probe.py'],stdout=log,stderr=subprocess.STDOUT)
if restored.returncode:raise RuntimeError('Restore failed; see private restore.log')
deploy.dc(state,'up','-d','--no-deps','scheduler','queue-long','queue-short')
deploy.check(state)
print('PASS: new site, trusted HTTPS, assets, actual administrator login, account-only setup, company, persistent data, 409 conflict, container recreation, backup and isolated restore.')
