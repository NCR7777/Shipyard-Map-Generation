import { memo, useMemo, type ReactNode } from 'react';
import type { SceneItem, SceneKind } from '../../adapters/contracts';
import { itemValue } from '../../compiler/catalog';
import { mapCapabilities } from '../../domain/capabilities';
import type { PhysicalValue, Polygon, Provenance, YardMap } from '../../domain/model';
import { polygonArea2D } from '../../geometry/polygons';
import { rectangleFrame } from '../../geometry/rectangles';
import { geometryBounds } from '../../geometry/roads';
import type { DesignAssumption, MapCommand } from '../../domain/commands';
import { continuousRoadIds } from '../../domain/ownerEditing';
import { entranceMovable, onOutline } from '../canvas/entrances';
import { selectedTarget } from '../canvas/handles';
import { uid } from '../canvas/movePreview';
import { operation, runOperation } from '../ops/registry';
import { apply, editBlock } from '../state/edit';
import { separateEntrance } from '../state/editOps';
import { blockedDirections, displayNumber, fixedServiceKind, readNumber, type Unit } from '../state/properties';
import { BackgroundProperties } from './BackgroundInspector';
import { CommitSelect, CommitText, PhysicalField } from './PropertyFields';
import { frame, itemOf, sceneOf, select, setUnits, store, useApp, type RightTab } from '../state/store';
import { Icon } from './icons';
import { KIND_LABELS, splitKey } from './labels';
import { relatedKeys } from './relations';

const TABS: { id: RightTab; label: string }[] = [{ id: 'properties', label: '属性' }, { id: 'relations', label: '关联' }, { id: 'sources', label: '来源' }];
const LAYOUT_BASIS: Record<string, string> = { conceptual: '概念布局', synthetic: '合成数据', reference_based: '有底图参照，未独立核验', surveyed: '实测' };
const CATEGORY: Record<string, string> = { surveyed: '实测', drawing: '描图', imagery_derived: '影像推导', design_assumption: '设计假设', synthetic: '合成', unknown: '未知' };
const DIRECTION: Record<string, string> = { unknown: '待配置', forward: '沿箭头单向', backward: '反向单向', both: '双向' };
const PASSABILITY: Record<string, string> = { unknown: '未知', allowed: '允许通行', forbidden: '禁止通行', explicit_access_only: '仅显式接入' };
const NODE_KIND: Record<string, string> = { ordinary: '普通节点', junction: '路口节点', access: '入口节点', service: '作业节点' };
const SERVICE_KIND: Record<string, string> = { loading: '装载', unloading: '卸载', parking: '停车', berth: '泊位', other: '其他' };

const fixed = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, '') : '—';
/** Stored SI values shown in the unit people use; unknown is never shown as 0. */
function physical(value: PhysicalValue | undefined, unit: Unit): string {
  if (!value) return '—';
  if (value.state === 'known') return (displayNumber(value.value, unit) === null ? '超出当前单位的有限显示范围' : fixed(Number(displayNumber(value.value, unit)))) + ' ' + unit;
  return { unknown: '未知', unrestricted: '明确无限制', not_applicable: '不适用' }[value.state];
}
function size(polygon: Polygon): string {
  const bounds = geometryBounds(polygon.outer);
  return bounds ? `${fixed(bounds.max[0] - bounds.min[0], 1)} × ${fixed(bounds.max[1] - bounds.min[1], 1)} m` : '—';
}

