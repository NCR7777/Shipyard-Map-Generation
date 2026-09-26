import type { SceneKind } from '../../adapters/contracts';
import type { IconName } from './icons';

export const KIND_LABELS: Record<SceneKind, string> = {
  facilities: '建筑', zones: '区域', roads: '道路', nodes: '节点', accessPoints: '入口', servicePoints: '作业点',
  siteBoundary: '厂界', junctions: '路口', slots: '储位/车位', resources: '资源', movements: '转向',
  sources: '来源', assets: '图片资源', backgroundLayers: '底图', extensions: '扩展',
};
/** Directory and layer order: what users draw most comes first. */
export const KIND_ORDER: readonly SceneKind[] = ['facilities', 'zones', 'roads', 'nodes', 'accessPoints', 'servicePoints', 'siteBoundary', 'junctions', 'slots', 'resources', 'movements', 'sources', 'assets', 'backgroundLayers', 'extensions'];
export const KIND_ICONS: Partial<Record<SceneKind, IconName>> = {
  facilities: 'building', zones: 'zone', roads: 'road', nodes: 'node', accessPoints: 'point', servicePoints: 'point', siteBoundary: 'zone', backgroundLayers: 'layers',
};
// Plain severities until P5 defines publication profiles; "blocks publishing" would overclaim for a draft check.
export const SERVICE_KIND: Record<string, string> = { loading: '装载', unloading: '卸载', parking: '停车', berth: '泊位', other: '其他' };
export const SEVERITY_LABELS = { error: '错误', warning: '提示' } as const;

export const splitKey = (key: string): { kind: SceneKind; id: string } => {
  const slash = key.indexOf('/');
  return { kind: key.slice(0, slash) as SceneKind, id: key.slice(slash + 1) };
};

/** How a background layer's placement came about, in words. */
export function placementText(method: string, controlPoints: number): string {
  const points = controlPoints ? `，含 ${controlPoints} 个控制点` : '';
  return method === 'affine' ? '按校准文件放置' + points : method === 'similarity' ? '相似变换配准' + points : '手动放置，未经校准核验';
}
