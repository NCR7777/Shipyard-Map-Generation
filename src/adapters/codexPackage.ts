import type { DrawingConfig, RasterAssetStorePort } from '../editor/projectController';
import type { BackgroundLayer, Facility, Polygon, Vec2, YardMap, Zone } from '../domain/model';
import { contentHash, serializeMap } from '../domain/serialization';
import { compileMap } from '../compiler/routing';
import { getRoadPath, type ResolvedPath } from '../geometry/roadPath';
import { backgroundDeterminant } from '../geometry/backgrounds';
import { IndexedDBProjectStore } from './projectStore';
import { decodeRaster } from './rasterFiles';
import { storedZip } from './storedZip';

interface Entry {name:string;bytes:Uint8Array}
export interface CodexCrop {
  entityType:'facilities'|'zones';entityId:string;kind:string;layerId:string;rawImage:string;outlineImage:string;
  sourceAssetId:string;sourceSha256:string;pixelRect:{x:number;y:number;width:number;height:number};
  imageToWorld:BackgroundLayer['imageToWorld'];cropPixelToWorld:BackgroundLayer['imageToWorld'];
}
export interface CodexPackageManifest {
  formatVersion:'1.0';mapId:string;baseMapContentHash:string;coordinateFrame:YardMap['coordinateFrame'];
  classificationScope:string;assets:{assetId:string;path:string;declaredPath:string;sha256:string}[];
  crops:CodexCrop[];unclassified:{entityType:'facilities'|'zones';entityId:string;kind:string;imageRefs:string[]}[];
  missing:string[];files:{path:string;byteLength:number;fileSha256:string}[];
}
const encoder=new TextEncoder();
function pixel(t:BackgroundLayer['imageToWorld'],world:readonly number[]):Vec2 {
  const d=backgroundDeterminant(t),x=world[0]!-t[4],y=world[1]!-t[5];if(!d)throw Error('BACKGROUND_TRANSFORM_SINGULAR');
  return [(t[3]*x-t[2]*y)/d,(-t[1]*x+t[0]*y)/d];
}
function outline(context:CanvasRenderingContext2D,polygon:Polygon,convert:(point:readonly number[])=>Vec2):void {
  context.beginPath();for(const ring of [polygon.outer,...polygon.holes])for(const [index,point] of ring.entries()){const [x,y]=convert(point);if(index===0)context.moveTo(x,y);else context.lineTo(x,y);}context.stroke();
}
function road(context:CanvasRenderingContext2D,path:ResolvedPath,convert:(point:readonly number[])=>Vec2):void {
  context.beginPath();context.moveTo(...convert(path.anchors[0]!));path.spans.forEach((span,i)=>{const end=convert(path.anchors[i+1]!);if(span.kind==='line')context.lineTo(...end);else context.bezierCurveTo(...convert(span.control1),...convert(span.control2),...end);});context.stroke();
}
function canvas(width:number,height:number):{canvas:HTMLCanvasElement;context:CanvasRenderingContext2D}{const value=document.createElement('canvas');value.width=width;value.height=height;const context=value.getContext('2d');if(!context)throw Error('CANVAS_UNAVAILABLE');return {canvas:value,context};}
async function encoded(value:HTMLCanvasElement):Promise<Uint8Array>{const blob=await new Promise<Blob>((resolve,reject)=>value.toBlob(blob=>blob?resolve(blob):reject(Error('IMAGE_ENCODE_FAILED')),'image/png'));return new Uint8Array(await blob.arrayBuffer());}
async function fileHash(bytes:Uint8Array):Promise<string>{const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer);return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');}
const safeName=(id:string)=>encodeURIComponent(id);

