import { describe, expect, it } from 'vitest';
import {
  adjustFrame, adjustPartAt, ANGLE_STEP, dragTransform, initialPlacement, measuredScale, pixelAt, replacementTransform, ROTATE_OFFSET_PX, scaleAbout, withField,
} from '../../src/app/canvas/backgroundAdjust';
import { drawableBackgrounds, type Raster } from '../../src/app/state/backgrounds';
import { backgroundFrame, backgroundPoint, type BackgroundTransform } from '../../src/geometry/backgrounds';
import { loadMap } from '../../src/domain/load';
import { backgroundMap } from '../helpers/P1B_backgroundMap';

// 64 × 48 px at 1 m/px, top-left pixel corner at world (120, 48): the image covers x 120–184, y 0–48.
const T: BackgroundTransform = [1, 0, 0, -1, 120, 48];
const W = 64, H = 48;
const camera = { offsetX: 0, offsetY: 500, scale: 2 };
const close = (actual: readonly number[], expected: readonly number[], digits = 9) => actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, digits));

describe('handles on screen', () => {
  it('puts the rotation handle beyond the top edge, whichever way the image is turned', () => {
    const frame = adjustFrame(T, W, H, camera);
    // Pixel (0,0) is world (120,48): screen (240, 404); the top edge is up on screen, so the handle is above it.
    close(frame.corners[0], [240, 404]); close(frame.topMiddle, [304, 404]); close(frame.rotate, [304, 404 - ROTATE_OFFSET_PX]);
    const upsideDown: BackgroundTransform = [-1, 0, 0, 1, 184, 0];
    const turned = adjustFrame(upsideDown, W, H, camera);
    // Turned half round: the image's top edge is at the bottom of the screen, and the handle below it.
    expect(turned.rotate[1]).toBeGreaterThan(turned.topMiddle[1]);
  });
  it('takes the rotation handle first, then the nearest corner, then the image; nothing outside', () => {
    const frame = adjustFrame(T, W, H, camera);
    expect(adjustPartAt(frame, frame.rotate)).toEqual({ kind: 'rotate' });
    expect(adjustPartAt(frame, [frame.corners[2][0] + 6, frame.corners[2][1] + 5])).toEqual({ kind: 'corner', corner: 2 });
    expect(adjustPartAt(frame, frame.centre)).toEqual({ kind: 'move' });
    expect(adjustPartAt(frame, [frame.corners[1][0] + 40, frame.corners[1][1]])).toBeNull();
  });
});

describe('dragging', () => {
  const options = { keepAspect: true, snapAngle: false };
  it('moves by the pointer delta rounded to millimetres', () => {
    expect(dragTransform({ kind: 'move' }, T, W, H, [130, 20, 0], [140.00049, 14.9996, 0], options)).toEqual([1, 0, 0, -1, 130, 43]);
  });
  it('resizes from a corner with the opposite corner fixed, keeping where the corner was grabbed', () => {
    // Grabbed 1 m right of the bottom-right corner (184, 0), dragged by (+32, −24): the corner goes to (216, −24).
    const free = dragTransform({ kind: 'corner', corner: 2 }, T, W, H, [185, 0, 0], [217, -24, 0], { keepAspect: false, snapAngle: false });
    close(free, [1.5, 0, 0, -1.5, 120, 48]);
    // Keeping the aspect ratio, a drag off the diagonal becomes a uniform scale.
    const uniform = dragTransform({ kind: 'corner', corner: 2 }, T, W, H, [184, 0, 0], [248, 0, 0], options);
    expect(uniform[0]).toBeCloseTo(-uniform[3], 12);
    expect(uniform.slice(4)).toEqual([120, 48]);
  });
  it('turns about the centre, and in 15° steps with Shift', () => {
    const centre = backgroundFrame(T, W, H).center;
    const turned = dragTransform({ kind: 'rotate' }, T, W, H, [centre[0], centre[1] + 10, 0], [centre[0] - 10, centre[1], 0], options);
    expect(backgroundFrame(turned, W, H).rotationRad).toBeCloseTo(Math.PI / 2, 12);
    close(backgroundFrame(turned, W, H).center, centre, 9);
    const snapped = dragTransform({ kind: 'rotate' }, T, W, H, [centre[0] + 10, centre[1], 0], [centre[0] + 10, centre[1] + 3, 0], { keepAspect: true, snapAngle: true });
    const angle = backgroundFrame(snapped, W, H).rotationRad;
    expect(angle / ANGLE_STEP).toBeCloseTo(Math.round(angle / ANGLE_STEP), 9);
    expect(angle).toBeCloseTo(Math.PI / 12, 9);
  });
  it('refuses a corner dragged through the opposite one instead of mirroring the image', () => {
    expect(() => dragTransform({ kind: 'corner', corner: 2 }, T, W, H, [184, 0, 0], [100, 60, 0], { keepAspect: false, snapAngle: false })).toThrow();
  });
});

