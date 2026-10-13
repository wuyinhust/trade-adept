import { ContactMerge, proposeContactMerge, resolveContactMerge } from '../js/contact-merge.js';

const contact = overrides => ({
    id: 'CONT-1',
    name: 'Fictional Alex',
    phone: '+001 (020) 003-004 ext. 05',
    email: 'fictional@example.invalid',
    ...overrides
});
const choose = (plan, side, index = 0) => resolveContactMerge(plan, { [plan.conflicts[index].id]: side });
const freeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

test('unchanged contacts preserve their values and use String-compatible stable IDs', () => {
    const base = [contact({ id: 7 })];
    const plan = proposeContactMerge(base, [contact({ id: '7' })], [contact({ id: 7 })]);
    expect(plan.canSubmit).toBe(true);
    expect(plan.result).toEqual(base);
    expect(plan.result[0]).not.toBe(base[0]);
    expect(ContactMerge.propose).toBe(proposeContactMerge);
    expect(ContactMerge.resolve).toBe(resolveContactMerge);
});

test('independent additions and distinct field edits merge while preserving same-name distinct IDs', () => {
    const base = [contact()];
    const local = [contact({ phone: '0000123' }), contact({ id: 'CONT-LOCAL', name: 'Fictional Alex' })];
    const server = [
        contact({ email: 'changed@example.invalid' }),
        contact({ id: 'CONT-SERVER', name: 'Fictional Alex' })
    ];
    const plan = proposeContactMerge(base, local, server);
    expect(plan.canSubmit).toBe(true);
    expect(plan.result.map(row => row.id)).toEqual(['CONT-1', 'CONT-SERVER', 'CONT-LOCAL']);
    expect(plan.result[0]).toMatchObject({ phone: '0000123', email: 'changed@example.invalid' });
});

test('the same concurrent edit is accepted without a false conflict', () => {
    const changed = contact({ phone: ' 001-02 ext. 3 ' });
    const plan = proposeContactMerge([contact()], [changed], [changed]);
    expect(plan.canSubmit).toBe(true);
    expect(plan.result[0].phone).toBe(' 001-02 ext. 3 ');
});

test('different edits to the same field require an explicit choice and retain independent edits', () => {
    const plan = proposeContactMerge(
        [contact()],
        [contact({ phone: '0001', position: 'Sales' })],
        [contact({ phone: '+002', email: 'new@example.invalid' })]
    );
    expect(plan.canSubmit).toBe(false);
    expect(plan.result).toBeNull();
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
        kind: 'field-conflict',
        path: ['phone'],
        local: { present: true, value: '0001' },
        server: { present: true, value: '+002' }
    });
    expect(choose(plan, 'local').result[0]).toMatchObject({
        phone: '0001',
        position: 'Sales',
        email: 'new@example.invalid'
    });
    expect(choose(plan, 'server').result[0].phone).toBe('+002');
    expect(plan.result).toBeNull();
});

test('partial resolution and invalid or unknown choices never produce a submittable result', () => {
    const plan = proposeContactMerge(
        [contact()],
        [contact({ phone: 'local', email: 'local@example.invalid' })],
        [contact({ phone: 'server', email: 'server@example.invalid' })]
    );
    const partial = choose(plan, 'local');
    expect(partial.result).toBeNull();
    expect(partial.conflicts).toHaveLength(1);
    expect(partial.resolvedConflicts).toHaveLength(1);
    const complete = choose(partial, 'server');
    expect(complete.canSubmit).toBe(true);
    expect(complete.conflicts).toEqual([]);
    expect(complete.resolvedConflicts).toHaveLength(2);
    expect(complete.result[0]).toMatchObject({ phone: 'local', email: 'server@example.invalid' });
    expect(choose(plan, 'keep-both').result).toBeNull();
    expect(resolveContactMerge(plan, { unrelated: 'local' }).issues[0].code).toBe('UNKNOWN_CONFLICT');
    expect(resolveContactMerge(plan, { unrelated: 'local' }).result).toBeNull();
});

