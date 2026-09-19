---
name: decisions
description: Architectural decisions
---

# Decisions

<!-- mex:entity
id: mx_01KR3Z0A20R4MWJHNSHJJ2ZJ1R
type: decision
status: promoted
revision: 1
topics: [mx_01KRC0G1Y0B27EG9PJMQMMD3RE]
sources:
  - type: commit
    ref: 8f21a3c
-->
## Rotate refresh tokens

Refresh tokens are single-use and rotated after every successful refresh. The
implementation lives in [rotateRefreshToken](mex://function:a3f8c21d9e4b7f60a1c2d3e4f5061728).

<!-- mex:entity
id: mx_01KR6MTWP0C0HHBN2WXC06REXC
type: decision
status: deprecated
revision: 2
relations:
  - type: supersedes
    target: mx_01KR3Z0A20R4MWJHNSHJJ2ZJ1R
-->
## Cache session lookups

Superseded by the gateway-level cache.
