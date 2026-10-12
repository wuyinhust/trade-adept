"""Check or set the product's big.middle.small release number."""
import argparse
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('version', nargs='?')
args = parser.parse_args()
package = json.loads((root / 'package.json').read_text())
lock = json.loads((root / 'package-lock.json').read_text())
html = (root / 'index.html').read_text()
version = args.version or package['version']
if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
    parser.error('Version must be three nonnegative integers, for example 0.11.234')
if args.version:
    package['version'] = version
    lock['version'] = lock['packages']['']['version'] = version
    html = re.sub(r'(?<=\?v=)\d+\.\d+\.\d+', version, html)
    for name, value in [('package.json', package), ('package-lock.json', lock)]:
        (root / name).write_text(json.dumps(value, ensure_ascii=False, indent=4) + '\n')
    (root / 'index.html').write_text(html)
versions = set(re.findall(r'\?v=(\d+\.\d+\.\d+)', html))
if package['version'] != version or lock['version'] != version or lock['packages']['']['version'] != version or versions != {version}:
    raise SystemExit('Release metadata or asset cache versions differ')
print(f'Tradept {version}: package, lock and entry assets agree')
