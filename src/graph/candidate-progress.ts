import { graphCandidateProgress, type GraphCandidateProgress } from "./candidate-protocol.js";

type ProgressSender = (progress: GraphCandidateProgress, done: () => void) => boolean;

function sendProgress(progress: GraphCandidateProgress, done: () => void): boolean {
  if (!process.send || !process.connected) throw new Error("Candidate parent disconnected.");
  return process.send({ type: "progress", progress }, (error: Error | null) => {
    if (error) process.exit(1);
    done();
  });
}

/** Fixed-size counts, at most four ordinary updates/second, respecting IPC backpressure. */
export function createGraphCandidateProgressSender(
  send: ProgressSender = sendProgress,
  clock: () => number = () => performance.now(),
): (progress: GraphCandidateProgress) => void {
  let lastPhase: GraphCandidateProgress["phase"] | undefined;
  let lastSent = 0;
  let backpressured = false;
  let finalParseSent = false;
  return (raw) => {
    const parsed = graphCandidateProgress.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid graph progress.");
    const progress = parsed.data;
    const finalParse = progress.phase === "parse"
      && progress.total !== undefined && progress.completed === progress.total;
    if (finalParse && finalParseSent) return;
    const now = clock();
    const phaseChanged = progress.phase !== lastPhase;
    if (!phaseChanged && !finalParse && (backpressured || now - lastSent < 250)) return;
    lastPhase = progress.phase;
    lastSent = now;
    if (finalParse) finalParseSent = true;
    // Completion callbacks cannot run while this thread is inside the compiler.
    // Use the channel's actual backpressure signal, not one-callback-at-a-time
    // gating, so counts continue to arrive during synchronous work. The two
    // phase changes and one final parse count may bypass throttling so fast
    // parses do not leave the durable job showing an incomplete file count.
    backpressured = !send(progress, () => { backpressured = false; });
  };
}
