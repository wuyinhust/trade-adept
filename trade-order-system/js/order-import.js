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

export function validCalendarDate(raw) {
    return (
        /^\d{4}-\d{2}-\d{2}$/.test(raw || '') &&
        !Number.isNaN(Date.parse(raw)) &&
        new Date(raw).toISOString().slice(0, 10) === raw
    );
}

export function validateNativeProductionPlan(previous, next) {
    if (previous.length !== next.length || new Set(next.map(row => String(row.factoryId))).size !== next.length) {
        return '正式订单不能通过生产计划移除或重复供应商';
    }
    for (const row of next) {
        const prior = previous.find(item => String(item.factoryId) === String(row.factoryId));
        if (!prior) return '正式订单不能通过生产计划新增供应商';
        if (row.productType !== prior.productType && !String(row.productType || '').trim()) return '产品类型不能为空';
        for (const key of ['inspectionDate', 'estimatedShipDate']) {
            if (row[key] !== prior[key] && row[key] && !validCalendarDate(row[key])) {
                return '生产计划日期必须是有效日期';
            }
        }
        if (
            (row.inspectionDate !== prior.inspectionDate || row.estimatedShipDate !== prior.estimatedShipDate) &&
            row.inspectionDate &&
            row.estimatedShipDate &&
            row.inspectionDate > row.estimatedShipDate
        ) {
            return '验货日期不能晚于预计出货日期';
        }
    }
    return '';
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
    const validDate = validCalendarDate;
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
            processImportRows(rows, resultDiv, {
                importPurpose: document.getElementById('importPurpose')?.value || 'order-brief'
            });
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
export function processImportRows(rows, resultDiv, { importPurpose = 'order-brief' } = {}) {
    if (
        !['order-brief', 'historical-reference'].includes(importPurpose) ||
        (importPurpose === 'historical-reference' && !canWriteFinancials())
    ) {
        resultDiv.innerHTML = '<p class="text-danger">历史参考导入需要财务写入权限，请核对导入用途。</p>';
        return;
    }
    const historical = importPurpose === 'historical-reference';
    const expectedVersion = DB._cloudVersion;
    const isHK = !Exchange.isDomestic(DB.currentCompanyId);
    const legacyRmbFees = DB.getCurrentCompany()?.profitPolicy === 'grandware-v40';
    const customers = DB.getCustomers();
    const today = calendarDate(new Date());

    // Parse header row to build column index map
    const headerRow = rows[0];
    const colMap = {}; // fieldKey -> columnIndex
    const headerErrors = [];

    const fieldPatterns = [
        { key: 'id', patterns: ['订单号', '订单ID', '记录ID', 'id'] },
        { key: 'companyId', patterns: ['法人主体ID', '公司主体ID', '公司ID', 'companyId'] },
        { key: 'customerName', patterns: ['客户', '客户名称', '客户名', '客户公司'] },
        { key: 'contactPerson', patterns: ['客户联系人', '联系人'] },
        { key: 'customerOrderNo', patterns: ['客户订单号', '客户PO', 'PO号'] },
        { key: 'companyOperationNo', patterns: ['公司操作单号', '操作单号'] },
        { key: 'productName', patterns: ['产品', '产品名称', '品名'] },
        { key: 'orderDate', patterns: ['下单日期', '订单日期'] },
        { key: 'expectedShipDate', patterns: ['预计出运', '预计出运日期', '预计出货'] },
        { key: 'actualShipDate', patterns: ['实际出运', '实际出运日期', '实际出货'] },
        { key: 'orderAmountUSD', patterns: ['订单金额(USD)', '订单金额', '订单金额USD', '金额(USD)', '金额USD'] },
        { key: 'orderAmountRMB', patterns: ['结算收入(结算币种)', '订单金额(RMB)', '订单金额(CNY)'] },
        { key: 'profitRMB', patterns: ['利润(结算币种)', '利润(RMB)', '利润(CNY)'] },
        { key: 'profitUSD', patterns: ['利润(USD)'] },
        { key: 'profitRate', patterns: ['利润率(%)', '利润率'] },
        {
            key: 'factoryCostRMB',
            patterns: ['工厂成本(RMB)', '工厂成本(USD)', '工厂成本(结算币种)', '工厂成本', '工厂金额']
        },
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
                '运费(RMB)',
                '货代/运费(费用币种)'
            ]
        },
        {
            key: 'insuranceCostUSD',
            patterns: ['保险费(USD)', '保险费', '保险(USD)', '退税率(%)', '退税率', '退税率/保险费(原始值)']
        },
        {
            key: 'otherCostUSD',
            patterns: ['其他费用(USD)', '其他费用', '其他(USD)', '其他费用(RMB)', '其他费用(CNY)', '其他费用(费用币种)']
        },
        { key: 'paymentStatus', patterns: ['收款状态'] },
        { key: 'paidAmountUSD', patterns: ['已收款(USD)', '已收款', '已收款USD'] },
        { key: 'factoryPaidStatus', patterns: ['工厂付款状态', '工厂付款', '工厂收款状态'] },
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
    if (!('customerName' in colMap) && !('id' in colMap) && !('companyOperationNo' in colMap)) {
        resultDiv.innerHTML =
            '<p style="color:var(--danger)">❌ 缺少必填列：<strong>客户</strong>（表头需包含"客户"/"客户名称"等）</p>';
        return;
    }
    if (!('orderAmountUSD' in colMap) && !('id' in colMap) && !('companyOperationNo' in colMap)) {
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
    const seenRecordIds = new Set();
    let skipCount = 0;
    const errors = [];

    dataRows.forEach((row, rowIdx) => {
        const rowNum = rowIdx + 2; // Excel row number (1-indexed header)
        const getVal = key => {
            const idx = colMap[key];
            if (idx === undefined) return '';
            const val = row[idx];
            if (val === undefined || val === null) return '';
            // Handle date objects from Excel
            if (val instanceof Date && !isNaN(val)) {
                return calendarDate(val);
            }
            return String(val).trim();
        };

        const customerName = getVal('customerName');
        const orderAmountUSDStr = getVal('orderAmountUSD');
        const sourceId = getVal('id');
        if (sourceId && !/^[\p{L}\p{N}_.:-]{1,200}$/u.test(sourceId)) {
            errors.push(`第${rowNum}行：记录 ID 仅支持字母、数字及 ._:-，长度不得超过 200`);
            return;
        }
        const suppliedNumber = getVal('companyOperationNo');
        if (getVal('companyId') && getVal('companyId') !== DB.currentCompanyId) {
            errors.push(`第${rowNum}行：法人主体与当前工作区选择不一致，请切换到对应法人后导入`);
            return;
        }
        const byId = sourceId ? DB.data.orders.find(order => String(order.id) === sourceId) : null;
        const numberMatches = suppliedNumber
            ? DB.data.orders.filter(
                  order =>
                      String(order.companyId) === String(DB.currentCompanyId) &&
                      String(order.companyOperationNo || '')
                          .trim()
                          .toUpperCase() === suppliedNumber.toUpperCase()
              )
            : [];
        if ((!byId && numberMatches.length > 1) || (sourceId && !byId && numberMatches.length)) {
            errors.push(`第${rowNum}行：记录 ID 与操作单号不能唯一对应，请核对现有记录`);
            return;
        }
        const existing = byId || numberMatches[0];
        if (existing) {
            if (
                String(existing.companyId) !== String(DB.currentCompanyId) ||
                existing.deleted ||
                seenRecordIds.has(String(existing.id))
            ) {
                errors.push(`第${rowNum}行：记录不属于当前法人、已删除或在本批次重复出现`);
                return;
            }
            if (historical && existing.stage && existing.stage !== 'legacy') {
                errors.push(`第${rowNum}行：待完善或正式订单不能改为历史参考`);
                return;
            }
            const numericFields = new Set([
                'orderAmountUSD',
                'orderAmountRMB',
                'profitRMB',
                'profitUSD',
                'profitRate',
                'factoryCostRMB',
                'freightCostUSD',
                'insuranceCostUSD',
                'otherCostUSD',
                'paidAmountUSD',
                'factoryPaidRMB'
            ]);
            const financeFields = new Set(
                [...numericFields]
                    .filter(key => key !== 'orderAmountUSD')
                    .concat(['paymentStatus', 'factoryPaidStatus'])
            );
            const patch = {};
            for (const key of Object.keys(colMap)) {
                if (['id', 'companyId', 'customerName'].includes(key)) continue;
                const raw = getVal(key);
                if (
                    raw === '' ||
                    (financeFields.has(key) && !canWriteFinancials()) ||
                    (!historical && ['orderAmountRMB', 'profitRMB', 'profitUSD', 'profitRate'].includes(key))
                ) {
                    continue;
                }
                const value = numericFields.has(key) ? Number(raw) : raw;
                if (numericFields.has(key) && !Number.isFinite(value)) {
                    errors.push(`第${rowNum}行：金额或利润必须为有限数值`);
                    return;
                }
                if (JSON.stringify(value) !== JSON.stringify(existing[key])) patch[key] = value;
            }
            if (
                customerName &&
                customerName !== (existing.customerName || DB.getCustomer(existing.customerId)?.company || '')
            ) {
                const matches = customers.filter(
                    customer =>
                        customer.company === customerName && String(customer.companyId) === String(existing.companyId)
                );
                if (matches.length !== 1) {
                    errors.push(`第${rowNum}行：修改后的客户必须在当前法人下唯一匹配`);
                    return;
                }
                patch.customerId = matches[0].id;
                patch.customerName = matches[0].company;
            }
            if (suppliedNumber && numberMatches.some(order => String(order.id) !== String(existing.id))) {
                errors.push(`第${rowNum}行：操作单号已由其他记录使用`);
                return;
            }
            if (
                existing.stage === 'native' &&
                [
                    'customerId',
                    'customerOrderNo',
                    'orderDate',
                    'expectedShipDate',
                    'actualShipDate',
                    'shippingStatus',
                    'orderAmountUSD',
                    'factoryCostRMB',
                    'paidAmountUSD',
                    'paymentStatus',
                    'factoryPaidStatus',
                    'factoryPaidRMB'
                ].some(key => Object.hasOwn(patch, key))
            ) {
                errors.push(`第${rowNum}行：正式订单的客户、金额和收款由业务单据维护，请使用对应业务操作`);
                return;
            }
            if (existing.stage === 'native' && patch.status === '已取消') {
                errors.push(`第${rowNum}行：正式订单须通过撤销业务单据处理`);
                return;
            }
            const invalid = validateOrderData({ ...existing, ...patch }, patch, false, DB.getCurrentCompany());
            if (invalid) {
                errors.push(`第${rowNum}行：${invalid}`);
                return;
            }
            seenRecordIds.add(String(existing.id));
            if (!Object.keys(patch).length) {
                skipCount++;
                return;
            }
            prepared.push({
                rowNum,
                id: existing.id,
                mode: 'update',
                value: patch,
                display: { ...existing, ...patch }
            });
            return;
        }

        // Skip empty rows
        if (!customerName && !orderAmountUSDStr && !sourceId && !suppliedNumber) {
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
        if (historical && !suppliedNumber) {
            errors.push(`第${rowNum}行：历史参考须提供原始公司操作单号，不会自动编造编号`);
            return;
        }
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
        if (historical) {
            for (const key of ['orderAmountRMB', 'profitRMB', 'profitUSD', 'profitRate']) {
                if (getVal(key) !== '') {
                    if (!Number.isFinite(Number(getVal(key)))) {
                        errors.push(`第${rowNum}行：历史金额或利润必须为有限数值`);
                        return;
                    }
                    orderData[key] = Number(getVal(key));
                }
            }
            for (const key of Object.keys(orderData)) {
                if (['customerId', 'customerName', 'companyId', 'companyOperationNo', 'orderAmountUSD'].includes(key)) {
                    continue;
                }
                if (!(key in colMap) || getVal(key) === '') delete orderData[key];
            }
        } else if (paidAmountUSD > 0 || (getVal('paymentStatus') && getVal('paymentStatus') !== '未收款')) {
            errors.push(`第${rowNum}行：新业务订单不能导入累计收款；已有 Excel 余额请选择历史参考用途`);
            return;
        }
        const invalid = validateOrderData(orderData, orderData, !historical);
        if (invalid || reservedNumbers.has(companyOperationNo.toUpperCase())) {
            errors.push(`第${rowNum}行：${invalid || '操作单号重复（含已删除订单）'}`);
            return;
        }
        reservedNumbers.add(companyOperationNo.toUpperCase());
        const id = sourceId || 'ORD-' + crypto.randomUUID();
        if (seenRecordIds.has(id)) {
            errors.push(`第${rowNum}行：记录 ID 在本批次重复出现`);
            return;
        }
        seenRecordIds.add(id);
        prepared.push({ rowNum, id, mode: 'create', value: orderData, display: orderData });
    });

    resultDiv.innerHTML = `<div style="padding:12px;border-radius:8px;margin-top:8px">
        <p class="font-semi">导入预览 · ${historical ? '历史参考（累计余额不生成账务）' : '待完善订单 / 维护现有记录'}</p>
        <p data-import-summary>待确认：${prepared.length} 笔；跳过空行：${skipCount} 行；失败：${errors.length} 条</p>
        ${errors.map(error => `<div style="color:var(--danger)">${App.escapeHtml(error)}</div>`).join('')}
        <div style="max-height:260px;overflow:auto"><table><thead><tr><th>行</th><th>操作</th><th>操作单号</th><th>客户</th><th>客户订单号</th><th>金额 (USD)</th></tr></thead><tbody>
        ${prepared.map(row => `<tr><td>${row.rowNum}</td><td>${row.mode === 'update' ? '更新' : '新增'}</td><td>${App.escapeHtml(row.display.companyOperationNo || row.id)}</td><td>${App.escapeHtml(row.display.customerName)}</td><td>${App.escapeHtml(row.display.customerOrderNo)}</td><td>${App.escapeHtml(row.display.orderAmountUSD)}</td></tr>`).join('')}
        </tbody></table></div>
        <p data-import-save-status>确认后才会将本批新增与修改一并保存；空白单元格不会清除现有值。</p>
        <button data-import-confirm class="btn btn-primary" ${prepared.length ? '' : 'disabled'}>确认导入 ${prepared.length} 笔</button>
        <button data-import-cancel class="btn btn-secondary">取消</button></div>`;
    const fileInput = document.getElementById('importFileInput');
    const purposeInput = document.getElementById('importPurpose');
    if (purposeInput) purposeInput.disabled = true;
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
        if (DB._businessAPI) {
            saveStatus.textContent = '正在保存已确认的导入批次...';
            try {
                await DB._businessAPI.importOrders(
                    prepared.map(row => ({ collection: 'orders', id: row.id, value: row.value })),
                    { expectedVersion, importPurpose }
                );
                completed = true;
                summary.textContent = `✅ 成功导入：${prepared.length} 笔订单；失败：${errors.length} 条`;
                saveStatus.textContent = '数据库保存成功，请刷新列表读取业务数据';
                confirm.textContent = '完成，刷新列表';
                confirm.disabled = false;
                confirm.onclick = async () => {
                    App.closeModal();
                    try {
                        await DB._initFromBusinessAPI();
                        window.Orders.renderTable();
                    } catch (error) {
                        DB._handleSaveFailure(error);
                    }
                };
                cancel.onclick = confirm.onclick;
            } catch (error) {
                if (error.code === 'CONFLICT') DB._handleSaveFailure(error);
                saveStatus.textContent =
                    error.code === 'CONFLICT'
                        ? '业务版本已更新，请保留原始文件并核对数据库后重新预览；当前批次不会覆盖新版本。'
                        : `导入尚未确认保存：${error.message}。本批次仍保留在预览中，未加入自动保存草稿。`;
                confirm.textContent = '重试本批导入';
                confirm.disabled = error.code === 'CONFLICT';
                App.toast(error.message || '导入保存失败', 'error');
            } finally {
                saving = false;
                cancel.disabled = false;
            }
            return;
        }
        if (!created) {
            created = [];
            for (const row of prepared) {
                try {
                    const order =
                        row.mode === 'update'
                            ? DB.updateOrder(row.id, { ...row.value })
                            : DB.addOrder({ ...row.value });
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
