/// Test-only entry points, which `index.ts` does not export and the package's `exports` do not
/// reach: a handshake with a throwaway key pair the test chose, so a run can be pinned byte for
/// byte, and a way for one test process to play several phones on one code. A caller given these
/// could reuse a key pair or retry a code, which is exactly what the shipped API refuses.

export { ephemeralKeyPair, exportPublicKey } from "./keys";
export { forgetStartedPairings, macReceiveCommitWith, startPairingWith } from "./pairing";
export { acceptSessionWith, startSessionWith } from "./session";
