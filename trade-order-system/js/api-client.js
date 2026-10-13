/**
 * Same-origin business API transport.
 * Writes contain only changes from the immutable, acknowledged read baseline.
 * The server owns authorization, atomic version checking and persistence.
 */
import { proposeContactMerge, resolveContactMerge } from './contact-merge.js';

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
    'bankAccount',
    'erpItems'
]);
const NESTED_FINANCIAL_FIELDS = new Set(['totalAmount', 'prepayment', 'paidAmount', 'cost', 'costUSD', 'costRMB']);
const PROJECTED_FACTORY_FIELDS = new Set([
    'advanceAmount',
    'invoiceSettledAmount',
    'invoiceOutstandingAmount',
    'invoiceNames'
]);
const NORMALIZED_ORDER_INPUTS = [
    'companyOperationNo',
    'factoryCostUSD',
    'factoryCostRMB',
    'freightCostUSD',
    'freightCostRMB',
    'otherCostUSD',
    'otherCostRMB'
];
const ORDER_RATE_FIELDS = new Set([
    'companyId',
    'orderAmountUSD',
    'factoryCostRMB',
    'factoryCostUSD',
    'freightCostUSD',
    'freightCostRMB',
    'insuranceCostUSD',
    'otherCostUSD',
    'otherCostRMB'
]);
const NESTED_ORDER_RATE_FIELDS = new Set([
    'totalAmount',
    'prepayment',
    'paidAmount',
    'cost',
    'costUSD',
    'costRMB',
    'paidCostRMB',
    'paidCostUSD',
    'costPaidUSD',
    'purchaseRate',
    'paymentStatus',
    'costPaymentStatus'
]);
const AUTHORITATIVE_ORDER_FIELDS = new Set([
    'orderAmountRMB',
    'profitRMB',
    'profitUSD',
    'profitRate',
    'margin',
    'profitPolicy',
    'settlementCurrency',
    'updatedAt',
    'updatedBy',
    'version'
]);
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
    'margin',
    'stage',
    'nativeDocuments',
    'salesOrder',
    'historicalReference',
    'exchangeRateUsed',
    'profitPolicy',
    'settlementCurrency',
    'nativeSettlementProjection',
    'nativeHasPostedSalesInvoices',
    'nativeSettlementCurrency',
    'salesAdvanceAmountUSD',
    'salesInvoiceSettledAmountUSD',
    'salesInvoiceOutstandingAmountUSD',
    'salesInvoiceNames',
    'factoryAdvanceAmount',
    'factoryInvoiceSettledAmount',
    'factoryInvoiceOutstandingAmount',
    'factoryInvoiceNames',
    'nativeReceiptSummary'
]);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const CONTACT_ALIASES = {
    contact: 'name',
    position: 'position',
    email: 'email',
    phone: 'phone',
    mobilePhone: 'mobilePhone',
    homeAddress: 'homeAddress'
};

export function workspaceDraftKey(session, origin) {
    const user = session.user;
    const authorization = encodeURIComponent(
        JSON.stringify([user.role, user.scope, user.permissions, user.visibleCompanyIds])
    );
    const backend = encodeURIComponent(
        session.backendIdentity ||
            session.backendInstanceId ||
            session.backend?.instanceId ||
            session.backend?.site ||
            'frappe'
    );
    return `trade_frappe_draft_v2:${origin}:${backend}:${user.tenantId}:${user.id}:${authorization}`;
}

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

