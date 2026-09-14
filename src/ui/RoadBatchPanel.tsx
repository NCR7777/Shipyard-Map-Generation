import { useState } from 'react';
import type { YardMap, MapRoad } from '../domain/model';
import type { MapCommand } from '../domain/commands';
import { Modal } from './Modal';
export function RoadBatchPanel({ map, ids, scope='continuous', onApply, onCancel }: { map: YardMap; ids: string[]; scope?: 'selection'|'continuous'; onApply: (command: MapCommand) => boolean; onCancel: () => void }) {
  const [width, setWidth] = useState(''), [direction, setDirection] = useState('');
  const [widthTouched, setWidthTouched] = useState(false), [error, setError] = useState('');
  const sourceId = useState(() => 'source_' + crypto.randomUUID())[0];
  const widths = new Set(ids.map(id => JSON.stringify(map.roads[id]!.widthM)));
  function apply() {
    const patch: Extract<MapCommand, { type: 'updateRoad' }>['patch'] = {};
    if (widthTouched) {
      if (width.trim() && (!Number.isFinite(Number(width)) || Number(width) <= 0)) { setError('宽度须为正的有限米数。'); return; }
      patch.widthM = width.trim() ? { state: 'known', value: Number(width) } : { state: 'unknown' };
    }
    if (direction) patch.direction = direction as MapRoad['direction'];
    if (onApply({ type: 'updateRoadBatch', ids, patch, ...(widthTouched && width.trim() ? { designAssumption: { id: sourceId, description: scope==='selection'?'明确选择道路后批量修改宽度。':'明确选择连续道路后批量修改宽度。' } } : {}) })) onCancel();
  }
  return <Modal title={scope==='selection'?'所选道路一起修改':'连续路段一起修改'} onCancel={onCancel}><p>{scope==='selection'?'仅修改当前明确选中的道路，未选道路保持。':'范围在路口、方向、宽度、所有者或资源条件变化处停止。'}只应用本次实际输入的字段。</p><ul>{ids.map(id => <li key={id}>{map.roads[id]!.name} · {id}</li>)}</ul><p>宽度现值：{widths.size > 1 ? '混合' : map.roads[ids[0]!]!.widthM.state === 'known' ? String((map.roads[ids[0]!]!.widthM as {value:number}).value) + ' m' : '未确定'}</p>
  <label className="field-label">统一宽度 (m)<input aria-label="统一宽度 (m)" type="number" step="any" value={width} placeholder="不修改" onChange={event => { setWidth(event.target.value); setWidthTouched(true); }}/></label>{widthTouched && !width.trim() && <p>确认将宽度改为未知，不解释为无限制。</p>}
  <label className="field-label">统一方向<select aria-label="统一方向" value={direction} onChange={event => setDirection(event.target.value)}><option value="">不修改</option><option value="both">双向</option><option value="forward">沿各道路声明箭头单向</option><option value="backward">逆各道路声明箭头单向</option><option value="unknown">待配置</option></select></label>{error && <p role="alert">{error}</p>}<button onClick={onCancel}>取消</button><button disabled={!widthTouched && !direction} onClick={apply}>应用到这些道路</button></Modal>;
}
