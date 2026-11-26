/// The operator key lives only in this tab's sessionStorage: closing the tab forgets it, and it never
/// reaches localStorage, a cookie or the URL. If sessionStorage is blocked it is held in memory instead,
/// which forgets it even sooner.

const STORAGE_KEY = "manut.pilot.operatorKey";
let memoryKey: string | null = null;

export function readOperatorKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return memoryKey;
  }
}

export function saveOperatorKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    memoryKey = trimmed;
  }
}

export function forgetOperatorKey(): void {
  memoryKey = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was stored.
  }
}
