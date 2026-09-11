import fs from 'node:fs';
import path from 'node:path';
import { SourceMap } from 'node:module';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { evidence: { type: 'string' }, dist: { type: 'string' }, output: { type: 'string' } } });
if (!values.evidence || !values.dist) throw new Error('--evidence and --dist are required');
const root = path.resolve(values.evidence), dist = path.resolve(values.dist), output = values.output ? path.resolve(values.output) : path.join(root, 'profile-summary.json');
if (fs.existsSync(output)) throw new Error('Refusing to overwrite profile summary');
const maps = new Map();
for (const file of fs.readdirSync(path.join(dist, 'assets')).filter(name => name.endsWith('.js.map'))) maps.set(file.replace(/\.map$/, ''), new SourceMap(JSON.parse(fs.readFileSync(path.join(dist, 'assets', file)))));
const q = (list, p) => list.slice().sort((a, b) => a - b)[Math.floor((list.length - 1) * p)] ?? null;
const results = [];
for (const file of fs.readdirSync(root).filter(name => name.endsWith('.cpuprofile'))) {
  const data = JSON.parse(fs.readFileSync(path.join(root, file))), parents = new Map(), self = new Map(), inclusive = new Map();
  for (const node of data.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  for (let i = 0; i < data.samples.length; i++) {
    const id = data.samples[i], ms = (data.timeDeltas[i] ?? 0) / 1000; self.set(id, (self.get(id) ?? 0) + ms);
    for (let ancestor = id; ancestor !== undefined; ancestor = parents.get(ancestor)) inclusive.set(ancestor, (inclusive.get(ancestor) ?? 0) + ms);
  }
  const frames = data.nodes.map(node => {
    const frame = node.callFrame, sourceMap = maps.get(frame.url.split('/').at(-1));
    const original = sourceMap?.findEntry(frame.lineNumber, frame.columnNumber);
    return { name: frame.functionName || '(anonymous)', source: original?.originalSource ?? frame.url, line: original?.originalLine == null ? frame.lineNumber + 1 : original.originalLine + 1, selfMs: self.get(node.id) ?? 0, inclusiveMs: inclusive.get(node.id) ?? 0 };
  });
  function category(frame) {
    if (frame.name === '(idle)') return 'idle'; if (frame.name === '(garbage collector)') return 'garbage_collection';
    const source = frame.source;
    if (source.includes('react-dom')) return 'ReactDOM'; if (source.includes('react-reconciler')) return 'Konva_reconciler';
    if (source.includes('/react-konva/')) return 'react_konva_host_updates';
    if (source.includes('/konva/')) return 'Konva'; if (source.includes('/geometry/')) return 'geometry';
    if (source.includes('/ui/ObjectDirectory')) return 'object_directory'; if (source.includes('/ui/')) return 'other_UI';
    if (source.includes('/renderers/')) return 'renderer_projection_and_JSX'; if (source.includes('/domain/') || source.includes('/compiler/') || source.includes('/validation/')) return 'domain_derived';
    if (source.includes('DP-measurement')) return 'measurement_overhead'; return 'other_or_native';
  }
  const categories = {}; for (const frame of frames) categories[category(frame)] = (categories[category(frame)] ?? 0) + frame.selfMs;
  const sampleFile = path.join(root, file.replace(/\.cpuprofile$/, '.json')), sample = fs.existsSync(sampleFile) ? JSON.parse(fs.readFileSync(sampleFile)) : null, measure = sample?.instrumentation;
  const profiler = {};
  for (const commit of measure?.commits ?? []) {
    const item = profiler[commit.id] ??= { commits: 0, actualDuration: 0, baseDuration: 0 }; item.commits++; item.actualDuration += commit.actualDuration; item.baseDuration += commit.baseDuration;
  }
  const complete = (measure?.cameraGenerations ?? []).filter(item => item.allLayerDrawEnd != null), latencies = (measure?.inputLatencies ?? []).map(item => item.latencyMs).filter(Number.isFinite);
  results.push({ file, categories, topSelf: frames.slice().sort((a, b) => b.selfMs - a.selfMs).slice(0, 30), topInclusive: frames.filter(frame => !['(root)', '(idle)'].includes(frame.name)).sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 25), counts: measure?.counts, methodTimes: measure?.timings, profiler, mounted: measure?.mounted, inputCoverage: { validNative: (measure?.inputs ?? []).filter(item => item.valid).length, effectiveUnique: new Set((measure?.effective ?? []).map(item => item.sequence)).size, completed: latencies.length, uncompleted: (measure?.inputLatencies ?? []).filter(item => item.latencyMs == null).length }, inputLatencyBasis: measure?.inputLatencyBasis ?? 'legacy_receipt_timestamp', receiptLatencyP95: q((measure?.inputLatencies ?? []).map(item => item.receiptLatencyMs).filter(Number.isFinite), .95), drawGenerations: { total: measure?.cameraGenerations.length ?? 0, completed: complete.length, p50: q(latencies, .5), p95: q(latencies, .95) }, maxRafGapMs: sample?.raw?.frames.length ? Math.max(...sample.raw.frames) : null });
}
fs.writeFileSync(output, JSON.stringify({ results, limitations: ['CPU sampling attribution is approximate.', 'Inclusive times and nested timers overlap; use self categories for additive attribution.', 'Profiling build timings are not normal production acceptance timings.', 'Missing draw generation completion is reported, never filled by a timer.'] }, null, 2));
console.log(JSON.stringify({ output, profiles: results.length }));
