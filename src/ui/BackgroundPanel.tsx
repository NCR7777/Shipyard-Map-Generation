import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MapCommand } from '../domain/commands';
import type { YardMap } from '../domain/model';
import { inspectBackground } from '../domain/backgrounds';
import { backgroundFrame, rotateBackground, scaleBackground, translateBackground, type BackgroundTransform } from '../geometry/backgrounds';
import type { BackgroundPreferences, RasterAssetBytes } from '../editor/projectController';
import { DEFAULT_BACKGROUND_LAYER_PREFERENCE } from '../editor/projectController';
import { usePropertyDraft, type DraftContext, type PropertyDraftProps } from '../editor/drafts';
import { resolveBackgroundCalibration, type BackgroundCalibrationResult } from '../adapters/backgroundCalibration';
import type { useBackgroundAssets } from './useBackgroundAssets';

interface Props extends PropertyDraftProps {
  map: YardMap; context: DraftContext; preferences: BackgroundPreferences;
  assets: ReturnType<typeof useBackgroundAssets>; disabled: boolean; adjustingId: string | null;
  onPreferences(value: BackgroundPreferences): void;
  onAdjust(id: string | null): void; onFit(id: string): void;
  onApply(command: MapCommand, context: DraftContext): boolean;
  onDirtyChange(value: boolean): void; keepAspect: boolean; onKeepAspect(value: boolean): void;
}
type Candidate = { file: File; asset: RasterAssetBytes; context: DraftContext; calibration: BackgroundCalibrationResult; replacingId?: string };
const uid = (prefix: string) => prefix + '_' + crypto.randomUUID().replaceAll('-', '');
const format = (value: number) => String(value);
const emptyPreferences = DEFAULT_BACKGROUND_LAYER_PREFERENCE;
/** Raster bytes live in the existing project store. This panel only proposes domain commands. */
export function BackgroundPanel(props: Props) {
  const [selectedId, setSelectedId] = useState(props.adjustingId ?? Object.keys(props.map.backgroundLayers)[0] ?? '');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sequence = useRef(0); const latest = useRef(props); latest.current = props;
  const importInput = useRef<HTMLInputElement>(null); const calibrationInput = useRef<HTMLInputElement>(null);
  const relinkInput = useRef<HTMLInputElement>(null); const replacementInput = useRef<HTMLInputElement>(null);
  const id = props.adjustingId ?? selectedId;
  const layer = props.map.backgroundLayers[id]; const asset = layer && props.map.assets[layer.assetId];
  const support = layer ? inspectBackground(props.map, id) : null;
  let frame: ReturnType<typeof backgroundFrame> | null = null;
  if (support?.supported && layer && asset?.widthPx && asset.heightPx) frame = backgroundFrame(layer.imageToWorld, asset.widthPx, asset.heightPx);
  const pref = props.preferences.layers[id] ?? emptyPreferences;
  const keepAspect = props.keepAspect;
  const initial = () => frame && layer ? { x: format(layer.imageToWorld[4]), y: format(layer.imageToWorld[5]), width: format(frame.widthM), height: format(frame.heightM), angle: format(frame.rotationRad * 180 / Math.PI), scale: '100' } : null;
  const [values, setValues] = useState(initial);
  const [formDirty, setFormDirty] = useState(false);
  const dirty = !!candidate || formDirty;
  useLayoutEffect(() => { props.onDirtyChange(dirty); return () => props.onDirtyChange(false); }, [dirty, props.onDirtyChange]);
  useEffect(() => () => { sequence.current++; }, []);
  function preference(patch: Partial<typeof pref>) { props.onPreferences({ ...props.preferences, layers: { ...props.preferences.layers, [id]: { ...pref, ...patch } } }); }
  function commitTransform(): boolean {
    if (!layer || !asset?.widthPx || !asset.heightPx || !frame || !values || props.disabled || props.adjustingId !== id) return false;
    try {
      const { x, y, width, height, angle, scale } = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim() ? Number(value) : NaN])) as Record<keyof NonNullable<typeof values>, number>;
      if (![x, y, width, height, angle, scale].every(Number.isFinite) || Math.min(width, height, scale) <= 0) throw Error('位置、角度必须有限；宽、高和比例必须大于零。');
      let transform = layer.imageToWorld;
      const factorX = width / frame.widthM * scale / 100, factorY = height / frame.heightM * scale / 100;
      if (factorX !== 1 || factorY !== 1) transform = scaleBackground(transform, asset.widthPx, asset.heightPx, factorX, factorY, 0);
      if (angle !== frame.rotationRad * 180 / Math.PI) transform = rotateBackground(transform, asset.widthPx, asset.heightPx, angle * Math.PI / 180 - frame.rotationRad);
      // X/Y explicitly position the upper-left pixel corner after rotation and scaling.
      transform = translateBackground(transform, [values.x !== format(layer.imageToWorld[4]) ? x - transform[4] : 0, values.y !== format(layer.imageToWorld[5]) ? y - transform[5] : 0]);
      const ok = props.onApply({ type: 'updateBackgroundTransform', id, imageToWorld: transform }, props.context);
      if (ok) { setFormDirty(false); setError(''); } return ok;
    } catch (failure) { setError(String(failure)); return false; }
  }
  function commitCandidate(): boolean {
    if (!candidate || props.disabled || busy) return false;
    if (!candidate.calibration.ok && candidate.calibration.status !== 'uncalibrated' && !candidate.replacingId) { setError('校准资料未通过。请取消后仅选择图片，以明确未校准方式添加，或使用本地预处理资料。'); return false; }
    const existingAsset = Object.entries(props.map.assets).find(([, value]) => value.sha256 === candidate.asset.sha256 && value.mediaType === candidate.asset.mimeType && value.widthPx === candidate.asset.width && value.heightPx === candidate.asset.height);
    const sourceId = existingAsset?.[1].sourceRef ?? uid('source_background'), assetId = existingAsset?.[0] ?? uid('asset');
    const extension = candidate.asset.mimeType === 'image/jpeg' ? 'jpg' : candidate.asset.mimeType === 'image/png' ? 'png' : 'webp';
    const assetValue = existingAsset?.[1] ?? { path: 'assets/' + candidate.asset.sha256 + '.' + extension, sha256: candidate.asset.sha256, mediaType: candidate.asset.mimeType,
      widthPx: candidate.asset.width, heightPx: candidate.asset.height, sourceRef: sourceId };
    const source = { id: sourceId, value: props.map.sources[sourceId] ?? { name: candidate.file.name, category: candidate.calibration.ok ? 'imagery_derived' as const : 'design_assumption' as const,
      description: JSON.stringify({ operation: candidate.replacingId ? 'explicit_image_replacement' : 'background_import', originalFilename: candidate.file.name,
        imageSha256: candidate.asset.sha256, calibration: candidate.calibration, note: '像素角点为左上原点，X右、Y下；文件身份匹配不等于独立测量精度认证。原件及校准文档保留在来源目录。' }) } };
    let command: MapCommand;
    if (candidate.replacingId) command = { type: 'replaceBackgroundAsset', id: candidate.replacingId, assetId, asset: assetValue, source };
    else {
      const points = Object.values(props.map.nodes).map(node => node.position);
      const minX = points.length ? Math.min(...points.map(p => p[0])) : 0, maxX = points.length ? Math.max(...points.map(p => p[0])) : 200;
      const minY = points.length ? Math.min(...points.map(p => p[1])) : 0, maxY = points.length ? Math.max(...points.map(p => p[1])) : 200;
      const scale = Math.max(10, maxX - minX) / candidate.asset.width;
      const imageToWorld: BackgroundTransform = candidate.calibration.ok ? candidate.calibration.imageToWorld : [scale, 0, 0, -scale, minX, (minY + maxY + candidate.asset.height * scale) / 2];
      command = { type: 'addBackground', id: uid('background'), assetId, asset: assetValue, source, layer: {
        name: candidate.file.name, assetId, imageToWorld, pixelConvention: 'top_left_x_right_y_down_exif_normalized', method: candidate.calibration.ok ? 'affine' : 'manual', controlPoints: candidate.calibration.ok ? candidate.calibration.controlPoints : [],
        provenance: { category: candidate.calibration.ok ? 'imagery_derived' : 'design_assumption', sourceRefs: [sourceId], note: candidate.calibration.ok ? '已匹配图片身份与完整坐标框架；精度未独立核验。证据：' + JSON.stringify(candidate.calibration.sourceEvidence) : '尚未校准：初始适应地图附近仅为显示，不能视为准确配准。' },
      } };
    }
    const ok = props.onApply(command, candidate.context);
    if (ok) { setCandidate(null); if (command.type === 'addBackground') setSelectedId(command.id); props.assets.reload(); } return ok;
  }
  usePropertyDraft(props.context, dirty, () => candidate ? commitCandidate() : commitTransform(), props.onDraftChange);
  async function documents(files: File[]) {
    if (files.length > 12 || files.some(file => file.size > 10 * 1024 * 1024)) throw Error('校准文档最多12份，每份不超过10MiB。');
    return Promise.all(files.map(async file => ({ name: file.name, text: await file.text() })));
  }
  async function prepare(files: File[], replacingId?: string) {
    const token = ++sequence.current; const context = { ...props.context };
    setBusy(true); setError('');
    try {
      const images = files.filter(file => !file.name.toLowerCase().endsWith('.json'));
      if (images.length !== 1 || !context.projectId) throw Error('请选择一张 PNG、JPEG 或 WebP；可同时选择对应校准 JSON。');
      const file = images[0]!;
      const binary = await props.assets.persistFile(file, context.projectId);
      const docs = await documents(files.filter(file => file.name.toLowerCase().endsWith('.json')));
      if (sequence.current !== token || latest.current.context.projectId !== context.projectId || latest.current.context.changeToken !== context.changeToken) throw Error('底图准备期间工程或地图已变化；未添加旧候选，请重新选择。');
      const calibration = resolveBackgroundCalibration({ image: { sha256: binary.sha256, widthPx: binary.width, heightPx: binary.height }, coordinateFrame: props.map.coordinateFrame, documents: docs });
      setCandidate({ file, asset: binary, context, calibration, ...(replacingId ? { replacingId } : {}) });
    } catch (failure) { if (sequence.current === token) setError(String(failure)); }
    finally { if (sequence.current === token) setBusy(false); }
  }
  async function calibrate(files: File[]) {
    if (!candidate) return; const token = ++sequence.current; setBusy(true);
    try {
      const docs = await documents(files);
      if (token !== sequence.current) return;
      setCandidate({ ...candidate, calibration: resolveBackgroundCalibration({ image: { sha256: candidate.asset.sha256, widthPx: candidate.asset.width, heightPx: candidate.asset.height }, coordinateFrame: props.map.coordinateFrame, documents: docs }) });
    } catch (failure) { if (sequence.current === token) setError(String(failure)); }
    finally { if (sequence.current === token) setBusy(false); }
  }
  async function relink(file: File) {
    if (!asset || !props.context.projectId) return; setBusy(true); setError('');
    try { await props.assets.persistFile(file, props.context.projectId, asset.sha256); props.assets.reload(); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  function resetFields(nextId: string) {
    setSelectedId(nextId); setFormDirty(false); setError('');
    const l = props.map.backgroundLayers[nextId], a = l && props.map.assets[l.assetId];
    if (l && a?.widthPx && a.heightPx && inspectBackground(props.map, nextId).supported) { const f = backgroundFrame(l.imageToWorld, a.widthPx, a.heightPx); setValues({ x: format(l.imageToWorld[4]), y: format(l.imageToWorld[5]), width: format(f.widthM), height: format(f.heightM), angle: format(f.rotationRad * 180 / Math.PI), scale: '100' }); } else setValues(null);
  }
  const item = props.assets.items.find(item => item.id === id);
  // Same image at the same place adds a full-image repaint per frame without changing the view.
  const layers = Object.values(props.map.backgroundLayers);
  const duplicateLayers = layers.length - new Set(layers.map(value => value.assetId + JSON.stringify(value.imageToWorld))).size;
  return <div className="background-panel" data-testid="background-panel">
    <input hidden type="file" multiple ref={importInput} data-testid="background-file-input" accept=".png,.jpg,.jpeg,.webp,.json" onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void prepare(files); }}/>
    <input hidden type="file" multiple ref={calibrationInput} data-testid="background-calibration-input" accept=".json" onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void calibrate(files); }}/>
    <input hidden type="file" ref={relinkInput} data-testid="background-relink-input" accept=".png,.jpg,.jpeg,.webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void relink(file); }}/>
    <input hidden type="file" ref={replacementInput} data-testid="background-replacement-input" accept=".png,.jpg,.jpeg,.webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void prepare([file], id); }}/>
    <button className="primary-button" disabled={props.disabled || busy || dirty || !!props.adjustingId} onClick={() => importInput.current?.click()}>添加底图</button>
    <p className="field-note">PNG / JPEG / WebP，≤32 MiB、≤2400万像素。可同时选择图片和校准 JSON。GeoTIFF 请使用 BG01 本地预处理脚本。</p>
    {busy && <p role="status">正在校验并保存图片字节…</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {candidate && <div className="background-candidate" role="region" aria-label="底图导入候选">
      <strong>{candidate.file.name}</strong><p>{candidate.asset.width} × {candidate.asset.height} px · SHA {candidate.asset.sha256.slice(0, 12)}</p>
      <p data-testid="background-calibration-status">{candidate.calibration.ok ? '校准匹配：图片身份、像素约定与完整坐标框架一致。' : candidate.calibration.code + ' · ' + candidate.calibration.message}</p>
      {candidate.replacingId && <p className="inline-error">将明确替换为不同图片；保留现有仿射变换与原校准证据，标为人工调整，旧精度不再适用。请重新检查覆盖范围。</p>}
      <button disabled={busy} onClick={() => calibrationInput.current?.click()}>选择校准资料</button>
      <button disabled={busy || props.disabled || (!candidate.replacingId && !candidate.calibration.ok && candidate.calibration.status !== 'uncalibrated')} onClick={commitCandidate}>{candidate.replacingId ? '明确替换此图片' : '添加此底图'}</button>
      <button onClick={() => { sequence.current++; setCandidate(null); setBusy(false); }}>取消导入</button>
    </div>}
    {!!Object.keys(props.map.backgroundLayers).length && <>
      <label className="field-label">当前底图<select aria-label="当前底图" value={id} disabled={dirty || !!props.adjustingId} onChange={event => resetFields(event.target.value)}>{Object.entries(props.map.backgroundLayers).map(([key, value]) => <option key={key} value={key}>{value.name} · {key}</option>)}</select></label>
      {duplicateLayers > 0 && <p className="inline-error" data-testid="background-duplicates">另有 {duplicateLayers} 个底图层与其他层引用同一图片且位置相同：画面没有区别，但每层都整张重绘，拖动和缩放会变慢。可切换到多余的层后点“删除此底图”。</p>}
      {layer && <>
        <p className="field-note" data-testid="background-image-status">{pref.visible ? item?.status === 'ready' ? '图片已就绪' : item?.status === 'missing' ? '图片缺失；矢量与资产引用保留。' : item?.status === 'error' ? item.error : item?.status === 'loading' ? '图片加载中…' : '当前未加载；请检查底图类型显隐。' : '底图已隐藏'} · {layer.method === 'manual' ? '人工定位／尚未校准，旧精度结论不适用。' : '使用已声明变换，精度未独立核验。'}</p>
        {!support?.supported && <p className="inline-error">{support?.reasons.join('；')}</p>}
        <label className="check-field"><input type="checkbox" aria-label="显示此底图" checked={pref.visible} onChange={event => { preference({ visible: event.target.checked }); if (!event.target.checked && props.adjustingId) props.onAdjust(null); }}/>显示底图</label>
        <label className="field-label">透明度 (%)<input aria-label="底图透明度滑块" type="range" min="0" max="100" step="1" value={pref.opacity * 100} onChange={event => preference({ opacity: Number(event.target.value) / 100 })}/><input aria-label="底图透明度 (%)" type="number" min="0" max="100" value={Number((pref.opacity * 100).toFixed(2))} onChange={event => { if (event.target.value !== '' && Number.isFinite(Number(event.target.value))) preference({ opacity: Math.min(100, Math.max(0, Number(event.target.value))) / 100 }); }}/></label>
        <label className="check-field"><input type="checkbox" aria-label="锁定此底图" checked={pref.locked} onChange={event => { preference({ locked: event.target.checked }); if (event.target.checked && props.adjustingId) props.onAdjust(null); }}/>锁定底图（普通选择始终忽略底图）</label>
        <label className="check-field"><input type="checkbox" aria-label="影像对照模式" checked={props.preferences.comparisonMode} onChange={event => props.onPreferences({ ...props.preferences, comparisonMode: event.target.checked })}/>影像对照模式</label>
        <div className="tool-grid"><button disabled={!support?.supported} onClick={() => props.onFit(id)}>适应底图</button><button disabled={dirty || (!props.adjustingId && (props.disabled || !support?.supported || !pref.visible || item?.status !== 'ready'))} onClick={() => props.onAdjust(props.adjustingId ? null : id)}>{props.adjustingId ? '完成调整并锁定' : '调整底图'}</button></div>
        {props.adjustingId === id && frame && asset && values && <>
          <p className="field-note">拖动影像平移；拖角固定对角点；圆柄绕图片中心旋转。X/Y 为调整后图片左上像素角点，世界 Y 向上，正角逆时针。方向键每次 0.1m，Shift 为 1m。滚轮、中键仅移动视窗。</p>
          <label className="check-field"><input type="checkbox" aria-label="保持底图长宽比" checked={keepAspect} onChange={event => { props.onKeepAspect(event.target.checked); }}/>保持当前长宽比</label>
          {!keepAspect && <p className="inline-error">非等比缩放可能造成影像失真；不会移除已有仿射剪切。</p>}
          {(['x','y','width','height','angle','scale'] as const).map(field => <label className="field-label" key={field}>{({x:'左上 X (m)',y:'左上 Y (m)',width:'底图宽度 (m)',height:'底图高度 (m)',angle:'底图旋转 (°)',scale:'追加等比缩放 (%)'})[field]}<input aria-label={({'x':'底图 X (m)','y':'底图 Y (m)','width':'底图宽度 (m)','height':'底图高度 (m)','angle':'底图旋转 (°)','scale':'底图比例 (%)'})[field]} type="number" step="any" value={values[field]} onChange={event => {
            const value = event.target.value; setFormDirty(true); setValues(current => {
              if (!current) return current; const next = { ...current, [field]: value };
              if (keepAspect && field === 'width') next.height = format(Number(value) / frame.widthM * frame.heightM);
              if (keepAspect && field === 'height') next.width = format(Number(value) / frame.heightM * frame.widthM);
              return next;
            });
          }}/></label>)}
          <button disabled={props.disabled || !formDirty} onClick={commitTransform}>应用底图数值</button><button onClick={() => { setValues(initial()); setFormDirty(false); setError(''); }}>恢复底图输入</button>
        </>}
        <div className="tool-grid"><button disabled={busy || dirty} onClick={() => relinkInput.current?.click()}>重新关联同一图片</button><button disabled={props.disabled || busy || dirty || !!props.adjustingId || !support?.supported} onClick={() => replacementInput.current?.click()}>替换底图图片</button><button disabled={props.disabled || busy || dirty || !!props.adjustingId} onClick={() => props.onApply({ type: 'deleteBackground', id }, props.context)}>删除此底图</button></div>
      </>}
    </>}
    <p className="field-note">图片字节保存在本浏览器工程库。单 JSON 只包含 assets 索引与变换；请保留图片原件，跨设备重新关联时核对 SHA。显示、透明度、锁定和对照模式仅为工程显示设置。</p>
  </div>;
}
