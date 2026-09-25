import { sha256 } from 'js-sha256';
import { parseTree, type Node, type ParseError } from 'jsonc-parser';
import { MAX_JSON_BYTES, type BackgroundLayer, type CoordinateFrame } from '../domain/model';
import { sameValue } from '../domain/value';

export const BG01_CALIBRATION_FORMAT = 'BG01_background_calibration_v1' as const;
export const BG01_PIXEL_CONVENTION = 'pixel_corner_top_left_x_right_y_down' as const;
export type BackgroundAffine = [number, number, number, number, number, number];
export interface BackgroundImageIdentity { sha256: string; widthPx: number; heightPx: number }
export interface CalibrationEvidence { name: string; sha256: string; jsonPath: string }
export interface BackgroundCalibrationDocument {
  format: typeof BG01_CALIBRATION_FORMAT;
  image: BackgroundImageIdentity;
  coordinateFrame: CoordinateFrame;
  pixelConvention: typeof BG01_PIXEL_CONVENTION;
  imageToWorld: BackgroundAffine;
  sourceEvidence: CalibrationEvidence[];
  controlPoints?: BackgroundLayer['controlPoints'];
}
export type BackgroundCalibrationResult =
  | { ok: true; imageToWorld: BackgroundAffine; coordinateFrame: CoordinateFrame;
      pixelConvention: typeof BG01_PIXEL_CONVENTION; sourceEvidence: CalibrationEvidence[]; controlPoints: BackgroundLayer['controlPoints']; notes: string[]; method: 'BG01' | 'legacy_manifest' | 'legacy_register' }
  | { ok: false; status: 'uncalibrated' | 'refused' | 'preprocess_required'; code: string; jsonPath: string; message: string };

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positiveInteger = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value > 0;
const failure = (code: string, jsonPath: string, message: string, status: 'uncalibrated' | 'refused' | 'preprocess_required' = 'refused'): BackgroundCalibrationResult => ({ ok: false, status, code, jsonPath, message });

/** Full frame comparison includes every unit and anchor field, not just origin/rotation. */
function validFrame(value: unknown): value is CoordinateFrame {
  if (!object(value)) return false;
  const fixed = { kind: 'local_cartesian', handedness: 'right', groundPlane: 'XY', upAxis: 'Z', lengthUnit: 'm', angleUnit: 'rad', massUnit: 'kg', timeUnit: 's' };
  if (Object.entries(fixed).some(([key, expected]) => value[key] !== expected)
    || Object.keys(value).some(key => !Object.hasOwn(fixed, key) && key !== 'geographicAnchor')) return false;
  const anchor = value.geographicAnchor;
  return anchor === undefined || (object(anchor) && Object.keys(anchor).length === 5
    && ['crs', 'coordinateOrder', 'method'].every(key => typeof anchor[key] === 'string' && !!anchor[key])
    && Array.isArray(anchor.origin) && anchor.origin.length === 3 && anchor.origin.every(finite) && finite(anchor.rotationRad));
}

function validAffine(value: unknown, image: BackgroundImageIdentity): value is BackgroundAffine {
  if (!Array.isArray(value) || value.length !== 6 || !value.every(finite)) return false;
  const [a, b, c, d, e, f] = value as BackgroundAffine;
  const determinant = a * d - b * c;
  return finite(determinant) && determinant !== 0 && [0, image.widthPx].every(u => [0, image.heightPx].every(v => finite(a * u + c * v + e) && finite(b * u + d * v + f)));
}

function parseDocument(text: string): ObjectValue {
  if (new TextEncoder().encode(text).length > MAX_JSON_BYTES) throw Error('JSON_SIZE_LIMIT');
  // Bound parser recursion before invoking the installed JSON parser.
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > 128) throw Error('JSON_DEPTH_LIMIT'); }
    else if (char === '}' || char === ']') depth--;
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) throw Error('JSON_INVALID');
  const pending: Node[] = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'object') {
      const names = node.children?.map(property => property.children?.[0]?.value as string) ?? [];
      if (new Set(names).size !== names.length) throw Error('JSON_DUPLICATE_KEY');
    }
    if (node.type === 'number' && !Number.isFinite(node.value)) throw Error('JSON_NONFINITE');
    if (node.children) pending.push(...node.children);
  }
  const value: unknown = JSON.parse(text);
  if (!object(value)) throw Error('JSON_OBJECT_REQUIRED');
  return value;
}

function basename(path: string): string | null {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => part === '..' || !part)) return null;
  return normalized.split('/').at(-1)!;
}

