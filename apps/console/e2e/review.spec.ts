import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const session = JSON.parse(
  readFileSync(
    new URL("../../../.demo/browser-session.json", import.meta.url),
    "utf8",
  ),
);

test("review evidence, approve and download a commit-bound fix", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Workspace access token").fill(session.token);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Discount is dropped before tax calculation",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Frozen regression and existing suite both pass."),
  ).toBeVisible({ timeout: 45000 });
  await page.screenshot({
    path: "../../docs/platform/console.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Patch", exact: true }).click();
  await expect(page.locator("pre.patch")).toContainText(
    "+    return discounted",
  );
  await page.getByRole("button", { name: "Execution logs" }).click();
  await expect(
    page.locator("pre").filter({ hasText: "AssertionError" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await page.getByRole("button", { name: "Approve fix", exact: true }).click();
  await expect(page.getByText("Approved for local application")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download approved fix" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const bundle = JSON.parse(readFileSync(path!, "utf8"));
  expect(bundle.head).toBe(session.head);
  expect(bundle.bundle.passed).toBe(true);
  await page.getByRole("button", { name: "Audit log" }).click();
  await expect(page.getByText("fix.approved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page.getByLabel("Lifetime review allowance").fill("75");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("/ 75 reserved")).toBeVisible();
});

test("viewer can inspect evidence without approval or configuration controls", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Workspace access token").fill(session.viewer_token);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Discount is dropped before tax calculation",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New review" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Settings/ }).click();
  await expect(
    page.getByRole("button", { name: "Save settings" }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
});

test("sign out does not restore a stale in-flight session", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Workspace access token").fill(session.viewer_token);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Discount is dropped before tax calculation",
    }),
  ).toBeVisible();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => (release = resolve));
  let intercepted!: () => void;
  const started = new Promise<void>((resolve) => (intercepted = resolve));
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    intercepted();
    await delayed;
    await route.fulfill({ response });
  });
  await started;
  await page.getByRole("button", { name: "Sign out" }).click();
  release();
  await expect(
    page.getByRole("button", { name: "Open workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Changes, backed by evidence." }),
  ).toHaveCount(0);
});
