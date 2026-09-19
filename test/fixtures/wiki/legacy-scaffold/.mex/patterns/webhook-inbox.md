---
name: webhook-inbox
description: Persist webhook deliveries before processing
edges:
  - target: ../context/architecture.md
    condition: the inbox protects payment capture retries
triggers:
  - "webhook retry"
last_updated: "2026-08-01"
---

# Webhook inbox

Store the delivery identifier before invoking business logic. Duplicate delivery identifiers are acknowledged without running capture twice.
