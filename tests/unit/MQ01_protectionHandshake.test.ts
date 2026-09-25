import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assertRepairProtection, readProtection } from '../../scripts/MQ01_core';

describe('MQ01 repair publication protection handshake', () => {
  it('rejects a lock file created or changed after candidate preparation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'MQ01-protection-'));
    const mapPath = join(directory, 'map.json'), sidecar = join(directory, 'map-protection.json');
    try {
      const initial = await readProtection(mapPath);
      await expect(assertRepairProtection(mapPath, initial)).resolves.toBeUndefined();
      await writeFile(sidecar, JSON.stringify({ protectedRefs: [{ kind: 'siteBoundary', id: 'siteBoundary' }] }));
      await expect(assertRepairProtection(mapPath, initial)).rejects.toThrow('MQ_PROTECTION_CHANGED');
      const prepared = await readProtection(mapPath);
      await expect(assertRepairProtection(mapPath, prepared)).resolves.toBeUndefined();
      await writeFile(sidecar, JSON.stringify({ protectedRefs: [{ kind: 'sources', id: 'new_source' }] }));
      await expect(assertRepairProtection(mapPath, prepared)).rejects.toThrow('MQ_PROTECTION_CHANGED');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
