"""MQ01 read-only calibrated-image and declared-width overlay. Never writes input maps.
Example: python scripts/MQ01_imagery.py --map PATH --node ID --span 600 --mpp 0.5 --out PREFIX
Outputs source-only, original-map overlay, paired review image and a SHA-bound receipt.
Pixels are sampled at output cell centres. Source coordinates use declared pixel corners;
subtracting 0.5 converts to raster sample indices. No geometry snapping or map reprojection.
"""
import argparse, hashlib, json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from shapely.geometry import LineString, Polygon

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def read(path): return json.loads(path.read_text(encoding='utf-8-sig'))
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--map',required=True,type=Path);p.add_argument('--node');p.add_argument('--road');p.add_argument('--entity',action='append',default=[]);p.add_argument('--center',nargs=2,type=float,metavar=('X','Y'));p.add_argument('--reference-root',type=Path,help='Original project directory containing map.json and reference/');p.add_argument('--label',default='BEFORE');p.add_argument('--highlight-road',action='append',default=[]);p.add_argument('--all-boundaries',action='store_true');p.add_argument('--vector-only',action='store_true',help='Explicit missing-image mode; never labels blank canvas satellite imagery');p.add_argument('--span',type=float,default=600);p.add_argument('--mpp',type=float,default=.5);p.add_argument('--out',required=True,type=Path);a=p.parse_args()
 if sum(v is not None for v in [a.node,a.road,a.center])!=1:p.error('choose exactly one --node, --road or --center')
 if not 0<a.mpp<=10 or not 0<a.span<=5000:p.error('invalid scale/extent')
 n=math.ceil(a.span/a.mpp)
 if n>4096:p.error('output side exceeds 4096 pixels')
 m=read(a.map);before=sha(a.map);referenceRoot=a.reference_root or a.map.parent;referenceMap=referenceRoot/'map.json';referenceMapSha=sha(referenceMap);referenceFrame=read(referenceMap)['coordinateFrame']
 if m['coordinateFrame']!=referenceFrame:raise SystemExit('blocked_frame_mismatch: trial and frozen reference coordinateFrame differ')
 gp=referenceRoot/'reference/georeference.json';g=read(gp);ip=referenceRoot/'reference/satellite_local.jpg'
 if not ip.exists() and not a.vector_only:raise SystemExit('blocked_evidence: standalone calibrated source image missing')
 if a.vector_only and ip.exists():raise SystemExit('vector_only_requires_missing_source_image: available imagery must not be mislabeled missing')
 anchor=m['coordinateFrame']['geographicAnchor']
 if not a.vector_only:im=np.asarray(Image.open(ip).convert('RGB'));h,w=im.shape[:2]
 if a.center:cx,cy=a.center
 elif a.node:cx,cy=m['nodes'][a.node]['position'][:2]
 else:
  road=m['roads'][a.road];pa=m['nodes'][road['fromNodeId']]['position'];pb=m['nodes'][road['toNodeId']]['position'];cx=(pa[0]+pb[0])/2;cy=(pa[1]+pb[1])/2
 extent=[cx-a.span/2,cy-a.span/2,cx+a.span/2,cy+a.span/2];step=a.span/n
 if a.vector_only:
  base=Image.new('RGB',(n,n),(245,245,245));valid=None;method='vector-only canvas; standalone source imagery missing; no pixel registration claimed'
 else:
  x,y=np.meshgrid(extent[0]+(np.arange(n)+.5)*step,extent[3]-(np.arange(n)+.5)*step)
  if 'referenceImage' in g:
   ri=g['referenceImage'];A,B,C,D,E,F=ri['imageToWorld'];det=A*D-B*C
   if list(im.shape[1::-1])!=[ri['widthPx'],ri['heightPx']]:raise ValueError('declared source dimensions differ')
   if g['origin_utm']!=anchor['origin'][:2] or g['theta_rad']!=anchor['rotationRad'] or g['utm_crs']!=anchor['crs']:raise ValueError('georeference anchor mismatch')
   u=(D*(x-E)-C*(y-F))/det;v=(-B*(x-E)+A*(y-F))/det;method='inverse declared imageToWorld affine on pixel-corner coordinates'
  elif 'sourceBounds' in g:
   if [w,h]!=g['pixelSize']:raise ValueError('declared source dimensions differ')
   theta=anchor.get('rotationRad',0);E=anchor['origin'][0]+math.cos(theta)*x-math.sin(theta)*y;N=anchor['origin'][1]+math.sin(theta)*x+math.cos(theta)*y;sx,sy=Transformer.from_crs(anchor['crs'],'EPSG:3857',always_xy=True).transform(E,N);b=g['sourceBounds'];u=(sx-b[0])/(b[2]-b[0])*w;v=(b[3]-sy)/(b[3]-b[1])*h;method='exact per-output-pixel pyproj inverse local->UTM->EPSG3857->source bounds'
  else:raise SystemExit('blocked_evidence: unsupported/unconfirmed image registration')
  valid=(u>=0)&(u<w)&(v>=0)&(v<h);u=np.clip(u-.5,0,w-1);v=np.clip(v-.5,0,h-1);ix=np.floor(u).astype(int);iy=np.floor(v).astype(int);jx=np.minimum(ix+1,w-1);jy=np.minimum(iy+1,h-1);fx=(u-ix)[...,None];fy=(v-iy)[...,None]
  rgb=(im[iy,ix]*(1-fx)*(1-fy)+im[iy,jx]*fx*(1-fy)+im[jy,ix]*(1-fx)*fy+im[jy,jx]*fx*fy).round().astype('uint8');rgb[~valid]=[96,96,96];base=Image.fromarray(rgb)
 overlay=Image.new('RGBA',(n,n));d=ImageDraw.Draw(overlay)
 def xy(pt):return ((pt[0]-extent[0])/step,(extent[3]-pt[1])/step)
 def polygon(value):return Polygon([p[:2] for p in value['outer']],[[p[:2] for p in ring] for ring in value.get('holes',[])])
 def paint(shape,color):
  nonlocal overlay,d
  layer=Image.new('RGBA',(n,n));ld=ImageDraw.Draw(layer)
  for part in getattr(shape,'geoms',[shape]):
   if part.geom_type!='Polygon':continue
   ld.polygon([xy(t) for t in part.exterior.coords],fill=color,outline=(*color[:3],240))
   for ring in part.interiors:ld.polygon([xy(t) for t in ring.coords],fill=(0,0,0,0))
  overlay=Image.alpha_composite(overlay,layer);d=ImageDraw.Draw(overlay)
 if a.all_boundaries:
  for group in ['facilities','zones']:
   color=(40,235,100,220) if group=='facilities' else (60,130,255,220)
   for entity in m[group].values():
    for ring in [entity['boundary']['outer'],*entity['boundary'].get('holes',[])]:d.line([xy(t) for t in ring],fill=color,width=1)
  d.line([xy(t) for t in m['siteBoundary']['outer']],fill=(210,210,210,240) if not a.vector_only else (60,60,60,240),width=1)
 for eid in a.entity:
  group='zones' if eid in m['zones'] else 'facilities';e=m[group][eid];paint(polygon(e['boundary']),(40,100,255,85) if group=='zones' else (40,255,100,70))
  q=xy(polygon(e['boundary']).representative_point().coords[0]);d.text(q,eid,fill='white')
 visible=[]
 for rid,r in m['roads'].items():
  pts=[m['nodes'][r['fromNodeId']]['position'],*r['shapePoints'],m['nodes'][r['toNodeId']]['position']];line=LineString([p[:2] for p in pts]);width=r['widthM'];radius=width['value']/2 if width['state']=='known' else 0;band=polygon(r['corridorPolygon']) if r.get('corridorPolygon') else (line.buffer(radius,quad_segs=64,cap_style='round',join_style='round') if radius>0 else None);bb=band.bounds if band is not None else line.bounds
  if bb[2]<extent[0] or bb[0]>extent[2] or bb[3]<extent[1] or bb[1]>extent[3]:continue
  if band is not None:
   paint(band,(255,210,0,85))
   for eid in a.entity:
    e=m['zones'].get(eid,m['facilities'].get(eid));overlap=band.intersection(polygon(e['boundary']))
    if not overlap.is_empty:paint(overlap,(255,0,200,200))
  color=(255,45,30,230)
  if rid in a.highlight_road:color=(0,255,255,255) if a.highlight_road.index(rid)%2==0 else (255,0,255,255)
  d.line([xy(t) for t in pts],fill=color,width=max(1,round(.7/step)))
  if rid in a.highlight_road:d.text(xy(line.interpolate(.5,normalized=True).coords[0]),rid,fill=color)
  visible.append({'id':rid,'declaredWidth':width,'lengthM':line.length})
 for nid,node in m['nodes'].items():
  q=xy(node['position'])
  if 0<=q[0]<n and 0<=q[1]<n:d.ellipse((q[0]-2,q[1]-2,q[0]+2,q[1]+2),fill=(0,230,255,255))
 center=(n/2,n/2);d.ellipse((center[0]-10,center[1]-10,center[0]+10,center[1]+10),outline='white',width=2)
 annotated=Image.alpha_composite(base.convert('RGBA'),overlay).convert('RGB');prefix=a.out;prefix.parent.mkdir(parents=True,exist_ok=True)
 def title(img,text):
  out=Image.new('RGB',(n,n+54),'white');out.paste(img,(0,54));dd=ImageDraw.Draw(out);dd.text((10,7),text,fill='black');dd.text((10,27),f'{a.span:g}m x {a.span:g}m | {step:g}m/pixel | top = local +Y | '+('NO SOURCE IMAGERY; vector-only' if a.vector_only else 'gray outside supplied image'),fill='black');return out
 bimg=title(base,'VECTOR ONLY / SOURCE IMAGERY MISSING' if a.vector_only else 'SOURCE JPEG / ORIGINAL CROP');oimg=title(annotated,a.label+(' VECTOR ONLY (IMAGERY MISSING)' if a.vector_only else '')+': declared road width (yellow), centerline red; nodes cyan; overlap magenta');pair=Image.new('RGB',(2*n,n+54));pair.paste(bimg);pair.paste(oimg,(n,0));files={}
 for suffix,img in [('source',bimg),('after' if a.label.upper().startswith('AFTER') else 'before',oimg),('pair',pair)]:
  dest=prefix.with_name(prefix.name+'-'+suffix+'.png');img.save(dest);files[suffix]={'path':str(dest.resolve()),'sha256':sha(dest)}
 preview=pair.copy();preview.thumbnail((1200,800));previewPath=prefix.with_name(prefix.name+'-pair-preview.jpg');preview.save(previewPath,quality=85);files['preview']={'path':str(previewPath.resolve()),'sha256':sha(previewPath),'supersedes':'initial square-cap rendition'}
 receipt={'mapPath':str(a.map.resolve()),'mapSha256Before':before,'mapSha256After':sha(a.map),'mapUnchanged':sha(a.map)==before,'mapId':m['mapId'],'revision':m['revision'],'imagePath':None if a.vector_only else str(ip.resolve()),'imageSha256':None if a.vector_only else sha(ip),'imageEvidenceStatus':'missing_vector_only' if a.vector_only else 'calibrated_reference_jpeg','allBoundariesRendered':a.all_boundaries,'georeferencePath':str(gp.resolve()),'georeferenceSha256':sha(gp),'coordinateFrame':m['coordinateFrame'],'bandMethod':'corridorPolygon (holes preserved) preferred; otherwise round cap/join quad_segs=64; bbox includes full band','previousArtifactStatus':'Initial square-cap previews superseded and regenerated; no map data changed','highlightRoadIds':a.highlight_road,'highlightMeaning':'ordered highlighted centerlines alternate cyan/magenta; other centerlines red; white ring fixed review center','renderLabel':a.label,'referenceMapPath':str(referenceMap.resolve()),'referenceMapSha256':referenceMapSha,'referenceMapUnchanged':sha(referenceMap)==referenceMapSha,'frameMatchesReferenceExactly':m['coordinateFrame']==referenceFrame,'selectedCenter':a.center,'selectedEntities':a.entity,'selectedNode':a.node,'selectedRoad':a.road,'localExtentM':extent,'mPerPixel':step,'sampling':method if a.vector_only else method+'; bilinear source sampling; source corner coordinate minus 0.5 for sample index','outsideImageFraction':None if a.vector_only else float(1-valid.mean()),'visibleRoads':visible,'outputs':files,'status':'rendered_existing_trial_after_without_mutation' if a.label.upper().startswith('AFTER') else 'before_only_review_artifacts; no map edit or claimed after','limitations':['Declared width bands are not verified clearance or safety.','Image acquisition date and absolute accuracy unknown.','No inference that gray/no-data is empty land.','Unprovided source GeoTIFF not visually inspected.']}
 prefix.with_suffix('.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps({'map':m['mapId'],'files':files,'unchanged':receipt['mapUnchanged'],'outsideImageFraction':receipt['outsideImageFraction']},ensure_ascii=False))
if __name__=='__main__':main()
