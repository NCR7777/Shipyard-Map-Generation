/** Shortcut and display-convention reference, opened on demand instead of covering the drawing area. */
const SECTIONS: [string, [string, string][]][] = [
  ['工具', [['V', '选择'], ['H', '平移'], ['R', '道路'], ['C', '弯曲'], ['B', '矩形建筑'], ['A', '多边形区域'], ['G', '矩形区域'], ['M', '量距']]],
  ['视图', [['滚轮', '缩放'], ['中键拖动', '平移'], ['F', '适应地图'], ['Shift+F', '定位关注对象']]],
  ['绘路', [['点击', '添加落点'], ['Enter / 双击', '完成道路'], ['R / C', '接续直线或曲线'], ['Alt', '本次不接路'], ['绿圈', '明确接路目标']]],
  ['编辑', [['Shift+点击', '多选'], ['再点 / Tab', '切换叠放对象'], ['Ctrl+Z', '撤销'], ['Ctrl+Shift+Z', '重做'], ['Ctrl+D', '快速复制'], ['Delete', '删除'], ['Ctrl+S', '保存'], ['Ctrl+K', '搜索对象'], ['Esc', '取消 / 退出']]],
];

export function CanvasHelp({ onClose }: { onClose: () => void }) {
  return <div className="canvas-help" role="dialog" aria-label="操作说明" data-testid="canvas-help">
    <div className="canvas-help-heading"><strong>操作说明</strong><button aria-label="关闭操作说明" onClick={onClose}>×</button></div>
    <div className="canvas-help-grid">{SECTIONS.map(([title, rows]) => <section key={title}><h4>{title}</h4>
      <dl>{rows.map(([key, action]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)}</dl></section>)}</div>
    <p>道路带 = 声明宽度 × 比例；圆端、圆连接为近似表达，不代表实测路口或车辆扫掠。道路带重叠不会自动连通，接路须经绿圈或拓扑确认。按 ? 打开或关闭本说明。</p>
  </div>;
}
