// 未归属城市补归属：分组视图、建议分区、预演与确认落定
// 落定时把城市写进分区的 cities 登记（正式的城市→分区登记），
// 并在分区上留一条 assignments 补归属登记（什么时候、按什么依据办的、压了多少票）。
const { badRequest, notFound } = require('./errors');
const { load, save } = require('./store');
const pricing = require('./pricing');
const zonesMod = require('./zones');
const { findCustomer } = require('./customers');
const { periodOf } = require('./bills');

function money(value) {
  return pricing.roundFen(Number(value) || 0);
}

// 找出所有 toCity 没落在任何分区的运单（别名也算登记的一种，命中即已归属）
function unassignedWaybills(data) {
  const index = zonesMod.cityIndex(data);
  return data.waybills.filter((waybill) => !index.has(zonesMod.cleanCity(waybill.toCity)));
}

function billIsActive(data, billId) {
  const bill = data.bills.find((item) => item.id === billId);
  return Boolean(bill && bill.status === '已出账');
}

// 按收件城市分组，汇总条数、客户、最早/最晚创建时刻、账期、入账情况
function groupByCity(data, items) {
  const map = new Map();
  items.forEach((waybill) => {
    const city = zonesMod.cleanCity(waybill.toCity);
    if (!map.has(city)) {
      map.set(city, {
        city,
        waybills: [],
        customers: new Map(),
        minCreatedAt: '',
        maxCreatedAt: '',
        lockedCount: 0,
        activeBillCount: 0,
        periods: new Set(),
        billIds: new Set(),
      });
    }
    const group = map.get(city);
    group.waybills.push(waybill);
    const customer = findCustomer(data, waybill.customerId);
    const known = customer || { id: waybill.customerId, code: '', name: '（客户已删）' };
    const prev = group.customers.get(known.id);
    group.customers.set(known.id, {
      id: known.id,
      code: known.code || '',
      name: known.name,
      count: (prev ? prev.count : 0) + 1,
    });
    const created = String(waybill.createdAt || '');
    if (!group.minCreatedAt || created.localeCompare(group.minCreatedAt) < 0) group.minCreatedAt = created;
    if (!group.maxCreatedAt || created.localeCompare(group.maxCreatedAt) > 0) group.maxCreatedAt = created;
    const period = periodOf(waybill);
    if (period) group.periods.add(period);
    if (waybill.billId) {
      group.lockedCount += 1;
      group.billIds.add(waybill.billId);
      if (billIsActive(data, waybill.billId)) group.activeBillCount += 1;
    }
  });
  return map;
}

// 同客户其他运单最常落入哪些分区（排除未归属票与本城市）
function customerTraffic(data, customerId, city) {
  const tally = new Map();
  data.waybills.forEach((waybill) => {
    if (waybill.customerId !== customerId) return;
    if (zonesMod.cleanCity(waybill.toCity) === city) return;
    const zone = zonesMod.zoneOfCity(data, waybill.toCity);
    if (!zone) return;
    tally.set(zone.id, (tally.get(zone.id) || 0) + 1);
  });
  return tally;
}

