/**
 * Read the machine-readable code of a structured host error.
 *
 * Host commands that distinguish expected states from failures serialize a
 * `{ code, message }` pair across the IPC boundary. Anything else — a bare
 * string, a transport `Error` — has no code and must be treated as a failure.
 */
export function getErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.trim()
  ) {
    return error.code;
  }

  return null;
}

export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }

  return fallback;
}
