"""Tenant authorization and atomic SQLite change sets.

JSON storage is an internal, transactionally versioned tenant aggregate. Clients
never submit a replacement aggregate: only authorized record patches are accepted.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import sqlite3
import time
from datetime import datetime, timezone
import uuid
from contextlib import contextmanager
import re
import subprocess
import sys

COLLECTIONS = ("orders", "customers", "factories", "shipments", "invoices")
SESSION_TTL = 8 * 3600
PBKDF2_ROUNDS = 600_000
DEFAULT_ROLES = {
    "admin": {"scope": "tenant", "permissions": ["read", "create", "edit", "delete", "assign", "finance.read", "finance.write", "rates.write", "snapshots.read", "snapshots.restore", "accounts.configure"], "pages": ["dashboard", "orders", "customers", "factories", "shipping", "profit", "settings"]},
    "finance": {"scope": "tenant", "permissions": ["read", "create", "edit", "assign", "finance.read", "finance.write", "rates.write"], "pages": ["dashboard", "orders", "customers", "factories", "shipping", "profit", "settings"]},
    "manager": {"scope": "team", "permissions": ["read", "create", "edit", "delete"], "pages": ["dashboard", "orders", "customers", "factories", "shipping"]},
    "salesperson": {"scope": "self", "permissions": ["read", "create", "edit", "delete"], "pages": ["dashboard", "orders", "customers", "factories", "shipping"]},
    "document": {"scope": "self", "permissions": ["read", "create", "edit"], "pages": ["dashboard", "orders", "customers", "factories", "shipping"]},
}
DEFAULT_ROLES = {name: {**policy, "readScopes": {"factories": "entities"}} for name, policy in DEFAULT_ROLES.items()}
HIDDEN_FIELDS = {"factoryCostRMB", "factoryCostUSD", "freightCostUSD", "freightCostRMB", "insuranceCostUSD", "otherCostUSD", "otherCostRMB", "orderAmountRMB", "profitRMB", "profitUSD", "profitRate", "margin", "paidAmountUSD", "paymentStatus", "costPaidUSD", "costPaymentStatus", "bankInfo", "bankAccount", "paidCostRMB", "paidCostUSD", "factoryCostPaid", "factoryPaidRMB"}
NESTED_COST = {"totalAmount", "prepayment", "paidAmount", "cost", "costUSD", "costRMB", "paidCostRMB", "paidCostUSD", "costPaidUSD", "paymentStatus", "costPaymentStatus"}
DERIVED = {"profitRMB", "profitUSD", "profitRate", "orderAmountRMB"}
FINANCIAL_INPUT = {"orderAmountUSD", "factoryCostRMB", "freightCostUSD", "insuranceCostUSD", "otherCostUSD", "factories", "companyId"}


def sensitive(key, nested=False):
    if key == "profitPolicy":
        return False
    lowered = str(key).replace("_", "").lower()
    return key in HIDDEN_FIELDS or (nested and key in NESTED_COST) or lowered.startswith(("profit", "margin", "factorycost", "costpaid", "paidcost", "bank", "paidamount", "costpayment", "paymentstatus", "freightcost", "insurancecost", "othercost", "prepayment")) or (nested and lowered.startswith("cost"))


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def safe_record_id(value):
    return isinstance(value, str) and re.fullmatch(r"[\w.:-]{1,200}", value) is not None


def validate_embedded_ids(value):
    """Legacy UI embeds technical identifiers in inline event attributes."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("id", "factoryId") and not safe_record_id(child):
                raise APIError(400, "INVALID_RECORD_ID", "Technical identifiers contain unsafe characters")
            validate_embedded_ids(child)
    elif isinstance(value, list):
        for child in value:
            validate_embedded_ids(child)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def password_hash(password):
    if not isinstance(password, str) or len(password) < 12:
        raise ValueError("Configured passwords must contain at least 12 characters")
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ROUNDS).hex()
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt}${digest}"


def password_ok(password, encoded):
    try:
        algo, rounds, salt, expected = encoded.split("$")
        if algo != "pbkdf2_sha256" or not isinstance(password, str):
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


class APIError(Exception):
    def __init__(self, status, code, message, **details):
        super().__init__(message)
        self.status, self.code, self.details = status, code, details

    def response(self):
        return {"error": str(self), "code": self.code, **self.details}


