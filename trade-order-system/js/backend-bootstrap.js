import { App } from './app.js';
import { Auth } from './auth.js';
import { Cloud } from './cloud.js';
import { DB } from './data.js';
import { Exchange } from './exchange.js';
import { BusinessAPIClient, workspaceDraftKey } from './api-client.js';
import { escapeHtml, toast } from './utils.js';

const api = new BusinessAPIClient({ canReplaceData: () => !document.querySelector('#modalContainer .modal-overlay') });
const tenantInput = document.createElement('div');
tenantInput.className = 'form-group';
tenantInput.innerHTML =
    '<label class="form-label" for="loginTenant">企业工作区</label><input id="loginTenant" class="form-input" required autocomplete="organization" placeholder="管理员提供的工作区 ID">';
document.getElementById('loginForm').prepend(tenantInput);
const teamImage = document.querySelector('.login-footer-image');
if (teamImage) teamImage.hidden = true;

function applySession(session) {
    Auth._serverDataAuthorized = true;
    Auth.users = session.users || [];
    Auth.teams = session.teams || {};
    Auth.roles = session.roles || {};
    Auth.currentUser = session.user;
    DB.companies = session.companies || [];
    DB.COMPANY_KEY = `trade_company_${session.user.tenantId}`;
    DB.currentCompanyId = sessionStorage.getItem(`trade_company_${session.user.tenantId}`) || DB.companies[0]?.id;
    DB._BACKUP_KEY = workspaceDraftKey(session, location.origin);
    DB._cloudReady = false;
    const tenant = session.tenant || {};
    App.workspaceName = tenant.branding?.workspaceName || tenant.name || 'Tradept';
    document.title = `${tenant.name || session.user.tenantId} · Tradept`;
    document.querySelector('.brand-caption').textContent = tenant.name || session.user.tenantId;
    const image = document.querySelector('.login-footer-image');
    if (image) image.hidden = true;
    return session.user;
}

Auth.configureProvider({
    restoreSession: async () => {
        try {
            return applySession(await api.session());
        } catch (e) {
            if (e.status === 401) return null;
            throw e;
        }
    },
    login: async (username, password) => {
        await api.login({ tenantId: document.getElementById('loginTenant').value.trim(), username, password });
        return applySession(await api.session());
    },
    logout: async () => {
        await api.logout();
        DB._cloudReady = DB._cloudConnected = false;
        Auth._serverDataAuthorized = false;
        document.title = 'Tradept · 登录工作区';
        DB.data = { customers: [], orders: [], factories: [], shipments: [], invoices: [] };
    }
});

DB._businessAPI = api;
DB._preserveImportedValues = true;
Cloud.configure(api, () => Auth.currentUser);
Exchange.startAutoRefresh = () => Exchange.stopAutoRefresh();
App._pageModulePaths.settings = './workspace-settings.js';

const originalCloudStatus = App.updateCloudStatus;
App.updateCloudStatus = function () {
    originalCloudStatus.call(this);
    const text = document.getElementById('cloudStatusText');
    if (text) text.textContent = DB._cloudReady ? '业务数据库 · 测试环境' : '业务服务未连接 · 草稿保留';
};

const conflictBar = document.createElement('div');
conflictBar.id = 'saveConflictBar';
conflictBar.className = 'local-preview-toolbar';
conflictBar.hidden = true;
conflictBar.innerHTML =
    '<strong>版本冲突 · 修改尚未保存</strong><button class="btn btn-secondary" id="downloadConflictDraft">下载草稿</button><button class="btn btn-secondary" id="discardConflictDraft">放弃草稿并重载</button>';
document.body.appendChild(conflictBar);
DB.onSaveConflict = () => {
    conflictBar.hidden = false;
};

document.getElementById('downloadConflictDraft').onclick = () => {
    const blob = new Blob(
        [
            JSON.stringify(
                {
                    tenantId: Auth.currentUser?.tenantId,
                    baseVersion: DB._cloudVersion,
                    data: DB.data,
                    exchangeRates: DB.exchangeRates,
                    rateMetas: DB.rateMetas
                },
                null,
                2
            )
        ],
        { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '未保存草稿.json';
    link.click();
    URL.revokeObjectURL(url);
};
document.getElementById('discardConflictDraft').onclick = () => {
    App.showConfirm('放弃当前未保存修改，重新加载数据库版本？建议先下载草稿。', async () => {
        DB._clearLocalBackup();
        api.resetBaseline();
        DB._saveConflict = false;
        conflictBar.hidden = true;
        await DB._initFromBusinessAPI();
        await App.router();
        App.updateSaveStatus('saved');
    });
};

const originalLogout = App.handleLogout;
App.handleLogout = async function () {
    if (DB._saveConflict || api.hasChanges(DB.data, DB.exchangeRates, DB.rateMetas)) {
        if (!(await DB.flush())) {
            toast('修改尚未保存。请先处理冲突或保留草稿后退出', 'warning');
            return;
        }
    }
    await originalLogout.call(this);
    conflictBar.hidden = true;
};

window.Workspace = { api, escapeHtml };
await App.init();
