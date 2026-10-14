#!/usr/bin/env python3
"""Tradept single-server installer. Run --help; no cloud purchase or demo import."""
from __future__ import annotations
import argparse
import getpass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LOCK = json.loads((HERE / 'dependencies.json').read_text())
DEFAULT_STATE = Path('/opt/tradept-private')
SERVICES = ['backend', 'frontend', 'websocket', 'queue-long', 'queue-short', 'scheduler']


def write(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError('Refusing symlink: '+str(path))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), mode)
    with os.fdopen(fd, 'w') as stream:
        stream.write(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2)+'\n')
    path.chmod(mode)


def run(args, *, cwd=None, capture=False):
    # Never include secret values in host command arguments.
    result = subprocess.run([str(a) for a in args], cwd=cwd, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        raise RuntimeError('Command failed: '+str(args[0])+' (exit '+str(result.returncode)+'); inspect private installation log')
    return result.stdout.strip() if capture else None


def materialize(cache):
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    for item in LOCK['wheels']:
        target = cache / item['name']
        if target.is_symlink():
            raise ValueError('Wheel cache must contain regular files')
        if target.exists():
            data = target.read_bytes()
        else:
            with urllib.request.urlopen(item['url'], timeout=60) as response:
                data = response.read(20 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Dependency checksum mismatch: '+item['name'])
        if not target.exists():
            target.write_bytes(data)
    print('All public build dependencies downloaded and SHA256 verified.')


def validate(domain, tenant, name):
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+', domain) or len(domain)>253:
        raise ValueError('Use a lowercase DNS hostname, without scheme, port or path')
    try:
        import ipaddress
        ipaddress.ip_address(domain)
    except ValueError:
        pass
    else:
        raise ValueError('Use a DNS hostname, not an IP address')
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,30}', tenant):
        raise ValueError('Tenant must be 2-31 lowercase letters/digits/hyphens, starting with a letter')
    if not name.strip() or len(name)>120:
        raise ValueError('Provide the enterprise name (1-120 characters)')


def compose_document(state, cfg):
    state = Path(state)
    shared = {'image': cfg['image'], 'restart': 'unless-stopped',
              'volumes': ['sites:/home/frappe/frappe-bench/sites', 'logs:/home/frappe/frappe-bench/logs'],
              'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}}
    def service(command=None):
        s = json.loads(json.dumps(shared))
        if command: s['command'] = command
        return s
    services = {'backend': service(),
        'websocket': service(['node', '/home/frappe/frappe-bench/apps/frappe/socketio.js']),
        'queue-long': service(['bench', 'worker', '--queue', 'long,default,short']),
        'queue-short': service(['bench', 'worker', '--queue', 'short,default']),
        'scheduler': service(['bench', 'schedule'])}
    services['init'] = service(['/home/frappe/frappe-bench/env/bin/python', '/run/tradept/bootstrap.py'])
    services['init']['restart'] = 'no'
    services['init']['volumes'].append(str(state / 'control')+':/run/tradept:ro')
    services['frontend'] = service(['nginx-entrypoint.sh'])
    services['frontend'].update(ports=['127.0.0.1:3088:8080'], environment={
        'BACKEND': 'backend:8000', 'FRAPPE_SITE_NAME_HEADER': '$$tradept_site_name',
        'SOCKETIO': 'websocket:9000', 'UPSTREAM_REAL_IP_ADDRESS': '127.0.0.1',
        'UPSTREAM_REAL_IP_HEADER': 'X-Forwarded-For', 'UPSTREAM_REAL_IP_RECURSIVE': 'off',
        'PROXY_READ_TIMEOUT': '120', 'CLIENT_MAX_BODY_SIZE': '50m'})
    services['frontend']['volumes'] += [str(state / 'nginx-map.conf')+':/etc/nginx/conf.d/00-tradept-sites-map.conf:ro',
        str(state / 'nginx-template.conf')+':/templates/nginx/frappe.conf.template:ro']
    services['db'] = {'image': LOCK['databaseImage'], 'restart': 'unless-stopped',
        'command': ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', '--skip-character-set-client-handshake'],
        'environment': {'MARIADB_ROOT_PASSWORD_FILE': '/run/secrets/db-password'},
        'volumes': ['db-data:/var/lib/mysql', str(state / 'control/db-password')+':/run/secrets/db-password:ro'],
        'healthcheck': {'test': ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], 'interval': '5s', 'timeout': '5s', 'retries': 60}}
    for name in ('redis-cache', 'redis-queue'):
        services[name] = {'image': LOCK['redisImage'], 'restart': 'unless-stopped',
            'healthcheck': {'test': ['CMD', 'redis-cli', 'ping'], 'interval': '5s', 'timeout': '5s', 'retries': 30}}
    services['redis-queue'].update(command=['redis-server', '--appendonly', 'yes'], volumes=['redis-queue-data:/data'])
    services['https'] = {'image': LOCK['httpsImage'], 'restart': 'unless-stopped', 'network_mode': 'host',
        'volumes': [str(state / 'Caddyfile')+':/etc/caddy/Caddyfile:ro', 'caddy-data:/data', 'caddy-config:/config']}
    return {'name': cfg['project'], 'services': services,
            'volumes': {n: {} for n in ('sites', 'logs', 'db-data', 'redis-queue-data', 'caddy-data', 'caddy-config')}}


def require_root():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('Run this server operation with sudo on Linux; materials can run on your own computer')


def prepare(args):
    require_root()
    validate(args.domain, args.tenant, args.name)
    state = args.state
    if state.exists():
        raise ValueError('State directory already exists. Use install to resume; do not recreate or overwrite credentials.')
    if not re.fullmatch(r'/[a-zA-Z0-9_./-]+', str(state)) or '..' in state.parts or state.resolve()!=state:
        raise ValueError('Use a canonical absolute state path without spaces or symlinks')
    if sys.version_info < (3, 11): raise ValueError('Python 3.11 or later is required')
    for port in (80, 443, 3087, 3088):
        with socket.socket() as probe:
            try: probe.bind(('127.0.0.1', port))
            except OSError: raise ValueError('Port '+str(port)+' is occupied; resolve the conflict before preparing') from None
    if shutil.disk_usage(state.parent).free < 20 * 1024**3:
        raise ValueError('At least 20 GiB free space is required for initial image build and volumes')
    username = args.admin_username or 'owner-'+secrets.token_hex(4)
    if not re.fullmatch('[a-z][a-z0-9._-]{2,63}', username) or username in ('administrator', 'guest'):
        raise ValueError('Invalid administrator username')
    password = getpass.getpass('Private administrator password: ') if args.ask_password else secrets.token_urlsafe(32)
    if not 12 <= len(password) <= 128: raise ValueError('Password must contain 12-128 characters')
    # The checkout, not a developer machine's external files, is the source of truth.
    commit = run(['git', '-c', 'safe.directory='+str(ROOT), 'rev-parse', 'HEAD'], cwd=ROOT, capture=True)
    if not re.fullmatch('[a-f0-9]{40}', commit): raise ValueError('Cannot identify source commit')
    tracked = run(['git', '-c', 'safe.directory='+str(ROOT), 'ls-files', '-z', '--', 'trade-order-system', 'local-preview/vendor'], cwd=ROOT, capture=True).split('\0')
    state.mkdir(mode=0o751, parents=True)
    state.chmod(0o751)
    control = state / 'control'; control.mkdir(mode=0o700)
    release = state / 'source'; release.mkdir(mode=0o755)
    manifest = {}
    for name in tracked:
        if not name: continue
        source = ROOT / name
        if source.is_symlink() or not source.is_file(): raise ValueError('Source file missing or symlink: '+name)
        data = source.read_bytes(); manifest[name] = hashlib.sha256(data).hexdigest()
        dest = release / name; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(data); dest.chmod(0o644)
    manifest_text = json.dumps(manifest, sort_keys=True, separators=(',', ':'))
    digest = hashlib.sha256(manifest_text.encode()).hexdigest()
    write(state / 'source-manifest.json', manifest_text, 0o644)
    version = json.loads((release / 'trade-order-system/package.json').read_text())['version']
    write(release / 'trade-order-system/release-build.json', {'version': version, 'sourceCommit': commit, 'sourceManifestSHA256': digest}, 0o644)
    cfg = {'domain': args.domain, 'origin': 'https://'+args.domain, 'tenant': args.tenant, 'name': args.name,
           'site': args.tenant+'.internal', 'project': 'tradept-'+args.tenant, 'sourceCommit': commit,
           'image': 'tradept-private:'+commit[:12]+'-'+digest[:12], 'tls': args.tls,
           'hmacKey': secrets.token_hex(32), 'databasePassword': secrets.token_urlsafe(40), 'nativePassword': secrets.token_urlsafe(40)}
    write(control / 'private.json', cfg)
    write(control / 'db-password', cfg['databasePassword'])
    write(control / 'admin-input.json', {'administrator': {'id': 'enterprise-admin', 'name': '企业管理员',
          'username': username, 'password': password, 'visibleCompanyIds': []}})
    write(state / 'initial-admin.json', {'username': username, 'password': password, 'url': cfg['origin']})
    shutil.copyfile(HERE / 'bootstrap.py', control / 'bootstrap.py')
    write(state / 'compose.json', compose_document(state, cfg))
    write(state / 'nginx-map.conf', 'map "$http_host|$http_x_frappe_site_name" $tradept_site_name {\n default __tradept_invalid_site__;\n'+
          ''.join(' "'+host+'|'+header+'" '+cfg['site']+';\n' for host,header in [('127.0.0.1:3088',cfg['site']),('127.0.0.1:3088',''),('localhost:3088','')])+'}\n', 0o644)
    shutil.copyfile(ROOT / 'trade-order-system/integrations/erpnext/tradept-frappe-nginx.conf.template', state / 'nginx-template.conf')
    tls = ' tls internal\n' if args.tls=='internal' else ''
    write(state / 'Caddyfile', args.domain+' {\n'+tls+' reverse_proxy 127.0.0.1:3087\n}\n', 0o644)
    write(state / 'INSTALLATION.txt', 'Prepared, not installed or accepted. Resume with the same state directory.\n')
    print('Prepared private configuration. Credentials: '+str(state / 'initial-admin.json')+' (0600); do not paste into chat.')


def config(state):
    if state.is_symlink(): raise ValueError('State directory cannot be a symlink')
    p = state / 'control/private.json'
    if p.is_symlink() or p.stat().st_mode & 0o077: raise ValueError('Private config permissions must be 0600')
    return json.loads(p.read_text())


def dc(state, *args, capture=False):
    cfg = config(state)
    return run(['docker', 'compose', '-p', cfg['project'], '-f', state/'compose.json', *args], capture=capture)


def install(state):
    import pwd
    require_root()
    cfg = config(state)
    run(['docker', 'compose', 'version'])
    dc(state, 'config', '--quiet')
    source = state / 'source'
    # Validate the exact prepared snapshot before building or resuming.
    manifest = json.loads((state / 'source-manifest.json').read_text())
    for name, digest in manifest.items():
        p = source / name
        if p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest()!=digest: raise ValueError('Prepared source changed: '+name)
    materialize(state / 'wheels')
    build = state / 'build'; build.mkdir(exist_ok=True)
    sys.path.insert(0, str(source / 'trade-order-system/integrations/erpnext'))
    from unified_build import application_sources
    app = source / 'trade-order-system/integrations/frappe_app'
    for p in application_sources(app):
        target = build / 'app' / p.relative_to(app); target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(p, target)
    shutil.copytree(state / 'wheels', build / 'wheels', dirs_exist_ok=True)
    shutil.copyfile(HERE / 'Containerfile', build / 'Containerfile')
    run(['docker', 'build', '--build-arg', 'BASE_IMAGE='+LOCK['baseImage'], '-f', build/'Containerfile', '-t', cfg['image'], build])
    uid = int(run(['docker', 'run', '--rm', '--entrypoint', 'id', cfg['image'], '-u'], capture=True))
    gid = int(run(['docker', 'run', '--rm', '--entrypoint', 'id', cfg['image'], '-g'], capture=True))
    os.chown(state / 'control', uid, gid)
    for p in (state / 'control').iterdir(): os.chown(p, uid, gid)
    # Successful init is marked only after all steps, so interrupted installs can resume.
    dc(state, 'up', '-d', '--wait', '--wait-timeout', '300', 'db', 'redis-cache', 'redis-queue')
    if not (state / 'initialized').exists():
        log = state / 'initialize.log'
        with log.open('w') as stream:
            log.chmod(0o600)
            result = subprocess.run(['docker', 'compose', '-p', cfg['project'], '-f', str(state/'compose.json'), 'run', '--rm', '--no-deps', 'init'], stdout=stream, stderr=subprocess.STDOUT)
        if result.returncode: raise RuntimeError('Initialization failed; inspect private '+str(log)+' locally (may contain credentials), then resume install')
        write(state / 'initialized', cfg['sourceCommit']+'\n')
    dc(state, 'up', '-d', '--no-deps', *SERVICES)
    try: account = pwd.getpwnam('tradept-private')
    except KeyError:
        run(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'tradept-private']); account = pwd.getpwnam('tradept-private')
    runtime = state / 'runtime'; runtime.mkdir(mode=0o700, exist_ok=True); runtime.chmod(0o700); os.chown(runtime, account.pw_uid, account.pw_gid)
    routing = runtime / 'frappe-sites.json'
    write(routing, {'tenants': {cfg['tenant']: {'origin': 'http://127.0.0.1:3088', 'site': cfg['site'], 'gatewayHmacKey': cfg['hmacKey']}}})
    os.chown(routing, account.pw_uid, account.pw_gid)
    unit = '[Unit]\nDescription=Tradept private gateway\nAfter=network-online.target docker.service\nRequires=docker.service\n\n[Service]\nUser=tradept-private\nWorkingDirectory='+str(source/'trade-order-system')+'\nExecStart=/usr/bin/python3 -m server.app --runtime '+str(runtime)+' --port 3087 --public-origin '+cfg['origin']+'\nRestart=on-failure\nUMask=0077\nNoNewPrivileges=true\nProtectSystem=strict\nReadWritePaths='+str(runtime)+'\n\n[Install]\nWantedBy=multi-user.target\n'
    service = 'tradept-private-'+cfg['tenant']
    unit_path = Path('/etc/systemd/system') / (service+'.service')
    if unit_path.exists() and unit_path.read_text()!=unit: raise ValueError('Existing systemd service differs; inspect instead of overwriting')
    write(unit_path, unit, 0o644)
    run(['systemctl', 'daemon-reload']); run(['systemctl', 'enable', '--now', service]); run(['systemctl', 'restart', service])
    dc(state, 'up', '-d', '--no-deps', 'https')
    print('Services started. Wait for DNS/certificate, run check, then complete company setup in the browser.')


