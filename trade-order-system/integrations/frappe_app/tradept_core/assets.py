"""Expose packaged public files in the shared Frappe sites volume."""
from pathlib import Path


REQUIRED = (
    'js/desk-brand.js', 'css/desk-brand.css',
    'images/tradept-logo.png', 'images/tradept-icon.png',
    'licenses/ERPNext-GPL-3.0.txt', 'licenses/Frappe-MIT.txt',
)


def ensure(site_assets=None, source=None):
    public = Path(source) if source is not None else Path(__file__).resolve().parent / 'public'
    public = public.resolve(strict=True)
    if any(not (public / name).is_file() or (public / name).is_symlink() for name in REQUIRED):
        raise RuntimeError('Tradept public assets are incomplete in this image')
    if site_assets is None:
        import frappe
        site_assets = frappe.get_site_path('..', 'assets')
    directory = Path(site_assets).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    link = directory / 'tradept_core'
    if link.is_symlink():
        if link.resolve() != public:
            raise RuntimeError('Existing Tradept asset link points outside the installed app')
    elif link.exists():
        raise RuntimeError('Tradept asset path is not an app symlink; preserve it before migration')
    else:
        link.symlink_to(public, target_is_directory=True)
    return {'ok': True, 'files': len(REQUIRED)}
