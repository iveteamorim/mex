import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserHubApplication } from "./app/App";
import { clearBootstrapFragment, readBootstrapToken, resolveApi } from "./api/client";
import { createHubQueryClient } from "./api/query-client";
import "./styles/global.css";

const api = await resolveApi();
let startupError: Error | null = null;
const token = readBootstrapToken();

if (token) {
  try {
    await api.bootstrap(token);
  } catch (error) {
    startupError = error instanceof Error ? error : new Error("The bootstrap request failed.");
  } finally {
    clearBootstrapFragment();
  }
}

const queryClient = createHubQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserHubApplication api={api} startupError={startupError} />
    </QueryClientProvider>
  </StrictMode>,
);
