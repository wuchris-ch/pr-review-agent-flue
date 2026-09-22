import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Session,
  type Review,
  type Finding,
  type Reproduction,
  type Fix,
  type Audit,
} from "./contracts";
export function useReviewData(
  token: string,
  setError: (error: string) => void,
) {
  const [session, setSession] = useState<Session | null>(null);
  const [repository, setRepository] = useState("");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Review | null>(null);
  const [finding, setFinding] = useState<Finding | null>(null);
  const [reproduction, setReproduction] = useState<Reproduction | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [intent, setIntent] = useState<{
    accepted: boolean;
    reason: string;
  } | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const currentKey = useRef("");
  currentKey.current = `${token}/${repository}/${selected}`;
  const api = useCallback(
    async <T>(path: string, options: RequestInit = {}): Promise<T> => {
      const response = await fetch(`/api${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail || `Request failed (${response.status})`);
      }
      return response.json();
    },
    [token],
  );
  const refresh = useCallback(async () => {
    const requestKey = currentKey.current;
    const active = () => requestKey === currentKey.current;
    if (!token) return;
    const current = await api<Session>("/session");
    if (!active()) return;
    setSession(current);
    if (!repository) {
      setRepository(current.repositories[0]?.id || "");
      return;
    }
    const list = await api<Review[]>(`/repositories/${repository}/reviews`);
    const activity = await api<Audit[]>(`/repositories/${repository}/audit`);
    if (!active()) return;
    setReviews(list);
    setAudit(activity);
    if (!selected) {
      if (list[0]) setSelected(list[0].id);
      return;
    }
    const review = await api<Review>(`/reviews/${selected}`);
    if (!active()) return;
    const artifact = async <T>(name: string): Promise<T | null> =>
      review.artifacts?.some((a) => a.name === name)
        ? api<T>(`/reviews/${selected}/artifacts/${name}`)
        : null;
    const [investigation, repro, repair, validation] = await Promise.all([
      artifact<{ candidates: Finding[] }>("investigation"),
      artifact<Reproduction>("reproduction"),
      artifact<Fix>("validated_fix"),
      artifact<{ accepted: boolean; reason: string }>("intent"),
    ]);
    if (!active()) return;
    setDetail(review);
    setFinding(investigation?.candidates[0] || null);
    setReproduction(repro);
    setFix(repair);
    setIntent(validation);
  }, [api, token, repository, selected]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch (error) {
        if (active) setError((error as Error).message);
      }
      if (active) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh, setError]);
  function signOut() {
    currentKey.current = "";
    setSession(null);
    setReviews([]);
    setSelected("");
    setRepository("");
    setDetail(null);
    setFinding(null);
    setReproduction(null);
    setFix(null);
    setIntent(null);
    setAudit([]);
  }
  return {
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
  };
}
