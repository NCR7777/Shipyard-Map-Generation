import type { Issue, PhysicalValue, YardMap } from '../../domain/model';
import { inspectPlanning, PLANNING_NAMESPACE } from '../../domain/planning';
import { entranceMovable } from '../canvas/entrances';
import { sameValue } from '../../domain/value';

/** Display units. Values are stored in SI (m, kg, m/s, rad) and converted once, when the user types them. */
export type Unit = 'm' | 't' | 'kg' | 'km/h' | 'm/s' | 'deg' | 'rad';
const FACTOR: Record<Unit, number> = { m: 1, t: 1000, kg: 1, 'km/h': 1 / 3.6, 'm/s': 1, deg: Math.PI / 180, rad: 1 };
export const unitFactor = (unit: Unit): number => FACTOR[unit];

/** Typed text in a display unit to the stored SI number: null for blank text or anything not finite after conversion. */
export function readNumber(text: string, factor = 1): number | null {
  if (!text.trim()) return null;
  const value = Number(text) * factor;
  return Number.isFinite(value) ? value : null;
}
/** A stored value in a display unit, or null when that unit cannot show it finitely (overflow, or underflow to 0). */
export function displayNumber(value: number, unit: Unit): string | null {
  const shown = value / FACTOR[unit];
  if (!Number.isFinite(shown) || (shown === 0 && value !== 0)) return null;
  return String(Number(shown.toPrecision(12)));
}

export type PhysicalState = PhysicalValue['state'];
/** One physical field being edited. `touched` is set only by typing: an untouched number is never parsed, so display
 *  rounding and unit switches can never change a stored value. `source` is set only when the user picks a source. */
export interface PhysicalDraft { state: PhysicalState; text: string; touched: boolean; source?: string; reason?: string }
export function physicalDraft(value: PhysicalValue | undefined, unit: Unit): PhysicalDraft {
  if (!value || value.state !== 'known') return { state: value?.state ?? 'unknown', text: '', touched: false, ...value?.reason !== undefined ? { reason: value.reason } : {} };
  return { state: 'known', text: displayNumber(value.value, unit) ?? '', touched: false };
}

export type PhysicalResult = { ok: true; value?: PhysicalValue; needsAssumption: boolean } | { ok: false; message: string };
/** The new stored value, or none when nothing changed. A changed known value without a chosen source needs a design assumption. */
export function physicalPatch(original: PhysicalValue | undefined, draft: PhysicalDraft, unit: Unit): PhysicalResult {
  const none: PhysicalResult = { ok: true, needsAssumption: false };
  if (draft.state !== 'known') {
    const value: PhysicalValue = { state: draft.state, ...draft.reason !== undefined ? { reason: draft.reason } : {} };
    return original && sameValue(original, value) ? none : { ok: true, value, needsAssumption: false };
  }
  const stored = original?.state === 'known' ? original : undefined;
  let number: number;
  // Untouched, or the stored number typed back as it is shown: the stored number, full precision.
  if (!draft.touched || (stored && displayNumber(stored.value, unit) === draft.text.trim())) {
    if (!stored) return { ok: false, message: '请输入数值。' };
    number = stored.value;
  } else if (!draft.text.trim()) {
    // Clearing a known number makes it unknown on purpose; typing into an unknown field and clearing it changes nothing.
    return stored ? { ok: true, value: { state: 'unknown' }, needsAssumption: false } : none;
  } else {
    const parsed = readNumber(draft.text, unitFactor(unit));
    if (parsed === null || parsed <= 0) return { ok: false, message: '数值必须是大于 0 的有限数；不知道时请清空或选择「未知」。' };
    number = parsed;
  }
  // The stored number without a newly chosen source restores the stored value, source included: no patch, no new source.
  if (stored && number === stored.value && (draft.source === undefined || draft.source === stored.sourceRef)) return none;
  const value: PhysicalValue = { state: 'known', value: number, ...draft.source ? { sourceRef: draft.source } : {} };
  return { ok: true, value, needsAssumption: !draft.source };
}

/** Why a command was refused: its first error. Warnings about the rest of the map come first in the list but are not the reason.
 *  With the map the command was refused on, a few kernel messages that name objects by ID read with names instead. */
