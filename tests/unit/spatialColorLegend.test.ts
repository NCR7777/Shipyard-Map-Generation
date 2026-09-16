import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SceneSnapshot } from '../../src/adapters/contracts';
import type { Polygon } from '../../src/domain/model';
import { newFacility, newZone } from '../../src/domain/factory';
import { spatialClassColor } from '../../src/compiler/spatialColors';
import { SpatialColorLegend } from '../../src/ui/SpatialColorLegend';

const boundary: Polygon = { outer: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0]], holes: [] };
const render = (scene: Pick<SceneSnapshot, 'facilities' | 'zones'>) => renderToStaticMarkup(createElement(SpatialColorLegend, { scene }));

describe('spatial classification color legend', () => {
  it('groups only present scene classifications, with visible names and counts', () => {
    const color = spatialClassColor('facilities', 'custom_class_001');
    const appearance = { classId: 'custom_class_001', classLabel: '自定义车间', color, stroke: '#000000', selectedStroke: '#ffffff' };
    const scene = {
      facilities: ['F1', 'F2'].map(id => ({ ...newFacility(boundary), id, appearance })),
      zones: [{ ...newZone(boundary, '堆场区域'), id: 'Z1', servicePointIds: [], appearance: { ...appearance, classId: 'yard', classLabel: '堆场', color: spatialClassColor('zones', 'yard') } }],
    };
    const before = structuredClone(scene), html = render(scene);
    expect(html).toContain('aria-label="建筑分类颜色"');
    expect(html).toContain('aria-label="区域分类颜色"');
    expect(html.match(/自定义车间/g)).toHaveLength(1);
    expect(html).toContain('2 个');
    expect(html).toContain('堆场');
    expect(html).toContain('background-color:' + color);
    expect(html).not.toContain('办公楼');
    expect(html).toContain('不代表通行或承载');
    expect(scene).toEqual(before);
  });

  it('uses the renderer legacy fallback when appearance is absent and names the empty state', () => {
    const html = render({ facilities: [{ ...newFacility(boundary, '旧船坞', 'dock'), id: 'legacy' }], zones: [] });
    expect(html).toContain('船坞（类型待确认，历史设施） · 未设置详细分类');
    expect(html).toContain('background-color:#7a8795');
    expect(html).not.toContain('干船坞');
    const empty = render({ facilities: [], zones: [] });
    expect(empty).toContain('地图中暂无建筑或区域');
    expect(empty).not.toContain('<li>');
  });
});
