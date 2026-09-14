"use strict";
exports.reconstructJsonl = reconstructJsonl;
exports.parseSessionContent = parseSessionContent;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 100000;
const HIDDEN_RESPONSE_KINDS = new Set([
    'thinking',
    'toolinvocationserialized',
    'progresstaskserialized',
    'texteditgroup',
    'inlinereference',
    'mcpserversstarting',
    'confirmation',
    'commandbutton',
    'warning',
    'reference',
    'citation',
    'codeblockuri',
    'filetree'
]);
function pathKey(value) {
    return typeof value === 'number' ? value : (/^\d+$/.test(value) ? Number(value) : value);
}
function getNested(root, path) {
    let current = root;
    for (const part of path) {
        if (current === null || current === undefined)
            return undefined;
        current = current[pathKey(part)];
    }
    return current;
}
function setNested(root, path, value) {
    if (!path.length)
        return;
    let current = root;
    for (let index = 0; index < path.length - 1; index++) {
        const key = pathKey(path[index]);
        const next = pathKey(path[index + 1]);
        if (current[key] === null || current[key] === undefined) {
            current[key] = typeof next === 'number' ? [] : {};
        }
        current = current[key];
    }
    current[pathKey(path[path.length - 1])] = value;
}
function ensureArray(root, path) {
    const existing = getNested(root, path);
    if (Array.isArray(existing))
        return existing;
    setNested(root, path, []);
    return getNested(root, path);
}
function splitJsonObjects(content) {
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < content.length; index++) {
        const char = content[index];
        if (start < 0) {
            if (char === '{') {
                start = index;
                depth = 1;
            } else if (!/\s/.test(char)) throw new Error('Invalid JSONL content outside an object.');
            continue;
        }
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === '{')
            depth++;
        else if (char === '}' && --depth === 0) {
            objects.push(content.slice(start, index + 1));
            start = -1;
        }
    }
    if (start >= 0) throw new Error('Copilot JSONL write is incomplete. Refresh after VS Code finishes writing.');
    if (!objects.length) throw new Error('Copilot JSONL contains no records.');
    return objects;
}
function reconstructJsonl(content) {
    let data = {};
    for (const raw of splitJsonObjects(content)) {
        let operation;
        try {
            operation = JSON.parse(raw);
        }
        catch (error) {
            throw new Error(`Invalid Copilot JSONL record: ${error.message}`, { cause: error });
        }
        if (operation.kind === 0 && operation.v && typeof operation.v === 'object') {
            data = { ...data, ...operation.v };
            continue;
        }
        if (!Array.isArray(operation.k) || operation.k.length === 0)
            continue;
        const path = operation.k;
        if (operation.kind === 1) {
            setNested(data, path, operation.v);
            continue;
        }
        if (operation.kind !== 2)
            continue;
        const index = typeof operation.i === 'number' ? operation.i : undefined;
        const current = getNested(data, path);
        if (index !== undefined) {
            const target = Array.isArray(current) ? current : ensureArray(data, path);
            const values = Array.isArray(operation.v) ? operation.v : [operation.v];
            if (target.length < index)
                target.length = index;
            target.splice(index, target.length - index, ...values);
        }
        else if (Array.isArray(current)) {
            const values = Array.isArray(operation.v) ? operation.v : [operation.v];
            current.push(...values);
        }
        else {
            setNested(data, path, operation.v);
        }
    }
    return data;
}
function normalizeText(value) {
    if (typeof value !== 'string')
        return '';
    return value
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim()
        .slice(0, MAX_MESSAGE_CHARS);
}
function collectVisibleText(value) {
    if (typeof value === 'string')
        return value ? [value] : [];
    if (!value || typeof value !== 'object')
        return [];
    if (Array.isArray(value))
        return value.flatMap(collectVisibleText);
    const result = [];
    for (const key of ['value', 'text', 'markdown', 'content', 'message', 'parts', 'items']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            result.push(...collectVisibleText(value[key]));
        }
    }
    return result;
}
function appendFragment(current, fragment) {
    if (!fragment)
        return current;
    if (!current)
        return fragment;
    if (fragment === current || current.endsWith(fragment))
        return current;
    if (fragment.startsWith(current))
        return fragment;
    const maxOverlap = Math.min(current.length, fragment.length, 4000);
    for (let size = maxOverlap; size >= 1; size--) {
        if (current.endsWith(fragment.slice(0, size))) {
            return current + fragment.slice(size);
        }
    }
    return current + fragment;
}
function visibleAssistantText(response) {
    if (!Array.isArray(response))
        return '';
    let text = '';
    for (const item of response) {
        if (!item || typeof item !== 'object')
            continue;
        const kind = String(item.kind || '').toLowerCase();
        if (HIDDEN_RESPONSE_KINDS.has(kind))
            continue;
        if (kind && kind !== 'value' && !kind.includes('markdown'))
            continue;
        for (const fragment of collectVisibleText(item.value)) {
            text = appendFragment(text, fragment);
        }
    }
    return normalizeText(text).replace(/\n{3,}/g, '\n\n');
}
function userText(request) {
    const direct = request?.message?.text;
    if (typeof direct === 'string')
        return normalizeText(direct);
    const parts = Array.isArray(request?.message?.parts) ? request.message.parts : [];
    const textPart = parts.find((part) => part?.kind === 'text' && typeof part?.text === 'string');
    return normalizeText(textPart?.text);
}
function timestamp(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}
function safeMetadataText(value, maxLength = 200) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
    return text || undefined;
}
function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}
function requestPresentation(request) {
    const metadata = request?.result?.metadata || {};
    const selectedModel = safeMetadataText(request?.modelId, 120);
    const resolvedModel = safeMetadataText(metadata.resolvedModel, 120) ||
        safeMetadataText(metadata.modelId, 120) ||
        safeMetadataText(request?.resolvedModel, 120);
    const responseDetails = safeMetadataText(request?.result?.details) ||
        safeMetadataText(request?.responseDetails);
    const modelLabel = responseDetails
        ? safeMetadataText(responseDetails.split(/[\u2022\u00B7]/)[0], 120)
        : undefined;
    const creditEstimate = positiveNumber(request?.copilotCredits) ||
        positiveNumber(metadata.copilotCredits) ||
        positiveNumber(request?.creditEstimate) ||
        positiveNumber(metadata.creditEstimate) ||
        positiveNumber(metadata.credits);
    return {
        model: resolvedModel || selectedModel,
        resolvedModel,
        modelLabel,
        responseDetails,
        creditEstimate,
        copilotCredits: creditEstimate
    };
}
function sessionStatus(data, messages) {
    if (Array.isArray(data?.pendingRequests) && data.pendingRequests.length > 0)
        return 'in-progress';
    const assistant = [...messages].reverse().find(message => message.role === 'assistant');
    if (assistant)
        return assistant.status || 'complete';
    return messages[messages.length - 1]?.role === 'user' ? 'in-progress' : 'complete';
}
function parseSessionContent(content, extension, sessionId) {
    let data;
    try {
        data = extension === '.jsonl' ? reconstructJsonl(content) : JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Cannot parse Copilot session: ${error.message}`, { cause: error });
    }
    if (!Array.isArray(data?.requests))
        throw new Error('Copilot session has no requests array.');
    const messages = [];
    const createdAt = timestamp(data.creationDate, Date.now());
    let lastModel;
    for (const request of data.requests.slice(-MAX_MESSAGES)) {
        if (!request || typeof request !== 'object')
            continue;
        const requestTime = timestamp(request.timestamp, createdAt);
        const prompt = userText(request);
        if (prompt)
            messages.push({ role: 'user', text: prompt, timestamp: requestTime, status: 'complete' });
        const answer = request.result || request.isCanceled
            ? visibleAssistantText(request.response)
            : '';
        if (answer) {
            const presentation = requestPresentation(request);
            if (presentation.model)
                lastModel = presentation.model;
            const elapsed = Number(request?.result?.timings?.totalElapsed) || 0;
            const status = request.isCanceled
                ? 'canceled'
                : request?.result?.error
                    ? 'error'
                    : request.result
                        ? 'complete'
                        : 'in-progress';
            messages.push({
                role: 'assistant',
                text: answer,
                timestamp: requestTime + Math.max(0, elapsed),
                status,
                timeline: [{ type: 'text', text: answer }],
                ...presentation
            });
        }
    }
    if (!messages.length)
        return null;
    const firstPrompt = messages.find(message => message.role === 'user')?.text || 'Copilot chat';
    const title = normalizeText(data.customTitle) || firstPrompt.replace(/\s+/g, ' ').slice(0, 80);
    const last = messages[messages.length - 1];
    return {
        sessionId,
        filePath: '',
        title,
        createdAt,
        lastMessageAt: last.timestamp || createdAt,
        messages,
        messageCount: messages.length,
        lastModel,
        status: sessionStatus(data, messages)
    };
}
