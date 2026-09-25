// Kernel behaviour snapshot over every map in examples/ and <data root>/projects/: the real import path (strict UTF-8,
// loadMap) plus canonical serialization and compilation. Keys are root-relative, independent of how the root is spelled.
// Usage: tsx scripts/golden.ts check | write [--allow-shrink] [--accept-drift]
// Exit: 0 same; 1 kernel output drifted; 2 blocked_input, usage or unexpected error; 3 input set changed (re-snapshot deliberately).
import { createHash } from 'node:crypto';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMap } from '../src/compiler/routing';
import { loadMap } from '../src/domain/load';
import { serializeMap } from '../src/domain/serialization';

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenFile = path.join(here, '../tests/golden/maps.json');
// Same default as the real-map tests: the workspace directory that contains projects/.
const dataRoot = path.resolve(process.env.SHIPYARD_TEST_DATA_ROOT ?? path.join(here, '../../..'));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(JSON.stringify(value)).slice(0, 16);
type Entry = Record<string, unknown> & { fileSha256: string };

async function mapFiles(root: string, prefix: string): Promise<{ key: string; file: string }[]> {
  const names = await readdir(root, { recursive: true });
  return names.filter(name => /(^|[\\/])([^\\/]*\.)?map\.json$/.test(name))
    .map(name => ({ key: prefix + '/' + name.split(path.sep).join('/'), file: path.join(root, name) }));
}

function entry(bytes: Uint8Array): Entry {
  const fileSha256 = sha(bytes);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { fileSha256, decode: 'not_utf8' }; }
  const loaded = loadMap(text), issues = loaded.report.issues;
  const codes: Record<string, number> = {};
  for (const issue of issues) codes[issue.severity + ':' + issue.code] = (codes[issue.severity + ':' + issue.code] ?? 0) + 1;
  const result: Entry = { fileSha256, ok: loaded.ok, issueCodes: Object.fromEntries(Object.entries(codes).sort()), issuesDigest: digest(issues) };
  if (!loaded.ok) return result;
  result.contentHash = loaded.contentHash;
  result.sceneDigest = digest(loaded.scene);
  result.serializedDigest = sha(serializeMap(loaded.map)).slice(0, 16);
  try { result.compiledDigest = digest(compileMap(loaded.map)); } catch (error) { result.compileError = String(error instanceof Error ? error.message : error).slice(0, 120); }
  return result;
}

async function snapshot(): Promise<Record<string, Entry>> {
  const projects = path.join(dataRoot, 'projects');
  try { await access(projects); } catch {
    console.error(`blocked_input: ${projects} cannot be read; set SHIPYARD_TEST_DATA_ROOT to the directory containing projects/`);
    process.exit(2);
  }
  const files = [...await mapFiles(path.join(here, '../examples'), 'examples'), ...await mapFiles(projects, 'projects')];
  const out: Record<string, Entry> = {};
  for (const { key, file } of files.sort((a, b) => a.key < b.key ? -1 : 1)) out[key] = entry(await readFile(file));
  return out;
}

/** Same input bytes, different kernel output. */
function drift(current: Record<string, Entry>, previous: Record<string, Entry>) {
  return Object.keys(current).filter(key => key in previous && current[key]!.fileSha256 === previous[key]!.fileSha256
    && JSON.stringify(current[key]) !== JSON.stringify(previous[key]))
    .map(key => ({ key, fields: Object.keys({ ...current[key], ...previous[key] }).filter(field => JSON.stringify(current[key]![field]) !== JSON.stringify(previous[key]![field])) }));
}

async function main(mode: string | undefined): Promise<number> {
  if (mode !== 'check' && mode !== 'write') { console.error('usage: golden.ts check | write [--allow-shrink] [--accept-drift]'); return 2; }
  let previous: Record<string, Entry> = {};
  try { previous = JSON.parse(await readFile(goldenFile, 'utf8')) as Record<string, Entry>; }
  catch (error) {
    // Only a first write may start without a snapshot; a check needs one.
    if (mode === 'check' || (error as NodeJS.ErrnoException).code !== 'ENOENT') { console.error(`blocked_input: snapshot ${goldenFile} cannot be read: ${String(error)}`); return 2; }
  }
  const current = await snapshot(), drifted = drift(current, previous);
  if (mode === 'write') {
    if (Object.keys(current).length < Object.keys(previous).length && !process.argv.includes('--allow-shrink')) {
      console.error(`refused: ${Object.keys(current).length} maps now, ${Object.keys(previous).length} in the snapshot; pass --allow-shrink if maps were removed on purpose`);
      return 2;
    }
    // Re-snapshotting after edited inputs must not silently absorb kernel drift on unchanged inputs.
    if (drifted.length && !process.argv.includes('--accept-drift')) {
      console.error(`refused: kernel output changed for ${drifted.length} unchanged inputs; explain the change, then pass --accept-drift\n${JSON.stringify(drifted, null, 1)}`);
      return 2;
    }
    await writeFile(goldenFile, JSON.stringify(current, null, 2) + '\n');
    console.log(`wrote ${Object.keys(current).length} maps`);
    return 0;
  }
  const missing = Object.keys(previous).filter(key => !(key in current));
  const added = Object.keys(current).filter(key => !(key in previous));
  const inputChanged = Object.keys(current).filter(key => key in previous && current[key]!.fileSha256 !== previous[key]!.fileSha256);
  const checked = Object.keys(current).length - added.length - inputChanged.length;
  console.log(JSON.stringify({ checked, drifted, missing, added, inputChanged }, null, 1));
  return drifted.length ? 1 : missing.length || added.length || inputChanged.length ? 3 : 0;
}

// Unexpected failures (a locked or unreadable map, a broken snapshot) are exit 2, never mistaken for drift.
process.exitCode = await main(process.argv[2]).catch((error: unknown) => { console.error('blocked_input: ' + String(error instanceof Error ? error.stack : error)); return 2; });
