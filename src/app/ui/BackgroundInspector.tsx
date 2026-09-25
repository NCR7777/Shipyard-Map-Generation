import { useEffect, useRef, type ReactNode } from 'react';
import { inspectBackground } from '../../domain/backgrounds';
import type { YardMap } from '../../domain/model';
import type { NumericField } from '../canvas/backgroundAdjust';
import { bridge } from '../ops/registry';
import {
  applyMeasure, cancelMeasure, deleteBackground, setField, setKeepAspect, startAdjust, startMeasure, stopAdjust, transformFields,
} from '../state/backgroundEdit';
import { useApp } from '../state/store';
import { Icon } from './icons';
import { placementText } from './labels';
import { CommitText } from './PropertyFields';

const MEDIA: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' };
const RASTER: Record<string, string> = { loading: '载入中', ready: '已载入', missing: '本浏览器还没有这张图片', error: '图片读取失败' };
const decimals = (value: number, digits: number) => Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '—';
const significant = (value: number) => Number.isFinite(value) ? String(Number(value.toPrecision(6))) : '—';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><dt>{label}</dt><dd>{children}</dd></div>;
}

/** A background layer in the inspector: what it is and where it lies. Its numbers can be typed only while it is being adjusted,
 *  the same mode in which the canvas lets it move, so a stray keystroke or drag never shifts a traced image. */
export function BackgroundProperties({ map, id }: { map: YardMap; id: string }) {
  const adjusting = useApp(state => state.adjusting), rasters = useApp(state => state.rasters);
  const layer = map.backgroundLayers[id]!, asset = map.assets[layer.assetId], support = inspectBackground(map, id);
  const active = adjusting?.id === id;
  const rows: ReactNode[] = [];
  if (asset) rows.push(<Row key="image" label="图片"><span className="num">{asset.widthPx ?? '?'}×{asset.heightPx ?? '?'}</span> 像素 · {MEDIA[asset.mediaType] ?? asset.mediaType} · SHA-256 <span className="num">{asset.sha256.slice(0, 12)}…</span></Row>);
  if (!support.supported) return <dl className="fields">{rows}<Row label="状态"><span className="muted">不受支持，完整保留但不能调整：{support.reasons.join(' ')}</span></Row></dl>;
  const raster = rasters[asset!.sha256];
  rows.push(<Row key="raster" label="图片状态">{RASTER[raster?.status ?? 'missing']}</Row>,
    <Row key="placement" label="放置">{placementText(layer.method, layer.controlPoints.length)}
      {active && layer.method !== 'manual' && <p className="muted">调整后记为手动放置；校准文件的依据仍保留在来源记录中。</p>}</Row>);
  const values = transformFields(layer.imageToWorld, asset!.widthPx!, asset!.heightPx!);
  const number = (field: NumericField, label: string, shown: string, suffix: string) => active
    ? <CommitText key={field} label={label} numeric suffix={suffix} value={shown} onCommit={text => setField(field, text)} />
    : <span key={field} className="num">{shown} {suffix}</span>;
  rows.push(
    <Row key="corner" label="左上角（X / Y）"><span className="prop-coords">{number('x', '左上角 X', decimals(values.x, 3), 'm')}{number('y', '左上角 Y', decimals(values.y, 3), 'm')}</span></Row>,
    <Row key="size" label="宽 × 高"><span className="prop-coords">{number('width', '底图宽度', decimals(values.width, 3), 'm')}{number('height', '底图高度', decimals(values.height, 3), 'm')}</span>
      {active && <label className="check"><input type="checkbox" checked={adjusting!.keepAspect} onChange={event => setKeepAspect(event.target.checked)} />保持宽高比</label>}</Row>,
    <Row key="angle" label="角度（逆时针）">{number('angle', '底图角度', decimals(values.angle, 3), '°')}</Row>,
    <Row key="resolution" label="比例">{number('resolution', '米每像素', significant(values.resolution), 'm/像素')}
      {Math.abs(values.resolutionY - values.resolution) > 1e-9 * values.resolution && <p className="muted">纵向 {significant(values.resolutionY)} m/像素（宽高比已改变）</p>}</Row>);
  return <>
    <dl className="fields">{rows}</dl>
    {active ? <AdjustTools measure={adjusting!.measure} /> : <p className="muted">底图平时锁定：画布上点不中、拖不动。要移动、缩放或定比例，先进入调整。</p>}
    <div className="dialog-actions inspector-actions">
      {active ? <button className="button primary" onClick={stopAdjust}>完成调整</button>
        : <button className="button primary" onClick={() => startAdjust(id)}><Icon name="transform" size={16} />调整位置与比例</button>}
      <button className="button" onClick={() => bridge.pickBackground(id)}><Icon name="replace" size={16} />替换图片…</button>
      <button className="button danger" onClick={() => deleteBackground(id)}><Icon name="trash" size={16} />删除底图</button>
    </div>
  </>;
}

/** While adjusting: how the canvas handles work, and setting the scale from a length known on the ground. */
function AdjustTools({ measure }: { measure: readonly unknown[] | null }) {
  const region = useRef<HTMLDivElement>(null), picked = measure?.length ?? 0;
  // The second point is picked on the canvas, which takes the focus on that press: the length field takes it afterwards.
  useEffect(() => {
    if (picked !== 2) return;
    const timer = window.setTimeout(() => region.current?.querySelector<HTMLInputElement>('input[aria-label="实际长度"]')?.focus());
    return () => window.clearTimeout(timer);
  }, [picked]);
  return <div className="adjust-tools" role="region" aria-label="底图调整" ref={region}>
    <p className="muted">拖动图片移动；拖四角缩放（Shift 临时切换是否保持宽高比）；拖顶部圆柄旋转（Shift 按 15°）。方向键微调 0.1 m，Shift 1 m。Esc 或「完成调整」结束。</p>
    {!measure ? <>
      <button className="button" onClick={startMeasure}><Icon name="measure" size={16} />量距定比例</button>
      <p className="muted">在图上点一段已知实际长度的两端（如船坞长度、比例尺），输入实际长度；第一点不动，整图等比缩放。</p>
    </> : <div className="measure-step">
      <p role="status">{measure.length === 0 ? '在底图上点第一个点。' : measure.length === 1 ? '再点第二个点。' : '输入两点间的实际长度；再点图上可重新选点。'}</p>
      {measure.length === 2 && <label className="dialog-field">两点间的实际长度
        <CommitText label="实际长度" numeric suffix="m" value="" placeholder="输入米数，Enter 应用" onCommit={applyMeasure} onEscape={cancelMeasure} /></label>}
      <button className="link" onClick={cancelMeasure}>取消量距（Esc）</button>
    </div>}
  </div>;
}
