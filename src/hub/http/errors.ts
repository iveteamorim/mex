import { randomUUID } from "node:crypto";
import {
  HUB_LIMITS,
  HubProblemCodeSchema,
  HubProblemDetailsSchema,
  type HubProblemCode,
  type HubProblemDetails,
} from "@mex/hub-contracts";
import type { Context } from "hono";
import { ZodError, type ZodTypeAny, type output } from "zod";
import { HubSecurityError } from "../security/session.js";

const SAFE_PORT_PROJECTIONS: Record<HubProblemCode, {
  readonly title: string;
  readonly detail: string;
}> = {
  NOT_FOUND: {
    title: "Resource not found",
    detail: "The requested local resource was not found.",
  },
  VALIDATION_FAILED: {
    title: "Validation failed",
    detail: "The local operation rejected invalid input.",
  },
  REVISION_CONFLICT: {
    title: "Revision conflict",
    detail: "The local state changed before the operation completed; refresh and retry.",
  },
  INDEX_MISSING: {
    title: "Index missing",
    detail: "The required local index is missing.",
  },
  INDEX_STALE: {
    title: "Index stale",
    detail: "The required local index is stale.",
  },
  INDEX_CORRUPT: {
    title: "Index corrupt",
    detail: "The required local index could not be read safely.",
  },
  MIGRATION_REQUIRED: {
    title: "Migration required",
    detail: "The local state requires an explicit supported migration.",
  },
  PATH_OUTSIDE_PROJECT: {
    title: "Unsafe project path",
    detail: "The local operation refused a path outside the project boundary.",
  },
  JOB_ALREADY_RUNNING: {
    title: "Job already running",
    detail: "An index-mutating job is already active for this project.",
  },
  JOB_FAILED: {
    title: "Job failed",
    detail: "The local job did not complete.",
  },
  INVALID_REQUEST: {
    title: "Invalid request",
    detail: "The local operation rejected the request.",
  },
  UNAUTHORIZED: {
    title: "Authentication required",
    detail: "A valid local Hub session is required.",
  },
  ORIGIN_REJECTED: {
    title: "Origin rejected",
    detail: "The local Hub rejected the request origin.",
  },
  CAPABILITY_UNAVAILABLE: {
    title: "Capability unavailable",
    detail: "The requested local capability is unavailable.",
  },
  OPERATION_INTERRUPTED: {
    title: "Operation interrupted",
    detail: "The local operation did not complete against a stable snapshot.",
  },
  RATE_LIMITED: {
    title: "Request limit reached",
    detail: "The local Hub request limit has been reached.",
  },
  RESPONSE_TOO_LARGE: {
    title: "Response too large",
    detail: "The local result exceeded its safe response bound.",
  },
  INTERNAL_ERROR: {
    title: "Internal error",
    detail: "The local Hub could not complete the request.",
  },
};

export class HubHttpError extends Error {
  readonly status: number;
  readonly code: HubProblemCode;
  readonly title: string;

  constructor(status: number, code: HubProblemCode, title: string, detail: string) {
    super(detail);
    this.name = "HubHttpError";
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

export interface HubRequestVariables {
  requestId: string;
}

export function createRequestId(): string {
  return randomUUID();
}

export function invalidRequest(detail: string): HubHttpError {
  return new HubHttpError(400, "INVALID_REQUEST", "Invalid request", detail);
}

export function validationFailed(detail: string): HubHttpError {
  return new HubHttpError(400, "VALIDATION_FAILED", "Validation failed", detail);
}

export function notFound(detail: string): HubHttpError {
  return new HubHttpError(404, "NOT_FOUND", "Resource not found", detail);
}

export function unavailable(detail: string): HubHttpError {
  return new HubHttpError(
    503,
    "CAPABILITY_UNAVAILABLE",
    "Capability unavailable",
    detail,
  );
}

export function parseInput<TSchema extends ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidRequest(formatZodIssues(parsed.error));
  }
  return parsed.data;
}

export function resourceResponse<TSchema extends ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  status = 200,
): Response {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HubHttpError(
      500,
      "INTERNAL_ERROR",
      "Invalid service response",
      "A local Hub service returned data that did not match its private API contract.",
    );
  }
  return serializedJsonResponse(parsed.data, status);
}

export function serializedJsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > HUB_LIMITS.maxJsonResponseBytes) {
    throw new HubHttpError(
      500,
      "RESPONSE_TOO_LARGE",
      "Response too large",
      "The local Hub response exceeded its safe serialized size.",
    );
  }
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

export function problemResponse(context: Context, error: unknown): Response {
  const normalized = normalizeError(error);
  const requestId = context.get("requestId") as string | undefined ?? createRequestId();
  const problem: HubProblemDetails = HubProblemDetailsSchema.parse({
    type: "about:blank",
    title: boundedText(normalized.title, 256, "Request failed"),
    status: normalized.status,
    code: normalized.code,
    detail: boundedText(
      normalized.detail,
      4_096,
      "The local Hub could not complete the request.",
    ),
    instance: context.req.path.slice(0, 4_096) || "/",
    requestId,
    ...(normalized.activeJobId === undefined
      ? {}
      : { activeJobId: normalized.activeJobId }),
  });
  const response = serializedJsonResponse(problem, normalized.status);
  response.headers.set("content-type", "application/problem+json; charset=UTF-8");
  response.headers.set("x-request-id", requestId);
  return response;
}

function normalizeError(error: unknown): {
  status: number;
  code: HubProblemCode;
  title: string;
  detail: string;
  activeJobId?: string;
} {
  if (error instanceof HubHttpError || error instanceof HubSecurityError) {
    return {
      status: error.status,
      code: error.code,
      title: error.title,
      detail: error.message,
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      title: "Invalid request",
      detail: formatZodIssues(error),
    };
  }

  const portProblem = readPortProblem(error);
  if (portProblem !== null) return portProblem;

  return {
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal error",
    detail: "The local Hub could not complete the request.",
  };
}

function readPortProblem(error: unknown): {
  status: number;
  code: HubProblemCode;
  title: string;
  detail: string;
  activeJobId?: string;
} | null {
  if (typeof error !== "object" || error === null || !("problem" in error)) return null;
  const problem = (error as { problem?: unknown }).problem;
  if (typeof problem !== "object" || problem === null) return null;
  const candidate = problem as Record<string, unknown>;
  const code = candidate.code;
  const parsedCode = HubProblemCodeSchema.safeParse(code);
  if (!parsedCode.success) {
    return {
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal error",
      detail: "The local Hub operation returned an unsupported failure.",
    };
  }
  const supportedCode = parsedCode.data;
  const safeProjection = SAFE_PORT_PROJECTIONS[supportedCode];
  const status = typeof candidate.status === "number"
    && Number.isInteger(candidate.status)
    && candidate.status >= 400
    && candidate.status <= 599
    ? candidate.status
    : 500;
  return {
    status,
    code: supportedCode,
    title: safeProjection.title,
    detail: safeProjection.detail,
    ...(supportedCode === "JOB_ALREADY_RUNNING"
      && typeof candidate.activeJobId === "string"
      && /^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(candidate.activeJobId)
      ? { activeJobId: candidate.activeJobId }
      : {}),
  };
}

function boundedText(value: string, maximum: number, fallback: string): string {
  if (value.length === 0) return fallback;
  return value.slice(0, maximum);
}

function formatZodIssues(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "The request did not match the expected schema.";
  const location = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `The request is invalid${location}: ${issue.message}`.slice(0, 4_096);
}
