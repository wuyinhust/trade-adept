import { jest } from '@jest/globals';

const hasCapability = jest.fn(() => true);
const showModal = jest.fn();
const toast = jest.fn();
const logout = jest.fn(async () => {});
const showLogin = jest.fn();

jest.unstable_mockModule('../js/auth.js', () => ({ Auth: { hasCapability, logout } }));
jest.unstable_mockModule('../js/app.js', () => ({
    App: { showModal, closeModal: jest.fn(), showLogin }
}));
jest.unstable_mockModule('../js/utils.js', () => ({
    escapeHtml: value =>
        String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;'),
    toast
}));

const { AdminCenter, Onboarding } = await import('../js/administrator.js');

const state = () => ({
    meta: { version: 8, updatedAt: '2026-10-12T12:00:00Z', updatedBy: 'U1' },
    enterprise: { id: 'tenant', name: 'Example Trading', language: 'zh-CN', timezone: 'Asia/Shanghai', branding: {} },
    companies: [
        { id: 'C1', name: 'Example Shanghai', jurisdiction: 'CN', settlementCurrency: 'CNY', orderPrefix: 'EX' }
    ],
    departments: [{ id: 'D1', name: 'Sales', visibleCompanyIds: ['C1'], memberIds: ['U1'] }],
    members: [
        {
            id: 'U1',
            name: 'Admin',
            username: 'admin',
            email: 'admin@example.com',
            role: 'admin',
            departmentId: 'D1',
            visibleCompanyIds: ['C1'],
            enabled: true
        }
    ],
    roles: [
        {
            key: 'admin',
            label: '企业管理员',
            scope: 'tenant',
            permissions: ['read', 'accounts.configure'],
            pages: ['dashboard', 'admin']
        }
    ],
    emailAccounts: [],
    onboarding: {
        status: 'in_progress',
        currentStep: 'business',
        completedSteps: ['enterprise', 'company', 'organization', 'members'],
        requiredReady: true,
        checks: { enterprise: true, company: true, organization: true, members: true, business: false }
    },
    options: {
        permissions: ['accounts.configure', 'read'],
        pages: ['admin', 'dashboard'],
        scopes: ['self', 'team', 'tenant'],
        emailAvailable: true
    }
});

