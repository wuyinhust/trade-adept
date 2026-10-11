/**
 * 公共工具模块 — 无业务模块依赖
 * 从 App 中提取，打破 App ↔ DB 循环依赖
 */

// ==================== 安全工具 ====================

/** HTML 转义：防止 XSS 注入攻击 */
export function escapeHtml(str) {
    if (!str && str !== 0) return '';
    const s = String(str);
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ==================== 错误处理 ====================

/** 将技术错误转为用户友好的提示 */
function _userFriendlyError(msg, context) {
    if (msg.includes('CloudBase SDK 未加载')) return '系统初始化中，请刷新页面重试';
    if (msg.includes('网络') || msg.includes('NetworkError') || msg.includes('fetch')) {
        return '网络连接失败，请检查网络后重试';
    }
    if (msg.includes('permission') || msg.includes('权限')) return '云端权限不足，请联系管理员';
    if (msg.includes('required') || msg.includes('必填')) return `操作失败：${msg}`;
    if (msg.includes('duplicate') || msg.includes('重复')) return `操作失败：${msg}`;
    const shortMsg = msg.length > 50 ? msg.substring(0, 50) + '...' : msg;
    return `${context}失败：${shortMsg}`;
}

/** 统一错误处理：记录日志 + 用户提示 */
export function handleError(error, context, options = {}) {
    const msg = error?.message || String(error);
    const stack = error?.stack || '';

    if (msg.includes('用户取消') || msg.includes('aborted')) return;

    console.error(`[${context}]`, msg, stack ? '\n' + stack : '');

    if (!options.silent) {
        const userMsg = _userFriendlyError(msg, context);
        toast(userMsg, 'error', 5000);
    }

    if (options.rethrow) throw error instanceof Error ? error : new Error(msg);
}

/** 安全执行异步操作（自动捕获错误） */
export async function safeCall(fn, context, options = {}) {
    try {
        return await fn();
    } catch (err) {
        handleError(err, context, options);
        return undefined;
    }
}

// ==================== Toast 通知 ====================

/** 显示 Toast 通知 */
export function toast(message, type = 'success', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icons[type] || '✅'}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
        el.style.animation = 'slideInRight 0.3s ease reverse';
        setTimeout(() => el.remove(), 300);
    }, duration);
}

// ==================== 事件总线 ====================

const _events = {};

export const EventBus = {
    on(event, callback) {
        if (!_events[event]) _events[event] = [];
        _events[event].push(callback);
        return () => this.off(event, callback);
    },

    off(event, callback) {
        if (!_events[event]) return;
        _events[event] = _events[event].filter(cb => cb !== callback);
    },

    emit(event, data) {
        if (!_events[event]) return;
        _events[event].forEach(cb => {
            try {
                cb(data);
            } catch (e) {
                console.error('[EventBus]', event, e);
            }
        });
    }
};

// ==================== 输入验证工具 ====================

export const validate = {
    /** 验证必填字段，返回第一个缺失字段名，或 null */
    required(data, fields) {
        for (const f of fields) {
            const val = data[f];
            if (val === undefined || val === null || String(val).trim() === '') {
                return f;
            }
        }
        return null;
    },

    /** 验证是否为正数 */
    positive(val) {
        const n = parseFloat(val);
        return !isNaN(n) && n > 0;
    },

    /** 验证是否为有效数字 */
    numeric(val) {
        return !isNaN(parseFloat(val)) && isFinite(val);
    },

    /** 验证邮箱格式 */
    email(val) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val));
    },

    /** 验证手机号（中国大陆） */
    phoneCN(val) {
        return /^1[3-9]\d{9}$/.test(String(val).replace(/\s/g, ''));
    },

    /** 验证字符串长度范围 */
    length(val, min, max) {
        const s = String(val || '');
        return s.length >= min && s.length <= max;
    },

    /** 批量校验，收集所有错误 */
    checkAll(data, rules) {
        const errors = [];
        for (const rule of rules) {
            const { field, label, test, message } = rule;
            const val = data[field];
            if (!test(val)) {
                errors.push(message || `${label || field} 格式不正确`);
            }
        }
        return errors;
    }
};
