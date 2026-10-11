// Jest test setup (CJS)
// Mock browser globals for ESM modules

// Polyfill TextEncoder/TextDecoder
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock Web Crypto API
const nodeCrypto = require('crypto');
const mockCrypto = {
    subtle: {
        async digest(algorithm, data) {
            const buf = Buffer.from(data);
            const hash = nodeCrypto.createHash('sha256').update(buf).digest();
            return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
        }
    }
};
global.crypto = mockCrypto;
globalThis.crypto = mockCrypto;

// Mock localStorage (closure-based, avoids `this` binding issues with ESM)
const _localData = {};
global.localStorage = {
    getItem(key) { return _localData[key] || null; },
    setItem(key, val) { _localData[key] = String(val); },
    removeItem(key) { delete _localData[key]; },
    clear() { for (const k of Object.keys(_localData)) delete _localData[k]; },
    get length() { return Object.keys(_localData).length; },
    key(i) { return Object.keys(_localData)[i] || null; }
};

// Mock sessionStorage (closure-based, avoids `this` binding issues with ESM)
const _sessionData = {};
global.sessionStorage = {
    getItem(key) { return _sessionData[key] || null; },
    setItem(key, val) { _sessionData[key] = String(val); },
    removeItem(key) { delete _sessionData[key]; },
    clear() { for (const k of Object.keys(_sessionData)) delete _sessionData[k]; },
    get length() { return Object.keys(_sessionData).length; },
    key(i) { return Object.keys(_sessionData)[i] || null; }
};

// Mock AbortSignal.timeout (not available in Node 22)
if (!AbortSignal.timeout) {
    AbortSignal.timeout = function(ms) {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
    };
}

// Mock document (minimal, for toast)
global.document = {
    getElementById() { return null; },
    createElement() { return { appendChild() {}, remove() {}, style: {} }; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