def check(state):
    cfg = config(state)
    dc(state, 'ps', '-a')
    # Public HTTPS is checked with normal certificate verification; private CA is explicit.
    import ssl
    context = ssl.create_default_context(cafile=str(state/'internal-root.crt') if cfg['tls']=='internal' else None)
    with urllib.request.urlopen(cfg['origin']+'/api/version', timeout=30, context=context) as response:
        v = json.load(response)
    manifest_hash = hashlib.sha256((state/'source-manifest.json').read_bytes()).hexdigest()
    if v['sourceCommit']!=cfg['sourceCommit'] or v['sourceManifestSHA256']!=manifest_hash: raise ValueError('Public endpoint does not serve this installation')
    with urllib.request.urlopen(cfg['origin']+'/api/login-config', timeout=30, context=context) as response: json.load(response)
    print('HTTPS, version and login endpoint passed. This does not replace employee, business, restart or restore acceptance.')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--state', type=Path, default=DEFAULT_STATE)
    sub = p.add_subparsers(dest='action', required=True)
    m=sub.add_parser('materials'); m.add_argument('--cache', type=Path, required=True)
    a=sub.add_parser('prepare'); a.add_argument('--domain',required=True); a.add_argument('--tenant',default='enterprise'); a.add_argument('--name',required=True)
    a.add_argument('--admin-username'); a.add_argument('--ask-password',action='store_true'); a.add_argument('--tls',choices=['public','internal'],default='public')
    sub.add_parser('install'); sub.add_parser('check')
    args=p.parse_args()
    try:
        if args.action=='materials': materialize(args.cache)
        elif args.action=='prepare': prepare(args)
        elif args.action=='install': install(args.state)
        elif args.action=='check': check(args.state)
    except (ValueError, RuntimeError, OSError) as e:
        p.exit(1, str(e)+'\n')


if __name__=='__main__': main()
