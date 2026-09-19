---
name: architecture
description: How the system fits together
grounds_to:
  - node: "function:a3f8c21d9e4b7f60a1c2d3e4f5061728"
    fingerprint: "mh:64:9f2a4c6e"
---

# Architecture

Prose introducing the system, belonging to no entity.

<!-- mex:entity
id: mx_01KQVXGJ60VSKPKQ4H1GJ2S0CB
type: architecture
status: promoted
revision: 2
topics: [mx_01KRC0G1Y0B27EG9PJMQMMD3RE]
relations:
  - type: depends_on
    target: mx_01KQYKB4T0FC6RE3HSRDJ4AVAH
-->
## Overall shape

Three services behind one gateway, with a shared session store.

### Data flow

Requests enter at the gateway and fan out. This deeper heading is part of the
entity above.

<!-- mex:entity
id: mx_01KQYKB4T0FC6RE3HSRDJ4AVAH
type: component
status: promoted
revision: 1
topics: [mx_01KRC0G1Y0B27EG9PJMQMMD3RE]
grounds_to:
  - node: "function:a3f8c21d9e4b7f60a1c2d3e4f5061728"
    fingerprint: "mh:64:9f2a4c6e"
-->
## Gateway

Terminates TLS, routes by path prefix, and is the only public surface.
