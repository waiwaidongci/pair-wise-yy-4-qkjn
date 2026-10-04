/* 核心业务逻辑测试（mock 浏览器环境） */
const assert = require('assert');

// ---- mock 浏览器全局 ----
const store = {};
global.window = global;
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
global.crypto = { randomUUID: () => 'id-' + Math.random().toString(36).slice(2) };

// ---- 加载模块 ----
require('./js/rules.js');
require('./js/archive.js');
const rules = global.App.rules;
const archive = global.App.archive;

// ---- 构造一个干净的 state ----
function makeState() {
  return {
    threshold: 10,
    baselines: [
      { id: 'bl-v0', version: 'v0', name: '旧基准面', establishedAt: '2023-01-01', active: false },
      { id: 'bl-v1', version: 'v1', name: '现行基准面', establishedAt: '2024-06-01', active: true }
    ],
    calibrations: [
      { id: 'cal-2024', code: 'CAL-2024-01', equipment: '测深仪A', validFrom: '2024-01-01', validTo: '2024-12-31' },
      { id: 'cal-2026', code: 'CAL-2026-03', equipment: '测深仪B', validFrom: '2026-01-01', validTo: '2026-12-31' }
    ],
    markers: [
      { id: 'mk-1', code: 'M-001', type: 'metal', x: 10, y: 10 },
      { id: 'mk-2', code: 'M-002', type: 'ceramic', x: 20, y: 20 },
      { id: 'mk-3', code: 'M-003', type: 'wood', x: 30, y: 30 }
    ],
    confirmedMarkers: [],
    readings: [],
    batches: [],
    recommendations: [],
    pendingRemeasure: [],
    conflicts: [],
    blockedMarkers: {},
    window: {},
    lastInvalidation: null
  };
}

// 复刻 app.js 的 recompute
function latestReadingOf(state, markerCode) {
  const list = state.readings.filter(r => r.markerCode === markerCode);
  if (!list.length) return null;
  return list.reduce((a, b) => new Date(b.measuredAt).getTime() > new Date(a.measuredAt).getTime() ? b : a);
}
function recompute(state) {
  const recs = [], pending = [];
  state.markers.forEach(m => {
    if (state.blockedMarkers[m.code]) return;
    const r = m.lastReading;
    if (r && rules.isEligible(state, r)) {
      if (rules.needsDredging(state, r.thickness)) {
        recs.push({ markerCode: m.code, thickness: r.thickness, basis: { opNo: r.opNo, calibrationNo: r.calibrationNo, measuredAt: r.measuredAt, baselineVersion: r.baselineVersion } });
      }
      return;
    }
    const latest = latestReadingOf(state, m.code);
    if (!latest) { pending.push({ markerCode: m.code, reason: '缺少基准面，待补测' }); return; }
    if (!latest.baselineVersion) { pending.push({ markerCode: m.code, reason: '读数缺少基准面版本，待补测' }); return; }
    const cal = rules.calibrationFor(state, latest.calibrationNo);
    if (!rules.isCalibrationValid(cal, latest.measuredAt)) { pending.push({ markerCode: m.code, reason: '设备校准已过期，待补测' }); return; }
    const active = rules.activeBaseline(state);
    if (active && latest.baselineVersion !== active.version) { pending.push({ markerCode: m.code, reason: '基准面已变更，待补测' }); return; }
    pending.push({ markerCode: m.code, reason: '基准不一致，待补测' });
  });
  state.recommendations = recs;
  state.pendingRemeasure = pending;
}

const T = '2026-09-20T08:00:00';
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

