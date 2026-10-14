"""Print installation diagnostics with known private values removed (CI only)."""
from pathlib import Path
import json
import re
import sys
state=Path(sys.argv[1]);values=[]
for p in [state/'control/private.json',state/'initial-admin.json']:
    if p.exists():
        d=json.loads(p.read_text());values += [v for k,v in d.items() if isinstance(v,str) and ('password' in k.lower() or 'key' in k.lower())]
for name in ['initialize.log','restore.log']:
    p=state/name
    if p.exists():
        s=p.read_text(errors='replace')[-12000:]
        for value in values:s=s.replace(value,'[REDACTED]')
        print(s)
