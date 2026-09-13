export interface WorkbenchPreferences {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean | 'auto';
  rightCollapsed: boolean | 'auto';
  drawerHeight: number;
  saveTarget: 'ask' | 'file' | 'browser';
}

export const DEFAULT_WORKBENCH_PREFERENCES: Readonly<WorkbenchPreferences> = Object.freeze({
  leftWidth: 240, rightWidth: 300, leftCollapsed: 'auto', rightCollapsed: 'auto',
  drawerHeight: 240, saveTarget: 'ask',
});

/** Workbench settings are editor preferences, never map content or unfinished operations. */
export function validateWorkbenchPreferences(value: unknown): WorkbenchPreferences {
  if (value === undefined) return { ...DEFAULT_WORKBENCH_PREFERENCES };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_WORKBENCH_PREFERENCES, key))) {
    throw new Error('工作台配置只能包含声明的面板尺寸、折叠状态和保存目标。');
  }
  const result = { ...DEFAULT_WORKBENCH_PREFERENCES, ...value } as WorkbenchPreferences;
  if (!Number.isFinite(result.leftWidth) || result.leftWidth < 180 || result.leftWidth > 360
    || !Number.isFinite(result.rightWidth) || result.rightWidth < 240 || result.rightWidth > 420
    || !Number.isFinite(result.drawerHeight) || result.drawerHeight < 120 || result.drawerHeight > 600
    || ![true, false, 'auto'].includes(result.leftCollapsed)
    || ![true, false, 'auto'].includes(result.rightCollapsed)
    || !['ask', 'file', 'browser'].includes(result.saveTarget)) {
    throw new Error('工作台配置的尺寸、折叠状态或保存目标无效。');
  }
  return result;
}
