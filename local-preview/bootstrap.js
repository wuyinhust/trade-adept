import { DemoProfile } from '/js/demo-profile.js';
import { App } from '/js/app.js?v58';
import { Auth } from '/js/auth.js?v58';
import { Cloud } from '/js/cloud.js?v58';
import { Exchange } from '/js/exchange.js?v58';
import { DB } from '/js/data.js?v58';


Auth.users = DemoProfile.users;
Auth.teams = DemoProfile.teams;
Auth.init = () => {
    const saved = sessionStorage.getItem(Auth.SESSION_KEY);
    try { Auth.currentUser = Auth.users.find(u => u.id === JSON.parse(saved || '{}').userId) || null; }
    catch (_) { Auth.currentUser = null; }
    return !!Auth.currentUser;
};
DB._preserveImportedValues = true;
const SHOW_LOGIN_KEY = 'grandware_preview_show_login';
const seed = await fetch('/__preview/seed.json').then(response => {
    if (!response.ok) throw new Error('无法读取本地预览数据');
    return response.json();
});
const isCloudSnapshot = seed.source?.kind === 'cloudbase-app-export';
if (isCloudSnapshot) for (const company of DB.companies) {
    company.profitPolicy = 'grandware-v40';
    company.settlementCurrency = ['CO-GR', 'CO-WY'].includes(company.id) ? 'CNY' : 'USD';
}
const sourceLabel = isCloudSnapshot ? '线上数据快照' : '示例数据';
const STORE_KEY = isCloudSnapshot
    ? `grandware_local_preview_v3_${seed.source.sha256}`
    : 'grandware_local_preview_v2';
DB._BACKUP_KEY = `${STORE_KEY}_backup`;
const clone = value => JSON.parse(JSON.stringify(value));
function readStore() {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : clone(seed);
}
if (!localStorage.getItem(STORE_KEY)) localStorage.setItem(STORE_KEY, JSON.stringify(seed));

// Only the preview transport changes. Original business modules remain untouched.
Cloud.DEFAULT_ENV_ID = Cloud.envId = 'local-preview';
Cloud.CLOUD_FN_URL = Cloud.CLOUD_SECRET = '';
Cloud.loadConfig = () => null;
Cloud.saveConfig = () => false;
Cloud.getConfig = () => ({ envId: 'local-preview', region: 'ap-shanghai', cloudFnUrl: '', cloudSecret: '' });
Cloud._ensureSDK = () => {};
Cloud.isReady = () => Cloud._ready;
Cloud.init = async () => {
    Cloud._ready = true;
    Cloud._loginType = 'local';
    Cloud._status = { sdkLoaded: true, authDone: true, dbReady: true, lastError: null, lastErrorTime: null };
    Cloud._lastMeta = readStore().meta;
    return { ok: true, uid: 'local-preview', loginType: 'local' };
};
Cloud.testPermission = async () => ({ ok: true, reason: '本地预览存储' });
Cloud.loadData = async () => {
    const stored = readStore();
    Cloud._lastMeta = stored.meta;
    return clone(stored);
};
Cloud.checkRemoteVersion = async () => clone(readStore().meta);
Cloud.saveData = async (data, exchangeRates, rateMetas) => {
    const previous = readStore();
    const meta = {
        version: (previous.meta?.version || 0) + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: Auth.currentUser?.name || '本地预览'
    };
    localStorage.setItem(STORE_KEY, JSON.stringify({ data, exchangeRates, rateMetas, meta, source: seed.source }));
    Cloud._lastMeta = meta;
    return true;
};
Cloud._cleanupOldDocs = async () => {};
Cloud._tryCustomLogin = async () => ({ ok: false, skipped: true, error: '本地预览不连接云端' });
Cloud.diagnose = async () => ({ localPreview: true, ok: true, envId: 'local-preview' });
Exchange._fetchRawRate = async () => isCloudSnapshot
    ? null
    : ({ rawRate: 7.25, adjustedRate: 7.25, source: '本地示例汇率' });
if (isCloudSnapshot) {
    Exchange.startAutoRefresh = () => Exchange.stopAutoRefresh();
}
// The original beforeunload handler sends a cloud beacon; disable it in preview.
navigator.sendBeacon = () => false;

