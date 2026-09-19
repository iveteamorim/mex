import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: vi.fn(),
  createCapture: vi.fn(),
  startTelemetry: vi.fn(),
  stopTelemetry: vi.fn(async () => undefined),
  startServer: vi.fn(),
  closeServer: vi.fn(async () => undefined),
  createApp: vi.fn(),
  createSetup: vi.fn(),
  inspect: vi.fn(),
  committedIdentity: vi.fn(),
  stopSetup: vi.fn(async () => undefined),
  findRoot: vi.fn(),
  findConfig: vi.fn(),
  identity: vi.fn(),
  createTeam: vi.fn(),
  order: [] as string[],
}));

vi.mock("../../telemetry/index.js", () => ({
  createProjectTelemetryCapture: mocks.createCapture,
  startHubTelemetry: mocks.startTelemetry,
}));
vi.mock("../static/assets.js", () => ({ HubAssetManifest: class {} }));
vi.mock("../security/session.js", () => ({
  createBootstrapToken: () => "private-bootstrap-token",
  HubSessionManager: class {},
}));
vi.mock("../app.js", () => ({ createHubApp: mocks.createApp }));
vi.mock("../node-server.js", () => ({ startHubNodeServer: mocks.startServer }));
vi.mock("../setup/services.js", () => ({ createSetupHubServices: mocks.createSetup }));
vi.mock("../../setup/headless.js", () => ({ inspectSetupStatus: mocks.inspect }));
vi.mock("../setup/readiness.js", () => ({ hasCommittedHubIdentity: mocks.committedIdentity }));
vi.mock("../../setup/index.js", () => ({ findSetupProjectRoot: mocks.findRoot }));
vi.mock("../../config.js", () => ({
  findConfig: mocks.findConfig,
  readScaffoldId: () => mocks.identity()?.scaffold_id,
}));
vi.mock("../jobs/index.js", () => ({ HubJobManager: class {
  initialize() {}
  shutdown = async () => { mocks.order.push("jobs"); };
} }));
vi.mock("../jobs/graph.js", () => ({ createGraphJobExecutors: () => ({}) }));
vi.mock("../jobs/wiki.js", () => ({ createWikiJobExecutors: () => ({}) }));
vi.mock("../services.js", () => ({ createLocalHubReadServices: () => ({}) }));
vi.mock("../../team/local-state/index.js", () => ({ TeamLocalState: class {} }));
vi.mock("../../graph/application-adapter.js", () => ({ createRepositoryGraphPort: () => ({}) }));
vi.mock("../../wiki/application-adapter.js", () => ({ createRepositoryWikiPort: () => ({}) }));
vi.mock("../../team/workflow/repository-team-workflow-port.js", () => ({
  createRepositoryTeamWorkflowPort: mocks.createTeam,
}));
vi.mock("../../team/specs/index.js", () => ({ createSpecReadService: () => ({}) }));

