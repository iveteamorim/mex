---
name: checkout-architecture
description: Legacy checkout architecture notes
grounds_to:
  - node: "function:persistCaptureAttempt"
    fingerprint: "mh:64:1111111111111111"
last_updated: "2026-08-01"
---

# Checkout architecture

The capture attempt is persisted before calling the payment gateway.

## Retry path

[`retryPaymentCapture()`](mex://function:retryPaymentCapture) reuses the original idempotency key.

## Delivery path

Webhook deliveries enter the durable inbox before processing.
