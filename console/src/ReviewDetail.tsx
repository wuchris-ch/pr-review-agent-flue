import {
  type Review,
  type Finding,
  type Reproduction,
  type Fix,
  type Run,
  label,
  short,
} from "./contracts";
type Props = {
  detail: Review | null;
  finding: Finding | null;
  reproduction: Reproduction | null;
  fix: Fix | null;
  intent: { accepted: boolean; reason: string } | null;
  tab: string;
  canReview: boolean;
  busy: boolean;
  onTab: (tab: string) => void;
  onDecision: (decision: "approve" | "reject") => void;
  onDownload: () => void;
};
export function ReviewDetail({
  detail,
  finding,
  reproduction,
  fix,
  intent,
  tab,
  canReview,
  busy,
  onTab,
  onDecision,
  onDownload,
}: Props) {
  return (
    <section className="panel detail">
      {!detail ? (
        <div className="empty">
          <h2>Select a review</h2>
          <p>Commit-bound evidence will appear here.</p>
        </div>
      ) : (
        <>
          <div className="detail-heading">
            <div>
              <span className="eyebrow">
                PULL REQUEST #{detail.pull_request}
              </span>
              <h2>{finding?.title || "Review in progress"}</h2>
            </div>
            <span className={`badge ${detail.state}`}>
              {label(detail.state)}
            </span>
          </div>
          <div className="binding">
            <span>
              BASE <code>{short(detail.base)}</code>
            </span>
            <span>
              HEAD <code>{short(detail.head)}</code>
            </span>
            <span>{detail.artifacts?.length || 0} evidence artifacts</span>
          </div>
          <div className="steps">
            {["Investigate", "Reproduce", "Validate", "Repair", "Approve"].map(
              (s, i) => (
                <div
                  key={s}
                  className={
                    (i === 0 && finding) ||
                    (i === 1 && reproduction?.confirmed) ||
                    (i === 2 && intent?.accepted) ||
                    (i === 3 && fix?.passed) ||
                    (i === 4 && detail.state === "approved")
                      ? "done"
                      : ""
                  }
                >
                  <span>{i + 1}</span>
                  {s}
                </div>
              ),
            )}
          </div>
          <div className="tabs">
            {["Evidence", "Patch", "Execution logs"].map((name) => (
              <button
                className={tab === name ? "chosen" : ""}
                onClick={() => onTab(name)}
                key={name}
              >
                {name}
              </button>
            ))}
          </div>
          {detail.error && <p className="error">{detail.error}</p>}
          {tab === "Evidence" && (
            <div className="evidence">
              <h3>Finding & source references</h3>
              <p>
                {finding?.explanation ||
                  "Specialists are investigating the frozen source snapshot."}
              </p>
              {finding?.references.map((r, i) => (
                <div className="reference" key={i}>
                  <strong>
                    {r.file}:{r.line}
                  </strong>
                  <code>{r.excerpt}</code>
                </div>
              ))}
              <div className="checks">
                <div>
                  <span className="check-icon">
                    {reproduction?.base.outcome === "passed" ? "✓" : "○"}
                  </span>
                  <div>
                    <strong>Base revision passes</strong>
                    <p>
                      {reproduction
                        ? `Regression test: ${reproduction.base.outcome}`
                        : "Waiting for execution"}
                    </p>
                  </div>
                </div>
                <div>
                  <span className="check-icon">
                    {reproduction?.confirmed ? "✓" : "○"}
                  </span>
                  <div>
                    <strong>PR regression reproduced</strong>
                    <p>
                      {reproduction?.confirmed
                        ? "The same frozen test fails on the PR revision."
                        : "Waiting for paired execution"}
                    </p>
                  </div>
                </div>
                <div>
                  <span className="check-icon">
                    {intent?.accepted ? "✓" : "○"}
                  </span>
                  <div>
                    <strong>Independent intent check</strong>
                    <p>
                      {intent?.reason || "Waiting for independent validation"}
                    </p>
                  </div>
                </div>
                <div>
                  <span className="check-icon">{fix?.passed ? "✓" : "○"}</span>
                  <div>
                    <strong>Fix preserves the test contract</strong>
                    <p>
                      {fix?.passed
                        ? "Frozen regression and existing suite both pass."
                        : "Waiting for candidate validation"}
                    </p>
                  </div>
                </div>
              </div>
              {reproduction && (
                <details>
                  <summary>
                    Frozen regression test · {short(reproduction.test_digest)}
                  </summary>
                  <pre>{reproduction.test}</pre>
                </details>
              )}
            </div>
          )}
          {tab === "Patch" && (
            <div className="evidence">
              <h3>Proposed source change</h3>
              <p>
                Only configured source paths may change. Regression tests remain
                frozen.
              </p>
              <pre className="patch">
                {fix?.patch || "A validated patch is not available yet."}
              </pre>
            </div>
          )}
          {tab === "Execution logs" && (
            <div className="evidence">
              {[
                ["Base regression", reproduction?.base],
                ["PR regression", reproduction?.head],
                ["Candidate regression", fix?.regression],
                ["Existing suite", fix?.existing_suite],
              ].map(([name, run]) => (
                <details open key={name as string}>
                  <summary>
                    {name as string}{" "}
                    <span className="badge">
                      {(run as Run)?.outcome || "pending"}
                    </span>
                  </summary>
                  <pre>{(run as Run)?.log || "No execution recorded."}</pre>
                </details>
              ))}
            </div>
          )}
          <footer className="approval">
            <div>
              <strong>
                {detail.state === "approved"
                  ? "Approved for local application"
                  : "Developer approval required"}
              </strong>
              <small>
                {detail.evidence_digest
                  ? `Evidence ${short(detail.evidence_digest)} · HEAD ${short(detail.head)}`
                  : "Approval unlocks after all validation checks pass."}
              </small>
            </div>
            {detail.state === "awaiting_approval" && canReview && (
              <div className="actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => onDecision("reject")}
                >
                  Reject
                </button>
                <button disabled={busy} onClick={() => onDecision("approve")}>
                  Approve fix
                </button>
              </div>
            )}
            {detail.state === "approved" && (
              <button onClick={onDownload}>Download approved fix</button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
