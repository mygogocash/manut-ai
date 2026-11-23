/// <reference types="vite/client" />

interface ImportMetaEnv {
  /// The API's origin, or `same-origin` for the API that served the page (the Worker build, `build:worker`).
  /// Absent or empty runs the app on the in-memory fake (practice mode).
  readonly VITE_API_ORIGIN?: string;
}
