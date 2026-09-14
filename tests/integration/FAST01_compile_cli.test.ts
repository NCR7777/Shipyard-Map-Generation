import { expect, it } from 'vitest';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GA01_TARGETS,readGA01Target } from '../helpers/GA01_targets';
import { upgradeMapToV03 } from '../../src/domain/upgradeV03';
import { serializeMap,contentHash } from '../../src/domain/serialization';
import { compileMap } from '../../src/compiler/routing';

it('compiles a real map copy through the Node CLI and reads it with a plain Node consumer',async()=>{
  const original=await readGA01Target(GA01_TARGETS.find(target=>target.id==='cimc_v02')!);
  const map=upgradeMapToV03(original).map,folder=await mkdtemp(join(tmpdir(),'fast01-compiler-'));
  try{
    const input=join(folder,'map.json'),output=join(folder,'compiled-map.json');await writeFile(input,serializeMap(map));
    const run=spawnSync(process.execPath,['--import','tsx',resolve('scripts/map-compile.ts'),input,'--out',output],{encoding:'utf8',timeout:60000});
    expect(run.status,run.stderr).toBe(0);const compiled=JSON.parse(await readFile(output,'utf8'));expect(compiled.mapContentHash).toBe(contentHash(map));
    expect(compiled).toEqual(JSON.parse(JSON.stringify(compileMap(map))));
    const consumer=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(Object.keys(m.arcs).length!==2*${Object.keys(map.roads).length})throw Error('arc count');for(const arc of Object.values(m.arcs)){if(!m.nodes[arc.fromNodeId]||!m.nodes[arc.toNodeId]||!(arc.lengthM>0)||arc.samples.at(-1).sM!==arc.lengthM)throw Error('arc contract');}console.log(JSON.stringify({nodes:Object.keys(m.nodes).length,arcs:Object.keys(m.arcs).length,movements:Object.keys(m.movements).length,services:Object.keys(m.servicePoints).length,unknowns:m.warnings.length}));`,output],{encoding:'utf8'});
    expect(consumer.status,consumer.stderr).toBe(0);expect(JSON.parse(consumer.stdout).nodes).toBe(Object.keys(map.nodes).length);
    const overwrite=spawnSync(process.execPath,['--import','tsx',resolve('scripts/map-compile.ts'),input,'--out',input],{encoding:'utf8',timeout:30000});
    expect(overwrite.status).toBe(1);expect(overwrite.stderr).toContain('OUTPUT_IS_INPUT');expect(await readFile(input,'utf8')).toBe(serializeMap(map));
  }finally{await rm(folder,{recursive:true,force:true});}
},90000);

it('keeps metric window fields in the core but rejects direct and globalThis DOM access',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'fast01-boundary-'));
  if(!folder.startsWith(join(tmpdir(),'fast01-boundary-')))throw Error('Unexpected temporary path');
  try {
    await mkdir(join(folder,'src/domain'),{recursive:true});
    for (const [source,allowed] of [
      ['const metric={window:{startS:0}};metric.window;',true],
      ['document.createElement("canvas");',false],
      ['window.document;',false],
      ['globalThis.window;',false],
      ['globalThis.document;',false],
      ['globalThis["document"];',false],
    ] as const) {
      await writeFile(join(folder,'src/domain/probe.ts'),source);
      const run=spawnSync(process.execPath,[resolve('scripts/check-boundaries.mjs')],{cwd:folder,encoding:'utf8',timeout:30000});
      expect(run.status,source+' '+run.stderr).toBe(allowed?0:1);
    }
  } finally {
    await rm(folder,{recursive:true,force:true});
  }
},90000);