describe('administrator experience', () => {
    beforeEach(() => {
        document.body.innerHTML = '<main id="pageContent"></main>';
        hasCapability.mockReturnValue(true);
        window.Workspace = {
            api: {
                adminState: jest.fn(async () => state()),
                adminUpdate: jest.fn(async () => ({ meta: { version: 9 } }))
            }
        };
        AdminCenter.state = null;
        AdminCenter.target = null;
        AdminCenter.tab = 'overview';
    });

    test('shows real enterprise configuration and pending onboarding state', async () => {
        await AdminCenter.render(document.getElementById('pageContent'));
        expect(document.body.textContent).toContain('管理中心');
        expect(document.body.textContent).toContain('Example Trading');
        expect(document.body.textContent).toContain('企业配置待完成');
        expect(document.body.textContent).toContain('1 个部门');
    });

    test('keeps administrator page closed for accounts without management permission', async () => {
        hasCapability.mockReturnValue(false);
        await AdminCenter.render(document.getElementById('pageContent'));
        expect(window.Workspace.api.adminState).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('没有企业管理权限');
    });

    test('renders resumable onboarding with a final completion action', async () => {
        await Onboarding.render(document.getElementById('pageContent'));
        expect(document.body.textContent).toContain('建立你的企业工作区');
        expect(document.body.textContent).toContain('业务准备');
        expect(document.body.textContent).toContain('完成初始化');
    });

    test('offers default incoming and outgoing choices for enterprise mailboxes', async () => {
        showModal.mockImplementationOnce((_title, body, options) => {
            document.body.insertAdjacentHTML('beforeend', body + options.footer);
        });
        AdminCenter.state = state();
        AdminCenter.open_email();
        expect(showModal).toHaveBeenCalledWith(
            '添加企业邮箱',
            expect.stringContaining('设为默认收信邮箱'),
            expect.objectContaining({ large: true })
        );
        expect(showModal.mock.calls.at(-1)[1]).toContain('设为默认发信邮箱');
    });

    test('native numeric disabled email flags stay unchecked when editing', () => {
        showModal.mockImplementationOnce((_title, body, options) => {
            document.body.insertAdjacentHTML('beforeend', body + options.footer);
        });
        AdminCenter.state = state();
        AdminCenter.open_email({
            id: 'Sales Mail',
            label: 'Sales',
            emailId: 'sales@example.com',
            enableIncoming: 0,
            enableOutgoing: 0,
            useSsl: 0,
            useTls: 0
        });
        expect(document.querySelector('[name="enableIncoming"]').checked).toBe(false);
        expect(document.querySelector('[name="enableOutgoing"]').checked).toBe(false);
        expect(document.querySelector('[name="incomingEncryption"]').value).toBe('none');
        expect(document.querySelector('[name="outgoingEncryption"]').value).toBe('none');
        expect(document.querySelector('[name="password"]').required).toBe(false);
    });

    test('configuration and onboarding progress use one atomic save', async () => {
        AdminCenter.state = state();
        AdminCenter.target = document.getElementById('pageContent');
        await AdminCenter.save('enterprise', { name: 'Updated' }, 'enterprise');
        expect(window.Workspace.api.adminUpdate).toHaveBeenCalledTimes(1);
        expect(window.Workspace.api.adminUpdate).toHaveBeenCalledWith({
            resource: 'enterprise',
            value: { name: 'Updated' },
            expectedVersion: 8,
            completedStep: 'enterprise'
        });
    });

    test('revisiting onboarding company step opens the saved company', async () => {
        showModal.mockImplementationOnce((_title, body, options) => {
            document.body.insertAdjacentHTML('beforeend', body + options.footer);
        });
        AdminCenter.state = state();
        Onboarding.target = document.getElementById('pageContent');
        Onboarding.open('company');
        expect(showModal.mock.calls.at(-1)[0]).toBe('编辑公司');
        expect(document.querySelector('[name="id"]').value).toBe('C1');
        expect(document.querySelector('[name="id"]').readOnly).toBe(true);
    });

    test('company editing locks native identity and preserves legacy Hong Kong country', () => {
        showModal.mockImplementationOnce((_title, body, options) => {
            document.body.insertAdjacentHTML('beforeend', body + options.footer);
        });
        AdminCenter.state = state();
        AdminCenter.open_company({
            id: 'HK1',
            name: 'HK Trading',
            jurisdiction: 'HK',
            settlementCurrency: 'USD',
            orderPrefix: 'HK'
        });
        expect(document.querySelector('[name="name"]').readOnly).toBe(true);
        expect(document.querySelector('[name="country"]').value).toBe('Hong Kong');
        expect(document.querySelector('[name="country"]').readOnly).toBe(true);
        expect(document.querySelector('[name="jurisdiction"]').readOnly).toBe(true);
        expect(document.querySelector('[name="orderPrefix"]').readOnly).toBe(false);
        expect(document.body.textContent).toContain('当前可修改订单前缀');
    });

    test('escapes enterprise values rendered inside management tables', async () => {
        const unsafe = state();
        unsafe.companies[0].name = '<img src=x onerror=alert(1)>';
        window.Workspace.api.adminState.mockResolvedValueOnce(unsafe);
        AdminCenter.tab = 'enterprise';
        await AdminCenter.render(document.getElementById('pageContent'));
        expect(document.querySelector('.admin-panel img')).toBeNull();
        expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(document.querySelector('[data-edit-company="C1"]')).not.toBeNull();
    });

    test('an acknowledged self edit asks for login when native sessions are revoked', async () => {
        await AdminCenter.render(document.getElementById('pageContent'));
        window.Workspace.refreshSession = jest.fn(async () => { throw Object.assign(new Error('expired'), { status: 401, code: 'SESSION_REQUIRED' }); });
        const result = await AdminCenter.save('member', { id: 'U1', name: 'Changed admin' });
        expect(result.meta.version).toBe(9);
        expect(window.Workspace.api.adminUpdate).toHaveBeenCalledTimes(1);
        expect(logout).toHaveBeenCalled();
        expect(showLogin).toHaveBeenCalled();
        expect(toast).toHaveBeenLastCalledWith('账号配置已保存，会话已结束，请重新登录', 'success');
        expect(AdminCenter.state).toBeNull();
    });

    test('a readback failure after acknowledgement does not report a failed save or replay it', async () => {
        await AdminCenter.render(document.getElementById('pageContent'));
        window.Workspace.refreshSession = jest.fn(async () => { throw Object.assign(new Error('offline'), { code: 'NETWORK' }); });
        await AdminCenter.save('enterprise', { name: 'Changed enterprise' });
        expect(window.Workspace.api.adminUpdate).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('配置已保存');
        expect(document.querySelector('[data-admin-reload]')).not.toBeNull();
        expect(toast).toHaveBeenLastCalledWith('配置已保存，读取最新状态失败', 'warning');
    });
    test('account members can omit email and receive administrator-configured passwords', () => {
        showModal.mockImplementationOnce((_title, body, options) => {
            document.body.insertAdjacentHTML('beforeend', body + options.footer);
        });
        AdminCenter.state = state();
        AdminCenter.state.loginPolicy = { mode: 'accounts', enabled: false, emailVerificationRequired: false };
        AdminCenter.open_member();
        expect(document.querySelector('[name="email"]').required).toBe(false);
        expect(document.querySelector('[name="username"]').required).toBe(true);
        expect(document.querySelector('[name="temporaryPassword"]').required).toBe(true);
        expect(document.querySelector('[name="sendInvitation"]')).toBeNull();
    });

    test('mail members without verification need email and a configured password, not an invitation', () => {
        showModal.mockImplementationOnce((_title, body, options) => {
            document.body.insertAdjacentHTML('beforeend', body + options.footer);
        });
        AdminCenter.state = state();
        AdminCenter.state.loginPolicy = { mode: 'all', enabled: true, emailVerificationRequired: false };
        AdminCenter.open_member();
        expect(document.querySelector('[name="email"]').required).toBe(true);
        expect(document.querySelector('[name="temporaryPassword"]').required).toBe(true);
        expect(document.querySelector('[name="sendInvitation"]')).toBeNull();
    });

    test('business preparation can be deferred without opening an SMTP form', async () => {
        showModal.mockImplementationOnce((_title, body, options) => {
            document.body.insertAdjacentHTML('beforeend', body + options.footer);
        });
        AdminCenter.state = state();
        Onboarding.target = document.getElementById('pageContent');
        Onboarding.open('business');
        expect(document.querySelector('#onboardingMailLater')).not.toBeNull();
        document.querySelector('#onboardingMailLater').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(window.Workspace.api.adminUpdate).toHaveBeenCalledWith(expect.objectContaining({
            resource: 'onboarding', value: expect.objectContaining({ businessPrepared: true })
        }));
    });

});