export function Inspector() {
  const map = useApp(state => state.session?.map ?? null);
  const selection = useApp(state => state.selection), mapEpoch = useApp(state => state.mapEpoch);
  const tab = useApp(state => state.rightTab);
  const title = selection.length === 1 ? '选中对象' : selection.length > 1 ? `已选 ${selection.length} 个对象` : '地图概览';
  return <section className="panel inspector" aria-label="属性">
    <header className="panel-header"><h2>{title}</h2>
      <button className="icon-button" aria-label="收起属性栏" title="收起" onClick={() => store.set(({ panels }) => ({ panels: { ...panels, right: false } }))}><Icon name="chevronRight" /></button>
    </header>
    {selection.length === 1 && <div className="tabs" role="tablist">{TABS.map(item =>
      <button key={item.id} role="tab" id={'right-tab-' + item.id} aria-controls="right-panel" aria-selected={tab === item.id} onClick={() => store.set({ rightTab: item.id })}>{item.label}</button>)}</div>}
    <div className="panel-body" {...(selection.length === 1 ? { role: 'tabpanel', id: 'right-panel', 'aria-labelledby': 'right-tab-' + tab } : {})}>
      {!map ? <p className="panel-empty">打开地图后查看对象属性。</p>
        // Keyed by map and object: a field's uncommitted text is dropped with it, never written into another map or object.
        : selection.length === 0 ? <MapOverview key={mapEpoch} map={map} />
          : selection.length > 1 ? <MultiSummary key={mapEpoch + ':' + selection.join(',')} map={map} keys={selection} />
            : <EntityView key={mapEpoch + ':' + selection[0]} map={map} entityKey={selection[0]!} tab={tab} />}
    </div>
  </section>;
}

/** The entrance tool, limited to this building. */
function addEntrances(facilityId: string): void {
  runOperation(operation('tool.entrance'));
  if (store.get().tool === 'entrance') store.set({ entranceFor: facilityId });
}

/** For the one building or zone that shows handles: how its outline is edited. A rectangle may stay one while resizing. */
function OutlineMode() {
  const tool = useApp(state => state.tool), selection = useApp(state => state.selection), map = useApp(state => state.session?.map ?? null);
  const boundaryMode = useApp(state => state.boundaryMode), drawing = useApp(state => state.drawing);
  const target = map ? selectedTarget(map, sceneOf(map), { tool, selection, boundaryMode, drawing }, !!editBlock()) : null;
  if (!target || target.kind === 'roads') return null;
  return <div className="field" role="region" aria-label="轮廓编辑"><dt>轮廓编辑</dt><dd>
    {rectangleFrame(target.boundary) && <div className="segmented" role="radiogroup" aria-label="轮廓编辑方式">
      {([['rect', '矩形约束'], ['free', '自由多边形']] as const).map(([value, label]) =>
        <button key={value} role="radio" aria-checked={boundaryMode === value} onClick={() => store.set({ boundaryMode: value })}>{label}</button>)}
    </div>}
    <p className="muted">{target.mode === 'rect' ? '拖动角点改尺寸，对角固定；点击或拖动边中点插入顶点（改为自由多边形）。' : '拖动顶点移动；点击或拖动边中点插入顶点；Alt+点击顶点删除。'}</p>
  </dd></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><dt>{label}</dt><dd>{children}</dd></div>;
}
function CopyId({ id }: { id: string }) {
  return <button className="id-chip" title={id + '（点击复制）'} onClick={() => void navigator.clipboard?.writeText(id)}>{id}</button>;
}
function Link({ entityKey, map, showKind = true, showId = false }: { entityKey: string; map: YardMap; showKind?: boolean; showId?: boolean }) {
  const item = itemOf(sceneOf(map), entityKey), { kind, id } = splitKey(entityKey);
  if (!item) return <span className="muted">{KIND_LABELS[kind] ?? kind} {id}（不存在）</span>;
  return <button className="link" onClick={() => { select([entityKey]); if (item.status === 'geometry') frame([entityKey]); }}>
    {showKind && <span className="muted">{KIND_LABELS[kind]} </span>}{item.name || id}{showId && item.name && <span className="muted"> {id}</span>}</button>;
}

