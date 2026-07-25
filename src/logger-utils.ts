/**
 * unknown 型の値を Error インスタンスに変換する
 *
 * catch 節で受け取る error は TypeScript 上 unknown 型であり、
 * Logger.error/warn の第 2 引数 (Error 型必須) にそのまま渡せないため、
 * Error でない場合は文字列化してラップする
 *
 * @param error 変換対象の値
 * @returns Error インスタンス
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