test.each([
    [[], [contact()]],
    [[contact()], []],
    [[], []],
    [[contact({ deleted: true })], [contact()]]
])('deletion versus unchanged contacts is final without reviving the old row (%j, %j)', (local, server) => {
    const plan = proposeContactMerge([contact()], local, server);
    expect(plan.canSubmit).toBe(true);
    expect(plan.result).toEqual([]);
});

test.each(['local', 'server'])(
    'delete-vs-edit is omitted until an explicit choice; deleted side is %s',
    deletedSide => {
        const edited = contact({ phone: 'new 0009', customNote: 'Preserve me' });
        const plan = proposeContactMerge(
            [contact()],
            deletedSide === 'local' ? [] : [edited],
            deletedSide === 'server' ? [] : [edited]
        );
        expect(plan.result).toBeNull();
        expect(plan.proposal).toEqual([]);
        expect(plan.conflicts[0].kind).toBe('delete-vs-edit');
        expect(plan.conflicts[0].base).toEqual({ present: true, value: contact() });
        expect(plan.conflicts[0][deletedSide]).toEqual({ present: false });
        expect(choose(plan, deletedSide).result).toEqual([]);
        expect(choose(plan, deletedSide === 'local' ? 'server' : 'local').result).toEqual([edited]);
    }
);

test('same-ID concurrent additions with different content cannot be blended or guessed', () => {
    const local = contact({ id: 'CONT-NEW', phone: 'local' });
    const server = contact({ id: 'CONT-NEW', email: 'server@example.invalid' });
    const plan = proposeContactMerge([], [local], [server]);
    expect(plan.result).toBeNull();
    expect(plan.proposal).toEqual([]);
    expect(plan.conflicts[0].kind).toBe('concurrent-add');
    expect(choose(plan, 'local').result).toEqual([local]);
    expect(choose(plan, 'server').result).toEqual([server]);
});

test('identical same-ID additions are accepted even with numeric/text ID types', () => {
    const plan = proposeContactMerge([], [contact({ id: 9 })], [contact({ id: '9' })]);
    expect(plan.canSubmit).toBe(true);
    expect(plan.result).toEqual([contact({ id: '9' })]);
});