/** Browser adapter: no filesystem access, network, map mutation, or projection fitting. */
export function resolveBackgroundCalibration(input: {
  image: BackgroundImageIdentity;
  coordinateFrame: CoordinateFrame;
  documents: { name: string; text: string }[];
}): BackgroundCalibrationResult {
  const { image, coordinateFrame } = input;
  if (!digest(image.sha256) || !positiveInteger(image.widthPx) || !positiveInteger(image.heightPx)) return failure('BG_IMAGE_IDENTITY_INVALID', '/image', '图片摘要或实际解码尺寸无效。');
  if (!validFrame(coordinateFrame)) return failure('BG_FRAME_UNSUPPORTED', '/coordinateFrame', '当前完整坐标框架不受支持。');
  if (!input.documents.length) return failure('BG_CALIBRATION_MISSING', '', '未提供校准文档；图片保持未校准。', 'uncalibrated');
  if (input.documents.length > 12) return failure('BG_CALIBRATION_DOCUMENT_LIMIT', '', '校准文档最多 12 份。');
  const documents: { name: string; value: ObjectValue; hash: string }[] = [];
  try {
    for (const document of input.documents) documents.push({ name: document.name, value: parseDocument(document.text), hash: sha256(document.text) });
  } catch (error) { return failure('BG_' + (error instanceof Error ? error.message : 'JSON_INVALID'), '', '校准 JSON 无效、重复键、非有限数值或超过输入限制。'); }
  const standard = documents.filter(document => document.value.format === BG01_CALIBRATION_FORMAT);
  const evidence = (document: typeof documents[number], jsonPath: string): CalibrationEvidence => ({ name: document.name, sha256: document.hash, jsonPath });
  function accepted(value: ObjectValue, sourceEvidence: CalibrationEvidence[], method: 'BG01' | 'legacy_manifest' | 'legacy_register', notes: string[] = []): BackgroundCalibrationResult {
    const points = value.controlPoints ?? [];
    if (!Array.isArray(points) || points.length > 1000 || !points.every(point => object(point)
      && Array.isArray(point.pixel) && point.pixel.length === 2 && point.pixel.every(finite)
      && Array.isArray(point.world) && point.world.length === 3 && point.world.every(finite)
      && (point.role === 'fit' || point.role === 'check'))) return failure('BG_CONTROL_POINTS_INVALID', '/controlPoints', '控制点必须保留明确 pixel、world 与 fit/check 角色。');
    return { ok: true, method, imageToWorld: [...value.imageToWorld as BackgroundAffine], coordinateFrame: structuredClone(coordinateFrame), pixelConvention: BG01_PIXEL_CONVENTION,
      controlPoints: structuredClone(points) as BackgroundLayer['controlPoints'], sourceEvidence,
      notes: ['校准仅验证文件与坐标变换的对应，不确立现场地理精度。', ...notes] };
  }
  function validate(value: ObjectValue): BackgroundCalibrationResult | null {
    if (value.pixelConvention !== BG01_PIXEL_CONVENTION) return failure('BG_PIXEL_CONVENTION_UNSUPPORTED', '/pixelConvention', '必须明确使用左上像素角点、X 向右、Y 向下。');
    if (!validFrame(value.coordinateFrame) || !sameValue(value.coordinateFrame, coordinateFrame)) return failure('BG_FRAME_MISMATCH', '/coordinateFrame', '校准文档与地图的完整坐标框架不一致。');
    if (!object(value.image) || value.image.sha256 !== image.sha256) return failure('BG_IMAGE_SHA_MISMATCH', '/image/sha256', '校准文档未绑定当前图片的实际 SHA-256。');
    if (value.image.widthPx !== image.widthPx || value.image.heightPx !== image.heightPx) return failure('BG_IMAGE_DIMENSION_MISMATCH', '/image', '校准尺寸与当前图片实际解码尺寸不一致。');
    if (!validAffine(value.imageToWorld, image)) return failure('BG_AFFINE_INVALID', '/imageToWorld', '需要六个有限数值、可逆且角点有限的完整仿射变换。');
    return null;
  }
  if (standard.length > 1) return failure('BG_CALIBRATION_AMBIGUOUS', '', '选择了多份标准校准文档；请只保留当前图片的一份。');
  if (standard.length === 1) {
    const document = standard[0]!;
    const invalid = validate(document.value);
    if (invalid) return invalid;
    const declared = document.value.sourceEvidence;
    if (!Array.isArray(declared) || !declared.length || declared.length > 64 || !declared.every(value => object(value) && typeof value.name === 'string' && !!value.name && digest(value.sha256) && typeof value.jsonPath === 'string')) {
      return failure('BG_SOURCE_EVIDENCE_MISSING', '/sourceEvidence', '标准校准文档需要有摘要与定位的来源证据。');
    }
    return accepted(document.value, [evidence(document, '/imageToWorld'), ...structuredClone(declared) as CalibrationEvidence[]], 'BG01');
  }
  if (documents.some(document => typeof document.value.format === 'string' && document.value.format.startsWith('BG01_'))) return failure('BG_CALIBRATION_VERSION_UNSUPPORTED', '/format', '不支持该校准文档版本。');
  const local = documents.filter(document => object(document.value.referenceImage));
  if (!local.length && documents.some(document => document.value.sourceBounds || document.value.pixel_to_local || document.value.transform)) {
    return failure('BG_REPROJECTION_REQUIRED', '', '源投影或像素拟合不等于精确本地仿射；请先重投影并输出 BG01 校准文档。', 'preprocess_required');
  }
  if (local.length !== 1) return failure('BG_CALIBRATION_UNBOUND', '', '未找到唯一、完整且绑定当前图片的本地校准。', 'uncalibrated');
  const georef = local[0]!, reference = georef.value.referenceImage as ObjectValue;
  const legacyNotes: string[] = [];
  const extraEvidence: CalibrationEvidence[] = [];
  if (georef.value.affine_fit_error_max_m !== undefined) {
    extraEvidence.push(evidence(georef, '/affine_fit_error_max_m'));
    legacyNotes.push(`源像素拟合残差声明为 ${String(georef.value.affine_fit_error_max_m)} m，仅是源投影拟合数值证据，不作为本地 JPEG 或现场精度。`);
  }
  if (georef.value.controlPoints !== undefined) {
    extraEvidence.push(evidence(georef, '/controlPoints'));
    legacyNotes.push('原 georeference 的顶层控制点保留来源定位；未明确属于本地参考图像像素，未转换为背景控制点。');
  }
  if (reference.pixelConvention !== BG01_PIXEL_CONVENTION) return failure('BG_PIXEL_CONVENTION_UNSUPPORTED', '/referenceImage/pixelConvention', '旧校准必须显式声明像素角点约定。');
  if (reference.widthPx !== image.widthPx || reference.heightPx !== image.heightPx) return failure('BG_IMAGE_DIMENSION_MISMATCH', '/referenceImage', '旧校准尺寸与实际图片不一致。');
  if (!validAffine(reference.imageToWorld, image)) return failure('BG_AFFINE_INVALID', '/referenceImage/imageToWorld', '旧校准缺少有效本地六参数仿射。');
  const imageName = typeof reference.path === 'string' ? basename(reference.path) : null;
  if (!imageName) return failure('BG_IMAGE_PATH_INVALID', '/referenceImage/path', '旧校准图像路径无效。');
  const anchor = coordinateFrame.geographicAnchor;
  if (!anchor || !sameValue(georef.value.origin_utm, anchor.origin.slice(0, 2)) || anchor.origin[2] !== 0 || georef.value.theta_rad !== anchor.rotationRad || georef.value.utm_crs !== anchor.crs) {
    return failure('BG_LEGACY_ANCHOR_MISMATCH', '', '旧 georeference 的原点、旋转或 CRS 与目标框架不一致。');
  }
  for (const holder of documents) {
    const value = holder.value;
    // Existing delivery manifests bind the actual image, georef, and a complete map frame.
    const entries = Array.isArray(value.files) ? value.files.filter(object)
      : object(value.filesSha256) ? Object.entries(value.filesSha256).map(([path, hash]) => ({ path, sha256: hash })) : [];
    const hasFile = (name: string, hash: string) => entries.some(entry => typeof entry.path === 'string' && basename(entry.path) === basename(name) && entry.sha256 === hash);
    const maps = documents.filter(document => typeof document.value.mapId === 'string' && validFrame(document.value.coordinateFrame)
      && sameValue(document.value.coordinateFrame, coordinateFrame) && hasFile(document.name, document.hash));
    if (hasFile(imageName, image.sha256) && hasFile(georef.name, georef.hash) && maps.length === 1) {
      return accepted(reference, [evidence(georef, '/referenceImage'), evidence(holder, '/files'), evidence(maps[0]!, '/coordinateFrame'), ...extraEvidence], 'legacy_manifest', legacyNotes);
    }
    const provided = value.providedImage;
    if (object(provided) && provided.sha256 === image.sha256 && provided.widthPx === image.widthPx && provided.heightPx === image.heightPx
      && typeof provided.path === 'string' && basename(provided.path) === imageName && value.georeferenceSha256 === georef.hash
      && validFrame(value.coordinateFrame) && sameValue(value.coordinateFrame, coordinateFrame)) {
      return accepted(reference, [evidence(georef, '/referenceImage'), evidence(holder, '/providedImage'), ...extraEvidence], 'legacy_register', legacyNotes);
    }
  }
  return failure('BG_CALIBRATION_IDENTITY_UNBOUND', '', '旧 georeference 缺少图片 SHA 与完整 frame 的绑定链；请补充匹配 manifest 和原地图，或先生成标准校准文档。', 'uncalibrated');
}