const originalCloudStatus = App.updateCloudStatus;
App.updateCloudStatus = function () {
    originalCloudStatus.call(this);
    const text = document.getElementById('cloudStatusText');
    const bar = document.getElementById('cloudStatusBar');
    if (text) text.textContent = `本地预览 · ${sourceLabel}`;
    if (bar) bar.title = `${sourceLabel}保存在当前浏览器，点击刷新本地数据`;
};
const originalSaveStatus = App.updateSaveStatus;
App.updateSaveStatus = function (status, message) {
    originalSaveStatus.call(this, status, message);
    if (status === 'saved') {
        const text = document.getElementById('saveStatusText');
        if (text) text.textContent = '✅ 已保存到本地';
    }
};
const originalRouter = App.router;
App.router = async function () {
    await originalRouter.call(this);
    if (this.currentPage !== 'settings') return;
    const status = document.getElementById('cloudConfigStatus');
    if (status) status.textContent = '本地预览 · 数据仅保存在当前浏览器 · CloudBase 连接已隔离';
    for (const code of document.querySelectorAll('#pageContent code')) {
        if (code.textContent === 'grandware-d9gb4owez89cb9df9') code.textContent = 'local-preview';
    }
    for (const button of document.querySelectorAll('#pageContent button[onclick]')) {
        if (/ManualConfig|runFullDiagnose/.test(button.getAttribute('onclick'))) {
            button.disabled = true;
            button.title = '本地预览不修改云端连接配置';
        }
    }
    for (const id of ['cfgEnvId', 'cfgRegion', 'cfgCloudFnUrl', 'cfgCloudSecret']) {
        const input = document.getElementById(id);
        if (input) input.disabled = true;
    }
    if (isCloudSnapshot) {
        for (const id of ['fetchRateBtn', 'toggleAutoRefreshBtn']) {
            const button = document.getElementById(id);
            if (button) {
                button.disabled = true;
                button.title = '本地测试保留线上快照汇率';
            }
        }
    }
};

const labels = { admin: '管理员', finance: '财务', manager: '经理', salesperson: '业务员', document: '单证员' };
const toolbar = document.createElement('div');
toolbar.id = 'localPreviewToolbar';
toolbar.className = 'local-preview-toolbar';
toolbar.innerHTML = `<strong>本地预览 · ${sourceLabel}</strong><select aria-label="预览角色"><option value="">选择角色进入</option></select><button type="button" class="btn btn-secondary">${isCloudSnapshot ? '恢复线上快照' : '恢复示例数据'}</button>`;
document.body.appendChild(toolbar);
const roleSelect = toolbar.querySelector('select');
for (const user of Auth.users) {
    const option = document.createElement('option');
    option.value = user.id;
    option.textContent = `${labels[user.role]} · ${user.name}`;
    roleSelect.appendChild(option);
}
roleSelect.onchange = () => {
    if (!roleSelect.value) return;
    sessionStorage.removeItem(SHOW_LOGIN_KEY);
    sessionStorage.setItem(Auth.SESSION_KEY, JSON.stringify({ userId: roleSelect.value }));
    location.reload();
};
toolbar.querySelector('button').onclick = () => {
    if (!confirm(`恢复当前浏览器的${sourceLabel}？本地预览中做的修改会被清除。`)) return;
    localStorage.setItem(STORE_KEY, JSON.stringify(seed));
    localStorage.removeItem(DB._BACKUP_KEY);
    location.reload();
};
const originalLogout = App.handleLogout;
App.handleLogout = async function () {
    sessionStorage.setItem(SHOW_LOGIN_KEY, '1');
    await originalLogout.call(this);
    roleSelect.value = '';
};
if (!sessionStorage.getItem(SHOW_LOGIN_KEY) && !sessionStorage.getItem(Auth.SESSION_KEY)) {
    sessionStorage.setItem(Auth.SESSION_KEY, JSON.stringify({ userId: 'U001' }));
}
await App.init();
roleSelect.value = Auth.currentUser?.id || '';
window.__localPreview = { storageKey: STORE_KEY, isolated: true };
