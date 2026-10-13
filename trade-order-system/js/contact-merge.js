/**
 * Pure contact reconciliation. Arrays are matched only by stable IDs, never names.
 * proposal is a preview; result is null until every conflict has an explicit choice.
 * Existing server order is retained, then local additions are appended.
 */

const ABSENT = Symbol('absent');
const sides = ['base', 'local', 'server'];
const own = (object, key) => Object.hasOwn(object, key);
const plain = value =>
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const put = (object, key, value) =>
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

function copy(value, ancestors = new Set()) {
    if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if ((!Array.isArray(value) && !plain(value)) || ancestors.has(value)) {
        throw new TypeError('联系人包含无法安全合并的数据，请人工核对');
    }
    const next = new Set(ancestors).add(value);
    if (Array.isArray(value)) return value.map(item => copy(item, next));
    const result = {};
    for (const key of Object.keys(value)) put(result, key, copy(value[key], next));
    return result;
}

function equal(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => equal(value, right[index]));
    }
    if (!plain(left) || !plain(right)) return false;
    const keys = Object.keys(left);
    return (
        keys.length === Object.keys(right).length && keys.every(key => own(right, key) && equal(left[key], right[key]))
    );
}

function identifier(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    if (!['string', 'number'].includes(typeof value)) return null;
    const id = String(value);
    // Same accepted characters as the server contact-ID validator; never trim an ID.
    return /^[\p{L}\p{N}_.:-]{1,200}$/u.test(id) ? id : null;
}

const state = value => (value === ABSENT ? { present: false } : { present: true, value: copy(value) });
const field = (object, key) => (object !== ABSENT && own(object, key) ? object[key] : ABSENT);
const alive = row => row !== undefined && row.deleted !== true;
const sameContact = (left, right) => equal({ ...left, id: String(left.id) }, { ...right, id: String(right.id) });

function inspect(sources) {
    const issues = [];
    const maps = {};
    for (const side of sides) {
        const rows = sources[side];
        const map = new Map();
        maps[side] = map;
        if (!Array.isArray(rows)) {
            issues.push({ code: 'INVALID_CONTACT_LIST', side, message: '联系人列表格式无效，请人工核对' });
            continue;
        }
        Array.from(rows).forEach((row, index) => {
            if (!plain(row)) {
                issues.push({ code: 'INVALID_CONTACT', side, index, message: '联系人格式无效，请人工核对' });
                return;
            }
            const id = own(row, 'id') ? identifier(row.id) : null;
            if (id === null) {
                issues.push({ code: 'INVALID_CONTACT_ID', side, index, message: '联系人缺少有效稳定编号，请人工核对' });
            } else if (map.has(id)) {
                issues.push({
                    code: 'DUPLICATE_CONTACT_ID',
                    side,
                    index,
                    contactId: id,
                    message: '联系人编号重复，请人工核对'
                });
            } else {
                map.set(id, row);
            }
        });
    }
    return { maps, issues };
}

