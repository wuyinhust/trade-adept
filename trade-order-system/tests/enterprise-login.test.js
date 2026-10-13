import { jest } from '@jest/globals';
import { mountEnterpriseLogin, passwordSetupOpen } from '../js/enterprise-login.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    document.body.innerHTML =
        '<form id="loginForm"><label for="loginUsername">账号</label><input id="loginUsername"><input id="loginPassword"><p id="loginError"></p></form>';
    history.replaceState(null, '', '/');
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true, message: '邮件已处理' }) }));
});

test('email-only login and reset form use server auth without tenant selection', async () => {
    mountEnterpriseLogin();
    expect(document.getElementById('loginUsername').type).toBe('email');
    expect(document.getElementById('loginTenant')).toBeNull();
    document.getElementById('forgotPassword').click();
    document.getElementById('resetEmail').value = 'A@Company.com';
    document.getElementById('enterpriseAuthForm').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(fetch.mock.calls[1][0]).toBe('/api/forgot-password');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ email: 'a@company.com' });
    expect(document.getElementById('authFeedback').textContent).toBe('邮件已处理');
});

test('activation token is removed from address bar; mismatched passwords do not submit', async () => {
    history.replaceState(null, '', '/#set-password=one-time-secret-key');
    mountEnterpriseLogin();
    expect(location.hash).toBe('');
    document.getElementById('newPassword').value = 'a sufficiently long password';
    document.getElementById('confirmPassword').value = 'different';
    document.getElementById('enterpriseAuthForm').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(fetch).toHaveBeenCalledTimes(1);
    document.getElementById('confirmPassword').value = 'a sufficiently long password';
    document.getElementById('enterpriseAuthForm').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(JSON.parse(fetch.mock.calls[1][1].body).key).toBe('one-time-secret-key');
    expect(document.getElementById('newPassword').value).toBe('');
    expect(document.querySelector('#enterpriseAuthForm [type="submit"]').hidden).toBe(true);
});

test('initial configuration uses administrator account and hides email recovery', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ setupRequired: true, emailOnly: false }) });
    mountEnterpriseLogin();
    await tick();
    expect(document.getElementById('loginUsername').type).toBe('text');
    expect(document.querySelector('label[for="loginUsername"]').textContent).toBe('初始管理员账号');
    expect(document.getElementById('forgotPassword').hidden).toBe(true);
});

test('same-tab password link interrupts the signed-in router and stays visible', async () => {
    document.body.innerHTML = `<div id="loginPage" style="display:none">${document.body.innerHTML}</div><div id="app" style="display:flex"></div>`;
    const stopBackgroundWork = jest.fn();
    mountEnterpriseLogin({ onPasswordSetup: stopBackgroundWork });
    const router = jest.fn();
    window.addEventListener('hashchange', router);
    history.replaceState(null, '', '/#set-password=another-single-use-token');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(router).not.toHaveBeenCalled();
    expect(stopBackgroundWork).toHaveBeenCalledTimes(1);
    expect(passwordSetupOpen()).toBe(true);
    expect(document.getElementById('loginPage').style.display).toBe('flex');
    expect(document.getElementById('app').style.display).toBe('none');
    expect(location.hash).toBe('');
    document.getElementById('backToLogin').click();
    expect(passwordSetupOpen()).toBe(false);
    window.removeEventListener('hashchange', router);
    await tick();
});

test('explicit demo configuration requires a tenant choice and keeps username login', async () => {
    fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ demoMode: true, demoTenants: ['grandware', 'example-company'] })
    });
    mountEnterpriseLogin();
    await tick();
    const select = document.getElementById('loginTenant');
    expect(select.value).toBe('');
    expect(select.required).toBe(true);
    expect([...select.options].map(option => option.value)).toEqual(['', 'grandware', 'example-company']);
    expect(document.getElementById('loginUsername').type).toBe('text');
    expect(document.getElementById('forgotPassword').hidden).toBe(true);
});
