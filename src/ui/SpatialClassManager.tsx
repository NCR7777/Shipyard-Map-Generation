import { useState } from 'react';
import type { YardMap } from '../domain/model';
import type { MapCommand } from '../domain/commands';
import { allocateSpatialClassId, BUILTIN_SPATIAL_CLASSES, getSpatialClasses, type SpatialCollection } from '../domain/spatialClassification';
import { Modal } from './Modal';

export function SpatialClassManager({ map, onApply, onCancel }: { map: YardMap; onApply(command: MapCommand): boolean; onCancel(): void }) {
  const custom = getSpatialClasses(map).filter(item => !BUILTIN_SPATIAL_CLASSES.some(builtin => builtin.id === item.id));
  const [name, setName] = useState(''), [collection, setCollection] = useState<SpatialCollection>('facilities');
  const [selectedId, setSelectedId] = useState(custom[0]?.id ?? ''), [newName, setNewName] = useState(custom[0]?.label ?? '');
  const [error, setError] = useState('');
  function submit(rename: boolean) {
    const label = (rename ? newName : name).trim();
    if (!label || label.length > 80) { setError('分类名称须为 1 至 80 个字符。'); return; }
    if (!rename && custom.length >= 128) { setError('当前地图已有 128 个自定义分类，请使用或改名现有分类。'); return; }
    if (rename && !custom.some(item => item.id === selectedId)) { setError('请选择现有自定义分类。'); return; }
    const customClasses = rename ? custom.map(item => item.id === selectedId ? { ...item, label } : item)
      : [...custom, { id: allocateSpatialClassId(map), label, appliesTo: [collection] as [SpatialCollection] }];
    if (onApply({ type: 'setSpatialClasses', customClasses })) onCancel();
    else setError('分类未保存，请查看操作提示；当前输入保持。');
  }
  return <Modal title="管理自定义分类" onCancel={onCancel}>
    <p>分类保存在当前地图。建筑和区域分别管理；改名保留分类 ID 与对象引用，不改变几何或通行。</p>
    <label className="field-label">新增分类名称<input aria-label="自定义分类名称" value={name} onChange={event => setName(event.target.value)}/></label>
    <label className="field-label">适用对象<select aria-label="自定义分类适用对象" value={collection} onChange={event => setCollection(event.target.value as SpatialCollection)}><option value="facilities">建筑</option><option value="zones">区域</option></select></label>
    <button disabled={!name.trim()} onClick={() => submit(false)}>新增自定义分类</button>
    {custom.length > 0 && <section><label className="field-label">现有自定义分类<select aria-label="待改名分类" value={selectedId} onChange={event => { const id = event.target.value; setSelectedId(id); setNewName(custom.find(item => item.id === id)?.label ?? ''); }}>{custom.map(item => <option key={item.id} value={item.id}>{item.label} · {item.appliesTo[0] === 'facilities' ? '建筑' : '区域'}</option>)}</select></label><label className="field-label">新名称<input aria-label="分类新名称" value={newName} onChange={event => setNewName(event.target.value)}/></label><button disabled={!newName.trim()} onClick={() => submit(true)}>保存分类名称</button></section>}
    {error && <p role="alert">{error}</p>}<div className="dialog-actions"><button data-cancel onClick={onCancel}>取消分类设置</button></div>
  </Modal>;
}
