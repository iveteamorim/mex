# Patterns

Retention is the open question. The raw store keeps every message and has
no expiry, so the volume fills on a schedule nobody has written down and
ingest starts refusing when it does.

Rules are data and are reloaded without a restart, which took the deploy
out of the loop and put validation on the critical path. A malformed rule
set now reaches production with only the loader standing in front of it.

The bootstrap target is safe to re-run. It drops and recreates the local
database only, applies every migration in order, and loads a fixture set
with three queues and a handful of threads.

A health check that sends a message and reads it back is the only thing
that would catch a stalled sender, because tickets continue to look
answered from the operator's side while replies pile up unsent.
