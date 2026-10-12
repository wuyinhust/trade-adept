"""Run in the isolated Lima guest to back up both native tenant databases.

The caller pauses workspace writes first. SQL, files and site_config stay in
private directories; only hashes and counts are printed. This never restores
or re-submits documents, and refuses to overwrite an earlier backup run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

PRIVATE = Path("/home/wangyao.guest/trade-private")
CONTAINER = "tradept-erp-backend-1"
PYTHON = "/home/frappe/frappe-bench/env/bin/python"
SITES = ("frontend", "grandware.test")


def run(command, *, data=None):
    return subprocess.run(command, input=data, text=True, capture_output=True, timeout=180)


def metadata():
    code = """import os,json,hashlib,contextlib,io,pathlib
os.chdir('/home/frappe/frappe-bench/sites');import frappe
from tradept_core import repository as repo
result=[]
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,default=str,separators=(',',':')).encode()).hexdigest()
def file_digest(site):
 values={}
 for folder in ('public/files','private/files'):
  base=pathlib.Path(site)/folder
  if base.exists():
   for p in sorted(base.rglob('*')):
    key=folder+'/'+p.relative_to(base).as_posix()
    if p.is_symlink():values[key]={'linkSHA256':hashlib.sha256(os.readlink(p).encode()).hexdigest()}
    elif p.is_file():values[key]={'contentSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
 return digest(values)
with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
 for site in ('frontend','grandware.test'):
  frappe.init(site);frappe.connect();frappe.set_user('Administrator')
  work,cfg=repo.workspace();rates,metas=repo.rates()
  business={'projected':repo.payload(),'stored':repo.payload(native_projection=False),'rates':rates,'rateMetas':metas,'meta':repo.meta(work),'configuration':cfg}
  types=('Company','Customer','Supplier','Contact','Currency Exchange','Item','Trade Legacy Order','Trade Order Brief','Trade Shipment','Trade Document','Trade User Profile','Trade Snapshot','Trade Audit','Sales Order','Purchase Order','Delivery Note','Payment Entry','GL Entry','Payment Ledger Entry','Advance Payment Ledger Entry')
  rows={dt:[dict(row) for row in frappe.get_all(dt,fields=['*'],order_by='name asc')] for dt in types}
  result.append({'site':site,'revision':int(work.revision),'databaseNameSHA256':hashlib.sha256(str(frappe.conf.db_name).encode()).hexdigest(),'businessAndRatesAndMetadataSHA256':digest(business),'nativeDocumentsAndLedgersSHA256':digest(rows),'publicAndPrivateFileContentsSHA256':file_digest(site),'counts':{dt:len(values) for dt,values in rows.items()}})
  frappe.db.rollback();frappe.destroy()
print(json.dumps(result))
"""
    result = run(["sudo", "docker", "exec", "-i", CONTAINER, PYTHON, "-"], data=code)
    if result.returncode:
        raise RuntimeError("Native backup metadata could not be read")
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,60}", args.backup_id):
        parser.error("Use a simple unique backup identifier")
    if PRIVATE.is_symlink() or not PRIVATE.is_dir() or PRIVATE.stat().st_uid != os.getuid() or stat.S_IMODE(PRIVATE.stat().st_mode) != 0o700:
        parser.error("Private base must be a real owned directory with mode0700")
    # Earlier Docker-copy baselines can be owned by the container UID. Use a
    # new guest-owned namespace without changing those immutable backups.
    output = PRIVATE / "unified-native-backups" / args.backup_id
    if output.parent.is_symlink() or output.is_symlink() or output.exists():
        parser.error("An existing backup run must never be overwritten")
    output.mkdir(mode=0o700, parents=True)
    output.parent.chmod(0o700)
    before = metadata()
    files = {}
    for site in SITES:
        # Frappe16 default-backup housekeeping treats nested directories as
        # removable files. Dedicated archives must live outside that folder.
        source = f"/home/frappe/frappe-bench/sites/{site}/private/tradept-native-backups/{args.backup_id}"
        code = "from pathlib import Path; p=Path(input()); assert not p.exists() and not p.parent.is_symlink(); p.parent.mkdir(mode=0o700, exist_ok=True); p.parent.chmod(0o700); p.mkdir(mode=0o700); p.chmod(0o700)"
        result = run(["sudo", "docker", "exec", "-i", CONTAINER, PYTHON, "-c", code], data=source)
        if result.returncode:
            raise RuntimeError("A native backup directory already exists or is unavailable")
        result = run(["sudo", "docker", "exec", CONTAINER, "bench", "--site", site, "backup", "--with-files", "--ignore-backup-conf", "--backup-path", source])
        diagnostic = output / (site + "-backup-diagnostic.txt")
        diagnostic.write_text(result.stdout + result.stderr)
        diagnostic.chmod(0o600)
        if result.returncode:
            raise RuntimeError("Native backup failed; inspect the private diagnostic")
        code = "from pathlib import Path; p=Path(input()); p.chmod(0o700); [f.chmod(0o600) for f in p.iterdir() if f.is_file()]"
        result = run(["sudo", "docker", "exec", "-i", CONTAINER, PYTHON, "-c", code], data=source)
        if result.returncode:
            raise RuntimeError("Native backup private modes could not be set")
        destination = output / site
        destination.mkdir(mode=0o700)
        result = run(["sudo", "docker", "cp", f"{CONTAINER}:{source}/.", str(destination)])
        if result.returncode:
            raise RuntimeError("Native backup files could not be copied")
        result = run(["sudo", "chown", "-R", f"{os.getuid()}:{os.getgid()}", str(destination)])
        if result.returncode:
            raise RuntimeError("Backup ownership could not be restricted")
        values = {}
        for path in destination.iterdir():
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("Unexpected native backup file")
            path.chmod(0o600)
            values[path.name] = {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        if len(values) != 4 or not any(n.endswith("-database.sql.gz") for n in values) or not any(n.endswith("-site_config_backup.json") for n in values) or not any(n.endswith("-private-files.tar") for n in values) or not any(n.endswith("-files.tar") and not n.endswith("-private-files.tar") for n in values):
            raise RuntimeError("SQL, public/private files and configuration backup are all required")
        files[site] = values
    after = metadata()
    distinct = before[0]["databaseNameSHA256"] != before[1]["databaseNameSHA256"]
    manifest = {"ok": before == after and distinct, "backupId": args.backup_id, "nativeBackupWithFiles": True,
                "sites": files, "before": before, "after": after,
                "tenantDatabasesDistinct": distinct,
                "directoryMode": "0700", "fileMode": "0600", "businessDocumentsSubmitted": 0}
    path = output / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    path.chmod(0o600)
    print(json.dumps({"ok": manifest["ok"], "privateBackupDirectory": str(output),
                      "manifestSHA256": hashlib.sha256(path.read_bytes()).hexdigest(),
                      "backupFiles": sum(len(v) for v in files.values()), "beforeEqualsAfter": before == after}))
    if not manifest["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
