#!/usr/bin/env python3
"""Archive an application JSON export and prepare an isolated local test seed."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

PREVIEW_ROOT = Path(__file__).resolve().parent
CATEGORIES = ("customers", "orders", "factories", "shipments", "invoices")


def write_json(path, value):
    content = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    path.write_bytes(content)
    path.chmod(0o600)
    return hashlib.sha256(content).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_file", type=Path)
    args = parser.parse_args()
    raw = args.export_file.read_bytes()
    exported = json.loads(raw)
    data = exported.get("data", exported)
    counts = {}
    for category in CATEGORIES:
        rows = data.get(category)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError(f"{category} must be an array of records")
        ids = [row.get("id") for row in rows]
        if any(not isinstance(record_id, str) or not record_id for record_id in ids):
            raise ValueError(f"{category} contains a missing or invalid ID")
        if len(ids) != len(set(ids)):
            raise ValueError(f"{category} contains duplicate IDs")
        deleted = sum(bool(row.get("deleted") or row.get("deletedAt")) for row in rows)
        counts[category] = {
            "total": len(rows), "active": len(rows) - deleted, "softDeleted": deleted,
            "byCompany": dict(Counter(row.get("companyId", "missing") for row in rows)),
        }

    rates = exported.get("exchangeRates")
    if not isinstance(rates, dict) or not rates:
        raise ValueError("exchangeRates is missing")
    if any(not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0 for rate in rates.values()):
        raise ValueError("exchangeRates contains an invalid rate")
    customers = {row["id"] for row in data["customers"]}
    missing_customer_refs = sum(
        bool(order.get("customerId") and order["customerId"] not in customers) for order in data["orders"]
    )
    sha256 = hashlib.sha256(raw).hexdigest()
    downloaded_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    exported_at = exported.get("exportDate") or downloaded_at
    stamp = datetime.fromisoformat(exported_at.replace("Z", "+00:00")).strftime("%Y%m%dT%H%M%SZ")
    snapshot_id = f"{stamp}-{sha256[:12]}"
    source = {
        "kind": "cloudbase-app-export",
        "envId": "grandware-d9gb4owez89cb9df9",
        "collection": "app_data",
        "dataType": "gw_data",
        "url": "https://grandware-d9gb4owez89cb9df9-1460064035.tcloudbaseapp.com/",
        "exportedAt": exported_at,
        "downloadedAt": downloaded_at,
        "sha256": sha256,
        "snapshotId": snapshot_id,
        "method": "Application settings: export all data (JSON)",
        "scope": "Business data merged by the online app from its latest active documents; not a raw collection/history dump.",
        "observedMergedDocuments": 20,
        "originalRateMetasIncluded": bool(exported.get("rateMetas")),
    }
    seed = {
        "data": {category: data[category] for category in CATEGORIES},
        "exchangeRates": rates,
        "rateMetas": exported.get("rateMetas") or {
            company_id: {
                "source": "线上导出快照", "updateTime": exported_at, "isAuto": False,
                "note": "导出文件未包含原始汇率元数据；本地保留快照汇率，自动刷新已停用。",
            } for company_id in rates
        },
        "meta": {"version": 0, "updatedAt": exported_at, "updatedBy": "线上业务快照"},
        "source": source,
    }
    data_root = PREVIEW_ROOT / "data"
    archive = data_root / "snapshots" / snapshot_id
    current = data_root / "current"
    for folder in (data_root, archive.parent, archive, current):
        folder.mkdir(parents=True, exist_ok=True)
        folder.chmod(0o700)
    raw_path = archive / "business-export.json"
    if raw_path.exists() and hashlib.sha256(raw_path.read_bytes()).hexdigest() != sha256:
        raise ValueError("Existing snapshot has a different checksum")
    raw_path.write_bytes(raw)
    raw_path.chmod(0o600)
    seed_sha256 = write_json(archive / "seed.json", seed)
    manifest = {
        "source": source, "counts": counts,
        "validation": {"missingOrDuplicateIds": 0, "missingOrderCustomerReferences": missing_customer_refs},
        "checksums": {"business-export.json": sha256, "seed.json": seed_sha256},
        "notes": [
            "Soft-deletion flags, IDs, ownership, nested factories and contacts are preserved.",
            "Local meta.version starts at zero; the application export does not include the CloudBase document version.",
            "The current application migrates legacy fields and recalculates profit in browser storage on entry; the archived export remains unchanged.",
        ],
    }
    write_json(archive / "manifest.json", manifest)
    write_json(current / "seed.json", seed)
    write_json(current / "manifest.json", manifest)
    print(json.dumps({"snapshot": str(archive), "currentSeed": str(current / "seed.json"), "counts": counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
