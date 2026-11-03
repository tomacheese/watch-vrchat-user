import type { DestinationConfig } from './config-file'

/** Compiled CEL expression, evaluated by passing a context */
export type CompiledProgram = (context: Record<string, unknown>) => unknown

/** Compiled rule */
export interface CompiledRule {
  /** Rule name (unique within the config) */
  name: string
  /** Whether the rule is enabled */
  enabled: boolean
  /** Destination names to notify */
  destinations: string[]
  /** Original CEL expression, used to rebuild it in the Worker and the persistent outbox */
  when?: string
  /** Compiled condition */
  program: CompiledProgram
}

/**
 * Immutable snapshot of the config in effect at a point in time
 *
 * An event is evaluated to the end with the snapshot taken when it was accepted (enqueued).
 */
export interface ConfigSnapshot {
  /** Destination definitions keyed by destination name */
  readonly destinations: Readonly<Record<string, DestinationConfig>>
  /** Compiled rules in config file order */
  readonly rules: readonly CompiledRule[]
  /** Load time (ISO 8601) */
  readonly loadedAt: string
}
