import { strict as assert } from 'node:assert';
import type { YardMap } from '../../src/domain/model';
import { GA01_TARGETS, readGA01Target, assertGA01Equal } from './GA01_targets';

// TE01 reuses the immutable 18-file identity contract; none of the source maps is rewritten.
export const TE01_TARGETS = GA01_TARGETS;
export const readTE01Target = readGA01Target;
export { assertGA01Equal as assertTE01Equal };
export const TE01_HANWHA = {
  id: 'hanwha_v01', roadId: 'R_HW_c96d6ef567',
  nodeIds: ['N_HW_be5a562998', 'N_HW_78f4ff9c56'],
  junctionIds: ['J_HW_be5a562998', 'J_HW_78f4ff9c56'],
  resourceIds: ['RES_J_HW_be5a562998', 'RES_J_HW_78f4ff9c56'],
  movementIds: ['M_HW_4161026acc', 'M_HW_f0db11f0ed', 'M_HW_a6e0d6ffeb', 'M_HW_bfeef3cc85', 'M_HW_b0daf71e51', 'M_HW_47e1055bf3', 'M_HW_b2cde53e61', 'M_HW_111d7c4220'],
} as const;

export function TE01RoadDependencies(map: YardMap, roadId: string) {
  const road = map.roads[roadId]; assert.ok(road, 'real road candidate must exist');
  const nodeIds = [road.fromNodeId, road.toNodeId];
  const movementIds = Object.entries(map.movements).filter(([, turn]) => turn.incomingArc.roadId === roadId || turn.outgoingArc.roadId === roadId).map(([id]) => id);
  return {
    roadId, nodeIds, movementIds,
    junctionIds: Object.entries(map.junctions).filter(([, junction]) => junction.nodeIds.some(id => nodeIds.includes(id))).map(([id]) => id),
    roadResourceIds: [...road.resourceIds],
    movementResourceIds: [...new Set(movementIds.flatMap(id => map.movements[id]!.resourceIds))],
    resourceAppliesTo: Object.entries(map.resources).filter(([, resource]) => resource.appliesTo.some(ref => ref.entityType === 'roads' && ref.entityId === roadId)).map(([id]) => id),
    serviceInternalPaths: Object.entries(map.servicePoints).filter(([, service]) => service.arrival?.mode === 'explicit_internal' && service.arrival.internalPath.some(arc => arc.roadId === roadId)).map(([id]) => id),
    sharedRoads: Object.keys(map.roads).filter(id => id !== roadId && [map.roads[id]!.fromNodeId, map.roads[id]!.toNodeId].some(nodeId => nodeIds.includes(nodeId))),
  };
}

