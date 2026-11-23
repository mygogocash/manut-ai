/// The one event contract every agent in Manut AI reports through, whatever runs it: a coding
/// CLI on the owner's Mac, a cloud worker for a team member, or a plain chat model. An adapter
/// maps its provider's wire format into `ProviderEvent`, and nothing past the adapter ever
/// learns that format: the screens read the timeline the reducer folds the events into.
///
/// Ported from GoSpark (`mygogocash/gospark`), which normalizes every agent it drives to one
/// protocol and one event enum (`GoGoCode/Providers/ProviderSession.swift`) and folds the events
/// in `ThreadRuntime`. The value types keep GoSpark's JSON key names, so a thread GoSpark saved
/// and a paired phone's rows read through the decoders here.
///
/// Plain TypeScript with no runtime dependencies, so the desktop app, the web pages and a
/// Durable Object can all run the same contract.

export * from "./coding";
export * from "./text";
export * from "./provider";
export * from "./requests";
export * from "./research";
export * from "./timeline";
export * from "./task";
export * from "./document";
export * from "./events";
export * from "./reducer";
