import {
  createContext,
  type PropsWithChildren,
  useContext,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { HubApi } from "./client";

const ApiContext = createContext<HubApi | null>(null);

export function HubApiProvider({ api, children }: PropsWithChildren<{ api: HubApi }>) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useHubApi(): HubApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("HubApiProvider is missing");
  return api;
}

export function useSession() {
  const api = useHubApi();
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api.getSession(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useCapabilities() {
  const api = useHubApi();
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: () => api.getCapabilities(),
    staleTime: 30_000,
    retry: false,
  });
}
