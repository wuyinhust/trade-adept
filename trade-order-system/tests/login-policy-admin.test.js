import { jest } from '@jest/globals';
import { editPolicy } from '../js/login-policy-admin.js';

test('initial settings save separately from sending administrator proof', async () => {
    const center = { state: { loginPolicy: { setupRequired: true } }, save: jest.fn() };
    let submit;
    editPolicy(center, (_title, html, callback) => {
        document.body.innerHTML = `<form>${html}</form>`;
        submit = callback;
    });
    const form = document.querySelector('form');
    form.elements.administratorEmail.value = 'owner@company.com';
    form.elements.publicOrigin.value = 'https://trade.company.com';
    form.elements.domains.value = 'company.com\nsecond.com';
    await submit(form);
    expect(center.save).toHaveBeenLastCalledWith('login-policy', {
        administratorEmail: 'owner@company.com', sendVerification: false,
        publicOrigin: 'https://trade.company.com', mode: 'domains',
        domains: ['company.com', 'second.com'], addresses: []
    });
    form.elements.sendVerification.checked = true;
    await submit(form);
    expect(center.save.mock.lastCall[1].sendVerification).toBe(true);
});

test('active policy editing does not expose the initial-admin binding flow', () => {
    editPolicy({ state: { loginPolicy: { enabled: true } } }, (_title, html) => {
        document.body.innerHTML = `<form>${html}</form>`;
    });
    expect(document.querySelector('[name="administratorEmail"]')).toBeNull();
    expect(document.querySelector('[name="sendVerification"]')).toBeNull();
});
