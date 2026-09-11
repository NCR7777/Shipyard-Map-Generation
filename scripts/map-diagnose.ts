import { readFile, stat } from 'node:fs/promises';
import { loadMap } from '../src/domain/load';
import { MAX_JSON_BYTES } from '../src/domain/model';
import { diagnoseMap } from '../src/validation/diagnostics';
import { previewPath, type PathEndpoint } from '../src/topology/pathPreview';

function emit(report: object, code: number): void {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = code;
}
function endpoint(value: string | undefined): PathEndpoint | undefined {
  const match = /^(servicePoints|accessPoints):([A-Za-z][A-Za-z0-9_-]{0,127})$/.exec(value ?? '');
  return match ? { kind: match[1] as PathEndpoint['kind'], id: match[2]! } : undefined;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); const file = args[0];
  let from: PathEndpoint | undefined, to: PathEndpoint | undefined;
  let valid = !!file && !file.startsWith('-');
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--from' && !from) { from = endpoint(args[i + 1]); valid &&= !!from; }
    else if (args[i] === '--to' && !to) { to = endpoint(args[i + 1]); valid &&= !!to; }
    else valid = false;
  }
  if (!valid || !!from !== !!to) {
    emit({ status: 'invalid', code: 'CLI_ARGUMENT', message: '用法：npm run map:diagnose -- <map.json> [--from servicePoints:ID --to accessPoints:ID]。' }, 2); return;
  }
  let bytes: Buffer;
  try {
    const info = await stat(file!);
    if (!info.isFile()) throw new Error('输入不是普通文件。');
    if (info.size > MAX_JSON_BYTES) { emit({ status: 'invalid', code: 'INPUT_TOO_LARGE', message: '地图超过共享 JSON 大小限制。' }, 1); return; }
    bytes = await readFile(file!);
  } catch (error) { emit({ status: 'invalid', code: 'CLI_IO', message: String(error) }, 2); return; }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { emit({ status: 'invalid', code: 'JSON_ENCODING', message: '地图不是合法 UTF-8。' }, 1); return; }
  const loaded = loadMap(text);
  if (!loaded.ok) { emit(loaded.report, 1); return; }
  emit({ diagnostics: diagnoseMap(loaded.map), ...(from && to ? { path: previewPath(loaded.map, from, to) } : {}) }, 0);
}
// Exit 0 means a report was produced, including partial/unknown/conflict results; never a safety gate.
await main();