def secure_runtime(path):
    directory = Path(path).resolve()
    # SMB can briefly report chmod's requested mode from its attribute cache
    # even though the remote filesystem still exposes 0777. It also cannot be
    # assumed to provide SQLite's local locking/durability contract.
    mounts = []
    if sys.platform == "darwin":
        try:
            listing = subprocess.check_output(["/sbin/mount"], text=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            raise RuntimeError("Cannot verify local runtime filesystem")
        for line in listing.splitlines():
            match = re.search(r" on (.+?) \(([^, )]+)", line)
            if match:
                mounts.append((match[1], match[2]))
    elif Path("/proc/mounts").exists():
        for line in Path("/proc/mounts").read_text().splitlines():
            parts = line.split()
            if len(parts) > 2:
                mounts.append((parts[1].replace("\\040", " "), parts[2]))
    candidates = [(mount, kind) for mount, kind in mounts if str(directory) == mount or str(directory).startswith(mount.rstrip("/") + "/")]
    if candidates:
        _, kind = max(candidates, key=lambda pair: len(pair[0]))
        if kind in {"smbfs", "cifs", "nfs", "nfs4", "afpfs", "fuse.sshfs", "9p"}:
            raise RuntimeError("Runtime must be on a private local filesystem, not a network share; use --runtime /private/tmp/... or a persistent local directory")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    if os.name != "nt" and directory.stat().st_mode & 0o077:
        raise RuntimeError("Runtime filesystem cannot enforce private permissions; use --runtime on an APFS/private filesystem")
    return directory


class Store:
    def __init__(self, runtime):
        self.runtime = secure_runtime(runtime)
        self.path = self.runtime / "workspace.sqlite3"
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self.path, 0o600)
        if os.name != "nt" and self.path.stat().st_mode & 0o077:
            raise RuntimeError("Database permissions must be 0600")
        with self.connect() as db:
            db.executescript("""
              PRAGMA journal_mode=DELETE;
              CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, config TEXT NOT NULL,
                payload TEXT NOT NULL, rates TEXT NOT NULL, rate_metas TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS users(tenant_id TEXT NOT NULL,id TEXT NOT NULL,
                username TEXT NOT NULL COLLATE NOCASE,password TEXT NOT NULL,profile TEXT NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,username));
              CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                user_id TEXT NOT NULL,expires INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                revision INTEGER NOT NULL,payload TEXT NOT NULL,rates TEXT NOT NULL,rate_metas TEXT NOT NULL,
                created_at TEXT NOT NULL,actor_id TEXT NOT NULL,kind TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,
                revision INTEGER NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,locked_until INTEGER NOT NULL);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
        finally:
            db.close()

    def configure(self, configuration):
        """CLI-only configuration; passwords never enter tenant JSON or APIs."""
        generated = []
        tenants = configuration.get("tenants", [])
        if not tenants:
            raise ValueError("Configuration must include tenants")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for supplied in tenants:
                    cfg = copy.deepcopy(supplied)
                    tid = str(cfg["id"])
                    users = cfg.pop("users", [])
                    if not tid or not cfg.get("companies"):
                        raise ValueError("Tenant must have an id and legal entities")
                    company_ids = [str(c["id"]) for c in cfg["companies"]]
                    if len(set(company_ids)) != len(company_ids):
                        raise ValueError("Duplicate company ID")
                    overrides = cfg.get("roles", {})
                    cfg["roles"] = {**copy.deepcopy(DEFAULT_ROLES), **{name: {**copy.deepcopy(DEFAULT_ROLES.get(name, {})), **policy} for name, policy in overrides.items()}}
                    for role in cfg["roles"].values():
                        if role.get("scope") not in ("self", "team", "tenant"):
                            raise ValueError("Role scope must be self, team or tenant")
                        if not isinstance(role.get("pages", []), list) or any(not isinstance(page, str) for page in role.get("pages", [])):
                            raise ValueError("Role pages must be an array of page names")
                        read_scopes = role.get("readScopes", {})
                        if not isinstance(read_scopes, dict) or any(c not in COLLECTIONS or scope not in ("self", "team", "entities", "tenant") for c, scope in read_scopes.items()):
                            raise ValueError("Role readScopes requires known collections and self/team/entities/tenant scope")
                    existing = db.execute("SELECT id FROM tenants WHERE id=?", (tid,)).fetchone()
                    if existing:
                        db.execute("UPDATE tenants SET config=? WHERE id=?", (dumps(cfg), tid))
                    else:
                        payload = {c: [] for c in COLLECTIONS}
                        rates = {c["id"]: c.get("exchangeRate", 7.25) for c in cfg["companies"]}
                        db.execute("INSERT INTO tenants VALUES(?,?,?,?,?,?,?,?)", (tid, dumps(cfg), dumps(payload), dumps(rates), "{}", 0, now(), "configuration"))
                        self._snapshot(db, tid, payload, rates, {}, 0, "configuration", "init")
                    configured_ids = []
                    for supplied_user in users:
                        profile = copy.deepcopy(supplied_user)
                        uid = str(profile["id"])
                        username = str(profile["username"]).strip()
                        if not username or profile.get("role") not in cfg["roles"]:
                            raise ValueError("Invalid configured username or role")
                        password = profile.pop("password", None)
                        profile.pop("passwordHash", None)
                        profile["id"], profile["username"], profile["tenantId"] = uid, username, tid
                        old = db.execute("SELECT password FROM users WHERE tenant_id=? AND id=?", (tid, uid)).fetchone()
                        if password is None and old:
                            encoded = old["password"]
                        else:
                            password = password or secrets.token_urlsafe(18)
                            encoded = password_hash(password)
                            if "password" not in supplied_user:
                                generated.append({"tenantId": tid, "id": uid, "username": username, "password": password})
                        disabled = int(bool(profile.pop("disabled", False)))
                        db.execute("INSERT INTO users VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET username=excluded.username,password=excluded.password,profile=excluded.profile,disabled=excluded.disabled", (tid, uid, username, encoded, dumps(profile), disabled))
                        configured_ids.append(uid)
                        if disabled or (old and "password" in supplied_user):
                            db.execute("DELETE FROM sessions WHERE tenant_id=? AND user_id=?", (tid, uid))
                    # An omitted account is revoked, not silently kept active.
                    for row in db.execute("SELECT id FROM users WHERE tenant_id=?", (tid,)):
                        if row["id"] not in configured_ids:
                            db.execute("UPDATE users SET disabled=1 WHERE tenant_id=? AND id=?", (tid, row["id"]))
                            db.execute("DELETE FROM sessions WHERE tenant_id=? AND user_id=?", (tid, row["id"]))
                db.commit()
            except Exception:
                db.rollback()
                raise
        if generated:
            credential_path = self.runtime / "demo-credentials.json"
            existing = json.loads(credential_path.read_text()) if credential_path.exists() else []
            lookup = {(r["tenantId"], r["id"]): r for r in existing + generated}
            fd = os.open(credential_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                output.write(json.dumps(list(lookup.values()), ensure_ascii=False, indent=2))
            os.chmod(credential_path, 0o600)
        return len(generated)

    def login(self, tenant_id, username, password):
        if not all(isinstance(v, str) for v in (tenant_id, username, password)) or len(password) > 1024:
            raise APIError(400, "INVALID_LOGIN", "Invalid login request")
        key = tenant_id + ":" + username.strip().casefold()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            lock = db.execute("SELECT * FROM login_attempts WHERE key=?", (key,)).fetchone()
            if lock and lock["attempts"] >= 5 and lock["locked_until"] > time.time():
                raise APIError(429, "LOGIN_LOCKED", "Too many login attempts; try again later")
            row = db.execute("SELECT * FROM users WHERE tenant_id=? AND username=? COLLATE NOCASE", (tenant_id, username.strip())).fetchone()
            valid = row is not None and not row["disabled"] and password_ok(password, row["password"])
            if not valid:
                # Perform comparable work for unknown accounts.
                if row is None or row["disabled"]:
                    hashlib.pbkdf2_hmac("sha256", password.encode(), b"unknown-user-salt", PBKDF2_ROUNDS)
                attempts = (lock["attempts"] if lock and lock["locked_until"] >= time.time() else 0) + 1
                db.execute("INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)", (key, attempts, int(time.time()) + (900 if attempts >= 5 else 60)))
                db.commit()
                raise APIError(401, "INVALID_CREDENTIALS", "Invalid username or password")
            db.execute("DELETE FROM login_attempts WHERE key=?", (key,))
            token = secrets.token_urlsafe(32)
            db.execute("INSERT INTO sessions VALUES(?,?,?,?)", (self._token_hash(token), tenant_id, row["id"], int(time.time()) + SESSION_TTL))
            db.commit()
            return token

    @staticmethod
    def _token_hash(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def logout(self, token):
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (self._token_hash(token or ""),))

    def actor(self, token):
        if not isinstance(token, str) or len(token) < 32:
            raise APIError(401, "SESSION_REQUIRED", "Please sign in")
        with self.connect() as db:
            row = db.execute("SELECT u.* FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id WHERE token_hash=? AND expires>? AND u.disabled=0", (self._token_hash(token), int(time.time()))).fetchone()
            if not row:
                raise APIError(401, "SESSION_REQUIRED", "Session expired or revoked")
            return json.loads(row["profile"])

    def _tenant(self, db, actor):
        row = db.execute("SELECT * FROM tenants WHERE id=?", (actor["tenantId"],)).fetchone()
        if not row:
            raise APIError(404, "TENANT_NOT_FOUND", "Tenant unavailable")
        return row, json.loads(row["config"])

    def _current_actor(self, db, actor):
        row = db.execute("SELECT profile FROM users WHERE tenant_id=? AND id=? AND disabled=0", (actor["tenantId"], actor["id"])).fetchone()
        if not row:
            raise APIError(401, "SESSION_REQUIRED", "Account is disabled or removed")
        return json.loads(row["profile"])

    def _policy(self, cfg, actor):
        return cfg.get("roles", {}).get(actor.get("role"), {"scope": "self", "permissions": []})

    def permitted(self, cfg, actor, action, collection=None):
        policy = self._policy(cfg, actor)
        permissions = policy.get("permissions", [])
        if isinstance(permissions, dict):
            allowed = bool(permissions.get(action))
        else:
            allowed = action in permissions
        restrictions = policy.get("collections")
        return allowed and (not collection or restrictions is None or collection in restrictions)

    def company_ids(self, cfg, actor):
        known = {str(c["id"]) for c in cfg["companies"]}
        if actor.get("visibleCompanyIds") is not None:
            return known.intersection(map(str, actor["visibleCompanyIds"]))
        team = cfg.get("teams", {}).get(actor.get("teamId"))
        if not team or team.get("visibleCompanyIds") is None:
            return set()  # Explicit grants required for ordinary accounts.
        return known.intersection(map(str, team["visibleCompanyIds"]))

    def record_allowed(self, db, cfg, actor, record, action="read", collection=None):
        if not self.permitted(cfg, actor, action, collection):
            return False
        if record.get("tenantId") not in (None, actor["tenantId"]):
            return False
        policy = self._policy(cfg, actor)
        company = record.get("companyId")
        if company not in self.company_ids(cfg, actor):
            # Fully granted tenant admins can inspect quarantined legacy records;
            # ordinary accounts never gain access through missing company IDs.
            unknown = company not in {c["id"] for c in cfg["companies"]}
            complete_grants = self.company_ids(cfg, actor) == {c["id"] for c in cfg["companies"]}
            return unknown and complete_grants and policy.get("scope") == "tenant" and self.permitted(cfg, actor, "accounts.configure") and action in ("read", "edit", "delete")
        scope = policy.get("readScopes", {}).get(collection, policy.get("scope")) if action == "read" else policy.get("scope")
        if scope in ("tenant", "entities"):
            return True
        users = {r["id"]: json.loads(r["profile"]) for r in db.execute("SELECT id,profile FROM users WHERE tenant_id=? AND disabled=0", (actor["tenantId"],))}
        owners = {str(record[k]) for k in ("createdBy", "salespersonId", "ownerId") if record.get(k) is not None}
        owners.intersection_update(users)
        if scope == "self":
            return actor["id"] in owners
        if not actor.get("teamId"):
            return False
        return any(users[uid].get("teamId") == actor["teamId"] for uid in owners)

    def _visible_record(self, cfg, actor, record):
        result = copy.deepcopy(record)
        if not self.permitted(cfg, actor, "finance.read"):
            def redact(value, nested=False):
                if isinstance(value, dict):
                    return {key: redact(child, True) for key, child in value.items() if not sensitive(key, nested)}
                if isinstance(value, list):
                    return [redact(child, nested) for child in value]
                return value
            result = redact(result)
        return result

    @staticmethod
    def _meta(row):
        return {"version": row["revision"], "updatedAt": row["updated_at"], "updatedBy": row["updated_by"]}

    def session(self, actor):
        with self.connect() as db:
            _, cfg = self._tenant(db, actor)
            ids = self.company_ids(cfg, actor)
            policy = self._policy(cfg, actor)
            actor = {**actor, "visibleCompanyIds": sorted(ids), "permissions": policy.get("permissions", []), "pages": policy.get("pages", []), "scope": policy.get("scope", "self"), "readScopes": policy.get("readScopes", {}), "baseRole": policy.get("baseRole", actor["role"])}
            users = []
            for row in db.execute("SELECT profile FROM users WHERE tenant_id=? AND disabled=0", (actor["tenantId"],)):
                profile = json.loads(row["profile"])
                users.append({k: profile.get(k) for k in ("id", "name", "username", "role", "teamId", "visibleCompanyIds")})
            teams = copy.deepcopy(cfg.get("teams", {}))
            # Return only team grants relevant to the current data scope.
            if self._policy(cfg, actor).get("scope") != "tenant":
                teams = {k: v for k, v in teams.items() if k == actor.get("teamId")}
                users = [u for u in users if u["id"] == actor["id"] or u.get("teamId") == actor.get("teamId")]
            return {"user": actor, "users": users, "teams": teams, "companies": [c for c in cfg["companies"] if c["id"] in ids], "roles": cfg["roles"], "tenant": {"id": cfg["id"], "name": cfg.get("name", cfg["id"]), "branding": cfg.get("branding", {})}}

    def data(self, actor):
        with self.connect() as db:
            row, cfg = self._tenant(db, actor)
            payload = json.loads(row["payload"])
            result = {c: [] for c in COLLECTIONS}
            visible_orders = set()
            for collection in COLLECTIONS:
                for record in payload.get(collection, []):
                    if record.get("deleted") or not self.record_allowed(db, cfg, actor, record, collection=collection):
                        continue
                    if collection in ("shipments", "invoices") and str(record.get("orderId")) not in visible_orders:
                        continue
                    result[collection].append(self._visible_record(cfg, actor, record))
                    if collection == "orders":
                        visible_orders.add(str(record["id"]))
            ids = self.company_ids(cfg, actor)
            return {"data": result, "exchangeRates": {k: v for k, v in json.loads(row["rates"]).items() if k in ids}, "rateMetas": {k: v for k, v in json.loads(row["rate_metas"]).items() if k in ids}, "meta": self._meta(row)}

    def meta(self, actor):
        with self.connect() as db:
            row, _ = self._tenant(db, actor)
            return {"ok": True, "meta": self._meta(row)}

    @staticmethod
    def _expected(row, expected):
        if type(expected) is not int or expected < 0:
            raise APIError(400, "EXPECTED_VERSION_REQUIRED", "expectedVersion must be a nonnegative integer")
        if expected != row["revision"]:
            raise APIError(409, "VERSION_CONFLICT", "Data changed; reload and review your pending changes", latestVersion=row["revision"])

    def _prepare_patch(self, db, cfg, actor, collection, old, patch):
        if not isinstance(patch, dict):
            raise APIError(400, "INVALID_PATCH", "Record value must be an object")
        patch = copy.deepcopy(patch)
        validate_embedded_ids(patch)
        if patch.get("tenantId", actor["tenantId"]) != actor["tenantId"]:
            raise APIError(403, "TENANT_DENIED", "Cannot change tenant")
        for key in ("tenantId", "id", "updatedAt", "updatedBy", "revision"):
            patch.pop(key, None)
        if "deleted" in patch or "deletedAt" in patch:
            raise APIError(400, "USE_DELETE_OPERATION", "Use deleted:true change operation")
        for key in ("createdBy", "createdAt"):
            if old and key in patch and patch[key] != old.get(key):
                raise APIError(403, "IMMUTABLE_FIELD", "Cannot change record origin")
        for key in ("profitPolicy", "settlementCurrency"):
            if key in patch and patch[key] != (old or {}).get(key):
                raise APIError(403, "IMMUTABLE_FIELD", "Company financial policy is configured on the server")
        if not self.permitted(cfg, actor, "assign"):
            for key in ("salespersonId", "ownerId", "createdBy"):
                if key in patch and patch[key] not in (actor["id"], (old or {}).get(key), None):
                    raise APIError(403, "ASSIGNMENT_DENIED", "Cannot assign another user's records")
        can_finance = self.permitted(cfg, actor, "finance.write")
        for key in list(patch):
            if sensitive(key):
                if key in DERIVED or key.lower().startswith(("profit", "margin")):
                    # Calculated fields are never client authority.
                    if not can_finance and patch[key] != (old or {}).get(key):
                        raise APIError(403, "FIELD_DENIED", "Financial fields require permission")
                    patch.pop(key)
                elif not can_finance and patch[key] != (old or {}).get(key):
                    raise APIError(403, "FIELD_DENIED", "Financial fields require permission")
        if "factories" in patch:
            if not isinstance(patch["factories"], list) or any(not isinstance(f, dict) for f in patch["factories"]):
                raise APIError(400, "INVALID_FACTORIES", "Factory entries must be an array of objects")
            factory_ids = [str(f.get("factoryId") or "").strip() for f in patch["factories"]]
            if any(not rid for rid in factory_ids) or len(set(factory_ids)) != len(factory_ids):
                raise APIError(400, "DUPLICATE_FACTORY_ENTRY", "Factory entries require unique factoryId values; multiple lines need a separate stable detail-ID schema")
            old_entries = (old or {}).get("factories", [])
            if not can_finance:
                old_ids = [str(f.get("factoryId") or "").strip() for f in old_entries]
                if any(not rid for rid in old_ids) or len(set(old_ids)) != len(old_ids):
                    raise APIError(403, "FIELD_DENIED", "Legacy factory lines need a schema-aware financial correction")
                old_by_id = {str(f.get("factoryId")): f for f in old_entries}
                new_ids = {str(f.get("factoryId")) for f in patch["factories"]}
                if any(str(f.get("factoryId")) not in new_ids and self._protected(f) for f in old_entries):
                    raise APIError(403, "FIELD_DENIED", "Cannot remove an entry containing financial amounts")
                for entry in patch["factories"]:
                    prior = old_by_id.get(str(entry.get("factoryId")), {})
                    for key in {k for k in set(entry) | set(prior) if sensitive(k, True)}:
                        if key in entry and entry[key] != prior.get(key):
                            raise APIError(403, "FIELD_DENIED", "Factory financial fields require permission")
                        if key in prior:
                            entry[key] = prior[key]
                    guarded = self._guard_embedded(prior, entry, array_item=True)
                    entry.clear()
                    entry.update(guarded)
        if not can_finance:
            for key in list(patch):
                if key != "factories" and (isinstance(patch[key], (dict, list)) or self._protected((old or {}).get(key))):
                    patch[key] = self._guard_embedded((old or {}).get(key), patch[key])
        value = {**(old or {}), **patch}
        company_id = value.get("companyId")
        if company_id not in self.company_ids(cfg, actor):
            raise APIError(403, "COMPANY_DENIED", "Legal entity is missing, unknown or unauthorized")
        if old is None:
            value["createdBy"] = actor["id"]
            value["createdAt"] = now()
            value.setdefault("salespersonId", actor["id"])
        value["tenantId"] = actor["tenantId"]
        value["updatedBy"] = actor["id"]
        value["updatedAt"] = now()
        if collection == "orders":
            self._validate_order(value)
            raw_changed = self._financial_changed(old, value)
            # A public nested-array edit that preserves all costs does not
            # rewrite historical derived amounts under a different formula.
            if raw_changed:
                self._derive_order(cfg, value)
        return value

    @staticmethod
    def _protected(value):
        if isinstance(value, dict):
            return any(sensitive(k, True) or Store._protected(v) for k, v in value.items())
        if isinstance(value, list):
            return any(Store._protected(v) for v in value)
        return False

    def _guard_embedded(self, prior, supplied, array_item=False):
        """Prevent hiding protected changes inside otherwise public objects."""
        if isinstance(prior, (dict, list)) and self._protected(prior) and type(prior) is not type(supplied):
            raise APIError(403, "FIELD_DENIED", "Cannot replace a container holding protected data")
        if isinstance(supplied, dict):
            old = prior if isinstance(prior, dict) else {}
            result = {k: copy.deepcopy(v) for k, v in old.items() if not array_item or sensitive(k, True) or self._protected(v)}
            for key, value in supplied.items():
                if sensitive(key, True) and value != old.get(key):
                    raise APIError(403, "FIELD_DENIED", "Embedded financial fields require permission")
                result[key] = self._guard_embedded(old.get(key), value)
            return result
        if isinstance(supplied, list):
            old = prior if isinstance(prior, list) else []
            # Unknown protected array schemas cannot safely be matched by
            # index. factories has an explicit unique factoryId path above.
            if self._protected(old) and old != supplied:
                raise APIError(403, "FIELD_DENIED", "Protected arrays require a schema-aware financial editor")
            return [self._guard_embedded(old[index] if index < len(old) else None, value, array_item=True) for index, value in enumerate(supplied)]
        return supplied

    @staticmethod
    def _financial_changed(old, value):
        if old is None:
            return True
        if any(value.get(key) != old.get(key) for key in FINANCIAL_INPUT - {"factories"}):
            return True
        def amounts(record):
            return {str(entry.get("factoryId")): {k: entry.get(k) for k in NESTED_COST} for entry in record.get("factories", [])}
        return amounts(old) != amounts(value)

    @staticmethod
    def _validate_order(order):
        number = order.get("companyOperationNo")
        if not isinstance(number, str) or not number.strip():
            raise APIError(400, "ORDER_NUMBER_REQUIRED", "Company operation number is required")
        order["companyOperationNo"] = number.strip()
        for key in ("orderAmountUSD", "factoryCostRMB", "freightCostUSD", "insuranceCostUSD", "otherCostUSD", "paidAmountUSD", "costPaidUSD"):
            if key in order:
                value = order[key]
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise APIError(400, "INVALID_AMOUNT", "Amounts must be finite, nonnegative numbers")

    def _validate_links(self, db, cfg, actor, payload, collection, value, patch, creating):
        if collection != "orders":
            return
        references = []
        changing_entity = creating or "companyId" in patch
        if changing_entity or "customerId" in patch:
            if not value.get("customerId"):
                raise APIError(400, "CUSTOMER_REQUIRED", "An order requires a customer")
            references.append(("customers", value["customerId"]))
        if changing_entity or any(key in patch for key in ("factoryId", "factoryIds", "factories")):
            factory_ids = set(map(str, value.get("factoryIds", [])))
            if value.get("factoryId"):
                factory_ids.add(str(value["factoryId"]))
            factory_ids.update(str(f["factoryId"]) for f in value.get("factories", []) if f.get("factoryId"))
            references.extend(("factories", rid) for rid in factory_ids)
        for target, rid in references:
            related = next((r for r in payload[target] if str(r["id"]) == str(rid) and not r.get("deleted")), None)
            if not related or related.get("companyId") != value.get("companyId") or related.get("companyId") not in self.company_ids(cfg, actor) or not self.record_allowed(db, cfg, actor, related, collection=target):
                raise APIError(403, "RELATED_RECORD_DENIED", "Referenced record is missing or unauthorized")

    @staticmethod
    def _derive_order(cfg, order, rates=None):
        company = next(c for c in cfg["companies"] if c["id"] == order["companyId"])
        policy = company.get("profitPolicy")
        if policy != "grandware-v40":
            raise APIError(400, "UNKNOWN_PROFIT_POLICY", "Configure a supported company profit policy before editing financial inputs")
        amount = order.get("orderAmountUSD", 0)
        cost = order.get("factoryCostRMB", 0)
        rate = (rates or {}).get(company["id"], company.get("exchangeRate", 7.25))
        currency = company.get("settlementCurrency", "CNY")
        if currency == "CNY":
            revenue = amount * rate
            profit = revenue - cost - order.get("freightCostUSD", 0) - order.get("otherCostUSD", 0) + cost / 1.13 * order.get("insuranceCostUSD", 0) / 100
        elif currency == "USD":
            revenue = amount
            profit = amount - cost - order.get("otherCostUSD", 0)
        else:
            raise APIError(400, "UNSUPPORTED_CURRENCY", "Settlement currency policy is unsupported")
        order["orderAmountRMB"] = round(revenue, 2)
        order["profitRMB"] = round(profit, 2)
        order["profitRate"] = round(profit / revenue * 100, 2) if revenue else 0
        order["profitPolicy"] = policy
        order["settlementCurrency"] = currency

    def changes(self, actor, expected, changes, exchange_rates=None, rate_metas=None):
        if not isinstance(changes, list) or len(changes) > 5000:
            raise APIError(400, "INVALID_CHANGES", "changes must be an array with at most 5000 operations")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                actor = self._current_actor(db, actor)
                row, cfg = self._tenant(db, actor)
                self._expected(row, expected)
                payload, rates, metas = (json.loads(row[key]) for key in ("payload", "rates", "rate_metas"))
                if exchange_rates is not None or rate_metas is not None:
                    if not self.permitted(cfg, actor, "rates.write"):
                        raise APIError(403, "RATE_DENIED", "Rate configuration requires permission")
                    ids = self.company_ids(cfg, actor)
                    for supplied in (exchange_rates, rate_metas):
                        if supplied is not None and (not isinstance(supplied, dict) or not set(supplied).issubset(ids)):
                            raise APIError(403, "COMPANY_DENIED", "Rate configuration contains unauthorized entities")
                    for key, value in (exchange_rates or {}).items():
                        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
                            raise APIError(400, "INVALID_RATE", "Exchange rates must be positive finite numbers")
                        rates[key] = value
                    for key, value in (rate_metas or {}).items():
                        if not isinstance(value, dict):
                            raise APIError(400, "INVALID_RATE_META", "Rate metadata must be an object")
                        metas[key] = {k: v for k, v in value.items() if k in ("source", "updateTime", "isAuto", "note")}
                for change in changes:
                    if not isinstance(change, dict) or change.get("collection") not in COLLECTIONS:
                        raise APIError(400, "INVALID_COLLECTION", "Unknown change collection")
                    collection = change["collection"]
                    rid = str(change["id"]) if "id" in change else str(uuid.uuid4())
                    if not safe_record_id(rid):
                        raise APIError(400, "INVALID_RECORD_ID", "Invalid record identifier")
                    records = payload.setdefault(collection, [])
                    old = next((r for r in records if str(r["id"]) == rid), None)
                    deleting = change.get("deleted") is True
                    action = "delete" if deleting else ("edit" if old else "create")
                    if old:
                        if not self.record_allowed(db, cfg, actor, old, action, collection):
                            raise APIError(403, "RECORD_DENIED", "Record operation is unauthorized")
                        if old.get("deleted"):
                            raise APIError(409, "RECORD_DELETED", "Restore a snapshot to recover a deleted record")
                    elif deleting:
                        raise APIError(404, "RECORD_NOT_FOUND", "Cannot delete a missing record")
                    elif not self.permitted(cfg, actor, "create", collection):
                        raise APIError(403, "CREATE_DENIED", "Cannot create this record")
                    if deleting:
                        value = {**old, "deleted": True, "deletedAt": now(), "updatedAt": now(), "updatedBy": actor["id"]}
                        if collection == "orders":
                            for related in ("shipments", "invoices"):
                                for entry in payload[related]:
                                    if str(entry.get("orderId")) == rid:
                                        entry.update(deleted=True, deletedAt=value["deletedAt"], updatedBy=actor["id"])
                    else:
                        value = self._prepare_patch(db, cfg, actor, collection, old, change.get("value"))
                        value["id"] = rid
                        if collection == "orders" and old and value.get("companyId") != old.get("companyId"):
                            if any(str(entry.get("orderId")) == rid for related in ("shipments", "invoices") for entry in payload[related]):
                                raise APIError(409, "LEGAL_ENTITY_MIGRATION_REQUIRED", "Orders with shipping/invoice history require an explicit legal entity migration")
                        if not self.record_allowed(db, cfg, actor, value, "read", collection):
                            raise APIError(403, "ASSIGNMENT_DENIED", "Cannot save a record outside the account scope")
                        self._validate_links(db, cfg, actor, payload, collection, value, change.get("value", {}), old is None)
                        if collection == "orders" and self._financial_changed(old, value):
                            self._derive_order(cfg, value, rates)
                        if collection in ("shipments", "invoices"):
                            parent = next((r for r in payload["orders"] if str(r["id"]) == str(value.get("orderId")) and not r.get("deleted")), None)
                            if not parent or parent.get("companyId") != value.get("companyId") or not self.record_allowed(db, cfg, actor, parent, collection="orders"):
                                raise APIError(403, "RELATED_RECORD_DENIED", "Related order is inaccessible or belongs to another legal entity")
                    if old:
                        records[records.index(old)] = value
                    else:
                        records.append(value)
                self._unique_order_numbers(payload)
                return self._commit(db, actor, row, payload, rates, metas, "changes", [{"collection": c["collection"], "id": str(c.get("id", "new")), "deleted": c.get("deleted") is True} for c in changes])
            except Exception:
                db.rollback()
                raise

    @staticmethod
    def _unique_order_numbers(payload):
        seen = set()
        for order in payload.get("orders", []):
            number = order.get("companyOperationNo")
            if not isinstance(number, str) or not number.strip():
                continue  # Quarantined legacy imports remain inspectable by admin.
            key = (order.get("companyId"), number.strip().casefold())
            if key in seen:
                raise APIError(409, "DUPLICATE_ORDER_NUMBER", "Company operation number already exists, including archived orders")
            seen.add(key)

    def _snapshot(self, db, tenant_id, payload, rates, metas, revision, actor_id, kind):
        sid = str(uuid.uuid4())
        db.execute("INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)", (sid, tenant_id, revision, dumps(payload), dumps(rates), dumps(metas), now(), actor_id, kind))
        return sid

    def _commit(self, db, actor, row, payload, rates, metas, kind, summary):
        revision = row["revision"] + 1
        timestamp = now()
        db.execute("UPDATE tenants SET payload=?,rates=?,rate_metas=?,revision=?,updated_at=?,updated_by=? WHERE id=? AND revision=?", (dumps(payload), dumps(rates), dumps(metas), revision, timestamp, actor["id"], actor["tenantId"], row["revision"]))
        sid = self._snapshot(db, actor["tenantId"], payload, rates, metas, revision, actor["id"], kind)
        db.execute("INSERT INTO audit(tenant_id,revision,actor_id,created_at,kind,summary) VALUES(?,?,?,?,?,?)", (actor["tenantId"], revision, actor["id"], timestamp, kind, dumps(summary)))
        db.commit()
        return {"ok": True, "meta": {"version": revision, "updatedAt": timestamp, "updatedBy": actor["id"]}, "snapshotId": sid}

    def snapshots(self, actor):
        with self.connect() as db:
            _, cfg = self._tenant(db, actor)
            if not self.permitted(cfg, actor, "snapshots.read"):
                raise APIError(403, "SNAPSHOT_DENIED", "Snapshot access requires permission")
            rows = db.execute("SELECT id,revision,created_at,actor_id,kind FROM snapshots WHERE tenant_id=? ORDER BY revision DESC LIMIT 200", (actor["tenantId"],))
            return {"snapshots": [{"id": r["id"], "version": r["revision"], "createdAt": r["created_at"], "createdBy": r["actor_id"], "kind": r["kind"]} for r in rows]}

    def restore(self, actor, snapshot_id, expected):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                actor = self._current_actor(db, actor)
                row, cfg = self._tenant(db, actor)
                self._expected(row, expected)
                if not self.permitted(cfg, actor, "snapshots.restore") or self._policy(cfg, actor).get("scope") != "tenant":
                    raise APIError(403, "RESTORE_DENIED", "Tenant administrator restore permission required")
                snapshot = db.execute("SELECT * FROM snapshots WHERE id=? AND tenant_id=?", (snapshot_id, actor["tenantId"])).fetchone()
                if not snapshot:
                    raise APIError(404, "SNAPSHOT_NOT_FOUND", "Snapshot unavailable")
                payload, rates, metas = (json.loads(snapshot[k]) for k in ("payload", "rates", "rate_metas"))
                known = {c["id"] for c in cfg["companies"]}
                if self.company_ids(cfg, actor) != known:
                    raise APIError(403, "RESTORE_DENIED", "Whole-tenant restore requires grants for every legal entity")
                for records in payload.values():
                    for record in records:
                        if record.get("tenantId") != actor["tenantId"] or (record.get("companyId") is not None and record["companyId"] not in known):
                            raise APIError(409, "RESTORE_CONFIG_CONFLICT", "Snapshot conflicts with current tenant/legal entity configuration")
                self._unique_order_numbers(payload)
                return self._commit(db, actor, row, payload, rates, metas, "restore", {"sourceSnapshotId": snapshot_id, "sourceVersion": snapshot["revision"]})
            except Exception:
                db.rollback()
                raise

    def import_data(self, tenant_id, source, expected=0):
        """CLI-only, read-only source import; never recalculates historical money."""
        content = json.loads(Path(source).read_text(encoding="utf-8"))
        supplied = content.get("data", content.get("payload", content))
        if not isinstance(supplied, dict):
            raise ValueError("Import must contain a business data object")
        payload = {c: copy.deepcopy(supplied.get(c, [])) for c in COLLECTIONS}
        for collection, records in payload.items():
            if not isinstance(records, list):
                raise ValueError("Business collections must be arrays")
            seen = set()
            for record in records:
                if not isinstance(record, dict) or not record.get("id"):
                    raise ValueError("Imported records require stable IDs")
                record["id"] = str(record["id"])
                try:
                    validate_embedded_ids(record)
                except APIError as error:
                    raise ValueError("Imported technical identifiers contain unsafe characters") from error
                if record["id"] in seen:
                    raise ValueError("Duplicate imported record ID")
                seen.add(record["id"])
                if record.get("tenantId") not in (None, tenant_id):
                    raise ValueError("Cannot import another tenant's records")
                record["tenantId"] = tenant_id
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT * FROM tenants WHERE id=?", (tenant_id,)).fetchone()
                if not row:
                    raise ValueError("Configure tenant before import")
                self._expected(row, expected)
                self._unique_order_numbers(payload)
                rates = content.get("exchangeRates", json.loads(row["rates"]))
                metas = content.get("rateMetas", {})
                return self._commit(db, {"tenantId": tenant_id, "id": "cli-import"}, row, payload, rates, metas, "import", {"counts": {k: len(v) for k, v in payload.items()}})
            except Exception:
                db.rollback()
                raise
