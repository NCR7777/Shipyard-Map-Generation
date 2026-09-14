import { expect, test } from 'vitest';
import { orientedRectangleVertices } from '../../src/renderers/2d/useSpatialDrawing';
import { validateEditorState } from '../../src/editor/projectController';

test('FAST01 drawing preferences recover and a three-point oblique rectangle has four right angles', () => {
  const restored = validateEditorState({ camera: { offsetX: 0, offsetY: 0, scale: 2 }, drawing: { roadWidthM: 18, roadDirection: 'backward' } });
  expect(restored.drawing.roadWidthM).toBe(18);
  expect(restored.drawing.roadDirection).toBe('backward');
  expect(restored.drawing.facilityKind).toBe('building');
  const points = orientedRectangleVertices([1, 2, 3], [5, 5, 3], [0, 8, 3]);
  for (let i = 0; i < 4; i++) {
    const a = points[i]!, b = points[(i + 1) % 4]!, c = points[(i + 2) % 4]!;
    expect((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])).toBeCloseTo(0, 12);
    expect(a[2]).toBe(3);
  }
  expect(() => orientedRectangleVertices([0, 0, 0], [0, 0, 0], [5, 5, 0])).toThrow();
});


test('FAST02 midpoint bending keeps authoritative endpoints and existing cubic shape offsets', async () => {
  const { curveThroughMidpoint, bendPathSpan } = await import('../../src/geometry/curveEditing');
  const { pointAt } = await import('../../src/geometry/roadPath');
  const a: [number,number,number]=[0,0,0], b: [number,number,number]=[100,0,0], middle: [number,number,number]=[50,30,0];
  const path={anchors:[a,b],spans:[curveThroughMidpoint(a,b,middle)]};
  expect(pointAt(path,0,0.5)).toEqual(middle);
  const bent=bendPathSpan(path,0,[50,60,0]);
  expect(bent.anchors).toEqual(path.anchors);expect(pointAt(bent,0,0.5)).toEqual([50,60,0]);expect(pointAt(path,0,0.5)).toEqual(middle);
});


test('FAST01 narrow-road width controls preserve metric width at zero displacement and both normal sides', async () => {
  const {roadWidthHandle,widthFromRoadHandle}=await import('../../src/renderers/2d/roadWidthHandles');
  for(const scale of [0.615,10])for(const tangent of [[1,0,0],[-1,0,0],[0.6,0.8,0]] as [number,number,number][])for(const sign of [-1,1] as const){
    const handle=roadWidthHandle([100,200,0],tangent,12,sign,{scale,offsetX:0,offsetY:0});
    expect(widthFromRoadHandle(handle,handle.position)).toBeCloseTo(12,10);
    expect(Math.hypot(handle.position[0]-100,handle.position[1]-200)*scale).toBeCloseTo(Math.max(16,6*scale),10);
    const moved:[number,number,number]=[handle.position[0]+handle.normal[0]*sign*12,handle.position[1]+handle.normal[1]*sign*12,0];
    expect(widthFromRoadHandle(handle,moved)).toBeCloseTo(36,10);
    expect(Math.hypot(handle.edgeScreen[0]-100*scale,handle.edgeScreen[1]+200*scale)).toBeCloseTo(6*scale,10);
  }
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
