import { SELECTION_KINDS, type Selection, type SelectionKind } from '../../domain/commands';
import type { Vec3, YardMap } from '../../domain/model';
import { entranceSlide } from '../canvas/entrances';
import { duplicateCommand, structuralCheck, translateCommand } from '../canvas/movePreview';
import { separationCommand } from '../canvas/separation';
import { apply, lockedMessage } from './edit';
import { notify, select, store } from './store';

const EDITABLE = new Set<string>(SELECTION_KINDS);

/** The kernel selection for scene keys, or why these keys cannot be edited together. */
export function selectionOf(keys: readonly string[]): Selection | string {
  if (!keys.length) return '当前没有选中对象';
  const selection: Record<SelectionKind, string[]> = { nodes: [], roads: [], facilities: [], zones: [], accessPoints: [], servicePoints: [] };
  for (const key of keys) {
    const at = key.indexOf('/'), kind = key.slice(0, at), id = key.slice(at + 1);
    if (!EDITABLE.has(kind)) return '选中内容里有只能查看的对象（厂界、路口、储位、资源等），请只选节点、道路、建筑、区域、入口或作业点';
    selection[kind as SelectionKind].push(id);
  }
  return selection;
}
/** Why the selection's own layers forbid editing, or null. Indirect effects are checked on the transaction itself. */
export function lockedSelection(selection: Selection): string | null {
  const locked = store.get().drawing.lockedTypes, kinds = SELECTION_KINDS.filter(kind => selection[kind]?.length && locked.includes(kind));
  return kinds.length ? '所选对象所在图层已锁定，不能编辑；可在「图层」页解锁' : null;
}
const keysOf = (selection: Partial<Record<SelectionKind, string[]>>) => SELECTION_KINDS.flatMap(kind => (selection[kind] ?? []).map(id => kind + '/' + id));
const count = (selection: Selection) => keysOf(selection).length;

export function translate(selection: Selection, delta: Vec3, merge?: string): boolean {
  return apply(translateCommand(selection, delta), `移动 ${count(selection)} 个对象`, merge);
}
/** Copies the selection's closure (members and endpoints, never outside roads) and selects the copies. */
export function duplicate(map: YardMap, selection: Selection, delta: Vec3): boolean {
  const command = duplicateCommand(map, selection, delta);
  if (!apply(command, `复制 ${count(selection)} 个对象`)) return false;
  select(keysOf(selection).map(key => { const at = key.indexOf('/'); return key.slice(0, at + 1) + command.idMap[key.slice(at + 1)]; }));
  return true;
}
/** Why a copy of the selection would be refused (kernel reference rules or locked layers), or null. */
export function duplicateRefusal(map: YardMap, selection: Selection): string | null {
  const check = structuralCheck(map, duplicateCommand(map, selection, [10, 10, 0]));
  return check.refusal ?? lockedMessage(check.affectedRefs);
}
/** Arrow keys: 0.1 m, Shift 1 m; a run of nudges on the same selection is one undo step. */
export function nudge(dx: number, dy: number): void {
  const selection = selectionOf(store.get().selection), map = store.get().session?.map;
  if (typeof selection === 'string') { notify(selection, 'error'); return; }
  // A lone entrance on its building's outline steps along it (as a drag slides it). A key across the edge, or outward at a
  // corner, has nothing to follow: it stays.
  const slide = map ? entranceSlide(map, selection, [0, 0, 0]) : undefined, delta: Vec3 = slide ? slide([dx, dy, 0]) : [dx, dy, 0];
  if (slide && Math.hypot(delta[0], delta[1]) < 1e-9) { notify('入口只能沿所属建筑的外边界移动，这个方向上没有可沿的边（与边垂直，或在角点处朝外）；请用沿边方向的方向键，或直接拖动。'); return; }
  translate(selection, delta, 'nudge:' + store.get().selection.join('|'));
}

/** Splits a fixed entrance off the node it shares (one undo step): it moves along its building's wall onto a node of its own;
 *  the old node, its roads and service points stay, and no road is built. */
export function separateEntrance(id: string): void {
  const state = store.get(), map = state.session?.map, entrance = map?.accessPoints[id]; if (!map || !entrance) return;
  const old = map.nodes[entrance.nodeId]!, plan = separationCommand(map, id);
  if ('reason' in plan) { notify(plan.reason, 'error'); return; }
  if (!apply(plan.command, '拆出入口节点')) return;
  select(['accessPoints/' + id]);
  const services = Object.values(store.get().session!.map.servicePoints).filter(point => point.nodeId === entrance.nodeId && point.facilityId === entrance.facilityId).length;
  notify(`已拆出入口「${entrance.name}」：它沿外边界移开 ${Number(plan.distanceM.toFixed(2))} m 到自己的节点；「${old.name}」和它的道路保持不变${services ? `，本建筑在那里的 ${services} 个作业点也留在原节点，仍接在路网上（之后移动建筑或改轮廓时它们不跟着走）` : ''}。入口现在没有接路，需要时用道路工具从入口节点画路接上；它可以沿外边界拖动，所属建筑也能随之移动或改轮廓。`);
}
