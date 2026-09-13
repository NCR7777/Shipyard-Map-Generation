"""Explicit synthetic fault probes for the full offline inventory; no original maps."""
import copy
import unittest
from MQ01_scan import scan


def rectangle(x,y,w,h):
    return {'outer':[[x,y,0],[x+w,y,0],[x+w,y+h,0],[x,y+h,0],[x,y,0]],'holes':[]}

def fixture():
    return {'nodes':{},'roads':{},'movements':{},'facilities':{},'zones':{},'servicePoints':{},'accessPoints':{},'siteBoundary':rectangle(-100,-100,200,200)}

def road(m,rid,a,b,width=2):
    for n,p in [(rid+'a',a),(rid+'b',b)]:m['nodes'][n]={'kind':'ordinary','position':[*p,0]}
    m['roads'][rid]={'fromNodeId':rid+'a','toNodeId':rid+'b','direction':'both','shapePoints':[],'widthM':{'state':'known','value':width}}

def rows(report,code):return [r for r in report['records'] if r['code']==code]

class FullScanTests(unittest.TestCase):
    def test_more_than_500_candidates_are_fully_visited_without_mutation(self):
        m=fixture()
        for i in range(40):m['nodes']['n'+str(i)]={'kind':'ordinary','position':[i/10,0,0]}
        before=copy.deepcopy(m);r=scan(m)
        self.assertEqual(r['coverage']['nodePairs']['visited'],780)
        self.assertEqual(len(rows(r,'NEAR_NODE_PAIR')),780)
        self.assertEqual(m,before)

    def test_partial_overlap_and_crossing_have_explicit_geometry_and_do_not_connect(self):
        m=fixture();road(m,'a',[-20,0],[20,0]);road(m,'b',[0,0],[30,0]);road(m,'c',[0,-10],[0,10])
        r=scan(m)
        self.assertEqual(rows(r,'COINCIDENT_ROAD_INTERVAL')[0]['metrics']['overlapLengthM'],20)
        self.assertTrue(rows(r,'CROSSING_WITHOUT_SHARED_NODE'))
        self.assertEqual(r['coverage']['roadPairs']['visited'],3)
        self.assertEqual(len(m['nodes']),6)

    def test_round_band_hits_when_center_does_not_and_unknown_width_remains_unchecked(self):
        m=fixture();road(m,'a',[0,0],[10,0],4);road(m,'unknown',[0,20],[10,20])
        m['roads']['unknown']['widthM']={'state':'unknown'}
        m['zones']['wall']={'kind':'obstacle','passability':'forbidden','boundary':rectangle(10.5,-1,1,2)}
        m['zones']['yard']={'kind':'work_area','passability':'allowed','boundary':rectangle(-5,-5,20,10)}
        r=scan(m);overlap=rows(r,'ROAD_SOLID_OR_FORBIDDEN_OVERLAP')
        self.assertEqual(len(overlap),1);self.assertEqual(overlap[0]['metrics']['centerInteriorLengthM'],0)
        self.assertGreater(overlap[0]['metrics']['overlapAreaM2'],0)
        self.assertEqual(r['coverage']['roadBands']['notCheckedRoadIds'],['unknown'])
        self.assertEqual(r['coverage']['roadPolygonPairs']['visited'],4)

    def test_holes_and_slot_ownership_detect_exact_outside_without_rectangularizing(self):
        m=fixture();boundary=rectangle(0,0,20,20);boundary['holes']=[list(reversed(rectangle(8,8,4,4)['outer']))]
        m['facilities']['owner']={'boundary':boundary,'accessPointIds':[],'servicePointIds':[],
            'extensions':{'sr02.planning':{'slots':[{'id':'slot','boundary':rectangle(9,9,2,2)}]}}}
        r=scan(m);self.assertEqual(rows(r,'SLOT_OUTSIDE_OWNER')[0]['metrics']['outsideAreaM2'],4)
        self.assertEqual(m['facilities']['owner']['boundary'],boundary)

    def test_different_z_is_unchecked_not_a_confirmed_xy_collision(self):
        m=fixture();road(m,'bridge',[0,0],[10,0],4)
        m['nodes']['bridgea']['position'][2]=5;m['nodes']['bridgeb']['position'][2]=5
        m['zones']['lower']={'kind':'obstacle','passability':'forbidden','boundary':rectangle(2,-1,2,2)}
        r=scan(m)
        self.assertFalse(rows(r,'ROAD_SOLID_OR_FORBIDDEN_OVERLAP'))
        self.assertEqual(r['coverage']['roadPolygonPairs']['status'],'partial')
        self.assertEqual(len(rows(r,'ROAD_POLYGON_LEVEL_UNCONFIRMED')),1)

    def test_unknown_direction_and_grouped_junction_are_not_fabricated_errors(self):
        m=fixture();road(m,'a',[0,0],[10,0]);road(m,'b',[20,0],[30,0])
        m['movements']['m']={'junctionId':'j','incomingArc':{'roadId':'a','direction':'forward'},'outgoingArc':{'roadId':'b','direction':'forward'},'allowed':True}
        m['junctions']={'j':{'nodeIds':['ab','ba']}}
        m['roads']['a']['direction']='unknown';r=scan(m)
        self.assertTrue(rows(r,'TURN_DIRECTION_UNCONFIRMED'));self.assertFalse(rows(r,'TURN_DIRECTION_OR_CONTINUITY'))
        m['roads']['a']['direction']='both';r=scan(m)
        self.assertTrue(rows(r,'MULTI_NODE_TRANSITION_NOT_CHECKED'));self.assertFalse(rows(r,'TURN_DIRECTION_OR_CONTINUITY'))
        self.assertEqual(r['coverage']['turns']['status'],'partial')

    def test_turn_sign_follows_travel_vector_not_stored_road_direction(self):
        m=fixture();road(m,'west',[0,0],[-10,0]);road(m,'north',[0,0],[0,10])
        m['roads']['north']['fromNodeId']='westa';del m['nodes']['northa']
        m['movements']['left']={'incomingArc':{'roadId':'west','direction':'backward'},'outgoingArc':{'roadId':'north','direction':'forward'},'allowed':False}
        r=scan(m);t=r['turnGeometry'][0]
        self.assertEqual(t['geometryClass'],'left');self.assertEqual(t['angleDeg'],90);self.assertFalse(t['allowed'])
        self.assertTrue(rows(r,'MISSING_TURN_DECLARATION'))

if __name__=='__main__':unittest.main()
