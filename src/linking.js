"use strict";
exports.resolvePairingTargets = resolvePairingTargets;
exports.pairingPageUrl = pairingPageUrl;
exports.DEFAULT_WEBSITE_ORIGIN = 'https://vslink.dev';
exports.DEFAULT_RELAY_URL = 'wss://vscode-relay.tahiraziztaran.workers.dev/extension';
function resolvePairingTargets(query) {
    const parameters = new URLSearchParams(query);
    const backend = allowedBackend(parameters.get('backend'));
    const backendOrigin = backend.origin;
    // A localhost pairing code belongs to the local server, so its WebSocket
    // must connect to that same server instead of the production relay.
    const relayUrl = isLoopback(backend.hostname)
        ? websocketEndpoint(backend)
        : allowedRelay(parameters.get('server'));
    return {
        backendOrigin,
        exchangeUrl: new URL('/api/link/exchange', backendOrigin).toString(),
        relayUrl
    };
}
function pairingPageUrl(origin = exports.DEFAULT_WEBSITE_ORIGIN) {
    return new URL('/link', allowedBackend(origin).origin).toString();
}
function allowedBackend(raw) {
    const fallback = new URL(exports.DEFAULT_WEBSITE_ORIGIN);
    if (!raw)
        return fallback;
    try {
        const candidate = new URL(raw);
        candidate.username = '';
        candidate.password = '';
        candidate.pathname = '/';
        candidate.search = '';
        candidate.hash = '';
        if (candidate.protocol === 'https:' && candidate.hostname === fallback.hostname)
            return candidate;
        if ((candidate.protocol === 'http:' || candidate.protocol === 'https:') && isLoopback(candidate.hostname))
            return candidate;
    }
    catch {
        // Fall back to the official website below.
    }
    return fallback;
}
function allowedRelay(raw) {
    const fallback = new URL(exports.DEFAULT_RELAY_URL);
    if (!raw)
        return fallback.toString();
    try {
        const candidate = new URL(raw);
        const sourceProtocol = candidate.protocol;
        if (sourceProtocol === 'https:')
            candidate.protocol = 'wss:';
        if (sourceProtocol === 'http:')
            candidate.protocol = 'ws:';
        candidate.username = '';
        candidate.password = '';
        candidate.search = '';
        candidate.hash = '';
        const secureOfficialRelay = candidate.protocol === 'wss:' && candidate.hostname === fallback.hostname;
        const localRelay = (candidate.protocol === 'ws:' || candidate.protocol === 'wss:') && isLoopback(candidate.hostname);
        if (!secureOfficialRelay && !localRelay)
            return fallback.toString();
        if (!candidate.pathname || candidate.pathname === '/')
            candidate.pathname = '/extension';
        return candidate.toString();
    }
    catch {
        return fallback.toString();
    }
}
function websocketEndpoint(backend) {
    const relay = new URL(backend.origin);
    relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
    relay.pathname = '/extension';
    return relay.toString();
}
function isLoopback(hostname) {
    const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}
