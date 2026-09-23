const { badRequest, notFound } = require('./errors');
const { load, save } = require('./store');
const pricing = require('./pricing');
const zonesMod = require('./zones');
const { findCustomer } = require('./customers');

// 未归属城市的运单：收件城市不在任何分区的城市/别名登记里，
// 存运单时不拦，统一到这里按城市分组管起来，再整城补归属。

function timeText(value) {
  return String(value || '').replace('T', ' ').slice(0, 16);
}

function cityGroups(data) {
  const index = zonesMod.cityIndex(data);
  const map = new Map();
  data.waybills.forEach((waybill) => {
    const city = zonesMod.cleanCity(waybill.toCity);
    if (!city || index.has(city)) return;
    if (!map.has(city)) map.set(city, []);
    map.get(city).push(waybill);
  });
  return map;
}

// 建议归属：优先按城市名相似度（与已登记城市的名称包含关系），
// 再按这批运单同客户的寄件城市指向，最后兜底第一个启用分区。
function suggestZone(data, grouped, city) {
  const enabled = data.zones.filter((zone) => zone.status !== '停用');
  const registered = new Set();
  data.zones.forEach((zone) => {
    (zone.cities || []).forEach((item) => registered.add(zonesMod.cleanCity(item)));
  });

  // 1. 与某个已登记城市同名或名称互相包含，且该城市只属于一个分区
  const nameHits = new Map();
  registered.forEach((name) => {
    if (name === city) return;
    const related = name.length >= 2 && city.length >= 2 &&
      (name.includes(city) || city.includes(name));
    if (!related) return;
    const zone = zonesMod.zoneOfCity(data, name);
    if (zone) nameHits.set(name, zone);
  });
  const distinctNameZones = new Set(Array.from(nameHits.values()).map((zone) => zone.id));
  if (distinctNameZones.size === 1) {
    const zone = Array.from(nameHits.values())[0];
    const names = Array.from(nameHits.keys());
    return {
      zoneId: zone.id,
      reason: '城市名与该分区已登记的「' + names.join('、') + '」名称相近（名称互相包含）',
      reasonCode: 'name-like',
      confidence: 'medium',
    };
  }

  // 2. 这批运单的寄件城市落在哪个分区（同城往返通常与收件城市同分区）
  const shipperHits = new Map();
  grouped.forEach((waybill) => {
    if (zonesMod.cleanCity(waybill.fromCity) === city) return;
    const zone = zonesMod.zoneOfCity(data, waybill.fromCity);
    if (zone) shipperHits.set(zone.id, zone);
  });
  if (shipperHits.size === 1) {
    const zone = Array.from(shipperHits.values())[0];
    const fromCities = Array.from(new Set(
      grouped.map((w) => zonesMod.cleanCity(w.fromCity)).filter((c) => c && c !== city)
    ));
    return {
      zoneId: zone.id,
      reason: '这批运单的寄件城市「' + fromCities.join('、') + '」已登记在该分区，同城往返可参考',
      reasonCode: 'from-city',
      confidence: 'low',
    };
  }

  // 3. 兜底：取第一个启用分区，并说明只是默认建议
  const fallback = enabled[0] || data.zones[0] || null;
  if (fallback) {
    return {
      zoneId: fallback.id,
      reason: '没有名称相近的已登记城市，也没有可参考的寄件城市，暂列第一个启用分区，请人工确认',
      reasonCode: 'fallback-first-enabled',
      confidence: 'low',
    };
  }
  return { zoneId: '', reason: '还没有可用分区，先到分区标签新建分区', reasonCode: 'none', confidence: 'none' };
}

function customerNameOf(data, customerId) {
  const customer = findCustomer(data, customerId);
  return customer ? customer.name : '（客户已删）';
}

