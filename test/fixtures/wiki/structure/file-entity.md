---
name: api-error-pattern
description: Standard API error handling
triggers:
  - "API error"
last_updated: 2026-08-22
mex:
  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD
  type: pattern
  status: promoted
  revision: 1
  topics: [mx_01BX5ZZKBKACTAV9WEVGEMMVRZ]
  relations:
    - type: constrained_by
      target: mx_01D78XYFJ1PRM1WPBCBT3VHMNV
  sources: []
  grounds_to:
    - node: "function:a3f8c21d9e4b7f60a1c2d3e4f5061728"
      fingerprint: "mh:64:9f2a4c6e"
---

# API error handling

Every handler returns a problem document rather than a bare string.

The shape is stable across services so clients can parse one thing.