import { launchHub, runSetupHubCommand } from "../command.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.committedIdentity.mockResolvedValue(false);
  mocks.createTeam.mockResolvedValue({ initializeIdentityActivitySigner() {} });
  mocks.findConfig.mockReturnValue({ projectRoot: "/Users/private/project", scaffoldRoot: "/Users/private/project/.mex" });
  mocks.identity.mockReturnValue({ scaffold_id: "private-scaffold" });
  mocks.stopSetup.mockImplementation(async () => { mocks.order.push("setup"); });
  mocks.closeServer.mockImplementation(async () => { mocks.order.push("http"); });
  mocks.stopTelemetry.mockImplementation(async () => { mocks.order.push("telemetry"); });
  mocks.startTelemetry.mockReturnValue(mocks.stopTelemetry);
  mocks.createCapture.mockReturnValue(mocks.events);
  mocks.createSetup.mockReturnValue({
    services: { tag: "setup-services" },
    setup: { tag: "setup-runner", status: () => ({ ready: false }), shutdown: mocks.stopSetup },
  });
  mocks.findRoot.mockReturnValue("/Users/private/project");
  mocks.inspect.mockReturnValue({ mode: "code-repo", hasScaffold: false, ready: false, stage: "needs_setup" });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("Hub setup process", () => {
  it("starts the setup Hub without jobs when the checkout is not ready", async () => {
    let ready!: (server: { origin: string; close: typeof mocks.closeServer; replaceApp: () => void }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    expect(mocks.createSetup).toHaveBeenCalledWith(
      "/Users/private/project",
      expect.objectContaining({ onReady: expect.any(Function) }),
    );
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      setup: expect.objectContaining({ tag: "setup-runner" }),
      services: { tag: "setup-services" },
      telemetry: mocks.events,
    }));
    expect(mocks.createApp.mock.calls[0][0].jobs).toBeUndefined();
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
    expect(mocks.events.mock.calls).toEqual([["hub.session_started", {}]]);
    expect(mocks.order).toEqual(["http", "setup", "telemetry"]);
  });

  it("opens the setup wizard from launchHub when setup is incomplete", async () => {
    let ready!: (server: { origin: string; close: typeof mocks.closeServer; replaceApp: () => void }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = launchHub({ openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    expect(mocks.findConfig).not.toHaveBeenCalled();
    expect(mocks.createSetup).toHaveBeenCalledWith(
      "/Users/private/project",
      expect.objectContaining({ onReady: expect.any(Function) }),
    );
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
  });

  it.each([
    { mode: "agent-memory", hasScaffold: true },
    { mode: "code-repo", hasScaffold: false },
  ])("keeps $mode with hasScaffold=$hasScaffold in setup despite committed config", async (state) => {
    mocks.inspect.mockReturnValue({ ...state, ready: false, stage: "needs_setup" });
    mocks.committedIdentity.mockResolvedValue(true);
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = launchHub({ openBrowser: false });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    expect(mocks.createSetup).toHaveBeenCalledOnce();
    expect(mocks.findConfig).not.toHaveBeenCalled();
    stopHub(priorListeners);
    await running;
  });

  it("retains the full Hub recovery surfaces when only disposable indexes are missing", async () => {
    mocks.inspect.mockReturnValue({ mode: "code-repo", hasScaffold: true, ready: false,
      populated: false, graphReady: false, wikiReady: false, stage: "needs_finalize" });
    mocks.committedIdentity.mockResolvedValue(true);
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp: vi.fn() });
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = launchHub({ openBrowser: false });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    expect(mocks.createSetup).not.toHaveBeenCalled();
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({ jobs: expect.anything() }));
    stopHub(priorListeners);
    await running;
    expect(mocks.order).toEqual(["http", "jobs", "telemetry"]);
  });

  it("cleans up pending composition after cancellation without replacing the setup app", async () => {
    const replaceApp = vi.fn();
    let onReady!: (signal: AbortSignal) => Promise<void>;
    mocks.createSetup.mockImplementation((_root, options: { onReady: typeof onReady }) => {
      onReady = options.onReady;
      return { services: {}, setup: { shutdown: mocks.stopSetup } };
    });
    let finishTeam!: (team: { initializeIdentityActivitySigner(): void }) => void;
    mocks.createTeam.mockReturnValue(new Promise((resolve) => { finishTeam = resolve; }));
    mocks.startServer.mockResolvedValue({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp });
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const promotion = onReady(controller.signal);
    const failure = expect(promotion).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mocks.createTeam).toHaveBeenCalledOnce());
    controller.abort();
    finishTeam({ initializeIdentityActivitySigner() {} });
    await failure;
    expect(replaceApp).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(["jobs"]);
    stopHub(priorListeners);
    await running;
    expect(mocks.order).toEqual(["jobs", "http", "setup", "telemetry"]);
  });

  it("promotes the running listener to the Project Hub when setup becomes ready", async () => {
    const replaceApp = vi.fn();
    let onReady!: (signal: AbortSignal) => Promise<void>;
    mocks.createSetup.mockImplementation((_root, options: { onReady: (signal: AbortSignal) => Promise<void> }) => {
      onReady = options.onReady;
      return {
        services: { tag: "setup-services" },
        setup: { tag: "setup-runner", status: () => ({ ready: false }), shutdown: mocks.stopSetup },
      };
    });
    mocks.findConfig.mockReturnValue({ projectRoot: "/Users/private/project" });
    mocks.identity.mockReturnValue({ scaffold_id: "private-scaffold" });
    mocks.createApp
      .mockReturnValueOnce({ tag: "setup-app" })
      .mockReturnValueOnce({ tag: "hub-app" });
    let ready!: (server: { origin: string; close: typeof mocks.closeServer; replaceApp: typeof replaceApp }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer, replaceApp });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    await onReady(new AbortController().signal);
    expect(replaceApp).toHaveBeenCalledWith({ tag: "hub-app" });
    expect(mocks.createApp).toHaveBeenNthCalledWith(2, expect.objectContaining({
      jobs: expect.anything(),
      telemetry: mocks.events,
    }));
    expect(mocks.createApp.mock.calls[1]?.[0].setup).toBeUndefined();
    expect(vi.mocked(process.stdout.write).mock.calls.some((call) => String(call[0]).includes("Project Hub is ready"))).toBe(true);
    const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
    expect(mocks.order).toEqual(["http", "setup", "jobs", "telemetry"]);
  });
});

function stopHub(priorListeners: Set<(...args: any[]) => void>): void {
  const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
  if (!stop) throw new Error("Hub did not install its shutdown handler.");
  stop("SIGTERM");
}