function rateDerivedOrderIds(patch) {
    const ids = new Set();
    for (const change of patch.changes || []) {
        if (change?.collection !== 'orders' || change.deleted === true || !change.value) continue;
        const value = change.value;
        const directRateInput = [...ORDER_RATE_FIELDS].some(field => Object.hasOwn(value, field));
        const nestedRateInput =
            Array.isArray(value.factories) &&
            value.factories.some(row => row && [...NESTED_ORDER_RATE_FIELDS].some(field => Object.hasOwn(row, field)));
        if (directRateInput || nestedRateInput) ids.add(String(change.id));
    }
    return ids;
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
    constructor({ baseUrl = '/api', fetcher = null, canReplaceData = () => true, persistExchangeRates = true } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this._fetcher = fetcher;
        this._canReplaceData = canReplaceData;
        this._persistExchangeRates = persistExchangeRates;
        this._serial = Promise.resolve();
        this._baseline = null;
        this._working = null;
        this._lastMeta = { version: 0, updatedAt: null, updatedBy: null };
        this._ready = false;
        this._conflict = null;
        this._permissions = null;
        this._contactMergePreview = null;
        this._contactMergeSequence = 0;
        this._workingGeneration = 0;
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
                response.status === 409 &&
                (!payload.code || ['CONFLICT', 'VERSION_CONFLICT', 'STALE_VERSION'].includes(payload.code))
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

    async login({ tenantId, username, email, password }) {
        return this._enqueue(async () => {
            const result = await this._request('/login', {
                method: 'POST',
                body: { tenantId, username, email, password }
            });
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
        this._workingGeneration++;
        this._baseline = null;
        this._working = null;
        this._lastMeta = { version: 0, updatedAt: null, updatedBy: null };
        this._conflict = null;
        this._contactMergePreview = null;
    }

    exportDraftBaseline() {
        return clone(this._baseline);
    }

    restoreDraftBaseline(baseline, expectedVersion, { conflict = false } = {}) {
        if (
            !this._baseline ||
            !baseline ||
            baseline.meta?.version !== expectedVersion ||
            expectedVersion > this._baseline.meta.version ||
            !COLLECTIONS.every(collection => Array.isArray(baseline.data?.[collection]))
        ) {
            throw apiError('草稿缺少原始读取版本，请保留草稿并人工核对', 'INVALID_DRAFT_BASELINE');
        }
        const normalized = this._normalizeDataResult(baseline);
        for (const collection of COLLECTIONS) recordsById(normalized.data[collection]);
        const serverVersion = this._baseline.meta.version;
        this._workingGeneration++;
        this._baseline = clone(normalized);
        this._lastMeta = clone(normalized.meta);
        this._conflict =
            conflict || expectedVersion < serverVersion
                ? apiError('已恢复旧版本草稿，请先处理冲突', 'CONFLICT', 409)
                : null;
        this._contactMergePreview = null;
    }

    async prepareContactMerge({ expectedBaseVersion = this._baseline?.meta.version } = {}) {
        return this._enqueue(async () => {
            if (!this._baseline || !this._working?.data) throw apiError('请先读取业务数据', 'NO_BASELINE');
            if (expectedBaseVersion !== this._baseline.meta.version) {
                throw apiError(
                    '旧草稿缺少原始联系人基线，请下载保留并人工核对，不能自动覆盖服务器资料',
                    'CONTACT_BASE_MISSING'
                );
            }
            const baseline = clone(this._baseline);
            const working = clone(this._working);
            const patch = this._diff(working.data, working.exchangeRates, working.rateMetas);
            const old = recordsById(baseline.data.customers);
            if (
                !patch.changes.length ||
                patch.exchangeRates ||
                patch.rateMetas ||
                !patch.changes.every(change => {
                    if (
                        change.collection !== 'customers' ||
                        change.deleted ||
                        !old.has(String(change.id)) ||
                        !Array.isArray(change.value?.contacts)
                    ) {
                        return false;
                    }
                    const primary = change.value.contacts[0] || {};
                    return Object.entries(change.value).every(
                        ([field, value]) =>
                            field === 'contacts' ||
                            (Object.hasOwn(CONTACT_ALIASES, field) &&
                                equal(value, primary[CONTACT_ALIASES[field]] ?? ''))
                    );
                })
            ) {
                throw apiError(
                    '当前草稿还包含其他修改，请先下载保留；联系人合并只处理已有客户的联系人修改',
                    'CONTACT_MERGE_REQUIRES_CONTACT_ONLY'
                );
            }
            const remote = this._normalizeDataResult(await this._request('/data'), baseline.meta.version);
            if (!equal(working, this._working) || !equal(baseline, this._baseline)) {
                throw apiError('读取期间产生了新输入，请重新查看差异', 'CONTACT_MERGE_CHANGED');
            }
            const latest = recordsById(remote.data.customers);
            const customers = patch.changes.map(change => {
                const current = latest.get(String(change.id));
                if (!current || current.deleted || current.companyId !== old.get(String(change.id)).companyId) {
                    throw apiError(
                        '客户已删除、归属变化或不再可访问，请保留草稿并人工核对',
                        'CONTACT_MERGE_UNAVAILABLE'
                    );
                }
                return {
                    id: change.id,
                    name: current.company || current.companyName || String(change.id),
                    plan: proposeContactMerge(
                        old.get(String(change.id)).contacts || [],
                        change.value.contacts,
                        current.contacts || []
                    )
                };
            });
            const id = ++this._contactMergeSequence;
            this._contactMergePreview = {
                id,
                working,
                baseline,
                remote,
                customers,
                context: clone(this._sessionIdentity)
            };
            return clone({ id, baseVersion: baseline.meta.version, serverVersion: remote.meta.version, customers });
        });
    }

    async applyContactMerge(previewId, choices = {}) {
        return this._enqueue(async () => {
            const preview = this._contactMergePreview;
            if (
                !preview ||
                preview.id !== previewId ||
                !equal(preview.working, this._working) ||
                !equal(preview.baseline, this._baseline) ||
                !equal(preview.context, this._sessionIdentity)
            ) {
                throw apiError('草稿或读取版本已变化，请重新查看差异', 'CONTACT_MERGE_CHANGED');
            }
            const latest = recordsById(preview.remote.data.customers);
            const changes = preview.customers.map(customer => {
                const selected = Object.fromEntries(
                    customer.plan.conflicts.map(conflict => [conflict.id, choices[`${customer.id}:${conflict.id}`]])
                );
                const resolved = resolveContactMerge(customer.plan, selected);
                if (!resolved.canSubmit || !resolved.result?.length) {
                    throw apiError('请逐项确认联系人冲突；至少保留一位联系人', 'CONTACT_MERGE_UNRESOLVED');
                }
                const current = latest.get(String(customer.id));
                const primary = resolved.result[0];
                const value = { contacts: clone(resolved.result) };
                for (const [field, source] of Object.entries(CONTACT_ALIASES)) {
                    if (Object.hasOwn(current, field)) value[field] = primary[source] ?? '';
                }
                return { collection: 'customers', id: customer.id, value };
            });
            const result = await this._request('/changes', {
                method: 'POST',
                body: { expectedVersion: preview.remote.meta.version, changes }
            });
            if (!Number.isInteger(result.meta?.version) || result.meta.version <= preview.remote.meta.version) {
                throw apiError('合并确认缺少有效新版本，请保留草稿', 'INVALID_RESPONSE');
            }
            if (
                this._contactMergePreview !== preview ||
                !equal(preview.baseline, this._baseline) ||
                !equal(preview.context, this._sessionIdentity)
            ) {
                throw apiError('登录或权限已变化，请重新读取当前账号数据', 'CONTACT_MERGE_CHANGED');
            }
            this._baseline = clone(preview.remote);
            this._acknowledge({ changes }, result.meta);
            this._contactMergePreview = null;
            if (!equal(preview.working, this._working)) {
                throw this._operationAppliedConflict(
                    result.meta,
                    apiError('合并已保存，提交期间的新输入仍保留，请核对后继续', 'CONTACT_MERGE_CHANGED')
                );
            }
            this._conflict = null;
            const working = clone(this._baseline);
            this._workingGeneration++;
            this.bindWorkingData(working.data, working.exchangeRates, working.rateMetas);
            return working;
        });
    }

    bindWorkingData(data, exchangeRates, rateMetas) {
        this._working = { data, exchangeRates, rateMetas };
    }

    setSessionContext(session) {
        globalThis.Finance?.clear?.();
        const user = session?.user;
        const role = Array.isArray(session?.roles)
            ? session.roles.find(entry => entry.id === user?.role)
            : session?.roles?.[user?.role];
        const permissions = user?.permissions ?? role?.permissions;
        this._permissions = permissions === undefined ? null : clone(permissions);
        this._sessionIdentity = clone(
            user
                ? {
                      id: user.id,
                      tenantId: user.tenantId,
                      visibleCompanyIds: user.visibleCompanyIds,
                      scope: user.scope,
                      permissions
                  }
                : null
        );
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
            if (key === 'factories' && Array.isArray(value)) {
                result.factories = value.map(row => {
                    const old = (baseline?.factories || []).find(
                        item => String(item.factoryId) === String(row.factoryId)
                    );
                    return Object.fromEntries(
                        Object.entries(row).filter(
                            ([field]) =>
                                !PROJECTED_FACTORY_FIELDS.has(field) &&
                                (finance === true ||
                                    !NESTED_FINANCIAL_FIELDS.has(field) ||
                                    (finance === null && Object.hasOwn(old || {}, field)))
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
        // Unified Tradept reads the current market publication through the
        // same-origin rate endpoint. Those in-memory values must never become
        // an incidental Currency Exchange write when an unrelated order saves.
        const ratePatch = this._persistExchangeRates ? changedFields(exchangeRates, this._baseline.exchangeRates) : {};
        const metaPatch = this._persistExchangeRates ? changedFields(rateMetas, this._baseline.rateMetas) : {};
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
            const normalized = this._normalizeDataResult(result);
            this._baseline = clone(normalized);
            this._lastMeta = clone(normalized.meta);
            this._ready = true;
            this._conflict = null;
            const working = clone(normalized);
            this._workingGeneration++;
            this.bindWorkingData(working.data, working.exchangeRates, working.rateMetas);
            return working;
        });
    }

    _normalizeDataResult(result, minimumVersion = 0) {
        if (!result.data || !Number.isInteger(result.meta?.version) || result.meta.version < minimumVersion) {
            throw apiError('业务数据缺少有效版本', 'INVALID_RESPONSE');
        }
        return {
            data: Object.fromEntries(COLLECTIONS.map(key => [key, clone(result.data[key] || [])])),
            exchangeRates: clone(result.exchangeRates || {}),
            rateMetas: clone(result.rateMetas || {}),
            meta: clone(result.meta)
        };
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

    _reconcileRateDerivedOrders(normalized, data, orderIds) {
        const authoritative = recordsById(normalized.data.orders);
        const acknowledged = recordsById(this._baseline.data.orders);
        const current = recordsById(data.orders || []);
        const merges = [];
        for (const id of orderIds) {
            const source = authoritative.get(id);
            if (!source) throw apiError('保存后的订单未出现在权威读取结果中', 'INVALID_RESPONSE');
            const target = current.get(id);
            if (!target || target.deleted === true) continue;
            merges.push({ source, target, accepted: acknowledged.get(id) || {} });
        }
        this._baseline = clone(normalized);
        this._lastMeta = clone(normalized.meta);
        this._conflict = null;
        for (const { source, target, accepted } of merges) {
            for (const field of AUTHORITATIVE_ORDER_FIELDS) {
                if (Object.hasOwn(source, field)) target[field] = clone(source[field]);
            }
            for (const field of NORMALIZED_ORDER_INPUTS) {
                if (!equal(target[field], accepted[field])) continue;
                if (Object.hasOwn(source, field)) target[field] = clone(source[field]);
                else delete target[field];
            }
            delete target.companyOperationNoAuto;
        }
    }

    _operationAppliedConflict(meta, cause) {
        const error = apiError('保存已生效，但未能核对服务器派生金额；请刷新数据后继续操作', 'CONFLICT', 409);
        error.latestVersion = cause?.latestVersion ?? meta.version;
        error.operationApplied = true;
        error.refreshRequired = true;
        error.cause = cause;
        this._conflict = error;
        return error;
    }

    async saveData(data, exchangeRates, rateMetas) {
        // Preserve the reference, then sample it when its queued operation starts.
        // New edits made during an earlier network request remain observable.
        const generation = this._workingGeneration;
        this.bindWorkingData(data, exchangeRates, rateMetas);
        return this._enqueue(async () => {
            if (generation !== this._workingGeneration) {
                throw apiError('读取版本已切换，旧保存请求未执行；请核对当前数据', 'STALE_WORKING_DATA');
            }
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
            const orderIds = rateDerivedOrderIds(patch);
            if (orderIds.size) {
                try {
                    const authoritative = this._normalizeDataResult(await this._request('/data'), result.meta.version);
                    if (authoritative.meta.version !== result.meta.version) {
                        const mismatch = apiError('保存后数据版本已被其他操作推进', 'CONFLICT', 409);
                        mismatch.latestVersion = authoritative.meta.version;
                        throw mismatch;
                    }
                    this._reconcileRateDerivedOrders(authoritative, data, orderIds);
                } catch (cause) {
                    throw this._operationAppliedConflict(result.meta, cause);
                }
            }
            return true;
        });
    }

    async listSnapshots() {
        return this._enqueue(async () => {
            const result = await this._request('/snapshots');
            return clone(result.snapshots || result);
        });
    }

    async backendStatus() {
        return this._enqueue(() => this._request('/backend/status'));
    }

    async adminState() {
        return this._enqueue(async () => clone(await this._request('/administrator')));
    }

    _financeQuery(params) {
        return new URLSearchParams(
            Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null)
        ).toString();
    }

    financeState(params = {}) {
        return this._enqueue(async () => clone(await this._request('/finance/state?' + this._financeQuery(params))));
    }

    financeDocument(params = {}) {
        return this._enqueue(async () => clone(await this._request('/finance/document?' + this._financeQuery(params))));
    }

    catalogState(params = {}) {
        const query = { ...params };
        if (typeof query.includeDisabled === 'boolean') query.includeDisabled = Number(query.includeDisabled);
        return this._enqueue(async () => clone(await this._request('/catalog/state?' + this._financeQuery(query))));
    }

    catalogOperation(params) {
        return this._enqueue(async () => {
            if (this.hasChanges()) throw apiError('请先保存或处理当前业务草稿，再维护商品', 'LOCAL_CHANGES');
            if (!Number.isInteger(params?.expectedVersion) || params.expectedVersion < 0 || !String(params?.idempotencyKey || '').trim()) {
                throw apiError('商品操作缺少当前版本或稳定请求标识', 'INVALID_REQUEST');
            }
            const result = await this._request('/catalog/operation', { method: 'POST', body: clone(params) });
            const version = result.meta?.version ?? result.version;
            if (!Number.isInteger(version) || version < params.expectedVersion) {
                throw apiError('商品保存确认缺少有效版本，请保留原请求核对结果', 'INVALID_RESPONSE');
            }
            // Only a full data read can acknowledge business-record changes;
            // a native Item write must leave their save baseline intact.
            return clone(result);
        });
    }

    financeReport(params = {}) {
        return this._enqueue(async () =>
            clone(await this._request('/finance/report', { method: 'POST', body: clone(params) }))
        );
    }

    financeOperation(params) {
        return this._enqueue(async () => {
            if (this.hasChanges()) {
                throw apiError('请先保存或处理当前业务草稿，再进行财务操作', 'LOCAL_CHANGES');
            }
            if (
                !Number.isInteger(params?.expectedVersion) ||
                params.expectedVersion < 0 ||
                !String(params?.idempotencyKey || '').trim()
            ) {
                throw apiError('财务操作缺少当前版本或稳定请求标识', 'INVALID_REQUEST');
            }
            // Keep the business-record save baseline unchanged. Invoice writes
            // can change projected order balances; only a full authorised data
            // read may acknowledge those new values.
            const result = await this._request('/finance/operation', { method: 'POST', body: clone(params) });
            const version = result.meta?.version ?? result.version;
            if (!Number.isInteger(version) || version < params.expectedVersion) {
                throw apiError('财务操作确认缺少有效版本，请保留原请求并核对单据', 'INVALID_RESPONSE');
            }
            return clone(result);
        });
    }

    async adminUpdate(body) {
        return this._enqueue(async () => {
            if (this.hasChanges()) {
                throw apiError('请先保存或处理当前业务草稿，再修改企业配置', 'LOCAL_CHANGES');
            }
            const expectedVersion = body?.expectedVersion;
            if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
                throw apiError('企业配置缺少当前数据版本', 'EXPECTED_VERSION_REQUIRED');
            }
            if (this._baseline && this._baseline.meta.version !== expectedVersion) {
                throw apiError('业务数据版本已更新，请刷新后再修改企业配置', 'CONFLICT', 409);
            }
            let result;
            try {
                result = await this._request('/administrator', { method: 'POST', body: clone(body) });
            } catch (error) {
                if (error.code === 'CONFLICT') this._conflict = error;
                throw error;
            }
            if (!Number.isInteger(result.meta?.version) || result.meta.version <= expectedVersion) {
                throw apiError('企业配置保存确认缺少有效新版本', 'INVALID_RESPONSE');
            }
            if (this._baseline) this._baseline.meta = clone(result.meta);
            this._lastMeta = clone(result.meta);
            return clone(result);
        });
    }

    /**
     * Read the shared live USD → CNY reference rate.
     *
     * The same-origin gateway owns upstream caching and only contacts the
     * provider after its advertised next publication time. Calling this method
     * when the settings page opens therefore does not create another upstream
     * request while the current publication is still valid.
     */
    async getExchangeRate() {
        return this._enqueue(async () => clone(await this._request('/exchange-rate')));
    }

    async importOrders(changes, { importPurpose = 'order-brief', expectedVersion } = {}) {
        return this._enqueue(async () => {
            if (this._conflict) throw this._conflict;
            if (!this._baseline) throw apiError('请先读取当前数据版本', 'NO_BASELINE');
            if (this.hasChanges()) throw apiError('请先保存或处理当前草稿，再确认 Excel 导入', 'LOCAL_CHANGES');
            const version = this._baseline.meta.version;
            if (expectedVersion !== undefined && expectedVersion !== version) {
                throw apiError('预览版本已更新，请重新核对导入内容', 'CONFLICT', 409);
            }
            if (
                !['order-brief', 'historical-reference'].includes(importPurpose) ||
                !Array.isArray(changes) ||
                !changes.length ||
                changes.some(change => change.collection !== 'orders' || !change.id || !change.value || change.deleted)
            ) {
                throw apiError('导入用途或订单批次无效', 'INVALID_IMPORT');
            }
            const normalized = changes.map(change => {
                const before = this._baseline.data.orders.find(record => String(record.id) === String(change.id));
                const value = this._publicRecord(change.value, before);
                if (importPurpose === 'historical-reference' && this._canWriteFinance() === true) {
                    for (const key of ['orderAmountRMB', 'profitRMB', 'profitUSD', 'profitRate']) {
                        if (Object.hasOwn(change.value, key)) value[key] = change.value[key];
                    }
                }
                return { collection: 'orders', id: change.id, value };
            });
            let result;
            try {
                result = await this._request('/changes', {
                    method: 'POST',
                    body: { expectedVersion: version, importPurpose, changes: clone(normalized) }
                });
            } catch (error) {
                if (error.code === 'CONFLICT') this._conflict = error;
                throw error;
            }
            if (!Number.isInteger(result.meta?.version) || result.meta.version <= version) {
                throw apiError('导入确认缺少有效新版本，请核对数据库后再重试', 'INVALID_RESPONSE');
            }
            if (this.hasChanges()) {
                const error = apiError('导入已完成，期间的新修改已保留为草稿，请先处理再刷新', 'CONFLICT', 409);
                error.latestVersion = result.meta.version;
                error.operationApplied = true;
                this._conflict = error;
                throw error;
            }
            // Do not stage imported history into the ordinary autosave/draft path.
            // The caller replaces the workspace only through an authorized read.
            return clone(result);
        });
    }

    async _orderAction(action, orderId, inputs = {}) {
        // Native documents and payments must be one version-checked server operation.
        // A fresh authorized read follows success; their fields cannot be acknowledged
        // by merging the submitted request into the old business-data baseline.
        return this._enqueue(async () => {
            if (this._conflict) throw this._conflict;
            if (!this._baseline) throw apiError('请先读取当前数据版本', 'NO_BASELINE');
            if (this.hasChanges()) throw apiError('请先保存或处理当前草稿', 'LOCAL_CHANGES');
            const expectedVersion = this._baseline.meta.version;
            if (inputs.expectedVersion !== undefined && inputs.expectedVersion !== expectedVersion) {
                throw apiError('操作版本与当前读取基线不一致', 'CONFLICT', 409);
            }
            if (!String(orderId || '').trim() || !String(inputs.idempotencyKey || '').trim()) {
                throw apiError('订单操作缺少稳定请求标识', 'INVALID_REQUEST');
            }
            let result;
            try {
                result = await this._request(`/orders/${action}`, {
                    method: 'POST',
                    body: { ...clone(inputs), orderId, expectedVersion }
                });
            } catch (error) {
                if (error.code === 'CONFLICT') this._conflict = error;
                throw error;
            }
            if (!Number.isInteger(result.meta?.version) || result.meta.version < expectedVersion) {
                throw apiError('操作确认缺少有效版本，请保留请求并核对业务数据', 'INVALID_RESPONSE');
            }
            if (this.hasChanges()) {
                const error = apiError('操作已完成，期间的新修改已保留。请先处理草稿再刷新', 'CONFLICT', 409);
                error.latestVersion = result.meta.version;
                error.operationApplied = true;
                this._conflict = error;
                throw error;
            }
            return clone(result);
        });
    }

    convertOrder(orderId, inputs) {
        return this._orderAction('convert', orderId, inputs);
    }

    submitOrder(orderId, inputs) {
        return this._orderAction('submit', orderId, inputs);
    }

    cancelOrder(orderId, inputs) {
        return this._orderAction('cancel', orderId, inputs);
    }

    receivePayment(orderId, inputs) {
        return this._orderAction('payment', orderId, inputs);
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
