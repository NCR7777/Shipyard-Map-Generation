import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadMap } from '../src/domain/load';
import { applyMapCommand } from '../src/domain/commands';
import { contentHash, serializeMap } from '../src/domain/serialization';
import { MAX_JSON_BYTES } from '../src/domain/model';

function emit(report: object, code: number) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = code; }
function failure(code: string, message: string, exitCode = 2) {
  emit({ ok: false, status: 'invalid', issues: [{ code, severity: 'error', jsonPath: '', message, suggestedAction: '用法：npm run map:migrate -- <旧输入.json> <不存在的新输出.json>。原文件不会被修改。' }] }, exitCode);
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some(value => value.startsWith('-'))) { failure('CLI_ARGUMENT', '必须明确提供一个输入文件和一个新输出文件路径。'); return; }
  const inputPath = resolve(args[0]!); const outputPath = resolve(args[1]!);
  if ((process.platform === 'win32' ? inputPath.toLowerCase() === outputPath.toLowerCase() : inputPath === outputPath)) { failure('MIGRATION_SAME_PATH', '不允许原地迁移；请提供不同的新文件路径。'); return; }
  let bytes: Buffer;
  try {
    const source = await stat(inputPath);
    if (!source.isFile()) { failure('CLI_IO', '输入不是普通文件。'); return; }
    if (source.size > MAX_JSON_BYTES) { failure('INPUT_TOO_LARGE', '地图 JSON 超过 10 MiB。', 1); return; }
    // Resolve the existing parent before any write. An existing output is never replaced.
    const canonicalOutput = resolve(await realpath(dirname(outputPath)), basename(outputPath));
    const canonicalInput = await realpath(inputPath);
    if ((process.platform === 'win32' ? canonicalInput.toLowerCase() === canonicalOutput.toLowerCase() : canonicalInput === canonicalOutput)) { failure('MIGRATION_SAME_PATH', '解析后的输出指向原文件，拒绝迁移。'); return; }
    try { await stat(outputPath); failure('MIGRATION_OUTPUT_EXISTS', '新输出路径已经存在，拒绝覆盖。'); return; }
    catch (reason) { if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason; }
    bytes = await readFile(inputPath);
  } catch (reason) { failure('CLI_IO', reason instanceof Error ? reason.message : String(reason)); return; }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { failure('JSON_ENCODING', '输入不是合法 UTF-8。', 1); return; }
  const loaded = loadMap(text);
  if (!loaded.ok) { emit(loaded.report, 1); return; }
  const result = applyMapCommand(loaded.map, { type: 'upgradeSchema', targetVersion: '0.2.0' });
  if (!result.ok) { emit({ ok: false, status: 'invalid', issues: result.issues }, 1); return; }
  try {
    const handle = await open(outputPath, 'wx');
    try { await handle.writeFile(serializeMap(result.map), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  } catch (reason) {
    failure((reason as NodeJS.ErrnoException).code === 'EEXIST' ? 'MIGRATION_OUTPUT_EXISTS' : 'CLI_IO', (reason instanceof Error ? reason.message : String(reason)) + '；未修改输入文件。若输出写入中途失败，新输出可能不完整，请检查后另选路径。'); return;
  }
  emit({ ok: true, status: result.changed ? 'migrated' : 'copied_current_version', inputPath, outputPath,
    sourceFileSha256: createHash('sha256').update(bytes).digest('hex'), sourceContentHash: loaded.contentHash,
    targetContentHash: contentHash(result.map), changes: result.migrationChanges ?? [],
    message: '只显式升级版本和修订号；未猜测区域归属、到达语义或补全道路。原文件保持不变。',
  }, 0);
}
await main();
