"use strict";
/*
 * 规则模块（rules.js）
 * 职责：统一基准下的判断规则——校准有效性、读数合并、同时冲突、清淤建议计算。
 * 只做纯判断，不碰存储，不碰页面；存储找 archive.js，页面找 app.js。
 */
window.Rules = (() => {
  const SILT_THRESHOLD = 0.3;   // 回淤厚度 ≥ 此值建议清淤（米）
  const URGENT_THRESHOLD = 0.6; // 回淤厚度 ≥ 此值紧急清淤（米）

  const ts = v => {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };

  // 校准号在测量时刻是否有效（未登记、已吊销、超有效期均无效）
  function calibrationValidAt(cal, measuredAt) {
    if (!cal || cal.revoked) return false;
    const t = ts(measuredAt);
    if (t === null) return false;
    if (cal.validFrom && t < ts(cal.validFrom)) return false;
    if (cal.validUntil && t > ts(cal.validUntil)) return false;
    return true;
  }

  // 读数能否参与当前淤积判断：校准有效 且 基准一致
  function eligibility(reading, calibrations, datumVersion) {
    if (!reading) return { ok: false, reason: "无读数" };
    if (!reading.datumVersion) return { ok: false, reason: "缺少基准面版本，待补测" };
    if (reading.datumVersion !== datumVersion) {
      return { ok: false, reason: "基准不一致（读数 " + reading.datumVersion + " ≠ 当前 " + datumVersion + "）" };
    }
    if (!calibrationValidAt(calibrations[reading.calibrationId], reading.measuredAt)) {
      return { ok: false, reason: "校准无效（" + (reading.calibrationId || "无校准号") + "）" };
    }
    return { ok: true, reason: "" };
  }

  /*
   * 把一笔读数合并进标记状态：
   * - 测量时刻更新者胜，旧读数不得覆盖新值（修复“合并时旧读数覆盖新值”）；
   * - 同一测量时刻且厚度不同 → 冲突：暂留现场值，处理前该标记不进清淤建议；
   * - 冲突未处理时来了更新的读数 → 采用新读数，冲突自然了结。
   * 返回 { state, outcome }，不修改入参。
   */
  function mergeReading(state, reading) {
    if (!state || !state.reading) return { state: { reading, status: "ok" }, outcome: "adopted" };
    const cur = state.reading;
    const tIn = ts(reading.measuredAt);
    const tCur = ts(cur.measuredAt);
    if (tIn !== null && (tCur === null || tIn > tCur)) {
      return { state: { reading, status: "ok" }, outcome: state.status === "conflict" ? "adopted_newer_resolved" : "adopted_newer" };
    }
    if (tCur === null || tIn === null || tIn < tCur) return { state, outcome: "kept_current" };
    if (Number(cur.thickness) === Number(reading.thickness)) return { state, outcome: "same_value" };
    // 两边同时提交同一标记：保留现场值
    const kept = cur.origin === "field" ? cur : reading.origin === "field" ? reading : cur;
    return {
      state: { reading: kept, status: "conflict", conflict: { a: cur, b: reading, keptOpId: kept.opId } },
      outcome: "conflict"
    };
  }

  // 处理冲突：choice 为 "a" | "b" | "field"（现场值）
  function resolveConflict(state, choice) {
    if (!state || state.status !== "conflict" || !state.conflict) return state;
    const { a, b } = state.conflict;
    const pick = choice === "a" ? a : choice === "b" ? b : (a.origin === "field" ? a : b.origin === "field" ? b : a);
    return { reading: pick, status: "ok", resolvedAt: new Date().toISOString(), resolvedFrom: [a.opId, b.opId] };
  }

  /*
   * 计算清淤建议。以下标记一律排除并说明原因：
   * 冲突未处理 / 待补测 / 校准无效 / 基准不一致。
   */
  function computeRecommendations(markers, markerStates, calibrations, datum, epoch) {
    const items = [];
    const excluded = [];
    for (const m of markers) {
      if (m.datumVersion !== datum.version) {
        excluded.push({ markerId: m.id, code: m.code, reason: m.datumVersion ? "标记基准已过期（" + m.datumVersion + "），待补测" : "标记缺少基准，待补测" });
        continue;
      }
      const st = markerStates[m.id];
      if (!st || !st.reading) continue; // 无测量，不参与
      if (st.status === "conflict") { excluded.push({ markerId: m.id, code: m.code, reason: "冲突未处理" }); continue; }
      if (st.status === "pending_remeasure") { excluded.push({ markerId: m.id, code: m.code, reason: "读数缺基准，待补测" }); continue; }
      const el = eligibility(st.reading, calibrations, datum.version);
      if (!el.ok) { excluded.push({ markerId: m.id, code: m.code, reason: el.reason }); continue; }
      const thickness = Number(st.reading.thickness);
      if (thickness >= SILT_THRESHOLD) {
        items.push({
          markerId: m.id, code: m.code, thickness,
          level: thickness >= URGENT_THRESHOLD ? "紧急" : "常规",
          measuredAt: st.reading.measuredAt, opId: st.reading.opId
        });
      }
    }
    items.sort((x, y) => y.thickness - x.thickness);
    return { items, excluded, datumVersion: datum.version, epoch };
  }

  return { SILT_THRESHOLD, URGENT_THRESHOLD, calibrationValidAt, eligibility, mergeReading, resolveConflict, computeRecommendations };
})();
