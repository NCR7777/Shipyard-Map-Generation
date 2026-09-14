import { describe, expect, it } from 'vitest';
import { LocalFileController, type FilePickerPort, type LocalFileBinding, type LocalFileData, type LocalFileHandle, type LocalWritable } from '../../src/adapters/localFiles';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { roadLength } from '../../src/geometry/roads';
import { editorFixture } from '../helpers/M1_fixtures';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
/** Test doubles only: these exercise adapter decisions, never native file permissions or actual disk writes. */
class FakeHandle implements LocalFileHandle {
  bytes: Uint8Array;
  created = 0;
  aborted = 0;
  written: string[] = [];
  reads = 0;
  failAt: 'create' | 'write' | 'close' | null = null;
  closeGate: Promise<void> | null = null;
  beforeRead?: (read: number) => void;
  permission: 'granted' | 'denied' | 'prompt' = 'granted';
  permissionRequests: string[] = [];
  permissionQueries: string[] = [];
  async queryPermission(descriptor: { mode: 'read' | 'readwrite' }) { this.permissionQueries.push(descriptor.mode); return this.permission; }
  async requestPermission(descriptor: { mode: 'read' | 'readwrite' }) { this.permissionRequests.push(descriptor.mode); return this.permission; }
  constructor(public name: string, text = '') { this.bytes = new TextEncoder().encode(text); }
  text(): string { return new TextDecoder().decode(this.bytes); }
  external(text: string): void { this.bytes = new TextEncoder().encode(text); }
  async getFile(): Promise<LocalFileData> {
    this.beforeRead?.(++this.reads);
    const bytes = new Uint8Array(this.bytes);
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  }
  async isSameEntry(other: LocalFileHandle): Promise<boolean> { return this === other; }
  async createWritable(): Promise<LocalWritable> {
    this.created++;
    if (this.failAt === 'create') throw new DOMException('denied', 'NotAllowedError');
    let staging = '';
    return {
      write: async (text) => {
        if (this.failAt === 'write') throw new Error('fake write failure');
        staging = text; this.written.push(text);
      },
      close: async () => {
        if (this.closeGate) await this.closeGate;
        if (this.failAt === 'close') throw new Error('fake close failure');
        this.external(staging);
      },
      abort: async () => { this.aborted++; },
    };
  }
}
async function linked(handle = new FakeHandle('original.map.json', serializeMap(editorFixture())), extra: FilePickerPort = {}) {
  const controller = new LocalFileController({ showOpenFilePicker: async () => [handle], ...extra });
  const candidate = await controller.open();
  if (candidate.status !== 'opened') throw new Error('fixture should open');
  expect(controller.acceptOpen(candidate.token).status).toBe('linked');
  return { controller, handle };
}

