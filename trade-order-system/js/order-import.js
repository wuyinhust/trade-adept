/**
 * 订单 Excel 导入模块 — 从 orders.js 拆分
 * 处理 Excel 文件解析、列映射、数据验证和批量导入
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';

function calendarDate(value) {
    return [
        value.getFullYear(),
        String(value.getMonth() + 1).padStart(2, '0'),
        String(value.getDate()).padStart(2, '0')
    ].join('-');
}

export function canWriteFinancials() {
    const permission = typeof Auth.hasCapability === 'function' ? Auth.hasCapability('finance.write') : null;
    return Auth.canSeeFinancials() && permission !== false;
}

export function requiresOverseasPort(company = DB.getCurrentCompany()) {
    return company?.jurisdiction === 'HK' || (!company?.jurisdiction && ['CO-GW', 'CO-LK'].includes(company?.id));
}

export function validateOrderData(value, patch = value, creating = true, company = DB.getCurrentCompany()) {
    const changed = key => creating || Object.hasOwn(patch, key);
    for (const [key, label] of [
        ['customerId', '客户'],
        ['customerOrderNo', '客户订单号'],
        ['contactPerson', '客户联系人'],
        ['loadingPort', '起运港'],
        ['paymentTerms', '付款条件']
    ]) {
        if (changed(key) && !String(value[key] ?? '').trim()) return `${label}不能为空`;
    }
    const validDate = raw =>
        /^\d{4}-\d{2}-\d{2}$/.test(raw || '') &&
        !Number.isNaN(Date.parse(raw)) &&
        new Date(raw).toISOString().slice(0, 10) === raw;
    for (const key of ['orderDate', 'expectedShipDate', 'actualShipDate']) {
        if (changed(key) && ((key === 'orderDate' && !value[key]) || (value[key] && !validDate(value[key])))) {
            return `${key}必须是有效日期`;
        }
    }
    if (
        requiresOverseasPort(company) &&
        (creating || changed('overseasPort')) &&
        !String(value.overseasPort ?? '').trim()
    ) {
        return '香港公司订单须填写海外港口';
    }
    if (changed('orderAmountUSD') && (!Number.isFinite(value.orderAmountUSD) || value.orderAmountUSD <= 0)) {
        return '订单金额必须大于0';
    }
    const enums = {
        status: ['进行中', '已订船', '已取消', '推迟出货'],
        paymentStatus: ['未收款', '部分收款', '已收款'],
        shippingStatus: ['待出运', '已出运', '已到港', '已签收'],
        factoryPaidStatus: ['未付款', '部分付款', '已付清']
    };
    for (const [key, allowed] of Object.entries(enums)) {
        if (changed(key) && Object.hasOwn(value, key) && !allowed.includes(value[key])) return `${key}状态无效`;
    }
    for (const key of [
        'factoryCostRMB',
        'freightCostUSD',
        'insuranceCostUSD',
        'otherCostUSD',
        'paidAmountUSD',
        'factoryPaidRMB'
    ]) {
        if (changed(key) && Object.hasOwn(value, key) && (!Number.isFinite(value[key]) || value[key] < 0)) {
            return `${key}必须为非负数`;
        }
    }
    if (changed('factories')) {
        for (const factory of value.factories || []) {
            if (!factory.factoryId || !String(factory.productType || '').trim()) return '请填写工厂和产品类型';
            if (!Number.isInteger(factory.totalQuantity) || factory.totalQuantity <= 0) return '工厂数量必须是正整数';
            for (const key of ['totalAmount', 'prepayment']) {
                if (Object.hasOwn(factory, key) && (!Number.isFinite(factory[key]) || factory[key] < 0)) {
                    return '工厂金额与预付款必须为非负数';
                }
            }
            if ((factory.prepayment || 0) > (factory.totalAmount || 0)) return '预付款不能超过工厂总金额';
            if (!validDate(factory.inspectionDate) || !validDate(factory.estimatedShipDate)) {
                return '请填写有效的验货和出货日期';
            }
            if (factory.inspectionDate > factory.estimatedShipDate) return '验货日期不能晚于出货日期';
        }
    }
    return '';
}

/**
 * 处理 Excel 文件导入
 * @param {HTMLInputElement} input - file input 元素
 */
