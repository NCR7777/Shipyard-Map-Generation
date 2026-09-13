"""Assemble final MQ01 evidence per record; never mutate maps or infer repairs."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('.cache/MQ01'))
    args = parser.parse_args()
    root = args.root.resolve()
    sources = {}

    def read(path):
        sources[str(path.relative_to(root))] = sha(path)
        return json.loads(path.read_text(encoding='utf-8-sig'))

    spatial = read(root / 'spatial-adjudication.json')
    parallel = read(root / 'parallel-adjudication.json')
    clusters = read(root / 'resource-free-cluster-candidates.json')
    geoje = read(root / 'geoje-cluster-imagery-adjudication.json')
    summary = {'format': 'MQ01_final_adjudication_v1', 'generatedAt': datetime.now(timezone.utc).isoformat(),
               'method': 'Final inventory records preserved exactly. Reuse individually reviewed geometry/imagery by exact entity IDs or accepted road lineage; remaining topology classified from current explicit references and recorded A guards. No new repair command executed.',
               'boundary': 'Retained declared semantics is not surveyed physical legality. candidate_only is a screened proximity/topology candidate protected by current references or guards, not a defect or individual user decision. C is a localized unresolved/deferred evidence topic, not an error verdict. not_checked business identity does not imply a missing entrance. Width unknown never gets an invented band.',
               'candidateCountsAreNotConfirmedErrorCounts': True,
               'yards': [], 'deferredDuplicateTraceGroups': parallel['deferredDuplicateTraceGroups']}
    all_status = Counter()
    all_categories = Counter()
    total_unknown = 0
    folders = sorted((root / 'final-check1').glob('*/full-inventory.json'))
    assert len(folders) == 9, 'Expected nine frozen final inventories'
    for inventory_path in folders:
        yard = inventory_path.parent.name
        inventory = read(inventory_path)
        map_path = inventory_path.with_name('map.json')
        map_data = read(map_path)
        core = read(inventory_path.with_name('core-report.json'))
        ledger = read(root / 'A-final' / yard / 'repair-ledger.json')
        a_map = read(root / 'A-final' / yard / 'map.json')
        assert sha(map_path) == inventory['binding']['fileSha256'] == core['normalizedFileSha256']
        assert inventory['binding']['contentHash'] == core['contentHash']
        assert inventory['binding']['coordinateFrame'] == map_data['coordinateFrame']
        aliases = {x['removedRoadId']: x['retainedRoadId'] for x in ledger['accepted'] if 'removedRoadId' in x}

        def key(ids):
            output = []
            for ref in ids:
                kind, entity_id = ref.split('/', 1)
                visited = set()
                while kind == 'roads' and entity_id in aliases:
                    assert entity_id not in visited, 'Cyclic road lineage'
                    visited.add(entity_id)
                    entity_id = aliases[entity_id]
                output.append(kind + '/' + entity_id)
            return tuple(sorted(output))

        inherited = {}
        for filename, data in [('spatial-adjudication.json', spatial), ('parallel-adjudication.json', parallel)]:
            for index, old in enumerate(data['records']):
                if old['factory'] == yard:
                    inherited.setdefault((old['originalRecord']['rule'], key(old['originalRecord']['ids'])), []).append((filename, index, old))
        cluster_map = next(item for item in clusters['maps'] if item['yard'] == yard)
        cluster_probes = {item['roadId']: item for item in cluster_map['rejections'] + cluster_map['candidates']}
        rejected = {}
        for index, item in enumerate(ledger['rejected']):
            rejected[item['nodeId']] = (index, item)
        nodes = map_data['nodes']
        roads = map_data['roads']
        incident = {node_id: [] for node_id in nodes}
        for road_id, road in roads.items():
            incident[road['fromNodeId']].append(road_id)
            incident[road['toNodeId']].append(road_id)

        def context(record):
            node_ids = {ref.split('/', 1)[1] for ref in record['ids'] if ref.startswith('nodes/')}
            road_ids = {ref.split('/', 1)[1] for ref in record['ids'] if ref.startswith('roads/')}
            for rid in list(road_ids):
                node_ids.update([roads[rid]['fromNodeId'], roads[rid]['toNodeId']])
            internal = {rid for rid, road in roads.items() if road['fromNodeId'] in node_ids and road['toNodeId'] in node_ids}
            road_ids.update(internal)
            aps = {aid: {k: v for k, v in ap.items() if k in ('nodeId', 'facilityId', 'zoneId')} for aid, ap in map_data['accessPoints'].items() if ap['nodeId'] in node_ids}
            sps = {}
            for sid, sp in map_data['servicePoints'].items():
                path_roads = {arc['roadId'] for arc in sp.get('arrival', {}).get('internalPath', [])}
                if sp['nodeId'] in node_ids or sp.get('accessPointId') in aps or path_roads & road_ids:
                    sps[sid] = {k: v for k, v in sp.items() if k in ('nodeId', 'facilityId', 'zoneId', 'accessPointId', 'arrival', 'resourceIds')}
            junctions = {jid: {'nodeIds': j['nodeIds'], 'model': j['model'], 'resourceIds': j.get('resourceIds', []), 'hasBoundary': 'boundary' in j}
                         for jid, j in map_data['junctions'].items() if set(j['nodeIds']) & node_ids}
            moves = {mid: {'junctionId': m['junctionId'], 'resourceIds': m.get('resourceIds', []), 'allowed': m['allowed']}
                     for mid, m in map_data['movements'].items() if m['junctionId'] in junctions or m['incomingArc']['roadId'] in road_ids or m['outgoingArc']['roadId'] in road_ids}
            resource_ids = set()
            for entity in list(junctions.values()) + list(moves.values()) + list(sps.values()) + [roads[rid] for rid in road_ids]:
                resource_ids.update(entity.get('resourceIds', []))
            return {'nodes': {nid: {'kind': nodes[nid]['kind'], 'degree': len(incident[nid]), 'incidentRoadIds': incident[nid], 'extensionNamespaces': list(nodes[nid].get('extensions', {}))} for nid in sorted(node_ids)},
                    'internalRoadIds': sorted(internal), 'roads': {rid: {'direction': roads[rid]['direction'], 'widthM': roads[rid]['widthM'], 'resourceIds': roads[rid].get('resourceIds', []),
                        'reference': roads[rid].get('extensions', {}).get('shipyard.reference'), 'planning': roads[rid].get('extensions', {}).get('sr02.planning')} for rid in sorted(road_ids)},
                    'accessPoints': aps, 'servicePoints': sps, 'junctions': junctions, 'movements': moves, 'resourceIds': sorted(resource_ids)}

        records = []
        for index, record in enumerate(inventory['records']):
            result = {'recordIndex': index, 'recordPointer': '/records/' + str(index), 'originalRecord': record,
                      'physicalSafety': 'not_established', 'action': 'none_in_adjudication'}
            matches = inherited.get((record['rule'], key(record['ids'])), [])
            if record['rule'] in ('MQ-G01', 'MQ-R01'):
                assert matches, (yard, record['ids'], 'Unmatched reviewed record')
                categories = {old['category'] for _, _, old in matches}
                assert len(categories) == 1, (yard, record['ids'], categories)
                filename, old_index, old = matches[0]
                category = old['category']
                changed_metrics = any(value['originalRecord']['metrics'] != record['metrics'] for _, _, value in matches)
                assert not changed_metrics or (record['rule'] == 'MQ-R01' and category.startswith('C')), 'Changed intervals cannot inherit a legal spatial verdict'
                retained = category.startswith('retain_') or category in ('declared_boundary_proxy_round_cap', 'boundary_proxy_cap_discretization_bound', 'legal_declared_owner_internal', 'declared_owner_internal_entry_round_cap')
                result.update(category=category, status='retained_declared_semantics' if retained else 'not_checked' if category.startswith('unknown_width') else 'C', explanationZh=old['explanationZh'],
                              evidence=[{'path': filename, 'pointer': '/records/' + str(i), 'originalIds': value['originalRecord']['ids'], 'mappedFinalIds': list(key(value['originalRecord']['ids'])),
                                         'metricsExactlyEqual': value['originalRecord']['metrics'] == record['metrics']} for filename, i, value in matches],
                              inheritance='Record-local overlap/interval only, never a verdict about the whole retained road. Exact IDs or accepted final-A road lineage; final metrics retained. Expanded parallel intervals remain C, not extended legal verdicts.')
            elif record['code'] == 'BUSINESS_PARTICIPATION_UNCONFIRMED':
                fid = record['ids'][0].split('/', 1)[1]
                facility = map_data['facilities'][fid]
                matching = [service for service in core['services'] if service.get('owner', {}).get('id') == fid]
                result.update(category='C_business_identity_unconfirmed', status='not_checked', explanationZh='当前设施未声明服务成员，业务身份尚未确认；屋顶/名称不能证明需承接货运，不能据此判定缺入口。保留原设施与现有 AP/SP 声明。',
                              evidence={'facilityPointer': '/facilities/' + fid, 'declaredServicePointIds': facility.get('servicePointIds', []), 'declaredAccessPointIds': facility.get('accessPointIds', []), 'coreServiceEntries': matching, 'coreReport': 'core-report.json#/services'})
            else:
                assert record['code'] in ('DEGREE_TWO_REVIEW', 'SHORT_ROAD_REVIEW', 'NEAR_NODE_PAIR', 'SHORT_EDGE_COMPONENT_REVIEW'), record['code']
                refs = context(record)
                evidence = {'currentReferences': refs, 'recordedClusterProbes': []}
                for rid in refs['internalRoadIds']:
                    if rid in cluster_probes:
                        evidence['recordedClusterProbes'].append({'path': 'resource-free-cluster-candidates.json', 'yard': yard, 'probe': cluster_probes[rid], 'scope': 'recorded pair-cluster preconditions; no new apply'})
                result.update(status='C', category='C_same_physical_junction_unconfirmed', evidence=evidence)
                if record['code'] == 'DEGREE_TWO_REVIEW':
                    nid = record['ids'][0].split('/', 1)[1]
                    if nid in rejected:
                        reject_index, reject = rejected[nid]
                        same_payloads = all(map_data[kind].get(eid) == a_map[kind].get(eid) for kind, eid in [ref.split('/', 1) for ref in record['ids']])
                        evidence['recordedAutomaticGuard'] = {'path': f'A-final/{yard}/repair-ledger.json', 'pointer': '/rejected/' + str(reject_index), 'rejection': reject, 'referencedPayloadsUnchangedSinceAFinal': same_payloads, 'scope': 'A automatic suppression policy; not proof all possible manual redesigns are impossible'}
                        result.update(category='C_automatic_suppression_guard_rejected', explanationZh='该二度节点有实际自动抑制拒绝回执，保留具体 code/jsonPath；当前候选本身不是错误。节点语义、道路字段或引用不满足窄等价维护条件，不删除字段绕过。')
                    else:
                        result.update(category='C_degree_two_unreviewed_for_equivalent_suppression', explanationZh='二度仅为拓扑度数；未找到该节点自动抑制实际回执，现有业务/资源/转向及弯折声明见引用，未执行合并，不宣称可无损消除。')
                elif yard == 'geoje' and 'R_MR_d13bb6404297' in refs['internalRoadIds']:
                    result.update(category='C_imagery_insufficient_same_ground_junction', explanationZh='唯一资源 free 二节点初筛候选仅约 1.76 个源像素，处港池内角/设备遮挡，相关道路宽度未知；实看 80m/300m 图不能确认同一地面路口，保留 C。')
                    evidence['imagery'] = {'path': 'geoje-cluster-imagery-adjudication.json', 'sha256': sources['geoje-cluster-imagery-adjudication.json'], 'reviewed': bool(geoje)}
                elif refs['accessPoints'] or refs['servicePoints']:
                    result.update(category='C_distinct_declared_business_attachments', explanationZh='候选涉及明确 AP/SP 或其内部路径，逐项 owner/arrival/node 引用已列出；距离短不证明业务节点身份相同，未经批准不改接入或合并。')
                elif refs['resourceIds']:
                    result.update(category='C_declared_junction_or_resource_sequence', explanationZh='候选关联显式路口/转向资源；缩并可能改变占用位置或序列，资源实体与引用必须保留。当前距离或短边阈值不能证明可无损缩并。')
                elif record['code'] == 'NEAR_NODE_PAIR' and not refs['internalRoadIds']:
                    result.update(category='C_near_nodes_without_explicit_connecting_road', explanationZh='仅空间近接，当前两节点间没有显式道路；不由距离、同 Z 或视觉重叠推断连接/同一地面实体。现有道路与节点身份保留。')
                elif record['code'] == 'SHORT_EDGE_COMPONENT_REVIEW' and len(refs['nodes']) > 2:
                    result.update(category='C_multi_node_cluster_not_proven_equivalent', explanationZh='多节点短边连通分量不是已确认单一路口；现有逐边 guard 仅是二节点初筛，不能外推整个分量可缩并。保留全部引用和真实分量直径。')
                else:
                    result['explanationZh'] = '当前声明不足以将短边/近接关系判为同一物理路口；现有 kind、corridorRef、连接道路及转向已列出，未取得可无损合并证据，保留 C。'
            if result['category'] in ('C_automatic_suppression_guard_rejected', 'C_distinct_declared_business_attachments',
                                      'C_declared_junction_or_resource_sequence', 'C_same_physical_junction_unconfirmed',
                                      'C_near_nodes_without_explicit_connecting_road', 'C_multi_node_cluster_not_proven_equivalent',
                                      'C_degree_two_unreviewed_for_equivalent_suppression'):
                result['status'] = 'candidate_only'
            result['requiresIndividualUserDecision'] = False
            result['confirmedErrorVerdict'] = 'not_assigned_by_candidate_or_adjudication_count'
            if result['category'] == 'C_deferred_user_decision':
                result['decisionScope'] = 'One of four grouped duplicate-trace topics; user explicitly retained this batch and deferred to a later batch.'
            elif result['category'] == 'C_imagery_insufficient_same_ground_junction':
                result['decisionScope'] = 'One Geoje cluster topic repeated by different candidate rules, not three independent defects.'
            records.append(result)
        counts = Counter(item['status'] for item in records)
        categories = Counter(item['category'] for item in records)
        unknown_ids = inventory['coverage']['roadBands']['notCheckedRoadIds']
        assert all(roads[rid]['widthM']['state'] != 'known' for rid in unknown_ids)
        output = {'format': 'MQ01_adjudicated_records_v1', 'yard': yard, 'binding': inventory['binding'],
                  'inventorySha256': sha(inventory_path), 'sourceEvidenceSha256': dict(sources), 'inputRecordCount': len(inventory['records']),
                  'outputRecordCount': len(records), 'allRecordsAddressed': len(records) == len(inventory['records']),
                  'statusCounts': dict(counts), 'categoryCounts': dict(categories), 'records': records,
                  'roadBandNotChecked': {'status': 'not_checked', 'count': len(unknown_ids), 'roadIds': unknown_ids, 'reason': 'No definite declared width; no band invented. This is per-road, separate from candidate-record counts.'},
                  'notChecked': inventory['notChecked'], 'boundary': summary['boundary']}
        write(inventory_path.with_name('adjudicated-records.json'), output)
        summary['yards'].append({'yard': yard, 'acceptedFinalACommands': len(ledger['accepted']), 'records': len(records), 'statusCounts': dict(counts), 'categoryCounts': dict(categories), 'roadBandNotChecked': len(unknown_ids),
                                 'output': str(inventory_path.with_name('adjudicated-records.json').relative_to(root)), 'outputSha256': sha(inventory_path.with_name('adjudicated-records.json'))})
        all_status.update(counts)
        all_categories.update(categories)
        total_unknown += len(unknown_ids)
    assert all(sha(root / relative) == expected for relative, expected in sources.items()), 'Source evidence changed during assembly'
    summary.update(acceptedFinalACommands=sum(y['acceptedFinalACommands'] for y in summary['yards']), totalRecords=sum(y['records'] for y in summary['yards']), allRecordsAddressed=True, statusCounts=dict(all_status), categoryCounts=dict(all_categories),
                   roadBandNotCheckedCount=total_unknown, sourceEvidenceSha256=sources, sourcesUnchanged=True, scriptSha256=sha(Path(__file__)))
    write(root / 'final-adjudication-summary.json', summary)
    print(json.dumps({k: summary[k] for k in ('totalRecords', 'allRecordsAddressed', 'statusCounts', 'roadBandNotCheckedCount', 'sourcesUnchanged')}, indent=2))


if __name__ == '__main__':
    main()