describe('scale from a known length', () => {
  it('keeps the first point and scales uniformly', () => {
    const next = measuredScale(T, [0, 48], [64, 48], 128);
    close(next, [2, 0, 0, -2, 120, 96]);
    close(backgroundPoint(next, [0, 48]), backgroundPoint(T, [0, 48]));
  });
  it('refuses nonsense', () => {
    expect(() => measuredScale(T, [3, 4], [3, 4], 10)).toThrow('重合');
    for (const bad of [0, -1, NaN, Infinity]) expect(() => measuredScale(T, [0, 0], [1, 0], bad)).toThrow();
    expect(() => scaleAbout(T, 0, [0, 0])).toThrow();
  });
  it('maps world points back to image pixels', () => {
    const t: BackgroundTransform = [0.8, 0.6, 0.6, -0.8, 10, 20];
    close(pixelAt(t, backgroundPoint(t, [17.5, 3.25])), [17.5, 3.25], 12);
  });
});

describe('numeric fields', () => {
  const odd: BackgroundTransform = [1 / 3, 0, 0, -1 / 3, 120.123456789, 48.987654321];
  it('store a typed corner exactly and leave everything else untouched', () => {
    // Moving by the difference would give 0.09999999999999432 and 0.29999999999999716 here.
    expect(withField(odd, W, H, 'x', 0.1, true)).toEqual([1 / 3, 0, 0, -1 / 3, 0.1, 48.987654321]);
    expect(withField(odd, W, H, 'y', 0.3, true)).toEqual([1 / 3, 0, 0, -1 / 3, 120.123456789, 0.3]);
  });
  it('size keeps the top-left corner; with the aspect ratio kept both axes follow', () => {
    const wide = withField(T, W, H, 'width', 128, false);
    close(wide, [2, 0, 0, -1, 120, 48]);
    const both = withField(T, W, H, 'width', 128, true);
    close(both, [2, 0, 0, -2, 120, 48]);
    close(withField(T, W, H, 'height', 24, true), [0.5, 0, 0, -0.5, 120, 48]);
  });
  it('angle turns about the centre; resolution scales uniformly', () => {
    const turned = withField(T, W, H, 'angle', 15, true);
    expect(backgroundFrame(turned, W, H).rotationRad).toBeCloseTo(Math.PI / 12, 12);
    close(backgroundFrame(turned, W, H).center, backgroundFrame(T, W, H).center, 9);
    close(withField(T, W, H, 'resolution', 0.25, true), [0.25, 0, 0, -0.25, 120, 48]);
  });
  it('refuses non-finite and non-positive sizes', () => {
    expect(() => withField(T, W, H, 'x', NaN, true)).toThrow();
    for (const field of ['width', 'height', 'resolution'] as const) expect(() => withField(T, W, H, field, 0, true)).toThrow();
  });
});

describe('placing a new image', () => {
  it('on an empty map: 1 m per pixel, lower-left corner at the origin', () => {
    const t = initialPlacement(W, H, null);
    expect(t).toEqual([1, 0, 0, -1, 0, 48]);
    close(backgroundPoint(t, [0, 48]), [0, 0]);
  });
  it('over content: covers its bounds, centred', () => {
    const t = initialPlacement(W, H, { min: [0, -20, 0], max: [256, 40, 0] });
    const frame = backgroundFrame(t, W, H);
    expect(frame.widthM).toBeCloseTo(256, 9); expect(frame.heightM).toBeCloseTo(192, 9);
    close(frame.center, [128, 10]);
  });
  it('over a speck of content: 1 m per pixel centred on it', () => {
    close(backgroundFrame(initialPlacement(W, H, { min: [5, 5, 0], max: [5, 5, 0] }), W, H).center, [5, 5]);
  });
});

describe('replacing an image', () => {
  it('keeps the ground when the aspect ratio agrees', () => {
    const { transform, sameGround } = replacementTransform(T, { width: 64, height: 48 }, { width: 128, height: 96 });
    expect(sameGround).toBe(true);
    expect(transform).toEqual([0.5, 0, 0, -0.5, 120, 48]);
    close(backgroundFrame(transform, 128, 96).corners.flat(), backgroundFrame(T, W, H).corners.flat());
  });
  it('otherwise keeps the corner and width without stretching', () => {
    const { transform, sameGround } = replacementTransform(T, { width: 64, height: 48 }, { width: 128, height: 48 });
    expect(sameGround).toBe(false);
    expect(transform).toEqual([0.5, 0, 0, -0.5, 120, 48]);
    expect(backgroundFrame(transform, 128, 48).heightM).toBe(24);
  });
});

describe('the background type in the layer table', () => {
  it('hides every image when hidden', () => {
    const map = loadMap(backgroundMap());
    if (!map.ok) throw new Error('fixture');
    const sha = Object.values(map.map.assets)[0]!.sha256, levels = [{ width: 64, height: 48 }] as unknown as ImageBitmap[];
    const rasters: Record<string, Raster> = { [sha]: { status: 'ready', levels } }, view = { hidden: [], opacity: {}, comparison: false };
    expect(drawableBackgrounds(map.map, rasters, view)).toHaveLength(1);
    expect(drawableBackgrounds(map.map, rasters, view, ['backgroundLayers'])).toEqual([]);
  });
});
