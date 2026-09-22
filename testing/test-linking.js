'use strict';
const assert = require('node:assert/strict');
const { DEFAULT_RELAY_URL, resolvePairingTargets, validateRelayUrl, validateSavedPairing, pairingPageUrl } = require('../src/linking');
const query = (backend, server = DEFAULT_RELAY_URL) => new URLSearchParams({ code: 'ABC123', backend, server }).toString();
assert.equal(pairingPageUrl(), 'https://vslink.dev/link', 'first-time website is a deliberate product default');
assert.equal(resolvePairingTargets(query('https://vslink.dev')).relayUrl, DEFAULT_RELAY_URL);
for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(resolvePairingTargets(query(`http://${host}:8080`)).relayUrl, `ws://${host}:8080/extension`);
    assert.equal(resolvePairingTargets(query(`https://${host}:8443`)).relayUrl, `wss://${host}:8443/extension`);
}
for (const invalid of ['', 'not-url', 'http://vslink.dev', 'https://vslink.dev:444', 'https://evil.example', 'https://vslink.dev/path', 'https://user:pass@vslink.dev', 'https://vslink.dev/?token=secret']) {
    assert.throws(() => resolvePairingTargets(query(invalid)));
    assert.throws(() => pairingPageUrl(invalid));
}
for (const invalid of [undefined, '', 'wss://evil.example/extension', 'ws://vscode-relay.tahiraziztaran.workers.dev/extension', 'ws://localhost:8080/extension?token=secret', 'ws://localhost:8080/wrong', 'wss://user:password@localhost:8080/extension']) assert.throws(() => validateRelayUrl(invalid));
assert.throws(() => resolvePairingTargets(query('http://localhost:8080', 'bad')), /valid URL/);
assert.throws(() => resolvePairingTargets('code=ABC123'), /exactly one backend/);
assert.throws(() => resolvePairingTargets(query('http://localhost:8080') + '&backend=https://vslink.dev'), /exactly one backend/);
assert.throws(() => resolvePairingTargets(query('https://vslink.dev', 'ws://localhost:8080/extension')), /Production/);
assert.throws(() => validateSavedPairing('http://localhost:8080', 'ws://localhost:9000/extension'), /do not match/);
assert.throws(() => validateSavedPairing('https://vslink.dev', undefined), /missing/);
assert.equal(validateSavedPairing('http://localhost:8080', 'ws://localhost:8080/extension').exchangeUrl, 'http://localhost:8080/api/link/exchange');
console.log('PASS pairing: explicit origins, loopback mapping, malicious URLs, duplicate/missing configuration, no production substitution');
