import {
  RelayDetailSchema,
  RelayDraftDetailSchema,
  RelayDraftIdSchema,
  RelayDraftListResponseSchema,
  RelayIdSchema,
  RelayListResponseSchema,
  RelayOperationApplyResponseSchema,
  RelayOperationPreviewResponseSchema,
} from "@mex/hub-contracts/relay";
import type {
  RelayDetail,
  RelayDraftDetail,
  RelayDraftListRequest,
  RelayDraftListResponse,
  RelayListRequest,
  RelayListResponse,
  RelayOperationApplyRequest,
  RelayOperationApplyResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
} from "./types";

interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface RelayTransport {
  request<T>(
    path: string,
    schema: Parser<T>,
    init?: RequestInit,
    mutation?: boolean,
  ): Promise<T>;
  invalidIdentifier(detail: string): never;
}

function identifier(
  transport: RelayTransport,
  schema: Parser<string>,
  value: string,
  detail: string,
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) transport.invalidIdentifier(detail);
  return parsed.data;
}

export function strictRelayPreviewEnvelope(
  value: unknown,
): RelayOperationPreviewResponse | null {
  const parsed = RelayOperationPreviewResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function getRelayDrafts(
  transport: RelayTransport,
  request: RelayDraftListRequest,
): Promise<RelayDraftListResponse> {
  const params = new URLSearchParams({ limit: String(request.limit) });
  if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
  return transport.request(`/relays/drafts?${params}`, RelayDraftListResponseSchema);
}

export function getRelayDraft(
  transport: RelayTransport,
  id: string,
): Promise<RelayDraftDetail> {
  const safeId = identifier(
    transport,
    RelayDraftIdSchema,
    id,
    "The Relay draft identifier is invalid.",
  );
  return transport.request(
    `/relays/drafts/${encodeURIComponent(safeId)}`,
    RelayDraftDetailSchema,
  );
}

export function getRelays(
  transport: RelayTransport,
  request: RelayListRequest,
): Promise<RelayListResponse> {
  const params = new URLSearchParams({
    perspective: request.perspective,
    limit: String(request.limit),
  });
  if (request.states?.length) params.set("state", request.states.join(","));
  if (request.workstreamId) params.set("workstreamId", request.workstreamId);
  if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
  return transport.request(`/relays?${params}`, RelayListResponseSchema);
}

export function getRelay(
  transport: RelayTransport,
  id: string,
): Promise<RelayDetail> {
  const safeId = identifier(
    transport,
    RelayIdSchema,
    id,
    "The Relay identifier is invalid.",
  );
  return transport.request(`/relays/${encodeURIComponent(safeId)}`, RelayDetailSchema);
}

export function previewRelayOperation(
  transport: RelayTransport,
  request: RelayOperationPreviewRequest,
): Promise<RelayOperationPreviewResponse> {
  return transport.request(
    "/relays/operations/preview",
    RelayOperationPreviewResponseSchema,
    { method: "POST", body: JSON.stringify(request) },
    true,
  );
}

export function applyRelayOperation(
  transport: RelayTransport,
  request: RelayOperationApplyRequest,
): Promise<RelayOperationApplyResponse> {
  return transport.request(
    "/relays/operations/apply",
    RelayOperationApplyResponseSchema,
    { method: "POST", body: JSON.stringify(request) },
    true,
  );
}
