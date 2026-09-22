'use strict';
const DEFAULT_WEBSITE_ORIGIN = 'https://vslink.dev';
const DEFAULT_RELAY_URL = 'wss://vscode-relay.tahiraziztaran.workers.dev/extension';

function parseEndpoint(raw, label) {
    if (typeof raw !== 'string' || !raw || raw !== raw.trim()) {
        throw new Error(`${label} is missing or invalid. Pair again from the VSLink website.`);
    }
    let url;
    try { url = new URL(raw); }
    catch (cause) { throw new Error(`${label} is not a valid URL. Pair again.`, { cause }); }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error(`${label} must not contain credentials, query parameters, or a fragment.`);
    }
    return url;
}
function validateBackendOrigin(raw) {
    const url = parseEndpoint(raw, 'Pairing website');
    if (url.pathname !== '/') throw new Error('Pairing website must be an origin without a path.');
    if (url.origin !== DEFAULT_WEBSITE_ORIGIN &&
        !(['http:', 'https:'].includes(url.protocol) && isLoopback(url.hostname))) {
        throw new Error('Pairing website must be https://vslink.dev or a localhost origin.');
    }
    return url.origin;
}
function validateRelayUrl(raw) {
    const url = parseEndpoint(raw, 'Relay address');
    const official = url.toString() === DEFAULT_RELAY_URL;
    const local = ['ws:', 'wss:'].includes(url.protocol) && isLoopback(url.hostname) && url.pathname === '/extension';
    if (!official && !local) throw new Error('Relay must be the official WSS endpoint or a localhost /extension WebSocket endpoint.');
    return url.toString();
}
function resolvePairingTargets(query) {
    const parameters = new URLSearchParams(query);
    for (const key of ['code', 'backend', 'server']) {
        if (parameters.getAll(key).length !== 1) throw new Error(`Pairing link requires exactly one ${key} parameter. Pair again.`);
    }
    const backendOrigin = validateBackendOrigin(parameters.get('backend'));
    const backend = new URL(backendOrigin);
    // Local pairing deliberately uses the same local server for both protocols.
    // Invalid advertised addresses still fail; they never select production.
    const advertised = parseEndpoint(parameters.get('server'), 'Pairing relay');
    if (advertised.protocol === 'https:') advertised.protocol = 'wss:';
    else if (advertised.protocol === 'http:') advertised.protocol = 'ws:';
    if (advertised.pathname === '/') advertised.pathname = '/extension';
    const remoteRelay = validateRelayUrl(advertised.toString());
    let relayUrl = remoteRelay;
    if (isLoopback(backend.hostname)) {
        const local = new URL('/extension', backendOrigin);
        local.protocol = backend.protocol === 'https:' ? 'wss:' : 'ws:';
        relayUrl = local.toString();
    } else if (remoteRelay !== DEFAULT_RELAY_URL) {
        throw new Error('Production pairing requires the official relay, not a localhost relay.');
    }
    return { backendOrigin, exchangeUrl: new URL('/api/link/exchange', backendOrigin).toString(), relayUrl };
}
function validateSavedPairing(backendOrigin, relayUrl) {
    const backend = validateBackendOrigin(backendOrigin);
    const relay = validateRelayUrl(relayUrl);
    const expected = resolvePairingTargets(new URLSearchParams({ code: 'saved', backend, server: relay }).toString());
    if (expected.relayUrl !== relay) throw new Error('Saved website and relay do not match. Unpair this editor and pair again.');
    return expected;
}
function pairingPageUrl(origin = DEFAULT_WEBSITE_ORIGIN) {
    return new URL('/link', validateBackendOrigin(origin)).toString();
}
function isLoopback(hostname) {
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
module.exports = { DEFAULT_WEBSITE_ORIGIN, DEFAULT_RELAY_URL, resolvePairingTargets, validateBackendOrigin, validateRelayUrl, validateSavedPairing, pairingPageUrl };