// 1. 同号重传只认首次
test('同号重传只认首次', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  const batch = { id: 'B1', side: 'left', readings: [
    { opNo: 'OP-1', markerCode: 'M-001', thickness: 15, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' },
    { opNo: 'OP-1', markerCode: 'M-001', thickness: 99, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  archive.mergeBatch(state, batch);
  assert.strictEqual(state.readings.length, 1, '重传读数不应入档');
  assert.strictEqual(state.readings[0].thickness, 15, '只认首次值');
  assert.strictEqual(batch.result.retransmissions.length, 1, '应记录1条重传');
});

// 2. 校准过期 → 不参与判断
test('校准过期读数不参与判断', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  const batch = { id: 'B2', side: 'left', readings: [
    { opNo: 'OP-2', markerCode: 'M-001', thickness: 20, calibrationNo: 'CAL-2024-01', measuredAt: T, baselineVersion: 'v1' }
  ]};
  archive.mergeBatch(state, batch);
  recompute(state);
  assert.strictEqual(state.readings.length, 1, '过期读数仍留档');
  assert.strictEqual(state.recommendations.length, 0, '过期读数不产生建议');
  assert.strictEqual(state.pendingRemeasure.some(p => p.markerCode === 'M-001' && p.reason.indexOf('校准') !== -1), true, 'M-001 归入待补测（校准过期）');
});

// 3. 基准不一致 → 不参与判断
test('基准不一致读数不参与判断', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  const batch = { id: 'B3', side: 'left', readings: [
    { opNo: 'OP-3', markerCode: 'M-001', thickness: 20, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v0' }
  ]};
  archive.mergeBatch(state, batch);
  recompute(state);
  assert.strictEqual(state.recommendations.length, 0);
  assert.strictEqual(state.pendingRemeasure[0].markerCode, 'M-001');
});

// 4. 两边同测同一标记 → 冲突，保留现场值，不进建议
test('两边同测同一标记 → 冲突且不进建议', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  const bL = { id: 'BL', side: 'left', readings: [
    { opNo: 'OP-4', markerCode: 'M-001', thickness: 15, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  const bR = { id: 'BR', side: 'right', readings: [
    { opNo: 'OP-5', markerCode: 'M-001', thickness: 18, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  archive.mergeBatch(state, bL);
  archive.mergeBatch(state, bR);
  recompute(state);
  assert.strictEqual(state.conflicts.length, 1, '应产生1条冲突');
  assert.strictEqual(state.recommendations.length, 0, '冲突标记不进建议');
  assert.strictEqual(state.markers.find(m => m.code === 'M-001').thickness, undefined, '现场值保留（未被任一船覆盖）');
});

// 5. 冲突处理后可进建议
test('冲突处理（采用右船）后可进建议', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  const bL = { id: 'BL2', side: 'left', readings: [
    { opNo: 'OP-6', markerCode: 'M-002', thickness: 15, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  const bR = { id: 'BR2', side: 'right', readings: [
    { opNo: 'OP-7', markerCode: 'M-002', thickness: 18, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  archive.mergeBatch(state, bL);
  archive.mergeBatch(state, bR);
  recompute(state);
  assert.strictEqual(state.recommendations.length, 0);
  archive.resolveConflict(state, 'M-002', 'right');
  recompute(state);
  assert.strictEqual(state.recommendations.length, 1, '处理后应产生建议');
  assert.strictEqual(state.recommendations[0].thickness, 18, '采用右船值');
});

// 6. 合并失败 → 从最后确认标记恢复
test('合并失败回滚到最后确认标记', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  // 先成功合并一批
  const ok = { id: 'BOK', side: 'left', readings: [
    { opNo: 'OP-8', markerCode: 'M-001', thickness: 15, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  archive.mergeBatch(state, ok);
  archive.finalizeCycle(state);
  const before = JSON.parse(JSON.stringify(state.markers));
  // 再合并一批含未知标记 → 失败
  const bad = { id: 'BBAD', side: 'left', readings: [
    { opNo: 'OP-9', markerCode: 'ZZ-999', thickness: 20, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  const out = archive.mergeBatch(state, bad);
  assert.ok(out.failed, '应报告失败');
  assert.strictEqual(bad.status, '合并失败');
  assert.deepStrictEqual(state.markers, before, '标记应恢复到最后确认状态');
});

// 7. 旧数据缺少基准 → 待补测
test('缺少基准面 → 待补测', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  const batch = { id: 'B7', side: 'left', readings: [
    { opNo: 'OP-10', markerCode: 'M-003', thickness: 8, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: null }
  ]};
  archive.mergeBatch(state, batch);
  recompute(state);
  assert.strictEqual(state.recommendations.length, 0);
  assert.strictEqual(state.pendingRemeasure.some(p => p.markerCode === 'M-003'), true);
});

// 8. 基准变更 → 建议失效重算
test('基准变更后建议失效重算', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  const batch = { id: 'B8', side: 'left', readings: [
    { opNo: 'OP-11', markerCode: 'M-001', thickness: 15, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  archive.mergeBatch(state, batch);
  recompute(state);
  assert.strictEqual(state.recommendations.length, 1);
  // 启用 v2
  state.baselines.forEach(b => { b.active = false; });
  state.baselines.push({ id: 'bl-v2', version: 'v2', name: '新基准面', establishedAt: '2026-01-01', active: true });
  state.window = {};
  recompute(state);
  assert.strictEqual(state.recommendations.length, 0, '旧基准建议应失效');
  assert.strictEqual(state.pendingRemeasure.some(p => p.markerCode === 'M-001'), true, '应归入待补测');
});

// 9. 淤积阈值边界
test('淤积阈值边界（>= 阈值即建议）', () => {
  const state = makeState();
  state.confirmedMarkers = JSON.parse(JSON.stringify(state.markers));
  const batch = { id: 'B9', side: 'left', readings: [
    { opNo: 'OP-12', markerCode: 'M-001', thickness: 10, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' },
    { opNo: 'OP-13', markerCode: 'M-002', thickness: 9, calibrationNo: 'CAL-2026-03', measuredAt: T, baselineVersion: 'v1' }
  ]};
  archive.mergeBatch(state, batch);
  recompute(state);
  assert.strictEqual(state.recommendations.length, 1, '10cm 应建议，9cm 不应');
  assert.strictEqual(state.recommendations[0].markerCode, 'M-001');
});

console.log('\n全部通过：' + passed + ' 项');
