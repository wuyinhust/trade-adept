/** Compatibility name for the existing data layer; the only transport is BusinessAPIClient. */
const Cloud = {
    _api: null,
    _actor: () => null,
    _saveQueue: [],
    _saveRunning: false,
    _lastMeta: { version: 0, updatedAt: null, updatedBy: null },

    configure(api, actor = () => null) {
        this._api = api;
        this._actor = actor;
    },

    _requireAPI() {
        if (!this._api) {
            const error = new Error('业务服务尚未连接，请保留草稿并登录企业工作区');
            error.code = 'BACKEND_UNAVAILABLE';
            throw error;
        }
        return this._api;
    },

    isReady() {
        return this._api?.isReady() === true;
    },

    async init() {
        return { ok: this.isReady(), uid: this._actor()?.id, loginType: 'server-session' };
    },

    loadData(options) {
        return this._requireAPI().loadData(options);
    },

    saveData(...args) {
        return this._requireAPI().saveData(...args);
    },

    checkRemoteVersion() {
        return this._requireAPI().checkRemoteVersion();
    },

    getLastMeta() {
        return this._api ? this._api.getLastMeta() : { ...this._lastMeta };
    },

    async testPermission() {
        return { ok: this.isReady() };
    },

    _drainQueue() {
        return this._requireAPI().drainQueue();
    },

    resetSession() {},
    async _cleanupOldDocs() {},

    getStatus() {
        return { transportReady: Boolean(this._api), authDone: this.isReady(), dbReady: this.isReady() };
    }
};

export { Cloud };
