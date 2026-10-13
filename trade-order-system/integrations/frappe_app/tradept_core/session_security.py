"""Revoke native sessions without committing the surrounding account change."""
import frappe


def revoke_user_sessions(user):
    # Frappe clear_sessions -> delete_session commits internally. Do not call it
    # inside a workspace/password transaction, where locks must survive audit.
    sessions = frappe.db.sql('SELECT sid FROM `tabSessions` WHERE user=%s FOR UPDATE', (user,), pluck=True)
    frappe.db.delete('Sessions', {'user': user})
    if sessions:
        def invalidate():
            for sid in sessions:
                # Savepoint rollback does not discard transaction callbacks.
                # Leave restored sessions intact if the caller caught a failure.
                if not frappe.db.sql('SELECT sid FROM `tabSessions` WHERE sid=%s LIMIT 1', (sid,)):
                    frappe.cache.hdel('session', sid)
        frappe.db.after_commit.add(invalidate)
    return len(sessions)
