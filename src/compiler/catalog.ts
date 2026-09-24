import { inspectAsset, inspectBackground } from '../domain/backgrounds';
import { backgroundFrame } from '../geometry/backgrounds';
import type { SceneItem, SceneKind } from '../adapters/contracts';
import { ENTITY_RECORDS, type Vec3, type YardMap } from '../domain/model';
import { inspectPlanning, PLANNING_NAMESPACE } from '../domain/planning';
import { roadPoints } from '../geometry/roads';
import { sceneRow } from './scene';

const pointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
// Same order as String#localeCompare(other, 'en'), without building a collator per comparison.
const collator = new Intl.Collator('en');
function makeItem(kind: SceneKind, id: string, name: string, jsonPath: string, geometry: Partial<Pick<SceneItem, 'polygons' | 'points' | 'lines'>> = {}, reason = ''): SceneItem {
  const item: SceneItem = { key: kind + '/' + id, kind, id, name, jsonPath, polygons: [], points: [], lines: [], status: 'logical', reason, ...structuredClone(geometry) };
  if (item.polygons.length || item.points.length || item.lines.length) item.status = 'geometry';
  return item;
}
/** Directory entries for every extension payload below value; path is its JSON pointer. */
function extensionItems(map: YardMap, value: unknown, path: string, planningSupported: boolean, out: SceneItem[]): SceneItem[] {
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path + '/' + pointer(key);
    if (key === 'extensions' && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const namespace of Object.keys(child)) {
        const item = makeItem('extensions', nextPath + '/' + namespace, namespace + ' · ' + (path || '/'), nextPath + '/' + pointer(namespace), {}, '此处完整载荷可查看，未修改字段保留。');
        if (map.extensionNamespaces[namespace]?.category !== 'metadata' && (namespace !== PLANNING_NAMESPACE || !planningSupported)) {
          item.status = 'unsupported'; item.reason = '此扩展载荷未被当前静态契约完整理解。';
        }
        out.push(item);
      }
    } else if (key !== 'extensionNamespaces') extensionItems(map, child, nextPath, planningSupported, out);
  }
  return out;
}
/** Projects only declared geometry. Logical references never invent a location or area. */
export function sceneCatalog(map: YardMap): SceneItem[] {
  const items: SceneItem[] = [];
  function add(...args: Parameters<typeof makeItem>) { const item = makeItem(...args); items.push(item); return item; }
  // Rows of unchanged frozen entities are reused; each lists what else it reads.
  for (const [id, n] of Object.entries(map.nodes)) items.push(sceneRow('nodeItem', n, [id], () => makeItem('nodes', id, n.name, '/nodes/' + pointer(id), { points: [n.position] })));
  for (const [id, r] of Object.entries(map.roads)) items.push(sceneRow('roadItem', r, [id, map.nodes[r.fromNodeId], map.nodes[r.toNodeId]], () => makeItem('roads', id, r.name, '/roads/' + pointer(id), { lines: [roadPoints(map, id)], ...(r.corridorPolygon ? { polygons: [r.corridorPolygon] } : {}) })));
  for (const kind of ['facilities', 'zones'] as const) for (const [id, e] of Object.entries(map[kind])) items.push(sceneRow(kind + 'Item', e, [id], () => makeItem(kind, id, e.name, '/' + kind + '/' + pointer(id), { polygons: [e.boundary] })));
  for (const kind of ['accessPoints', 'servicePoints'] as const) for (const [id, e] of Object.entries(map[kind])) items.push(sceneRow(kind + 'Item', e, [id, map.nodes[e.nodeId]], () => makeItem(kind, id, e.name, '/' + kind + '/' + pointer(id), { points: [map.nodes[e.nodeId]!.position] })));
  if (map.siteBoundary) add('siteBoundary', 'siteBoundary', '厂界 / 研究范围', '/siteBoundary', { polygons: [map.siteBoundary] }, '范围用途未在核心字段声明；不默认全部为陆地。本批只读。');
  for (const [id, j] of Object.entries(map.junctions)) items.push(sceneRow('junctionItem', j, [id, ...j.nodeIds.map(n => map.nodes[n])], () => makeItem('junctions', id, j.name, '/junctions/' + pointer(id), {
    polygons: j.boundary ? [j.boundary] : [], points: j.nodeIds.map(n => map.nodes[n]!.position),
  }, j.boundary ? '声明预留边界，不自动授予转向或容量。' : '仅声明节点，未声明预留边界。')));
  for (const [id, m] of Object.entries(map.movements)) items.push(sceneRow('movementItem', m, [id], () => makeItem('movements', id, m.name, '/movements/' + pointer(id), {}, '逻辑转向声明；可在属性查看入弧、出弧，P1 不编辑或重新验证转向。')));
  const byKey = new Map(items.map(item => [item.key, item]));
  for (const [id, r] of Object.entries(map.resources)) {
    const refs = r.appliesTo.map(ref => byKey.get(ref.entityType + '/' + ref.entityId)).filter((item): item is SceneItem => !!item);
    items.push(sceneRow('resourceItem', r, [id, ...refs], () => ({ ...makeItem('resources', id, r.name, '/resources/' + pointer(id), {
      polygons: refs.flatMap(ref => ref.polygons), points: refs.flatMap(ref => ref.points), lines: refs.flatMap(ref => ref.lines),
    }, '逻辑资源：选中时高亮 appliesTo 的声明几何；这不是独立资源边界或运行许可。'), status: 'logical' as const })));
  }
  const planning = inspectPlanning(map);
  for (const slot of planning.slots) {
    const owner = map[slot.ownerKind][slot.ownerId]!;
    const raw = owner.extensions?.[PLANNING_NAMESPACE] as { slots?: { id: string }[] } | undefined;
    const index = raw?.slots?.findIndex(value => value.id === slot.id) ?? -1;
    const item = add('slots', slot.ownerKind + ':' + slot.ownerId + ':' + slot.id, (slot.parking ? '停车位 ' : '储位 ') + slot.id,
      '/' + slot.ownerKind + '/' + pointer(slot.ownerId) + '/extensions/' + pointer(PLANNING_NAMESPACE) + '/slots/' + index,
      { polygons: [slot.boundary] }, '仅支持随所属设施/区域整体平移和旋转；容量不从显示推断。');
    item.owner = { kind: slot.ownerKind, id: slot.ownerId };
  }
  for (const [id, source] of Object.entries(map.sources)) items.push(sceneRow('sourceItem', source, [id], () => makeItem('sources', id, source.name, '/sources/' + pointer(id), {}, '来源声明，P1 只读。')));
  for (const [id, asset] of Object.entries(map.assets)) {
    const support = inspectAsset(asset);
    const item = add('assets', id, asset.path, '/assets/' + pointer(id), {}, support.supported ? '本地栅格资产索引；图片字节可用性在底图面板单独核对。单 JSON 不包含图片字节。' : support.reasons.join('；'));
    if (!support.supported) item.status = 'unsupported';
  }
  for (const [id, layer] of Object.entries(map.backgroundLayers)) {
    const support = inspectBackground(map, id), asset = map.assets[layer.assetId];
    const points: Vec3[] = support.supported && asset?.widthPx && asset.heightPx ? backgroundFrame(layer.imageToWorld, asset.widthPx, asset.heightPx).corners.map(p => [p[0], p[1], 0]) : [];
    const item = add('backgroundLayers', id, layer.name, '/backgroundLayers/' + pointer(id), { lines: points.length ? [[...points, points[0]!]] : [] }, support.supported ? '范围从 imageToWorld 和实际像素尺寸派生；请在底图面板调整。不会改变矢量或坐标框架，配准精度未独立核验。' : support.reasons.join('；'));
    if (!support.supported) item.status = 'unsupported';
  }
  for (const [id, declaration] of Object.entries(map.extensionNamespaces)) {
    const item = add('extensions', id, id + ' @' + declaration.version, '/extensionNamespaces/' + pointer(id), {}, '命名空间声明，原样保留。');
    if (declaration.category !== 'metadata' && (id !== PLANNING_NAMESPACE || !planning.supported)) { item.status = 'unsupported'; item.reason = '未支持的行为或几何契约，禁止不能证明独立的修改。'; }
  }
  // Extension payloads: entity subtrees are walked once per entity version, the few root fields every time.
  const namespaces = JSON.stringify(map.extensionNamespaces);
  for (const [key, value] of Object.entries(map)) {
    if (!(ENTITY_RECORDS as readonly string[]).includes(key)) { extensionItems(map, { [key]: value }, '', planning.supported, items); continue; }
    for (const [id, entity] of Object.entries(value as Record<string, object>))
      items.push(...sceneRow('extensionItems', entity, [key, id, namespaces, planning.supported], () => extensionItems(map, { [id]: entity }, '/' + key, planning.supported, [])));
  }
  return items.sort((a, b) => collator.compare(a.key, b.key));
}

export function itemPositions(item: SceneItem): Vec3[] {
  return [...item.points, ...item.lines.flat(), ...item.polygons.flatMap(p => [p.outer, ...p.holes].flat())];
}
export function itemValue(map: YardMap, item: SceneItem): unknown {
  return item.jsonPath.split('/').slice(1).reduce<unknown>((value, key) => value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined, map);
}
