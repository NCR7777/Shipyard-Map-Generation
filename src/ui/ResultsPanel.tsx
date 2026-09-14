import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { YardMap } from '../domain/model';
import { storedZip } from '../adapters/storedZip';
import { readJsonFile } from '../adapters/files';
import { downloadPackage } from '../adapters/codexPackage';
import { loadRunPlan, loadRunEvents, loadRunSummary, frameAt, compareSummaries, makeSyntheticRunFiles, loadScenario, type PreparedRun } from '../domain/results';

export type ResultsOverlay = ReturnType<typeof frameAt> & { mapContentHash: string; runId: string };
interface Props { map: YardMap; mapHash: string; active: boolean; onFrame: (frame: ResultsOverlay|null) => void }
export function ResultsPanel(props: Props) {
  const [scenario,setScenario]=useState<Extract<ReturnType<typeof loadScenario>,{ok:true}>|null>(null);
  const [runs,setRuns]=useState<[PreparedRun|null,PreparedRun|null]>([null,null]),[slot,setSlot]=useState<0|1>(0);
  const [time,setTime]=useState(0),[playing,setPlaying]=useState(false),[rate,setRate]=useState(1),[error,setError]=useState('');
  const [vehicle,setVehicle]=useState(''),[task,setTask]=useState('');
  const file=useRef<HTMLInputElement>(null),pending=useRef<{slot:0|1;format:'scenario'|'plan'|'events'|'summary'}>({slot:0,format:'plan'});
  const [loading,setLoading]=useState(false),loadingRef=useRef(false);
  const currentMap=useRef({id:props.map.mapId,hash:props.mapHash});currentMap.current={id:props.map.mapId,hash:props.mapHash};
  const run=runs[slot], valid=!!run&&run.binding.mapId===props.map.mapId&&run.binding.mapContentHash===props.mapHash;
  const frame=useMemo(()=>run&&valid?frameAt(run,time,{...(vehicle?{vehicleIds:[vehicle]}:{}),...(task?{taskIds:[task]}:{})}):null,[run,valid,time,vehicle,task]);
  // Publish the visual frame in the same commit as its clock, before either canvas or timeline paints.
  useLayoutEffect(()=>{props.onFrame(frame&&run?{...frame,mapContentHash:run.binding.mapContentHash,runId:run.binding.runId}:null);},[frame,run,props.onFrame]);
  useEffect(()=>{if(!props.active||!valid)setPlaying(false);},[props.active,valid]);
  useEffect(()=>{if(!playing||!run||!valid)return;let handle=0,last=performance.now();const tick=(now:number)=>{const step=(now-last)/1000*rate;last=now;setTime(current=>{const next=Math.min(run.endS,current+step);if(next===run.endS)setPlaying(false);return next;});handle=requestAnimationFrame(tick);};handle=requestAnimationFrame(tick);return()=>cancelAnimationFrame(handle);},[playing,rate,run,valid]);
  function choose(target:0|1,format:'scenario'|'plan'|'events'|'summary') { if(loadingRef.current)return;pending.current={slot:target,format};file.current?.click(); }
  async function read(selected:File|undefined) {
    if(!selected||loadingRef.current)return;
    const target={...pending.current},map=props.map,mapHash=props.mapHash,expectedScenario=scenario,existing=runs[target.slot];
    loadingRef.current=true;setLoading(true);setError('');
    try {
      const text=await readJsonFile(selected);
      if(currentMap.current.id!==map.mapId||currentMap.current.hash!==mapHash)throw new Error('读取期间地图已变化，请为当前地图重新导入。');
      if(target.format==='scenario') {
        const result=loadScenario(text);
        if(!result.ok){setError(result.issues.map(issue=>issue.message).join('；'));return;}
        setScenario(result);setRuns([null,null]);setPlaying(false);setTime(result.scenario.timeWindow.startS);return;
      }
      if(target.format!=='plan'&&!existing)throw new Error('请先导入该组计划。');
      const result=target.format==='plan'?loadRunPlan(map,text,expectedScenario??undefined):target.format==='events'?loadRunEvents(existing!,text):loadRunSummary(existing!,text);
      if(!result.ok){setError(result.issues.map(issue=>issue.message).join('；'));return;}
      setRuns(current=>target.slot===0?[result.run,current[1]]:[current[0],result.run]);setSlot(target.slot);setTime(result.run.startS);setPlaying(false);setVehicle('');setTask('');
    }catch(reason){setError(String(reason));}finally{loadingRef.current=false;setLoading(false);}
  }
  const timeline=useMemo(()=>{const activities=run?.activities.filter(activity=>(!vehicle||activity.vehicleId===vehicle)&&(!task||activity.taskId===task))??[];const shown=activities.slice(0,500);return {count:activities.length,rows:[...new Set(shown.map(activity=>activity.vehicleId))].map(vehicleId=>({vehicleId,activities:shown.filter(activity=>activity.vehicleId===vehicleId)}))};},[run,vehicle,task]);
  const comparison=useMemo(()=>runs[0]?.summary&&runs[1]?.summary?compareSummaries(runs[0].summary,runs[1].summary):null,[runs]);
  return <div className="results-panel">
    <h3>外部调度过程与结果</h3><p>读取外部计划和过程；区间内按弧长均速展示。编辑器不执行优化求解。</p>
    <div className="tool-grid">{([0,1]as const).map(index=><div key={index}><strong>{index===0?'A':'B'}</strong><button disabled={loading} onClick={()=>choose(index,'plan')}>导入计划 {index===0?'A':'B'}</button><button disabled={loading||!runs[index]} onClick={()=>choose(index,'events')}>事件 {index===0?'A':'B'}</button><button disabled={loading||!runs[index]} onClick={()=>choose(index,'summary')}>指标 {index===0?'A':'B'}</button></div>)}</div>
    <input ref={file} hidden type="file" accept=".json,.jsonl,application/json" data-testid="result-file-input" onChange={event=>{void read(event.target.files?.[0]);event.target.value='';}}/>
    <button disabled={loading} onClick={()=>choose(0,'scenario')}>导入场景</button>{scenario?<p>场景 {scenario.scenario.scenarioId} · 内容摘要已计算</p>:<p>载入场景后再导入计划，可验证任务、车队及场景版本；未核验场景不比较差值。</p>}
    <button onClick={()=>{const example=makeSyntheticRunFiles(props.map);if(!example){setError('当前地图没有可供示例行驶的正向道路。');return;}const encoder=new TextEncoder(),entries=[{name:'scenario.json',bytes:encoder.encode(JSON.stringify(example.scenario,null,2))},{name:'plan.json',bytes:encoder.encode(JSON.stringify(example.plan,null,2))},{name:'events.jsonl',bytes:encoder.encode(example.events.map(event=>JSON.stringify(event)).join('\n'))},{name:'summary.json',bytes:encoder.encode(JSON.stringify(example.summary,null,2))}];const zip=storedZip(entries);downloadPackage(new Blob([new Uint8Array(zip).buffer],{type:'application/zip'}),'synthetic-run-example.zip');}}>下载当前地图的 synthetic 示例包</button>
    {run&&<><label>显示结果<select aria-label="显示结果组" value={slot} onChange={event=>{const next=Number(event.target.value)as 0|1;setSlot(next);setTime(runs[next]?.startS??0);setPlaying(false);}}><option value="0" disabled={!runs[0]}>A</option><option value="1" disabled={!runs[1]}>B</option></select></label><p>{run.name} · {run.source==='synthetic'?'合成示例，仅演示回放':'外部结果'}<br/>{run.binding.runId}</p>
      {!valid&&<p role="alert">地图版本已变化；此结果仍绑定旧地图，已停止覆盖显示。</p>}
      <div className="tool-grid"><button disabled={!valid} onClick={()=>{if(time>=run.endS)setTime(run.startS);setPlaying(value=>!value);}}>{playing?'暂停':'播放'}</button><button disabled={!valid} onClick={()=>{setPlaying(false);setTime(run.startS);}}>回到开始</button><select aria-label="回放倍率" value={rate} onChange={event=>setRate(Number(event.target.value))}>{[0.5,1,2,5,10].map(value=><option key={value} value={value}>{value}×</option>)}</select></div>
      <label>模拟时间 <input aria-label="模拟时间秒" type="number" min={run.startS} max={run.endS} step="0.1" value={Number(time.toFixed(2))} disabled={!valid} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)){setPlaying(false);setTime(Math.max(run.startS,Math.min(run.endS,value)));}}}/> s</label>
      <input aria-label="回放时间轴" type="range" min={run.startS} max={run.endS} step="0.05" value={time} disabled={!valid} onChange={event=>{setPlaying(false);setTime(Number(event.target.value));}}/>
      <label>车辆<select aria-label="结果车辆筛选" value={vehicle} onChange={event=>setVehicle(event.target.value)}><option value="">全部车辆</option>{run.vehicleIds.map(id=><option key={id}>{id}</option>)}</select></label><label>任务<select aria-label="结果任务筛选" value={task} onChange={event=>setTask(event.target.value)}><option value="">全部任务</option>{run.taskIds.map(id=><option key={id}>{id}</option>)}</select></label>
      <section aria-label="任务时间条" className="run-timeline"><h3>任务时间条</h3><p>{run.startS.toFixed(1)}—{run.endS.toFixed(1)} s · 点击区间跳到开始</p>
        {timeline.rows.map(row=><div className="run-timeline-row" key={row.vehicleId}><span>{row.vehicleId}</span><div className="run-timeline-track" data-testid="activity-track">{row.activities.map((activity,index)=>{const label=({travel:'行驶',wait:'等待',load:'装载',unload:'卸载'}as const)[activity.kind];return <button key={index} type="button" className={'run-activity run-activity-'+activity.kind} data-testid="activity-bar" data-t0={activity.t0} data-t1={activity.t1} aria-label={[activity.vehicleId,activity.taskId,label,activity.t0.toFixed(2)+'—'+activity.t1.toFixed(2)+' s'].filter(Boolean).join(' ')} title={[activity.taskId,label,activity.t0.toFixed(2)+'—'+activity.t1.toFixed(2)+' s'].filter(Boolean).join(' · ')} disabled={!valid} style={{left:100*(activity.t0-run.startS)/Math.max(0.001,run.endS-run.startS)+'%',width:100*(activity.t1-activity.t0)/Math.max(0.001,run.endS-run.startS)+'%'}} onClick={()=>{setPlaying(false);setTime(activity.t0);}}>{label}</button>;})}<span className="run-time-cursor" style={{left:100*(time-run.startS)/Math.max(0.001,run.endS-run.startS)+'%'}}/></div></div>)}
        {timeline.count>500&&<p>当前筛选有 {timeline.count} 项活动，展示前 500 项；可用车辆或任务筛选缩小范围。</p>}
      </section>
      <ul aria-label="当前车辆状态">{frame?.vehicles.map(item=><li key={item.vehicleId}>{item.vehicleId} · {({travel:'行驶',wait:'等待',load:'装载',unload:'卸载',idle:'空闲',gap:'资料缺口'}as const)[item.state]}{item.note?' · '+item.note:''}</li>)}</ul>
      {run.summary&&<section aria-label="本组结果指标"><h3>结果指标</h3><table><thead><tr><th>指标</th><th>值</th></tr></thead><tbody>{run.summary.metrics.map(metric=><tr key={metric.key}><td>{metric.key} ({metric.unit})<details><summary>口径与时域</summary>{metric.definition}<p>{metric.window.startS}—{metric.window.endS} s · {metric.source}</p></details></td><td>{metric.value??'未提供'}</td></tr>)}</tbody></table></section>}
      {run.issues.map((issue,index)=><p key={index}>{issue.message}</p>)}
    </>}
    {comparison&&<section aria-label="同场景结果比较"><h3>A / B 指标</h3>{!comparison.comparable||!runs[0]?.scenarioVerified||!runs[1]?.scenarioVerified?<p>{!runs[0]?.scenarioVerified||!runs[1]?.scenarioVerified?'需要验证同一场景内容后才能比较差值。':comparison.reasons.join('；')}</p>:<table><thead><tr><th>指标</th><th>A</th><th>B</th><th>差值</th></tr></thead><tbody>{comparison.metrics.map(metric=><tr key={metric.key}><td>{metric.key} ({metric.unit})<details><summary>口径与时域</summary>{metric.definition}<pre>{JSON.stringify(metric.window)}</pre></details></td><td>{metric.a??'未提供'}</td><td>{metric.b??'未提供'}</td><td>{metric.delta??'不可计算'}</td></tr>)}</tbody></table>}</section>}
    {error&&<p role="alert" className="inline-error">{error}</p>}
  </div>;
}