const MapOverview = memo(function MapOverview({ map }: { map: YardMap }) {
  const capabilities = useMemo(() => mapCapabilities(map), [map]);
  const hash = sceneOf(map).mapContentHash;
  return <dl className="fields">
    <Field label="名称">{editBlock() ? map.metadata.name
      : <CommitText label="地图名称" value={map.metadata.name} onCommit={text => !text.trim() ? '不能为空。' : apply({ type: 'renameMap', name: text }, '重命名地图')} />}</Field>
    <Field label="地图编号"><CopyId id={map.mapId} /></Field>
    <Field label="格式版本">{map.schemaVersion} · 修订 {map.revision}</Field>
    <Field label="布局依据">{LAYOUT_BASIS[map.metadata.layoutBasis] ?? map.metadata.layoutBasis}</Field>
    <Field label="内容">{(['facilities', 'zones', 'roads', 'nodes', 'accessPoints', 'servicePoints'] as const).map(kind =>
      <span key={kind} className="stat">{KIND_LABELS[kind]} <b className="num">{Object.keys(map[kind]).length}</b></span>)}</Field>
    <Field label="编辑能力">{capabilities.editable ? '可编辑' : <span className="warn">只读：{capabilities.reasons.join('；')}</span>}</Field>
    <Field label="内容摘要"><CopyId id={hash} /></Field>
  </dl>;
});

function MultiSummary({ map, keys }: { map: YardMap; keys: readonly string[] }) {
  const byKind = new Map<SceneKind, number>();
  for (const key of keys) { const { kind } = splitKey(key); byKind.set(kind, (byKind.get(kind) ?? 0) + 1); }
  const locked = useApp(state => state.drawing.lockedTypes);
  const roads = byKind.size === 1 && byKind.has('roads') && !editBlock() && !locked.includes('roads') ? keys.map(key => splitKey(key).id) : null;
  return <>
    <dl className="fields"><Field label="类型">{[...byKind].map(([kind, count]) => <span key={kind} className="stat">{KIND_LABELS[kind]} <b className="num">{count}</b></span>)}</Field></dl>
    {roads && <RoadBatch map={map} ids={roads} />}
    <ul className="link-list">{keys.slice(0, 50).map(key => <li key={key}><Link entityKey={key} map={map} /></li>)}</ul>
    {keys.length > 50 && <p className="muted">另有 {keys.length - 50} 个对象未列出。</p>}
  </>;
}

function EntityView({ map, entityKey, tab }: { map: YardMap; entityKey: string; tab: RightTab }) {
  const item = itemOf(sceneOf(map), entityKey);
  if (!item) return <p className="panel-empty">该对象已不在当前地图中。</p>;
  const value = itemValue(map, item) as Record<string, unknown> | undefined;
  return <>
    <div className="entity-heading"><strong>{item.name || item.id}</strong><span className="badge">{KIND_LABELS[item.kind]}</span></div>
    {tab === 'properties' ? <Properties map={map} item={item} /> : tab === 'relations' ? <Relations map={map} item={item} /> : <Sources map={map} provenance={value?.provenance as Provenance | undefined} />}
    <details className="raw-json"><summary>原始 JSON</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
  </>;
}

