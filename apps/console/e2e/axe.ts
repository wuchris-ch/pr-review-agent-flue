import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

// WCAG 2.2 level A and AA rules, which include the 2.0 and 2.1 rules.
const WCAG = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

/** Run axe-core on the current page and fail with each violation and where it is. */
export async function expectNoViolations(page: Page, state: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const violations = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help} at ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
  expect(violations, `accessibility violations in ${state}`).toEqual([]);
}
