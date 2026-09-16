import { memo, useMemo } from 'react';
import type { SceneSnapshot } from '../adapters/contracts';
import { legacySpatialAppearance, type SpatialAppearance } from '../compiler/spatialColors';
import './spatialColorLegend.css';

export const SPATIAL_COLOR_HINT = '颜色表示分类，不代表通行或承载；可在“描图透明度”调整填充不透明度。';

export function SpatialColorSwatch({ color }: { color: string }) {
  return <span className="spatial-color-swatch" style={{ backgroundColor: color }} aria-hidden="true"/>;
}

export const SpatialColorLegend = memo(function SpatialColorLegend({ scene }: { scene: Pick<SceneSnapshot, 'facilities' | 'zones'> }) {
  const groups = useMemo(() => (['facilities', 'zones'] as const).map(collection => {
    const rows = new Map<string, { appearance: SpatialAppearance; count: number }>();
    for (const entity of scene[collection]) {
      const appearance = entity.appearance ?? legacySpatialAppearance(collection, entity.kind);
      const key = appearance.classId ?? 'legacy:' + appearance.classLabel;
      const row = rows.get(key);
      if (row) row.count++;
      else rows.set(key, { appearance, count: 1 });
    }
    return { collection, label: collection === 'facilities' ? '建筑' : '区域', rows: [...rows].sort(([, a], [, b]) => a.appearance.classLabel.localeCompare(b.appearance.classLabel, 'zh-CN')) };
  }), [scene.facilities, scene.zones]);
  const hasObjects = groups.some(group => group.rows.length > 0);
  return <details className="workbench-settings spatial-color-legend" aria-label="分类颜色图例">
    <summary title={SPATIAL_COLOR_HINT}>分类颜色图例</summary>
    <div className="spatial-controls">
      {hasObjects ? groups.filter(group => group.rows.length).map(group => <section key={group.collection} aria-label={group.label + '分类颜色'}>
        <h3>{group.label}</h3>
        <ul>{group.rows.map(([key, { appearance, count }]) => <li key={key}>
          <SpatialColorSwatch color={appearance.color}/><span className="spatial-color-name">{appearance.classLabel}</span><span className="spatial-color-count">{count} 个</span>
        </li>)}</ul>
      </section>) : <p className="field-note">地图中暂无建筑或区域。</p>}
      <p className="field-note">仅列当前地图已有类别。{SPATIAL_COLOR_HINT}</p>
    </div>
  </details>;
});
