import { describe, expect, it } from 'vitest';
import { createSession, editSession, isDirty, markExported, prepareImport, redoSession, resolveImport, undoSession } from '../../src/editor/session';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { editorFixture } from '../helpers/M1_fixtures';

describe('M1 history and external-edit conflict sessions', () => {
  it('marks new maps dirty until the exported content matches the current map', () => {
    let session = createSession(editorFixture());
    expect(isDirty(session)).toBe(true);
    session = markExported(session, contentHash(session.map));
    expect(isDirty(session)).toBe(false);
  });

  it('commits one drag transaction after 100 intermediate previews and restores it in one undo/redo', () => {
    const original = createSession(editorFixture(), true);
    let preview = original.map.nodes.nB!.position;
    for (let frame = 1; frame <= 100; frame += 1) preview = [100 + frame, 0, 0];
    expect(original.past).toHaveLength(0);
    const edited = editSession(original, { type: 'updateNode', id: 'nB', patch: { position: preview } });
    expect(edited.ok).toBe(true);
    expect(edited.session.past).toHaveLength(1);
    expect(edited.session.map.nodes.nB!.position).toEqual([200, 0, 0]);
    const undone = undoSession(edited.session);
    expect(undone.map).toEqual(original.map);
    expect(undone.past).toHaveLength(0);
    expect(undone.future).toHaveLength(1);
    expect(isDirty(undone)).toBe(false);
    const redone = redoSession(undone);
    expect(redone.map).toEqual(edited.session.map);
    expect(redone.past).toHaveLength(1);
  });

  it('reuses copied IDs on redo rather than generating a second set', () => {
    const initial = createSession(editorFixture(), true);
    const result = editSession(initial, {
      type: 'duplicateSelection', selection: { nodes: [], roads: ['rAB'] }, delta: [0, 20, 0],
      idMap: { nA: 'nA_copy', nB: 'nB_copy', rAB: 'rAB_copy' },
    });
    expect(result.ok).toBe(true);
    expect(result.session.past).toHaveLength(1);
    const redone = redoSession(undoSession(result.session));
    expect(serializeMap(redone.map)).toBe(serializeMap(result.session.map));
    expect(redone.map.roads.rAB_copy!.fromNodeId).toBe('nA_copy');
  });

  it('keeps failed edits out of history and retains saved content identity', () => {
    const initial = createSession(editorFixture(), true);
    const result = editSession(initial, { type: 'updateNode', id: 'nB', patch: { position: [0, 0, 0] } });
    expect(result.ok).toBe(false);
    expect(result.session).toEqual(initial);
    expect(isDirty(result.session)).toBe(false);
  });

  it('clears redo only after a successful new edit and does not record no-ops', () => {
    const initial = createSession(editorFixture(), true);
    const moved = editSession(initial, { type: 'updateNode', id: 'nB', patch: { position: [120, 0, 0] } }).session;
    const undone = undoSession(moved);
    const noop = editSession(undone, { type: 'updateNode', id: 'nA', patch: { name: 'A' } }).session;
    expect(noop.past).toHaveLength(0);
    expect(noop.future).toHaveLength(1);
    const changed = editSession(noop, { type: 'updateNode', id: 'nA', patch: { name: 'A2' } }).session;
    expect(changed.future).toHaveLength(0);
    expect(changed.past).toHaveLength(1);
  });

  it('refuses invalid imports without modifying the dirty map, history, or saved baseline', () => {
    const initial = createSession(editorFixture(), true);
    const dirty = editSession(initial, { type: 'updateNode', id: 'nB', patch: { position: [110, 0, 0] } }).session;
    const before = structuredClone(dirty);
    const invalid = prepareImport(dirty, '{"schemaVersion":"99.0.0"}');
    expect(invalid.status).toBe('invalid');
    expect(dirty).toEqual(before);
    expect(isDirty(dirty)).toBe(true);
    expect(undoSession(dirty).map).toEqual(initial.map);
  });

  it('keeps the exact dirty document on cancelled external-reload conflict', () => {
    const initial = createSession(editorFixture(), true);
    const dirty = editSession(initial, { type: 'updateNode', id: 'nA', patch: { name: '本地编辑' } }).session;
    const external = editorFixture();
    external.nodes.nB!.position = [120, 0, 0];
    const proposal = prepareImport(dirty, serializeMap(external));
    expect(proposal.status).toBe('conflict');
    if (proposal.status === 'invalid') throw new Error('Valid external map rejected.');
    const result = resolveImport(dirty, proposal, 'cancel');
    expect(result.session).toEqual(dirty);
    expect(result.session.savedHash).toBe(initial.savedHash);
    expect(isDirty(result.session)).toBe(true);
  });

  it('allows export-current then explicit replacement and resets history to the imported baseline', () => {
    const initial = createSession(editorFixture(), true);
    const dirty = editSession(initial, { type: 'updateNode', id: 'nA', patch: { name: '先保存这份' } }).session;
    const external = editorFixture();
    external.nodes.nB!.position = [120, 0, 0];
    const proposal = prepareImport(dirty, serializeMap(external));
    expect(proposal.status).toBe('conflict');
    if (proposal.status === 'invalid') throw new Error('Valid external map rejected.');
    const exported = markExported(dirty, contentHash(dirty.map));
    expect(isDirty(exported)).toBe(false);
    const result = resolveImport(exported, proposal, 'replace');
    expect(result.ok).toBe(true);
    expect(result.session.map).toEqual(external);
    expect(result.session.past).toHaveLength(0);
    expect(result.session.future).toHaveLength(0);
    expect(isDirty(result.session)).toBe(false);
  });

  it('rejects stale reload proposals after another command changes the active document', () => {
    const initial = createSession(editorFixture(), true);
    const external = editorFixture();
    external.nodes.nB!.position = [120, 0, 0];
    const proposal = prepareImport(initial, serializeMap(external));
    expect(proposal.status).toBe('ready');
    if (proposal.status === 'invalid') throw new Error('Valid external map rejected.');
    const edited = editSession(initial, { type: 'updateNode', id: 'nA', patch: { name: '更晚编辑' } }).session;
    const result = resolveImport(edited, proposal, 'replace');
    expect(result.ok).toBe(false);
    expect(result.session).toEqual(edited);
  });

  it('returns structured errors for a candidate modified after preparation without replacing state', () => {
    const initial = createSession(editorFixture(), true);
    const proposal = prepareImport(initial, serializeMap(editorFixture()));
    if (proposal.status === 'invalid') throw new Error('Valid import fixture rejected.');
    proposal.loaded.map.roads.rAB!.toNodeId = 'nMissing';
    const result = resolveImport(initial, proposal, 'replace');
    expect(result.ok).toBe(false);
    expect(result.session).toEqual(initial);
    expect(result.issues.some((issue) => issue.code === 'DANGLING_REFERENCE')).toBe(true);
  });

  it('isolates and freezes session snapshots from caller-owned maps and commands', () => {
    const source = editorFixture();
    const initial = createSession(source, true);
    source.nodes.nA!.name = '来源随后改动';
    expect(initial.map.nodes.nA!.name).toBe('A');
    expect(Object.isFrozen(initial.map.nodes.nA!.position)).toBe(true);
    const patch = { position: [120, 0, 0] as [number, number, number] };
    const result = editSession(initial, { type: 'updateNode', id: 'nB', patch });
    patch.position[0] = 999;
    expect(result.session.map.nodes.nB!.position).toEqual([120, 0, 0]);
    expect(undoSession(result.session).map).toEqual(initial.map);
  });

  it('does not mark a later document as saved when an earlier export completes', () => {
    const initial = createSession(editorFixture(), true);
    const oldHash = contentHash(initial.map);
    const dirty = editSession(initial, { type: 'updateNode', id: 'nB', patch: { position: [120, 0, 0] } }).session;
    const result = markExported(dirty, oldHash);
    expect(isDirty(result)).toBe(true);
    expect(result.savedHash).toBe(initial.savedHash);
    expect(result.map).toEqual(dirty.map);
  });
});
