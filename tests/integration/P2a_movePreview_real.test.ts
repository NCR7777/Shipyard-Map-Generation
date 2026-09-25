import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MOVE_POLICY, planMove } from '../../src/app/canvas/movePreview';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { applyMapCommand, commandSupport, type Selection } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import type { RoadSpan, YardMap } from '../../src/domain/model';
import { expectPreviewMatchesCommit } from '../helpers/P2a_previewCheck';
import { resolveP1DataRoot } from '../helpers/P1_targets';

const PATH = 'projects/TIF_可导入底图_20260915/韩华海洋造船厂/map.json';
function hanwha(): YardMap {
  let text: string;
  try { text = readFileSync(resolve(resolveP1DataRoot(), PATH), 'utf8'); }
  catch (error) { throw new Error(`blocked_input: required original ${PATH} cannot be read; SHIPYARD_TEST_DATA_ROOT must contain projects/`, { cause: error }); }
  const loaded = loadMap(text); if (!loaded.ok) throw new Error('Hanwha TIF map does not load');
  return loaded.map;
}

describe('the drag preview matches the commit on the real Hanwha TIF map (0.3.0, cubic roads)', () => {
  it('nodes on curves, curved roads and movable buildings', () => {
    const map = hanwha(), scene = toSceneSnapshot(map), delta = [2.5, -1.25, 0] as const;
    const curved = Object.entries(map.roads).filter(([, road]) => road.geometry?.spans.some((span: RoadSpan) => span.kind === 'cubic'));
    expect(curved.length).toBeGreaterThan(5);
    const candidates: Selection[] = [
      ...[...new Set(curved.flatMap(([, road]) => [road.fromNodeId, road.toNodeId]))].slice(0, 8).map(id => ({ nodes: [id], roads: [] })),
      ...curved.slice(0, 4).map(([id]) => ({ nodes: [], roads: [id] })),
      ...Object.keys(map.facilities).filter(id => { try { planMove(map, scene, { nodes: [], roads: [], facilities: [id] }); return true; } catch { return false; } })
        .slice(0, 3).map(id => ({ nodes: [], roads: [], facilities: [id] })),
    ];
    let matched = 0, refused = 0;
    for (const selection of candidates) {
      let planned = true;
      try { planMove(map, scene, selection); } catch { planned = false; }
      const commit = applyMapCommand(map, { type: 'translateSelection', selection, delta: [...delta], facilityMovePolicy: MOVE_POLICY, zoneMovePolicy: MOVE_POLICY });
      // A selection the preview refuses must also be refused by the commit.
      if (!planned) { expect(commit.ok).toBe(false); refused++; continue; }
      // What the preview lets through the kernel's structural checks also allow; only checks of the landing place remain.
      expect(commandSupport(map, { type: 'translateSelection', selection, delta: [...delta], facilityMovePolicy: MOVE_POLICY, zoneMovePolicy: MOVE_POLICY }).allowed).toBe(true);
      if (!commit.ok) { refused++; continue; }
      expectPreviewMatchesCommit(map, selection, [...delta]);
      matched++;
    }
    expect(matched).toBeGreaterThanOrEqual(8);
    console.log(`P2a preview on Hanwha: ${matched} selections matched the commit, ${refused} refused by the kernel`);
  }, 180_000);
});
