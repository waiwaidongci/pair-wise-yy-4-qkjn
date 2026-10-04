/* ============================================================
 * 规则模块
 * 基准面版本、设备校准、淤积判定与建议失效规则。
 * 只有校准有效且基准一致的读数，才能参与当前淤积判断。
 * ============================================================ */
(function () {
  'use strict';

  var rules = {
    /* 当前启用的基准面版本 */
    activeBaseline: function (state) {
      return state.baselines.find(function (b) { return b.active; }) || null;
    },

    baselineByVersion: function (state, version) {
      return state.baselines.find(function (b) { return b.version === version; }) || null;
    },

    calibrationFor: function (state, code) {
      return state.calibrations.find(function (c) { return c.code === code; }) || null;
    },

    /* 设备校准在测量时刻是否有效 */
    isCalibrationValid: function (cal, atTime) {
      if (!cal || !atTime) return false;
      var t = new Date(atTime).getTime();
      if (isNaN(t)) return false;
      var from = new Date(cal.validFrom + 'T00:00:00').getTime();
      var to = new Date(cal.validTo + 'T23:59:59').getTime();
      return from <= t && t <= to;
    },

    /* 读数能否参与当前淤积判断：校准有效 + 基准一致 */
    isEligible: function (state, reading) {
      var cal = rules.calibrationFor(state, reading.calibrationNo);
      if (!rules.isCalibrationValid(cal, reading.measuredAt)) return false;
      var active = rules.activeBaseline(state);
      if (!active) return false;
      return reading.baselineVersion === active.version;
    },

    /* 淤积判定：厚度达到阈值即建议清淤 */
    needsDredging: function (state, thickness) {
      return Number(thickness) >= state.threshold;
    },

    /* 建议失效原因 */
    invalidReasons: {
      baseline: '基准面变更，清淤建议已按新基准失效重算',
      marker: '标记位置变更，清淤建议已失效重算'
    }
  };

  window.App = window.App || {};
  window.App.rules = rules;
})();
