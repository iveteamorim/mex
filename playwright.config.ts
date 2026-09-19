import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/hub-e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 2,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: { animations: "disabled", caret: "hide" },
  },
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  // Browser text rasterization is platform-specific even with self-hosted fonts.
  // Keep exact baselines per OS instead of weakening visual comparisons globally.
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev --workspace @mex/hub-web -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
