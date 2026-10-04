/* ============================================================
 * 页面操作模块
 * 标记地图、清淤建议、冲突处理、待补测、批次存档与规则面板。
 * 基准或标记位置一改，建议立即失效重算，原读数留查。
 * ============================================================ */
(function () {
  'use strict';

  var clone = function (v) { return JSON.parse(JSON.stringify(v)); };
  var STORE_KEY = 'dredgeStateV1';
  var $ = function (s) { return document.querySelector(s); };
  var map = $('#map');
  var tabBody = $('#tabBody');

  var typeNames = { ceramic: '陶片', wood: '木构件', metal: '金属件', unknown: '未知物' };

  var state = null;
  var tab = 'rec';
  var opSeq = 100;
  var didDrag = false;

  /* ---------------- 种子数据 ---------------- */
  function seed() {
    state = {
      threshold: 10,
      baselines: [
        { id: 'bl-v0', version: 'v0', name: '旧基准面', establishedAt: '2023-01-01', active: false },
        { id: 'bl-v1', version: 'v1', name: '现行基准面', establishedAt: '2024-06-01', active: true }
      ],
      calibrations: [
        { id: 'cal-2024', code: 'CAL-2024-01', equipment: '测深仪A', validFrom: '2024-01-01', validTo: '2024-12-31' },
        { id: 'cal-2025', code: 'CAL-2025-02', equipment: '测深仪A', validFrom: '2025-01-01', validTo: '2025-12-31' },
        { id: 'cal-2026', code: 'CAL-2026-03', equipment: '测深仪B', validFrom: '2026-01-01', validTo: '2026-12-31' }
      ],
      markers: [
        // 旧数据：缺少基准面 → 待补测
        { id: 'mk-001', code: 'A-017', type: 'ceramic', dive: 'DIVE-01', x: 42, y: 46, depth: '17.8m', orientation: '东', condition: '边缘残缺', note: '靠近船肋' },
        { id: 'mk-002', code: 'W-003', type: 'wood', dive: 'DIVE-02', x: 58, y: 39, depth: '18.2m', orientation: '西北', condition: '稳定', note: '疑似横梁' },
        // 有基准的新标记
        { id: 'mk-003', code: 'M-004', type: 'metal', dive: 'DIVE-03', x: 35, y: 60, depth: '18.0m', orientation: '南', condition: '附着物厚', note: '' },
        { id: 'mk-004', code: 'M-005', type: 'ceramic', dive: 'DIVE-03', x: 64, y: 55, depth: '17.6m', orientation: '东南', condition: '一般', note: '' },
        { id: 'mk-005', code: 'M-006', type: 'unknown', dive: 'DIVE-04', x: 50, y: 30, depth: '18.4m', orientation: '北', condition: '待查', note: '' }
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
    state.confirmedMarkers = clone(state.markers);

    var b1 = {
      id: 'B-2026-0920', side: 'left', submittedAt: '2026-09-20T08:30:00', status: '待合并', failReason: null,
      readings: [
        { opNo: 'OP-0001', markerCode: 'M-004', thickness: 15, calibrationNo: 'CAL-2026-03', measuredAt: '2026-09-20T08:00:00', baselineVersion: 'v1' },
        { opNo: 'OP-0002', markerCode: 'M-005', thickness: 5, calibrationNo: 'CAL-2026-03', measuredAt: '2026-09-20T08:05:00', baselineVersion: 'v1' },
        { opNo: 'OP-0003', markerCode: 'M-006', thickness: 12, calibrationNo: 'CAL-2024-01', measuredAt: '2026-09-20T08:10:00', baselineVersion: 'v1' },
        { opNo: 'OP-0004', markerCode: 'A-017', thickness: 8, calibrationNo: 'CAL-2026-03', measuredAt: '2026-09-20T08:15:00', baselineVersion: null }
      ]
    };
    var b2 = {
      id: 'B-2026-0921', side: 'right', submittedAt: '2026-09-21T09:30:00', status: '待合并', failReason: null,
      readings: [
        { opNo: 'OP-0005', markerCode: 'M-004', thickness: 18, calibrationNo: 'CAL-2026-03', measuredAt: '2026-09-21T09:00:00', baselineVersion: 'v1' },
        { opNo: 'OP-0006', markerCode: 'M-006', thickness: 14, calibrationNo: 'CAL-2026-03', measuredAt: '2026-09-21T09:10:00', baselineVersion: 'v1' },
        { opNo: 'OP-0007', markerCode: 'W-003', thickness: 6, calibrationNo: 'CAL-2026-03', measuredAt: '2026-09-21T09:20:00', baselineVersion: null }
      ]
    };
    state.batches.push(b1, b2);
    App.archive.mergeBatch(state, b1);
    App.archive.mergeBatch(state, b2);
    App.archive.finalizeCycle(state);
    recompute();
  }

  /* ---------------- 持久化 ---------------- */
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) { state = JSON.parse(raw); return true; }
    } catch (e) {}
    return false;
  }

  /* ---------------- 建议重算 ---------------- */
  function latestReadingOf(markerCode) {
    var list = state.readings.filter(function (r) { return r.markerCode === markerCode; });
    if (!list.length) return null;
    return list.reduce(function (a, b) {
      return new Date(b.measuredAt).getTime() > new Date(a.measuredAt).getTime() ? b : a;
    });
  }

  function recompute() {
    var recs = [];
    var pending = [];
    state.markers.forEach(function (m) {
      // 冲突未处理前不能进入清淤建议
      if (state.blockedMarkers[m.code]) return;
      var r = m.lastReading;
      if (r && App.rules.isEligible(state, r)) {
        if (App.rules.needsDredging(state, r.thickness)) {
          recs.push({
            id: 'REC-' + m.code,
            markerCode: m.code,
            thickness: r.thickness,
            basis: {
              opNo: r.opNo,
              calibrationNo: r.calibrationNo,
              measuredAt: r.measuredAt,
              baselineVersion: r.baselineVersion
            },
            status: '建议清淤'
          });
        }
        return;
      }
      // 不满足建议条件 → 待补测，给出真实原因
      var latest = latestReadingOf(m.code);
      if (!latest) {
        pending.push({ markerCode: m.code, reason: '缺少基准面，待补测' });
        return;
      }
      if (!latest.baselineVersion) {
        pending.push({ markerCode: m.code, reason: '读数缺少基准面版本，待补测' });
        return;
      }
      var cal = App.rules.calibrationFor(state, latest.calibrationNo);
      if (!App.rules.isCalibrationValid(cal, latest.measuredAt)) {
        pending.push({ markerCode: m.code, reason: '设备校准已过期（' + latest.calibrationNo + '），待补测' });
        return;
      }
      var active = App.rules.activeBaseline(state);
      if (active && latest.baselineVersion !== active.version) {
        pending.push({ markerCode: m.code, reason: '基准面已变更（' + latest.baselineVersion + ' → ' + active.version + '），待按新基准补测' });
        return;
      }
      pending.push({ markerCode: m.code, reason: '基准不一致，待补测' });
    });
    state.recommendations = recs;
    state.pendingRemeasure = pending;
  }

  /* ---------------- 标记状态 ---------------- */
  function markerStatus(m) {
    if (state.blockedMarkers[m.code]) return 'conflict';
    var r = m.lastReading;
    if (!r || !App.rules.isEligible(state, r)) return 'pending';
    return App.rules.needsDredging(state, r.thickness) ? 'dredging' : 'safe';
  }

  /* ---------------- 批次生成与提交 ---------------- */
  function nowIso() { return new Date().toISOString(); }

  function makeBatch(side) {
    var active = App.rules.activeBaseline(state);
    var ts = nowIso();
    var readings = [];
    state.markers.forEach(function (m) {
      if (m.code === 'A-017' || m.code === 'W-003') {
        // 旧数据无基准 → 待补测
        readings.push({ opNo: 'OP-' + (opSeq++), markerCode: m.code, thickness: 7, calibrationNo: 'CAL-2026-03', measuredAt: ts, baselineVersion: null });
      } else if (m.code === 'M-006') {
        // 校准过期 → 存档但不参与判断
        readings.push({ opNo: 'OP-' + (opSeq++), markerCode: m.code, thickness: 12, calibrationNo: 'CAL-2024-01', measuredAt: ts, baselineVersion: active ? active.version : null });
      } else {
        var base = m.code === 'M-004' ? 15 : (m.code === 'M-005' ? 5 : 9);
        readings.push({ opNo: 'OP-' + (opSeq++), markerCode: m.code, thickness: base, calibrationNo: 'CAL-2026-03', measuredAt: ts, baselineVersion: active ? active.version : null });
      }
    });
    return {
      id: 'B-' + (side === 'left' ? 'L' : 'R') + '-' + Date.now(),
      side: side,
      submittedAt: ts,
      status: '待合并',
      failReason: null,
      readings: readings
    };
  }

  function submitBatch(side) {
    var batch = makeBatch(side);
    state.batches.push(batch);
    var out = App.archive.mergeBatch(state, batch);
    recompute();
    save();
    render();
    var sideName = side === 'left' ? '左船' : '右船';
    toast(sideName + '批次已合并：应用 ' + out.applied.length + ' · 冲突 ' + out.conflicts.length +
      ' · 待补测 ' + out.pending.length + ' · 重传 ' + out.retransmissions.length);
  }

  function retransmit() {
    var first = state.batches[0];
    if (!first) return;
    var batch = {
      id: 'B-RE-' + Date.now(),
      side: first.side,
      submittedAt: nowIso(),
      status: '待合并',
      failReason: null,
      readings: clone(first.readings)
    };
    state.batches.push(batch);
    var out = App.archive.mergeBatch(state, batch);
    recompute();
    save();
    render();
    toast('重传 ' + out.retransmissions.length + ' 条读数，同号只认首次，已忽略');
  }

  function failDrill() {
    var active = App.rules.activeBaseline(state);
    var batch = {
      id: 'B-FAIL-' + Date.now(),
      side: 'left',
      submittedAt: nowIso(),
      status: '待合并',
      failReason: null,
      readings: [{
        opNo: 'OP-FAIL-' + Date.now(),
        markerCode: 'ZZ-999',
        thickness: 20,
        calibrationNo: 'CAL-2026-03',
        measuredAt: nowIso(),
        baselineVersion: active ? active.version : null
      }]
    };
    state.batches.push(batch);
    var out = App.archive.mergeBatch(state, batch);
    recompute();
    save();
    render();
    toast('合并失败：' + out.failed + '；已从最后确认标记恢复');
  }

  /* ---------------- 基准 / 标记变更 → 建议失效重算 ---------------- */
  function activateBaseline(id) {
    state.baselines.forEach(function (b) { b.active = b.id === id; });
    state.window = {};
    state.lastInvalidation = { reason: App.rules.invalidReasons.baseline, at: Date.now() };
    recompute();
    save();
    render();
    var b = state.baselines.find(function (x) { return x.id === id; });
    toast('已启用基准面 ' + b.version + '，全部建议失效重算');
  }

  function moveMarker(id, x, y) {
    var m = state.markers.find(function (m) { return m.id === id; });
    if (!m) return;
    m.x = x; m.y = y;
    delete state.window[m.code];
    state.lastInvalidation = { reason: App.rules.invalidReasons.marker, at: Date.now() };
    recompute();
    save();
    render();
    toast('标记 ' + m.code + ' 位置已变更，建议失效重算');
  }

  function addMarker(x, y) {
    var n = state.markers.length + 1;
    var code = 'M-' + String(n).padStart(3, '0');
    var marker = {
      id: 'mk-' + Date.now(), code: code, type: 'unknown',
      dive: 'DIVE-' + String(Math.ceil(n / 3)).padStart(2, '0'),
      x: Number(x), y: Number(y), depth: '', orientation: '', condition: '', note: ''
    };
    state.markers.push(marker);
    state.confirmedMarkers.push(clone(marker));
    recompute();
    save();
    render();
    toast('已添加标记 ' + code + '（无基准，待补测）');
  }

  /* ---------------- 冲突处理 ---------------- */
  function resolveConflict(markerCode, choice) {
    App.archive.resolveConflict(state, markerCode, choice);
    recompute();
    save();
    render();
    toast('冲突已处理：' + choiceLabel(choice));
  }

  function choiceLabel(c) {
    return { left: '采用左船读数', right: '采用右船读数', field: '维持现场值', pending: '标记待补测' }[c] || c;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    renderMap();
    renderSummary();
    renderTab();
    $('#tabs').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
  }

  function renderMap() {
    map.querySelectorAll('.marker').forEach(function (el) { el.remove(); });
    state.markers.forEach(function (m) {
      var el = document.createElement('button');
      el.className = 'marker ' + markerStatus(m);
      el.dataset.id = m.id;
      el.style.left = m.x + '%';
      el.style.top = m.y + '%';
      el.textContent = m.code.slice(0, 2);
      el.title = m.code + ' · ' + typeNames[m.type] + (m.lastReading ? ' · ' + m.lastReading.thickness + 'cm' : '');
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        startDrag(m.id, e);
      });
      map.appendChild(el);
    });
  }

  function renderSummary() {
    var el = $('#summary');
    if (!el) return;
    var counts = { dredging: 0, conflict: 0, pending: 0, safe: 0 };
    state.markers.forEach(function (m) { counts[markerStatus(m)]++; });
    el.innerHTML =
      '<span class="pill dredging">建议清淤 ' + counts.dredging + '</span>' +
      '<span class="pill conflict">冲突 ' + counts.conflict + '</span>' +
      '<span class="pill pending">待补测 ' + counts.pending + '</span>' +
      '<span class="pill safe">安全 ' + counts.safe + '</span>';
  }

  function renderTab() {
    if (tab === 'rec') renderRecs();
    else if (tab === 'pending') renderPending();
    else if (tab === 'conflict') renderConflicts();
    else if (tab === 'batches') renderBatches();
    else if (tab === 'rules') renderRules();
  }

  function renderRecs() {
    var active = App.rules.activeBaseline(state);
    var html = '<h2>清淤建议</h2>';
    if (state.lastInvalidation) {
      html += '<div class="banner">' + state.lastInvalidation.reason + '（' + fmtTime(state.lastInvalidation.at) + '）</div>';
    }
    html += '<div class="muted">当前基准面：<b>' + (active ? active.version : '无') +
      '</b>　淤积阈值：' + state.threshold + 'cm　|　只有校准有效且基准一致的读数参与判断</div>';
    if (!state.recommendations.length) {
      html += '<div class="empty">当前没有符合条件的清淤建议</div>';
    }
    html += state.recommendations.map(function (r) {
      return '<div class="card rec">' +
        '<div class="card-head"><b>' + r.markerCode + '</b><span class="pill red">' + r.thickness + 'cm</span></div>' +
        '<div class="muted">依据：' + r.basis.opNo + ' · ' + r.basis.calibrationNo +
        ' · ' + fmtTime(r.basis.measuredAt) + ' · 基准 ' + r.basis.baselineVersion + '</div>' +
        '</div>';
    }).join('');
    tabBody.innerHTML = html;
  }

  function renderPending() {
    var html = '<h2>待补测</h2>';
    html += '<div class="muted">缺少基准面 / 基准已变更 / 校准过期的标记，暂不进入清淤建议</div>';
    if (!state.pendingRemeasure.length) html += '<div class="empty">没有待补测标记</div>';
    html += state.pendingRemeasure.map(function (p) {
      return '<div class="card pending">' +
        '<div class="card-head"><b>' + p.markerCode + '</b><span class="pill gray">待补测</span></div>' +
        '<div class="muted">' + p.reason + '</div>' +
        '</div>';
    }).join('');
    tabBody.innerHTML = html;
  }

  function renderConflicts() {
    var html = '<h2>冲突处理</h2>';
    html += '<div class="muted">两边同测同一标记时保留现场值；冲突未处理前该标记不能进入清淤建议</div>';
    var open = state.conflicts.filter(function (c) { return c.status === '未处理'; });
    if (!open.length) html += '<div class="empty">没有未处理冲突</div>';
    html += open.map(function (c) {
      var l = state.readings.find(function (r) { return r.opNo === c.leftOp; });
      var rr = state.readings.find(function (r) { return r.opNo === c.rightOp; });
      return '<div class="card conflict">' +
        '<div class="card-head"><b>' + c.markerCode + '</b><span class="pill orange">冲突未处理</span></div>' +
        '<div class="muted">左船 ' + c.leftOp + '（' + (l ? l.thickness : '?') + 'cm） vs 右船 ' + c.rightOp + '（' + (rr ? rr.thickness : '?') + 'cm）</div>' +
        '<div class="muted">现场值已保留，该标记未进入清淤建议</div>' +
        '<div class="actions">' +
        '<button data-choice="left" data-code="' + c.markerCode + '">采用左船</button>' +
        '<button data-choice="right" data-code="' + c.markerCode + '" class="secondary">采用右船</button>' +
        '<button data-choice="field" data-code="' + c.markerCode + '" class="secondary">维持现场</button>' +
        '<button data-choice="pending" data-code="' + c.markerCode + '" class="secondary">标记待补测</button>' +
        '</div></div>';
    }).join('');
    var resolved = state.conflicts.filter(function (c) { return c.status === '已处理'; });
    if (resolved.length) {
      html += '<h3>已处理</h3>' + resolved.map(function (c) {
        return '<div class="muted">' + c.markerCode + ' · ' + choiceLabel(c.resolution) + ' · ' + fmtTime(c.resolvedAt) + '</div>';
      }).join('');
    }
    tabBody.innerHTML = html;
    tabBody.querySelectorAll('[data-choice]').forEach(function (btn) {
      btn.onclick = function () { resolveConflict(btn.dataset.code, btn.dataset.choice); };
    });
  }

  function renderBatches() {
    var html = '<h2>批次存档</h2>';
    html += '<div class="muted">读数原档留查，同号重传只认首次</div>';
    if (!state.batches.length) html += '<div class="empty">暂无批次</div>';
    html += state.batches.slice().reverse().map(function (b) {
      var fail = b.failReason;
      var status = fail ? '合并失败' : b.status;
      var sideName = b.side === 'left' ? '左船' : '右船';
      var r = b.result;
      return '<div class="card batch">' +
        '<div class="card-head"><b>' + b.id + '</b><span class="pill ' + (fail ? 'red' : 'green') + '">' + status + '</span></div>' +
        '<div class="muted">' + sideName + ' · ' + fmtTime(b.submittedAt) + '</div>' +
        (r ? '<div class="muted">读数 ' + b.readings.length +
          ' · 应用 ' + (r.applied ? r.applied.length : 0) +
          ' · 冲突 ' + (r.conflicts ? r.conflicts.length : 0) +
          ' · 待补测 ' + (r.pending ? r.pending.length : 0) +
          ' · 重传 ' + (r.retransmissions ? r.retransmissions.length : 0) + '</div>' : '') +
        (fail ? '<div class="muted red">失败原因：' + fail + '（已从最后确认标记恢复）</div>' : '') +
        '<details><summary>原始读数</summary><div class="reading-list">' +
        b.readings.map(function (rd) {
          return '<div class="reading">' + rd.opNo + ' · ' + rd.markerCode + ' · ' + rd.thickness + 'cm · ' +
            rd.calibrationNo + ' · ' + fmtTime(rd.measuredAt) + ' · 基准 ' + (rd.baselineVersion || '无') + '</div>';
        }).join('') + '</div></details>' +
        '</div>';
    }).join('');
    tabBody.innerHTML = html;
  }

  function renderRules() {
    var html = '<h2>规则</h2>';
    html += '<h3>基准面版本</h3>';
    html += state.baselines.map(function (b) {
      return '<div class="rule-row' + (b.active ? ' active' : '') + '"><span>' +
        b.version + ' ' + b.name + ' · ' + b.establishedAt + (b.active ? '（当前）' : '') +
        '</span>' + (b.active ? '' : '<button data-activate="' + b.id + '" class="secondary">启用</button>') + '</div>';
    }).join('');

    html += '<h3>设备校准</h3>';
    html += state.calibrations.map(function (c) {
      var valid = App.rules.isCalibrationValid(c, nowIso());
      return '<div class="rule-row"><span>' + c.code + ' ' + c.equipment + ' · ' +
        c.validFrom + ' ~ ' + c.validTo + (valid ? '' : '（已过期）') + '</span></div>';
    }).join('');

    html += '<h3>淤积阈值</h3>';
    html += '<div class="rule-row"><span>厚度 ≥ </span><input type="number" id="thresholdInput" value="' +
      state.threshold + '" style="width:80px"><span> cm 时建议清淤</span></div>';

    html += '<h3>新增校准</h3>';
    html += '<div class="form-inline">' +
      '<input id="calCode" placeholder="校准号">' +
      '<input id="calEquip" placeholder="设备">' +
      '<input id="calFrom" type="date">' +
      '<input id="calTo" type="date">' +
      '<button id="btnAddCal" class="secondary">添加</button>' +
      '</div>';

    tabBody.innerHTML = html;
    tabBody.querySelectorAll('[data-activate]').forEach(function (btn) {
      btn.onclick = function () { activateBaseline(btn.dataset.activate); };
    });
    var t = $('#thresholdInput');
    if (t) t.onchange = function () {
      state.threshold = Number(t.value);
      recompute(); save(); render();
      toast('淤积阈值已调整为 ' + state.threshold + 'cm，建议重算');
    };
    var add = $('#btnAddCal');
    if (add) add.onclick = addCalibration;
  }

  function addCalibration() {
    var code = $('#calCode').value.trim();
    var equip = $('#calEquip').value.trim();
    var from = $('#calFrom').value;
    var to = $('#calTo').value;
    if (!code || !from || !to) { toast('请填写完整校准信息（校准号、有效期）'); return; }
    state.calibrations.push({
      id: 'cal-' + Date.now(), code: code,
      equipment: equip || '未命名设备', validFrom: from, validTo: to
    });
    save();
    render();
    toast('已添加校准 ' + code);
  }

  /* ---------------- 地图交互 ---------------- */
  function startDrag(id, e) {
    var rect = map.getBoundingClientRect();
    var moved = false;
    function move(ev) {
      var x = Math.max(0, Math.min(100, (ev.clientX - rect.left) / rect.width * 100));
      var y = Math.max(0, Math.min(100, (ev.clientY - rect.top) / rect.height * 100));
      var m = state.markers.find(function (mm) { return mm.id === id; });
      if (!m) return;
      m.x = Number(x.toFixed(2));
      m.y = Number(y.toFixed(2));
      moved = true;
      didDrag = true;
      renderMap();
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        var m = state.markers.find(function (mm) { return mm.id === id; });
        if (m) moveMarker(id, m.x, m.y);
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  map.addEventListener('click', function (e) {
    if (didDrag) { didDrag = false; return; }
    if (e.target.closest('.marker')) return;
    var rect = map.getBoundingClientRect();
    var x = ((e.clientX - rect.left) / rect.width * 100).toFixed(2);
    var y = ((e.clientY - rect.top) / rect.height * 100).toFixed(2);
    addMarker(x, y);
  });

  /* ---------------- 其它 ---------------- */
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 3800);
  }

  function exportArchive() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dredge-archive-' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------------- 事件绑定 ---------------- */
  $('#tabs').querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { tab = b.dataset.tab; render(); };
  });
  $('#btnLeft').onclick = function () { submitBatch('left'); };
  $('#btnRight').onclick = function () { submitBatch('right'); };
  $('#btnFinalize').onclick = function () {
    App.archive.finalizeCycle(state);
    save();
    toast('本轮合并已确认，现场值已存档');
  };
  $('#btnRetransmit').onclick = retransmit;
  $('#btnFail').onclick = failDrill;
  $('#btnExport').onclick = exportArchive;

  /* ---------------- 启动 ---------------- */
  window.App = window.App || {};
  window.App.ui = { render: render, recompute: recompute };
  if (!load()) seed();
  render();
  save();
})();
