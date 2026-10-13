import { escapeHtml } from './utils.js';

export function policyPanel(policy = {}) {
    return `<div class="admin-panel-heading"><div><h3>邮箱登录与邀请</h3><p>仅受邀且完成邮箱验证的成员可以登录。选择所有邮箱不会开放注册。</p></div><button class="btn btn-primary" data-admin-action="login_policy">编辑登录规则</button></div>
        <div class="card"><div class="card-body"><p>登录入口：${escapeHtml(policy.publicOrigin || '请在企业初始化时填写')}</p>
        ${policy.setupRequired ? '<p>初始化中：先保存域名和邮箱规则，再配置 SMTP，最后发送管理员验证邮件。验证成功后启用邮箱登录，初始账号随即停用。</p>' : ''}
        <p>准入模式：${escapeHtml({ domains: '企业邮箱域名白名单', addresses: '指定邮箱白名单', all: '所有邮箱（仍需邀请）' }[policy.mode] || '尚未启用')}</p>
        <p>${escapeHtml((policy[policy.mode] || []).join('、'))}</p>
        <p>新成员通过邮件设置本人密码。重发邀请会撤销该成员的现有会话，并要求重新设置密码。暂不开启二次验证。</p></div></div>`;
}

export function editPolicy(center, formModal) {
    const current = center.state.loginPolicy || {};
    const setup = current.setupRequired === true;
    formModal(
        '邮箱登录规则',
        `${setup ? `<label class="form-group"><span class="form-label">管理员真实邮箱</span><input class="form-input" type="email" name="administratorEmail" required value="${escapeHtml(current.administratorEmail || '')}"></label>` : ''}<label class="form-group"><span class="form-label">企业登录域名</span><input class="form-input" type="url" name="publicOrigin" required placeholder="https://trade.company.com" value="${escapeHtml(current.publicOrigin || '')}"></label>
        <label class="form-group"><span class="form-label">允许的邮箱范围</span><select class="form-select" name="mode">${[
            ['domains', '企业邮箱域名白名单'],
            ['addresses', '指定邮箱白名单'],
            ['all', '所有邮箱（仍需邀请）']
        ]
            .map(([key, label]) => `<option value="${key}" ${current.mode === key ? 'selected' : ''}>${label}</option>`)
            .join('')}</select></label>
        <label class="form-group"><span class="form-label">域名白名单（每行一个，例如 company.com）</span><textarea class="form-input" name="domains">${escapeHtml((current.domains || []).join('\n'))}</textarea></label>
        <label class="form-group"><span class="form-label">邮箱白名单（每行一个）</span><textarea class="form-input" name="addresses">${escapeHtml((current.addresses || []).join('\n'))}</textarea></label>
        ${setup ? '<label class="form-group"><input type="checkbox" name="sendVerification"> SMTP 已配置，保存并发送管理员验证邮件</label><p>可先保存规则，再配置 SMTP。修改规则后旧验证链接失效；勾选后可发送新链接。收到邮件并设置新密码后，才会切换为邮箱登录。</p>' : '<p>规则保存后立即生效，已登录成员也须符合新规则。当前管理员邮箱必须保留在允许范围内。</p>'}`,
        form => {
            const value = name => form.elements.namedItem(name).value.trim();
            const list = name =>
                value(name)
                    .split(/[\s,;，；]+/)
                    .filter(Boolean);
            return center.save('login-policy', {
                ...(setup
                    ? {
                          administratorEmail: value('administratorEmail'),
                          sendVerification: form.elements.namedItem('sendVerification').checked
                      }
                    : {}),
                publicOrigin: value('publicOrigin'),
                mode: value('mode'),
                domains: list('domains'),
                addresses: list('addresses')
            });
        }
    );
}
