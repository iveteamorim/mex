import {
  MexPortError,
  type MexErrorCode,
  type RepoRelativePath,
} from "../contracts/shared.js";

export function artifactError(
  code: MexErrorCode,
  title: string,
  detail: string,
  path?: RepoRelativePath,
): MexPortError {
  return new MexPortError({
    title,
    status: statusFor(code),
    code,
    detail,
    ...(path === undefined
      ? {}
      : {
          diagnostics: [{
            code,
            severity: "error",
            message: detail,
            path,
          }],
        }),
  });
}

function statusFor(code: MexErrorCode): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "REVISION_CONFLICT") return 409;
  if (code === "PATH_OUTSIDE_PROJECT") return 400;
  if (code === "VALIDATION_FAILED" || code === "INVALID_REQUEST") return 422;
  return 500;
}
