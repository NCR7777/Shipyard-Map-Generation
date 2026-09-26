import { useEffect, useState } from 'react';
import type { DrawingConfig } from '../../editor/projectController';
import { bridge } from '../ops/registry';
import { DRAWING_TOOLS, draftStore, setTool, useDraft, type Draft } from '../state/draft';

import { setDrawing, store, useApp, type ShapeKind, type Tool } from '../state/store';
import { SERVICE_KIND } from './labels';
import { INSIDE_LABELS, TRANSFER_LABELS, type Inside } from '../canvas/servicePoints';

const SHAPES: [ShapeKind, string][] = [['rect2', '两点矩形'], ['rect3', '三点斜矩形'], ['polygon', '多边形']];
const TOOL_NAMES: Partial<Record<Tool, string>> = { node: '节点', road: '道路', curve: '弯道', building: '建筑', zone: '区域', measure: '量距', entrance: '入口', service: '作业点' };

/** What the next click does, from the tool and how far the draft has got. */
function nextStep(tool: Tool, shape: ShapeKind | undefined, draft: Draft | null, inside: Inside): string {
  if (tool === 'node') return '点击放置节点';
  if (tool === 'entrance') return '点选建筑外边界添加入口（绿色圆点处），靠近角点时取角点；每点一次加一个，Esc 结束';
  // Short: the panel floats over the map (the status bar has the whole hint).
  if (tool === 'service') return inside === 'internal' ? '点入口：入口处作业 · 建筑内部：经内部通道 · 区域内部或已有节点：草稿' : '点入口：入口处作业 · 建筑、区域内部或已有节点：草稿';
  if (tool === 'measure') return draft?.kind === 'measure' && !draft.finished ? '继续点击；Enter 或双击结束，Esc 清除' : '点击起点开始量距';
  if (tool === 'road' || tool === 'curve') {
    if (draft?.kind !== 'road') return tool === 'curve' ? '点击起点；随后点终点，再点曲线经过的位置' : '点击起点；在节点或道路上点击会明确接上（绿圈）';
    if (tool === 'curve') return draft.road.curveEnd ? '点击曲线经过的位置' : '点击曲线终点；按 R 改画直线段';
    return '继续点击折点；点到节点或道路即接上并结束；Enter 或双击完成；按 C 接一段曲线';
  }
  const points = draft?.kind === 'shape' ? draft.points.length : 0;
  if (shape === 'rect2') return points ? '点击对角完成' : '点击一个角，或直接拖出矩形';
  if (shape === 'rect3') return ['点击基边起点', '点击基边终点', '点击确定宽度'][points] ?? '';
  return points < 3 ? '逐点点击轮廓；Shift 保持水平或竖直' : '继续点击；点回起点、Enter 或双击完成';
}