function summarizeGroup(data, city, grouped) {
  const sorted = grouped.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const customerIds = Array.from(new Set(grouped.map((waybill) => waybill.customerId))).filter(Boolean);
  const customers = customerIds.map((id) => {
    const customer = findCustomer(data, id);
    return { id, name: customer ? customer.name : '（客户已删）', code: customer ? customer.code : '' };
  });
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const suggest = suggestZone(data, grouped, city);
  const zone = suggest.zoneId ? (data.zones.find((item) => item.id === suggest.zoneId) || null) : null;
  return {
    city,
    count: grouped.length,
    customerIds,
    customers,
    customerText: customers.map((item) => item.name).join('、'),
    firstCreatedAt: first ? first.createdAt : '',
    lastCreatedAt: last ? last.createdAt : '',
    firstCreatedAtText: first ? timeText(first.createdAt) : '',
    lastCreatedAtText: last ? timeText(last.createdAt) : '',
    waybillIds: sorted.map((waybill) => waybill.id),
    suggestion: {
      zoneId: suggest.zoneId,
      zoneCode: zone ? zone.code : '',
      zoneName: zone ? zone.name : '',
      reason: suggest.reason,
      reasonCode: suggest.reasonCode,
      confidence: suggest.confidence,
    },
  };
}

function findGroup(data, city) {
  const groups = cityGroups(data);
  if (!groups.has(city)) return null;
  return summarizeGroup(data, city, groups.get(city));
}

function listUnzoned() {
  const data = load();
  const groups = cityGroups(data);
  const items = Array.from(groups.keys())
    .map((city) => summarizeGroup(data, city, groups.get(city)))
    .sort((a, b) => (b.count - a.count) || String(a.city).localeCompare(String(b.city), 'zh'));
  return {
    groups: items,
    total: items.length,
    waybillCount: items.reduce((sum, item) => sum + item.count, 0),
  };
}

function getUnzonedCity(rawCity) {
  const data = load();
  const city = String(rawCity == null ? '' : rawCity).trim();
  const group = findGroup(data, city);
  if (!group) throw notFound('UNZONED_CITY_NOT_FOUND', '城市「' + city + '」当前没有未归属分区的运单');
  const waybills = group.waybillIds
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  return Object.assign({}, group, {
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      customerId: waybill.customerId,
      customerName: customerNameOf(data, waybill.customerId),
      weightKg: Number(waybill.weightKg),
      volumeM3: Number(waybill.volumeM3),
      pieces: Number(waybill.pieces || 1),
      createdAt: waybill.createdAt,
      createdAtText: timeText(waybill.createdAt),
      billId: waybill.billId || null,
      billCode: (data.bills.find((bill) => bill.id === waybill.billId) || {}).code || '',
      quoteCacheYuan: Number(waybill.quoteCacheYuan) || 0,
    })),
    zoneOptions: data.zones.map((zone) => ({ id: zone.id, code: zone.code, name: zone.name, status: zone.status })),
  });
}

// 逐单试算：落定后每条运单按所选分区算出来的金额
function priceGroupWaybills(data, grouped, zone) {
  const settings = pricing.settingsOf(data);
  return grouped.map((waybill) => {
    const customer = findCustomer(data, waybill.customerId);
    const result = pricing.quoteWaybill(waybill, zone, customer, settings);
    return {
      waybillId: waybill.id,
      code: waybill.code,
      customerId: waybill.customer,
      customerName: customerNameOf(data, waybill.customerId),
      billableKg: result.billableKg,
      amountYuan: result.totalYuan,
      amountText: result.totalYuan.toFixed(2),
      billId: waybill.billId || null,
      quoteCacheYuan: Number(waybill.quoteCacheYuan) || 0,
    };
  });
}

