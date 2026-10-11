/**
 * Same-origin business API transport.
 * Writes contain only changes from the immutable, acknowledged read baseline.
 * The server owns authorization, atomic version checking and persistence.
 */

// Parents must exist before dependent records in a single atomic import batch.
const COLLECTIONS = ['customers', 'factories', 'orders', 'shipments', 'invoices'];
const FINANCIAL_FIELDS = new Set([
    'factoryCostRMB',
    'factoryCostUSD',
    'freightCostUSD',
    'freightCostRMB',
    'insuranceCostUSD',
    'otherCostUSD',
    'otherCostRMB',
    'orderAmountRMB',
    'profitRMB',
    'profitUSD',
    'profitRate',
    'margin',
    'paidAmountUSD',
    'paymentStatus',
    'factoryPaidStatus',
    'factoryPaidRMB',
    'costPaidUSD',
    'costPaymentStatus',
    'bankInfo',
    'bankAccount'
]);
const NESTED_FINANCIAL_FIELDS = new Set(['totalAmount', 'prepayment', 'paidAmount', 'cost', 'costUSD', 'costRMB']);
const SERVER_FIELDS = new Set([
    'createdAt',
    'createdBy',
    'updatedAt',
    'updatedBy',
    'version',
    'deletedAt',
    'orderAmountRMB',
    'profitRMB',
    'profitUSD',
    'profitRate',
    'margin'
]);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function equal(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return equalKeys(aKeys, bKeys) && aKeys.every(key => equal(a[key], b[key]));
}

function equalKeys(a, b) {
    return a.length === b.length && a.every((key, index) => key === b[index]);
}

function apiError(message, code, status) {
    const error = new Error(message);
    error.code = code;
    if (status !== undefined) error.status = status;
    return error;
}

function recordsById(records = []) {
    const result = new Map();
    for (const record of records) {
        if (!record || record.id === undefined || record.id === null || String(record.id).trim() === '') {
            throw apiError('记录缺少 id', 'INVALID_RECORD');
        }
        const id = String(record.id);
        if (result.has(id)) throw apiError('存在重复记录 id：' + id, 'DUPLICATE_ID');
        result.set(id, record);
    }
    return result;
}

/** Omitted fields do not mean deletion: a permission-filtered response may omit them. */
function changedFields(current, baseline) {
    const patch = {};
    for (const [key, value] of Object.entries(current || {})) {
        if (key !== 'id' && value !== undefined && !equal(value, baseline?.[key])) {
            patch[key] = clone(value);
        }
    }
    return patch;
}

export class BusinessAPIClient {
    constructor({ baseUrl = '/api', fetcher = null, canReplaceData = () => true } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this._fetcher = fetcher;
        this._canReplaceData = canReplaceData;
        this._serial = Promise.resolve();
        this._baseline = null;
        this._working = null;
        this._lastMeta = { version: 0, updatedAt: null, updatedBy: null };
        this._ready = false;
        this._conflict = null;
        this._permissions = null;
    }

    get lastMeta() {
        return this.getLastMeta();
    }

    getLastMeta() {
        return clone(this._lastMeta);
    }

    isReady() {
        return this._ready;
    }

    _enqueue(operation) {
        const result = this._serial.then(operation);
        // A failed request must not prevent explicit subsequent user actions.
        this._serial = result.catch(() => {});
        return result;
    }

