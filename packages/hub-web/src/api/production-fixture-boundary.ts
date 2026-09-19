import type { FixtureApiOptions, HubApi } from "./client";

/**
 * Every Vite production build resolves the fixture boundary to this module.
 * The build-command alias is independent of Vite mode and environment values,
 * so a packaged Hub cannot opt back into development fixtures.
 */
export const createFixtureApi: ((options?: FixtureApiOptions) => HubApi) | null = null;
