import { jest } from '@jest/globals';
import { editPolicy, policyPanel } from '../js/login-policy-admin.js';

const mount = policy => {
    const center = { state: { loginPolicy: policy }, save: jest.fn() };
    let submit;
    editPolicy(center, (_title, html, callback) => {
        document.body.innerHTML = `<form>${html}</form>`;
        submit = callback;
    });
    return { center, submit, form: document.querySelector('form') };
};

test('account setup works with no email or SMTP and explicitly skips email verification', async () => {
    const { center, submit, form } = mount({ setupRequired: true, smtpReady: false });
    expect(form.elements.mode.value).toBe('accounts');
    expect(form.elements.administratorEmail.required).toBe(false);
    expect(form.elements.publicOrigin.required).toBe(false);
    expect(form.elements.emailVerificationRequired.disabled).toBe(true);
    await submit(form);
    expect(center.save).toHaveBeenLastCalledWith('login-policy', {
        administratorEmail: '', sendVerification: false,
        publicOrigin: '', mode: 'accounts', emailVerificationRequired: false,
        domains: [], addresses: []
    });
});

test('arbitrary suffix and whitelisted mail modes work without SMTP and cannot send mail', async () => {
    const { center, submit, form } = mount({ setupRequired: true, smtpReady: false });
    for (const mode of ['all', 'domains', 'addresses']) {
        form.elements.mode.value = mode;
        form.elements.mode.dispatchEvent(new Event('change'));
        form.elements.administratorEmail.value = 'owner@company.com';
        form.elements.domains.value = 'company.com';
        form.elements.addresses.value = 'staff@company.com';
        expect(form.elements.sendVerification.disabled).toBe(true);
        await submit(form);
        expect(center.save.mock.lastCall[1]).toEqual(expect.objectContaining({
            mode, emailVerificationRequired: false, sendVerification: false
        }));
    }
});

test('SMTP-ready administrator may explicitly require verification and send proof', async () => {
    const { center, submit, form } = mount({ setupRequired: true, mode: 'domains', smtpReady: true });
    form.elements.administratorEmail.value = 'owner@company.com';
    form.elements.publicOrigin.value = 'https://trade.company.com';
    form.elements.domains.value = 'company.com\nsecond.com';
    form.elements.emailVerificationRequired.checked = true;
    form.elements.emailVerificationRequired.dispatchEvent(new Event('change'));
    expect(form.elements.administratorEmail.required).toBe(true);
    expect(form.elements.publicOrigin.required).toBe(true);
    expect(form.elements.sendVerification.disabled).toBe(false);
    form.elements.sendVerification.checked = true;
    await submit(form);
    expect(center.save.mock.lastCall[1]).toEqual(expect.objectContaining({
        mode: 'domains', emailVerificationRequired: true, sendVerification: true,
        domains: ['company.com', 'second.com']
    }));
    form.elements.mode.value = 'accounts';
    form.elements.mode.dispatchEvent(new Event('change'));
    expect(form.elements.emailVerificationRequired.checked).toBe(false);
    expect(form.elements.sendVerification.checked).toBe(false);
});

test('active policy editing excludes bootstrap binding and describes unverified account access', () => {
    const { form } = mount({ enabled: false, mode: 'accounts', emailVerificationRequired: false });
    expect(form.elements.namedItem('administratorEmail')).toBeNull();
    expect(form.elements.namedItem('sendVerification')).toBeNull();
    expect(policyPanel({ mode: 'accounts', emailVerificationRequired: false })).toContain('不要求邮箱');
    expect(policyPanel({ mode: 'accounts', emailVerificationRequired: false })).toContain('未要求邮件验证');
});