export function handleFileImport(input) {
    const resultDiv = document.getElementById('importResult');
    const file = input.files[0];
    if (!file) return;

    resultDiv.innerHTML = '<p style="color:var(--gray-500)">⏳ 正在解析文件...</p>';

    const reader = new FileReader();
    reader.onload = e => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array', cellDates: true });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            if (rows.length < 2) {
                resultDiv.innerHTML = '<p style="color:var(--danger)">❌ 文件为空或只有表头，请检查文件内容</p>';
                return;
            }
            processImportRows(rows, resultDiv);
        } catch (err) {
            resultDiv.innerHTML =
                '<p style="color:var(--danger)">❌ 文件解析失败：' + App.escapeHtml(err.message) + '</p>';
        }
    };
    reader.readAsArrayBuffer(file);
}

/**
 * 处理导入的行数据：解析列映射、验证、创建订单
 * @param {Array[]} rows - Excel 行数组（第一行为表头）
 * @param {HTMLElement} resultDiv - 结果显示区域
 */
export function processImportRows(rows, resultDiv) {
    const isHK = !Exchange.isDomestic(DB.currentCompanyId);
    const legacyRmbFees = DB.getCurrentCompany()?.profitPolicy === 'grandware-v40';
    const customers = DB.getCustomers();
    const today = calendarDate(new Date());

    // Parse header row to build column index map
    const headerRow = rows[0];
    const colMap = {}; // fieldKey -> columnIndex
    const headerErrors = [];

    const fieldPatterns = [
        { key: 'customerName', patterns: ['客户', '客户名称', '客户名', '客户公司'] },
        { key: 'contactPerson', patterns: ['客户联系人', '联系人'] },
        { key: 'customerOrderNo', patterns: ['客户订单号', '客户PO', 'PO号'] },
        { key: 'companyOperationNo', patterns: ['公司操作单号', '操作单号'] },
        { key: 'productName', patterns: ['产品', '产品名称', '品名'] },
        { key: 'orderDate', patterns: ['下单日期', '订单日期'] },
        { key: 'expectedShipDate', patterns: ['预计出运', '预计出运日期', '预计出货'] },
        { key: 'actualShipDate', patterns: ['实际出运', '实际出运日期', '实际出货'] },
        { key: 'orderAmountUSD', patterns: ['订单金额(USD)', '订单金额', '订单金额USD', '金额(USD)', '金额USD'] },
        { key: 'factoryCostRMB', patterns: ['工厂成本(RMB)', '工厂成本(USD)', '工厂成本', '工厂金额'] },
        {
            key: 'freightCostUSD',
            patterns: [
                '运费(USD)',
                '运费',
                '运费USD',
                '货代费(USD)',
                '货代费',
                '货代费(RMB)',
                '货代费(CNY)',
                '运费(RMB)'
            ]
        },
        { key: 'insuranceCostUSD', patterns: ['保险费(USD)', '保险费', '保险(USD)', '退税率(%)', '退税率'] },
        { key: 'otherCostUSD', patterns: ['其他费用(USD)', '其他费用', '其他(USD)', '其他费用(RMB)', '其他费用(CNY)'] },
        { key: 'paymentStatus', patterns: ['收款状态'] },
        { key: 'paidAmountUSD', patterns: ['已收款(USD)', '已收款', '已收款USD'] },
        { key: 'factoryPaidStatus', patterns: ['工厂付款状态', '工厂付款'] },
        { key: 'status', patterns: ['订单状态', '状态'] },
        { key: 'shippingStatus', patterns: ['出运状态'] },
        { key: 'loadingPort', patterns: ['起运港', '装运港', '出货港'] },
        { key: 'destinationPort', patterns: ['目的港', '目的地'] },
        { key: 'overseasPort', patterns: ['海外港口', '中转港'] },
        { key: 'paymentTerms', patterns: ['付款条件', '付款方式', '支付条件'] },
        { key: 'remarks', patterns: ['备注', '说明', '特殊要求'] }
    ];

    const normalizeHeader = value => String(value).trim().replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
    headerRow.forEach((header, idx) => {
        const h = normalizeHeader(header);
        // Match complete aliases first: 客户订单号 must never overwrite 客户.
        const exact = fieldPatterns.filter(fp => fp.patterns.some(p => h === normalizeHeader(p)));
        if (exact.length === 1) {
            const key = exact[0].key;
            if (key === 'factoryCostRMB' && ((isHK && /RMB|CNY/.test(h)) || (!isHK && h.includes('USD')))) {
                headerErrors.push(`第${idx + 1}列“${header}”与当前公司工厂成本币种不符，请下载当前公司的模板`);
                return;
            }
            const feeKeys = ['freightCostUSD', 'insuranceCostUSD', 'otherCostUSD'];
            if (feeKeys.includes(key) && !isHK) {
                const wrongCurrency = legacyRmbFees ? h.includes('USD') : /RMB|CNY|退税率/.test(h);
                if (wrongCurrency) {
                    headerErrors.push(`第${idx + 1}列“${header}”与当前公司核算口径不符，请下载当前公司的模板`);
                    return;
                }
            }
            if (key in colMap) {
                headerErrors.push(`第${idx + 1}列“${header}”与第${colMap[key] + 1}列映射到同一字段，请只保留一列`);
            } else {
                colMap[key] = idx;
            }
            return;
        }
        const partial = fieldPatterns.filter(fp => fp.patterns.some(p => h.includes(normalizeHeader(p))));
        if (exact.length > 1 || partial.length > 1) {
            headerErrors.push(`第${idx + 1}列“${header}”含义不明确，请使用模板中的完整表头`);
        }
    });
    if (headerErrors.length > 0) {
        resultDiv.innerHTML =
            '<p style="color:var(--danger)">❌ 表头存在歧义，尚未导入任何订单：</p>' +
            headerErrors.map(error => `<div>${App.escapeHtml(error)}</div>`).join('');
        return;
    }

    // Validate required columns exist
    if (!('customerName' in colMap)) {
        resultDiv.innerHTML =
            '<p style="color:var(--danger)">❌ 缺少必填列：<strong>客户</strong>（表头需包含"客户"/"客户名称"等）</p>';
        return;
    }
    if (!('orderAmountUSD' in colMap)) {
        resultDiv.innerHTML = '<p style="color:var(--danger)">❌ 缺少必填列：<strong>订单金额(USD)</strong></p>';
        return;
    }

    const dataRows = rows.slice(1);
    const prepared = [];
    const reservedNumbers = new Set(
        DB.data.orders
            .filter(order => order.companyId === DB.currentCompanyId)
            .map(order => String(order.companyOperationNo || '').toUpperCase())
    );
    let skipCount = 0;
    const errors = [];

    dataRows.forEach((row, rowIdx) => {
        const rowNum = rowIdx + 2; // Excel row number (1-indexed header)
        const getVal = key => {
            const idx = colMap[key];
            if (idx === undefined) return '';
            const val = row[idx];
            // Handle date objects from Excel
            if (val instanceof Date && !isNaN(val)) {
                return calendarDate(val);
            }
            return String(val).trim();
        };

        const customerName = getVal('customerName');
        const orderAmountUSDStr = getVal('orderAmountUSD');

        // Skip empty rows
        if (!customerName && !orderAmountUSDStr) {
            skipCount++;
            return;
        }

        // Validate required
        if (!customerName) {
            errors.push(`第${rowNum}行：缺少客户名称`);
            return;
        }
        if (!orderAmountUSDStr || isNaN(Number(orderAmountUSDStr)) || Number(orderAmountUSDStr) <= 0) {
            errors.push(`第${rowNum}行：订单金额无效`);
            return;
        }

        // Match customer
        const customerMatches = customers.filter(c => c.company === customerName);
        const currentCompanyMatches = customerMatches.filter(c => c.companyId === DB.currentCompanyId);
        const candidates = currentCompanyMatches;
        const customer = candidates.length === 1 ? candidates[0] : null;
        if (!customer) {
            errors.push(
                candidates.length > 1
                    ? `第${rowNum}行：客户“${customerName}”有多个匹配，请明确公司主体后再导入`
                    : `第${rowNum}行：客户"${customerName}"未找到，请先在客户管理中创建`
            );
            return;
        }

        // Build order data
        const orderAmountUSD = Number(orderAmountUSDStr);
        const factoryCostRMB = Number(getVal('factoryCostRMB') || 0);
        const freightCostUSD = isHK ? 0 : Number(getVal('freightCostUSD') || 0);
        const insuranceCostUSD = isHK ? 0 : Number(getVal('insuranceCostUSD') || 0);
        const otherCostUSD = Number(getVal('otherCostUSD') || 0);
        const paidAmountUSD = Number(getVal('paidAmountUSD') || 0);
        const orderDate = getVal('orderDate') || today;
        const customerOrderNo = getVal('customerOrderNo');
        let companyOperationNo =
            getVal('companyOperationNo') ||
            DB.generateCompanyOperationNo(DB.currentCompanyId, Auth.currentUser?.id || '');
        if (!getVal('companyOperationNo')) {
            while (reservedNumbers.has(companyOperationNo.toUpperCase())) {
                const match = companyOperationNo.match(/^(.*?)(\d{3,})$/);
                companyOperationNo = match
                    ? match[1] + String(Number(match[2]) + 1).padStart(3, '0')
                    : companyOperationNo + '-2';
            }
        }
        const paymentStatus = getVal('paymentStatus') || '未收款';
        const status = getVal('status') || '进行中';
        const shippingStatus = getVal('shippingStatus') || '待出运';
        const loadingPort = getVal('loadingPort') || '上海港';
        const destinationPort = getVal('destinationPort') || customer.country || '';
        const overseasPort = getVal('overseasPort');
        const paymentTerms = getVal('paymentTerms') || customer.paymentTerms || '';
        const productName = getVal('productName') || '';
        const remarks = getVal('remarks') || '';
        const factoryPaidStatus = getVal('factoryPaidStatus') || '未付款';

        const orderData = {
            customerId: customer.id,
            customerName: customer.company,
            contactPerson:
                getVal('contactPerson') ||
                (customer.contacts?.length === 1 ? customer.contacts[0].name : customer.contact || ''),
            companyId: DB.currentCompanyId,
            factoryId: '',
            factoryIds: [],
            factoryName: '',
            factories: [],
            productCategory: productName,
            productName: productName,
            quantity: 0,
            unit: 'PCS',
            orderDate: orderDate,
            expectedShipDate: getVal('expectedShipDate') || '',
            actualShipDate: getVal('actualShipDate') || null,
            orderAmountUSD: orderAmountUSD,
            factoryCostRMB: factoryCostRMB,
            freightCostUSD: freightCostUSD,
            insuranceCostUSD: insuranceCostUSD,
            otherCostUSD: otherCostUSD,
            paymentStatus: paymentStatus,
            paidAmountUSD: paidAmountUSD,
            status: status,
            shippingStatus: shippingStatus,
            factoryPaidStatus: factoryPaidStatus,
            factoryPaidRMB: 0,
            paymentTerms: paymentTerms,
            loadingPort: loadingPort,
            destinationPort: destinationPort,
            overseasPort: overseasPort,
            remarks: remarks,
            customerOrderNo: customerOrderNo,
            companyOperationNo: companyOperationNo,
            salespersonId: Auth.currentUser ? Auth.currentUser.id : null
        };

        if (!canWriteFinancials()) {
            for (const key of [
                'factoryCostRMB',
                'freightCostUSD',
                'insuranceCostUSD',
                'otherCostUSD',
                'paymentStatus',
                'paidAmountUSD',
                'factoryPaidStatus',
                'factoryPaidRMB'
            ]) {
                delete orderData[key];
            }
        }
        const invalid = validateOrderData(orderData);
        if (invalid || reservedNumbers.has(companyOperationNo.toUpperCase())) {
            errors.push(`第${rowNum}行：${invalid || '操作单号重复（含已删除订单）'}`);
            return;
        }
        reservedNumbers.add(companyOperationNo.toUpperCase());
        prepared.push({ rowNum, value: orderData });
    });

    resultDiv.innerHTML = `<div style="padding:12px;border-radius:8px;margin-top:8px">
        <p class="font-semi">导入预览</p>
        <p data-import-summary>待确认：${prepared.length} 笔；跳过空行：${skipCount} 行；失败：${errors.length} 条</p>
        ${errors.map(error => `<div style="color:var(--danger)">${App.escapeHtml(error)}</div>`).join('')}
        <div style="max-height:260px;overflow:auto"><table><thead><tr><th>行</th><th>操作单号</th><th>客户</th><th>客户订单号</th><th>金额 (USD)</th></tr></thead><tbody>
        ${prepared.map(row => `<tr><td>${row.rowNum}</td><td>${App.escapeHtml(row.value.companyOperationNo)}</td><td>${App.escapeHtml(row.value.customerName)}</td><td>${App.escapeHtml(row.value.customerOrderNo)}</td><td>${App.escapeHtml(row.value.orderAmountUSD)}</td></tr>`).join('')}
        </tbody></table></div>
        <p data-import-save-status>确认后才会创建订单并保存到数据库。</p>
        <button data-import-confirm class="btn btn-primary" ${prepared.length ? '' : 'disabled'}>确认导入 ${prepared.length} 笔</button>
        <button data-import-cancel class="btn btn-secondary">取消</button></div>`;
    const fileInput = document.getElementById('importFileInput');
    const confirm = resultDiv.querySelector('[data-import-confirm]');
    const cancel = resultDiv.querySelector('[data-import-cancel]');
    const summary = resultDiv.querySelector('[data-import-summary]');
    const saveStatus = resultDiv.querySelector('[data-import-save-status]');
    let created = null;
    let saving = false;
    let completed = false;
    cancel.onclick = () => {
        if (!created) App.closeModal();
    };
    confirm.onclick = async () => {
        if (saving || completed) return;
        if (!DB._cloudReady) {
            App.toast('数据库未连接，请稍后重试', 'error');
            return;
        }
        saving = true;
        confirm.disabled = true;
        cancel.disabled = true;
        if (fileInput) fileInput.disabled = true;
        if (!created) {
            created = [];
            for (const row of prepared) {
                try {
                    const order = DB.addOrder({ ...row.value });
                    if (order) created.push(order.id);
                    else errors.push(`第${row.rowNum}行：订单未创建，请检查当前权限与重复操作单号`);
                } catch (error) {
                    errors.push(`第${row.rowNum}行：${error.message}`);
                }
            }
        }
        summary.textContent = `⏳ 待保存：${created.length} 笔；失败：${errors.length} 条`;
        saveStatus.textContent = '正在保存到数据库...';
        let ok = created.length === 0;
        try {
            if (created.length) ok = await DB.flush();
        } catch {
            /* The same IDs remain pending for retry. */
        }
        saving = false;
        if (!ok) {
            saveStatus.textContent = '数据库保存失败，本批订单仍待保存；请重试本批记录。';
            confirm.textContent = '重试保存本批记录';
            confirm.disabled = false;
            App.toast('导入保存失败，草稿已保留', 'error');
            return;
        }
        completed = true;
        summary.textContent = `✅ 成功导入：${created.length} 笔订单；失败：${errors.length} 条`;
        saveStatus.textContent = created.length ? '数据库保存成功' : '没有订单写入数据库';
        confirm.textContent = '完成，刷新列表';
        confirm.disabled = false;
        confirm.onclick = () => {
            App.closeModal();
            window.Orders.renderTable();
        };
        if (fileInput) {
            fileInput.disabled = false;
            fileInput.value = '';
        }
    };
}
