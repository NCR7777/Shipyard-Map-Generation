import { useEffect, useRef, useState } from 'react';
import type { RoadGeometry, Vec3 } from '../../domain/model';
import { pathToRoadGeometry, type ResolvedPath } from '../../geometry/roadPath';

/** Preview only after a short pointer pause; the committing command still checks its exact final geometry. */
export function useCrossingPreview(path: ResolvedPath | null, mapHash: string, enabled: boolean,
  calculate?: (points: Vec3[], geometry?: RoadGeometry) => Vec3[]) {
  const calculateRef = useRef(calculate); calculateRef.current = calculate;
  const [result, setResult] = useState<{ path: ResolvedPath; mapHash: string; points: Vec3[] } | null>(null);
  useEffect(() => {
    if (!enabled || !path || path.anchors.length < 2) return;
    const handle = setTimeout(() => {
      const points = calculateRef.current?.(path.anchors, pathToRoadGeometry(path)) ?? [];
      setResult({ path, mapHash, points });
    }, 100);
    return () => clearTimeout(handle);
  }, [path, mapHash, enabled]);
  return enabled && result?.path === path && result.mapHash === mapHash ? result.points : [];
}
