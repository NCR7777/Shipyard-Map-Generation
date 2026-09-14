import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMap } from '../src/domain/load';
import { MAX_JSON_BYTES } from '../src/domain/model';
import { compileMap, COMPILE_PROFILE } from '../src/compiler/routing';

async function main(): Promise<void> {
  const args=process.argv.slice(2); const input=args.shift(); let output:string|undefined,profile=COMPILE_PROFILE as string;
  while(args.length) {const flag=args.shift(),value=args.shift();if(!value||value.startsWith('-'))throw Error('CLI_ARGUMENT');if(flag==='--out'&&!output)output=value;else if(flag==='--profile')profile=value;else throw Error('CLI_ARGUMENT');}
  if(!input||input.startsWith('-'))throw Error('用法：npm run map:compile -- map.json [--out compiled-map.json] [--profile declared-network-v1]');
  if(output&&resolve(output)===resolve(input))throw Error('OUTPUT_IS_INPUT: 编译输出不得覆盖地图原件。');
  const info=await stat(input);if(!info.isFile()||info.size>MAX_JSON_BYTES)throw Error('INVALID_INPUT_FILE');
  const loaded=loadMap(new TextDecoder('utf-8',{fatal:true}).decode(await readFile(input)));
  if(!loaded.ok)throw Error(loaded.report.issues.map(i=>i.code+': '+i.message).join('\n'));
  const text=JSON.stringify(compileMap(loaded.map,profile),null,2)+'\n';
  if(output) await writeFile(output,text,{encoding:'utf8',flag:'wx'}); else process.stdout.write(text);
}
try { await main(); } catch(error) { process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1; }
