export type Repository = {
  id: string;
  name: string;
  role: "viewer" | "reviewer" | "admin";
};
export type Session = {
  github_publication?: boolean;
  tenant: string;
  user: string;
  provider: string;
  review_limit: number;
  reviews_used: number;
  available_providers: string[];
  repositories: Repository[];
};
export type Review = {
  id: string;
  repository_id: string;
  pull_request: number;
  base: string;
  head: string;
  provider: string;
  state: string;
  error: string | null;
  evidence_digest: string | null;
  decision_by: string | null;
  created_at: string;
  artifacts?: { name: string; sha256: string }[];
};
export type Finding = {
  title: string;
  explanation: string;
  category: string;
  references: { file: string; line: number; excerpt: string }[];
};
export type Run = { outcome: string; log: string; exit_code: number };
export type Reproduction = {
  confirmed: boolean;
  base: Run;
  head: Run;
  test: string;
  test_digest: string;
};
export type Fix = {
  passed: boolean;
  patch: string;
  regression: Run;
  existing_suite: Run;
  baseline_suite: Run;
};
export type Audit = {
  actor: string;
  action: string;
  subject: string;
  created_at: string;
};
export const label = (value: string) => value.replaceAll("_", " ");
export const short = (value: string) => value.slice(0, 10);
