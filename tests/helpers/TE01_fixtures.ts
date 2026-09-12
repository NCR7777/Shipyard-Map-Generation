import { editorFixture, testNode } from './M1_fixtures';
import type { YardMap } from '../../src/domain/model';

/** Explicitly synthetic geometry; never a substitute for the frozen original inputs. */
export function TE01Synthetic(): YardMap {
  const map = editorFixture(); map.mapId = 'map_TE01_synthetic'; map.metadata.name = 'TE01 synthetic topology acceptance';
  map.roads.rAB!.direction = 'both';
  map.nodes.nC = testNode('C', 50, 25); map.nodes.nD = testNode('D', 50, 60);
  map.roads.rCD = { ...structuredClone(map.roads.rAB!), name: 'CD', fromNodeId: 'nC', toNodeId: 'nD' };
  return map;
}