/** Several roads at once: width and direction; the kernel leaves roads that already have the value alone, and refuses all or none. */
function RoadBatch({ map, ids }: { map: YardMap; ids: string[] }) {
  const roads = ids.map(id => map.roads[id]!), first = roads[0]!;
  const widthMixed = !roads.every(road => sameWidth(road.widthM, first.widthM));
  const width = !widthMixed && first.widthM.state === 'known' ? displayNumber(first.widthM.value, 'm') ?? '' : '';
  const direction = roads.every(road => road.direction === first.direction) ? first.direction : 'mixed';
  const batch = (patch: Extract<MapCommand, { type: 'updateRoadBatch' }>['patch'], label: string, designAssumption?: DesignAssumption, only = ids) =>
    apply({ type: 'updateRoadBatch', ids: only, patch, ...designAssumption ? { designAssumption } : {} }, label);
  // Only declared widths become unknown: a width already unknown, unrestricted or not applicable keeps its state and its note.
  const declared = ids.filter(id => map.roads[id]!.widthM.state === 'known');
  const forgetWidths = () => declared.length ? batch({ widthM: { state: 'unknown' } }, '批量把已声明的道路宽度改为未知', undefined, declared) : true;
  // A one-way direction is offered only if the turn rules of every selected road allow it.
  const blocked = new Set(ids.flatMap(id => blockedDirections(map, id)));
  return <><h3 className="section-title">批量修改 {ids.length} 条道路</h3><dl className="fields">
    <Field label="宽度"><CommitText label="批量宽度" numeric suffix="m" value={width} onCommit={text => {
      if (!text.trim()) return forgetWidths();
      const value = readNumber(text);
      if (value === null || value <= 0) return '宽度必须是大于 0 的有限数。';
      return batch({ widthM: { state: 'known', value } }, '批量修改道路宽度', assumption('道路参数设计假设'));
    }} placeholder={widthMixed ? '各不相同' : '未知'} />
      {declared.length > 0 && <button className="link" onClick={forgetWidths}>把已声明的宽度改为未知（{declared.length} 条）</button>}</Field>
    <Field label="方向"><CommitSelect label="批量方向" value={direction}
      options={[...direction === 'mixed' ? [['mixed', '各不相同'] as const] : [], ...DIRECTION_OPTIONS.map(([value, text]) => blocked.has(value as never) ? [value, text + '（转向规则不允许）', TURN_RULE_NOTE] as const : [value, text] as const)]}
      onCommit={value => { if (value !== 'mixed') batch({ direction: value }, '批量修改道路方向'); }} />
      {blocked.size > 0 && <p className="muted">{TURN_RULE_NOTE}</p>}</Field>
  </dl></>;
}
const sameWidth = (a: PhysicalValue, b: PhysicalValue) => a.state === b.state && (a.state !== 'known' || (b.state === 'known' && a.value === b.value));
const assumption = (name: string): DesignAssumption => ({ id: uid('source'), name, description: '用户在属性栏输入的数值，未经现场核验。' });
const DIRECTION_OPTIONS = Object.entries(DIRECTION) as [MapRoadDirection, string][];
type MapRoadDirection = 'unknown' | 'forward' | 'backward' | 'both';
const FACILITY_KINDS: Record<string, string> = { building: '建筑', workshop: '厂房', other: '其他', yard: '堆场（旧）', assembly: '总组（旧）', dock: '船坞（旧）', quay: '码头（旧）' };
const ZONE_KINDS: Record<string, string> = { unclassified: '未分类', work: '作业区', buffer: '缓冲区', waiting: '候停区', water: '水域', obstacle: '障碍物', drivable: '可行驶区', forbidden: '禁入区' };
const TURN_RULE_NOTE = '路口转向规则按相反方向使用这条路，改为该方向的单向会被拒绝；需先调整转向规则（P3 的转向矩阵）。';
const LENGTH: readonly Unit[] = ['m'], MASS: readonly Unit[] = ['t', 'kg'], SPEED: readonly Unit[] = ['km/h', 'm/s'];

function Properties({ map, item }: { map: YardMap; item: SceneItem }) {
  const units = useApp(state => state.units), locked = useApp(state => state.drawing.lockedTypes);
  if (item.kind === 'backgroundLayers' && Object.hasOwn(map.backgroundLayers, item.id)) return <BackgroundProperties map={map} id={item.id} />;
  const editable = !editBlock() && !locked.includes(item.kind);
  return editable ? <EditableProperties map={map} item={item} /> : <ReadOnlyProperties map={map} item={item} units={units} />;
}

