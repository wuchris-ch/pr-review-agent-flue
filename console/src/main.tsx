import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

import { type Review, label, short } from "./contracts";
import { useReviewData } from "./useReviewData";
import { ReviewDetail } from "./ReviewDetail";

function App() {
  const [token, setToken] = useState("");
  const [inputToken, setInputToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("Evidence");
  const [showNew, setShowNew] = useState(false);
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [pr, setPr] = useState("1");
  const [provider, setProvider] = useState("");
  const [limit, setLimit] = useState(100);
  const {
    session,
    repository,
    setRepository,
    reviews,
    selected,
    setSelected,
    detail,
    setDetail,
    finding,
    reproduction,
    fix,
    intent,
    audit,
    api,
    refresh,
    signOut,
  } = useReviewData(token, setError);
  useEffect(() => {
    if (session) {
      setProvider(session.provider);
      setLimit(session.review_limit);
    }
  }, [session?.provider, session?.review_limit]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const repo = session?.repositories.find((r) => r.id === repository);
  const canReview = !!repo && repo.role !== "viewer";
  async function decide(decision: "approve" | "reject") {
    if (!detail) return;
    await api(`/reviews/${detail.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        head: detail.head,
        evidence_digest: detail.evidence_digest,
        decision,
      }),
    });
  }
  async function download() {
    if (!detail) return;
    const bundle = await api(`/reviews/${detail.id}/approved-fix`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `approved-fix-${short(detail.head)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  if (!session)
    return (
      <main className="login">
        <div className="brand">
          R<span>Review Platform</span>
        </div>
        <h1>Evidence before approval.</h1>
        <p>
          Investigate changes, reproduce regressions, and review fixes with a
          complete evidence trail.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            setToken(inputToken);
          }}
        >
          <label>
            Workspace access token
            <input
              autoComplete="off"
              type="password"
              value={inputToken}
              onChange={(e) => setInputToken(e.target.value)}
              required
            />
          </label>
          <button>Open workspace</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <small>
          Access is scoped to your tenant and repository roles. Tokens stay in
          memory.
        </small>
      </main>
    );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          R<span>Review Platform</span>
        </div>
        <div className="workspace">
          <span className="eyebrow">WORKSPACE</span>
          <strong>{session.tenant}</strong>
          <span className="muted">Engineering / Code quality</span>
        </div>
        <nav>
          {["Reviews", "Settings", "Audit log"].map((name) => (
            <button
              className={
                tab === name ||
                (name === "Reviews" &&
                  ["Evidence", "Patch", "Execution logs"].includes(tab))
                  ? "active"
                  : ""
              }
              onClick={() => setTab(name === "Reviews" ? "Evidence" : name)}
              key={name}
            >
              {name}
              <span>{name === "Reviews" ? reviews.length : "↗"}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="avatar">{session.user[0].toUpperCase()}</div>
          <div>
            <strong>{session.user}</strong>
            <small>{repo?.role} access</small>
          </div>
          <button
            aria-label="Sign out"
            onClick={() => {
              setToken("");
              setInputToken("");
              signOut();
              setSelected("");
              setRepository("");
            }}
          >
            ↗
          </button>
        </div>
      </aside>
      <main className="main">
        <header>
          <div>
            <span className="eyebrow">REPOSITORY</span>
            <select
              aria-label="Repository"
              value={repository}
              onChange={(e) => {
                setRepository(e.target.value);
                setSelected("");
                setDetail(null);
              }}
            >
              {session.repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <select
            className="mobile-nav"
            aria-label="Console section"
            value={tab}
            onChange={(e) => setTab(e.target.value)}
          >
            <option value="Evidence">Reviews</option>
            <option value="Settings">Settings</option>
            <option value="Audit log">Audit log</option>
          </select>
          <div className="connection">
            <i />
            Connected workspace
          </div>
        </header>
        {error && (
          <div role="alert" className="error">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        <section className="page-heading">
          <div>
            <span className="eyebrow">REVIEW OPERATIONS</span>
            <h1>
              {tab === "Settings"
                ? "Workspace settings"
                : tab === "Audit log"
                  ? "Audit trail"
                  : "Changes, backed by evidence."}
            </h1>
            <p>
              From suspected regression to a tested, developer-approved fix.
            </p>
          </div>
          {canReview && (
            <button onClick={() => setShowNew(!showNew)}>+ New review</button>
          )}
        </section>
        <div className="metrics">
          <div>
            <span>Repository reviews</span>
            <strong>
              {reviews.length}
              <small>tracked revisions</small>
            </strong>
          </div>
          <div>
            <span>Awaiting approval</span>
            <strong>
              {reviews.filter((r) => r.state === "awaiting_approval").length}
              <small>ready for a decision</small>
            </strong>
          </div>
          <div>
            <span>Review allowance</span>
            <strong>
              {session.reviews_used}
              <small>/ {session.review_limit} reserved</small>
            </strong>
          </div>
          <div>
            <span>Model provider</span>
            <strong className="provider">
              {session.provider}
              <small>
                {session.provider === "fixture"
                  ? "Deterministic demonstration"
                  : "Configured specialist provider"}
              </small>
            </strong>
          </div>
        </div>
        {showNew && (
          <form
            className="panel new-review"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const result = await api<Review>(
                  `/repositories/${repository}/reviews`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      base,
                      head,
                      pull_request: Number(pr),
                    }),
                  },
                );
                setSelected(result.id);
                setShowNew(false);
              });
            }}
          >
            <h2>Review immutable revisions</h2>
            <label>
              Pull request
              <input
                value={pr}
                type="number"
                min="1"
                onChange={(e) => setPr(e.target.value)}
              />
            </label>
            <label>
              Base commit
              <input
                value={base}
                pattern="[0-9a-f]{40}"
                required
                onChange={(e) => setBase(e.target.value)}
              />
            </label>
            <label>
              PR commit
              <input
                value={head}
                pattern="[0-9a-f]{40}"
                required
                onChange={(e) => setHead(e.target.value)}
              />
            </label>
            <button disabled={busy}>Start review</button>
          </form>
        )}
        {tab === "Settings" ? (
          <form
            className="panel settings"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() =>
                api("/settings", {
                  method: "PUT",
                  body: JSON.stringify({ provider, review_limit: limit }),
                }),
              );
            }}
          >
            <h2>Providers and usage</h2>
            <p>
              Changes apply to future reviews. Credentials are provisioned on
              the worker.
            </p>
            <label>
              Model provider
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {session.available_providers.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              Lifetime review allowance
              <input
                type="number"
                min="1"
                max="10000"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
            </label>
            <button disabled={busy || repo?.role !== "admin"}>
              Save settings
            </button>
          </form>
        ) : tab === "Audit log" ? (
          <section className="panel">
            <h2>Repository activity</h2>
            {audit.map((a, i) => (
              <div className="audit" key={i}>
                <strong>{a.action}</strong>
                <span>{a.actor}</span>
                <time>{new Date(a.created_at).toLocaleString()}</time>
              </div>
            ))}
          </section>
        ) : (
          <div className="review-grid">
            <section className="review-list">
              <h2>
                Review queue <span>{reviews.length}</span>
              </h2>
              {reviews.length === 0 && (
                <div className="panel">
                  <p>
                    No reviews yet. Start with exact base and PR commits from
                    your repository mirror.
                  </p>
                </div>
              )}
              {reviews.map((r) => (
                <button
                  className={`review-card ${r.id === selected ? "selected" : ""}`}
                  key={r.id}
                  onClick={() => {
                    setSelected(r.id);
                    setDetail(null);
                  }}
                >
                  <div>
                    <strong>Pull request #{r.pull_request}</strong>
                    <span className={`badge ${r.state}`}>{label(r.state)}</span>
                  </div>
                  <p>
                    {short(r.head)} <span>← {short(r.base)}</span>
                  </p>
                  <small>
                    {new Date(r.created_at).toLocaleDateString()} · {r.provider}
                  </small>
                </button>
              ))}
            </section>
            <ReviewDetail
              detail={detail}
              finding={finding}
              reproduction={reproduction}
              fix={fix}
              intent={intent}
              tab={tab}
              canReview={canReview}
              busy={busy}
              onTab={setTab}
              onDecision={(decision) => void act(() => decide(decision))}
              onDownload={() => void act(download)}
            />
          </div>
        )}
        <p className="footnote">
          {session.provider === "fixture"
            ? "Fixture provider uses authored specialist responses. Executions run against real Git revisions."
            : "Specialist findings require executable reproduction and independent validation."}
        </p>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
