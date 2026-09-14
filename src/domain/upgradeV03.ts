import type { RoadGeometry, YardMap, YardMapV03 } from './model';

export interface SchemaMigrationChange { path: string; before: unknown; after: unknown }
export interface SchemaMigrationV03 { map: YardMapV03; changes: SchemaMigrationChange[] }

/** Explicit copy migration: coordinates, entity IDs, attributes and provenance stay exact. */
export function upgradeMapToV03(map: YardMap): SchemaMigrationV03 {
  if (map.schemaVersion === '0.3.0') return { map: structuredClone(map), changes: [] };
  const changes: SchemaMigrationChange[] = [
    { path: '/schemaVersion', before: map.schemaVersion, after: '0.3.0' },
    { path: '/revision', before: map.revision, after: map.revision + 1 },
  ];
  const next = structuredClone(map);
  const roads: YardMapV03['roads'] = {};
  for (const [id, road] of Object.entries(next.roads)) {
    const { shapePoints, ...properties } = road;
    const geometry: RoadGeometry = { kind: 'path', anchors: shapePoints, spans: [{ kind: 'line' }, ...shapePoints.map(() => ({ kind: 'line' as const }))] };
    roads[id] = { ...properties, geometry };
    const path = '/roads/' + id.replace(/~/g, '~0').replace(/\//g, '~1');
    changes.push({ path: path + '/shapePoints', before: structuredClone(shapePoints), after: undefined }, { path: path + '/geometry', before: undefined, after: structuredClone(geometry) });
  }
  return { map: { ...next, schemaVersion: '0.3.0', revision: next.revision + 1, roads }, changes };
}