describe('M1.1 native file adapter contract (mock handles, not native permission acceptance)', () => {
  it('detects optional capabilities without denying browser-only operation', async () => {
    const controller = new LocalFileController({});
    expect(controller.capabilities()).toEqual({ open: false, saveAs: false });
    expect((await controller.open()).status).toBe('unsupported');
    expect((await controller.saveAs(editorFixture())).status).toBe('unsupported');
    expect((await controller.write(editorFixture())).status).toBe('unlinked');
    expect(controller.snapshot().confirmedContentHash).toBeNull();
  });

  it('prepares through shared loadMap and associates only after candidate acceptance', async () => {
    const handle = new FakeHandle('A.json', serializeMap(editorFixture()));
    const controller = new LocalFileController({ showOpenFilePicker: async () => [handle] });
    const candidate = await controller.open();
    expect(candidate.status).toBe('opened');
    expect(controller.snapshot().linkedName).toBeNull();
    if (candidate.status !== 'opened') throw new Error('expected candidate');
    expect(roadLength(candidate.loaded.map, 'rAB')).toBe(100);
    expect(controller.acceptOpen(candidate.token).status).toBe('linked');
    expect(controller.snapshot().confirmedContentHash).toBe(contentHash(editorFixture()));
    expect(handle.created).toBe(0);
  });

  it('invalidates cancelled and project-reset candidates without changing map JSON', async () => {
    const original = editorFixture(); const before = serializeMap(original);
    const handle = new FakeHandle('A.json', before);
    const controller = new LocalFileController({ showOpenFilePicker: async () => [handle] });
    const candidate = await controller.open();
    if (candidate.status !== 'opened') throw new Error('expected candidate');
    controller.cancelOpen(candidate.token);
    expect(controller.acceptOpen(candidate.token).status).toBe('stale');
    const next = await controller.open();
    if (next.status !== 'opened') throw new Error('expected candidate');
    expect(controller.reset()).toBe(true);
    expect(controller.acceptOpen(next.token).status).toBe('stale');
    expect(serializeMap(original)).toBe(before);
  });

  it.each(['AbortError', 'NotAllowedError'])('preserves association when picker returns %s', async (name) => {
    const handle = new FakeHandle('A.json', serializeMap(editorFixture()));
    let refuse = false;
    const { controller } = await linked(handle, { showOpenFilePicker: async () => { if (refuse) throw new DOMException('test', name); return [handle]; } });
    const before = controller.snapshot(); refuse = true;
    expect((await controller.open()).status).toBe(name === 'AbortError' ? 'cancelled' : 'failure');
    expect(controller.snapshot()).toEqual(before);
    expect(handle.created).toBe(0);
  });

  it('rejects a dangling reference candidate with the same structured error as ordinary import', async () => {
    const { controller, handle } = await linked(); const before = controller.snapshot();
    const invalid = editorFixture(); invalid.roads.rAB!.toNodeId = 'missing';
    handle.external(JSON.stringify(invalid));
    const result = await controller.readCurrent();
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') throw new Error('expected failure');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'DANGLING_REFERENCE', jsonPath: '/roads/rAB/toNodeId' }));
    expect(controller.snapshot().confirmedContentHash).toBe(before.confirmedContentHash);
    expect(controller.snapshot().conflict).toBe(true);
  });

  it('detects external 100m to 120m edits even when revision is unchanged, then reloads via the common compiler', async () => {
    const { controller, handle } = await linked(); const before = controller.snapshot();
    const outside = editorFixture(); outside.nodes.nB!.position[0] = 120;
    handle.external(serializeMap(outside));
    const check = await controller.check();
    expect(check.status).toBe('conflict');
    if (check.status !== 'conflict') throw new Error('expected conflict');
    expect(check.loaded?.ok).toBe(true);
    expect(check.rawHash).not.toBe(before.confirmedRawHash);
    expect((await controller.write(editorFixture())).status).toBe('conflict');
    expect(handle.created).toBe(0);
    const reload = await controller.readCurrent();
    if (reload.status !== 'opened') throw new Error('expected candidate');
    expect(reload.loaded.map.revision).toBe(editorFixture().revision);
    expect(roadLength(reload.loaded.map, 'rAB')).toBe(120);
    expect(reload.loaded.scene.mapContentHash).toBe(contentHash(outside));
    expect(controller.snapshot().confirmedContentHash).toBe(before.confirmedContentHash);
    controller.acceptOpen(reload.token);
    expect(controller.snapshot().confirmedContentHash).toBe(contentHash(outside));
  });

  it('treats whitespace-only disk edits as observed changes even with equal semantic hashes', async () => {
    const { controller, handle } = await linked();
    handle.external(JSON.stringify(editorFixture()));
    const check = await controller.check();
    expect(check.status).toBe('conflict');
    if (check.status !== 'conflict' || !check.loaded?.ok) throw new Error('expected valid conflict');
    expect(check.loaded.contentHash).toBe(controller.snapshot().confirmedContentHash);
    expect((await controller.write(editorFixture())).status).toBe('conflict');
    expect(handle.created).toBe(0);
  });

  it('requires the latest conflict token and rechecks the disk before explicit overwrite', async () => {
    const { controller, handle } = await linked();
    const outside = editorFixture(); outside.nodes.nB!.position[0] = 120; handle.external(serializeMap(outside));
    const first = await controller.check(); const repeated = await controller.check();
    if (first.status !== 'conflict' || repeated.status !== 'conflict') throw new Error('expected conflict');
    expect(repeated.token).toBe(first.token);
    outside.nodes.nB!.position[0] = 130; handle.external(serializeMap(outside));
    const refused = await controller.write(editorFixture(), first.token);
    expect(refused.status).toBe('conflict');
    if (refused.status !== 'conflict') throw new Error('expected fresh conflict');
    expect(refused.token).not.toBe(first.token);
    expect((await controller.write(editorFixture(), first.token)).status).toBe('stale');
    expect(handle.created).toBe(0);
    expect((await controller.write(editorFixture(), refused.token)).status).toBe('saved');
    expect(handle.text()).toBe(serializeMap(editorFixture()));
  });

  it.each(['{ invalid json', '\ufffd'])('refuses to overwrite invalid external contents even after conflict confirmation: %s', async (invalid) => {
    const { controller, handle } = await linked();
    if (invalid === '\ufffd') handle.bytes = new Uint8Array([0xc3, 0x28]);
    else handle.external(invalid);
    const before = Array.from(handle.bytes);
    const conflict = await controller.check();
    if (conflict.status !== 'conflict') throw new Error('expected conflict');
    expect((await controller.write(editorFixture(), conflict.token)).status).toBe('failure');
    expect(Array.from(handle.bytes)).toEqual(before);
    expect(handle.created).toBe(0);
  });

  it('advances only the captured file baseline after close, refuses switching while busy, and leaves newer edits dirty', async () => {
    const { controller, handle } = await linked(); const baseline = controller.snapshot();
    const gate = deferred(); handle.closeGate = gate.promise;
    const map = editorFixture(); map.nodes.nB!.position[0] = 120;
    const expectedHash = contentHash(map); const saving = controller.write(map);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle.written).toHaveLength(1);
    expect(controller.snapshot().confirmedContentHash).toBe(baseline.confirmedContentHash);
    expect(controller.reset()).toBe(false);
    expect((await controller.open()).status).toBe('busy');
    map.nodes.nB!.position[0] = 140;
    gate.resolve(); const result = await saving;
    expect(result.status).toBe('saved');
    expect(controller.snapshot().confirmedContentHash).toBe(expectedHash);
    expect(controller.snapshot().confirmedContentHash).not.toBe(contentHash(map));
    expect(JSON.parse(handle.text()).nodes.nB.position[0]).toBe(120);
  });

  it.each(['create', 'write', 'close'] as const)('does not advance baseline on %s failure', async (stage) => {
    const { controller, handle } = await linked(); const before = controller.snapshot(); const disk = handle.text();
    const map = editorFixture(); map.nodes.nB!.position[0] = 120; handle.failAt = stage;
    const result = await controller.write(map);
    expect(result.status).toBe('failure');
    expect(controller.snapshot()).toEqual(before);
    expect(handle.text()).toBe(disk);
    expect(handle.aborted).toBe(stage === 'create' ? 0 : 1);
  });

  it('associates a newly chosen save-as target only after close succeeds', async () => {
    const target = new FakeHandle('new.map.json');
    const { controller, handle } = await linked(undefined, { showSaveFilePicker: async () => target });
    const oldDisk = handle.text(); const before = controller.snapshot();
    const map = editorFixture(); map.nodes.nB!.position[0] = 150;
    target.failAt = 'close'; expect((await controller.saveAs(map)).status).toBe('failure');
    expect(controller.snapshot()).toEqual(before);
    target.failAt = null; expect((await controller.saveAs(map)).status).toBe('saved');
    expect(controller.snapshot().linkedName).toBe('new.map.json');
    expect(controller.snapshot().confirmedContentHash).toBe(contentHash(map));
    expect(target.text()).toBe(serializeMap(map)); expect(handle.text()).toBe(oldDisk);
  });

  it('does not use save-as to bypass conflict checks when selecting the linked file', async () => {
    const handle = new FakeHandle('A.json', serializeMap(editorFixture()));
    const { controller } = await linked(handle, { showSaveFilePicker: async () => handle });
    const outside = editorFixture(); outside.metadata.name = '外部编辑'; handle.external(serializeMap(outside));
    expect((await controller.saveAs(editorFixture())).status).toBe('conflict');
    expect(handle.created).toBe(0);
  });

  it('refuses an invalid or newly changed save-as target without replacing it', async () => {
    const target = new FakeHandle('B.json', '{broken');
    const { controller } = await linked(undefined, { showSaveFilePicker: async () => target }); const before = controller.snapshot();
    expect((await controller.saveAs(editorFixture())).status).toBe('failure');
    expect(target.text()).toBe('{broken'); expect(target.created).toBe(0);
    target.external(''); target.reads = 0;
    target.beforeRead = (read) => { if (read === 2) target.external(serializeMap(editorFixture())); };
    expect((await controller.saveAs(editorFixture())).status).toBe('stale');
    expect(target.created).toBe(0); expect(controller.snapshot()).toEqual(before);
  });

  it('rejects an oversized external file before allocating a writable stream', async () => {
    const { controller, handle } = await linked(); const before = controller.snapshot();
    handle.bytes = new Uint8Array(10 * 1024 * 1024 + 1);
    expect((await controller.check()).status).toBe('failure');
    expect((await controller.write(editorFixture())).status).toBe('failure');
    expect(handle.created).toBe(0); expect(controller.snapshot()).toEqual(before);
  });

  it('keeps the file baseline independent of serialization/export and other project controllers', async () => {
    const { controller: first } = await linked();
    const second = new LocalFileController({});
    const map = editorFixture(); map.metadata.name = '只导出的内容';
    serializeMap(map);
    expect(first.snapshot().confirmedContentHash).not.toBe(contentHash(map));
    expect(second.snapshot().linkedName).toBeNull();
    expect(first.reset()).toBe(true); expect(first.snapshot().confirmedContentHash).toBeNull();
  });
});