    async _request(path, { method = 'GET', body } = {}) {
        let response;
        try {
            const fetcher = this._fetcher || globalThis.fetch;
            if (!fetcher) throw new Error('Fetch unavailable');
            response = await fetcher(this.baseUrl + path, {
                method,
                credentials: 'same-origin',
                cache: 'no-store',
                headers:
                    body === undefined
                        ? { Accept: 'application/json' }
                        : {
                              Accept: 'application/json',
                              'Content-Type': 'application/json'
                          },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
        } catch (cause) {
            const error = apiError('无法连接业务服务，请保留当前修改并重试', 'NETWORK');
            error.cause = cause;
            throw error;
        }
        let payload;
        try {
            payload = await response.json();
        } catch (cause) {
            const error = apiError('业务服务返回格式无效', 'INVALID_RESPONSE', response.status);
            error.cause = cause;
            throw error;
        }
        if (!response.ok) {
            const code =
                response.status === 409
                    ? 'CONFLICT'
                    : payload.code || (response.status === 401 ? 'AUTH_REQUIRED' : 'API_ERROR');
            const error = apiError(payload.error || payload.message || '业务请求失败', code, response.status);
            error.serverCode = payload.code;
            if (payload.latestVersion !== undefined) error.latestVersion = payload.latestVersion;
            throw error;
        }
        return payload;
    }

    async session() {
        return this._enqueue(async () => {
            const result = await this._request('/session');
            this.setSessionContext(result);
            this._ready = true;
            return clone(result);
        });
    }

    async login({ tenantId, username, password }) {
        return this._enqueue(async () => {
            const result = await this._request('/login', { method: 'POST', body: { tenantId, username, password } });
            this.resetBaseline();
            this.setSessionContext(result);
            this._ready = true;
            return clone(result);
        });
    }

    async logout() {
        return this._enqueue(async () => {
            const result = await this._request('/logout', { method: 'POST', body: {} });
            this.resetBaseline();
            this._ready = false;
            this._permissions = null;
            return clone(result);
        });
    }

    /** Call only after an explicit decision to discard a draft or change session. */
    resetBaseline() {
        this._baseline = null;
        this._working = null;
        this._lastMeta = { version: 0, updatedAt: null, updatedBy: null };
        this._conflict = null;
    }

    bindWorkingData(data, exchangeRates, rateMetas) {
        this._working = { data, exchangeRates, rateMetas };
    }

    setSessionContext(session) {
        const user = session?.user;
        const role = Array.isArray(session?.roles)
            ? session.roles.find(entry => entry.id === user?.role)
            : session?.roles?.[user?.role];
        const permissions = user?.permissions ?? role?.permissions;
        this._permissions = permissions === undefined ? null : clone(permissions);
    }

    _canWriteFinance() {
        if (this._permissions === null) return null;
        return Array.isArray(this._permissions)
            ? this._permissions.includes('finance.write')
            : this._permissions['finance.write'] === true;
    }

    _publicRecord(record, baseline) {
        const result = {};
        const finance = this._canWriteFinance();
        for (const [key, value] of Object.entries(record)) {
            if (SERVER_FIELDS.has(key)) continue;
            if (
                FINANCIAL_FIELDS.has(key) &&
                (finance === false || (finance === null && !Object.hasOwn(baseline || {}, key)))
            ) {
                continue;
            }
            if (key === 'factories' && Array.isArray(value) && finance !== true) {
                result.factories = value.map(row => {
                    const old = (baseline?.factories || []).find(
                        item => String(item.factoryId) === String(row.factoryId)
                    );
                    return Object.fromEntries(
                        Object.entries(row).filter(
                            ([field]) =>
                                !NESTED_FINANCIAL_FIELDS.has(field) ||
                                (finance === null && Object.hasOwn(old || {}, field))
                        )
                    );
                });
            } else {
                result[key] = value;
            }
        }
        return result;
    }

    _diff(data, exchangeRates, rateMetas) {
        if (!this._baseline) return { changes: [] };
        const changes = [];
        for (const collection of COLLECTIONS) {
            // A missing entire collection is not an instruction to delete it.
            if (!Array.isArray(data?.[collection])) continue;
            const before = recordsById(this._baseline.data[collection]);
            const after = recordsById(data[collection]);
            for (const [id, record] of after) {
                const old = before.get(id);
                if (record.deleted === true) {
                    if (old && old.deleted !== true) changes.push({ collection, id: record.id, deleted: true });
                    continue;
                }
                const publicRecord = this._publicRecord(record, old);
                if (!old) {
                    changes.push({ collection, id: record.id, value: clone(publicRecord) });
                } else {
                    const value = changedFields(publicRecord, this._publicRecord(old, old));
                    if (Object.keys(value).length) changes.push({ collection, id: record.id, value });
                }
            }
            for (const [id, record] of before) {
                if (!after.has(id) && record.deleted !== true) {
                    changes.push({ collection, id: record.id, deleted: true });
                }
            }
        }
        const ratePatch = changedFields(exchangeRates, this._baseline.exchangeRates);
        const metaPatch = changedFields(rateMetas, this._baseline.rateMetas);
        return {
            changes,
            ...(Object.keys(ratePatch).length ? { exchangeRates: ratePatch } : {}),
            ...(Object.keys(metaPatch).length ? { rateMetas: metaPatch } : {})
        };
    }

    hasChanges(
        data = this._working?.data,
        exchangeRates = this._working?.exchangeRates,
        rateMetas = this._working?.rateMetas
    ) {
        if (!this._baseline || !data) return false;
        const patch = this._diff(data, exchangeRates, rateMetas);
        return patch.changes.length > 0 || Boolean(patch.exchangeRates || patch.rateMetas);
    }

    async loadData({ discardLocal = false } = {}) {
        return this._enqueue(async () => {
            if (!discardLocal && (this.hasChanges() || !this._canReplaceData())) {
                throw apiError('当前有未提交修改，请先保存或明确放弃草稿', 'LOCAL_CHANGES');
            }
            const result = await this._request('/data');
            if (!discardLocal && (this.hasChanges() || !this._canReplaceData())) {
                throw apiError('读取期间产生了新的修改，已保留草稿', 'LOCAL_CHANGES');
            }
            if (!result.data || !Number.isInteger(result.meta?.version) || result.meta.version < 0) {
                throw apiError('业务数据缺少有效版本', 'INVALID_RESPONSE');
            }
            const normalized = {
                data: Object.fromEntries(COLLECTIONS.map(key => [key, clone(result.data[key] || [])])),
                exchangeRates: clone(result.exchangeRates || {}),
                rateMetas: clone(result.rateMetas || {}),
                meta: clone(result.meta)
            };
            this._baseline = clone(normalized);
            this._lastMeta = clone(normalized.meta);
            this._ready = true;
            this._conflict = null;
            const working = clone(normalized);
            this.bindWorkingData(working.data, working.exchangeRates, working.rateMetas);
            return working;
        });
    }

    async checkRemoteVersion() {
        // Metadata reads never alter the acknowledged data baseline.
        return this._enqueue(async () => {
            const result = await this._request('/meta');
            return clone(result.meta || result);
        });
    }

    _acknowledge(patch, meta) {
        const next = clone(this._baseline);
        for (const change of patch.changes) {
            const records = next.data[change.collection];
            const index = records.findIndex(record => String(record.id) === String(change.id));
            if (change.deleted) {
                if (index >= 0) records[index] = { ...records[index], deleted: true };
            } else if (index >= 0) {
                records[index] = { ...records[index], ...clone(change.value) };
            } else {
                records.push(clone(change.value));
            }
        }
        if (patch.exchangeRates) Object.assign(next.exchangeRates, clone(patch.exchangeRates));
        if (patch.rateMetas) Object.assign(next.rateMetas, clone(patch.rateMetas));
        next.meta = clone(meta);
        this._baseline = next;
        this._lastMeta = clone(meta);
    }

    async saveData(data, exchangeRates, rateMetas) {
        // Preserve the reference, then sample it when its queued operation starts.
        // New edits made during an earlier network request remain observable.
        this.bindWorkingData(data, exchangeRates, rateMetas);
        return this._enqueue(async () => {
            if (this._conflict) throw this._conflict;
            if (!this._baseline) throw apiError('请先读取数据，不能从未知版本保存', 'NO_BASELINE');
            const patch = this._diff(data, exchangeRates, rateMetas);
            if (!patch.changes.length && !patch.exchangeRates && !patch.rateMetas) return true;
            const expectedVersion = this._baseline.meta.version;
            let result;
            try {
                result = await this._request('/changes', {
                    method: 'POST',
                    body: { expectedVersion, ...clone(patch) }
                });
            } catch (error) {
                if (error.code === 'CONFLICT') this._conflict = error;
                throw error;
            }
            if (!Number.isInteger(result.meta?.version) || result.meta.version <= expectedVersion) {
                throw apiError('保存确认缺少有效新版本，请保留草稿并核对服务状态', 'INVALID_RESPONSE');
            }
            // Only acknowledge the submitted snapshot, never a newer mutable draft.
            this._acknowledge(patch, result.meta);
            return true;
        });
    }

    async listSnapshots() {
        return this._enqueue(async () => {
            const result = await this._request('/snapshots');
            return clone(result.snapshots || result);
        });
    }

    async restore(snapshotId, options = {}) {
        return this._enqueue(async () => {
            if (!this._baseline) throw apiError('请先读取当前数据版本', 'NO_BASELINE');
            if (this.hasChanges()) throw apiError('请先保存或明确放弃草稿再恢复快照', 'LOCAL_CHANGES');
            const expectedVersion = this._baseline.meta.version;
            const suppliedVersion = typeof options === 'number' ? options : options.expectedVersion;
            if (suppliedVersion !== undefined && suppliedVersion !== expectedVersion) {
                throw apiError('恢复版本与当前读取基线不一致', 'CONFLICT', 409);
            }
            const result = await this._request('/restore', { method: 'POST', body: { snapshotId, expectedVersion } });
            if (!Number.isInteger(result.meta?.version) || result.meta.version <= expectedVersion) {
                throw apiError('快照恢复未返回有效新版本', 'INVALID_RESPONSE');
            }
            // A successful restore requires a new authorized read before editing.
            this.resetBaseline();
            this._lastMeta = clone(result.meta);
            return clone(result);
        });
    }

    async drainQueue() {
        await this._serial;
    }
}

export const APIClient = new BusinessAPIClient();
