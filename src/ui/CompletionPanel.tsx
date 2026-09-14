import { useMemo, useRef, useState } from 'react';
import type { YardMap, Vec3 } from '../domain/model';
import type { MapCommand } from '../domain/commands';
import { readJsonFile } from '../adapters/files';
import { previewSemanticPatch, type SemanticPatchFile } from '../domain/semanticPatch';
import { prepareResearchAccess, checkResearchInput, type ResearchTarget, type ResearchAccessProposal } from '../domain/researchAccess';

interface Props {
  map: YardMap; mapHash: string; disabled: boolean;
  onApply: (command: MapCommand) => boolean;
  onRequireUpgrade: () => void;
  onExportPackage: () => Promise<void>;
  onPreview: (lines: Vec3[][]) => void;
  onLocate: (target: ResearchTarget) => void;
}
const kindNames: Record<string,string> = { building:'通用建筑',unclassified:'通用区域',workshop:'厂房',yard:'堆场',assembly:'总组',dock:'坞区',quay:'码头',other:'其他',work:'作业',buffer:'缓冲',waiting:'等待',water:'水域',obstacle:'障碍',forbidden:'禁入',drivable:'可行驶' };
export function CompletionPanel(props: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [patch,setPatch]=useState<unknown>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [reading,setReading]=useState(false),readingRef=useRef(false);
  const currentMap=useRef({id:props.map.mapId,hash:props.mapHash});currentMap.current={id:props.map.mapId,hash:props.mapHash};
  const [targetKeys,setTargetKeys]=useState<string[]>([]),[landZoneIds,setLandZoneIds]=useState<string[]>([]);
  const [proposal,setProposal]=useState<ResearchAccessProposal|null>(null);
  const [level,setLevel]=useState<'spatial'|'routing'|'scheduling'>('spatial');
  const [report,setReport]=useState<{key:string;value:ReturnType<typeof checkResearchInput>}|null>(null);
  const inputKey=JSON.stringify([props.map.mapId,props.mapHash,level,targetKeys,landZoneIds]);
  const preview=useMemo(()=>patch===null?null:previewSemanticPatch(props.map,patch),[props.map,patch]);
  const allTargets:ResearchTarget[]=[...Object.keys(props.map.facilities).map(id=>({kind:'facilities' as const,id})),...Object.keys(props.map.zones).map(id=>({kind:'zones' as const,id}))];
  const targets=allTargets.filter(target=>targetKeys.includes(target.kind+'/'+target.id));
  async function read(file:File|undefined) { if(!file||readingRef.current)return;const before={...currentMap.current};readingRef.current=true;setReading(true);try{setError('');const value=JSON.parse(await readJsonFile(file));if(currentMap.current.id!==before.id||currentMap.current.hash!==before.hash)throw new Error('读取期间地图已变化，请重新导入补丁。');setPatch(value);}catch(reason){setError(String(reason));}finally{readingRef.current=false;setReading(false);} }
  function clearProposal(){setProposal(null);props.onPreview([]);}
  function propose() {if(props.map.schemaVersion!=='0.3.0'){props.onRequireUpgrade();return;}try{setError('');const result=prepareResearchAccess(props.map,targets,{landZoneIds,transferAssumption:'excluded_from_model'});setProposal(result);props.onPreview(result.items.flatMap(item=>item.candidate?[[item.candidate.position,item.candidate.connectionPoint]]:[]));}catch(reason){setError(String(reason));}}
  return <div className="completion-panel">
    <h3>分类与用途补全</h3><p>导出含原始底图、轮廓 ID 和坐标的自包含资产补标包，由 Codex 批量给出可审查建议。</p>
    <button disabled={props.disabled||busy} onClick={()=>{setBusy(true);setError('');void props.onExportPackage().catch(reason=>setError(String(reason))).finally(()=>setBusy(false));}}>{busy?'正在整理原图与轮廓…':'导出Codex补标包'}</button>
    <button disabled={props.disabled||reading} onClick={()=>input.current?.click()}>导入语义补丁</button>
    <input ref={input} type="file" accept=".json,application/json" hidden data-testid="semantic-patch-input" onChange={event=>{void read(event.target.files?.[0]);event.target.value='';}}/>
    {preview&&<section aria-label="语义补丁预览"><p>{preview.readyCount} 项可应用；手工已确定用途优先。</p>
      <ul>{preview.items.map(item=><li key={item.index}><strong>{props.map[item.patch.entityType]?.[item.patch.entityId]?.name??item.patch.entityId}</strong>：{kindNames[String(item.patch.before)]??String(item.patch.before)} → {kindNames[String(item.patch.after)]??String(item.patch.after)}<br/>{item.reason}<details><summary>推测依据</summary><p>{item.patch.evidence}</p><p>{item.patch.origin} · {item.patch.evidenceGrade}</p></details></li>)}</ul>
      {preview.issues.map((issue,index)=><p className="inline-error" key={index}>{issue.message}</p>)}
      <button disabled={props.disabled||reading||!preview.ok||preview.readyCount===0} onClick={()=>{if(props.onApply({type:'applySemanticPatch',patch:patch as SemanticPatchFile}))setPatch(null);}}>一次应用可接受项</button>
    </section>}
    <h3>研究目标与接入</h3><p>仅为选定目标生成接入建议；未知门位与设施内运输保留为研究假设。</p>
    <div className="tool-grid"><button onClick={()=>{clearProposal();setTargetKeys(allTargets.map(target=>target.kind+'/'+target.id));}}>全选目标</button><button onClick={()=>{clearProposal();setTargetKeys([]);}}>清空目标</button></div>
    <div className="research-target-list">{allTargets.map(target=><label className="check-field" key={target.kind+'/'+target.id}><input type="checkbox" checked={targetKeys.includes(target.kind+'/'+target.id)} onChange={event=>{clearProposal();setTargetKeys(keys=>event.target.checked?[...keys,target.kind+'/'+target.id]:keys.filter(key=>key!==target.kind+'/'+target.id));}}/>{props.map[target.kind][target.id]!.name}<button aria-label={'定位 '+props.map[target.kind][target.id]!.name} onClick={()=>props.onLocate(target)}>⌖</button></label>)}</div>
    <details><summary>明确可通行的陆域</summary><p>短接线须完整处于已声明可通行区域；没有相应声明时保留未完成。</p>{Object.entries(props.map.zones).filter(([,zone])=>zone.kind==='drivable'&&zone.passability==='allowed').map(([id,zone])=><label className="check-field" key={id}><input type="checkbox" checked={landZoneIds.includes(id)} onChange={event=>{clearProposal();setLandZoneIds(ids=>event.target.checked?[...ids,id]:ids.filter(value=>value!==id));}}/>{zone.name}</label>)}</details>
    <button disabled={props.disabled||targets.length===0} onClick={propose}>生成选定目标接入建议</button>{props.map.schemaVersion!=='0.3.0'&&<p>首次生成接入将先保留原图并启用 0.3 路径契约。</p>}
    {proposal&&<section aria-label="接入建议"><ul>{proposal.items.map(item=><li key={item.target.kind+'/'+item.target.id}>{props.map[item.target.kind][item.target.id]?.name??item.target.id}：{item.reason}</li>)}</ul><button disabled={props.disabled||proposal.baseMapContentHash!==props.mapHash||!proposal.items.some(item=>item.status==='ready')} onClick={()=>{if(props.onApply({type:'applyResearchAccess',proposal})){setProposal(null);props.onPreview([]);}}}>一次接受可用接入</button>{proposal.baseMapContentHash!==props.mapHash&&<p>地图已变化，请重新生成建议。</p>}</section>}
    <h3>分级检查</h3><label>检查目标<select aria-label="研究输入检查级别" value={level} onChange={event=>setLevel(event.target.value as typeof level)}><option value="spatial">空间描图</option><option value="routing">可达与路由</option><option value="scheduling">调度输入</option></select></label>
    <button disabled={props.disabled} onClick={()=>setReport({key:inputKey,value:checkResearchInput(props.map,level,targets)})}>检查当前研究输入</button>
    {report&&report.key===inputKey&&<div aria-label="研究输入检查结果"><p>{report.value.ready?'当前级别输入就绪':'当前级别仍有待补项'}</p>{report.value.issues.map((issue,index)=><p key={index}>{issue.message}</p>)}</div>}
    {error&&<p role="alert" className="inline-error">{error}</p>}
  </div>;
}