/** New-road width: may be empty while typing; values in 0.1–1000 m apply, anything else reverts when the field is left. */
function WidthInput({ value, onChange, label = '新道路宽度（米）' }: { value: number; onChange: (value: number) => void; label?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const valid = (input: string) => { const number = Number(input); return input.trim() !== '' && Number.isFinite(number) && number >= 0.1 && number <= 1000 ? number : null; };
  return <input type="number" min={0.1} max={1000} step={0.5} value={text} aria-label={label} aria-invalid={valid(text) === null}
    onChange={event => { setText(event.target.value); const number = valid(event.target.value); if (number !== null) onChange(number); }}
    onBlur={() => setText(String(value))} />;
}

/** Options and next-step hint for the active drawing tool, floating over the canvas. */
export function ToolOptions() {
  const tool = useApp(state => state.tool), drawing = useApp(state => state.drawing), shapes = useApp(state => state.shapes);
  const hasMap = useApp(state => !!state.session), draft = useDraft();
  const serviceKind = useApp(state => state.serviceKind), serviceTransfer = useApp(state => state.serviceTransfer), serviceInside = useApp(state => state.serviceInside), routeWidthM = useApp(state => state.routeWidthM);
  const entranceFor = useApp(state => state.entranceFor), only = useApp(state => state.entranceFor ? state.session?.map.facilities[state.entranceFor]?.name ?? null : null);
  if (!hasMap || !DRAWING_TOOLS.includes(tool)) return null;
  const area = tool === 'building' || tool === 'zone' ? tool : null, shape = area ? shapes[area] : undefined;
  const road = tool === 'road' || tool === 'curve';
  const set = (patch: Partial<DrawingConfig>) => setDrawing(patch);
  return <div className="tool-options" role="region" aria-label="绘图选项">
    <div className="tool-options-row">
      <strong>{TOOL_NAMES[tool]}</strong><span className="tool-step" aria-live="polite">{nextStep(tool, shape, draft, serviceInside)}</span>
    </div>
    {area && <div className="segmented" role="radiogroup" aria-label="形状">
      {SHAPES.map(([value, label]) => <button key={value} role="radio" aria-checked={shape === value}
        onClick={() => { draftStore.set(null); store.set(({ shapes }) => ({ shapes: { ...shapes, [area]: value } })); }}>{label}</button>)}
    </div>}
    {road && <div className="tool-options-row">
      <label>宽度<WidthInput value={drawing.roadWidthM} onChange={roadWidthM => set({ roadWidthM })} />m</label>
      <label>方向<select value={drawing.roadDirection} aria-label="新道路方向" onChange={event => set({ roadDirection: event.target.value as DrawingConfig['roadDirection'] })}>
        <option value="both">双向</option><option value="forward">沿绘制方向单向</option><option value="backward">逆绘制方向单向</option></select></label>
      <label className="check"><input type="checkbox" checked={drawing.connectNewCrossings} onChange={event => set({ connectNewCrossings: event.target.checked })} />与已有道路交叉处连通</label>
    </div>}
    {tool === 'entrance' && <div className="tool-options-row actions">
      {entranceFor && only !== null && <><span>只在「{only}」上添加</span>
        <button className="button subtle" onClick={() => store.set({ entranceFor: null })}>改为任意建筑</button></>}
      <button className="button primary" onClick={() => setTool('select')} title="Esc">完成添加入口</button>
    </div>}
    {tool === 'service' && <div className="tool-options-row actions">
      <label>作业类型<select value={serviceKind} aria-label="新作业点类型" onChange={event => store.set({ serviceKind: event.target.value as typeof serviceKind })}>
        {Object.entries(SERVICE_KIND).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <label title="放在入口处的作业点按节点代理到达，须声明场内转运如何计入">入口处<select value={serviceTransfer} aria-label="入口处作业点的场内转运" onChange={event => store.set({ serviceTransfer: event.target.value as typeof serviceTransfer })}>
        {Object.entries(TRANSFER_LABELS).map(([value, label]) => <option key={value} value={value}>{label.replace('场内转运', '')}</option>)}</select></label>
      <label title="建筑内部的作业点：从最近的可用入口建一条直线内部通道（属于该建筑），或先放草稿、稍后画路">建筑内部<select value={serviceInside} aria-label="建筑内部作业点" onChange={event => store.set({ serviceInside: event.target.value as typeof serviceInside })}>
        {Object.entries(INSIDE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {serviceInside === 'internal' && <label title="内部通道的宽度（真实地图多为 8 m 或 6 m）">宽<WidthInput value={routeWidthM} onChange={value => store.set({ routeWidthM: value })} label="内部通道宽度（米）" />m</label>}
      <button className="button primary" onClick={() => setTool('select')} title="Esc">完成添加作业点</button>
    </div>}
    {tool !== 'measure' && tool !== 'entrance' && tool !== 'service' && <div className="tool-options-row">
      <label className="check"><input type="checkbox" checked={drawing.snapNodes} onChange={event => set({ snapNodes: event.target.checked })} />吸附节点{road ? '与道路' : ''}</label>
      <label>网格<select value={drawing.snapGrid} aria-label="网格吸附" onChange={event => set({ snapGrid: Number(event.target.value) as DrawingConfig['snapGrid'] })}>
        <option value={0}>关</option><option value={1}>1 m</option><option value={5}>5 m</option><option value={10}>10 m</option></select></label>
      <span className="muted">Alt 暂停吸附</span>
    </div>}
    {draft && <div className="tool-options-row actions">
      {draft.kind === 'road' && tool === 'curve' && <label className="check"><input type="checkbox" checked={draft.road.continuity === 'smooth'}
        onChange={event => draftStore.set({ ...draft, road: { ...draft.road, continuity: event.target.checked ? 'smooth' : 'corner' } })} />平滑接续</label>}
      <button className="button subtle" onClick={() => bridge.draw.undoPoint()} title="Backspace">撤回一点</button>
      <button className="button subtle" onClick={() => bridge.draw.cancel()} title="Esc">取消</button>
      {(draft.kind !== 'measure' || !draft.finished) && <button className="button primary" onClick={() => bridge.draw.finish()} title="Enter">完成</button>}
    </div>}
  </div>;
}