export function assertTE01HanwhaDeletion(before: YardMap, after: YardMap): void {
  const deps = TE01RoadDependencies(before, TE01_HANWHA.roadId);
  assertTE01Set(deps.movementIds, TE01_HANWHA.movementIds);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.roads[TE01_HANWHA.roadId], undefined);
  for (const id of TE01_HANWHA.movementIds) assert.equal(after.movements[id], undefined);
  const expected = structuredClone(before); expected.revision = after.revision;
  delete expected.roads[TE01_HANWHA.roadId];
  for (const id of TE01_HANWHA.movementIds) delete expected.movements[id];
  const namespace = 'org.shipyard.editor.lineage';
  const lineage = after.extensions[namespace] as { version: string; roadSplits: unknown[]; topologyEdits: { operation: string; removedNodes: string[]; removedRoads: string[]; removedMovements: string[]; removedJunctions: string[] }[] };
  assert.ok(lineage); assert.equal(lineage.version, '1.0.0'); assert.deepEqual(lineage.roadSplits, []); assert.equal(lineage.topologyEdits.length, 1);
  const record = lineage.topologyEdits[0]!;
  assert.deepEqual({ ...record, removedMovements: [...record.removedMovements].sort() }, { operation: 'deleteSelection', removedNodes: [], removedRoads: [TE01_HANWHA.roadId], removedMovements: [...TE01_HANWHA.movementIds].sort(), removedJunctions: [] });
  assert.deepEqual(Object.keys(lineage).sort(), ['roadSplits', 'topologyEdits', 'version']);
  expected.extensionNamespaces[namespace] = { version: '1.0.0', category: 'metadata' };
  expected.extensions[namespace] = structuredClone(lineage);
  // This road has no direct resource/slot/service-path reference. All shared roads, resources,
  // remaining turns, junctions, nodes, source records and the frozen frame must remain exact.
  assertGA01Equal(after, expected, 'explicit deletion removes only one road and its eight dependent turns');
}
export function assertTE01Set(actual: readonly string[], expected: readonly string[]): void {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

// Frozen after actual isolated apply success; rejected earlier candidates remain in the TE01 cache audit.
export const TE01_NETWORK_COMMANDS: Record<string, { merge: import('../../src/domain/commands').MapCommand; connect: import('../../src/domain/commands').MapCommand }> = {
  "cimc_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_CR_cfba8bcd58",
      "targetNodeId": "N_CR_fde3ca5e36"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_CR_22695fe379",
      "roadId": "R_CR_f77cd86c8b",
      "distanceM": 58.00000000000001,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "cimc_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_CR_cfba8bcd58",
      "targetNodeId": "N_CR_fde3ca5e36"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_MR_fa232af6da19",
      "roadId": "R_MR_745f48f7ce61",
      "distanceM": 0.05163954847506912,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "dalian_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_DL_72cf2f4370",
      "targetNodeId": "N_DL_bc0fc2cf84"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_DL_675ce2922b",
      "roadId": "R_DL_23d601adb9",
      "distanceM": 780,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "dalian_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_MR_65b56f3312ec",
      "targetNodeId": "N_MR_8b35b07139f3"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_MR_e2c90e6b1f34",
      "roadId": "R_MR_2b21ad847838",
      "distanceM": 285.2197640851123,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "geoje_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_GJ_a31f102a1d",
      "targetNodeId": "N_GJ_05aff87f1b"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_GJ_a7f8d95194",
      "roadId": "R_GJ_39bd2c2b90",
      "distanceM": 5.400000000000091,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "geoje_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_MR_0e26f6060f0f",
      "targetNodeId": "N_MR_47bafe60bdd9"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_MR_05db4f0e8e44",
      "roadId": "R_MR_89a5794eae3d",
      "distanceM": 0.017037233888089635,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "hanwha_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_HW_19a2407a15",
      "targetNodeId": "N_HW_ea0b7a0538"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_HW_8461df2e22",
      "roadId": "R_HW_fce2d4f4a3",
      "distanceM": 0.00016542824819301897,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "hanwha_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_HW_19a2407a15",
      "targetNodeId": "N_HW_ea0b7a0538"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_HW_8461df2e22",
      "roadId": "R_HW_fce2d4f4a3",
      "distanceM": 0.00016542824819301897,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "hudong_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_HD_634a0f6cce",
      "targetNodeId": "N_HD_c9ee37fb1d"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_HD_fd359cb28e",
      "roadId": "R_HD_208817e4c5",
      "distanceM": 0.0011997600719738264,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "hudong_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_HD_634a0f6cce",
      "targetNodeId": "N_HD_c9ee37fb1d"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_HD_fd359cb28e",
      "roadId": "R_HD_208817e4c5",
      "distanceM": 0.0011997600719738264,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "newtimes_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_NT_03410738d1",
      "targetNodeId": "N_NT_14932a5338"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_NT_61b2b263fc",
      "roadId": "R_NT_4e9e4b5a7f",
      "distanceM": 39.98782536229444,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "newtimes_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_NT_03410738d1",
      "targetNodeId": "N_NT_14932a5338"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_NT_61b2b263fc",
      "roadId": "R_NT_4e9e4b5a7f",
      "distanceM": 39.98782536229444,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "samho_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_SH_d93ee5ee6c",
      "targetNodeId": "N_SH_0a41b9d7ec"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_SH_b50d1509fe",
      "roadId": "R_SH_146ec2860f",
      "distanceM": 366.0008245951385,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "samho_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_SH_d93ee5ee6c",
      "targetNodeId": "N_SH_0a41b9d7ec"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_SH_3f35fe1f5e",
      "roadId": "R_SH_9d5524dd32",
      "distanceM": 114.99979337446993,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "weihai_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_0085",
      "targetNodeId": "N_0070"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_0153",
      "roadId": "R_0077",
      "distanceM": 140,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "weihai_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_0085",
      "targetNodeId": "N_0070"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_0153",
      "roadId": "R_0077",
      "distanceM": 140,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "xinyangzi_v01": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_XY_672a65dd3e",
      "targetNodeId": "N_XY_69304fa0eb"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_XY_359d4e9a26",
      "roadId": "R_XY_7726a9b98f",
      "distanceM": 5,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  },
  "xinyangzi_v02": {
    "merge": {
      "type": "mergeNodes",
      "sourceNodeId": "N_MR_3950c12e084e",
      "targetNodeId": "N_MR_23e979d042c9"
    },
    "connect": {
      "type": "connectNodeToRoad",
      "nodeId": "N_MR_23e979d042c9",
      "roadId": "R_MR_1cf951609a69",
      "distanceM": 317.852884647266,
      "newRoadIds": [
        "R_TE01_left",
        "R_TE01_right"
      ],
      "junctionId": "J_TE01_connect",
      "approvedMovements": []
    }
  }
};
