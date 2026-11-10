import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expectNoViolations } from "./axe";

const session = JSON.parse(
  readFileSync(
    new URL("../../../.demo/browser-session.json", import.meta.url),
    "utf8",
  ),
);

async function openWorkspace(page: Page, token: string) {
  await page.goto("/");
  await page.getByLabel("Workspace access token").fill(token);
  await page.getByRole("button", { name: "Open workspace" }).click();
  // The demo review may still be running, so wait until it reaches approval.
  await expect(
    page.getByText("Frozen regression and existing suite both pass."),
  ).toBeVisible({ timeout: 45000 });
}

test("sign-in page and its error state meet WCAG 2.2 AA", async ({ page }) => {
  await page.goto("/");
  await expectNoViolations(page, "sign-in page");
  await page
    .getByLabel("Workspace access token")
    .fill("not-a-valid-workspace-token-0000000000");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expectNoViolations(page, "sign-in error");
});

test("review evidence, approval controls and settings meet WCAG 2.2 AA", async ({
  page,
}) => {
  await openWorkspace(page, session.token);
  await expect(
    page.getByRole("button", { name: "Approve fix", exact: true }),
  ).toBeVisible();
  await expectNoViolations(page, "evidence tab with approval controls");
  await page.getByRole("button", { name: "Patch", exact: true }).click();
  await expect(page.locator("pre.patch")).toBeVisible();
  await expectNoViolations(page, "patch tab");
  await page.getByRole("button", { name: "Execution logs" }).click();
  await expect(
    page.locator("pre").filter({ hasText: "AssertionError" }),
  ).toBeVisible();
  await expectNoViolations(page, "execution logs tab");
  await page.getByRole("button", { name: "+ New review" }).click();
  await expect(
    page.getByRole("heading", { name: "Review immutable revisions" }),
  ).toBeVisible();
  await expectNoViolations(page, "new review form");
  await page.getByRole("button", { name: "Audit log" }).click();
  await expect(
    page.getByRole("heading", { name: "Repository activity" }),
  ).toBeVisible();
  await expectNoViolations(page, "audit log");
  await page.getByRole("button", { name: /^Settings/ }).click();
  await expect(
    page.getByRole("heading", { name: "Providers and usage" }),
  ).toBeVisible();
  await expectNoViolations(page, "settings");
});

test("viewer workspace on a phone-sized screen meets WCAG 2.2 AA", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, session.viewer_token);
  await expectNoViolations(page, "viewer evidence on a phone-sized screen");
});
