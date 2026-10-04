"use strict";
/*
 * 页面操作模块（app.js）
 * 职责：地图、表单、批次提交、冲突处理与建议展示。
 * 规则问 Rules，存取走 Archive，本模块不直接改数据。
 */
(() => {
  Archive.load();

  const $ = s => document.querySelector(s);
  const map = $("#map");
  const form = $("#form");
  const mform = $("#mform");
  const cform = $("#cform");
  const list = $("#list");
  const filter = $("#filter");
  const view = $("#view");
  const listTitle = $("#listTitle");
  const S = () => Archive.state;

  const typeNames = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtT = t => new Date(t).toLocaleString("zh-CN", { hour12: false });
  const pad = n => String(n).padStart(2, "0");
  const localDT = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());

  let pending = null; // 地图上点选的位置
  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  // ---------- 页签 ----------
  document.querySelectorAll(".tabs button").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b === btn));
      document.querySelectorAll(".tabpage").forEach(p => p.style.display = p.id === "tab-" + btn.dataset.tab ? "" : "none");
    };
  });
  function gotoTab(name) { document.querySelector('.tabs button[data-tab="' + name + '"]').click(); }

  // ---------- 地图 ----------
  for (let i = 0; i < 7; i++) {
    const rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    map.appendChild(rib);
  }
  function markerClass(m) {
    const st = S().markerStates[m.id];
    const rec = S().recommendations.find(r => r.status === "active");
    if (st && st.status === "conflict") return "conflict";
    if (rec && rec.items.some(i => i.markerId === m.id)) return "silt";
    if (m.datumVersion !== S().datum.version || (st && st.status === "pending_remeasure")) return "pending";
    return "";
  }
  function renderMap() {
    map.querySelectorAll(".marker").forEach(el => el.remove());
    const data = filter.value ? S().markers.filter(m => m.type === filter.value) : S().markers;
    data.forEach(mark => {
      const el = document.createElement("button");
      el.className = "marker " + mark.type + " " + markerClass(mark) + (mark.id === form.elements.mid.value ? " selected" : "");
      el.style.left = mark.x + "%";
      el.style.top = mark.y + "%";
      el.textContent = mark.code.slice(0, 2);
      el.title = mark.code;
      el.onclick = event => { event.stopPropagation(); edit(mark.id); };
      map.appendChild(el);
    });
  }
  map.addEventListener("click", event => {
    const rect = map.getBoundingClientRect();
    pending = { x: Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2)), y: Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2)) };
    form.reset();
    form.elements.mid.value = "";
    form.elements.code.value = "M-" + String(S().markers.length + 1).padStart(3, "0");
    form.elements.dive.value = "DIVE-01";
    renderAll();
  });

  // ---------- 标记页 ----------
  function renderList() {
    const data = filter.value ? S().markers.filter(m => m.type === filter.value) : S().markers;
    if (view.value === "timeline") {
      listTitle.textContent = "潜次时间线";
      list.className = "timeline";
      const groups = data.reduce((g, item) => ((g[item.dive] ||= []).push(item), g), {});
      list.innerHTML = Object.entries(groups).map(([dive, items]) =>
        '<div class="item"><b>' + esc(dive) + '</b><div class="muted">新增' + items.length + '个标记</div>' +
        items.map(i => "<div>" + esc(i.code) + " · " + typeNames[i.type] + "</div>").join("") + "</div>").join("");
      return;
    }
    listTitle.textContent = "标记列表";
    list.className = "list";
    list.innerHTML = data.map(m => {
      const stale = m.datumVersion !== S().datum.version;
      return '<div class="item' + (m.id === form.elements.mid.value ? " active" : "") + '" data-id="' + m.id + '"><b>' + esc(m.code) + "</b> " +
        '<span class="pill">' + typeNames[m.type] + "</span>" + (stale ? ' <span class="pill gray">待补测</span>' : "") +
        '<div class="muted">' + esc(m.dive) + " · " + esc(m.depth) + " · " + esc(m.orientation || "") + "</div><div>" + esc(m.condition || "") + "</div></div>";
    }).join("");
    list.querySelectorAll("[data-id]").forEach(el => el.onclick = () => edit(el.dataset.id));
  }
  function edit(id) {
    const mark = S().markers.find(m => m.id === id);
    if (!mark) return;
    const f = form.elements;
    f.mid.value = mark.id;
    f.code.value = mark.code;
    f.type.value = mark.type;
    f.dive.value = mark.dive;
    f.depth.value = mark.depth;
    f.orientation.value = mark.orientation || "";
    f.condition.value = mark.condition || "";
    f.note.value = mark.note || "";
    pending = { x: mark.x, y: mark.y };
    renderAll();
  }
  form.onsubmit = event => {
    event.preventDefault();
    const f = form.elements;
    const id = f.mid.value;
    const old = S().markers.find(m => m.id === id);
    const pos = pending || (old ? { x: old.x, y: old.y } : { x: 50, y: 50 });
    const positionChanged = !old || old.x !== pos.x || old.y !== pos.y;
    const marker = {
      ...(old || {}),
      id: id || "M-" + Date.now().toString(36),
      code: f.code.value, type: f.type.value, dive: f.dive.value, depth: f.depth.value,
      orientation: f.orientation.value, condition: f.condition.value, note: f.note.value,
      x: pos.x, y: pos.y,
      // 位置一动就挂到当前基准；未动则保留原基准（可能仍待补测）
      datumVersion: positionChanged ? S().datum.version : (old ? old.datumVersion : S().datum.version)
    };
    Archive.putMarker(marker, positionChanged);
    form.reset();
    form.elements.mid.value = "";
    pending = null;
    renderAll();
  };
  $("#deleteBtn").onclick = () => {
    const id = form.elements.mid.value;
    if (!id) return;
    Archive.removeMarker(id);
    form.reset();
    pending = null;
    renderAll();
  };

  // ---------- 回淤测量页 ----------
  function resetMeasureForm() {
    mform.reset();
    mform.elements.measuredAt.value = localDT(new Date());
    newOpId();
  }
  function newOpId() {
    mform.elements.opId.value = "OP-" + mform.elements.ship.value + "-" + Date.now().toString(36).toUpperCase();
  }
  mform.elements.ship.onchange = newOpId;
  mform.onsubmit = event => {
    event.preventDefault();
    const f = mform.elements;
    const reading = {
      opId: f.opId.value.trim(),
      markerId: f.markerId.value,
      thickness: Number(f.thickness.value),
      calibrationId: f.calibrationId.value,
      measuredAt: new Date(f.measuredAt.value).toISOString(),
      datumVersion: S().datum.version, // 页面提交的测量一律挂当前基准
      origin: f.origin.value
    };
    const res = Archive.mergeBatch({ batchId: "BATCH-" + f.ship.value + "-" + Date.now().toString(36), ship: f.ship.value, measurements: [reading] });
    toast(summarize(res));
    resetMeasureForm();
    renderAll();
  };
  function summarize(res) {
    if (res.status === "failed") return "批次 " + res.batchId + " 合并失败：" + res.error + "，已从最后确认标记恢复";
    return "批次 " + res.batchId + "：采用 " + res.adopted + " · 旧值保留 " + res.keptCurrent + " · 重传忽略 " + res.duplicates + " · 待补测 " + res.pending + " · 冲突 " + res.conflicts.length;
  }

  // 演示：两船各报一批，覆盖冲突、校准过期、同号重传
  $("#demoBtn").onclick = () => {
    const st = S();
    const ms = st.markers.filter(m => m.datumVersion === st.datum.version);
    if (ms.length < 2) return toast("当前基准下可用标记不足，请先确认标记");
    const t0 = new Date(Date.now() - 3600e3).toISOString();
    const t1 = new Date(Date.now() - 1800e3).toISOString();
    const v = st.datum.version;
    const r1 = Archive.mergeBatch({
      batchId: "BATCH-A-DEMO", ship: "A", measurements: [
        { opId: "OP-A-001", markerId: ms[0].id, thickness: 0.42, calibrationId: "CAL-A1", measuredAt: t0, datumVersion: v, origin: "field" },
        { opId: "OP-A-002", markerId: ms[1].id, thickness: 0.18, calibrationId: "CAL-A1", measuredAt: t0, datumVersion: v, origin: "field" }
      ]
    });
    const r2 = Archive.mergeBatch({
      batchId: "BATCH-B-DEMO", ship: "B", measurements: [
        { opId: "OP-B-001", markerId: ms[0].id, thickness: 0.55, calibrationId: "CAL-B1", measuredAt: t0, datumVersion: v, origin: "office" }, // 同时异值 → 冲突，留现场值
        { opId: "OP-B-002", markerId: ms[1].id, thickness: 0.66, calibrationId: "CAL-OLD", measuredAt: t1, datumVersion: v, origin: "office" }, // 校准过期 → 不参与判断
        { opId: "OP-A-001", markerId: ms[0].id, thickness: 0.42, calibrationId: "CAL-A1", measuredAt: t0, datumVersion: v, origin: "field" } // 同号重传 → 只认首次
      ]
    });
    toast(summarize(r1) + "｜" + summarize(r2));
    renderAll();
  };
  // 演示：故障批次（未知标记）→ 整批回滚，从最后确认标记恢复
  $("#faultBtn").onclick = () => {
    const res = Archive.mergeBatch({
      batchId: "BATCH-X-" + Date.now().toString(36), ship: "A", measurements: [
        { opId: "OP-X-" + Date.now().toString(36), markerId: "MK-GHOST", thickness: 0.5, calibrationId: "CAL-A1", measuredAt: new Date().toISOString(), datumVersion: S().datum.version, origin: "field" }
      ]
    });
    toast(summarize(res));
    renderAll();
  };
  $("#recoverBtn").onclick = () => {
    const cp = Archive.recoverLastCheckpoint();
    toast(cp ? "已恢复到最后确认标记（" + cp.id + "）" : "暂无检查点");
    renderAll();
  };

  // 校准登记
  cform.onsubmit = event => {
    event.preventDefault();
    const f = cform.elements;
    Archive.registerCalibration({ id: f.cid.value.trim(), device: f.device.value.trim(), validFrom: f.validFrom.value, validUntil: f.validUntil.value });
    toast("校准 " + f.cid.value.trim() + " 已登记");
    cform.reset();
    renderAll();
  };

  function renderMeasureTab() {
    const st = S();
    $("#datumNow").textContent = st.datum.version;
    const sel = mform.elements.markerId;
    const cur = sel.value;
    sel.innerHTML = st.markers.map(m =>
      '<option value="' + m.id + '">' + esc(m.code) + (m.datumVersion === st.datum.version ? "" : "（待补测）") + "</option>").join("");
    if (cur) sel.value = cur;
    const calSel = mform.elements.calibrationId;
    const curCal = calSel.value;
    calSel.innerHTML = Object.values(st.calibrations).map(c =>
      '<option value="' + esc(c.id) + '">' + esc(c.id) + "（" + esc(c.device || "") + "）</option>").join("");
    if (curCal) calSel.value = curCal;
    $("#calList").innerHTML = Object.values(st.calibrations).map(c => {
      const ok = Rules.calibrationValidAt(c, new Date().toISOString());
      return '<div class="item"><b>' + esc(c.id) + '</b> <span class="pill ' + (ok ? "green" : "red") + '">' + (ok ? "当前有效" : "已失效") + '</span>' +
        '<div class="muted">' + esc(c.device || "") + " · " + esc(c.validFrom || "-") + " ~ " + esc(c.validUntil || "-") + "</div></div>";
    }).join("");
    $("#batchList").innerHTML = st.batches.slice(0, 15).map(b =>
      '<div class="item"><b>' + esc(b.batchId) + '</b> <span class="pill ' + (b.status === "merged" ? "green" : "red") + '">' + (b.status === "merged" ? "已合并" : "失败已回滚") + "</span>" +
      '<div class="muted">' + esc(b.ship || "?") + "船 · 收到 " + b.received + " · 采用 " + b.adopted + " · 重传 " + b.duplicates + " · 保留 " + b.keptCurrent + " · 待补测 " + b.pending + " · 冲突 " + (b.conflicts || []).length + "</div>" +
      (b.error ? '<div class="muted">原因：' + esc(b.error) + "（恢复自 " + esc(b.restoredFrom || "") + "）</div>" : "") + "</div>").join("") || '<div class="muted">暂无批次</div>';
  }

  // ---------- 清淤建议页 ----------
  const fmtR = r => esc((r.ship || "?") + "船 " + r.opId) + " · " + r.thickness + "m · " + (r.origin === "field" ? "现场" : "岸上") + " · " + fmtT(r.measuredAt);
  function renderDredgeTab() {
    const st = S();
    const rec = st.recommendations.find(r => r.status === "active");
    const history = st.recommendations.filter(r => r.status === "invalidated");
    $("#recNow").innerHTML = rec ?
      '<div class="item"><b>' + esc(rec.id) + '</b> <span class="pill green">当前</span>' +
      '<div class="muted">基准 ' + esc(rec.datumVersion) + " · epoch " + rec.epoch + " · " + fmtT(rec.computedAt) + " · " + esc(rec.reason) + "</div></div>" +
      (rec.items.length ? rec.items.map(i =>
        '<div class="item"><b>' + esc(i.code) + '</b> <span class="pill ' + (i.level === "紧急" ? "red" : "orange") + '">' + i.level + "清淤</span>" +
        '<div class="muted">回淤 ' + i.thickness + "m · " + fmtT(i.measuredAt) + " · " + esc(i.opId) + "</div></div>").join("")
        : '<div class="muted">当前无需清淤的标记</div>') +
      (rec.excluded.length ? '<h3>未进入建议（' + rec.excluded.length + "）</h3>" + rec.excluded.map(e =>
        '<div class="item"><b>' + esc(e.code) + '</b><div class="muted">' + esc(e.reason) + "</div></div>").join("") : "")
      : '<div class="muted">暂无建议</div>';
    $("#recHistory").innerHTML = "<h3>历史建议（留查 " + history.length + "）</h3>" +
      history.slice(0, 8).map(r => '<div class="item"><b>' + esc(r.id) + '</b> <span class="pill gray">已失效</span>' +
        '<div class="muted">基准 ' + esc(r.datumVersion) + " · " + fmtT(r.computedAt) + " · " + r.items.length + " 项 · " + esc(r.reason) + "</div></div>").join("");

    const conflicts = st.markers.filter(m => (st.markerStates[m.id] || {}).status === "conflict");
    $("#conflictList").innerHTML = "<h3>冲突待处理（" + conflicts.length + "）</h3>" +
      (conflicts.map(m => {
        const c = st.markerStates[m.id].conflict;
        return '<div class="item"><b>' + esc(m.code) + '</b> <span class="pill orange">处理前不进建议</span>' +
          '<div class="muted">甲：' + fmtR(c.a) + '</div><div class="muted">乙：' + fmtR(c.b) + "</div>" +
          '<div class="toolbar"><button class="mini" data-res="' + m.id + ':field">保留现场值</button>' +
          '<button class="mini secondary" data-res="' + m.id + ':a">采用甲</button>' +
          '<button class="mini secondary" data-res="' + m.id + ':b">采用乙</button></div></div>';
      }).join("") || '<div class="muted">无冲突</div>');

    const pendings = [];
    st.markers.forEach(m => {
      if (m.datumVersion !== st.datum.version) pendings.push({ m, kind: "marker", reason: m.datumVersion ? "标记基准过期（" + m.datumVersion + "）" : "标记缺基准" });
    });
    Object.entries(st.markerStates).forEach(([id, s2]) => {
      if (s2.status === "pending_remeasure") {
        const m = st.markers.find(k => k.id === id);
        if (m) pendings.push({ m, kind: "reading", reason: "读数缺基准（" + s2.reading.opId + "）" });
      }
    });
    $("#pendingList").innerHTML = "<h3>待补测（" + pendings.length + "）</h3>" +
      (pendings.map(p => '<div class="item"><b>' + esc(p.m.code) + '</b> <span class="pill gray">待补测</span>' +
        '<div class="muted">' + esc(p.reason) + "</div>" +
        (p.kind === "marker"
          ? '<button class="mini" data-confirm="' + p.m.id + '">按当前基准确认位置</button>'
          : '<button class="mini" data-goto="' + p.m.id + '">去补测</button>') + "</div>").join("")
        || '<div class="muted">无待补测</div>');

    $("#auditLog").innerHTML = st.audit.slice(0, 40).map(a =>
      '<div class="item"><b>' + esc(a.event) + '</b> <span class="muted">' + fmtT(a.at) + '</span><div>' + esc(a.detail) + "</div></div>").join("");
  }
  $("#conflictList").onclick = event => {
    const btn = event.target.closest("[data-res]");
    if (!btn) return;
    const [id, choice] = btn.dataset.res.split(":");
    Archive.resolveConflict(id, choice);
    toast("冲突已处理，建议已重算");
    renderAll();
  };
  $("#pendingList").onclick = event => {
    const c = event.target.closest("[data-confirm]");
    if (c) {
      Archive.confirmMarkerDatum(c.dataset.confirm);
      toast("已按当前基准确认，建议已重算");
      renderAll();
      return;
    }
    const g = event.target.closest("[data-goto]");
    if (g) {
      gotoTab("measure");
      mform.elements.markerId.value = g.dataset.goto;
      mform.elements.thickness.focus();
    }
  };

  // ---------- 头部 ----------
  $("#datumBtn").onclick = () => {
    const v = prompt("新基准面版本号（当前 " + S().datum.version + "）", "VD-2026.2");
    if (!v) return;
    if (Archive.setDatum(v.trim(), "页面变更")) toast("基准已变更，建议立即失效重算，原读数留查");
    else toast("版本号未变化");
    renderAll();
  };
  $("#exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(S(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "siltation-archive.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  function renderAll() {
    $("#datumBadge").textContent = "基准面 " + S().datum.version + " · epoch " + S().epoch;
    renderMap();
    renderList();
    renderMeasureTab();
    renderDredgeTab();
  }
  filter.onchange = renderAll;
  view.onchange = renderAll;

  resetMeasureForm();
  renderAll();
})();
