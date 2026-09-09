import { readFile, stat } from 'node:fs/promises';
import { loadMap } from '../src/domain/load';
import { MAX_JSON_BYTES, type Issue, type ValidationReport } from '../src/domain/model';
import { validateMap } from '../src/validation/validate';

interface Arguments { file: string; profile: string }

function parseArguments(args: string[]): Arguments | undefined {
  let file: string | undefined;
  let profile = 'draft';
  let profileSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--profile' || argument.startsWith('--profile=')) {
      if (profileSeen) return undefined;
      profileSeen = true;
      const value = argument === '--profile' ? args[++index] : argument.slice('--profile='.length);
      if (!value || value.startsWith('-')) return undefined;
      profile = value;
    } else if (argument.startsWith('-') || file !== undefined) {
      return undefined;
    } else {
      file = argument;
    }
  }
  return file ? { file, profile } : undefined;
}

function failure(code: string, message: string, profile = 'draft'): ValidationReport {
  const issue: Issue = {
    code,
    severity: 'error',
    jsonPath: '',
    message,
    suggestedAction: code === 'CLI_ARGUMENT'
      ? '用法：npm run map:validate -- <map.json> [--profile draft]。'
      : '检查本地文件路径、文件权限和 JSON 大小后重试。',
  };
  return { ok: false, status: 'invalid', profile, issues: [issue] };
}

function emit(report: object, exitCode: number): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCode;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    emit(failure('CLI_ARGUMENT', '缺少地图文件或命令行参数无效。'), 2);
    return;
  }
  let text: string;
  try {
    const information = await stat(args.file);
    if (!information.isFile()) {
      emit(failure('CLI_IO', '输入路径不是普通文件。', args.profile), 2);
      return;
    }
    if (information.size > MAX_JSON_BYTES) {
      emit(failure('INPUT_TOO_LARGE', `地图 JSON 超过 ${MAX_JSON_BYTES} 字节限制。`, args.profile), 1);
      return;
    }
    const bytes = await readFile(args.file);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      emit(failure('JSON_ENCODING', '地图文件不是合法 UTF-8 编码。请转换为 UTF-8 后重试。', args.profile), 1);
      return;
    }
  } catch (error) {
    emit(failure('CLI_IO', error instanceof Error ? error.message : '无法读取文件。', args.profile), 2);
    return;
  }

  const loaded = loadMap(text);
  if (!loaded.ok) {
    emit({ ...loaded.report, profile: args.profile }, 1);
    return;
  }
  const report = args.profile === 'draft' ? loaded.report : validateMap(loaded.map, args.profile);
  emit({
    ...report,
    mapId: loaded.map.mapId,
    mapContentHash: loaded.contentHash,
    capabilities: loaded.capabilities,
  }, report.status === 'unsupported' ? 3 : report.ok ? 0 : 1);
}

await main();