/** Each field commits on its own: Enter or leaving the field, one undo step each; Escape restores it. */
function EditableProperties({ map, item }: { map: YardMap; item: SceneItem }) {
  const { id } = item, scene = sceneOf(map), units = useApp(state => state.units);
  const run = (command: MapCommand, label: string) => apply(command, label);
  const rows: ReactNode[] = [<Field key="id" label="编号"><CopyId id={id} /></Field>];
  const name = (command: (name: string) => MapCommand, value: string) =>
    <Field key="name" label="名称"><CommitText label="名称" value={value} onCommit={text => run(command(text), '修改名称')} /></Field>;
  if (item.kind === 'nodes') {
    const node = map.nodes[id]!;
    const axis = (index: 0 | 1, label: string) => <CommitText key={label} label={label + ' 坐标'} numeric suffix="m" value={fixed(node.position[index], 3)} onCommit={text => {
      const value = readNumber(text); if (value === null) return '坐标必须是有限数。';
      const position = [...node.position] as typeof node.position; position[index] = value;
      return run({ type: 'updateNode', id, patch: { position } }, '修改节点坐标');
    }} />;
    rows.push(name(value => ({ type: 'updateNode', id, patch: { name: value } }), node.name),
      <Field key="kind" label="节点类型">{NODE_KIND[node.kind] ?? node.kind}</Field>,
      <Field key="xy" label="坐标（X / Y）"><span className="prop-coords">{axis(0, 'X')}{axis(1, 'Y')}<span className="muted">Z {fixed(node.position[2], 3)} m</span></span></Field>);
  } else if (item.kind === 'roads') {
    const road = map.roads[id]!, derived = scene.roads.find(entry => entry.id === id), chain = continuousRoadIds(map, id), blocked = blockedDirections(map, id);
    const curved = road.geometry?.spans.some(span => span.kind === 'cubic');
    const physicalRow = (field: 'widthM' | 'heightLimitM' | 'massLimitKg' | 'speedLimitMps', label: string, unit: Unit, options: readonly Unit[], onUnit?: (unit: Unit) => void) =>
      <Field key={field} label={label}><PhysicalField map={map} label={label} value={road[field]} unit={unit} units={options} onUnit={onUnit}
        onCommit={(value, needsAssumption, sourceOnly) => run({ type: 'updateRoad', id, patch: { [field]: value }, ...needsAssumption ? { designAssumption: assumption('道路参数设计假设') } : {} }, `修改${label}${sourceOnly ? '依据' : ''}`)} /></Field>;
    rows.push(name(value => ({ type: 'updateRoad', id, patch: { name: value } }), road.name),
      <Field key="len" label="长度（派生）"><span className="num">{derived ? fixed(derived.lengthM) : '—'}</span> m</Field>,
      physicalRow('widthM', '宽度', 'm', LENGTH),
      <Field key="dir" label="方向"><CommitSelect label="方向" value={road.direction} options={DIRECTION_OPTIONS.map(([value, text]) => blocked.includes(value as never) ? [value, text + '（转向规则不允许）', TURN_RULE_NOTE] as const : [value, text] as const)}
        onCommit={direction => run({ type: 'updateRoad', id, patch: { direction } }, '修改道路方向')} />
        {blocked.length > 0 && <p className="muted">{TURN_RULE_NOTE}</p>}</Field>,
      physicalRow('heightLimitM', '限高', 'm', LENGTH),
      physicalRow('massLimitKg', '承载', units.mass, MASS, unit => setUnits({ mass: unit as 't' | 'kg' })),
      physicalRow('speedLimitMps', '限速', units.speed, SPEED, unit => setUnits({ speed: unit as 'km/h' | 'm/s' })),
      <Field key="g" label="几何">{curved ? '含曲线段' : '折线'} · 内部锚点 {(road.geometry?.anchors ?? road.shapePoints ?? []).length} 个</Field>);
    if (chain.length > 1) rows.push(<Field key="chain" label="连续路段"><button className="button" onClick={() => select(chain.map(road => 'roads/' + road))}>选中连续的 {chain.length} 段</button>
      <p className="muted">方向、宽度等参数相同、首尾相接且中间没有业务点的路段，可一起批量修改。</p></Field>);
  } else if (item.kind === 'facilities' || item.kind === 'zones') {
    const entity = map[item.kind][id]!, derived = item.kind === 'facilities' ? scene.facilities.find(entry => entry.id === id) : scene.zones.find(entry => entry.id === id);
    rows.push(item.kind === 'facilities' ? name(value => ({ type: 'updateFacility', id, patch: { name: value } }), entity.name) : name(value => ({ type: 'updateZone', id, patch: { name: value } }), entity.name),
      <Field key="class" label="分类">{derived?.appearance ? <span className="swatch-label"><i className="swatch" style={{ background: derived.appearance.color }} />{derived.appearance.classLabel}</span> : entity.kind}</Field>);
    // What it is first, then its outline.
    const geometry = [<Field key="size" label="外包尺寸">{size(entity.boundary)}</Field>,
      <Field key="area" label="净面积"><span className="num">{fixed(polygonArea2D(entity.boundary), 1)}</span> m²</Field>,
      <OutlineMode key="outline" />];
    if (item.kind === 'facilities') {
      const facility = map.facilities[id]!;
      // 「建筑」needs format 0.3.0; older kinds are offered only to the building that already has one.
      const kinds = Object.entries(FACILITY_KINDS).filter(([kind]) => kind === facility.kind || (kind === 'building' ? map.schemaVersion === '0.3.0' : ['workshop', 'other'].includes(kind)));
      rows.push(<Field key="kind" label="兼容类型"><CommitSelect label="建筑兼容类型" value={facility.kind as string} options={kinds} onCommit={kind => run({ type: 'updateFacility', id, patch: { kind: kind as never } }, '修改建筑类型')} /></Field>,
        <Field key="height" label="高度"><PhysicalField map={map} label="高度" value={facility.heightM} unit="m"
          onCommit={(value, needsAssumption, sourceOnly) => run({ type: 'updateFacility', id, patch: { heightM: value }, ...needsAssumption ? { designAssumption: assumption('建筑参数设计假设') } : {} }, sourceOnly ? '修改建筑高度依据' : '修改建筑高度')} /></Field>,
        <Field key="members" label="入口 / 作业点">{facility.accessPointIds.length} / {facility.servicePointIds.length}
          <button className="link" onClick={() => addEntrances(id)}>在此建筑上添加入口</button></Field>, ...geometry);
    } else {
      const zone = map.zones[id]!;
      const kinds = Object.entries(ZONE_KINDS).filter(([kind]) => kind === zone.kind || kind !== 'unclassified' || map.schemaVersion === '0.3.0');
      rows.push(<Field key="kind" label="兼容类型"><CommitSelect label="区域兼容类型" value={zone.kind as string} options={kinds} onCommit={kind => run({ type: 'updateZone', id, patch: { kind: kind as never } }, '修改区域类型')} /></Field>,
        <Field key="pass" label="通行声明"><CommitSelect label="通行声明" value={zone.passability} options={Object.entries(PASSABILITY) as [typeof zone.passability, string][]}
          onCommit={passability => run({ type: 'updateZone', id, patch: { passability } }, '修改通行声明')} /></Field>, ...geometry);
    }
  } else if (item.kind === 'accessPoints') {
    const point = map.accessPoints[id]!;
    rows.push(name(value => ({ type: 'updateAccessPoint', id, patch: { name: value } }), point.name),
      <Field key="owner" label="所属建筑"><Link entityKey={'facilities/' + point.facilityId} map={map} /></Field>,
      <Field key="where" label="位置"><span className="muted">{!entranceMovable(map, id) ? '与公共道路或其他对象共用节点：保持固定，不能移动；所属建筑的移动也可能因此被拒。'
        : onOutline(map, id) ? '在建筑外边界上：拖动或方向键沿外边界移动。'
        : '不在建筑外边界上（设计上的接入点）：自由移动，内核保持它在轮廓内或外的原有关系。'}</span>
        {!entranceMovable(map, id) && <button className="link" title="入口沿外边界移开几米到自己的节点；原节点及其道路、作业点保持不变，不新建道路，入口拆出后不接路" onClick={() => separateEntrance(id)}>拆出入口节点</button>}</Field>);
  } else if (item.kind === 'servicePoints') {
    const point = map.servicePoints[id]!;
    rows.push(name(value => ({ type: 'updateServicePoint', id, patch: { name: value } }), point.name),
      <Field key="kind" label="作业类型">{fixedServiceKind(map, id)
        ? <>{SERVICE_KIND[point.kind] ?? point.kind}<p className="muted">{fixedServiceKind(map, id)}</p></>
        : <CommitSelect label="作业类型" value={point.kind} options={Object.entries(SERVICE_KIND) as [typeof point.kind, string][]}
          onCommit={kind => run({ type: 'updateServicePoint', id, patch: { kind } }, '修改作业类型')} />}</Field>,
      <Field key="arrival" label="到达方式">{!point.arrival ? '未声明（草稿）' : point.arrival.mode === 'node_proxy' ? '节点代理' : `显式内部通道 · ${point.arrival.internalPath.length} 段`}</Field>);
  } else if (item.reason) rows.push(<Field key="reason" label="说明">{item.reason}</Field>);
  return <dl className="fields">{rows}</dl>;
}