export function refusalMessage(issues: readonly Issue[], map?: YardMap): string {
  const issue = issues.find(issue => issue.severity === 'error') ?? issues[0];
  if (!issue) return '操作未通过校验，地图保持不变。';
  return (map && readableRefusal(issue, map)) ?? issue.message;
}
/** An entrance the edit would carry across its building's outline (an outline drag under a corner entrance, say): its name,
 *  and what to do on the canvas, in place of the kernel's IDs and its advice for moves of public roads. */
function readableRefusal(issue: Issue, map: YardMap): string | null {
  const entrance = issue.code === 'OWNER_ENTRANCE_REPOSITION_REQUIRED' && issue.entityId ? map.accessPoints[issue.entityId] : undefined;
  if (!entrance) return null;
  const facility = map.facilities[entrance.facilityId]?.name ?? entrance.facilityId, where = /位于(轮廓外|轮廓内|边界上)/.exec(issue.message)?.[1] ?? '轮廓另一侧';
  if (!issue.message.includes('保持原位')) return `入口「${entrance.name}」移动后会位于${where}，改变了它与「${facility}」轮廓的原有关系；请保持原有关系。`;
  return `「${facility}」的入口「${entrance.name}」不随这次改动移动，改动后会位于${where}，改变了它与轮廓的原有关系。`
    + (entranceMovable(map, issue.entityId!) ? '要改这里，先点选这个入口把它移开，或缩小改动。' : '它与公共道路或其他对象共用节点，不能移动；可先在属性栏「拆出入口节点」，或缩小改动。');
}

/** Per map, derived once (maps are immutable snapshots). */
function perMap<T>(compute: (map: YardMap) => T): (map: YardMap) => T {
  const cache = new WeakMap<YardMap, T>();
  return map => { let value = cache.get(map); if (value === undefined) { value = compute(map); cache.set(map, value); } return value; };
}
/** The directions turn rules use each road in. A road can become one-way only in a direction every rule on it uses. */
const arcDirections = perMap(map => {
  const used = new Map<string, Set<'forward' | 'backward'>>();
  for (const movement of Object.values(map.movements)) for (const arc of [movement.incomingArc, movement.outgoingArc]) {
    let set = used.get(arc.roadId); if (!set) used.set(arc.roadId, set = new Set()); set.add(arc.direction);
  }
  return used;
});
export function blockedDirections(map: YardMap, roadId: string): ('forward' | 'backward')[] {
  const used = arcDirections(map).get(roadId);
  return used ? (['forward', 'backward'] as const).filter(direction => [...used].some(other => other !== direction)) : [];
}
/** Service types fixed by planning data: a declared loading and unloading capability keeps kind=other, a parking slot keeps parking. */
const parkingServicePoints = perMap(map => new Set(inspectPlanning(map).slots.flatMap(slot => slot.parking && slot.servicePointId ? [slot.servicePointId] : [])));
export function fixedServiceKind(map: YardMap, id: string): string | null {
  if (map.servicePoints[id]?.extensions?.[PLANNING_NAMESPACE]) return '规划数据声明了装载和卸载能力，作业类型须保持「其他」。';
  if (parkingServicePoints(map).has(id)) return '规划数据中的停车泊位引用了此作业点，作业类型须保持「停车」。';
  return null;
}
/** Labels for the sources a value may rest on: sources sharing a name are told apart by id and by how many fields cite them. */
const sourceUse = perMap(map => {
  const count = new Map<string, number>();
  for (const kind of ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'junctions', 'movements', 'resources'] as const) {
    for (const entity of Object.values(map[kind]) as { provenance?: { fieldSources?: Record<string, string> } }[]) {
      for (const ref of Object.values(entity.provenance?.fieldSources ?? {})) count.set(ref, (count.get(ref) ?? 0) + 1);
    }
  }
  const names = new Map<string, number>();
  for (const source of Object.values(map.sources)) names.set(source.name, (names.get(source.name) ?? 0) + 1);
  return { count, names };
});
export function sourceLabels(map: YardMap): [string, string][] {
  const { count, names } = sourceUse(map);
  return Object.entries(map.sources).map(([id, source]) => [id, names.get(source.name)! > 1 ? `${source.name} · ${id}（${count.get(id) ?? 0} 处引用）` : source.name]);
}

export const STATE_LABELS: Record<PhysicalState, string> = { known: '已声明', unknown: '未知', unrestricted: '明确无限制', not_applicable: '不适用' };
