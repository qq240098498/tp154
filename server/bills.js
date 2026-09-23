const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const zones = require('./zones');
const { findCustomer } = require('./customers');

function cleanCity(value) {
  return zones.cleanCity(value);
}

// 账单里的分区判断：与运单计费同一套归属口径（别名优先），查不到就是未归属，
// 不能再静默回退到第一个分区，否则未归属运单会按错误分区出账
function zoneOf(data, city) {
  return zones.zoneOfCity(data, city);
}

// 账期：按运单创建时刻的年月
function periodOf(waybill) {
  const date = new Date(String(waybill.createdAt || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 7);
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 出账计费：同分区的运单合起来算一次首重续重，再按各自的计费重量分摊；
// 一张账单里跨多个分区时，各分区分别合并计价
function priceBill(data, customer, waybills) {
  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  if (waybills.length === 0) return { lines: [], amountYuan: 0, permille };
  const entries = waybills.map((waybill) => ({
    waybill,
    zone: zones.zoneOfCity(data, waybill.toCity),
    weight: pricing.billableWeightKg(waybill, settings),
  }));
  const byZone = new Map();
  entries.forEach((entry) => {
    const key = entry.zone ? entry.zone.id : '';
    if (!byZone.has(key)) byZone.set(key, []);
    byZone.get(key).push(entry);
  });
  const amountByWaybill = new Map();
  let amountYuan = 0;
  byZone.forEach((groupEntries) => {
    const zone = groupEntries[0].zone;
    const weights = groupEntries.map((entry) => entry.weight);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const freightAll = pricing.freightYuan(zone, totalWeight, settings);
    const surchargeAll = groupEntries.reduce(
      (sum, entry) => sum + pricing.surchargeYuan(zone, entry.waybill, entry.weight, settings), 0
    );
    amountYuan += (freightAll + surchargeAll) * permille / 1000;
    groupEntries.forEach((entry) => {
      const share = totalWeight > 0 ? entry.weight / totalWeight : 0;
      const raw = (freightAll * share + pricing.surchargeYuan(zone, entry.waybill, entry.weight, settings)) * permille / 1000;
      const cached = Number(entry.waybill.quoteCacheYuan);
      amountByWaybill.set(entry.waybill.id, cached > 0 ? cached : pricing.roundFen(raw));
    });
  });
  const lines = waybills.map((waybill, index) => ({
    waybillId: waybill.id,
    code: waybill.code,
    toCity: waybill.toCity,
    zoneName: entries[index].zone ? entries[index].zone.name : '',
    billableKg: entries[index].weight,
    amountYuan: amountByWaybill.get(waybill.id),
    fromCache: Number(waybill.quoteCacheYuan) > 0,
  }));
  pricing.alignLineAmounts(lines, amountYuan);
  return { lines, amountYuan: pricing.roundFen(amountYuan), permille };
}

function summarizeBill(bill, data) {
  const customer = findCustomer(data, bill.customerId);
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  const lineSum = lines.reduce((sum, line) => sum + Number(line.amountYuan || 0), 0);
  const waybills = (bill.waybillIds || [])
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    lines: lines.map((line) => Object.assign({}, line, {
      amountText: Number(line.amountYuan || 0).toFixed(2),
      billableText: Number(line.billableKg).toFixed(2) + ' kg',
    })),
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      weightKg: Number(waybill.weightKg),
      createdAt: waybill.createdAt,
      quoteCacheYuan: waybill.quoteCacheYuan,
    })),
  });
}

function listBills(query) {
  const data = load();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  let bills = data.bills.map((bill) => summarizeBill(bill, data));
  if (customerId) bills = bills.filter((bill) => bill.customerId === customerId);
  if (status) bills = bills.filter((bill) => bill.status === status);
  bills.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.code).localeCompare(String(a.code)));
  return {
    bills,
    total: bills.length,
    issued: bills.filter((bill) => bill.status === '已出账').length,
    voided: bills.filter((bill) => bill.status === '已作废').length,
  };
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) || null;
}

function getBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  return summarizeBill(bill, data);
}

function generateBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户没有可以出账的运单', { field: 'period' });
  const unknownCities = Array.from(new Set(
    targets
      .filter((waybill) => !zones.zoneOfCity(data, waybill.toCity))
      .map((waybill) => cleanCity(waybill.toCity))
  ));
  if (unknownCities.length > 0) {
    throw badRequest('BILL_HAS_UNZONED_WAYBILL',
      '有 ' + unknownCities.length + ' 个收件城市还没归属分区（' + unknownCities.join('、') + '），先到「补归属」把城市归到分区再出账',
      { field: 'period', cities: unknownCities });
  }
  const priced = priceBill(data, customer, targets);
  const samePeriod = data.bills.filter((bill) => bill.period === period && bill.customerId === customerId).length;
  const bill = {
    id: nextId('bill', data.bills),
    code: 'ZD' + period.replace('-', '') + '-' + customer.code + String(samePeriod + 1).padStart(2, '0'),
    period,
    customerId,
    status: '已出账',
    createdAt: new Date().toISOString(),
    waybillIds: targets.map((waybill) => waybill.id),
    lines: priced.lines,
    amountYuan: priced.amountYuan,
    discountPermille: priced.permille,
  };
  data.bills.push(bill);
  targets.forEach((waybill) => {
    waybill.billId = bill.id;
  });
  save(data);
  return summarizeBill(bill, load());
}

function voidBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  if (bill.status === '已作废') throw badRequest('BILL_ALREADY_VOID', '这张账单已经作废了');
  bill.status = '已作废';
  bill.voidedAt = new Date().toISOString();
  save(data);
  return summarizeBill(bill, load());
}

function listPeriods() {
  const data = load();
  const periods = new Set();
  data.waybills.forEach((waybill) => {
    const period = periodOf(waybill);
    if (period) periods.add(period);
  });
  data.bills.forEach((bill) => periods.add(bill.period));
  return { periods: Array.from(periods).sort() };
}

module.exports = { listBills, getBill, generateBill, voidBill, listPeriods, periodOf, zoneOf };
