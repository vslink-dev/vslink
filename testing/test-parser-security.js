'use strict';
const assert = require('node:assert/strict');
const { reconstructJsonl, parseSessionContent } = require('../src/sessionParser');
const log = (...entries) => entries.map(entry => JSON.stringify(entry)).join('\n');
const initial = { kind: 0, v: { requests: [], nested: { values: [1, 2, 3], text: 'old' } } };
for (const segment of ['__proto__', 'constructor', 'prototype']) {
    for (const kind of [1, 2, 3]) {
        assert.throws(() => reconstructJsonl(log(initial, { kind, k: [segment, 'polluted'], v: true })), /Unsafe/);
        assert.throws(() => reconstructJsonl(log(initial, { kind, k: ['nested', segment], v: true })), /Unsafe/);
    }
}
assert.equal({}.polluted, undefined);
assert.throws(() => reconstructJsonl(log(initial, { kind: 1, k: [{ toString: 'x' }], v: true })), /Unsafe/);
assert.throws(() => reconstructJsonl(log(initial, { kind: 1, k: ['missing', 'child'], v: true })), /missing parent/);
assert.throws(() => reconstructJsonl(log(initial, { kind: 2, k: ['nested', 'values'], i: 900000000 })), /out of range/);
assert.throws(() => reconstructJsonl(log(initial, { kind: 2, k: ['nested', 'text'], v: ['new'] })), /not an array/);
assert.throws(() => reconstructJsonl(log(initial, { kind: 2, k: ['requests'], v: 'not-array' })), /must be an array/);
assert.throws(() => reconstructJsonl(log(initial, { kind: 9, k: ['requests'] })), /Unsupported/);
assert.throws(() => reconstructJsonl(log({ kind: 1, k: ['requests'], v: [] })), /initial/);
assert.throws(() => reconstructJsonl(log(initial, { kind: 1, k: [], v: {} })), /Invalid/);
assert.deepEqual(reconstructJsonl(log(initial, { kind: 2, k: ['nested', 'values'], i: 1 })).nested.values, [1]);
assert.deepEqual(reconstructJsonl(log(initial, { kind: 2, k: ['nested', 'values'], i: 1, v: [4] })).nested.values, [1, 4]);
assert.deepEqual(reconstructJsonl(log(initial, { kind: 2, k: ['newArray'], v: [4] })).newArray, [4]);
assert.equal(Object.hasOwn(reconstructJsonl(log(initial, { kind: 3, k: ['nested', 'text'] })).nested, 'text'), false);
assert.deepEqual(reconstructJsonl(log(initial, { kind: 0, v: { requests: [] } })), { requests: [] }, 'initial replaces, not merges');
const request = { requestId: 'request', timestamp: 123, message: { text: 'Visible prompt \\n code' }, result: {}, response: [
    { value: 'Visible ' }, { value: 'answer' }, { value: 'answer' },
    { kind: 'thinking', value: 'PRIVATE_THINKING' },
    { kind: 'toolInvocationSerialized', value: { text: 'PRIVATE_TOOL' } },
    { kind: 'markdownVuln', value: 'PRIVATE_UNKNOWN_KIND' }
] };
for (const format of ['.json', '.jsonl']) {
    const data = { requests: [request, { ...request, hiddenFromTranscript: true, message: { text: 'PRIVATE_HIDDEN' } }, { ...request, requestHiddenFromTranscript: true, message: { text: 'PRIVATE_PROMPT' } }] };
    const session = parseSessionContent(format === '.json' ? JSON.stringify(data) : log({ kind: 0, v: data }), format, 'fixture');
    assert.equal(session.messages.length, 3);
    assert.equal(session.messages[0].text, 'Visible prompt \\n code', 'literal backslash sequences stay intact');
    assert.equal(session.messages[1].text, 'Visible answeranswer', 'repeated answer text is not deduplicated');
    assert.equal(session.createdAt, undefined, 'missing optional timestamps are not invented');
    assert.doesNotMatch(JSON.stringify(session), /PRIVATE_/);
}
const parse = requests => parseSessionContent(JSON.stringify({ requests }), '.json', 'fixture');
assert.equal(parse(Array.from({ length: 205 }, () => request)).messageCount, 410, 'no last-200 truncation');
assert.throws(() => parse([{ ...request, message: { text: 'x'.repeat(100001) } }]), /100,000/);
assert.throws(() => parse([{ ...request, response: [{ value: 'x'.repeat(100001) }] }]), /100,000/);
assert.throws(() => parse([{ ...request, modelId: 123, result: { metadata: { resolvedModel: 'good' } } }]), /model ID/);
assert.throws(() => parse([{ ...request, timestamp: 'invalid' }]), /timestamp/);
assert.throws(() => parse([null]), /Invalid Copilot request/);
assert.throws(() => parseSessionContent('{"requests":[]}', '.unknown', 'fixture'), /Unsupported/);
assert.equal(parse([{ ...request, result: { errorDetails: { message: 'error' } } }]).messages[1].status, 'error');
assert.equal(parse([{ ...request, isCanceled: true }]).messages[1].status, 'canceled');
assert.equal(parse([{ ...request, isCanceled: true, response: [] }]).status, 'canceled');
assert.equal(parse([{ ...request, result: { errorDetails: { message: 'error' } }, response: [] }]).status, 'error');
console.log('PASS parser: prototype paths, operation validation, deletion/truncation semantics, hidden content, literal text, full history and explicit limits');