function calculate(sources, choices = {}) {
    const { maps, issues } = inspect(sources);
    const proposal = [];
    const conflicts = [];
    const resolvedConflicts = [];
    const knownChoices = new Set();

    const conflict = (contactId, kind, path, base, local, server, fallback = base) => {
        const id = `contact:${encodeURIComponent(contactId)}:${kind}:${encodeURIComponent(JSON.stringify(path))}`;
        knownChoices.add(id);
        const item = {
            id,
            contactId,
            kind,
            path: [...path],
            field: path.join('.'),
            base: state(base),
            local: state(local),
            server: state(server),
            options: ['local', 'server'],
            message:
                kind === 'delete-vs-edit'
                    ? '另一处已删除此联系人，请明确选择删除或确认保留编辑后的联系人'
                    : kind === 'concurrent-add'
                      ? '两处新建了相同编号但不同内容的联系人，请明确选择保留哪一处'
                      : '同一联系人字段在两处被不同修改，请明确选择保留哪一处'
        };
        if (own(choices, id) && ['local', 'server'].includes(choices[id])) {
            resolvedConflicts.push({ ...item, resolution: choices[id] });
            return choices[id] === 'local' ? local : server;
        }
        if (own(choices, id)) {
            issues.push({ code: 'INVALID_RESOLUTION', conflictId: id, message: '冲突只能明确选择本地或服务器版本' });
        }
        conflicts.push(item);
        return fallback;
    };

    const mergeField = (contactId, path, base, local, server) => {
        if (equal(local, server)) return local;
        if (equal(local, base)) return server;
        if (equal(server, base)) return local;
        if (plain(local) && plain(server) && (plain(base) || base === ABSENT)) {
            const result = {};
            const keys = new Set([
                ...Object.keys(base === ABSENT ? {} : base),
                ...Object.keys(server),
                ...Object.keys(local)
            ]);
            for (const key of keys) {
                const value = mergeField(
                    contactId,
                    [...path, key],
                    field(base, key),
                    field(local, key),
                    field(server, key)
                );
                if (value !== ABSENT) put(result, key, copy(value));
            }
            return result;
        }
        return conflict(contactId, 'field-conflict', path, base, local, server);
    };

    if (issues.length === 0) {
        const ids = new Set([...maps.server.keys(), ...maps.local.keys(), ...maps.base.keys()]);
        for (const id of ids) {
            const baseline = maps.base.get(id);
            const localRow = maps.local.get(id);
            const serverRow = maps.server.get(id);
            const base = alive(baseline) ? baseline : ABSENT;
            const local = alive(localRow) ? localRow : ABSENT;
            const server = alive(serverRow) ? serverRow : ABSENT;
            if (baseline?.deleted === true && (local !== ABSENT || server !== ABSENT)) {
                issues.push({
                    code: 'DELETED_CONTACT_REAPPEARED',
                    contactId: id,
                    message: '基线中已删除的联系人再次出现，请人工核对，不能自动恢复'
                });
                continue;
            }
            let merged = ABSENT;
            if (base === ABSENT) {
                if (local !== ABSENT && server !== ABSENT) {
                    merged = sameContact(local, server)
                        ? server
                        : conflict(id, 'concurrent-add', [], ABSENT, local, server);
                } else if (
                    (localRow?.deleted === true && server !== ABSENT) ||
                    (serverRow?.deleted === true && local !== ABSENT)
                ) {
                    merged = conflict(id, 'delete-vs-edit', [], base, local, server, ABSENT);
                } else {
                    merged = local !== ABSENT ? local : server;
                }
            } else if (local === ABSENT || server === ABSENT) {
                const remaining = local !== ABSENT ? local : server;
                if (remaining !== ABSENT && !sameContact(remaining, base)) {
                    // Unresolved deletion conflicts must not revive the base row in proposal.
                    merged = conflict(id, 'delete-vs-edit', [], base, local, server, ABSENT);
                }
            } else {
                merged = { id: server.id };
                const keys = new Set([...Object.keys(base), ...Object.keys(server), ...Object.keys(local)]);
                keys.delete('id');
                for (const key of keys) {
                    const value = mergeField(id, [key], field(base, key), field(local, key), field(server, key));
                    if (value !== ABSENT) put(merged, key, copy(value));
                }
            }
            if (merged !== ABSENT) proposal.push(copy(merged));
        }
    }
    for (const id of Object.keys(choices)) {
        if (!knownChoices.has(id)) {
            issues.push({ code: 'UNKNOWN_CONFLICT', conflictId: id, message: '选择不属于本次联系人冲突，请重新核对' });
        }
    }
    const canSubmit = issues.length === 0 && conflicts.length === 0;
    return {
        proposal,
        conflicts,
        resolvedConflicts,
        issues,
        canSubmit,
        result: canSubmit ? copy(proposal) : null,
        choices: copy(choices),
        sources: copy(sources)
    };
}

/** No input array or contact is mutated. Missing/duplicate IDs always require manual review. */
export function proposeContactMerge(base, local, server) {
    try {
        return calculate(copy({ base, local, server }));
    } catch (_) {
        return {
            proposal: [],
            conflicts: [],
            resolvedConflicts: [],
            issues: [{ code: 'INVALID_CONTACT_DATA', message: '联系人包含无法安全合并的数据，请人工核对' }],
            canSubmit: false,
            result: null,
            choices: {},
            sources: null
        };
    }
}

/** Choices are keyed by stable conflict.id; values must be exactly 'local' or 'server'. */
export function resolveContactMerge(plan, choices = {}) {
    if (!plain(plan?.sources) || !plain(choices) || !plain(plan.choices)) {
        return {
            proposal: [],
            conflicts: [],
            resolvedConflicts: [],
            issues: [{ code: 'INVALID_MERGE_PLAN', message: '合并方案无效，请保留草稿并重新核对' }],
            canSubmit: false,
            result: null,
            choices: {},
            sources: null
        };
    }
    try {
        return calculate(copy(plan.sources), { ...copy(plan.choices), ...copy(choices) });
    } catch (_) {
        return {
            proposal: [],
            conflicts: [],
            resolvedConflicts: [],
            issues: [{ code: 'INVALID_MERGE_PLAN', message: '合并方案无效，请保留草稿并重新核对' }],
            canSubmit: false,
            result: null,
            choices: {},
            sources: null
        };
    }
}

export const ContactMerge = { propose: proposeContactMerge, resolve: resolveContactMerge };