// 建议分区：① 历史账单沿用的分区 → ② 别名指向 → ③ 同客户既有运单主流分区 → ④ 价格档位
function suggestZone(data, group) {
  const enabled = data.zones.filter((zone) => zone.status === '启用');
  const pool = enabled.length ? enabled : data.zones;

  // ① 这些票已出账的账单行里记的分区（存量错账的现状）
  const historical = new Map();
  group.waybills.forEach((waybill) => {
    if (!waybill.billId || !billIsActive(data, waybill.billId)) return;
    const bill = data.bills.find((item) => item.id === waybill.billId);
    const line = (bill.lines || []).find((item) => item.waybillId === waybill.id);
    const zone = line && line.zoneName && data.zones.find((item) => item.name === line.zoneName);
    if (zone) historical.set(zone.id, (historical.get(zone.id) || 0) + 1);
  });
  if (historical.size > 0) {
    let bestId = '';
    let bestCount = 0;
    historical.forEach((count, id) => { if (count > bestCount) { bestId = id; bestCount = count; } });
    const zone = data.zones.find((item) => item.id === bestId);
    return {
      zone,
      reason: '这 ' + group.waybills.length + ' 条运单里有 ' + bestCount + ' 条已经出账，账单上沿用的分区是「' + zone.name +
        '」。按账单现状建议先归到这里保持一致；落定后系统会按正确分区把这些账单重新算一遍，多退少补会写在预演里。',
    };
  }

  // ② 城市名本身已作为别名登记在某分区
  for (const zone of pool) {
    const aliases = zone.aliases || {};
    if (Object.prototype.hasOwnProperty.call(aliases, group.city)) {
      return {
        zone,
        reason: '「' + group.city + '」已作为城市别名登记在「' + zone.name + '」（指向「' +
          text(aliases[group.city]) + '」），只是还没直接登记为覆盖城市，建议直接归到该分区。',
      };
    }
  }

  // ③ 这些客户的其他运单主要走哪个分区
  const traffic = new Map();
  group.customers.forEach((customer) => {
    customerTraffic(data, customer.id, group.city).forEach((count, zoneId) => {
      traffic.set(zoneId, (traffic.get(zoneId) || 0) + count);
    });
  });
  if (traffic.size > 0) {
    let bestId = '';
    let bestCount = 0;
    let total = 0;
    traffic.forEach((count, id) => { total += count; if (count > bestCount) { bestId = id; bestCount = count; } });
    const zone = data.zones.find((item) => item.id === bestId);
    if (zone) {
      return {
        zone,
        reason: '这些客户的其他运单有 ' + total + ' 条已归属分区，其中 ' + bestCount + ' 条走「' + zone.name +
          '」（占 ' + Math.round(bestCount / total * 100) + '%），客户线路最集中在这个分区，建议跟着走。',
      };
    }
  }

  // ④ 兜底：按组内平均计费重量与分区价位档（首重价 + 两个续重单位）贴近度
  const settings = pricing.settingsOf(data);
  const weights = group.waybills.map((waybill) => pricing.billableWeightKg(waybill, settings));
  const avgWeight = weights.reduce((sum, value) => sum + value, 0) / (weights.length || 1);
  let best = null;
  pool.forEach((zone) => {
    const tier = Number(zone.firstPriceYuan) + Number(zone.addPriceYuan) * 2;
    const candidate = { zone, distance: Math.abs(tier - avgWeight * 1.5) };
    if (!best || candidate.distance < best.distance) best = candidate;
  });
  if (best) {
    return {
      zone: best.zone,
      reason: '没有历史账单或客户线路可参照。组内运单平均计费重量约 ' + avgWeight.toFixed(1) +
        ' kg，按首重价加两个续重单位的价位档，「' + best.zone.name + '」最贴近，仅供参考，落定前可以改选其他分区。',
    };
  }
  return { zone: null, reason: '还没有可用分区，先到「分区」标签新建分区。' };
}

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function listGroups() {
  const data = load();
  const groups = groupByCity(data, unassignedWaybills(data));
  const items = Array.from(groups.values()).map((group) => {
    const suggestion = suggestZone(data, group);
    return {
      city: group.city,
      count: group.waybills.length,
      customers: Array.from(group.customers.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      customerCount: group.customers.size,
      earliestCreatedAt: group.minCreatedAt,
      latestCreatedAt: group.maxCreatedAt,
      periods: Array.from(group.periods).sort(),
      lockedCount: group.lockedCount,
      activeBillCount: group.activeBillCount,
      suggestionZoneId: suggestion.zone ? suggestion.zone.id : '',
      suggestionZoneCode: suggestion.zone ? suggestion.zone.code : '',
      suggestionZoneName: suggestion.zone ? suggestion.zone.name : '',
      suggestionReason: suggestion.reason,
    };
  });
  items.sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
  return {
    groups: items,
    total: items.length,
    waybillCount: items.reduce((sum, item) => sum + item.count, 0),
    lockedCount: items.reduce((sum, item) => sum + item.lockedCount, 0),
  };
}

// 整张账单按当前分区登记重新计价（同分区票合并共享一个首重，再按计费重量分摊）。
// override 仅用于预演：城市还没落进分区登记时，临时把某城市当作属于指定分区。
function repriceBill(data, bill, members, settings, override) {
  const customer = findCustomer(data, bill.customerId);
  const permille = pricing.discountPermilleOf(customer);
  const byZone = new Map();
  members.forEach((waybill) => {
    let zone = zonesMod.zoneOfCity(data, waybill.toCity);
    const city = zonesMod.cleanCity(waybill.toCity);
    if (!zone && override && override.city === city) zone = override.zone;
    const key = zone ? zone.id : '';
    if (!byZone.has(key)) byZone.set(key, { zone, entries: [] });
    byZone.get(key).entries.push({ waybill, weight: pricing.billableWeightKg(waybill, settings) });
  });
  const lineMap = new Map();
  let amountYuan = 0;
  byZone.forEach((group) => {
    const zone = group.zone;
    const entries = group.entries;
    const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
    const freightAll = pricing.freightYuan(zone, totalWeight, settings);
    const surchargeAll = entries.reduce(
      (sum, entry) => sum + pricing.surchargeYuan(zone, entry.waybill, entry.weight, settings), 0
    );
    amountYuan += (freightAll + surchargeAll) * permille / 1000;
    entries.forEach((entry) => {
      const share = totalWeight > 0 ? entry.weight / totalWeight : 0;
      const raw = (freightAll * share + pricing.surchargeYuan(zone, entry.waybill, entry.weight, settings)) * permille / 1000;
      const cached = Number(entry.waybill.quoteCacheYuan);
      lineMap.set(entry.waybill.id, {
        waybillId: entry.waybill.id,
        toCity: entry.waybill.toCity,
        zoneName: zone ? zone.name : '',
        billableKg: entry.weight,
        amountYuan: cached > 0 ? cached : pricing.roundFen(raw),
        fromCache: cached > 0,
      });
    });
  });
  const orderedLines = members.map((waybill) => lineMap.get(waybill.id)).filter(Boolean);
  pricing.alignLineAmounts(orderedLines, amountYuan);
  orderedLines.forEach((line) => lineMap.set(line.waybillId, line));
  return { lineMap, amountYuan: pricing.roundFen(amountYuan), permille };
}

function findPendingGroup(data, city) {
  const targetCity = zonesMod.cleanCity(city);
  if (!targetCity) throw badRequest('ASSIGN_CITY_REQUIRED', '要指定一个收件城市', { field: 'city' });
  const group = groupByCity(data, unassignedWaybills(data)).get(targetCity);
  if (!group) throw notFound('ASSIGN_CITY_NOT_PENDING', '城市「' + targetCity + '」当前没有待补归属的运单');
  return { targetCity, group };
}

// 预演：选定城市 + 分区，逐票试算金额，并模拟重算会被牵动的已出账账单
function preview(city, zoneId) {
  const data = load();
  const { targetCity, group } = findPendingGroup(data, city);
  const zone = zonesMod.findZone(data, text(zoneId));
  if (!zone) throw badRequest('ASSIGN_ZONE_NOT_FOUND', '选的分区不存在', { field: 'zoneId' });
  if (zone.status === '停用') {
    throw badRequest('ASSIGN_ZONE_DISABLED', '分区「' + zone.name + '」已停用，不能把城市归到停用分区', { field: 'zoneId' });
  }
  const suggestion = suggestZone(data, group);
  const settings = pricing.settingsOf(data);

  // 先把受影响账单模拟重算出来，行金额要和落定后的算法完全一致
  const activeBillIds = Array.from(new Set(
    group.waybills.filter((waybill) => waybill.billId && billIsActive(data, waybill.billId)).map((waybill) => waybill.billId)
  ));
  const billSim = new Map();
  const affectedBills = activeBillIds.map((billId) => {
    const bill = data.bills.find((item) => item.id === billId);
    const members = (bill.waybillIds || [])
      .map((id) => data.waybills.find((waybill) => waybill.id === id))
      .filter(Boolean);
    const repriced = repriceBill(data, bill, members, settings, { city: targetCity, zone });
    billSim.set(billId, repriced);
    // 把行差异拆成两部分：本城市运单直接带来的、同账单其他历史运单按正确分区重算带来的
    let touchedCurrent = 0;
    let touchedPreview = 0;
    let otherCurrent = 0;
    let otherPreview = 0;
    members.forEach((waybill) => {
      const oldLine = (bill.lines || []).find((line) => line.waybillId === waybill.id);
      const newLine = repriced.lineMap.get(waybill.id);
      const oldAmount = oldLine ? Number(oldLine.amountYuan || 0) : 0;
      const newAmount = newLine ? Number(newLine.amountYuan || 0) : 0;
      if (zonesMod.cleanCity(waybill.toCity) === targetCity) {
        touchedCurrent += oldAmount;
        touchedPreview += newAmount;
      } else {
        otherCurrent += oldAmount;
        otherPreview += newAmount;
      }
    });
    return {
      billId: bill.id,
      code: bill.code,
      period: bill.period,
      customerId: bill.customerId,
      customerName: (findCustomer(data, bill.customerId) || { name: '（客户已删）' }).name,
      currentAmountYuan: money(bill.amountYuan),
      previewAmountYuan: repriced.amountYuan,
      diffYuan: money(repriced.amountYuan - Number(bill.amountYuan || 0)),
      lineCount: members.length,
      touchedCount: members.filter((waybill) => zonesMod.cleanCity(waybill.toCity) === targetCity).length,
      touchedCurrentYuan: money(touchedCurrent),
      touchedPreviewYuan: money(touchedPreview),
      touchedDiffYuan: money(touchedPreview - touchedCurrent),
      otherCount: members.length - members.filter((waybill) => zonesMod.cleanCity(waybill.toCity) === targetCity).length,
      otherDiffYuan: money(otherPreview - otherCurrent),
    };
  }).sort((a, b) => a.period.localeCompare(b.period) || a.code.localeCompare(b.code));

  const rows = group.waybills.map((waybill) => {
    const customer = findCustomer(data, waybill.customerId);
    const quote = pricing.quoteWaybill(waybill, zone, customer, settings);
    const bill = waybill.billId ? data.bills.find((item) => item.id === waybill.billId) : null;
    const active = bill && bill.status === '已出账';
    const currentLine = bill ? (bill.lines || []).find((line) => line.waybillId === waybill.id) : null;
    const simLine = active && billSim.has(bill.id) ? billSim.get(bill.id).lineMap.get(waybill.id) : null;
    return {
      waybillId: waybill.id,
      code: waybill.code,
      customerId: waybill.customerId,
      customerName: customer ? customer.name : '（客户已删）',
      status: waybill.status,
      createdAt: waybill.createdAt,
      billId: waybill.billId || null,
      billCode: bill ? bill.code : '',
      billStatus: bill ? bill.status : '',
      billableKg: quote.billableKg,
      freightYuan: quote.freightYuan,
      surchargeYuan: quote.surchargeYuan,
      discountPermille: quote.discountPermille,
      expectedYuan: quote.totalYuan,
      currentYuan: active && currentLine ? money(currentLine.amountYuan) : null,
      billPreviewYuan: simLine ? simLine.amountYuan : null,
      diffYuan: simLine ? money(simLine.amountYuan - (currentLine ? Number(currentLine.amountYuan || 0) : 0)) : null,
    };
  });

  const expectedYuan = money(rows.reduce((sum, row) => sum + row.expectedYuan, 0));
  const billedRows = rows.filter((row) => row.billPreviewYuan !== null);
  const billedCurrentYuan = money(billedRows.reduce((sum, row) => sum + row.currentYuan, 0));
  const billedPreviewYuan = money(billedRows.reduce((sum, row) => sum + row.billPreviewYuan, 0));

  return {
    city: targetCity,
    count: rows.length,
    unlockedCount: rows.length - group.lockedCount,
    lockedCount: group.lockedCount,
    zone: { id: zone.id, code: zone.code, name: zone.name },
    suggestion: {
      zoneId: suggestion.zone ? suggestion.zone.id : '',
      zoneCode: suggestion.zone ? suggestion.zone.code : '',
      zoneName: suggestion.zone ? suggestion.zone.name : '',
      reason: suggestion.reason,
      matchesSelected: Boolean(suggestion.zone && suggestion.zone.id === zone.id),
    },
    rows,
    totals: {
      expectedYuan,
      billedRowCount: billedRows.length,
      billedCurrentYuan,
      billedPreviewYuan,
      billedDiffYuan: money(billedPreviewYuan - billedCurrentYuan),
    },
    affectedBills,
    billTotals: {
      count: affectedBills.length,
      currentYuan: money(affectedBills.reduce((sum, item) => sum + item.currentAmountYuan, 0)),
      previewYuan: money(affectedBills.reduce((sum, item) => sum + item.previewAmountYuan, 0)),
      diffYuan: money(affectedBills.reduce((sum, item) => sum + item.diffYuan, 0)),
    },
  };
}

// 确认落定
function commit(city, zoneId, payload) {
  const data = load();
  const { targetCity, group } = findPendingGroup(data, city);
  const zone = zonesMod.findZone(data, text(zoneId));
  if (!zone) throw badRequest('ASSIGN_ZONE_NOT_FOUND', '选的分区不存在', { field: 'zoneId' });
  if (zone.status === '停用') {
    throw badRequest('ASSIGN_ZONE_DISABLED', '分区「' + zone.name + '」已停用，不能把城市归到停用分区', { field: 'zoneId' });
  }
  const dryRun = preview(targetCity, zone.id);
  const basis = text(payload && payload.basis) || dryRun.suggestion.reason || '人工选定分区';
  const note = text(payload && payload.note);

  // 1) 城市写进分区的 cities —— 正式的城市→分区登记，而不是只改运单上的临时标记
  if (!zone.cities.some((item) => zonesMod.cleanCity(item) === targetCity)) zone.cities.push(targetCity);
  if (!Array.isArray(zone.assignments)) zone.assignments = [];
  zone.assignments.push({
    city: targetCity,
    assignedAt: new Date().toISOString(),
    waybillCount: group.waybills.length,
    basis,
    suggestionZoneId: dryRun.suggestion.zoneId,
    suggestionMatched: dryRun.suggestion.matchesSelected,
    note,
  });

  const settings = pricing.settingsOf(data);

  // 2) 未入账运单：把按新分区算出来的费用写回运单缓存，之后查看与出账直接可用
  group.waybills.forEach((waybill) => {
    if (waybill.billId) return;
    const customer = findCustomer(data, waybill.customerId);
    const result = pricing.quoteWaybill(waybill, zone, customer, settings);
    waybill.quoteCacheYuan = result.totalYuan;
    waybill.quoteCachedAt = new Date().toISOString();
  });

  // 3) 已出账账单：城市已登记，按当前登记整单重算，明细行与账单金额一并刷新
  const activeBillIds = Array.from(new Set(
    group.waybills.filter((waybill) => waybill.billId && billIsActive(data, waybill.billId)).map((waybill) => waybill.billId)
  ));
  const recomputedBills = activeBillIds.map((billId) => {
    const bill = data.bills.find((item) => item.id === billId);
    const members = (bill.waybillIds || [])
      .map((id) => data.waybills.find((waybill) => waybill.id === id))
      .filter(Boolean);
    const oldAmount = money(bill.amountYuan);
    const repriced = repriceBill(data, bill, members, settings, null);
    bill.lines = members.map((waybill) => {
      const line = repriced.lineMap.get(waybill.id);
      const cached = Number(waybill.quoteCacheYuan);
      return {
        waybillId: waybill.id,
        code: waybill.code,
        toCity: waybill.toCity,
        zoneName: line.zoneName,
        billableKg: line.billableKg,
        amountYuan: line.amountYuan,
        fromCache: cached > 0,
      };
    });
    bill.amountYuan = repriced.amountYuan;
    bill.discountPermille = repriced.permille;
    bill.recomputedAt = new Date().toISOString();
    bill.recomputedReason = '补归属：城市「' + targetCity + '」归入分区「' + zone.name + '」，整单按当前登记重算';
    return {
      billId: bill.id,
      code: bill.code,
      period: bill.period,
      currentAmountYuan: oldAmount,
      amountYuan: bill.amountYuan,
      diffYuan: money(bill.amountYuan - oldAmount),
    };
  });

  save(data);
  const remaining = listGroups();
  return {
    city: targetCity,
    zoneId: zone.id,
    zoneCode: zone.code,
    zoneName: zone.name,
    waybillCount: group.waybills.length,
    expectedYuan: dryRun.totals.expectedYuan,
    recomputedBills,
    remainingCityCount: remaining.total,
    remainingWaybillCount: remaining.waybillCount,
  };
}

module.exports = { listGroups, preview, commit };
