/* ============================================================
 * 批次存档模块
 * 测量批次与原始读数存档；同号重传只认首次；合并按事务处理，
 * 失败时从最后确认标记恢复；两边同测同一标记时保留现场值。
 * ============================================================ */
(function () {
  'use strict';

  var clone = function (v) {
    if (v === undefined) return undefined;
    return JSON.parse(JSON.stringify(v));
  };

  var archive = {
    /* 同号重传只认首次：按操作号去重 */
    dedup: function (readings) {
      var seen = {};
      var accepted = [];
      var ignored = [];
      readings.forEach(function (r) {
        if (seen[r.opNo]) { ignored.push(r); return; }
        seen[r.opNo] = true;
        accepted.push(r);
      });
      return { accepted: accepted, ignored: ignored };
    },

    /* 合并批次（事务）：失败时从最后确认标记恢复 */
    mergeBatch: function (state, batch) {
      var before = clone(state.markers);
      var out = { applied: [], conflicts: [], pending: [], retransmissions: [], failed: null };
      try {
        // 同号重传只认首次
        var d = archive.dedup(batch.readings);
        var accepted = d.accepted;
        out.retransmissions = d.ignored.map(function (r) { return r.opNo; });

        accepted.forEach(function (raw) {
          // 跨轮次重传：操作号已存在则只认首次
          if (state.readings.some(function (r) { return r.opNo === raw.opNo; })) {
            if (out.retransmissions.indexOf(raw.opNo) === -1) out.retransmissions.push(raw.opNo);
            return;
          }

          // 旧数据缺少基准 → 先归待补测
          if (raw.baselineVersion == null || raw.baselineVersion === '') {
            archive._archiveReading(state, raw);
            out.pending.push(raw.opNo);
            return;
          }

          var marker = state.markers.find(function (m) { return m.code === raw.markerCode; });
          if (!marker) {
            throw new Error('未知标记编号 ' + raw.markerCode + '，整批回滚到最后确认标记');
          }
          if (!window.App.rules.calibrationFor(state, raw.calibrationNo)) {
            throw new Error('未知校准号 ' + raw.calibrationNo + '，整批回滚到最后确认标记');
          }

          // 原读数留查
          archive._archiveReading(state, raw);

          // 只有校准有效且基准一致的读数能参与当前淤积判断
          if (!window.App.rules.isEligible(state, raw)) return;

          // 同轮次两边都测了同一标记 → 冲突，保留现场值
          var w = state.window[raw.markerCode] || (state.window[raw.markerCode] = {});
          var otherSide = batch.side === 'left' ? 'right' : 'left';
          if (w[otherSide]) {
            var confirmed = state.confirmedMarkers.find(function (m) { return m.code === raw.markerCode; });
            if (confirmed) {
              marker.thickness = confirmed.thickness;
              marker.lastReading = clone(confirmed.lastReading);
            }
            state.blockedMarkers[raw.markerCode] = true;
            archive._openConflict(state, raw.markerCode, w[otherSide], raw.opNo);
            out.conflicts.push(raw.markerCode);
          } else {
            w[batch.side] = raw.opNo;
            marker.thickness = raw.thickness;
            marker.lastReading = {
              opNo: raw.opNo,
              calibrationNo: raw.calibrationNo,
              measuredAt: raw.measuredAt,
              baselineVersion: raw.baselineVersion,
              thickness: raw.thickness
            };
            out.applied.push(raw.opNo);
          }
        });

        batch.status = '已合并';
        batch.result = out;
      } catch (err) {
        // 合并失败 → 从最后确认标记恢复
        state.markers = before;
        batch.status = '合并失败';
        batch.failReason = err.message;
        out.failed = err.message;
      }
      return out;
    },

    /* 完成本轮合并：确认现场值，作为下次恢复依据 */
    finalizeCycle: function (state) {
      state.confirmedMarkers = clone(state.markers);
      state.window = {};
    },

    /* 冲突处理：采用左船 / 采用右船 / 维持现场 / 标记待补测 */
    resolveConflict: function (state, markerCode, choice) {
      var conflict = state.conflicts.find(function (c) {
        return c.markerCode === markerCode && c.status === '未处理';
      });
      if (!conflict) return;
      var marker = state.markers.find(function (m) { return m.code === markerCode; });

      if (choice === 'left' || choice === 'right') {
        var opNo = choice === 'left' ? conflict.leftOp : conflict.rightOp;
        var reading = state.readings.find(function (r) { return r.opNo === opNo; });
        if (reading && marker) {
          marker.thickness = reading.thickness;
          marker.lastReading = {
            opNo: reading.opNo,
            calibrationNo: reading.calibrationNo,
            measuredAt: reading.measuredAt,
            baselineVersion: reading.baselineVersion,
            thickness: reading.thickness
          };
        }
      } else if (choice === 'field') {
        var confirmed = state.confirmedMarkers.find(function (m) { return m.code === markerCode; });
        if (confirmed && marker) {
          marker.thickness = confirmed.thickness;
          marker.lastReading = clone(confirmed.lastReading);
        }
      }
      // choice === 'pending'：维持现状并标记待补测

      conflict.status = '已处理';
      conflict.resolution = choice;
      conflict.resolvedAt = Date.now();
      delete state.blockedMarkers[markerCode];
      delete state.window[markerCode];
    },

    _archiveReading: function (state, reading) {
      if (!state.readings.some(function (r) { return r.opNo === reading.opNo; })) {
        state.readings.push(clone(reading));
      }
    },

    _openConflict: function (state, markerCode, leftOp, rightOp) {
      var exists = state.conflicts.some(function (c) {
        return c.markerCode === markerCode && c.status === '未处理';
      });
      if (exists) return;
      state.conflicts.push({
        id: 'CF-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        markerCode: markerCode,
        leftOp: leftOp,
        rightOp: rightOp,
        status: '未处理',
        resolution: null,
        createdAt: Date.now(),
        resolvedAt: null
      });
    }
  };

  window.App = window.App || {};
  window.App.archive = archive;
})();
