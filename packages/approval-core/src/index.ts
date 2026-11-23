/// The approval rulebook Manut AI's clients and server share: who may decide a request, whether a
/// decision still counts for what the person saw, and a store that settles each request once.
/// Plain TypeScript with no runtime dependencies, so the desktop app, the web approval page, the
/// phone and a Durable Object can all run the same rules.
///
/// The rules are ported from GoSpark (`DecisionBinding`, the decision chokepoint in
/// `AppModel+Decisions`, plan revisions) and from Orca (MIT; refusing stale or resolved prompts by
/// expected revision, and refusing options that were not offered).

export * from "./types";
export * from "./binding";
export * from "./roles";
export * from "./standing";
export * from "./transitions";
export * from "./store";
export * from "./in-memory-store";