/** Snapshot export through the existing local asset store. No upload or map mutation. */
export async function buildCodexPackage(input:{map:YardMap;drawing:DrawingConfig;projectId:string;store?:RasterAssetStorePort}):Promise<{blob:Blob;filename:string;manifest:CodexPackageManifest}> {
  const map=structuredClone(input.map),drawing=structuredClone(input.drawing),store=input.store??new IndexedDBProjectStore();
  const entries:Entry[]=[],add=(name:string,value:unknown)=>entries.push({name,bytes:encoder.encode(JSON.stringify(value,null,2)+'\n')});
  entries.push({name:'map.json',bytes:encoder.encode(serializeMap(map))});add('compiled-map.json',compileMap(map));add('drawing-defaults.json',{profile:'quick_trace_v1',drawing,source:'design_assumption'});add('sources.json',map.sources);
  const manifest:CodexPackageManifest={formatVersion:'1.0',mapId:map.mapId,baseMapContentHash:contentHash(map),coordinateFrame:map.coordinateFrame,classificationScope:'Only semantic kind/name with evidence. Preserve geometry, IDs, coordinate frame, road width/direction, resources and physical unknowns.',assets:[],crops:[],unclassified:[],missing:[],files:[]};
  const objects: {entityType:'facilities'|'zones';entityId:string;entity:Facility|Zone}[]=(['facilities','zones'] as const).flatMap(entityType=>Object.entries(map[entityType]).map(([entityId,entity])=>({entityType,entityId,entity})));
  for(const object of objects)if(object.entity.kind==='building'||object.entity.kind==='unclassified')manifest.unclassified.push({entityType:object.entityType,entityId:object.entityId,kind:object.entity.kind,imageRefs:[]});
  const loaded=new Map<string,Awaited<ReturnType<typeof store.getAssetBytes>>>();
  for(const [assetId,asset]of Object.entries(map.assets)){
    const data=await store.getAssetBytes(input.projectId,asset.sha256);loaded.set(assetId,data);
    if(!data)throw Error('PACKAGE_ASSET_MISSING: '+assetId+'；请在原工程重新关联底图后导出。');
    if(data.sha256!==asset.sha256)throw Error('PACKAGE_ASSET_HASH_MISMATCH: '+assetId);
    if(data.mimeType!==asset.mediaType||asset.widthPx!==undefined&&data.width!==asset.widthPx||asset.heightPx!==undefined&&data.height!==asset.heightPx)throw Error('PACKAGE_ASSET_METADATA_MISMATCH: '+assetId);
    const declaredSafe=asset.path.startsWith('assets/')&&!asset.path.includes('\\')&&!asset.path.includes(':')&&asset.path.split('/').every(part=>part&&part!=='.'&&part!=='..');
    const path=declaredSafe?asset.path:'assets/'+safeName(assetId)+'.'+(data.mimeType==='image/jpeg'?'jpg':data.mimeType==='image/png'?'png':'webp');
    entries.push({name:path,bytes:new Uint8Array(data.bytes)});manifest.assets.push({assetId,path,declaredPath:asset.path,sha256:asset.sha256});
  }
  for(const [layerId,layer]of Object.entries(map.backgroundLayers)){
    const data=loaded.get(layer.assetId);if(!data)throw Error('PACKAGE_LAYER_ASSET_MISSING: '+layerId);
    const decoded=await decodeRaster(data);
    try {
      const overviewScale=Math.min(1,2048/Math.max(data.width,data.height)),overview=canvas(Math.max(1,Math.round(data.width*overviewScale)),Math.max(1,Math.round(data.height*overviewScale)));
      overview.context.drawImage(decoded.image,0,0,overview.canvas.width,overview.canvas.height);
      const overviewScaleX=overview.canvas.width/data.width,overviewScaleY=overview.canvas.height/data.height;
      const overviewConvert=(p:readonly number[]):Vec2=>{const q=pixel(layer.imageToWorld,p);return [q[0]*overviewScaleX,q[1]*overviewScaleY];};
      overview.context.lineWidth=1.5;overview.context.strokeStyle='#f8d04b';for(const roadId of Object.keys(map.roads))road(overview.context,getRoadPath(map,roadId),overviewConvert);
      overview.context.font='12px sans-serif';overview.context.fillStyle='#ffffff';overview.context.strokeStyle='#24e5cf';
      for(const object of objects){outline(overview.context,object.entity.boundary,overviewConvert);const p=overviewConvert(object.entity.boundary.outer[0]);overview.context.fillText(object.entityId,p[0]+2,p[1]-2);}
      entries.push({name:'overview/'+safeName(layerId)+'.png',bytes:await encoded(overview.canvas)});
      add('calibration/'+safeName(layerId)+'.json',{mapId:map.mapId,mapContentHash:manifest.baseMapContentHash,coordinateFrame:map.coordinateFrame,layer,asset:map.assets[layer.assetId],overviewScaleX,overviewScaleY,overviewPixelToWorld:[layer.imageToWorld[0]/overviewScaleX,layer.imageToWorld[1]/overviewScaleX,layer.imageToWorld[2]/overviewScaleY,layer.imageToWorld[3]/overviewScaleY,layer.imageToWorld[4],layer.imageToWorld[5]]});
      for(const object of objects){
        const points=object.entity.boundary.outer.map(p=>pixel(layer.imageToWorld,p)),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
        const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
        if(maxX<0||maxY<0||minX>=data.width||minY>=data.height)continue;
        const padding=Math.max(48,0.35*Math.max(maxX-minX,maxY-minY));
        const x=Math.max(0,Math.floor(minX-padding)),y=Math.max(0,Math.floor(minY-padding)),width=Math.min(data.width,Math.ceil(maxX+padding))-x,height=Math.min(data.height,Math.ceil(maxY+padding))-y;
        if(width<=0||height<=0)continue;
        const crop=canvas(width,height);crop.context.drawImage(decoded.image,x,y,width,height,0,0,width,height);
        const stem='crops/'+safeName(layerId)+'/'+safeName(object.entityId),rawImage=stem+'.raw.png',outlineImage=stem+'.outline.png';
        entries.push({name:rawImage,bytes:await encoded(crop.canvas)});
        const convert=(p:readonly number[]):Vec2=>{const q=pixel(layer.imageToWorld,p);return [q[0]-x,q[1]-y];};
        crop.context.lineWidth=2;crop.context.strokeStyle='#fde047';for(const roadId of Object.keys(map.roads))road(crop.context,getRoadPath(map,roadId),convert);
        crop.context.strokeStyle='#25e7d0';crop.context.fillStyle='#ffffff';crop.context.font='14px sans-serif';
        for(const neighbour of objects){outline(crop.context,neighbour.entity.boundary,convert);const p=convert(neighbour.entity.boundary.outer[0]);crop.context.fillText(neighbour.entityId,p[0]+3,p[1]-3);}
        crop.context.strokeStyle='#ff496b';crop.context.lineWidth=3;outline(crop.context,object.entity.boundary,convert);
        entries.push({name:outlineImage,bytes:await encoded(crop.canvas)});
        const t=layer.imageToWorld,cropPixelToWorld:BackgroundLayer['imageToWorld']=[t[0],t[1],t[2],t[3],t[0]*x+t[2]*y+t[4],t[1]*x+t[3]*y+t[5]];
        manifest.crops.push({entityType:object.entityType,entityId:object.entityId,kind:object.entity.kind,layerId,rawImage,outlineImage,sourceAssetId:layer.assetId,sourceSha256:data.sha256,pixelRect:{x,y,width,height},imageToWorld:[...t],cropPixelToWorld});
        manifest.unclassified.find(item=>item.entityType===object.entityType&&item.entityId===object.entityId)?.imageRefs.push(rawImage);
      }
    } finally {decoded.dispose();}
  }
  for(const object of manifest.unclassified)if(!object.imageRefs.length)manifest.missing.push(object.entityType+'/'+object.entityId+': no calibrated source image coverage');
  if(!Object.keys(map.backgroundLayers).length)manifest.missing.push('No calibrated background layer; image classification evidence unavailable');
  add('unclassified.json',manifest.unclassified);add('semantic_patch.template.json',{formatVersion:'1.0',mapId:map.mapId,baseMapContentHash:manifest.baseMapContentHash,patches:[]});
  entries.push({name:'README.txt',bytes:encoder.encode('FAST01 Codex 补标包\nmap.json 保持导出快照，baseMapContentHash 沿用原算法。资产以 manifest.assets 映射原声明路径；original bytes 不改动。calibration 保留像素变换。*.raw.png 无矢量覆盖，*.outline.png 是 ID 对照；二者不得混淆。请依据原图及全厂总览补 kind/name，只输出 semantic_patch.json，不重写地图。不猜承载、净高、真实产能、服务时间。低把握保留通用类别。接入与时序假设必须另行声明。\n')});
  for(const entry of entries)manifest.files.push({path:entry.name,byteLength:entry.bytes.length,fileSha256:await fileHash(entry.bytes)});
  add('manifest.json',manifest);const zip=storedZip(entries);
  return {blob:new Blob([new Uint8Array(zip).buffer],{type:'application/zip'}),filename:map.mapId+'-'+manifest.baseMapContentHash.slice(0,10)+'-codex.zip',manifest};
}
export function downloadPackage(blob:Blob,filename:string):void {const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
