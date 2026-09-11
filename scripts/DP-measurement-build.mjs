import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, 'timing-only': { type: 'boolean', default: false } } });
if (!values.source || !values.output) throw new Error('--source and --output are required');
const timingOnly = values['timing-only'];
const editor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(values.source), outDir = path.resolve(values.output);
if (fs.existsSync(outDir)) throw new Error('Refusing to overwrite a measurement build');
const injected = [], runtime = path.join(editor, 'scripts/DP-measurement.mjs').replaceAll('\\', '/');
const targets = new Set(['selectionImpact', 'App', 'MapCanvas', 'ObjectDirectory', 'ObjectInspector', 'SpatialLayer', 'AssociatedPointLayer', 'DeclaredLayer', 'worldToScreen', 'screenToWorld', 'snapPosition', 'toSceneSnapshot', 'contentHash', 'serializeMap', 'validateMap', 'loadMap', 'diagnoseMap', 'previewPath', 'createDisplayIndex', 'selectDisplay', 'layoutLabels', 'createTextMeasurer', 'inspectPlanning', 'mapCapabilities', 'readPlanning', 'readStaticPlanning', 'readStaticContents', 'persist', 'persistEditor', 'saveEditorState', 'writeEditorState']);
const plugin = {
  name: 'dp-isolated-measurement', enforce: 'pre',
  transform(source, id) {
    const clean = id.split('?')[0].replaceAll('\\', '/'); if (!clean.startsWith(root.replaceAll('\\', '/') + '/src') || !/\.[cm]?[jt]sx?$/.test(clean)) return null;
    let code = source;
    if (clean.endsWith('/src/main.tsx')) {
      code = `import ${JSON.stringify(runtime)};\n` + (timingOnly ? code : code.replace('<App />', '<React.Profiler id="DOMApp" onRender={globalThis.__DPMeasurement.commit}><App /></React.Profiler>'));
    }
    if (clean.endsWith('/ui/App.tsx')) code = code.replace('onCamera={setCamera}', 'onCamera={camera => { globalThis.__DPMeasurement.effectiveCamera(camera); setCamera(camera); }}');
    if (clean.endsWith('/ui/useFrameCamera.ts')) code = code.replace('this.effective = next;', 'this.effective = next; globalThis.__DPMeasurement.effectiveCamera(next);');
    if (clean.endsWith('/2d/MapCanvas.tsx')) {
      const hasLabels = code.includes('const labels = layoutLabels(');
      code = code.replace('name="display-label" {...label}', 'name="display-label" dpLabelKey={key} {...label}');
      if (hasLabels && !code.includes('dpLabelKey={key}')) throw new Error('Measurement label identity injection no longer matches source');
      code = "import { Profiler as DPProfiler, useLayoutEffect as DPLayoutEffect } from 'react';\n" + code;
      code = code.replace('const stage = useRef<KonvaStage>(null);', 'const stage = useRef<KonvaStage>(null);\n  DPLayoutEffect(() => globalThis.__DPMeasurement.cameraCommit(props.camera, stage.current, props.frameCamera, EXPECTED_LABELS), [props.camera, props.frameCamera?.navigating, props.frameCamera?.epoch]);');
      code = code.replace('EXPECTED_LABELS', hasLabels ? 'labels.labels' : 'undefined');
      if (!timingOnly) code = code.replace('      <Layer listening={false}>', '      <DPProfiler id="KonvaLayers" onRender={globalThis.__DPMeasurement.commit}>\n      <Layer listening={false}>');
      if (!timingOnly) code = code.replace('</Stage>', '</DPProfiler></Stage>');
    }
    const file = ts.createSourceFile(clean, code, ts.ScriptTarget.Latest, true, clean.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS), edits = [];
    function walk(node) {
      if (!timingOnly && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.body && node.name && targets.has(node.name.getText(file))) {
        const name = node.name.getText(file), label = path.relative(root, clean).replaceAll('\\', '/') + ':' + name;
        edits.push({ position: node.body.getStart(file) + 1, text: `globalThis.__DPMeasurement.count(${JSON.stringify(label)});` }); injected.push(label);
      }
      ts.forEachChild(node, walk);
    }
    walk(file);
    for (const edit of edits.sort((a, b) => b.position - a.position)) code = code.slice(0, edit.position) + edit.text + code.slice(edit.position);
    return { code, map: null };
  },
};
await build({ root, configFile: false, plugins: [plugin, react()], define: { __DP_TIMING_ONLY__: JSON.stringify(timingOnly) }, resolve: { alias: timingOnly ? [] : [
  { find: /^react-dom\/client$/, replacement: path.join(editor, 'node_modules/react-dom/profiling.js') },
  { find: /^react-reconciler$/, replacement: path.join(editor, 'node_modules/react-reconciler/cjs/react-reconciler.profiling.js') },
] }, build: { outDir, emptyOutDir: false, target: 'es2022', sourcemap: true, minify: timingOnly ? 'oxc' : false } });
fs.writeFileSync(path.join(outDir, 'measurement-build.json'), JSON.stringify({ kind: timingOnly ? 'LIGHTWEIGHT_DRAW_TIMING_BUILD' : 'ISOLATED_PROFILE_BUILD_NOT_NORMAL_PRODUCTION', source: root, output: outDir, tools: Object.fromEntries([['builder', fileURLToPath(import.meta.url)], ['runtime', runtime]].map(([name, file]) => [name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])), injected, reactDOM: timingOnly ? 'normal' : 'react-dom/profiling', konvaReconciler: timingOnly ? 'normal' : 'react-reconciler.profiling', minified: timingOnly, sourcemaps: true }, null, 2));
console.log(JSON.stringify({ source: root, outDir, injectedFunctions: injected.length }));
