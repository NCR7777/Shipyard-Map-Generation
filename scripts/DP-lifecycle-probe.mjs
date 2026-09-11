/* global window, document, EventTarget */
// Serialized by Playwright only for the isolated stress run. No product import.
export function installLifecycleProbe() {
  const raf = window.requestAnimationFrame.bind(window), cancelRaf = window.cancelAnimationFrame.bind(window);
  const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
  const pendingRaf = new Set(), pendingTimeout = new Set();
  let stringTimeouts = 0;
  window.requestAnimationFrame = callback => {
    if (typeof callback !== 'function') return raf(callback);
    const id = raf(function (time) { pendingRaf.delete(id); return callback.call(this, time); });
    pendingRaf.add(id); return id;
  };
  window.cancelAnimationFrame = id => { pendingRaf.delete(id); return cancelRaf(id); };
  window.setTimeout = (callback, delay, ...args) => {
    if (typeof callback !== 'function') { stringTimeouts++; return timeout(callback, delay, ...args); }
    const id = timeout(function (...values) { pendingTimeout.delete(id); return callback.apply(this, values); }, delay, ...args);
    pendingTimeout.add(id); return id;
  };
  window.clearTimeout = id => { pendingTimeout.delete(id); return clear(id); };
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const records = new WeakMap(), activeByType = {};
  const targetName = target => target === window ? 'window' : target === document ? 'document' : target === document.fonts ? 'fonts' : null;
  const captureOf = options => typeof options === 'boolean' ? options : !!options?.capture;
  const decrement = record => {
    if (!record.active) return;
    record.active = false; activeByType[record.key]--;
    if (record.signal && record.abort) remove.call(record.signal, 'abort', record.abort);
  };
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    const target = targetName(this);
    if (!target || !callback || !['function', 'object'].includes(typeof callback)) return add.call(this, type, callback, options);
    const key = target + ':' + String(type) + ':' + captureOf(options);
    let callbacks = records.get(callback); if (!callbacks) { callbacks = new Map(); records.set(callback, callbacks); }
    let record = callbacks.get(key);
    if (!record?.active) {
      const once = typeof options === 'object' && !!options?.once;
      record = { key, active: false, signal: typeof options === 'object' ? options?.signal : null };
      record.wrapper = function (event) {
        if (once) decrement(record);
        return typeof callback === 'function' ? callback.call(this, event) : callback.handleEvent.call(callback, event);
      };
      callbacks.set(key, record);
    }
    const result = add.call(this, type, record.wrapper, options);
    if (!record.active && !record.signal?.aborted) {
      record.active = true; activeByType[key] = (activeByType[key] ?? 0) + 1;
      if (record.signal) { record.abort = () => decrement(record); add.call(record.signal, 'abort', record.abort, { once: true }); }
    }
    return result;
  };
  EventTarget.prototype.removeEventListener = function (type, callback, options) {
    const target = targetName(this), key = target + ':' + String(type) + ':' + captureOf(options);
    const record = target && callback && ['function', 'object'].includes(typeof callback) ? records.get(callback)?.get(key) : null;
    if (!record) return remove.call(this, type, callback, options);
    const result = remove.call(this, type, record.wrapper, options); decrement(record); return result;
  };
  window.__DPLifecycle = {
    snapshot: () => ({ raf: pendingRaf.size, timeout: pendingTimeout.size, stringTimeoutRegistrations: stringTimeouts,
      listeners: Object.fromEntries(Object.entries(activeByType).filter(([, value]) => value)), listenerCount: Object.values(activeByType).reduce((a, b) => a + b, 0),
      coverage: 'window/document/document.fonts listeners only; all RAF and function timeouts in this window; no intervals/workers/element listeners; WeakMap listener identities; probe does not retain arbitrary DOM targets' }),
  };
}
