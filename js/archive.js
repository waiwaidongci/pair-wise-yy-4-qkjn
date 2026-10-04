"use strict";
/*
 * 批次存档模块（archive.js）
 * 职责：状态与存档——测量批次事务合并（失败回滚到最后确认标记）、操作号幂等、
 * 校准登记、基准面版本、检查点恢复、审计留查。规则判断全部委托 Rules。
 */
window.Archive = (() => {
  const KEY = "zfl31State";
  const LEGACY_KEY = "zfl30Marks"; // 上一版单文件应用的标记数据
  const MAX_AUDIT = 300;
  const MAX_CHECKPOINTS = 10;
  let state = null;

  const now = () => new Date().toISOString();
  const clone = o => JSON.parse(JSON.stringify(o));
  const uid = p => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function blank() {
    return {
      datum: { version: "VD-2026.1", name: "遗址基准面", establishedAt: now(), note: "初始基准" },
      datumHistory: [],
      calibrations: {},     // 校准号 → { device, validFrom, validUntil, revoked }
      markers: [],          // 标记（含 datumVersion，位置挂在基准上）
      measurements: [],     // 全部入账读数（留查，含被拒与待补测）
      opIndex: {},          // 操作号 → 批次号（同号重传只认首次）
      batches: [],          // 批次存档（含失败记录）
      markerStates: {},     // markerId → { reading, status, conflict? }
      checkpoints: [],      // 最后确认标记快照，供合并失败恢复
      recommendations: [],  // 全部建议版本（留查，status=active 为当前）
      epoch: 0,             // 基准或标记位置每改一次 +1，建议随失效重算
      audit: []
    };
  }

  function audit(event, detail) {
    state.audit.unshift({ at: now(), event, detail });
    if (state.audit.length > MAX_AUDIT) state.audit.length = MAX_AUDIT;
  }

  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

  function seed() {
    state.calibrations = {
      "CAL-A1": { id: "CAL-A1", device: "A船测深仪", validFrom: "2026-01-01", validUntil: "2026-12-31T23:59:59" },
      "CAL-B1": { id: "CAL-B1", device: "B船测深仪", validFrom: "2026-01-01", validUntil: "2026-12-31T23:59:59" },
      "CAL-OLD": { id: "CAL-OLD", device: "备用测深仪", validFrom: "2025-01-01", validUntil: "2025-12-31T23:59:59" }
    };
    const v = state.datum.version;
    state.markers = [
      { id: uid("M"), code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋", datumVersion: v },
      { id: uid("M"), code: "W-003", type: "wood", dive: "DIVE-02", x: 58, y: 39, depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁", datumVersion: v },
      { id: uid("M"), code: "M-004", type: "metal", dive: "DIVE-03", x: 35, y: 62, depth: "18.5m", orientation: "南", condition: "锈蚀", note: "", datumVersion: v },
      { id: uid("M"), code: "L-901", type: "unknown", dive: "DIVE-00", x: 70, y: 55, depth: "未知", orientation: "", condition: "旧档案迁移", note: "缺基准面版本", datumVersion: null }
    ];
    audit("初始化", "基准 " + v + " 建立，登记校准 3 台；旧标记 L-901 缺基准，归待补测");
    recompute("初始化");
  }

  function load() {
    try { state = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { state = null; }
    if (state) return;
    state = blank();
    // 旧数据迁移：缺基准面版本的标记先归待补测
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]"); } catch { legacy = []; }
    if (legacy.length) {
      state.markers = legacy.map(m => ({ ...m, datumVersion: m.datumVersion || null }));
      audit("旧数据迁移", legacy.length + " 个标记缺少基准面版本，已归待补测");
      recompute("旧数据迁移");
    } else {
      seed();
    }
    save();
  }

  // ---------- 检查点：合并失败后从最后确认标记恢复 ----------
  function checkpoint(reason) {
    return {
      id: uid("CKP"), at: now(), reason,
      snapshot: { markerStates: clone(state.markerStates), measurements: clone(state.measurements), opIndex: clone(state.opIndex) }
    };
  }
  function commitCheckpoint(cp, reason) {
    state.checkpoints.unshift({ id: cp.id, at: cp.at, reason, snapshot: cp.snapshot });
    if (state.checkpoints.length > MAX_CHECKPOINTS) state.checkpoints.length = MAX_CHECKPOINTS;
  }
  function restore(cp) {
    state.markerStates = clone(cp.snapshot.markerStates);
    state.measurements = clone(cp.snapshot.measurements);
    state.opIndex = clone(cp.snapshot.opIndex);
  }
  function recoverLastCheckpoint() {
    const cp = state.checkpoints[0];
    if (!cp) return null;
    restore(cp);
    audit("手动恢复", "回到最后确认标记（" + cp.id + " · " + cp.reason + "）");
    recompute("从检查点恢复");
    save();
    return cp;
  }

  // ---------- 建议：基准或标记位置一改，立即失效重算，旧版本留查 ----------
  function recompute(reason) {
    const prev = state.recommendations.find(r => r.status === "active");
    if (prev) prev.status = "invalidated";
    const rec = Rules.computeRecommendations(state.markers, state.markerStates, state.calibrations, state.datum, state.epoch);
    rec.id = uid("REC");
    rec.computedAt = now();
    rec.status = "active";
    rec.reason = reason;
    state.recommendations.unshift(rec);
    audit("建议重算", reason + " → 当前 " + rec.items.length + " 项清淤建议");
    return rec;
  }

  // ---------- 批次合并（事务）：任一笔结构性错误 → 整批回滚 ----------
  function mergeBatch(batch) {
    const cp = checkpoint("批次 " + batch.batchId + " 合并前");
    const result = {
      batchId: batch.batchId, ship: batch.ship, receivedAt: now(),
      received: (batch.measurements || []).length,
      adopted: 0, duplicates: 0, keptCurrent: 0, pending: 0, conflicts: [],
      status: "merged", error: null
    };
    try {
      const sorted = [...(batch.measurements || [])].sort((x, y) => (Date.parse(x.measuredAt) || 0) - (Date.parse(y.measuredAt) || 0));
      for (const m of sorted) {
        if (!m.opId || !m.markerId || m.thickness === null || m.thickness === undefined || m.thickness === "" || !m.measuredAt) {
          throw new Error("测量缺必填字段（操作号/标记/厚度/测量时刻）");
        }
        if (state.opIndex[m.opId]) { // 同号重传只认首次
          result.duplicates++;
          audit("重传忽略", m.opId + " 已入账，只认首次");
          continue;
        }
        const marker = state.markers.find(k => k.id === m.markerId);
        if (!marker) throw new Error("未知标记 " + m.markerId);
        state.opIndex[m.opId] = batch.batchId;
        const reading = { ...m, ship: batch.ship, batchId: batch.batchId, receivedAt: result.receivedAt };
        state.measurements.push(reading); // 原读数留查
        if (!m.datumVersion) { // 缺基准 → 待补测，不参与判断
          state.markerStates[m.markerId] = { reading, status: "pending_remeasure" };
          result.pending++;
          audit("待补测", marker.code + " 读数 " + m.opId + " 缺基准面版本");
          continue;
        }
        const merged = Rules.mergeReading(state.markerStates[m.markerId], reading);
        state.markerStates[m.markerId] = merged.state;
        if (merged.outcome === "conflict") {
          result.conflicts.push(m.markerId);
          audit("冲突", marker.code + " 两船同时提交，暂留现场值，处理前不进清淤建议");
        } else if (merged.outcome === "kept_current" || merged.outcome === "same_value") {
          result.keptCurrent++; // 旧读数不覆盖新值
        } else {
          result.adopted++;
        }
        // 读数在当前基准下入账 → 标记视为已在新基准下复测，自动确认
        if (state.markerStates[m.markerId].reading === reading &&
            reading.datumVersion === state.datum.version &&
            marker.datumVersion !== state.datum.version) {
          marker.datumVersion = state.datum.version;
          state.epoch++;
          audit("补测确认", marker.code + " 已在基准 " + state.datum.version + " 下复测");
        }
      }
      state.batches.unshift(result);
      commitCheckpoint(cp, "批次 " + batch.batchId + " 合并完成");
      recompute("批次 " + batch.batchId + "（" + (batch.ship || "?") + "船）合并");
    } catch (err) {
      restore(cp); // 从最后确认标记恢复
      result.status = "failed";
      result.error = err.message;
      result.restoredFrom = cp.id;
      state.batches.unshift(result);
      audit("合并失败", batch.batchId + "：" + err.message + "，已从最后确认标记恢复（" + cp.id + "）");
    }
    save();
    return result;
  }

  // ---------- 基准 / 校准 / 标记 ----------
  function setDatum(version, note) {
    if (!version || version === state.datum.version) return false;
    state.datumHistory.unshift({ ...state.datum, retiredAt: now() });
    state.datum = { version, name: state.datum.name, establishedAt: now(), note: note || "" };
    state.epoch++;
    audit("基准变更", "→ " + version + "，建议立即失效重算，原读数留查");
    recompute("基准变更至 " + version);
    save();
    return true;
  }

  function registerCalibration(cal) {
    if (!cal.id) return false;
    const norm = { ...cal };
    if (norm.validUntil && norm.validUntil.length === 10) norm.validUntil += "T23:59:59"; // 日期型失效期算到当日末
    state.calibrations[norm.id] = norm;
    audit("校准登记", norm.id + "（" + (norm.device || "?") + "）有效期 " + (norm.validFrom || "-") + " ~ " + (norm.validUntil || "-"));
    recompute("校准登记 " + norm.id);
    save();
    return true;
  }

  function putMarker(marker, positionChanged) {
    const i = state.markers.findIndex(m => m.id === marker.id);
    if (i >= 0) state.markers[i] = marker; else state.markers.push(marker);
    if (positionChanged) {
      state.epoch++;
      audit("位置变更", marker.code + " 位置/基准更新，建议失效重算");
      recompute("标记位置变更（" + marker.code + "）");
    }
    save();
  }

  function removeMarker(id) {
    const marker = state.markers.find(m => m.id === id);
    state.markers = state.markers.filter(m => m.id !== id);
    delete state.markerStates[id]; // 测量留查，状态清除
    state.epoch++;
    audit("标记删除", (marker ? marker.code : id) + "，建议失效重算");
    recompute("标记删除");
    save();
  }

  function confirmMarkerDatum(id) {
    const marker = state.markers.find(m => m.id === id);
    if (!marker || marker.datumVersion === state.datum.version) return false;
    marker.datumVersion = state.datum.version;
    state.epoch++;
    audit("补测确认", marker.code + " 位置按当前基准 " + state.datum.version + " 确认");
    recompute("标记补测确认（" + marker.code + "）");
    save();
    return true;
  }

  function resolveConflict(markerId, choice) {
    const st = state.markerStates[markerId];
    const next = Rules.resolveConflict(st, choice);
    if (next === st) return false;
    state.markerStates[markerId] = next;
    const marker = state.markers.find(m => m.id === markerId);
    audit("冲突处理", (marker ? marker.code : markerId) + " 采用" + (choice === "field" ? "现场值" : choice === "a" ? "甲方值" : "乙方值") + "（" + next.reading.opId + "）");
    recompute("冲突处理完成");
    save();
    return true;
  }

  return {
    load, save, mergeBatch, recoverLastCheckpoint,
    setDatum, registerCalibration, putMarker, removeMarker, confirmMarkerDatum, resolveConflict,
    get state() { return state; }
  };
})();
