import type { SceneItem, SceneKind } from '../adapters/contracts';
import type { Vec3, YardMap } from '../domain/model';
import { inspectPlanning, PLANNING_NAMESPACE } from '../domain/planning';
import { roadPoints } from '../geometry/roads';

const pointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
/** Projects only declared geometry. Logical references never invent a location or area. */
export function sceneCatalog(map: YardMap): SceneItem[] {
  const items: SceneItem[] = [];
  function add(kind: SceneKind, id: string, name: string, jsonPath: string, geometry: Partial<Pick<SceneItem, 'polygons' | 'points' | 'lines'>> = {}, reason = '') {
    const item: SceneItem = { key: kind + '/' + id, kind, id, name, jsonPath, polygons: [], points: [], lines: [], status: 'logical', reason, ...structuredClone(geometry) };
    if (item.polygons.length || item.points.length || item.lines.length) item.status = 'geometry';
    items.push(item); return item;
  }
  for (const [id, n] of Object.entries(map.nodes)) add('nodes', id, n.name, '/nodes/' + pointer(id), { points: [n.position] });
  for (const [id, r] of Object.entries(map.roads)) add('roads', id, r.name, '/roads/' + pointer(id), { lines: [roadPoints(map, id)], ...(r.corridorPolygon ? { polygons: [r.corridorPolygon] } : {}) });
  for (const kind of ['facilities', 'zones'] as const) for (const [id, e] of Object.entries(map[kind])) add(kind, id, e.name, '/' + kind + '/' + pointer(id), { polygons: [e.boundary] });
  for (const kind of ['accessPoints', 'servicePoints'] as const) for (const [id, e] of Object.entries(map[kind])) add(kind, id, e.name, '/' + kind + '/' + pointer(id), { points: [map.nodes[e.nodeId]!.position] });
  if (map.siteBoundary) add('siteBoundary', 'siteBoundary', '厂界 / 研究范围', '/siteBoundary', { polygons: [map.siteBoundary] }, '范围用途未在核心字段声明；不默认全部为陆地。本批只读。');
  for (const [id, j] of Object.entries(map.junctions)) add('junctions', id, j.name, '/junctions/' + pointer(id), {
    polygons: j.boundary ? [j.boundary] : [], points: j.nodeIds.map(n => map.nodes[n]!.position),
  }, j.boundary ? '声明预留边界，不自动授予转向或容量。' : '仅声明节点，未声明预留边界。');
  for (const [id, m] of Object.entries(map.movements)) add('movements', id, m.name, '/movements/' + pointer(id), {}, '逻辑转向声明；可在属性查看入弧、出弧，P1 不编辑或重新验证转向。');
  const byKey = new Map(items.map(item => [item.key, item]));
  for (const [id, r] of Object.entries(map.resources)) {
    const refs = r.appliesTo.map(ref => byKey.get(ref.entityType + '/' + ref.entityId)).filter((item): item is SceneItem => !!item);
    const item = add('resources', id, r.name, '/resources/' + pointer(id), {
      polygons: refs.flatMap(ref => ref.polygons), points: refs.flatMap(ref => ref.points), lines: refs.flatMap(ref => ref.lines),
    }, '逻辑资源：选中时高亮 appliesTo 的声明几何；这不是独立资源边界或运行许可。');
    item.status = 'logical';
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
  for (const [id, source] of Object.entries(map.sources)) add('sources', id, source.name, '/sources/' + pointer(id), {}, '来源声明，P1 只读。');
  for (const kind of ['assets', 'backgroundLayers'] as const) for (const [id] of Object.entries(map[kind])) {
    const item = add(kind, id, id, '/' + kind + '/' + pointer(id), {}, 'P1 未加载底图二进制或实现标定；声明完整保留。'); item.status = 'unsupported';
  }
  for (const [id, declaration] of Object.entries(map.extensionNamespaces)) {
    const item = add('extensions', id, id + ' @' + declaration.version, '/extensionNamespaces/' + pointer(id), {}, '命名空间声明，原样保留。');
    if (declaration.category !== 'metadata' && (id !== PLANNING_NAMESPACE || !planning.supported)) { item.status = 'unsupported'; item.reason = '未支持的行为或几何契约，禁止不能证明独立的修改。'; }
  }
  function extensionEntries(value: unknown, path: string) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path + '/' + pointer(key);
      if (key === 'extensions' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const namespace of Object.keys(child)) {
          const item = add('extensions', nextPath + '/' + namespace, namespace + ' · ' + (path || '/'), nextPath + '/' + pointer(namespace), {}, '此处完整载荷可查看，未修改字段保留。');
          if (map.extensionNamespaces[namespace]?.category !== 'metadata' && (namespace !== PLANNING_NAMESPACE || !planning.supported)) {
            item.status = 'unsupported'; item.reason = '此扩展载荷未被当前静态契约完整理解。';
          }
        }
      } else if (key !== 'extensionNamespaces') extensionEntries(child, nextPath);
    }
  }
  extensionEntries(map, '');
  return items.sort((a, b) => a.key.localeCompare(b.key, 'en'));
}

export function itemPositions(item: SceneItem): Vec3[] {
  return [...item.points, ...item.lines.flat(), ...item.polygons.flatMap(p => [p.outer, ...p.holes].flat())];
}
export function itemValue(map: YardMap, item: SceneItem): unknown {
  return item.jsonPath.split('/').slice(1).reduce<unknown>((value, key) => value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined, map);
}
