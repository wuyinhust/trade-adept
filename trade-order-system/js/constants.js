/**
 * 全局常量定义
 * 集中管理所有魔法数字，便于维护和审计
 */
export const CONSTANTS = {
    // ===== 汇率 =====
    DEFAULT_EXCHANGE_RATE: 7.25,
    HK_EXCHANGE_RATE: 7.8,
    LEGACY_DEFAULT_RATE: 7.2,
    EXCHANGE_RATE_MIN: 5,
    EXCHANGE_RATE_MAX: 10,
    EXCHANGE_RATE_ADJUST: 0.02,

    // ===== 时间（毫秒） =====
    INIT_TIMEOUT_MS: 10000,
    POLL_INTERVAL_MS: 10000,
    POLL_SKIP_WINDOW_MS: 3000,
    SAVE_DEBOUNCE_MS: 500,
    LOAD_RETRY_DELAY_MS: 1000,
    EXCHANGE_API_TIMEOUT_MS: 8000,
    // 同源汇率服务会返回供应商的下次发布时间；前端按该时间单次唤醒。
    // 最小延迟避免上游失败或时钟偏差造成紧密重试。
    EXCHANGE_REFRESH_MIN_DELAY_MS: 60 * 1000,
    EXCHANGE_FAILURE_RETRY_MS: 5 * 60 * 1000,
    MAX_TIMER_DELAY_MS: 2_147_483_647,
    ONE_HOUR_MS: 60 * 60 * 1000,

    // ===== 数据限制 =====
    MAX_BACKUP_AGE_DAYS: 7,
    IMPORT_PREVIEW_LIMIT: 20,

    // ===== 安全 =====
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_DURATION_MS: 15 * 60 * 1000,

    // ===== 公司代码 =====
    COMPANY_DOMESTIC: ['CO-GR', 'CO-WY'],
    COMPANY_HK: ['CO-GW', 'CO-LK'],

    // ===== 分页 =====
    DEFAULT_PAGE_SIZE: 50
};
