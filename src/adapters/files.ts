import { MAX_JSON_BYTES } from '../domain/model';
import { serializeMap } from '../domain/serialization';
import type { YardMap } from '../domain/model';

export async function readJsonFile(file: File): Promise<string> {
  if (file.size > MAX_JSON_BYTES) throw new Error('JSON 文件超过 10 MiB。');
  const bytes = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('文件必须使用 UTF-8 编码。'); }
}

export function downloadMap(map: YardMap): string {
  const text = serializeMap(map);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${map.mapId}-r${map.revision}-${timestamp}-${crypto.randomUUID().slice(0, 8)}.map.json`;
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}