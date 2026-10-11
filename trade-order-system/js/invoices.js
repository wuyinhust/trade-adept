/**
 * 单证管理模块 - 按订单展示发票(CI) + 装箱单(PL)
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate } from './utils.js';

const Invoices = {
    render(container) {
        container.innerHTML = `
            <div class="filter-bar">
                <input type="text" id="invoiceSearchInput" class="filter-input" placeholder="搜索单证号/订单号/客户..." style="width:280px" oninput="Invoices.filter()">
                <select id="filterDocStatus" class="filter-select" onchange="Invoices.filter()">
                    <option value="all">所有状态</option>
                    <option value="待确认">待确认</option>
                    <option value="已确认">已确认</option>
                </select>
                <div style="margin-left:auto">
                    <button class="btn btn-secondary" onclick="Invoices.downloadTemplate()">📋 下载模板</button>
                    <button class="btn btn-secondary" onclick="Invoices.showImportGuide()">📖 导入说明</button>
                    <button class="btn btn-primary" onclick="document.getElementById('invoiceFileInput').click()">📥 导入Excel</button>
                    <button class="btn btn-secondary" onclick="Invoices.exportExcel()">📤 导出Excel</button>
                    <input type="file" id="invoiceFileInput" accept=".xlsx,.xls" style="display:none" onchange="Invoices.importExcel(event)">
                </div>
            </div>

            <div class="stats-grid">
                ${(() => {
                    const all = DB.getInvoices();
                    const ciCount = all.filter(d => d.docType === 'CI').length;
                    const plCount = all.filter(d => d.docType === 'PL').length;
                    const pending = all.filter(d => d.status === '待确认').length;
                    const confirmed = all.filter(d => d.status === '已确认').length;
                    return `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon blue">📄</div></div>
                    <div class="stat-label">发票 (CI)</div>
                    <div class="stat-value">${ciCount}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">📦</div></div>
                    <div class="stat-label">装箱单 (PL)</div>
                    <div class="stat-value">${plCount}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon red">⏳</div></div>
                    <div class="stat-label">待确认</div>
                    <div class="stat-value">${pending}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon green">✅</div></div>
                    <div class="stat-label">已确认</div>
                    <div class="stat-value">${confirmed}</div>
                </div>
                    `;
                })()}
            </div>

            <div class="card">
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>订单号</th>
                                <th>客户</th>
                                <th>发票号 (CI)</th>
                                <th>装箱单号 (PL)</th>
                                <th>日期</th>
                                <th class="text-right">金额(USD)</th>
                                <th>状态</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="invoicesTableBody"></tbody>
                    </table>
                </div>
            </div>
        `;
        this.renderTable();
    },

    filter() {
        const status = document.getElementById('filterDocStatus')?.value || 'all';
        const search = document.getElementById('invoiceSearchInput')?.value || '';
        this.renderTable({ status, search });
    },

    renderTable(filter = {}) {
        const allDocs = DB.getInvoices();
        const tbody = document.getElementById('invoicesTableBody');
        if (!tbody) return;

        // 按订单分组：每个订单合并为一行
        const orderMap = {};
        allDocs.forEach(d => {
            if (!orderMap[d.orderId]) {
                orderMap[d.orderId] = {
                    orderId: d.orderId,
                    customerName: d.customerName,
                    date: d.date,
                    amountUSD: d.amountUSD,
                    ci: null,
                    pl: null
                };
            }
            if (d.docType === 'CI') orderMap[d.orderId].ci = d;
            if (d.docType === 'PL') orderMap[d.orderId].pl = d;
        });
        let rows = Object.values(orderMap);

        // 搜索过滤
        if (filter.search) {
            const q = filter.search.toLowerCase();
            rows = rows.filter(
                r =>
                    r.orderId.toLowerCase().includes(q) ||
                    r.customerName.toLowerCase().includes(q) ||
                    (r.ci && r.ci.docNumber.toLowerCase().includes(q)) ||
                    (r.pl && r.pl.docNumber.toLowerCase().includes(q))
            );
        }

        // 状态过滤
        if (filter.status && filter.status !== 'all') {
            rows = rows.filter(r => {
                const docs = [r.ci, r.pl].filter(Boolean);
                return docs.some(d => d.status === filter.status);
            });
        }

        if (rows.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="8" class="text-center text-gray" style="padding:40px">暂无单证记录</td></tr>';
            return;
        }

        tbody.innerHTML = rows
            .map(r => {
                const ciBadge = r.ci
                    ? `<span class="table-link" onclick="Invoices.showDetail('${r.ci.id}')">${r.ci.docNumber}</span>`
                    : '<span class="text-gray">-</span>';
                const plBadge = r.pl
                    ? `<span class="table-link" onclick="Invoices.showDetail('${r.pl.id}')">${r.pl.docNumber}</span>`
                    : '<span class="text-gray">-</span>';
                // 状态：如果两个单证都已确认则显示已确认，否则显示待确认
                const allConfirmed = [r.ci, r.pl].filter(Boolean).every(d => d.status === '已确认');
                const statusBadge = allConfirmed
                    ? '<span class="badge badge-success">已确认</span>'
                    : '<span class="badge badge-warning">待确认</span>';
                return `
            <tr>
                <td><span class="table-link" onclick="window.location.hash='#/orders/${r.orderId}'">${r.orderId}</span></td>
                <td>${r.customerName}</td>
                <td>${ciBadge}</td>
                <td>${plBadge}</td>
                <td>${App.formatDate(r.date)}</td>
                <td class="text-right font-semi">${App.formatMoney(r.amountUSD, 'USD')}</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="flex gap-2">
                        ${r.ci ? `<button class="btn btn-sm btn-secondary" onclick="Invoices.showDetail('${r.ci.id}')">发票</button>` : ''}
                        ${r.pl ? `<button class="btn btn-sm btn-secondary" onclick="Invoices.showDetail('${r.pl.id}')">装箱单</button>` : ''}
                        <button class="btn btn-sm btn-primary" onclick="Invoices.showImportForOrder('${r.orderId}')">📥 导入</button>
                    </div>
                </td>
            </tr>
            `;
            })
            .join('');
    },

    showDetail(invoiceId) {
        const doc = DB.getInvoice(invoiceId);
        if (!doc) return;
        const order = DB.getOrder(doc.orderId);
        const customer = order ? DB.getCustomer(order.customerId) : null;

        const docTemplates = {
            CI: this.renderCI(doc, order, customer),
            PL: this.renderPL(doc, order, customer)
        };

        const bodyHtml = docTemplates[doc.docType] || '<p>未知单证类型</p>';
        App.showModal(doc.docTypeName + ' - ' + doc.docNumber, bodyHtml, {
            large: true,
            hideFooter: true
        });
    },

    renderCI(doc, order, customer) {
        return `
            <div style="font-family:serif;padding:20px">
                <div style="text-align:center;margin-bottom:30px">
                    <h2 style="font-size:22px;font-weight:700">COMMERCIAL INVOICE</h2>
                    <p style="color:#666">商业发票</p>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px">
                    <div>
                        <p><strong>Invoice No:</strong> ${doc.docNumber}</p>
                        <p><strong>Date:</strong> ${App.formatDate(doc.date)}</p>
                        <p><strong>Contract/Order:</strong> ${doc.orderId}</p>
                    </div>
                    <div style="text-align:right">
                        <p><strong>Shipper:</strong> ${DB.getCurrentCompany()?.name || '您的公司名称'}</p>
                        <p>地址 / Address</p>
                    </div>
                </div>
                <hr style="border:1px solid #ddd;margin:16px 0">
                <div style="margin-bottom:20px">
                    <p><strong>Consignee (收货人):</strong></p>
                    <p>${customer ? customer.company : doc.customerName}</p>
                    <p>${customer ? customer.country : ''}</p>
                </div>
                <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
                    <thead>
                        <tr style="background:#f5f5f5">
                            <th style="border:1px solid #ddd;padding:8px;text-align:left">Marks & Numbers</th>
                            <th style="border:1px solid #ddd;padding:8px;text-align:left">Description of Goods</th>
                            <th style="border:1px solid #ddd;padding:8px;text-align:center">Qty</th>
                            <th style="border:1px solid #ddd;padding:8px;text-align:right">Unit Price</th>
                            <th style="border:1px solid #ddd;padding:8px;text-align:right">Total Amount</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td style="border:1px solid #ddd;padding:8px">N/M</td>
                            <td style="border:1px solid #ddd;padding:8px">${order ? order.productName : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${order ? order.quantity + ' ' + order.unit : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:right">${order ? '$' + (order.orderAmountUSD / order.quantity).toFixed(2) : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:right;font-weight:600">${App.formatMoney(doc.amountUSD, 'USD')}</td>
                        </tr>
                    </tbody>
                </table>
                <div style="text-align:right;margin-bottom:20px">
                    <p style="font-size:18px"><strong>Total: ${App.formatMoney(doc.amountUSD, 'USD')}</strong></p>
                </div>
                <hr style="border:1px solid #ddd;margin:16px 0">
                <div>
                    <p><strong>Country of Origin:</strong> China</p>
                    <p><strong>Terms of Delivery:</strong> FOB ${order ? order.loadingPort : '-'}</p>
                    <p><strong>Payment:</strong> ${order ? order.paymentTerms : '-'}</p>
                </div>
                <div style="margin-top:60px;text-align:right">
                    <p>We hereby certify that the above mentioned goods are of Chinese Origin.</p>
                    <br>
                    <p>Authorized Signature: _______________</p>
                </div>
            </div>
            <div style="text-align:center;margin-top:20px">
                <button class="btn btn-primary" onclick="window.print()">🖨️ 打印 / 保存PDF</button>
                ${doc.status === '待确认' ? `<button class="btn btn-success" onclick="Invoices.confirmDoc('${doc.id}')">✅ 确认单证</button>` : ''}
            </div>
        `;
    },

    renderPL(doc, order, customer) {
        const shipment = order ? DB.getShipmentByOrder(order.id) : null;
        return `
            <div style="font-family:serif;padding:20px">
                <div style="text-align:center;margin-bottom:30px">
                    <h2 style="font-size:22px;font-weight:700">PACKING LIST</h2>
                    <p style="color:#666">装箱单</p>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px">
                    <div>
                        <p><strong>PL No:</strong> ${doc.docNumber}</p>
                        <p><strong>Date:</strong> ${App.formatDate(doc.date)}</p>
                        <p><strong>Order:</strong> ${doc.orderId}</p>
                    </div>
                    <div style="text-align:right">
                        <p><strong>Shipper:</strong> ${DB.getCurrentCompany()?.name || '您的公司名称'}</p>
                    </div>
                </div>
                <hr style="border:1px solid #ddd;margin:16px 0">
                <div style="margin-bottom:20px">
                    <p><strong>Consignee:</strong> ${customer ? customer.company : doc.customerName}</p>
                </div>
                <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
                    <thead>
                        <tr style="background:#f5f5f5">
                            <th style="border:1px solid #ddd;padding:8px">C/No.</th>
                            <th style="border:1px solid #ddd;padding:8px">Description</th>
                            <th style="border:1px solid #ddd;padding:8px;text-align:center">Qty</th>
                            <th style="border:1px solid #ddd;padding:8px;text-align:center">G.W. (kg)</th>
                            <th style="border:1px solid #ddd;padding:8px;text-align:center">N.W. (kg)</th>
                            <th style="border:1px solid #ddd;padding:8px;text-align:center">CBM</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td style="border:1px solid #ddd;padding:8px">1-${Math.ceil((order?.quantity || 1000) / 500)}</td>
                            <td style="border:1px solid #ddd;padding:8px">${order ? order.productName : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${order ? order.quantity + ' ' + order.unit : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${shipment ? shipment.grossWeight.toLocaleString() : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${shipment ? shipment.netWeight.toLocaleString() : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${shipment ? shipment.volume : '-'}</td>
                        </tr>
                    </tbody>
                    <tfoot>
                        <tr style="font-weight:700;background:#f9f9f9">
                            <td style="border:1px solid #ddd;padding:8px" colspan="2">TOTAL</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${order ? order.quantity : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${shipment ? shipment.grossWeight.toLocaleString() : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${shipment ? shipment.netWeight.toLocaleString() : '-'}</td>
                            <td style="border:1px solid #ddd;padding:8px;text-align:center">${shipment ? shipment.volume : '-'}</td>
                        </tr>
                    </tfoot>
                </table>
                <div>
                    <p><strong>Container No:</strong> ${shipment ? shipment.containerNo : '-'}</p>
                    <p><strong>B/L No:</strong> ${shipment ? shipment.blNumber : '-'}</p>
                    <p><strong>Vessel:</strong> ${shipment ? shipment.vessel + ' (' + shipment.voyage + ')' : '-'}</p>
                    <p><strong>Port of Loading:</strong> ${order ? order.loadingPort : '-'}</p>
                    <p><strong>Port of Discharge:</strong> ${order ? order.destinationPort : '-'}</p>
                </div>
                <div style="margin-top:60px;text-align:right">
                    <p>Authorized Signature: _______________</p>
                </div>
            </div>
            <div style="text-align:center;margin-top:20px">
                <button class="btn btn-primary" onclick="window.print()">🖨️ 打印 / 保存PDF</button>
                ${doc.status === '待确认' ? `<button class="btn btn-success" onclick="Invoices.confirmDoc('${doc.id}')">✅ 确认单证</button>` : ''}
            </div>
        `;
    },

    confirmDoc(invoiceId) {
        const doc = DB.getInvoice(invoiceId);
        if (!doc) return;
        DB.data.invoices = DB.data.invoices.map(d => (d.id === invoiceId ? { ...d, status: '已确认' } : d));
        DB.save();
        App.toast('单证已确认');
        App.closeModal();
        this.renderTable();
    },

    print(invoiceId) {
        this.showDetail(invoiceId);
        setTimeout(() => window.print(), 500);
    },

    // ========== 按订单导入箱单发票 ==========

    showImportForOrder(orderId) {
        const order = DB.getOrder(orderId);
        if (!order) {
            App.toast('订单不存在', 'error');
            return;
        }
        const existing = DB.getInvoicesByOrder(orderId);
        const hasCI = existing.some(d => d.docType === 'CI');
        const hasPL = existing.some(d => d.docType === 'PL');
        const customer = DB.getCustomer(order.customerId);

        const bodyHtml = `
            <div style="padding:10px">
                <div style="background:var(--gray-50,#f9f9f9);border-radius:8px;padding:16px;margin-bottom:20px">
                    <div style="display:flex;gap:24px;flex-wrap:wrap">
                        <div><span style="color:#999">订单号：</span><strong>${orderId}</strong></div>
                        <div><span style="color:#999">客户：</span><strong>${customer ? customer.company : order.customerName}</strong></div>
                        <div><span style="color:#999">金额：</span><strong>${App.formatMoney(order.orderAmountUSD, 'USD')}</strong></div>
                    </div>
                    <div style="margin-top:10px;display:flex;gap:12px">
                        <span class="badge ${hasCI ? 'badge-success' : 'badge-warning'}">发票(CI) ${hasCI ? '已有' : '未导入'}</span>
                        <span class="badge ${hasPL ? 'badge-success' : 'badge-warning'}">装箱单(PL) ${hasPL ? '已有' : '未导入'}</span>
                    </div>
                </div>

                <div style="margin-bottom:16px">
                    <p style="margin-bottom:8px"><strong>操作步骤：</strong></p>
                    <ol style="padding-left:20px;line-height:2;color:#555">
                        <li>点击「下载此订单模板」获取 Excel 模板（已预填订单信息）</li>
                        <li>在模板中填写发票号、装箱单号、日期、金额、状态</li>
                        <li>点击「选择文件」上传填写好的 Excel</li>
                        <li>系统自动导入，已有单证将被更新</li>
                    </ol>
                </div>

                <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                    <button class="btn btn-secondary" onclick="Invoices.downloadOrderTemplate('${orderId}')">📋 下载此订单模板</button>
                    <button class="btn btn-primary" onclick="document.getElementById('orderFileInput_${orderId}').click()">📥 选择Excel文件导入</button>
                    <input type="file" id="orderFileInput_${orderId}" accept=".xlsx,.xls" style="display:none" onchange="Invoices.importForOrder('${orderId}', event)">
                </div>

                <div style="margin-top:16px;padding:12px;background:#fff3cd;border-radius:6px;font-size:13px;color:#856404">
                    💡 Excel 文件需包含以下列：<strong>类型</strong>（CI或PL）、<strong>单证号</strong>、<strong>日期</strong>、<strong>金额(USD)</strong>、<strong>状态</strong>（待确认/已确认）。订单号会自动关联，无需填写。
                </div>
            </div>
        `;

        App.showModal('导入箱单发票 - ' + orderId, bodyHtml, {
            large: true,
            footer: '<button class="btn btn-secondary" onclick="App.closeModal()">关闭</button>'
        });
    },

    downloadOrderTemplate(orderId) {
        const order = DB.getOrder(orderId);
        if (!order) return;
        const customer = DB.getCustomer(order.customerId);
        const customerName = customer ? customer.company : order.customerName;
        const today = new Date().toISOString().split('T')[0];

        const template = [
            ['类型', '单证号', '日期', '金额(USD)', '状态'],
            [
                'CI',
                'CI-' + new Date().getFullYear() + '-' + orderId.split('-').pop().padStart(4, '0'),
                today,
                order.orderAmountUSD,
                '待确认'
            ],
            [
                'PL',
                'PL-' + new Date().getFullYear() + '-' + orderId.split('-').pop().padStart(4, '0'),
                today,
                order.orderAmountUSD,
                '待确认'
            ]
        ];
        const ws = XLSX.utils.aoa_to_sheet(template);
        ws['!cols'] = [{ wch: 8 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 10 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, orderId + '_单证');
        XLSX.writeFile(wb, orderId + '_箱单发票模板.xlsx');
        App.toast('模板已下载', 'success');
    },

    importForOrder(orderId, event) {
        const file = event.target.files[0];
        if (!file) return;
        event.target.value = '';

        const order = DB.getOrder(orderId);
        if (!order) {
            App.toast('订单不存在', 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = new Uint8Array(e.target.result);
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

                if (rows.length === 0) {
                    App.toast('Excel 文件中没有数据', 'error');
                    return;
                }

                const customer = DB.getCustomer(order.customerId);
                const customerName = customer ? customer.company : order.customerName;
                const existing = DB.getInvoicesByOrder(orderId);

                let added = 0,
                    updated = 0,
                    skipped = 0;
                const toAdd = [];

                rows.forEach(row => {
                    const docType = (row['类型'] || '').toString().trim().toUpperCase();
                    const docNumber = (row['单证号'] || '').toString().trim();
                    const date = (row['日期'] || '').toString().trim();
                    const amountUSD = parseFloat(row['金额(USD)']) || order.orderAmountUSD;
                    const status = (row['状态'] || '待确认').toString().trim();

                    if (!docType || !docNumber) {
                        skipped++;
                        return;
                    }
                    if (docType !== 'CI' && docType !== 'PL') {
                        skipped++;
                        return;
                    }

                    // 检查是否已有同类型单证
                    const existingDoc = existing.find(d => d.docType === docType);
                    if (existingDoc) {
                        // 更新现有单证
                        Object.assign(existingDoc, {
                            docNumber: docNumber,
                            date: date || existingDoc.date,
                            amountUSD: amountUSD,
                            amountRMB: Math.round(amountUSD * DB.getExchangeRate() * 100) / 100,
                            status: status === '已确认' ? '已确认' : '待确认'
                        });
                        updated++;
                    } else {
                        // 新增
                        toAdd.push({
                            companyId: DB.currentCompanyId,
                            orderId: orderId,
                            customerName: customerName,
                            docType: docType,
                            docTypeName: docType === 'CI' ? '商业发票' : '装箱单',
                            docNumber: docNumber,
                            date: date || new Date().toISOString().split('T')[0],
                            amountUSD: amountUSD,
                            amountRMB: Math.round(amountUSD * DB.getExchangeRate() * 100) / 100,
                            status: status === '已确认' ? '已确认' : '待确认',
                            createdBy: Auth.currentUser ? Auth.currentUser.name : '导入'
                        });
                        added++;
                    }
                });

                // 批量新增
                if (toAdd.length > 0) {
                    DB.bulkAddInvoices(toAdd);
                }
                // ★ 显式 flush（bulkAddInvoices 不再自动 flush）
                DB.flush().then(ok => {
                    if (!ok) App.toast('⚠️ 单证云端保存失败，请勿刷新页面并重试', 'error', 8000);
                });

                if (added === 0 && updated === 0) {
                    App.toast(
                        '没有有效的单证数据可导入' + (skipped > 0 ? `（跳过 ${skipped} 条无效记录）` : ''),
                        'error'
                    );
                    return;
                }

                let msg = `导入完成：新增 ${added} 条`;
                if (updated > 0) msg += `，更新 ${updated} 条`;
                if (skipped > 0) msg += `，跳过 ${skipped} 条无效记录`;
                App.toast(msg, 'success');

                App.closeModal();
                this.render(document.getElementById('pageContent'));
            } catch (err) {
                console.error('Import error:', err);
                App.toast('导入失败：' + err.message, 'error');
            }
        };
        reader.readAsArrayBuffer(file);
    },

    showImportGuide() {
        const bodyHtml = `
            <div style="padding:10px;line-height:1.8">
                <h3 style="margin-bottom:12px">Excel 导入格式说明</h3>
                <p>请先点击「下载模板」获取标准 Excel 模板，按格式填写后导入。</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0">
                    <thead>
                        <tr style="background:var(--gray-100,#f5f5f5)">
                            <th style="border:1px solid #ddd;padding:8px">列名</th>
                            <th style="border:1px solid #ddd;padding:8px">说明</th>
                            <th style="border:1px solid #ddd;padding:8px">示例</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td style="border:1px solid #ddd;padding:8px">类型</td><td style="border:1px solid #ddd;padding:8px">CI（发票）或 PL（装箱单）</td><td style="border:1px solid #ddd;padding:8px">CI</td></tr>
                        <tr><td style="border:1px solid #ddd;padding:8px">订单号</td><td style="border:1px solid #ddd;padding:8px">关联的订单编号</td><td style="border:1px solid #ddd;padding:8px">ORD-0001</td></tr>
                        <tr><td style="border:1px solid #ddd;padding:8px">单证号</td><td style="border:1px solid #ddd;padding:8px">发票号或装箱单号</td><td style="border:1px solid #ddd;padding:8px">CI-2026-0001</td></tr>
                        <tr><td style="border:1px solid #ddd;padding:8px">客户名称</td><td style="border:1px solid #ddd;padding:8px">客户公司名</td><td style="border:1px solid #ddd;padding:8px">ABC Trading Co.</td></tr>
                        <tr><td style="border:1px solid #ddd;padding:8px">日期</td><td style="border:1px solid #ddd;padding:8px">单证日期（YYYY-MM-DD）</td><td style="border:1px solid #ddd;padding:8px">2026-07-28</td></tr>
                        <tr><td style="border:1px solid #ddd;padding:8px">金额(USD)</td><td style="border:1px solid #ddd;padding:8px">单证金额（美元）</td><td style="border:1px solid #ddd;padding:8px">50000.00</td></tr>
                        <tr><td style="border:1px solid #ddd;padding:8px">状态</td><td style="border:1px solid #ddd;padding:8px">待确认 或 已确认</td><td style="border:1px solid #ddd;padding:8px">已确认</td></tr>
                    </tbody>
                </table>
                <p style="color:var(--gray-500,#666);font-size:13px">注意：同一订单可导入 CI 和 PL 两条记录，系统会自动合并显示在一行。</p>
            </div>
        `;
        App.showModal('导入说明', bodyHtml, {
            footer: '<button class="btn btn-primary" onclick="App.closeModal()">知道了</button>'
        });
    },

    downloadTemplate() {
        const template = [
            ['类型', '订单号', '单证号', '客户名称', '日期', '金额(USD)', '状态'],
            ['CI', 'ORD-0001', 'CI-2026-0001', 'ABC Trading Co.', '2026-07-28', 50000.0, '已确认'],
            ['PL', 'ORD-0001', 'PL-2026-0001', 'ABC Trading Co.', '2026-07-28', 50000.0, '已确认'],
            ['CI', 'ORD-0002', 'CI-2026-0002', 'XYZ Import Ltd.', '2026-07-28', 32000.0, '待确认'],
            ['PL', 'ORD-0002', 'PL-2026-0002', 'XYZ Import Ltd.', '2026-07-28', 32000.0, '待确认']
        ];
        const ws = XLSX.utils.aoa_to_sheet(template);
        ws['!cols'] = [{ wch: 8 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 10 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '单证导入模板');
        XLSX.writeFile(wb, '单证导入模板.xlsx');
        App.toast('模板已下载', 'success');
    },

    importExcel(event) {
        const file = event.target.files[0];
        if (!file) return;
        event.target.value = '';

        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = new Uint8Array(e.target.result);
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

                if (rows.length === 0) {
                    App.toast('Excel 文件中没有数据', 'error');
                    return;
                }

                const invoices = [];
                let skipCount = 0;

                rows.forEach((row, idx) => {
                    const docType = (row['类型'] || '').toString().trim().toUpperCase();
                    const orderId = (row['订单号'] || '').toString().trim();
                    const docNumber = (row['单证号'] || '').toString().trim();
                    const customerName = (row['客户名称'] || '').toString().trim();
                    const date = (row['日期'] || '').toString().trim();
                    const amountUSD = parseFloat(row['金额(USD)']) || 0;
                    const status = (row['状态'] || '待确认').toString().trim();

                    if (!docType || !orderId || !docNumber) {
                        skipCount++;
                        return;
                    }
                    if (docType !== 'CI' && docType !== 'PL') {
                        skipCount++;
                        return;
                    }

                    // 检查订单号是否存在
                    const order = DB.getOrder(orderId);
                    const amountRMB = Math.round(amountUSD * DB.getExchangeRate() * 100) / 100;

                    invoices.push({
                        companyId: DB.currentCompanyId,
                        orderId: orderId,
                        customerName: customerName || (order ? order.customerName : ''),
                        docType: docType,
                        docTypeName: docType === 'CI' ? '商业发票' : '装箱单',
                        docNumber: docNumber,
                        date: date || new Date().toISOString().split('T')[0],
                        amountUSD: amountUSD,
                        amountRMB: amountRMB,
                        status: status === '已确认' ? '已确认' : '待确认',
                        createdBy: Auth.currentUser ? Auth.currentUser.name : '导入'
                    });
                });

                if (invoices.length === 0) {
                    App.toast(
                        '没有有效的单证数据可导入' + (skipCount > 0 ? `（跳过 ${skipCount} 条无效记录）` : ''),
                        'error'
                    );
                    return;
                }

                const count = DB.bulkAddInvoices(invoices);
                App.toast(
                    `成功导入 ${count} 条单证` + (skipCount > 0 ? `，跳过 ${skipCount} 条无效记录` : ''),
                    'success'
                );
                this.render(document.getElementById('pageContent'));
                // ★ 显式 flush（bulkAddInvoices 不再自动 flush）
                DB.flush().then(ok => {
                    if (!ok) App.toast('⚠️ 导入的单证云端保存失败，请勿刷新页面并重试', 'error', 8000);
                });
            } catch (err) {
                console.error('Import error:', err);
                App.toast('导入失败：' + err.message, 'error');
            }
        };
        reader.readAsArrayBuffer(file);
    },

    exportExcel() {
        const allDocs = DB.getInvoices();
        const headers = [
            'docNumber',
            'docTypeName',
            'orderId',
            'customerName',
            'date',
            'amountUSD',
            'amountRMB',
            'status'
        ];
        const labels = {
            docNumber: '单证号',
            docTypeName: '单证类型',
            orderId: '订单号',
            customerName: '客户',
            date: '日期',
            amountUSD: '金额(USD)',
            amountRMB: '金额(RMB)',
            status: '状态'
        };
        App.exportExcel(allDocs, '单证列表_' + new Date().toISOString().split('T')[0] + '.xlsx', headers, labels);
    }
};

window.Invoices = Invoices;
