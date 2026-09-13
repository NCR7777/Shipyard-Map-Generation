import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useBackgroundAssets } from '../../src/ui/useBackgroundAssets';
import { rasterBytes } from '../../src/adapters/rasterFiles';
import type { RasterAssetBytes, RasterAssetStorePort } from '../../src/editor/projectController';
import type { YardMap } from '../../src/domain/model';

/** Browser adapter test harness; imports through Vite keep one React instance. */
export async function exerciseBackgroundHook(bytes: number[], mode: 'load' | 'persist') {
  const asset = await rasterBytes(Uint8Array.from(bytes).buffer), div = document.createElement('div'); document.body.append(div);
  let setProject!: (project: string) => void, rerender!: () => void, hook!: ReturnType<typeof useBackgroundAssets>, finish!: () => void;
  let gets = 0, started = false, created = 0, revoked = 0;
  const pending = new Map<string, (value: RasterAssetBytes | null) => void>();
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { created++; return create(blob); }; URL.revokeObjectURL = url => { revoked++; revoke(url); };
  const store: RasterAssetStorePort = {
    getAssetBytes: project => { gets++; return new Promise(resolve => pending.set(project, resolve)); },
    putAssetBytes: () => { started = true; return new Promise<void>(resolve => { finish = resolve; }); },
  };
  const assets: YardMap['assets'] = { image: { sha256: asset.sha256, mediaType: asset.mimeType, widthPx: 3, heightPx: 2, path: 'assets/test.png', sourceRef: 'test' } };
  function Harness() {
    const [project, update] = useState('A'), [, tick] = useState(0);
    setProject = update; rerender = () => tick(value => value + 1);
    const layers: YardMap['backgroundLayers'] = mode === 'persist' ? {} : { [project]: { assetId: 'image', name: 'test', pixelConvention: 'top_left_x_right_y_down_exif_normalized', method: 'manual', imageToWorld: [1, 0, 0, -1, 0, 0], controlPoints: [], provenance: { category: 'synthetic', sourceRefs: [] } } };
    hook = useBackgroundAssets({ projectId: project, assets: { ...assets }, layers, store });
    return createElement('span', null, JSON.stringify(hook.items.map(item => [item.id, item.status])));
  }
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 150 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); if (!predicate()) throw new Error('background hook test timed out'); };
  const root = createRoot(div); let unmounted = false; root.render(createElement(Harness));
  try {
    await wait(() => !!hook); await new Promise(resolve => setTimeout(resolve, 20));
    if (mode === 'persist') {
      const operation = hook.persistFile(new File([Uint8Array.from(bytes)], 'local.png'), 'A').then(() => 'unexpected success', error => error.code);
      await wait(() => started); setProject('B'); await new Promise(resolve => setTimeout(resolve, 20)); finish();
      const code = await operation; root.unmount(); unmounted = true; return { code, created, revoked };
    }
    await wait(() => pending.has('A')); setProject('B'); await wait(() => pending.has('B'));
    pending.get('B')!(asset); await wait(() => hook.items[0]?.id === 'B' && hook.items[0]?.status === 'ready');
    pending.get('A')!(asset); await new Promise(resolve => setTimeout(resolve, 30));
    const afterLate = hook.items.map(item => [item.id, item.status]), beforeRender = { gets, created };
    rerender(); await new Promise(resolve => setTimeout(resolve, 30));
    const afterRender = { gets, created }; root.unmount(); unmounted = true;
    return { afterLate, beforeRender, afterRender, created, revoked };
  } finally { if (!unmounted) root.unmount(); div.remove(); URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
}
