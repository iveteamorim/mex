import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HubApi } from "../api/client";
import { Button } from "../components/primitives/button";
import { appendTranscript, emptyTranscript, transcriptWindow } from "./setup-transcript-buffer";
import styles from "../styles/setup.module.css";

type TranscriptApi = Pick<HubApi, "subscribeToSetupTranscript">;

export function SetupTranscript({ runId, api }: { runId: string; api: TranscriptApi }) {
  // A new run must not inherit content, cursors, or scroll state from its predecessor.
  return <TranscriptSession key={runId} runId={runId} api={api} />;
}

function TranscriptSession({ runId, api }: { runId: string; api: TranscriptApi }) {
  const [buffer, setBuffer] = useState(emptyTranscript);
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [windowEnd, setWindowEnd] = useState<number | null>(null);
  const [following, setFollowing] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pageChanged = useRef(false);

  useEffect(() => {
    let active = true;
    const subscription = api.subscribeToSetupTranscript?.(runId, (batch) => {
      if (!active || batch.runId !== runId) return;
      setConnection("connected");
      setBuffer((current) => appendTranscript(current, batch));
    }, () => { if (active) setConnection("reconnecting"); });
    return () => { active = false; subscription?.close(); };
  }, [api, runId]);

  const { rows, olderCount, laterCount } = transcriptWindow(buffer.entries, windowEnd);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (follow.current) element.scrollTop = element.scrollHeight;
    else if (pageChanged.current) element.scrollTop = 0;
    pageChanged.current = false;
  }, [buffer.cursor, windowEnd]);

  const showLatest = () => { follow.current = true; setFollowing(true); setWindowEnd(null); };
  const showEarlier = () => {
    const first = rows[0];
    if (!first) return;
    follow.current = false;
    pageChanged.current = true;
    setFollowing(false);
    setWindowEnd(first.id - 1);
  };

  return (
    <section className={styles.transcript} aria-label="Background session output">
      <div className={styles.transcriptHeader}>
        <strong>Session output</strong>
        <span>{buffer.done ? "Session ended" : connection === "reconnecting" ? "Reconnecting…" : connection === "connecting" ? "Connecting…" : "Live · read only"}</span>
      </div>
      {buffer.truncated ? <p className={styles.transcriptNotice}>Earlier output is no longer retained. Showing the available session history.</p> : null}
      {olderCount > 0 ? <Button className={styles.transcriptEarlier} type="button" size="xs" variant="ghost" onClick={showEarlier}>Show earlier output</Button> : null}
      <div
        ref={viewport}
        className={styles.transcriptViewport}
        role="region"
        aria-label="Agent session transcript"
        aria-live="off"
        tabIndex={0}
        onScroll={() => {
          const element = viewport.current;
          if (!element) return;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
          if (!atBottom && follow.current) {
            follow.current = false;
            setFollowing(false);
            setWindowEnd(buffer.entries.at(-1)?.id ?? null);
          } else if (atBottom && laterCount === 0 && !follow.current && !pageChanged.current) showLatest();
        }}
      >
        {rows.length === 0 ? <p className={styles.transcriptEmpty}>{buffer.done ? "This session produced no output." : "Waiting for session output…"}</p> : rows.map((entry) => (
          <div key={entry.id} className={entry.kind === "assistant" ? styles.transcriptEntry : styles.transcriptMarker} data-kind={entry.kind}>
            {entry.kind === "assistant" ? <>
              <p className={styles.transcriptProse}>{entry.text}</p>
              {entry.truncated ? <span className={styles.transcriptShortened}>Message shortened</span> : null}
            </> : <><span aria-hidden="true">·</span><span>{entry.text}{entry.count > 1 ? ` × ${entry.count}` : ""}</span></>}
          </div>
        ))}
      </div>
      <div className={styles.transcriptFooter}>
        <span>{following ? "Following latest output" : "Viewing earlier output"}</span>
        {!following ? <Button type="button" size="xs" variant="outline" onClick={showLatest}>Follow latest{laterCount > 0 ? " · new output" : ""}</Button> : null}
      </div>
    </section>
  );
}