describe('SV01 restores only explicit file identity and its last confirmed baseline', () => {
  it('restores without file reads or permission requests; the next save writes the same handle', async () => {
    const { controller, handle } = await linked(); const reads = handle.reads;
    const binding = controller.exportBinding()!;
    const restored = new LocalFileController({});
    expect(restored.restoreBinding(binding).status).toBe('linked');
    expect(handle.reads).toBe(reads); expect(handle.permissionRequests).toEqual([]); expect(handle.permissionQueries).toEqual([]);
    const map = editorFixture(); map.nodes.nB!.position[0] = 123.456789;
    expect((await restored.write(map)).status).toBe('saved');
    expect(handle.permissionRequests).toEqual(['readwrite']);
    expect(handle.text()).toBe(serializeMap(map));
    expect(controller.snapshot().confirmedContentHash).toBe(binding.contentHash);
    expect(restored.exportBinding()!.rawHash).not.toBe(binding.rawHash);
  });

  it('automatic checks do not request permission and a denied save does not fall back to save-as', async () => {
    const { controller, handle } = await linked(); const binding = controller.exportBinding()!;
    const restored = new LocalFileController({ showSaveFilePicker: async () => { throw new Error('must not save-as'); } });
    restored.restoreBinding(binding); handle.permission = 'prompt'; const reads = handle.reads;
    expect((await restored.check()).status).toBe('failure');
    expect(handle.permissionQueries).toEqual(['read']); expect(handle.permissionRequests).toEqual([]);
    expect(handle.reads).toBe(reads);
    handle.permission = 'denied';
    expect((await restored.write(editorFixture())).status).toBe('failure');
    expect(restored.exportBinding()).toEqual(binding); expect(handle.created).toBe(0);
    handle.permission = 'granted';
    expect((await restored.write(editorFixture())).status).toBe('saved');
  });

  it('explicit reload may renew read permission while denied reload preserves the old baseline', async () => {
    const { controller, handle } = await linked(); const before = controller.snapshot();
    handle.permission = 'denied';
    expect((await controller.readCurrent()).status).toBe('failure');
    expect(controller.snapshot()).toEqual(before);
    handle.permission = 'granted';
    expect((await controller.readCurrent()).status).toBe('opened');
    expect(handle.permissionRequests).toEqual(['read', 'read']);
  });

  it('keeps the old raw baseline across refresh and rejects bytes changed while the page was closed', async () => {
    const { controller, handle } = await linked(); const binding = controller.exportBinding()!;
    const outside = editorFixture(); outside.metadata.name = 'closed-page external edit';
    handle.external(serializeMap(outside));
    const restored = new LocalFileController({}); restored.restoreBinding(binding);
    const result = await restored.write(editorFixture());
    expect(result.status).toBe('conflict'); expect(handle.created).toBe(0);
    expect(restored.exportBinding()).toEqual(binding);
    expect(handle.text()).toBe(serializeMap(outside));
  });

  it('does not confuse equal map IDs and equal filenames in different projects', async () => {
    const a = new FakeHandle('map.json', serializeMap(editorFixture())), b = new FakeHandle('map.json', serializeMap(editorFixture()));
    const first = await linked(a), second = await linked(b);
    const restored = new LocalFileController({});
    restored.restoreBinding(first.controller.exportBinding()!);
    const changed = editorFixture(); changed.nodes.nB!.position[0] = 125;
    expect((await restored.write(changed)).status).toBe('saved');
    expect(a.text()).toBe(serializeMap(changed)); expect(b.text()).toBe(serializeMap(editorFixture()));
    restored.reset(); restored.restoreBinding(second.controller.exportBinding()!);
    expect((await restored.write(editorFixture())).status).toBe('saved');
    expect(a.created).toBe(1); expect(b.created).toBe(1);
  });

  it('rejects malformed restored records without clearing an existing association', async () => {
    const { controller } = await linked(); const before = controller.snapshot();
    expect(controller.restoreBinding({ handle: { name: 'map.json' }, contentHash: 'a'.repeat(64), rawHash: 'b'.repeat(64) } as LocalFileBinding).status).toBe('failure');
    expect(controller.restoreBinding({ ...controller.exportBinding()!, rawHash: 'invalid' }).status).toBe('failure');
    expect(controller.snapshot()).toEqual(before);
  });

  it('does not replace a binding while its original file write is in flight', async () => {
    const { controller, handle } = await linked(); const other = await linked(new FakeHandle('other.json', serializeMap(editorFixture())));
    const gate = deferred(); handle.closeGate = gate.promise;
    const saving = controller.write(editorFixture());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.restoreBinding(other.controller.exportBinding()!).status).toBe('busy');
    gate.resolve(); expect((await saving).status).toBe('saved');
    expect(controller.snapshot().linkedName).toBe('original.map.json');
  });
});
