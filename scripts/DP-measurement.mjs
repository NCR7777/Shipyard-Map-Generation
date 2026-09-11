/* global performance, window, CanvasRenderingContext2D, document, __DP_TIMING_ONLY__ */
import Konva from 'konva';

// Included only by the separate DP measurement build; normal production is untouched.
const timingOnly = typeof __DP_TIMING_ONLY__ !== 'undefined' && __DP_TIMING_ONLY__;
let counts = {}, timings = {}, commits = [], draws = [], inputs = [], cameraGenerations = [], effective = [];
const layerPhases = new Map();
let inputSequence = 0, latestInput = null, generation = 0, cameraKey = '', stateKey = '', lastNavigation = null, lastNavigationTime = null, lastNavigationEventTime = null, pendingDraw = null;
const keyOf = camera => [camera.scale, camera.offsetX, camera.offsetY].join(',');
const count = name => { if (!timingOnly) counts[name] = (counts[name] ?? 0) + 1; };
function timed(target, method, label) {
  if (timingOnly) return;
  const original = target[method]; if (typeof original !== 'function') return;
  target[method] = function (...args) {
    const start = performance.now(); count(label);
    try { return original.apply(this, args); }
    finally { timings[label] = (timings[label] ?? 0) + performance.now() - start; }
  };
}
for (const [target, method, label] of [
  [Konva.Stage.prototype, 'getIntersection', 'Konva.stageHitTest'],
  [Konva.Layer.prototype, 'getIntersection', 'Konva.layerHitTest'],
  [Konva.Text.prototype, '_setTextData', 'Konva.textLayout'],
  [CanvasRenderingContext2D.prototype, 'measureText', 'Canvas.measureText'],
]) timed(target, method, label);
// Attribute listener churn without treating all Konva objects as roads.
if (!timingOnly) for (const method of ['on', 'off']) {
  const original = Konva.Node.prototype[method];
  Konva.Node.prototype[method] = function (...args) {
    const category = ['road-band', 'road-centerline'].includes(this.attrs?.name) ? 'roads' : 'other';
    const label = 'Konva.listeners.' + category + '.' + method, start = performance.now(); count(label);
    try { return original.apply(this, args); }
    finally { timings[label] = (timings[label] ?? 0) + performance.now() - start; }
  };
}
for (const [method, phase] of [['drawScene', 'scene'], ['drawHit', 'hit']]) {
  const original = Konva.Layer.prototype[method];
  Konva.Layer.prototype[method] = function (...args) {
    const start = performance.now(), currentGeneration = generation; count('Konva.' + method);
    try { return original.apply(this, args); }
    finally {
      const end = performance.now(); timings['Konva.' + method] = (timings['Konva.' + method] ?? 0) + end - start;
      draws.push({ phase, generation: currentGeneration, layerId: this._id, start, end });
      if (phase === 'scene') layerPhases.set(this._id, currentGeneration);
      else if (pendingDraw?.generation === currentGeneration && layerPhases.get(this._id) === currentGeneration) {
        pendingDraw.remaining.delete(this._id);
        if (!pendingDraw.remaining.size) {
          const record = pendingDraw.record; record.allLayerDrawEnd = end;
          if (record.restore) {
            record.displayAtDrawEnd = { ...document.querySelector('[data-testid="display-state"]')?.dataset };
            record.renderedLabels = (this.getStage()?.find('.display-label') ?? []).filter(node => node.isVisible()).map(node => ({ key: node.getAttr('dpLabelKey'), text: node.text(), x: node.x(), y: node.y(), fontSize: node.fontSize() })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
            record.renderedLabelCount = record.renderedLabels.length;
            record.labelsMatch = JSON.stringify(record.expectedLabels) === JSON.stringify(record.renderedLabels);
            record.restoreReady = record.navigating === false && record.displayAtDrawEnd.navigating === 'false'
              && record.labelsMatch && Number(record.displayAtDrawEnd.labels) === record.renderedLabelCount && keyOf(record.camera) === cameraKey;
          }
          pendingDraw = null;
        }
      }
    }
  };
}
function input(event) {
  const inside = !!event.target?.closest?.('[data-testid="map-canvas"]');
  const valid = inside && (event.type === 'wheel' || event.type === 'pointermove' && (event.buttons & 4) !== 0);
  const end = inside && event.type === 'pointerup' && event.button === 1;
  const receivedAt = performance.now(), eventTimeStamp = event.timeStamp;
  const eventClockValid = Number.isFinite(eventTimeStamp) && eventTimeStamp >= 0 && eventTimeStamp <= receivedAt + 1;
  latestInput = { sequence: ++inputSequence, type: event.type, t: receivedAt, eventTimeStamp, eventClockValid, valid, end, buttons: event.buttons ?? 0 };
  if (valid || end) { lastNavigationTime = receivedAt; lastNavigationEventTime = eventClockValid ? eventTimeStamp : null; }
  inputs.push(latestInput);
}
for (const type of ['wheel', 'pointermove', 'pointerup']) window.addEventListener(type, input, { capture: true, passive: true });
function mounted() {
  const result = { stages: Konva.stages.length, total: 0, text: 0, listening: 0, visible: 0, byClass: {} };
  function visit(node) {
    const name = node.getClassName(); result.total++; result.byClass[name] = (result.byClass[name] ?? 0) + 1;
    if (name === 'Text') result.text++; if (node.isListening()) result.listening++; if (node.isVisible()) result.visible++;
    for (const child of node.getChildren?.() ?? []) visit(child);
  }
  Konva.stages.forEach(visit); return result;
}
function labelAudit() {
  const labels = Konva.stages.flatMap(stage => stage.find('.display-label')).filter(node => node.isVisible()).map(node => {
    const box = node.getClientRect({ skipStroke: true, skipShadow: true });
    return { key: node.getAttr('dpLabelKey'), text: node.text(), x: box.x, y: box.y, width: box.width, height: box.height, fontSize: node.fontSize() };
  });
  const collisions = []; let crossTypeCollisions = 0;
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j];
    const horizontalGap = Math.max(a.x - b.x - b.width, b.x - a.x - a.width);
    const verticalGap = Math.max(a.y - b.y - b.height, b.y - a.y - a.height);
    if (horizontalGap < 4 && verticalGap < 4) {
      const crossType = String(a.key).split('/')[0] !== String(b.key).split('/')[0];
      if (crossType) crossTypeCollisions++; collisions.push({ a: a.key, b: b.key, crossType });
    }
  }
  return { labels, count: labels.length, marginPx: 4, collisionCount: collisions.length, crossTypeCollisions, collisions, coverage: 'Current visible display-label Text boxes only; excludes static service/access badge glyphs and other viewports.' };
}
function associations() {
  const unique = [...new Map(effective.map(item => [item.sequence, item])).values()];
  return unique.map(item => {
    const completed = cameraGenerations.find(frame => frame.cameraChanged && frame.consumedThroughSequence >= item.sequence && frame.allLayerDrawEnd != null);
    const receiptLatencyMs = completed ? completed.allLayerDrawEnd - item.inputTime : null;
    const eventLatencyMs = completed && item.eventClockValid ? completed.allLayerDrawEnd - item.eventTimeStamp : null;
    return { sequence: item.sequence, inputTime: item.inputTime, eventTimeStamp: item.eventTimeStamp, eventClockValid: item.eventClockValid, generation: completed?.generation ?? null, latencyMs: eventLatencyMs, eventLatencyMs, receiptLatencyMs };
  });
}
globalThis.__DPMeasurement = {
  count,
  reset() { counts = {}; timings = {}; commits = []; draws = []; inputs = []; cameraGenerations = []; effective = []; latestInput = null; lastNavigationTime = null; lastNavigationEventTime = null; pendingDraw = null; layerPhases.clear(); },
  commit(id, phase, actualDuration, baseDuration, startTime, commitTime) { commits.push({ id, phase, actualDuration, baseDuration, startTime, commitTime }); },
  effectiveCamera(camera) {
    if (latestInput?.valid) effective.push({ cameraKey: keyOf(camera), sequence: latestInput.sequence, inputTime: latestInput.t, eventTimeStamp: latestInput.eventTimeStamp, eventClockValid: latestInput.eventClockValid, effectiveAt: performance.now() });
  },
  cameraCommit(camera, stage, frame = {}, expectedLabels) {
    if (!stage) return;
    const nextKey = keyOf(camera), nextState = [nextKey, frame?.navigating, frame?.epoch].join(',');
    if (nextState === stateKey) return;
    const cameraChanged = nextKey !== cameraKey;
    const consumed = cameraChanged ? effective.findLast(item => item.cameraKey === nextKey) : null;
    const record = { generation: ++generation, camera: { ...camera }, cameraChanged, navigating: frame?.navigating ?? null, epoch: frame?.epoch ?? null, committedAt: performance.now(), consumedThroughSequence: consumed?.sequence ?? null, restore: lastNavigation === true && frame?.navigating === false, lastNavigationInputTime: lastNavigationTime, lastNavigationEventTime };
    record.expectedLabels = expectedLabels?.map(label => ({ key: label.key, text: String(label.text ?? ''), x: label.x ?? 0, y: label.y ?? 0, fontSize: label.fontSize ?? 12 })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
    stateKey = nextState; cameraKey = nextKey; lastNavigation = frame?.navigating ?? null; cameraGenerations.push(record);
    const layers = stage.getLayers().filter(layer => layer.isVisible() && layer._waitingForDraw);
    record.pendingLayerIds = layers.map(layer => layer._id);
    pendingDraw = { generation, record, remaining: new Set(record.pendingLayerIds) };
    if (!layers.length) { record.noLayerDrawScheduled = true; pendingDraw = null; }
  },
  snapshot() {
    const inputLatencies = associations();
    const restores = cameraGenerations.filter(frame => frame.restore).map(frame => ({ generation: frame.generation, latencyMs: frame.restoreReady && frame.allLayerDrawEnd != null && frame.lastNavigationEventTime != null ? frame.allLayerDrawEnd - frame.lastNavigationEventTime : null, receiptLatencyMs: frame.restoreReady && frame.allLayerDrawEnd != null && frame.lastNavigationInputTime != null ? frame.allLayerDrawEnd - frame.lastNavigationInputTime : null, noLayerDrawScheduled: frame.noLayerDrawScheduled ?? false, restoreReady: frame.restoreReady ?? false, displayAtDrawEnd: frame.displayAtDrawEnd, renderedLabelCount: frame.renderedLabelCount, labelsMatch: frame.labelsMatch }));
    return { timeOrigin: performance.timeOrigin, inputLatencyBasis: 'event.timeStamp after finite monotonic-range validation; receipt latency retained separately', mode: timingOnly ? 'lightweight_draw_timing' : 'profiling', counts, timings, commits, draws, inputs, effective, inputLatencies, restores, cameraGenerations, labelAudit: labelAudit(), mounted: mounted(), display: { ...document.querySelector('[data-testid="display-state"]')?.dataset }, limitations: [timingOnly ? 'Lightweight draw probe differs from normal production; no React profiling or CPU sampling.' : 'Profiling build timings differ from normal production.', 'Nested method timers and Profiler trees overlap.', 'Completion requires drawScene and drawHit for all layers scheduled at committed camera state.', 'Every effective native navigation input maps to the first completed camera generation containing its sequence; merged earlier inputs retain their waiting time.', 'Unreceived native events and uncompleted generations are not assigned zero latency.', 'Same-camera navigation-start/settle commits do not consume an input twice.', 'event.timeStamp must be finite, nonnegative, and no later than performance.now receipt +1 ms; invalid event-clock latency stays null.', 'Restore additionally requires current camera, navigating=false, and actual display-label ID/text/x/y/fontSize set equal to the layout expectation and restored DOM label count after all scheduled scene/hit draws.', 'No physical display presentation or GPU memory is inferred.'] };
  },
};
