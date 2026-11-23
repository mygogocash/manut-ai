import { createContext, useContext } from "react";
import { readOperatorKey } from "../ops/operatorKey";
import { createHttpApi } from "./client";
import { createFakeApi } from "./fake";
import type { PilotApi } from "./types";

export * from "./types";

/// `fake` is practice mode: sample data, nothing leaves the browser.
export type ApiMode = "fake" | "live";

export type ApiSetup = { api: PilotApi; mode: ApiMode; reset?: () => void };

/// Picks the backend from `VITE_API_ORIGIN`: absent or empty means the in-memory fake.
export function createApi(origin: string | undefined = import.meta.env.VITE_API_ORIGIN): ApiSetup {
  const trimmed = origin?.trim();
  if (trimmed) return { api: createHttpApi({ origin: trimmed, operatorKey: readOperatorKey }), mode: "live" };
  const fake = createFakeApi({ operatorKey: readOperatorKey, latencyMs: 300, storage: browserStorage() });
  return { api: fake, mode: "fake", reset: () => fake.reset() };
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const ApiContext = createContext<ApiSetup | null>(null);

export const ApiProvider = ApiContext.Provider;

export function useApiSetup(): ApiSetup {
  const setup = useContext(ApiContext);
  if (!setup) throw new Error("useApiSetup needs an ApiProvider above it");
  return setup;
}

export function useApi(): PilotApi {
  return useApiSetup().api;
}
