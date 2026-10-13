import { escapeHtml } from './utils.js';

let passwordLinkHandler;

export async function authRequest(action, body) {
    const response = await fetch(`/api/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) {
        const fallback =
            action === 'set-password'
                ? '链接可能已失效，或密码未满足要求。请使用 12 至 128 位新密码，必要时重新申请邮件。'
                : '请求失败，请稍后重试或联系企业管理员。';
        throw new Error(result.code === 'BACKEND_REQUEST_FAILED' ? fallback : result.error || fallback);
    }
    return result;
}

export function passwordSetupOpen() {
    const panel = document.getElementById('enterpriseAuthPanel');
    return panel?.dataset.mode === 'set-password' && !panel.hidden;
}

export function mountEnterpriseLogin({ onPasswordSetup = () => {} } = {}) {
    const login = document.getElementById('loginForm');
    if (!login) return;
    const email = document.getElementById('loginUsername');
    if (!email || !document.getElementById('loginPassword')) return;
    email.type = 'email';
    email.placeholder = 'name@company.com';
    email.autocomplete = 'username';
    document.querySelector('label[for="loginUsername"]').textContent = '企业邮箱';
    document.getElementById('loginPassword').autocomplete = 'current-password';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary login-btn';
    button.textContent = '忘记密码';
    button.id = 'forgotPassword';
    login.after(button);
    const panel = document.createElement('div');
    panel.id = 'enterpriseAuthPanel';
    panel.hidden = true;
    button.after(panel);

    let setupRequired = false;
    let demoMode = false;
    let passwordRecoveryAvailable = true;
    function show(mode, key = '') {
        login.hidden = true;
        button.hidden = true;
        panel.hidden = false;
        const reset = mode === 'set-password';
        panel.dataset.mode = mode;
        if (reset) {
            const loginPage = document.getElementById('loginPage');
            const app = document.getElementById('app');
            if (loginPage) loginPage.style.display = 'flex';
            if (app) app.style.display = 'none';
            onPasswordSetup();
        }
        panel.innerHTML = `<h2>${reset ? '激活账号 / 设置新密码' : '找回密码'}</h2>
            <p>${reset ? '验证邮箱并设置本人密码后，即可进入企业工作台。' : '请输入获企业管理员邀请的邮箱。'}</p>
            <form id="enterpriseAuthForm">
            ${reset ? '<label class="form-label" for="newPassword">新密码（12 至 128 位）</label><input class="form-input" id="newPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password"><label class="form-label" for="confirmPassword">确认新密码</label><input class="form-input" id="confirmPassword" type="password" required autocomplete="new-password">' : `<label class="form-label" for="resetEmail">企业邮箱</label><input class="form-input" id="resetEmail" type="email" required autocomplete="email" value="${escapeHtml(email.value)}">`}
            <p id="authFeedback" role="status" aria-live="polite"></p>
            <button class="btn btn-primary login-btn" type="submit">${reset ? '设置密码' : '发送重置邮件'}</button>
            </form><button class="btn btn-secondary login-btn" id="backToLogin" type="button">返回登录</button>`;
        document.getElementById('backToLogin').onclick = () => {
            panel.replaceChildren();
            panel.hidden = true;
            delete panel.dataset.mode;
            login.hidden = false;
            button.hidden = setupRequired || demoMode || !passwordRecoveryAvailable;
        };
        document.getElementById('enterpriseAuthForm').onsubmit = async event => {
            event.preventDefault();
            const feedback = document.getElementById('authFeedback');
            const submit = event.currentTarget.querySelector('[type="submit"]');
            if (
                reset &&
                document.getElementById('newPassword').value !== document.getElementById('confirmPassword').value
            ) {
                feedback.textContent = '两次输入的密码不一致。';
                return;
            }
            submit.disabled = true;
            try {
                const result = await authRequest(
                    mode,
                    reset
                        ? { key, password: document.getElementById('newPassword').value }
                        : { email: document.getElementById('resetEmail').value.trim().toLowerCase() }
                );
                feedback.textContent = result.message;
                if (reset) {
                    key = '';
                    document.getElementById('newPassword').value = '';
                    document.getElementById('confirmPassword').value = '';
                    submit.hidden = true;
                    await loadConfig();
                }
            } catch (error) {
                feedback.textContent = error.message;
            } finally {
                submit.disabled = false;
            }
        };
    }
    button.onclick = () => show('forgot-password');
    function consumePasswordLink(event) {
        if (!location.hash.startsWith('#set-password=')) return;
        // This also handles a link opened in the same already signed-in tab.
        event?.stopImmediatePropagation();
        const key = location.hash.slice('#set-password='.length);
        window.history.replaceState(null, '', location.pathname + location.search);
        show('set-password', key);
    }
    if (passwordLinkHandler) window.removeEventListener('hashchange', passwordLinkHandler, { capture: true });
    passwordLinkHandler = consumePasswordLink;
    window.addEventListener('hashchange', passwordLinkHandler, { capture: true });
    consumePasswordLink();
    function loadConfig() {
        return fetch('/api/login-config', { credentials: 'same-origin' })
            .then(async response => {
                if (!response.ok) throw new Error((await response.json()).error);
                const config = await response.json();
                setupRequired = config.setupRequired === true;
                demoMode = config.demoMode === true;
                passwordRecoveryAvailable = config.passwordRecoveryAvailable !== false;
                login.dataset.demoMode = String(demoMode);
                document.getElementById('demoTenantField')?.remove();
                if (demoMode) {
                    if (!Array.isArray(config.demoTenants) || !config.demoTenants.length)
                        throw new Error('演示企业入口尚未配置');
                    const field = document.createElement('label');
                    field.id = 'demoTenantField';
                    field.className = 'form-group';
                    field.innerHTML =
                        '<span class="form-label">演示企业</span><select class="form-select" id="loginTenant" required><option value="" disabled selected>请选择演示企业</option></select><small>演示环境 · 使用已有账号登录</small>';
                    const select = field.querySelector('select');
                    for (const tenant of config.demoTenants) {
                        const option = document.createElement('option');
                        option.value = tenant;
                        option.textContent = tenant;
                        select.append(option);
                    }
                    login.prepend(field);
                }
                const accountLogin = config.mode === 'accounts' || config.emailOnly === false;
                email.type = setupRequired || demoMode || accountLogin ? 'text' : 'email';
                email.placeholder = demoMode
                    ? '已有演示账号'
                    : setupRequired
                      ? '部署时设置的管理员账号'
                      : accountLogin
                        ? (config.mode === 'accounts' ? '管理员配置的登录账号' : '账号或邮箱')
                        : 'name@company.com';
                document.querySelector('label[for="loginUsername"]').textContent = demoMode
                    ? '账号'
                    : setupRequired
                      ? '初始管理员账号'
                      : accountLogin
                        ? (config.mode === 'accounts' ? '账号' : '账号或邮箱')
                        : '企业邮箱';
                button.hidden = setupRequired || demoMode || !passwordRecoveryAvailable || !panel.hidden;
            })
            .catch(error => {
                const box = document.getElementById('loginError');
                box.textContent = error.message || '企业登录服务不可用，请联系管理员。';
                box.style.display = 'block';
            });
    }
    loadConfig();
}