function ReadOnlyProperties({ map, item, units }: { map: YardMap; item: SceneItem; units: { mass: Unit; speed: Unit } }) {
  const { id } = item, scene = sceneOf(map);
  const rows: ReactNode[] = [<Field key="id" label="编号"><CopyId id={id} /></Field>];
  if (item.kind === 'nodes') {
    const node = map.nodes[id]!;
    rows.push(<Field key="kind" label="节点类型">{NODE_KIND[node.kind] ?? node.kind}</Field>,
      <Field key="xy" label="坐标"><span className="num">X {fixed(node.position[0], 3)} · Y {fixed(node.position[1], 3)} · Z {fixed(node.position[2], 3)}</span> m</Field>);
  } else if (item.kind === 'roads') {
    const road = map.roads[id]!, derived = scene.roads.find(entry => entry.id === id);
    const curved = road.geometry?.spans.some(span => span.kind === 'cubic');
    rows.push(<Field key="len" label="长度（派生）"><span className="num">{derived ? fixed(derived.lengthM) : '—'}</span> m</Field>,
      <Field key="w" label="宽度">{physical(road.widthM, 'm')}</Field>,
      <Field key="dir" label="方向">{DIRECTION[road.direction] ?? road.direction}</Field>,
      <Field key="h" label="限高">{physical(road.heightLimitM, 'm')}</Field>,
      <Field key="m" label="承载">{physical(road.massLimitKg, units.mass)}</Field>,
      <Field key="v" label="限速">{physical(road.speedLimitMps, units.speed)}</Field>,
      <Field key="g" label="几何">{curved ? '含曲线段' : '折线'} · 内部锚点 {(road.geometry?.anchors ?? road.shapePoints ?? []).length} 个</Field>);
  } else if (item.kind === 'facilities' || item.kind === 'zones') {
    const entity = map[item.kind][id]!, derived = item.kind === 'facilities' ? scene.facilities.find(entry => entry.id === id) : scene.zones.find(entry => entry.id === id);
    rows.push(<Field key="class" label="分类">{derived?.appearance ? <span className="swatch-label"><i className="swatch" style={{ background: derived.appearance.color }} />{derived.appearance.classLabel}</span> : entity.kind}</Field>,
      <Field key="size" label="外包尺寸">{size(entity.boundary)}</Field>,
      <Field key="area" label="净面积"><span className="num">{fixed(polygonArea2D(entity.boundary), 1)}</span> m²</Field>,
      <OutlineMode key="outline" />);
    if (item.kind === 'facilities') {
      const facility = map.facilities[id]!;
      rows.push(<Field key="height" label="高度">{physical(facility.heightM, 'm')}</Field>,
        <Field key="members" label="入口 / 作业点">{facility.accessPointIds.length} / {facility.servicePointIds.length}</Field>);
    } else rows.push(<Field key="pass" label="通行声明">{PASSABILITY[map.zones[id]!.passability] ?? map.zones[id]!.passability}</Field>);
  } else if (item.kind === 'accessPoints') {
    const point = map.accessPoints[id]!;
    rows.push(<Field key="owner" label="所属建筑"><Link entityKey={'facilities/' + point.facilityId} map={map} /></Field>);
  } else if (item.kind === 'servicePoints') {
    const point = map.servicePoints[id]!;
    rows.push(<Field key="kind" label="作业类型">{SERVICE_KIND[point.kind] ?? point.kind}</Field>,
      <Field key="arrival" label="到达方式">{!point.arrival ? '未声明（草稿）' : point.arrival.mode === 'node_proxy' ? '节点代理' : `显式内部通道 · ${point.arrival.internalPath.length} 段`}</Field>);
  } else if (item.reason) rows.push(<Field key="reason" label="说明">{item.reason}</Field>);
  return <dl className="fields">{rows}</dl>;
}

