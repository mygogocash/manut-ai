/// What test/remote-mac.test.ts uses of `cloudflare:test`, for tsconfig.remote-mac.json, which checks that test with the
/// browser's library instead of the Workers types: the Worker's own fetch, whose upgrade answers carry a socket to accept.
declare module "cloudflare:test" {
  export const SELF: {
    fetch(input: string, init?: RequestInit): Promise<Response & { webSocket: (WebSocket & { accept(): void }) | null }>;
  };
}
