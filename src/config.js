'use strict';
// 配置读取与"实际生效的停靠边"
//
// 设计取舍：`dock` 只允许 bottom / bottom-left / bottom-right / top 这四个**屏幕边**，
// 因为球要"往下沉"，底下必须有屏幕边可以沉进去。
// 侧边栏那种"贴左侧竖直一列"是**另一种形态**：球会横着露出窗口，观感是挂在侧栏上，
// 不是沉在窗口底部，所以不放进本扩展的主路径（用底部三个变体已经能避开左侧活动栏与右下角区域）。

const DEFAULTS = {
  enabled: true,
  dock: 'bottom',
  sink: 0.32,
  ballSize: 30,
  gap: 8,
  offset: 0,
  showCard: true,
  drag: true,
  maxRepos: 6,
};

function loadConfig(vscode) {
  const c = vscode.workspace.getConfiguration('branchOrbs');
  const pick = (k, d) => {
    const v = c.get(k);
    return v === undefined || v === null ? d : v;
  };
  return {
    enabled: pick('enabled', DEFAULTS.enabled),
    dock: pick('dock', DEFAULTS.dock),
    sink: clamp(pick('sink', DEFAULTS.sink), 0, 0.6),
    ballSize: clamp(Math.round(pick('ballSize', DEFAULTS.ballSize)), 18, 56),
    gap: clamp(Math.round(pick('gap', DEFAULTS.gap)), 0, 32),
    offset: clamp(Math.round(pick('offset', DEFAULTS.offset)), -4000, 4000),
    showCard: pick('showCard', DEFAULTS.showCard),
    drag: pick('drag', DEFAULTS.drag),
    maxRepos: clamp(Math.round(pick('maxRepos', DEFAULTS.maxRepos)), 1, 20),
  };
}

function effectiveSide(cfg) {
  if (cfg.dock === 'bottom-left') return { kind: 'corner', corner: 'left' };
  if (cfg.dock === 'bottom-right') return { kind: 'corner', corner: 'right' };
  if (cfg.dock === 'top') return { kind: 'edge', edge: 'top' };
  return { kind: 'edge', edge: 'bottom' };
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

module.exports = { loadConfig, effectiveSide, DEFAULTS };
