"""Supported app/settings branding; upstream source and notices stay intact."""
import frappe

ASSET = '/assets/tradept_core/'


def install():
    for doctype, values in {
        'Website Settings': {'app_name': 'Tradept', 'favicon': ASSET + 'images/tradept-icon.png', 'banner_image': ASSET + 'images/tradept-logo.png', 'footer_logo': ASSET + 'images/tradept-logo.png', 'footer_powered': '<a href="/tradept-licenses">Tradept · 开源许可与来源</a>'},
        'Navbar Settings': {'app_logo': ASSET + 'images/tradept-logo.png'},
    }.items():
        if not frappe.db.exists('DocType', doctype):
            continue
        meta = frappe.get_meta(doctype)
        for field, value in values.items():
            if meta.has_field(field):
                frappe.db.set_single_value(doctype, field, value)


def boot_session(bootinfo):
    bootinfo.app_name = 'Tradept'
    bootinfo.app_logo_url = ASSET + 'images/tradept-logo.png'
    # Display labels only. Keep upstream app identifiers, routing and permissions.
    for item in bootinfo.get('app_data', []):
        if item.get('app_name', item.get('name')) in ('erpnext', 'frappe'):
            item['app_title'] = 'Tradept' if item.get('app_name', item.get('name')) == 'erpnext' else 'Tradept 系统设置'
            item['app_logo_url'] = ASSET + 'images/tradept-icon.png'
