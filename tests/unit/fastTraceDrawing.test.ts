import { expect, test } from 'vitest';

test('FAST02 midpoint bending keeps authoritative endpoints and existing cubic shape offsets', async () => {
  const { curveThroughMidpoint, bendPathSpan } = await import('../../src/geometry/curveEditing');
  const { pointAt } = await import('../../src/geometry/roadPath');
  const a: [number,number,number]=[0,0,0], b: [number,number,number]=[100,0,0], middle: [number,number,number]=[50,30,0];
  const path={anchors:[a,b],spans:[curveThroughMidpoint(a,b,middle)]};
  expect(pointAt(path,0,0.5)).toEqual(middle);
  const bent=bendPathSpan(path,0,[50,60,0]);
  expect(bent.anchors).toEqual(path.anchors);expect(pointAt(bent,0,0.5)).toEqual([50,60,0]);expect(pointAt(path,0,0.5)).toEqual(middle);
});

test('FAST01 one road draft stores line-cubic-line and maintains only requested smooth joins', async()=>{
  const {appendDraftLine,appendDraftCurve,draftRoadGeometry,lastDraftJoin}=await import('../../src/editor/roadDrawing');
  const {tangentAt}=await import('../../src/geometry/roadPath');
  const start:import('../../src/editor/roadDrawing').DraftRoad={points:[[0,0,0]],spans:[],continuity:'smooth'};
  const line=appendDraftLine(start,[50,0,0]),curve=appendDraftCurve(line,[100,50,0],[85,15,0]),end=appendDraftLine(curve,[100,100,0]);
  expect(draftRoadGeometry(end).spans.map(span=>span.kind)).toEqual(['line','cubic','line']);expect(end.points).toHaveLength(4);expect(start.points).toHaveLength(1);
  const path={anchors:end.points,spans:end.spans};expect(lastDraftJoin(path)).toBe('smooth');
  const before=tangentAt(path,0,1),after=tangentAt(path,1,0);expect(before[0]*after[0]+before[1]*after[1]).toBeCloseTo(1,10);
  const corner=appendDraftCurve({...line,continuity:'corner'},[100,50,0],[85,15,0]);expect(lastDraftJoin({anchors:corner.points,spans:corner.spans})).toBe('corner');
});
