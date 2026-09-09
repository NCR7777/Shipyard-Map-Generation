import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const roots = ['domain', 'geometry', 'topology', 'validation', 'compiler'];
async function visit(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { await visit(file); continue; }
    if (!/\.tsx?$/.test(file)) continue;
    const text = await readFile(file, 'utf8');
    if (/\b(?:from|import)\s*[(]?\s*['"](?:react(?:-dom|-konva)?|konva|three)(?:['"/])/.test(text)
      || /\b(?:window|document|HTMLCanvasElement|CanvasRenderingContext2D)\b/.test(text)
      || /(?:from|import)\s*[(]?\s*['"][^'"]*(?:\/ui\/|\/renderers\/|\/editor\/|adapters\/files)/.test(text)) {
      throw new Error(`Core boundary violated: ${file}`);
    }
  }
}
for (const root of roots) await visit(path.join('src', root));
console.log('Core boundaries: PASS');
