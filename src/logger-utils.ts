/**
 * Converts an unknown value to an Error instance
 *
 * The error received in a catch clause is typed unknown, so it cannot be passed
 * as-is to the second argument of Logger.error/warn (which requires an Error);
 * non-Error values are stringified and wrapped
 *
 * @param error Value to convert
 * @returns An Error instance
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
