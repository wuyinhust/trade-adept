/**
 * 系统设置模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Cloud } from './cloud.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate } from './utils.js';

const Settings = {
    render(container) {
        container.innerHTML = `
            <div style="max-width:700px">
                <div class="card mb-6">
                    <div class="card-header"><span class="card-title">💱 汇率设置</span><span style="font-size:13px;color:var(--gray-500);margin-left:12px">${DB.getCurrentCompany().name}</span></div>
                    <div class="card-body">
                        <div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap">
                            <div class="form-group" style="margin-bottom:0">
                                <label class="form-label">1 USD = <span id="rateLabel">?</span> RMB</label>
                                <input type="number" step="0.0001" class="form-input" id="exchangeRateInput" value="${DB.getExchangeRate()}" style="font-size:18px;font-weight:600;max-width:180px">
                            </div>
                            <div style="display:flex;gap:8px;align-items:flex-end;padding-bottom:2px">
                                <button class="btn btn-primary" id="fetchRateBtn" onclick="Settings.fetchRate()">🔄 获取实时汇率</button>
                                <button class="btn btn-sm btn-secondary" id="toggleAutoRefreshBtn" onclick="Settings.toggleAutoRefresh()">
                                    ${window.Exchange && window.Exchange.isAutoRefreshActive() ? '⏸️ 停止自动刷新' : '▶️ 开启自动刷新'}
                                </button>
                            </div>
                        </div>
                        <div id="rateStatus" class="mt-3" style="font-size:13px;color:var(--gray-600)">
                            ${(() => {
                                const meta = DB.getRateMeta();
                                const autoActive = window.Exchange && window.Exchange.isAutoRefreshActive();
                                const nextRefresh = autoActive ? window.Exchange.getNextRefreshTime() : null;
                                return meta.updateTime
                                    ? `
                                <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
                                    <span>📡 来源：<strong>${meta.source}</strong></span>
                                    <span>🕐 更新：${new Date(meta.updateTime).toLocaleString('zh-CN')}</span>
                                </div>
                                ${autoActive && nextRefresh ? `<div class="mt-2" style="color:var(--success)">⏰ 下次自动刷新：${new Date(nextRefresh).toLocaleString('zh-CN')}</div>` : ''}
                                ${!autoActive ? `<div class="mt-2" style="color:var(--gray-500)">💡 开启自动刷新后，汇率将每1小时自动更新</div>` : ''}
                                ${meta.note ? `<div class="mt-2" style="color:var(--gray-500)">💡 ${meta.note}</div>` : ''}
                            `
                                    : '<span class="text-gray">尚未获取实时汇率，点击上方按钮获取（获取后自动重算订单利润）</span>';
                            })()}
                        </div>
                    </div>
                </div>

                <div class="card mb-6">
                    <div class="card-header"><span class="card-title">☁️ CloudBase 云存储</span></div>
                    <div class="card-body">
                        <p class="text-sm mb-3">
                            环境 ID：<code style="background:var(--gray-100);padding:2px 8px;border-radius:4px">grandware-d9gb4owez89cb9df9</code>
                        </p>
                        <div id="cloudConfigStatus" style="font-size:13px">
                            ${Settings._renderCloudStatus()}
                        </div>
                        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
                            <button class="btn btn-sm btn-secondary" onclick="Settings.refreshCloudNow()">🔄 手动刷新云端数据</button>
                            <button class="btn btn-sm btn-secondary" onclick="Settings.reconnectCloudNow(event)">🔌 重新连接 CloudBase</button>
                            <button class="btn btn-sm btn-secondary" onclick="Settings.runFullDiagnose(event)">🧪 完整诊断</button>
                        </div>
                    </div>
                </div>

                ${
                    Auth.canSeeAll()
                        ? `
                <div class="card mb-6">
                    <div class="card-header">
                        <span class="card-title">🔍 数据可见性体检</span>
                        <span style="font-size:13px;color:var(--gray-500);margin-left:12px">仅管理员/财务 · 排查"谁看不到什么"</span>
                    </div>
                    <div class="card-body">
                        <p class="text-sm text-gray mb-3">
                            统计数据在「公司归属 / 业务员归属」维度下的分布。若某账号登录后看不到数据，
                            通常是数据归属不在其可见范围（B组：为语+Grandware HK；订单还需匹配团队业务员）。
                        </p>
                        <button class="btn btn-sm btn-primary" onclick="Settings.runVisibilityDiag(event)">📊 生成体检报告</button>
                        <div id="visibilityDiagResult" class="mt-3" style="font-size:13px"></div>
                    </div>
                </div>
                `
                        : ''
                }

                <div class="card mb-6">
                    <div class="card-header">
                        <span class="card-title">🛠️ CloudBase 高级配置（手动设置）</span>
                    </div>
                    <div class="card-body">
                        <p class="text-sm text-gray mb-3">
                            多数情况下<b>不需要</b>手动配置。只有遇到特殊情况（如切换环境、部署自定义登录云函数）时才需要修改。
                            修改后点击「保存并重新连接」即可生效。
                        </p>
                        <div class="form-group">
                            <label class="form-label">环境 ID（envId）</label>
                            <input type="text" class="form-input" id="cfgEnvId" placeholder="grandware-d9gb4owez89cb9df9" />
                            <div class="text-sm text-gray mt-1">CloudBase 控制台 → 环境 → 环境 ID</div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">区域（region）</label>
                            <select class="form-input" id="cfgRegion">
                                <option value="ap-shanghai">ap-shanghai（上海）</option>
                                <option value="ap-guangzhou">ap-guangzhou（广州）</option>
                                <option value="ap-beijing">ap-beijing（北京）</option>
                                <option value="ap-hongkong">ap-hongkong（香港）</option>
                                <option value="na-siliconvalley">na-siliconvalley（硅谷）</option>
                            </select>
                            <div class="text-sm text-gray mt-1">环境所在的物理区域，必须与控制台一致</div>
                        </div>
                        <details class="mb-3">
                            <summary class="text-sm" style="cursor:pointer;color:var(--primary)">⚙️ 自定义登录云函数（高级，可选）</summary>
                            <div class="mt-3" style="padding:12px;background:var(--gray-50);border-radius:6px">
                                <p class="text-sm text-gray mb-2">
                                    部署了 <code>customLogin</code> 云函数后可启用，<b>支持用户身份识别（auth.uid）</b>。
                                    没部署时保持空白即可，系统会自动用匿名登录。
                                </p>
                                <div class="form-group">
                                    <label class="form-label">云函数 HTTP 触发器 URL</label>
                                    <input type="text" class="form-input" id="cfgCloudFnUrl" placeholder="https://grandware-xxx.service.tcloudbase.com/customLogin" />
                                </div>
                                <div class="form-group">
                                    <label class="form-label">共享密钥（CLOUD_SECRET）</label>
                                    <input type="text" class="form-input" id="cfgCloudSecret" placeholder="部署云函数时设置的共享密钥" />
                                </div>
                            </div>
                        </details>
                        <div id="manualConfigStatus" class="text-sm mb-3"></div>
                        <div style="display:flex;gap:8px;flex-wrap:wrap">
                            <button class="btn btn-primary" onclick="Settings.saveManualConfig()">💾 保存并重新连接</button>
                            <button class="btn btn-secondary" onclick="Settings.clearManualConfig()">🗑️ 恢复默认配置</button>
                            <button class="btn btn-secondary" onclick="Settings.testManualConfig(event)">🧪 测试当前配置</button>
                        </div>
                    </div>
                </div>

                <div class="card mb-6">
                    <div class="card-header"><span class="card-title">🏭 工厂管理</span></div>
                    <div class="card-body">
                        <div class="table-container">
                            <table>
                                <thead>
                                    <tr><th>编号</th><th>工厂名称</th><th>联系人</th><th>电话</th><th>产品类型</th></tr>
                                </thead>
                                <tbody>
                                    ${DB.getFactories()
                                        .map(
                                            f => `
                                        <tr>
                                            <td>${f.id}</td>
                                            <td>${f.name}</td>
                                            <td>${f.contact}</td>
                                            <td>${f.phone}</td>
                                            <td>${f.products}</td>
                                        </tr>
                                    `
                                        )
                                        .join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div class="card mb-6">
                    <div class="card-header"><span class="card-title">📊 数据统计</span></div>
                    <div class="card-body">
                        <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                            <div class="detail-item"><div class="detail-label">订单总数</div><div class="detail-value">${DB.data.orders.length}</div></div>
                            <div class="detail-item"><div class="detail-label">客户总数</div><div class="detail-value">${DB.data.customers.length}</div></div>
                            <div class="detail-item"><div class="detail-label">出运记录</div><div class="detail-value">${DB.data.shipments.length}</div></div>
                            <div class="detail-item"><div class="detail-label">工厂总数</div><div class="detail-value">${DB.data.factories.length}</div></div>
                            <div class="detail-item"><div class="detail-label">数据存储位置</div><div class="detail-value text-sm">☁️ 腾讯云 CloudBase</div></div>
                        </div>
                    </div>
                </div>

                <div class="card mb-6">
                    <div class="card-header"><span class="card-title">💾 数据管理</span></div>
                    <div class="card-body">
                        <p class="text-sm text-gray mb-3">☁️ 所有数据存储在 CloudBase 云端，团队成员登录后自动共享最新数据。</p>
                        <div class="flex gap-3">
                            <button class="btn btn-secondary" onclick="Settings.exportAllData()">📥 导出全部数据 (JSON)</button>
                            <button class="btn btn-secondary" onclick="Settings.importData()">📤 导入数据</button>
                            <button class="btn btn-danger" onclick="Settings.clearAllData()">🗑️ 清空所有数据</button>
                        </div>
                        <input type="file" id="importFileInput" accept=".json" style="display:none" onchange="Settings.handleImport(event)">
                    </div>
                </div>

                <div class="card">
                    <div class="card-header"><span class="card-title">ℹ️ 关于系统</span></div>
                    <div class="card-body">
                        <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                            <div class="detail-item"><div class="detail-label">系统名称</div><div class="detail-value">Grandware Group</div></div>
                            <div class="detail-item"><div class="detail-label">版本</div><div class="detail-value">v1.0.0</div></div>
                            <div class="detail-item"><div class="detail-label">技术栈</div><div class="detail-value text-sm">HTML5 + CSS3 + JavaScript</div></div>
                            <div class="detail-item"><div class="detail-label">图表库</div><div class="detail-value text-sm">Chart.js</div></div>
                        </div>
                        <div class="mt-4">
                            <h3 class="font-semi mb-2">功能模块</h3>
                            <ul style="list-style:none;padding-left:0">
                                <li style="padding:4px 0">📊 <strong>总览</strong> - 关键指标、营收趋势、订单分布、收款进度</li>
                                <li style="padding:4px 0">📋 <strong>订单管理</strong> - 订单全生命周期，金额/成本/利润/付款跟踪</li>
                                <li style="padding:4px 0">👥 <strong>客户管理</strong> - 客户信息、历史订单、联系人名录</li>
                                <li style="padding:4px 0">💰 <strong>利润分析</strong> - 多维度利润统计与可视化</li>
                                <li style="padding:4px 0">🚢 <strong>物流单证</strong> - 提单、报关、船期、到港跟踪</li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // ★ 渲染完成后，把当前生效配置填到手动配置输入框中
        setTimeout(() => Settings._fillManualConfigInputs(), 0);
    },

    async fetchRate() {
        const btn = document.getElementById('fetchRateBtn');
        const statusEl = document.getElementById('rateStatus');
        btn.disabled = true;
        btn.textContent = '⏳ 获取中...';
        statusEl.innerHTML = '<span style="color:var(--primary)">⏳ 正在从外汇市场获取最新汇率...</span>';

        const result = await DB.fetchExchangeRate();
        btn.disabled = false;
        btn.textContent = '🔄 获取实时汇率';

        if (result.success) {
            document.getElementById('exchangeRateInput').value = DB.getExchangeRate();
            App.updateExchangeRateDisplay();
            // 更新状态显示
            const meta = DB.getRateMeta();
            const autoActive = window.Exchange && window.Exchange.isAutoRefreshActive();
            const nextRefresh = autoActive ? window.Exchange.getNextRefreshTime() : null;
            statusEl.innerHTML = `
                <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
                    <span>📡 来源：<strong>${meta.source}</strong></span>
                    <span>🕐 更新：${new Date(meta.updateTime).toLocaleString('zh-CN')}</span>
                </div>
                ${autoActive && nextRefresh ? `<div class="mt-2" style="color:var(--success)">⏰ 下次自动刷新：${new Date(nextRefresh).toLocaleString('zh-CN')}</div>` : ''}
                ${meta.note ? `<div class="mt-2" style="color:var(--gray-500)">💡 ${meta.note}</div>` : ''}
            `;
            App.toast(`实时汇率：1 USD = ${DB.getExchangeRate().toFixed(4)} RMB，订单利润已自动重算`, 'success');
        } else {
            statusEl.innerHTML = `<span style="color:var(--danger)">❌ ${App.escapeHtml(result.error)}</span>`;
            App.toast(result.error, 'error');
        }
    },

    /** 切换自动刷新开关 */
    toggleAutoRefresh() {
        if (!window.Exchange) return;
        if (window.Exchange.isAutoRefreshActive()) {
            window.Exchange.stopAutoRefresh();
            App.toast('已停止汇率自动刷新', 'info');
        } else {
            window.Exchange.startAutoRefresh();
            App.toast('已开启汇率自动刷新（每1小时）', 'success');
        }
        // 重新渲染设置页面以更新按钮状态
        const container = document.querySelector('#app main') || document.getElementById('mainContent');
        if (container) this.render(container);
    },

    exportAllData() {
        const data = {
            ...DB.data,
            exchangeRates: DB.exchangeRates,
            exportDate: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'Grandware Group_数据备份_' + new Date().toISOString().split('T')[0] + '.json';
        link.click();
        App.toast('数据已导出');
    },

    importData() {
        document.getElementById('importFileInput').click();
    },

    handleImport(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = JSON.parse(e.target.result);
                if (data.orders && data.customers) {
                    DB.data = data;
                    DB.save();
                    // 兼容旧版单汇率和新版多汇率
                    if (data.exchangeRates) {
                        Object.assign(DB.exchangeRates, data.exchangeRates);
                    } else if (data.exchangeRate) {
                        for (const cid of Object.keys(DB.exchangeRates)) {
                            DB.exchangeRates[cid] = parseFloat(data.exchangeRate) || 7.2;
                        }
                    }
                    App.updateExchangeRateDisplay();
                    App.toast('数据导入成功');
                    App.router();
                } else {
                    App.toast('文件格式不正确', 'error');
                }
            } catch (err) {
                App.toast('数据解析失败：' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    },

    clearAllData() {
        App.showConfirm(
            '⚠️ 确定要清空所有数据吗？此操作不可撤销，所有订单、客户、工厂、出运和单证数据将被永久删除！',
            () => {
                DB.resetData();
                App.updateExchangeRateDisplay();
                App.toast('所有数据已清空');
                App.router();
            }
        );
    },

    // ==================== CloudBase 云存储 ====================

    /** 渲染 CloudBase 连接状态（含详细诊断） */
    _renderCloudStatus() {
        const status = Cloud.getStatus();

        if (DB.CLOUD_READY) {
            const loginType = Cloud.getLoginType();
            return `<span style="color:var(--success)">✅ 云端已连接 · 所有数据自动同步 (${loginType === 'custom' ? '自定义登录' : '匿名登录'})</span>`;
        }

        // 构建诊断详情
        const details = [];
        if (!status.sdkLoaded) {
            details.push('❌ CloudBase SDK 未加载');
        } else {
            details.push('✅ SDK 已加载');
        }
        if (!status.authDone) {
            details.push('❌ 登录未完成');
        } else {
            details.push('✅ 已登录');
        }
        if (!status.dbReady) {
            details.push('❌ 数据库未就绪');
        } else {
            details.push('✅ 数据库就绪');
        }

        let html = `<span style="color:var(--danger)">❌ 云端未连接</span>`;

        // 显示具体错误（默认直接显示，不用折叠）
        if (status.lastError) {
            html += `<div style="margin-top:8px;padding:10px;background:#fff3cd;border-radius:6px;font-size:12px;color:#856404;word-break:break-all">
                <strong>🚨 错误信息：</strong><br>
                ${escapeHtml(status.lastError)}
                ${status.lastErrorTime ? `<div style="color:#856404;opacity:0.8;margin-top:4px">最后错误时间: ${new Date(status.lastErrorTime).toLocaleString('zh-CN')}</div>` : ''}
            </div>`;
        } else if (!DB.CLOUD_READY && status.sdkLoaded && status.authDone && status.dbReady) {
            html += `<div style="margin-top:8px;padding:10px;background:#fff3cd;border-radius:6px;font-size:12px;color:#856404">
                <strong>🚨 数据库权限测试未通过</strong><br>
                SDK、登录、数据库均就绪，但无法读写 app_data 集合。
            </div>`;
        }

        // 显示诊断详情（默认展开）
        html += `<details open style="margin-top:10px">
            <summary style="cursor:pointer;color:var(--gray-500);font-size:12px">查看诊断详情</summary>
            <div style="margin-top:6px;padding:8px;background:var(--gray-50);border-radius:6px;font-size:12px;line-height:1.8">
                ${details.map(d => `<div>${d}</div>`).join('')}
                <div>环境 ID: <code>${escapeHtml(status.envId || '')}</code></div>
            </div>
        </details>`;

        // 根据错误原因给出排查建议
        const err = status.lastError || '';
        if (err.includes('SDK 未加载')) {
            html += `<div style="margin-top:8px;padding:10px;background:#fff3cd;border-radius:6px;font-size:12px;color:#856404">
                <strong>💡 排查建议：</strong><br>
                1. 检查 index.html 中是否引入了 &lt;script src="js/cloudbase-sdk.js"&gt;<br>
                2. 刷新页面后再试
            </div>`;
        } else if (err.includes('anonymous') || err.includes('未开启') || err.includes('not enabled')) {
            html += `<div style="margin-top:8px;padding:10px;background:#fff3cd;border-radius:6px;font-size:12px;color:#856404">
                <strong>💡 排查建议：</strong><br>
                1. 登录 <a href="https://console.cloud.tencent.com/tcb" target="_blank">CloudBase 控制台</a><br>
                2. 进入「用户管理」→「登录设置」→ 开启「匿名登录」<br>
                3. 刷新页面后再试
            </div>`;
        } else if (
            err.includes('CORS') ||
            err.includes('network') ||
            err.includes('NetworkError') ||
            err.includes('安全域名') ||
            err.includes('fetch')
        ) {
            html += `<div style="margin-top:8px;padding:10px;background:#fff3cd;border-radius:6px;font-size:12px;color:#856404">
                <strong>💡 排查建议：</strong><br>
                1. 登录 <a href="https://console.cloud.tencent.com/tcb" target="_blank">CloudBase 控制台</a><br>
                2. 进入「安全配置」→「安全域名」→ 添加当前访问域名<br>
                3. 如果本地测试，添加 <code>localhost</code> 或 <code>127.0.0.1</code><br>
                4. 刷新页面后再试
            </div>`;
        } else if (
            err.includes('permission') ||
            err.includes('权限') ||
            err.includes('PERMISSION') ||
            err.includes('Unauthorized')
        ) {
            html += `<div style="margin-top:8px;padding:10px;background:#fff3cd;border-radius:6px;font-size:12px;color:#856404">
                <strong>💡 排查建议（数据库权限不足）：</strong><br>
                1. 登录 <a href="https://console.cloud.tencent.com/tcb" target="_blank">CloudBase 控制台</a><br>
                2. 进入「数据库」→ 选择 <code>app_data</code> 集合 → 「权限设置」<br>
                3. 设置为自定义安全规则：<br>
                <code style="display:block;margin:4px 0;padding:6px;background:#fff;border-radius:4px">{"read":"doc.dataType != null","write":"doc.dataType in ['gw_data','_diag_test']","create":"doc.dataType in ['gw_data','_diag_test']","update":"doc.dataType in ['gw_data','_diag_test']","delete":false}</code>
                4. 刷新页面后再试
            </div>`;
        } else if (err) {
            html += `<div style="margin-top:8px;padding:10px;background:#fff3cd;border-radius:6px;font-size:12px;color:#856404">
                <strong>💡 排查建议：</strong><br>
                1. 打开浏览器控制台 (F12) 查看详细错误日志<br>
                2. 检查网络连接是否正常<br>
                3. 刷新页面后再试
            </div>`;
        } else {
            // 没有具体错误时（权限测试静默失败）
            html += `<div style="margin-top:8px;padding:10px;background:#fff3cd;border-radius:6px;font-size:12px;color:#856404">
                <strong>💡 排查建议：</strong><br>
                1. 打开浏览器控制台 (F12) 查看详细错误日志<br>
                2. 检查 CloudBase 控制台中 <code>app_data</code> 集合是否存在且权限正确<br>
                3. 点击下方的「重新连接 CloudBase」按钮重试
            </div>`;
        }

        return html;
    },

    async refreshCloudNow() {
        await App.refreshCloud();
        setTimeout(() => App.router(), 300);
    },

    async reconnectCloudNow(event) {
        const btn = event?.target;
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ 正在连接...';
        }
        try {
            App.toast('正在重新连接 CloudBase...', 'info');
            Cloud.reset();
            DB._cloudConnected = false;
            DB._cloudReady = false;
            const ok = await DB.init();
            App.updateCloudStatus();
            if (ok) {
                App.toast('✅ CloudBase 重新连接成功', 'success');
            } else {
                App.toast('❌ CloudBase 重新连接失败，请查看设置页错误信息', 'error', 6000);
            }
        } catch (e) {
            console.error(e);
            App.toast('❌ 重连异常: ' + (e.message || String(e)), 'error', 6000);
        } finally {
            // 刷新设置页以显示最新状态
            App.router('settings');
        }
    },

    /**
     * 把当前生效配置填到手动配置输入框中
     */
    _fillManualConfigInputs() {
        const cfg = Cloud.getConfig();
        const envIdEl = document.getElementById('cfgEnvId');
        const regionEl = document.getElementById('cfgRegion');
        const fnUrlEl = document.getElementById('cfgCloudFnUrl');
        const secretEl = document.getElementById('cfgCloudSecret');
        if (envIdEl) envIdEl.value = cfg.envId || '';
        if (regionEl) regionEl.value = cfg.region || 'ap-shanghai';
        if (fnUrlEl) fnUrlEl.value = cfg.cloudFnUrl || '';
        if (secretEl) secretEl.value = cfg.cloudSecret || '';
        // 显示当前是否有手动配置
        const statusEl = document.getElementById('manualConfigStatus');
        if (statusEl) {
            const hasManual = !!localStorage.getItem('grandware_cloud_config');
            statusEl.innerHTML = hasManual
                ? '<span style="color:var(--success)">✅ 当前使用<b>手动配置</b>（保存于本地）</span>'
                : '<span style="color:var(--gray-500)">📌 当前使用<b>默认配置</b>（来自代码内置值）</span>';
        }
    },

    /**
     * 保存手动配置并重新连接
     */
    async saveManualConfig() {
        const envId = document.getElementById('cfgEnvId')?.value.trim() || '';
        const region = document.getElementById('cfgRegion')?.value || 'ap-shanghai';
        const cloudFnUrl = document.getElementById('cfgCloudFnUrl')?.value.trim() || '';
        const cloudSecret = document.getElementById('cfgCloudSecret')?.value.trim() || '';

        if (!envId) {
            App.toast('环境 ID 不能为空', 'error');
            return;
        }
        if (!envId.startsWith('grandware-') && !envId.match(/^[a-z]+-\d{14}$/i)) {
            App.toast('环境 ID 格式看起来不对，请确认（应该是 xxx-xxxxxxxxxxxxxxxx 这种）', 'error', 5000);
        }

        const ok = Cloud.saveConfig({ envId, region, cloudFnUrl, cloudSecret });
        if (!ok) {
            App.toast('配置保存失败', 'error');
            return;
        }
        App.toast('配置已保存，正在重新连接...', 'success');
        await this.reconnectCloudNow();
    },

    /**
     * 清除手动配置，恢复默认
     */
    async clearManualConfig() {
        App.showConfirm(
            '确定要恢复默认配置吗？\n\n将清除所有手动设置（环境 ID / 区域 / 自定义登录等），恢复为代码内置的默认值。',
            async () => {
                Cloud.clearConfig();
                App.toast('已恢复默认配置，正在重新连接...', 'success');
                await this.reconnectCloudNow();
            }
        );
    },

    /**
     * 测试当前配置（不修改）
     */
    async testManualConfig(event) {
        const btn = event?.target;
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ 测试中...';
        }
        try {
            // 先应用临时配置（不保存）
            const envId = document.getElementById('cfgEnvId')?.value.trim() || Cloud.DEFAULT_ENV_ID;
            const region = document.getElementById('cfgRegion')?.value || Cloud.DEFAULT_REGION;
            const oldEnvId = Cloud.envId;
            const oldRegion = Cloud.region;
            Cloud.envId = envId;
            Cloud.region = region;

            // 重置 app/db 让下次 init 重新创建
            Cloud._app = null;
            Cloud._db = null;
            Cloud._ready = false;

            const result = await Cloud.diagnose();

            // 恢复
            Cloud.envId = oldEnvId;
            Cloud.region = oldRegion;
            Cloud._app = null;
            Cloud._db = null;
            Cloud._ready = false;

            App.toast(
                result.ok ? '✅ 所有步骤通过，配置可用' : '❌ 测试未通过，详情见上方',
                result.ok ? 'success' : 'error',
                4000
            );
        } catch (e) {
            App.toast('测试异常: ' + (e.message || String(e)), 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🧪 测试当前配置';
            }
        }
    },

    /**
     * 运行完整诊断（在主面板显示）
     */
    async runFullDiagnose(event) {
        const statusDiv = document.getElementById('cloudConfigStatus');
        if (!statusDiv) return;
        const btn = event?.target;
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ 诊断中...';
        }
        statusDiv.innerHTML = '<div style="color:var(--primary)">⏳ 正在运行 7 步完整诊断...</div>';

        try {
            // 先重新初始化以确保拿到最新错误
            Cloud.reset();
            const initResult = await Cloud.init();
            const result = await Cloud.diagnose();

            let html = `<div style="margin-bottom:12px">`;
            html += `<strong>完整诊断报告</strong>（共 ${result.log.length} 步）`;
            html += `</div>`;
            html += `<div style="background:var(--gray-50);border-radius:6px;padding:12px;font-size:13px;line-height:1.8">`;
            result.log.forEach((step, i) => {
                const icon = step.ok ? '✅' : '❌';
                const color = step.ok ? 'var(--success)' : 'var(--danger)';
                html += `<div style="margin-bottom:8px">
                    <span style="color:${color};font-weight:600">${icon} ${escapeHtml(step.step)}</span>
                    <div style="margin-left:24px;color:var(--gray-700);font-size:12px;word-break:break-all;font-family:monospace">${escapeHtml(step.detail)}</div>
                </div>`;
            });
            html += `</div>`;
            html += `<div style="margin-top:10px;padding:8px;background:${result.ok ? '#d4edda' : '#f8d7da'};border-radius:6px;font-size:13px;color:${result.ok ? '#155724' : '#721c24'}">
                ${result.ok ? '🎉 所有诊断步骤通过！CloudBase 工作正常。' : '⚠️ 诊断发现问题，请将本页面截图发给开发者排查。'}
            </div>`;
            statusDiv.innerHTML = html;
        } catch (e) {
            statusDiv.innerHTML = `<div style="color:var(--danger);padding:10px;background:#f8d7da;border-radius:6px">❌ 诊断异常: ${escapeHtml(e.message || String(e))}</div>`;
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🧪 完整诊断';
            }
        }
    },

    /**
     * 数据可见性体检（仅 admin/finance）
     * 调用 DB.diagnoseVisibility() 并在设置页渲染归属分布统计
     */
    runVisibilityDiag(event) {
        const el = document.getElementById('visibilityDiagResult');
        if (!el) return;
        const btn = event?.target;
        if (btn) btn.disabled = true;
        try {
            const result = DB.diagnoseVisibility();
            const fmt = obj =>
                Object.entries(obj)
                    .sort((a, b) => b[1] - a[1])
                    .map(
                        ([k, v]) =>
                            `<tr><td style="padding:2px 8px">${escapeHtml(k)}</td><td style="padding:2px 8px;text-align:right">${v}</td></tr>`
                    )
                    .join('') || '<tr><td colspan="2" style="padding:2px 8px;color:var(--gray-500)">无数据</td></tr>';
            const card = (title, body) => `
                <div>
                    <div style="font-weight:600;margin-bottom:4px">${title}</div>
                    <table style="width:100%;border-collapse:collapse;background:var(--gray-50);border-radius:6px;overflow:hidden;font-size:12px">
                        ${body}
                    </table>
                </div>`;
            const warnParts = [];
            if (result.orders.noSalesperson) {
                warnParts.push(`${result.orders.noSalesperson} 条订单无业务员归属（仅 admin/finance/经理可见）`);
            }
            if (result.customers.noSalesperson) {
                warnParts.push(`${result.customers.noSalesperson} 条客户无业务员归属（仅 admin/finance/经理可见）`);
            }
            if (result.orders.noCompany) {
                warnParts.push(`${result.orders.noCompany} 条订单无公司归属（全员可见，建议补上）`);
            }
            el.innerHTML = `
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px">
                    ${card('📦 订单（共 ' + result.orders.total + '）· 按业务员', fmt(result.orders.bySalesperson))}
                    ${card('📦 订单 · 按公司', fmt(result.orders.byCompany))}
                    ${card('👥 客户（共 ' + result.customers.total + '）· 按业务员', fmt(result.customers.bySalesperson))}
                    ${card('👥 客户 · 按公司', fmt(result.customers.byCompany))}
                    ${card('🏭 工厂（共 ' + result.factories.total + '）· 按公司', fmt(result.factories.byCompany))}
                </div>
                ${
                    warnParts.length
                        ? `
                <div class="mt-3" style="padding:10px 12px;background:#fff3cd;border-radius:6px;line-height:1.8">
                    ⚠️ <strong>归属异常提醒</strong>：${warnParts.join('；')}。无归属数据可通过编辑详情补上归属字段。
                </div>`
                        : ''
                }
                <div class="mt-2 text-sm" style="color:var(--gray-600)">
                    💡 B组（为语+Grandware HK）仅能看到 CO-WY / CO-GW 归属的工厂与订单；订单还需业务员归属在团队内。
                </div>
            `;
        } catch (e) {
            el.innerHTML = `<div style="color:var(--danger)">诊断异常: ${escapeHtml(e.message || String(e))}</div>`;
        } finally {
            if (btn) btn.disabled = false;
        }
    }
};

window.Settings = Settings;