test.each([undefined, null, '', ' ', 'unsafe id', "'quoted'", true, [], {}, 1.2, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'invalid or absent IDs require manual review: %j',
    id => {
        const row = contact({ id });
        if (id === undefined) delete row.id;
        const plan = proposeContactMerge([row], [row], [row]);
        expect(plan.canSubmit).toBe(false);
        expect(plan.result).toBeNull();
        expect(plan.issues.some(issue => ['INVALID_CONTACT_ID', 'INVALID_CONTACT_DATA'].includes(issue.code))).toBe(
            true
        );
        expect(plan.proposal).toEqual([]);
    }
);

test('duplicate String-equivalent IDs require manual review, including tombstones', () => {
    const plan = proposeContactMerge([], [contact({ id: 1 }), contact({ id: '1', deleted: true })], []);
    expect(plan.result).toBeNull();
    expect(plan.issues).toContainEqual(
        expect.objectContaining({ code: 'DUPLICATE_CONTACT_ID', side: 'local', contactId: '1' })
    );
});

test('a missing ID cannot be guessed from an otherwise identical name or assigned by the merger', () => {
    const { id: ignored, ...withoutId } = contact();
    const plan = proposeContactMerge([withoutId], [contact()], [contact()]);
    expect(plan.result).toBeNull();
    expect(plan.issues[0]).toMatchObject({ code: 'INVALID_CONTACT_ID', side: 'base' });
    expect(withoutId).not.toHaveProperty('id');
});

test('nested unknown extension fields merge independently; missing fields remain distinct from empty text', () => {
    const base = contact({
        extension: { locale: 'en', preferences: { channel: 'email', tags: ['a'] } },
        homeAddress: ''
    });
    const local = contact({ extension: { locale: 'zh', preferences: { channel: 'email', tags: ['a'] } } });
    const server = contact({
        extension: { locale: 'en', preferences: { channel: 'phone', tags: ['a'] } },
        homeAddress: ''
    });
    const plan = proposeContactMerge([base], [local], [server]);
    expect(plan.canSubmit).toBe(true);
    expect(plan.result[0].extension).toEqual({ locale: 'zh', preferences: { channel: 'phone', tags: ['a'] } });
    expect(plan.result[0]).not.toHaveProperty('homeAddress');
    expect(plan.result[0].phone).toBe('+001 (020) 003-004 ext. 05');
});

test('nested field deletion versus editing and arrays require explicit field choices', () => {
    const base = contact({ extension: { address: 'old', tags: ['a'] } });
    const local = contact({ extension: { tags: ['local'] } });
    const server = contact({ extension: { address: 'server', tags: ['server'] } });
    const plan = proposeContactMerge([base], [local], [server]);
    expect(plan.result).toBeNull();
    expect(plan.conflicts.map(item => item.path)).toEqual([
        ['extension', 'address'],
        ['extension', 'tags']
    ]);
    expect(plan.conflicts[0].local).toEqual({ present: false });
    const resolved = resolveContactMerge(plan, Object.fromEntries(plan.conflicts.map(item => [item.id, 'local'])));
    expect(resolved.result[0].extension).toEqual({ tags: ['local'] });
});

test('old tombstones cannot be revived by replaying active snapshots', () => {
    const plan = proposeContactMerge([contact({ deleted: true })], [contact()], []);
    expect(plan.result).toBeNull();
    expect(plan.issues[0].code).toBe('DELETED_CONTACT_REAPPEARED');
    expect(resolveContactMerge(plan).result).toBeNull();
});

test('an explicit tombstone colliding with a new contact cannot silently resurrect it', () => {
    const plan = proposeContactMerge([], [contact({ deleted: true })], [contact({ phone: 'server new' })]);
    expect(plan.result).toBeNull();
    expect(plan.proposal).toEqual([]);
    expect(plan.conflicts[0].kind).toBe('delete-vs-edit');
    expect(choose(plan, 'local').result).toEqual([]);
});

test('the plan, inputs and unknown fields are independent copies, including safely owned special keys', () => {
    const extension = JSON.parse('{"__proto__":{"unchanged":"raw"},"constructor":{"kind":"raw"}}');
    const base = freeze([contact({ extension })]);
    const local = freeze([contact({ extension, phone: '0000007' })]);
    const server = freeze([contact({ extension, email: 'server@example.invalid' })]);
    const plan = proposeContactMerge(base, local, server);
    expect(plan.canSubmit).toBe(true);
    expect(plan.result[0].extension).toEqual(extension);
    expect(Object.getPrototypeOf(plan.result[0].extension)).toBe(Object.prototype);
    expect({}.unchanged).toBeUndefined();
    plan.proposal[0].extension.constructor.kind = 'preview only';
    plan.result[0].extension.constructor.kind = 'result only';
    expect(base[0].extension.constructor.kind).toBe('raw');
    expect(resolveContactMerge(plan).result[0].extension.constructor.kind).toBe('raw');
});

test('a JSON-roundtripped plan remains resolvable with stable conflict IDs', () => {
    const plan = proposeContactMerge([contact()], [contact({ phone: 'local' })], [contact({ phone: 'server' })]);
    const roundtrip = JSON.parse(JSON.stringify(plan));
    expect(choose(roundtrip, 'server').result[0].phone).toBe('server');
});

test('malformed lists, rows and cyclic values fail safely instead of producing a commit result', () => {
    expect(proposeContactMerge(undefined, [], []).issues[0].code).toBe('INVALID_CONTACT_LIST');
    expect(proposeContactMerge([], [null], []).issues[0].code).toBe('INVALID_CONTACT');
    expect(proposeContactMerge([], new Array(1), []).issues[0].code).toBe('INVALID_CONTACT');
    const cyclic = contact();
    cyclic.extension = cyclic;
    expect(proposeContactMerge([], [cyclic], []).result).toBeNull();
    expect(proposeContactMerge([], [cyclic], []).issues[0].code).toBe('INVALID_CONTACT_DATA');
    expect(resolveContactMerge({}).issues[0].code).toBe('INVALID_MERGE_PLAN');
});
