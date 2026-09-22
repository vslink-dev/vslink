'use strict';
const MAX_MESSAGE_CHARS = 100000;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function validatePath(path) {
    if (!Array.isArray(path) || !path.length || path.length > 100) throw new Error('Invalid Copilot JSONL operation path.');
    for (const key of path) {
        if ((typeof key !== 'string' && !(Number.isSafeInteger(key) && key >= 0)) ||
            UNSAFE_KEYS.has(key) || key === '') throw new Error('Unsafe or invalid Copilot JSONL path segment.');
    }
}
function propertyKey(object, key, allowAppend = false) {
    if (!object || typeof object !== 'object') throw new Error('Copilot JSONL path traverses a non-object.');
    if (Array.isArray(object)) {
        const index = typeof key === 'number' ? key : /^(0|[1-9]\d*)$/.test(key) ? Number(key) : NaN;
        if (!Number.isSafeInteger(index) || index < 0 || index >= object.length + (allowAppend ? 1 : 0)) {
            throw new Error('Copilot JSONL array index is out of range.');
        }
        return index;
    }
    return key;
}
function parentAt(root, path) {
    let parent = root;
    for (const part of path.slice(0, -1)) {
        const key = propertyKey(parent, part);
        if (!Object.hasOwn(parent, key)) throw new Error('Copilot JSONL path refers to a missing parent.');
        parent = parent[key];
    }
    return [parent, propertyKey(parent, path.at(-1), true)];
}
function splitJsonObjects(content) {
    const objects = [];
    let start = -1, depth = 0, inString = false, escaped = false;
    for (let index = 0; index < content.length; index++) {
        const char = content[index];
        if (start < 0) {
            if (char === '{') { start = index; depth = 1; }
            else if (!/\s/.test(char)) throw new Error('Invalid JSONL content outside an object.');
            continue;
        }
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) { objects.push(content.slice(start, index + 1)); start = -1; }
    }
    if (start >= 0) throw new Error('Copilot JSONL write is incomplete. Refresh after VS Code finishes writing.');
    if (!objects.length) throw new Error('Copilot JSONL contains no records.');
    return objects;
}
function reconstructJsonl(content) {
    let data;
    for (const raw of splitJsonObjects(content)) {
        let op;
        try { op = JSON.parse(raw); }
        catch (cause) { throw new Error(`Invalid Copilot JSONL record: ${cause.message}`, { cause }); }
        if (op.kind === 0) {
            if (!op.v || typeof op.v !== 'object' || Array.isArray(op.v)) throw new Error('Invalid Copilot JSONL initial entry.');
            data = op.v; // Initial entries replace state, including after compaction.
            continue;
        }
        if (!data) throw new Error('Copilot JSONL is missing an initial entry.');
        if (![1, 2, 3].includes(op.kind)) throw new Error('Unsupported Copilot JSONL operation kind.');
        validatePath(op.k);
        const [parent, key] = parentAt(data, op.k);
        if (op.kind === 1) {
            // An omitted value represents undefined in VS Code's serializer.
            if (Object.hasOwn(op, 'v')) Object.defineProperty(parent, key, { value: op.v, enumerable: true, configurable: true, writable: true });
            else delete parent[key];
        } else if (op.kind === 3) {
            delete parent[key];
        } else {
            // The stored push operation can initialize an optional absent array
            // or truncate an array with i and no v. Never insert undefined.
            const current = Object.hasOwn(parent, key) ? parent[key] : undefined;
            if (current !== undefined && current !== null && !Array.isArray(current)) throw new Error('Copilot JSONL push target is not an array.');
            const target = current == null ? [] : current;
            if (Object.hasOwn(op, 'v') && !Array.isArray(op.v)) throw new Error('Copilot JSONL push value must be an array.');
            if (Object.hasOwn(op, 'i')) {
                if (!Number.isSafeInteger(op.i) || op.i < 0 || op.i > target.length) throw new Error('Copilot JSONL truncation index is out of range.');
                target.length = op.i;
            }
            if (op.v) for (const item of op.v) target.push(item);
            Object.defineProperty(parent, key, { value: target, enumerable: true, configurable: true, writable: true });
        }
    }
    return data;
}
function text(value, label) {
    if (typeof value !== 'string') throw new Error(`${label} is not text.`);
    if (value.length > MAX_MESSAGE_CHARS) throw new Error(`${label} exceeds the 100,000 character limit; no partial conversation was sent.`);
    return value.replace(/\r\n?/g, '\n').trim();
}
function userText(request) {
    if (!request.message || typeof request.message !== 'object') throw new Error('Copilot request has no message.');
    if (Object.hasOwn(request.message, 'text')) return text(request.message.text, 'Copilot prompt');
    if (!Array.isArray(request.message.parts)) throw new Error('Copilot message has no text or parts.');
    // Text parts are a supported stored message form; attachments are not text.
    return text(request.message.parts.filter(part => part?.kind === 'text').map(part => text(part.text, 'Copilot text part')).join(''), 'Copilot prompt');
}
function visibleAssistantText(response) {
    if (response === undefined) return '';
    if (!Array.isArray(response)) throw new Error('Copilot response is not an array.');
    const parts = [];
    for (const item of response) {
        if (!item || typeof item !== 'object') throw new Error('Invalid Copilot response part.');
        // Allow only display markdown, never arbitrary nested fields that may
        // include hidden reasoning, attachments, or tool payloads.
        if (item.kind !== undefined && !['value', 'markdownContent', 'markdown'].includes(item.kind)) continue;
        const value = item.kind === 'markdownContent' ? item.content : item.value;
        if (typeof value === 'string') parts.push(value);
        else if (value && typeof value.value === 'string' && value.kind === undefined) parts.push(value.value);
        else throw new Error('Unsupported Copilot display markdown format.');
    }
    return text(parts.join(''), 'Copilot answer');
}
function optionalNumber(value, label) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}.`);
    return value;
}
function optionalText(value, label, max = 200) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid or oversized ${label}.`);
    return value.trim() || undefined;
}
function requestPresentation(request) {
    const metadata = request.result?.metadata;
    if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error('Invalid Copilot result metadata.');
    const selected = optionalText(request.modelId, 'model ID', 120);
    // Optional names differ across stored schema versions. Validate every
    // supplied field; invalid data never selects a substitute field.
    const models = [metadata?.resolvedModel, metadata?.modelId, request.resolvedModel].map(value => optionalText(value, 'resolved model ID', 120));
    const details = [request.result?.details, request.responseDetails].map(value => optionalText(value, 'response details'));
    const credits = [request.copilotCredits, metadata?.copilotCredits, request.creditEstimate, metadata?.creditEstimate, metadata?.credits].map(value => optionalNumber(value, 'credit estimate'));
    const resolvedModel = models.find(value => value !== undefined);
    const responseDetails = details.find(value => value !== undefined);
    const creditEstimate = credits.find(value => value !== undefined);
    return { model: resolvedModel ?? selected, resolvedModel,
        modelLabel: responseDetails?.split(/[\u2022\u00B7]/)[0].trim(), responseDetails,
        creditEstimate, copilotCredits: creditEstimate };
}
function parseSessionContent(content, extension, sessionId) {
    if (!['.jsonl', '.json'].includes(extension)) throw new Error('Unsupported Copilot session format.');
    let data;
    try { data = extension === '.jsonl' ? reconstructJsonl(content) : JSON.parse(content); }
    catch (cause) { throw new Error(`Cannot parse Copilot session: ${cause.message}`, { cause }); }
    if (!Array.isArray(data?.requests)) throw new Error('Copilot session has no requests array.');
    const createdAt = optionalNumber(data.creationDate, 'session creation date');
    const messages = [];
    let lastModel;
    let lastResponseStatus;
    for (const request of data.requests) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid Copilot request.');
        for (const flag of ['isHidden', 'hiddenFromTranscript', 'requestHiddenFromTranscript', 'isCanceled']) {
            if (request[flag] !== undefined && typeof request[flag] !== 'boolean') throw new Error(`Invalid Copilot ${flag} flag.`);
        }
        if (request.isHidden || request.hiddenFromTranscript) continue;
        const requestTime = optionalNumber(request.timestamp, 'request timestamp');
        const prompt = request.requestHiddenFromTranscript ? '' : userText(request);
        const requestId = optionalText(request.requestId, 'request ID');
        if (request.result != null && (typeof request.result !== 'object' || Array.isArray(request.result))) throw new Error('Invalid Copilot result.');
        const responseStatus = request.isCanceled ? 'canceled' : (request.result?.error || request.result?.errorDetails) ? 'error' : request.result ? 'complete' : 'in-progress';
        if (prompt) messages.push({ role: 'user', text: prompt, timestamp: requestTime, status: 'complete', responseStatus, requestId });
        const answer = request.result || request.isCanceled ? visibleAssistantText(request.response) : '';
        if (prompt || answer) lastResponseStatus = responseStatus;
        if (answer) {
            const presentation = requestPresentation(request);
            if (presentation.model) lastModel = presentation.model;
            const elapsed = optionalNumber(request.result?.timings?.totalElapsed, 'response duration');
            const responseTime = optionalNumber(request.responseTimestamp, 'response timestamp');
            messages.push({ role: 'assistant', text: answer,
                timestamp: responseTime ?? (requestTime !== undefined && elapsed !== undefined ? requestTime + elapsed : undefined),
                status: responseStatus, requestId, timeline: [{ type: 'text', text: answer }], ...presentation });
        }
    }
    if (!messages.length) return null;
    const customTitle = optionalText(data.customTitle, 'session title', MAX_MESSAGE_CHARS);
    const title = customTitle ?? messages[0].text.replace(/\s+/g, ' ').slice(0, 80);
    const last = messages.at(-1);
    if (data.pendingRequests !== undefined && !Array.isArray(data.pendingRequests)) throw new Error('Invalid pending Copilot requests.');
    const status = data.pendingRequests?.length ? 'in-progress' : lastResponseStatus;
    return { sessionId, filePath: '', title, createdAt, lastMessageAt: last.timestamp,
        messages, messageCount: messages.length, lastModel, status };
}
module.exports = { reconstructJsonl, parseSessionContent };
