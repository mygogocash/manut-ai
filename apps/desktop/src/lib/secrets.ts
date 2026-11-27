// The app's one masker now lives in the workspace package @manut/mask-secrets (packages/mask-secrets: its code, its patterns in
// secrets.json and its shared table of cases), so the desktop and the API's Worker share one file and neither imports from the
// other's source (item 102l-1). This module re-exports every name it used to define, so the desktop's importers stay as they
// are. The shell's twin (src-tauri/src/tasks.rs) reads the same secrets.json from the package.
export { MASK, maskCommand, maskSecrets, revealHidden, sameShape, shellWords, showCommand } from "@manut/mask-secrets";
export type { ShownCommand } from "@manut/mask-secrets";
