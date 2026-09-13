"""MQ01 full offline geometry inventory. Read-only; core receipt is mandatory.
Uses installed Shapely for planar metrics, never for authoritative JSON edits or routing.
Every pair in the declared scope is visited (no output cap). Thresholds generate
review candidates, never an implicit merge, connection or operating permission.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import itertools
import json
import math
from pathlib import Path
import shapely
from shapely.geometry import LineString, Point, Polygon

RULE_VERSION = 'MQ01-1'
EPS_M = 1e-7
PARAMETERS = {'nearNodeCandidateM': 30.0, 'shortRoadFloorM': 5.0,
              'parallelAngleDeg': 10.0, 'parallelDistanceCapM': 30.0,
              'clusterDiameterReviewM': 60.0, 'strictGeometryToleranceM': EPS_M,
              'roundBufferQuadrantSegments': 64,
              'thresholdMeaning': 'candidate generation only, not evidence of an error'}
PL = 'sr02.planning'

def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def poly(boundary):
    return Polygon([p[:2] for p in boundary['outer']],
                   [[p[:2] for p in ring] for ring in boundary.get('holes', [])])

def points(m, road):
    return [m['nodes'][road['fromNodeId']]['position'], *road['shapePoints'],
            m['nodes'][road['toNodeId']]['position']]

def planning(entity):
    return entity.get('extensions', {}).get(PL, {})

def reference(entity):
    ext = entity.get('extensions', {})
    return ext.get('shipyard.reference', ext.get('weihai.reference', {}))

def angle(a, b):
    return math.degrees(math.atan2(a[0]*b[1]-a[1]*b[0], a[0]*b[0]+a[1]*b[1]))

def vector(a, b):
    return b[0]-a[0], b[1]-a[1]

def strict_between(a, b, c):
    return LineString([a[:2], c[:2]]).distance(Point(b[:2])) <= EPS_M and min(a[2], c[2])-EPS_M <= b[2] <= max(a[2], c[2])+EPS_M and abs(a[2]-b[2])+abs(b[2]-c[2])-abs(a[2]-c[2]) <= EPS_M

def same_plane(a, b):
    values=[p[2] for p in a+b]
    return bool(values) and max(values)-min(values)<=EPS_M

def scan(m):
    records, coverage = [], {}
    slot_paths={}
    for kind in ['facilities','zones']:
        for owner_id,owner in m[kind].items():
            for index,slot in enumerate(planning(owner).get('slots',[])):
                slot_paths['slots/'+slot['id']]=f'/{kind}/{owner_id}/extensions/sr02.planning/slots/{index}'
    incident = defaultdict(list)
    lines = {rid: LineString([p[:2] for p in points(m,r)]) for rid,r in m['roads'].items()}
    nodes = {nid: Point(n['position'][:2]) for nid,n in m['nodes'].items()}
    polygons = {f'{kind}/{fid}': poly(f['boundary']) for kind in ['facilities','zones'] for fid,f in m[kind].items()}
    polygons['siteBoundary'] = poly(m['siteBoundary'])
    def add(rule, code, ids, geometry, status='candidate', **metrics):
        bounds = list(geometry.bounds) if geometry is not None and not geometry.is_empty else None
        records.append({'rule':rule,'code':code,'ids':ids,'jsonPaths':[slot_paths.get(i,'/'+i) for i in ids],
                        'bboxXY':bounds,'status':status,'metrics':metrics})
    for rid,r in m['roads'].items():
        for nid in [r['fromNodeId'],r['toNodeId']]: incident[nid].append(rid)
    # Whole-node scan, not only nodes which happen to lack an existing edge.
    count = 0
    for nid,n in m['nodes'].items():
        count += 1
        roads = incident[nid]
        if not roads: add('MQ-N01','ISOLATED_NODE',['nodes/'+nid],nodes[nid])
        if len(roads)==2:
            tangents=[]
            for rid in roads:
                p=points(m,m['roads'][rid]); p=p if m['roads'][rid]['fromNodeId']==nid else p[::-1]
                nxt=next((x for x in p[1:] if math.dist(p[0][:2],x[:2])>EPS_M),None)
                if nxt: tangents.append(vector(p[0],nxt))
            deviation=abs(180-abs(angle(*tangents))) if len(tangents)==2 else None
            add('MQ-N01','DEGREE_TWO_REVIEW',['nodes/'+nid,*['roads/'+r for r in roads]],nodes[nid],
                deviationFromStraightDeg=deviation,nodeKind=n['kind'],hasBusinessReference=any(p['nodeId']==nid for k in ['servicePoints','accessPoints'] for p in m[k].values()))
    coverage['nodes']={'status':'checked','visited':count,'total':len(nodes)}
    short_edges=[]
    for rid,r in m['roads'].items():
        width=r['widthM']; threshold=max(PARAMETERS['shortRoadFloorM'],width.get('value',0)/2 if width['state']=='known' else 0)
        if lines[rid].length<=threshold:
            short_edges.append((r['fromNodeId'],r['toNodeId'],rid))
            add('MQ-N01','SHORT_ROAD_REVIEW',['roads/'+rid],lines[rid],lengthM=lines[rid].length,thresholdM=threshold)
        p=points(m,r)
        for i,b in enumerate(p[1:-1],1):
            if strict_between(p[i-1],b,p[i+1]): add('MQ-N01','REDUNDANT_SHAPE_POINT',['roads/'+rid],Point(b[:2]),index=i-1)
    coverage['roadShapePoints']={'status':'checked','visited':sum(len(r['shapePoints']) for r in m['roads'].values())}
    connected = {frozenset([a,b]):rid for a,b,rid in short_edges}
    node_pairs=0
    for (a,pa),(b,pb) in itertools.combinations(nodes.items(),2):
        node_pairs+=1; distance=pa.distance(pb)
        if distance<=PARAMETERS['nearNodeCandidateM']:
            zsame=abs(m['nodes'][a]['position'][2]-m['nodes'][b]['position'][2])<=EPS_M
            add('MQ-N02','NEAR_NODE_PAIR',['nodes/'+a,'nodes/'+b],LineString([pa,pb]),
                distanceM=distance,shortConnectingRoad=connected.get(frozenset([a,b])),sameDeclaredZ=zsame,
                elevationEvidence='same declared Z is not a surveyed physical-level confirmation')
    coverage['nodePairs']={'status':'checked','visited':node_pairs,'total':len(nodes)*(len(nodes)-1)//2}
    adjacency=defaultdict(set)
    for a,b,_ in short_edges: adjacency[a].add(b);adjacency[b].add(a)
    seen=set()
    for seed in sorted(adjacency):
        if seed in seen: continue
        pending=[seed]; group=set()
        while pending:
            n=pending.pop()
            if n in group: continue
            group.add(n); pending.extend(adjacency[n]-group)
        seen.update(group)
        diameter=max((nodes[a].distance(nodes[b]) for a,b in itertools.combinations(group,2)),default=0)
        geom=LineString([m['nodes'][n]['position'][:2] for n in sorted(group)])
        add('MQ-N02','SHORT_EDGE_COMPONENT_REVIEW',['nodes/'+n for n in sorted(group)],geom,
            diameterM=diameter,singleJunctionUnconfirmed=True,
            exceedsClusterDiameter=diameter>PARAMETERS['clusterDiameterReviewM'])
    # Exact intersection plus per-segment directional/projection candidates; no route inference.
    road_pairs=0
    for (a,la),(b,lb) in itertools.combinations(lines.items(),2):
        road_pairs+=1
        intersection=la.intersection(lb)
        shared=set([m['roads'][a]['fromNodeId'],m['roads'][a]['toNodeId']]) & set([m['roads'][b]['fromNodeId'],m['roads'][b]['toNodeId']])
        if intersection.length>EPS_M:
            add('MQ-R01','COINCIDENT_ROAD_INTERVAL',['roads/'+a,'roads/'+b],intersection,overlapLengthM=intersection.length)
        elif not intersection.is_empty:
            # An exact shared endpoint represents only that endpoint, not a second crossing elsewhere.
            rest=intersection
            for n in shared: rest=rest.difference(nodes[n].buffer(EPS_M))
            if not rest.is_empty: add('MQ-R01','CROSSING_WITHOUT_SHARED_NODE',['roads/'+a,'roads/'+b],rest,
                sameDeclaredZ=all(abs(p[2]-points(m,m['roads'][a])[0][2])<=EPS_M for p in points(m,m['roads'][a])+points(m,m['roads'][b])))
        if la.distance(lb)>PARAMETERS['parallelDistanceCapM']: continue
        candidates=[]
        ap,bp=list(la.coords),list(lb.coords)
        for aa,ab in zip(ap,ap[1:]):
            va=vector(aa,ab); length=math.hypot(*va)
            if length<=EPS_M: continue
            for ba,bb in zip(bp,bp[1:]):
                vb=vector(ba,bb); secondLength=math.hypot(*vb)
                if secondLength<=EPS_M: continue
                cosine=abs((va[0]*vb[0]+va[1]*vb[1])/(length*secondLength))
                if cosine < math.cos(math.radians(PARAMETERS['parallelAngleDeg'])): continue
                projection=sorted(((p[0]-aa[0])*va[0]/length+(p[1]-aa[1])*va[1]/length for p in [ba,bb]))
                overlap=max(0,min(length,projection[1])-max(0,projection[0]))
                spacing=LineString([aa,ab]).distance(LineString([ba,bb]))
                if overlap>max(5,spacing) and spacing<=PARAMETERS['parallelDistanceCapM']:
                    candidates.append({'overlapProjectionM':overlap,'minimumSegmentSpacingM':spacing})
        if candidates and intersection.length<=EPS_M:
            add('MQ-R01','PARALLEL_ROAD_INTERVAL_REVIEW',['roads/'+a,'roads/'+b],la.union(lb),intervals=candidates)
    coverage['roadPairs']={'status':'checked','visited':road_pairs,'total':len(lines)*(len(lines)-1)//2}
    # Polygons: preserve concavities/holes; rectangularity is descriptive, never an editing instruction.
    vertices=0
    for ident,p in polygons.items():
        entity=m['siteBoundary'] if ident=='siteBoundary' else m[ident.split('/')[0]][ident.split('/')[1]]['boundary']
        if not p.is_valid: add('MQ-P01','INVALID_POLYGON',[ident],p,status='declared_conflict',reason=shapely.is_valid_reason(p))
        for ring_index,ring in enumerate([entity['outer'],*entity.get('holes',[])]):
            vertices+=len(ring)-1
            for i,b in enumerate(ring[:-1]):
                a,c=ring[(i-1)%(len(ring)-1)],ring[(i+1)%(len(ring)-1)]
                if math.dist(a,b)<=EPS_M: add('MQ-P01','DUPLICATE_VERTEX',[ident],Point(b[:2]),ring=ring_index,index=i)
                elif strict_between(a,b,c): add('MQ-P01','STRICT_COLLINEAR_VERTEX',[ident],Point(b[:2]),ring=ring_index,index=i)
                elif math.dist(a[:2],c[:2])<=EPS_M or abs(angle(vector(b,a),vector(b,c)))<5:
                    add('MQ-P01','SPIKE_REVIEW',[ident],Point(b[:2]),ring=ring_index,index=i)
    coverage['polygonVertices']={'status':'checked','visited':vertices,'polygons':len(polygons)}
    # Road bands use round caps/joins like MapCanvas. Approximation bound is reported per width.
    spatial_pairs=0; unknown_bands=[]; legal_pairs=0; level_unchecked=[]
    for rid,r in m['roads'].items():
        line=lines[rid]
        if r.get('corridorPolygon'): band=poly(r['corridorPolygon']); approximation=0
        elif r['widthM']['state']=='known':
            radius=r['widthM']['value']/2
            band=line.buffer(radius,quad_segs=PARAMETERS['roundBufferQuadrantSegments'],cap_style='round',join_style='round')
            approximation=radius*(1-math.cos(math.pi/(4*PARAMETERS['roundBufferQuadrantSegments'])))
        else: band=None; approximation=None; unknown_bands.append(rid)
        for ident,p in polygons.items():
            if ident=='siteBoundary': continue
            spatial_pairs+=1
            kind,fid=ident.split('/'); entity=m[kind][fid]
            solid=kind=='facilities' and reference(entity).get('solidFootprint') is True
            forbidden=(kind=='zones' and (entity['passability']=='forbidden' or entity['kind'] in ['water','obstacle'])) or planning(entity).get('vehicleAccess')=='forbidden'
            if not solid and not forbidden:
                if line.intersects(p): legal_pairs+=1
                continue
            if not p.is_valid: add('MQ-G01','INVALID_OBSTACLE_UNCHECKED',['roads/'+rid,ident],p,status='not_checked');continue
            boundary=entity['boundary']; obstacle_points=boundary['outer']+[v for ring in boundary.get('holes',[]) for v in ring]
            road_geometry=points(m,r)+(r.get('corridorPolygon',{}).get('outer',[]))
            if not same_plane(road_geometry,obstacle_points):
                level_unchecked.append([rid,ident])
                if line.intersects(p) or band is not None and band.intersects(p):
                    add('MQ-G01','ROAD_POLYGON_LEVEL_UNCONFIRMED',['roads/'+rid,ident],line.intersection(p),status='not_checked',reason='XY projection alone cannot establish a same-level conflict.')
                continue
            center=line.intersection(p)
            # Strict interior segment length: coincident boundary is not through-building.
            center_inside=center.difference(p.boundary).length
            overlap=band.intersection(p) if band is not None else None
            area=overlap.area if overlap is not None else None
            own=planning(r).get('role')=='internal' and planning(r).get('ownerEntityId')==fid and p.buffer(EPS_M).covers(line) and any(s.get('facilityId',s.get('zoneId'))==fid and s.get('arrival',{}).get('mode')=='explicit_internal' and any(a['roadId']==rid for a in s['arrival']['internalPath']) for s in m['servicePoints'].values())
            if center_inside>EPS_M or area is not None and area>EPS_M:
                status='legal_retained' if own and not forbidden else 'declared_conflict' if forbidden else 'candidate'
                add('MQ-G01','DECLARED_OWNER_INTERNAL_ACCESS' if own and not forbidden else 'ROAD_SOLID_OR_FORBIDDEN_OVERLAP',
                    ['roads/'+rid,ident],overlap if overlap is not None and not overlap.is_empty else center,status=status,
                    centerInteriorLengthM=center_inside,overlapAreaM2=area,minimumCenterDistanceM=line.distance(p),
                    roundBufferRadialErrorBoundM=approximation,physicalClearance='unknown',
                    solidFootprint=solid,explicitForbidden=forbidden,
                    sourceClassification='roof reference declaration' if solid else 'explicit zone/passability declaration')
            elif center.intersects(p.boundary) or overlap is not None and not overlap.is_empty:
                add('MQ-G01','BOUNDARY_CONTACT',['roads/'+rid,ident],center,status='legal_retained',overlapAreaM2=area)
    coverage['roadPolygonPairs']={'status':'checked','visited':spatial_pairs,'total':len(lines)*(len(polygons)-1),'legalAreaCenterlineIntersections':legal_pairs,'levelNotCheckedPairs':level_unchecked}
    if level_unchecked:coverage['roadPolygonPairs']['status']='partial'
    coverage['roadBands']={'status':'partial' if unknown_bands else 'checked','visited':len(lines)-len(unknown_bands),'total':len(lines),'notCheckedRoadIds':unknown_bands,'reason':'unknown/unrestricted/not_applicable width has no definite band'}
    # All slot containment/overlap, with no issue-count budget. Different-owner overlap needs semantics.
    slots=[]
    for kind in ['facilities','zones']:
        for fid,f in m[kind].items():
            for s in planning(f).get('slots',[]):
                slots.append((kind,fid,s,poly(s['boundary'])))
    slot_level_unchecked=[]
    for kind,fid,s,p in slots:
        if not same_plane(s['boundary']['outer'],m[kind][fid]['boundary']['outer']):
            slot_level_unchecked.append([s['id'],kind+'/'+fid])
            add('MQ-P01','SLOT_OWNER_LEVEL_UNCONFIRMED',[kind+'/'+fid,'slots/'+s['id']],p,status='not_checked');continue
        owner=polygons[kind+'/'+fid]; outside=p.difference(owner).area
        if outside>EPS_M: add('MQ-P01','SLOT_OUTSIDE_OWNER',[kind+'/'+fid,'slots/'+s['id']],p,status='declared_conflict',outsideAreaM2=outside)
    slot_pairs=0
    for (ka,fa,a,pa),(kb,fb,b,pb) in itertools.combinations(slots,2):
        slot_pairs+=1
        if not same_plane(a['boundary']['outer'],b['boundary']['outer']):
            slot_level_unchecked.append([a['id'],b['id']]);continue
        area=pa.intersection(pb).area
        if area>EPS_M:
            add('MQ-P01','SLOT_OVERLAP',['slots/'+a['id'],'slots/'+b['id']],pa.intersection(pb),
                status='declared_conflict' if (ka,fa)==(kb,fb) else 'candidate',overlapAreaM2=area,sameOwner=(ka,fa)==(kb,fb))
    coverage['slots']={'status':'partial' if slot_level_unchecked else 'checked','visited':len(slots),'pairVisited':slot_pairs,'pairTotal':len(slots)*(len(slots)-1)//2,'levelNotCheckedPairs':slot_level_unchecked}
    # Incoming/outgoing travel tangents in right-handed world XY, never screen Y.
    arcs={}; inbound=defaultdict(list); outbound=defaultdict(list)
    for rid,r in m['roads'].items():
        for direction in ['forward','backward']:
            if r['direction'] not in [direction,'both']: continue
            p=points(m,r);p=p if direction=='forward' else p[::-1]
            a,b=(r['fromNodeId'],r['toNodeId']) if direction=='forward' else (r['toNodeId'],r['fromNodeId'])
            key=(rid,direction); arcs[key]=(a,b,p);outbound[a].append(key);inbound[b].append(key)
    turns=defaultdict(list); turn_geometry=[]
    for mid,mov in m['movements'].items():
        a=(mov['incomingArc']['roadId'],mov['incomingArc']['direction']);b=(mov['outgoingArc']['roadId'],mov['outgoingArc']['direction']);turns[a,b].append((mid,mov['allowed']))
        road_a,road_b=m['roads'].get(a[0]),m['roads'].get(b[0])
        if road_a is None or road_b is None:
            add('MQ-T01','DANGLING_MOVEMENT_ROAD',['movements/'+mid],None,status='declared_conflict');continue
        if 'unknown' in [road_a['direction'],road_b['direction']]:
            add('MQ-T01','TURN_DIRECTION_UNCONFIRMED',['movements/'+mid],None,status='not_checked');continue
        if a not in arcs or b not in arcs:
            add('MQ-T01','TURN_DIRECTION_OR_CONTINUITY',['movements/'+mid],None,status='declared_conflict');continue
        if arcs[a][1]!=arcs[b][0]:
            junction=m.get('junctions',{}).get(mov.get('junctionId'),{})
            grouped=arcs[a][1] in junction.get('nodeIds',[]) and arcs[b][0] in junction.get('nodeIds',[])
            add('MQ-T01','MULTI_NODE_TRANSITION_NOT_CHECKED' if grouped else 'TURN_DIRECTION_OR_CONTINUITY',
                ['movements/'+mid],None,status='not_checked' if grouped else 'declared_conflict');continue
        pa,pb=arcs[a][2],arcs[b][2]
        va=next((vector(p,pa[-1]) for p in reversed(pa[:-1]) if math.dist(p[:2],pa[-1][:2])>EPS_M),None)
        vb=next((vector(pb[0],p) for p in pb[1:] if math.dist(p[:2],pb[0][:2])>EPS_M),None)
        deg=angle(va,vb) if va and vb else None
        turn_geometry.append({'id':mid,'allowed':mov['allowed'],'angleDeg':deg,'geometryClass':None if deg is None else 'straight' if abs(deg)<=15 else 'uturn' if abs(deg)>=165 else 'left' if deg>0 else 'right'})
    for pair,declarations in turns.items():
        if len(declarations)>1: add('MQ-T01','CONFLICTING_TURN' if len({allow for _,allow in declarations})>1 else 'DUPLICATE_TURN',
                                   ['movements/'+mid for mid,_ in declarations],None,status='declared_conflict')
    transition_pairs=0
    for nid in sorted(nodes):
        for a,b in itertools.product(inbound[nid],outbound[nid]):
            transition_pairs+=1
            if a[0]!=b[0] and (a,b) not in turns:
                add('MQ-T01','MISSING_TURN_DECLARATION',['nodes/'+nid,'roads/'+a[0],'roads/'+b[0]],nodes[nid],incomingArc=a,outgoingArc=b,
                    conclusion='operation permission unconfirmed; no automatic allow')
    coverage['turns']={'status':'checked','declarationsVisited':len(m['movements']),'knownDirectionTransitionPairsVisited':transition_pairs,'unknownRoadIds':[rid for rid,r in m['roads'].items() if r['direction']=='unknown'],'notCheckedMovements':[r['ids'][0] for r in records if r['rule']=='MQ-T01' and r['status']=='not_checked']}
    if coverage['turns']['notCheckedMovements']:coverage['turns']['status']='partial'
    for fid,f in m['facilities'].items():
        participating=bool(f['servicePointIds'])
        if participating and not f['accessPointIds']: add('MQ-F01','PARTICIPATING_FACILITY_WITHOUT_ACCESS',['facilities/'+fid],polygons['facilities/'+fid])
        if not participating: add('MQ-F01','BUSINESS_PARTICIPATION_UNCONFIRMED',['facilities/'+fid],polygons['facilities/'+fid],status='not_checked',
                                  operationRoleHypothesis=reference(f).get('operationRoleHypothesis'),reason='No explicit service membership; no cargo entrance inferred from roof/name.')
    coverage['facilities']={'status':'checked','visited':len(m['facilities']),'serviceValidation':'see mandatory core-report.services; imagery business use remains unconfirmed'}
    return {'format':'MQ01_full_geometry_inventory_v1','ruleVersion':RULE_VERSION,'parameters':PARAMETERS,
            'environment':{'shapely':shapely.__version__},'coverage':coverage,'counts':dict(Counter((r['rule']+':'+r['status']) for r in records)),
            'records':records,'turnGeometry':turn_geometry,
            'notChecked':['imagery_evidence_classification','business_use_beyond_declared_services','physical_levels_gates_and_lanes',
                          'physical_clearance_swept_paths','external_scenario_task_references','OD_routes_separate_core_router_report'],
            'boundary':'Full inventory of stated geometric scopes; candidates are not confirmed errors. No map mutation.'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('map');parser.add_argument('--core-report',required=True);parser.add_argument('--out',required=True)
    args=parser.parse_args();path=Path(args.map);raw=path.read_bytes();report=load(args.core_report)
    digest=hashlib.sha256(raw).hexdigest()
    if digest != report['normalizedFileSha256']: raise ValueError('MQ_STALE_CORE_RECEIPT: scan the normalized map.json emitted with this exact receipt, not the pre-repair input')
    m=load(path)
    if m['mapId']!=report['mapId'] or not report['validation']['ok']:raise ValueError('MQ_INVALID_CORE_RECEIPT')
    result=scan(m);result['binding']={'mapId':m['mapId'],'fileSha256':digest,'contentHash':report['contentHash'],'coordinateFrame':m['coordinateFrame']}
    if path.read_bytes()!=raw: raise RuntimeError('MQ_INPUT_CHANGED')
    with Path(args.out).open('x',encoding='utf-8',newline='\n') as stream: json.dump(result,stream,ensure_ascii=False,indent=2,allow_nan=False);stream.write('\n')
    print(json.dumps({'mapId':m['mapId'],'records':len(result['records']),'counts':result['counts'],'out':args.out}))
if __name__=='__main__':main()
