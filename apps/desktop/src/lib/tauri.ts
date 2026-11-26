// Whether this page is running inside the desktop shell. In a plain browser (the web build, the tests) there is no
// Tauri bridge, so every host module asks this one question before it calls the shell, and falls back to its
// stand-in when the answer is no.
export const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