/** Rows beyond this are summarised: one source can be cited by thousands of objects. */
const RELATION_ROWS = 200;
function Relations({ map, item }: { map: YardMap; item: SceneItem }) {
  const keys = useMemo(() => relatedKeys(map, item.kind, item.id), [map, item]);
  const shown = keys.slice(0, RELATION_ROWS);
  // Generated names often repeat (six movements all called 道路接续); show the ID only where a name is ambiguous.
  const repeated = useMemo(() => {
    const seen = new Set<string>(), twice = new Set<string>();
    for (const [, key] of keys.slice(0, RELATION_ROWS)) { const name = itemOf(sceneOf(map), key)?.name; if (name) (seen.has(name) ? twice : seen).add(name); }
    return twice;
  }, [map, keys]);
  if (!keys.length) return <p className="panel-empty">没有直接关联的对象。</p>;
  const all = keys.length > RELATION_ROWS ? [...new Set(keys.map(([, key]) => key))] : [];
  return <>
    <ul className="link-list">{shown.map(([label, key], index) => <li key={label + key}><span className="muted rel">{label === shown[index - 1]?.[0] ? '' : label}</span>
      <Link entityKey={key} map={map} showKind={false} showId={repeated.has(itemOf(sceneOf(map), key)?.name ?? '')} /></li>)}</ul>
    {keys.length > RELATION_ROWS && <p className="muted">另有 {keys.length - RELATION_ROWS} 个未列出。
      <button className="link" onClick={() => select(all)}>全部选中（{all.length}）</button></p>}
  </>;
}

function Sources({ map, provenance }: { map: YardMap; provenance: Provenance | undefined }) {
  if (!provenance) return <p className="panel-empty">此对象没有来源记录。</p>;
  return <>
    <dl className="fields">
      <Field label="来源类别">{CATEGORY[provenance.category] ?? provenance.category}</Field>
      {provenance.note && <Field label="备注">{provenance.note}</Field>}
    </dl>
    {!!provenance.sourceRefs?.length && <><h3 className="section-title">引用的来源</h3>
      <ul className="source-list">{provenance.sourceRefs.map(ref => { const source = map.sources[ref]; return <li key={ref}>
        <strong>{source?.name ?? ref}</strong> <span className="badge">{source ? CATEGORY[source.category] ?? source.category : '缺失'}</span>
        {source?.description && <p className="muted clamp">{source.description}</p>}</li>; })}</ul></>}
    {provenance.fieldSources && Object.keys(provenance.fieldSources).length > 0 && <><h3 className="section-title">字段来源</h3>
      <dl className="fields">{Object.entries(provenance.fieldSources).map(([field, ref]) => <Field key={field} label={field}>{map.sources[ref]?.name ?? ref}</Field>)}</dl></>}
  </>;
}
