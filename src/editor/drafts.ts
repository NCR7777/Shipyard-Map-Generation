import { useLayoutEffect, useRef } from 'react';

export interface DraftContext {
  projectId: string | null;
  changeToken: number;
  mapContentHash: string;
}

export interface PropertyDraft {
  context: DraftContext;
  apply: () => boolean;
}

export interface PropertyDraftProps {
  draftContext?: DraftContext;
  onDraftChange?: (draft: PropertyDraft | null) => void;
}

/** The dirty form owns the registration; input changes refresh its callable before paint. */
export function usePropertyDraft(context: DraftContext | undefined, dirty: boolean, apply: () => boolean,
  onDraftChange: PropertyDraftProps['onDraftChange']): void {
  const latestApply = useRef(apply);
  useLayoutEffect(() => { latestApply.current = apply; });
  const projectId = context?.projectId;
  const changeToken = context?.changeToken;
  const mapContentHash = context?.mapContentHash;
  useLayoutEffect(() => {
    if (projectId === undefined || changeToken === undefined || mapContentHash === undefined || !onDraftChange || !dirty) return;
    let active = true;
    onDraftChange({ context: { projectId, changeToken, mapContentHash }, apply: () => active && latestApply.current() });
    return () => { active = false; onDraftChange(null); };
  }, [projectId, changeToken, mapContentHash, dirty, onDraftChange]);
}
