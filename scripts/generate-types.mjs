import { readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';

const schemaUrl = new URL('../schemas/map.schema.json', import.meta.url);
const target = new URL('../src/domain/model.generated.ts', import.meta.url);
// The generator consumes tuple `items`; the authoritative validator uses Draft 2020-12 prefixItems.
function generatorSchema(value) {
  if (Array.isArray(value)) return value.map(generatorSchema);
  if (value && typeof value === 'object') {
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, generatorSchema(child)]));
    if (result.prefixItems) {
      result.items = result.prefixItems;
      delete result.prefixItems;
      result.additionalItems = false;
    }
    return result;
  }
  return value;
}
const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
const output = (await compile(generatorSchema(schema), 'YardMap', {
  bannerComment: '/* Generated from schemas/map.schema.json. Run npm run schema:generate; do not edit. */',
  unreachableDefinitions: true,
  style: { singleQuote: true, semi: true, tabWidth: 2, printWidth: 100 },
})).replace(/\r\n/g, '\n');
if (process.argv.includes('--check')) {
  const actual = await readFile(target, 'utf8').catch(() => '');
  if (actual !== output) {
    console.error('Schema/type mismatch. Run npm run schema:generate.');
    process.exitCode = 1;
  }
} else {
  await writeFile(target, output, 'utf8');
}
