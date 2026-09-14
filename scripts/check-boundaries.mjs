import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const roots = ['domain', 'geometry', 'topology', 'validation', 'compiler'];
// Contract fields such as metric.window are data; only references to browser globals/types cross the boundary.
function hasDomReference(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const domNames = ['window','document','HTMLCanvasElement','CanvasRenderingContext2D'];
  let found = false;
  function inspect(node) {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'globalThis') {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : '';
      if (domNames.includes(key)) found=true;
    }
    if (ts.isIdentifier(node) && domNames.includes(node.text)) {
      const parent=node.parent;
      const propertyName = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
      if (!propertyName) found=true;
    }
    if (!found) ts.forEachChild(node, inspect);
  }
  inspect(source); return found;
}
async function visit(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { await visit(file); continue; }
    if (!/\.tsx?$/.test(file)) continue;
    const text = await readFile(file, 'utf8');
    if (/\b(?:from|import)\s*[(]?\s*['"](?:react(?:-dom|-konva)?|konva|three)(?:['"/])/.test(text)
      || hasDomReference(text, file)
      || /(?:from|import)\s*[(]?\s*['"][^'"]*(?:\/ui\/|\/renderers\/|\/editor\/|adapters\/files)/.test(text)) {
      throw new Error(`Core boundary violated: ${file}`);
    }
  }
}
for (const root of roots) await visit(path.join('src', root));
console.log('Core boundaries: PASS');
