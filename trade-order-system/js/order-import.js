/**
 * 订单 Excel 导入模块 — 从 orders.js 拆分
 * 处理 Excel 文件解析、列映射、数据验证和批量导入
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';

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
    const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
    const customers = DB.getCustomers();
    const today = new Date().toISOString().split('T')[0];

    // Parse header row to build column index map
    const headerRow = rows[0];
    const colMap = {}; // fieldKey -> columnIndex
    const headerIndexMap = {}; // columnIndex -> fieldKey

    const fieldPatterns = [
        { key: 'customerName', patterns: ['客户', '客户名称', '客户名', '客户公司'] },
        { key: 'customerOrderNo', patterns: ['客户订单号', '客户PO', 'PO号'] },
        { key: 'companyOperationNo', patterns: ['公司操作单号', '操作单号'] },
        { key: 'productName', patterns: ['产品', '产品名称', '品名'] },
        { key: 'orderDate', patterns: ['下单日期', '订单日期'] },
        { key: 'expectedShipDate', patterns: ['预计出运', '预计出运日期', '预计出货'] },
        { key: 'actualShipDate', patterns: ['实际出运', '实际出运日期', '实际出货'] },
        { key: 'orderAmountUSD', patterns: ['订单金额(USD)', '订单金额', '订单金额USD', '金额(USD)', '金额USD'] },
        { key: 'factoryCostRMB', patterns: ['工厂成本(RMB)', '工厂成本(USD)', '工厂成本', '工厂金额'] },
        { key: 'freightCostUSD', patterns: ['运费(USD)', '运费', '运费USD', '货代费(USD)', '货代费'] },
        { key: 'insuranceCostUSD', patterns: ['保险费(USD)', '保险费', '保险(USD)'] },
        { key: 'otherCostUSD', patterns: ['其他费用(USD)', '其他费用', '其他(USD)'] },
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

    headerRow.forEach((header, idx) => {
        const h = String(header).trim();
        for (const fp of fieldPatterns) {
            if (fp.patterns.some(p => h === p || h.includes(p))) {
                colMap[fp.key] = idx;
                headerIndexMap[idx] = fp.key;
                break;
            }
        }
    });

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

    const dataRows = rows.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
    let successCount = 0;
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
                return val.toISOString().split('T')[0];
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
        if (!orderAmountUSDStr || isNaN(parseFloat(orderAmountUSDStr)) || parseFloat(orderAmountUSDStr) <= 0) {
            errors.push(`第${rowNum}行：订单金额无效`);
            return;
        }

        // Match customer
        const customer = customers.find(c => c.company === customerName);
        if (!customer) {
            errors.push(`第${rowNum}行：客户"${customerName}"未找到，请先在客户管理中创建`);
            return;
        }

        // Build order data
        const orderAmountUSD = parseFloat(orderAmountUSDStr);
        const factoryCostRMB = parseFloat(getVal('factoryCostRMB')) || 0;
        const freightCostUSD = isHK ? 0 : parseFloat(getVal('freightCostUSD')) || 0;
        const insuranceCostUSD = isHK ? 0 : parseFloat(getVal('insuranceCostUSD')) || 0;
        const otherCostUSD = parseFloat(getVal('otherCostUSD')) || 0;
        const paidAmountUSD = parseFloat(getVal('paidAmountUSD')) || 0;
        const orderDate = getVal('orderDate') || today;
        const customerOrderNo = getVal('customerOrderNo');
        const companyOperationNo =
            getVal('companyOperationNo') ||
            DB.generateCompanyOperationNo(DB.currentCompanyId, Auth.currentUser?.id || '');
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

        try {
            DB.addOrder(orderData);
            successCount++;
        } catch (err) {
            errors.push(`第${rowNum}行：创建失败 - ${err.message}`);
        }
    });

    // Build result HTML
    let resultHtml = '<div style="padding:12px;border-radius:8px;margin-top:8px">';
    resultHtml += '<p style="font-size:15px;font-weight:600;margin-bottom:8px">📊 导入结果</p>';
    resultHtml += `<p>✅ 成功导入：<strong style="color:var(--success)">${successCount}</strong> 笔订单</p>`;
    if (skipCount > 0) {
        resultHtml += `<p>⏭️ 跳过空行：<strong>${skipCount}</strong> 行</p>`;
    }
    if (errors.length > 0) {
        resultHtml += `<p>❌ 失败：<strong style="color:var(--danger)">${errors.length}</strong> 条</p>`;
        resultHtml +=
            '<div style="max-height:200px;overflow-y:auto;margin-top:8px;padding:8px;background:var(--gray-50);border-radius:6px;font-size:12px;line-height:1.8">';
        errors.forEach(e => {
            resultHtml += `<div style="color:var(--danger)">${App.escapeHtml(e)}</div>`;
        });
        resultHtml += '</div>';
    }
    resultHtml += '</div>';

    if (successCount > 0) {
        resultHtml +=
            '<button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="App.closeModal();Orders.renderTable()">✅ 完成，刷新列表</button>';
    }

    resultDiv.innerHTML = resultHtml;
    // Reset file input so same file can be re-imported
    document.getElementById('importFileInput').value = '';

    // ★ 显式 flush（addOrder 不再自动 flush）
    if (successCount > 0) {
        DB.flush().then(ok => {
            if (!ok) {
                App.toast('⚠️ 导入的订单云端保存失败，请勿刷新页面并重试', 'error', 8000);
            }
        });
    }
}