function previewAssign(cityRaw, zoneIdRaw) {
  const data = load();
  const city = String(cityRaw == null ? '' : cityRaw).trim();
  const zoneId = String(zoneIdRaw == null ? '' : zoneIdRaw).trim();
  if (!city) throw badRequest('UNZONED_CITY_REQUIRED', '要指定补归属的城市', { field: 'city' });
  const groups = cityGroups(data);
  if (!groups.has(city)) {
    throw badRequest('UNZONED_CITY_NOT_FOUND', '城市「' + city + '」当前没有未归属分区的运单', { field: 'city' });
  }
  const zone = data.zones.find((item) => item.id === zoneId);
  if (!zone) throw badRequest('ZONE_NOT_FOUND', '选的分区不存在', { field: 'zoneId' });
  const grouped = groups.get(city);
  const lines = priceGroupWaybills(data, grouped, zone);
  const totalYuan = pricing.roundFen(lines.reduce((sum, line) => sum + line.amountYuan, 0));
  // 与之前相比：未归属算不出钱，只能拿运单上之前缓存的计费结果比（正常没有，即全是新增可计费金额）
  const previousYuan = pricing.roundFen(lines.reduce((sum, line) => sum + (line.quoteCacheYuan > 0 ? line.quoteCacheYuan : 0), 0));
  const deltaYuan = pricing.roundFen(totalYuan - previousYuan);
  const locked = grouped.filter((waybill) => waybill.billId);
  return {
    city,
    zoneId: zone.id,
    zoneCode: zone.code,
    zoneName: zone.name,
    count: grouped.length,
    totalYuan,
    previousBasis: previousYuan > 0
      ? '按运单上之前缓存的计费结果合计（' + previousYuan.toFixed(2) + ' 元）对比'
      : '之前该城市未归属分区、算不出运费，对比基准按 0 计，差额即新增可计费金额',
    previousYuan,
    deltaYuan,
    deltaText: (deltaYuan >= 0 ? '+' : '') + deltaYuan.toFixed(2),
    lockedCount: locked.length,
    lockedBillCodes: Array.from(new Set(locked.map((waybill) => {
      const bill = data.bills.find((item) => item.id === waybill.billId);
      return bill ? bill.code : '';
    }).filter(Boolean))),
    lines,
  };
}

function confirmAssign(payload) {
  const data = load();
  const city = String((payload && payload.city) || '').trim();
  const zoneId = String((payload && payload.zoneId) || '').trim();
  const confirmToken = String((payload && payload.confirm) || '').trim();
  if (!city) throw badRequest('UNZONED_CITY_REQUIRED', '要指定补归属的城市', { field: 'city' });
  if (!zoneId) throw badRequest('ZONE_REQUIRED', '要选一个分区', { field: 'zoneId' });
  const groups = cityGroups(data);
  if (!groups.has(city)) {
    throw badRequest('UNZONED_CITY_NOT_FOUND', '城市「' + city + '」当前没有未归属分区的运单', { field: 'city' });
  }
  const grouped = groups.get(city);
  const zone = data.zones.find((item) => item.id === zoneId);
  if (!zone) throw badRequest('ZONE_NOT_FOUND', '选的分区不存在', { field: 'zoneId' });
  if (confirmToken !== 'yes') {
    throw badRequest('CONFIRM_REQUIRED', '补归属要先看预演、再带 confirm=yes 落定', { field: 'confirm' });
  }

  const preview = previewAssign(city, zoneId);
  // 已进账单的运单其账单分区列与金额不会自动重算，先禁止在已出账/已作废账单里的运单做这个操作
  const locked = grouped.filter((waybill) => waybill.billId);
  if (locked.length > 0) {
    const codes = preview.lockedBillCodes.join('、');
    throw badRequest('UNZONED_LOCKED',
      '城市「' + city + '」有 ' + locked.length + ' 条运单已进账单（' + codes + '），账单不会自动重算，请先作废对应账单再补归属',
      { count: locked.length, billCodes: preview.lockedBillCodes });
  }

  // 关键：把城市写进分区的城市登记里，而不是只改运单上的临时标记
  if (!(zone.cities || []).some((item) => zonesMod.cleanCity(item) === city)) {
    zone.cities.push(city);
  }
  // 归属定下来之后，用新分区给这批运单算一遍并刷新计费缓存，
  // 这样分区视图与单条计费看到的都是归属后的结果
  const settings = pricing.settingsOf(data);
  const stampedAt = new Date().toISOString();
  grouped.forEach((waybill) => {
    const customer = findCustomer(data, waybill.customerId);
    const result = pricing.quoteWaybill(waybill, zone, customer, settings);
    waybill.quoteCacheYuan = result.totalYuan;
    waybill.quoteCachedAt = stampedAt;
  });
  save(data);

  const remaining = load();
  return {
    city,
    zoneId: zone.id,
    zoneCode: zone.code,
    zoneName: zone.name,
    count: grouped.length,
    waybillIds: grouped.map((waybill) => waybill.id),
    totalYuan: preview.totalYuan,
    remainingCityCount: cityGroups(remaining).size,
    assignedAt: stampedAt,
  };
}

module.exports = { listUnzoned, getUnzonedCity, previewAssign, confirmAssign, cityGroups };
