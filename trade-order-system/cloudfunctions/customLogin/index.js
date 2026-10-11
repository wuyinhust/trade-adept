/**
 * CloudBase 自定义登录云函数
 *
 * 部署方式（CloudBase 控制台 → 云函数 → 新建云函数）：
 *   1. 函数名称：customLogin
 *   2. 运行环境：Node.js 18+
 *   3. 上传方式：上传整个 customLogin 文件夹（含 package.json + index.js）
 *   4. 环境变量：设置 SHARED_SECRET（与客户端 cloud.js 的 CLOUD_SECRET 一致）
 *   5. HTTP 触发器：开启，路径为 /customLogin
 *
 * 调用方式（来自客户端）：
 *   POST https://<env-id>.service.tcloudbase.com/customLogin
 *   Body: { username, passwordHash, secret }
 *
 * 响应：
 *   { ok: true, ticket: "..." }  或  { ok: false, error: "..." }
 */

const cloudbase = require('@cloudbase/node-sdk');

// 环境配置（与客户端 cloud.js 保持一致）
const ENV_ID = process.env.TCB_ENV_ID || 'grandware-d9gb4owez89cb9df9';
// 服务端共享密钥（部署时在环境变量中设置，与客户端 CLOUD_SECRET 一致）
const SHARED_SECRET = process.env.SHARED_SECRET || '';

if (!SHARED_SECRET) {
    console.warn('[customLogin] ⚠️ SHARED_SECRET 未设置！请在云函数环境变量中配置。');
}

// ==================== 用户数据库（与 auth.js 同步） ====================
const USERS = [
    { id: 'U001', username: 'David',    passwordHash: 'f283230b435d9874fd9ff9aa7c7522f4e67c437c2ed9222992bba1e50965eddf', name: 'David',   role: 'admin',       teamId: null },
    { id: 'U002', username: 'Lily',     passwordHash: '72b1d48623678a54fe80bed51d3f6aa1112f1da46e655560001303933c3be7c2', name: 'Lily',    role: 'finance',      teamId: null },
    { id: 'U003', username: 'Vivian',   passwordHash: '010f7a6cfc4661bdeac2e07948153bcf482f4dc778f45867911d9f9a67d789d0', name: 'Vivian',  role: 'manager',      teamId: 'TEAM-A' },
    { id: 'U005', username: 'Michale',  passwordHash: '424bac2baf00bcf569229ec0aa4697e69ac8a9d5e9a4fe61c855be9e97950d53', name: 'Michale', role: 'salesperson',   teamId: 'TEAM-A' },
    { id: 'U006', username: 'Alex',     passwordHash: 'd457705b292a8019b8afddb270bb8719d59c9108269550e7591cec8b4d666afa', name: 'Alex',    role: 'salesperson',   teamId: 'TEAM-A', visibleCompanyIds: ['CO-WY', 'CO-GW'] },
    { id: 'U007', username: 'Anna',     passwordHash: '56c7604022a19e3faffc68489f9cf2a3db7b1fd51b2f2715c1d68b6371200bb0', name: 'Anna',    role: 'document',      teamId: 'TEAM-A' },
    { id: 'U011', username: 'Sue',      passwordHash: 'eb03d0ca592799d39282dc9b06a037e392d3b70612bfea126ac73855983ab689', name: 'Sue',     role: 'salesperson',   teamId: 'TEAM-A', visibleCompanyIds: ['CO-LK'] },
    { id: 'U004', username: 'Galen',    passwordHash: 'd72836fb1445992a2aad026db748cb3cd2049685024be7797514d93352c362b9', name: 'Galen',   role: 'manager',      teamId: 'TEAM-B' },
    { id: 'U008', username: 'Nicole',   passwordHash: '000474d5f9528881bf1e75c4a4dc0697f635a539d384525e22633b058dd92740', name: 'Nicole',  role: 'salesperson',   teamId: 'TEAM-B' },
    { id: 'U009', username: 'Jack',     passwordHash: 'c0b9f3feb7f992d1d8384ad4a83d75ae99e161ed5f3bce64f4ab7a5e758f347d', name: 'Jack',    role: 'document',      teamId: 'TEAM-B' },
    { id: 'U010', username: 'Melody',   passwordHash: '15834a6c8f827b82e53f5f6ef4aa2907b7c1f9ca2ac3d407c8690721c13755fd', name: 'Melody',  role: 'document',      teamId: 'TEAM-B' }
];

// 构建快速查找表
const USER_MAP = {};
USERS.forEach(u => { USER_MAP[u.username] = u; });

// ==================== CloudBase 初始化 ====================
const app = cloudbase.init({ env: ENV_ID });
const auth = app.auth();

// ==================== 主处理函数 ====================
exports.main = async (event, context) => {
    // 解析请求体（HTTP 触发器传入的 event.body 是字符串）
    let body;
    try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event;
    } catch (e) {
        return formatResponse(400, { ok: false, error: '请求格式无效' });
    }

    const { username, passwordHash, secret } = body || {};

    // 1. 验证共享密钥
    if (SHARED_SECRET && secret !== SHARED_SECRET) {
        console.warn('[customLogin] 密钥验证失败 | username:', username);
        return formatResponse(403, { ok: false, error: '无权访问' });
    }

    // 2. 参数校验
    if (!username || !passwordHash) {
        return formatResponse(400, { ok: false, error: '缺少 username 或 passwordHash' });
    }

    // 3. 查找用户
    const user = USER_MAP[username];
    if (!user) {
        console.warn('[customLogin] 用户不存在:', username);
        return formatResponse(401, { ok: false, error: '用户名或密码错误' });
    }

    // 4. 验证密码哈希
    if (passwordHash !== user.passwordHash) {
        console.warn('[customLogin] 密码错误 | username:', username);
        return formatResponse(401, { ok: false, error: '用户名或密码错误' });
    }

    // 5. 签发 CloudBase 自定义登录票据
    try {
        // userId 使用业务用户 ID（会在 db 安全规则的 auth.uid 中可用）
        const userId = user.id;
        const ticketOptions = {
            refresh: 3600 * 1000, // 票据有效 1 小时
            custom: {
                username: user.username,
                name: user.name,
                role: user.role,
                teamId: user.teamId || '',
                visibleCompanyIds: user.visibleCompanyIds || []
            }
        };

        const ticket = auth.createTicket(userId, ticketOptions);

        console.log('[customLogin] 登录成功 | user:', username, '| role:', user.role, '| team:', user.teamId);
        return formatResponse(200, {
            ok: true,
            ticket: ticket,
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                role: user.role,
                teamId: user.teamId
            }
        });
    } catch (err) {
        console.error('[customLogin] 票据签发失败:', err.message || err);
        return formatResponse(500, { ok: false, error: '票据签发失败: ' + (err.message || '未知错误') });
    }
};

/**
 * 格式化 HTTP 响应
 */
function formatResponse(statusCode, body) {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(body)
    };
}
