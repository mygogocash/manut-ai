/// <reference types="vite/client" />

interface ImportMetaEnv {
  /// The API's origin. Absent or empty runs the app on the in-memory fake (practice mode).
  readonly VITE_API_ORIGIN?: string;
}
