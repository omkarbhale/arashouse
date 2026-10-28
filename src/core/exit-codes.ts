// The CLI's stable exit codes (documented in docs/lease.md and docs/cli.md).
// 1 is any other failure. 8 is `SECRET_REQUIRED_EXIT_CODE` (licence.ts): a step needs a secret and no TTY can ask.

export const EXIT_CODES = {
  ok: 0,
  usage: 2,
  /** No slot of the flavor can be handed out now (none free, or the governor refused). */
  noSlot: 3,
  /** `return --if-lease-id` named a lease the slot no longer holds (ABA protection). */
  leaseMismatch: 4,
  /** The slot's reset failed and it is quarantined, or the reset being waited for did not finish. */
  resetFailed: 5,
  hostUnreachable: 6,
  /** A guard refused: the host or a core guard would not touch what was named. */
  refused: 7,
  /** A `get --import` or `import` step failed (libs-js `aras-pkg import` exited non-zero); `get` returned the lease unless `--keep-on-fail`. */
  importFailed: 9,
  /** A code deploy (`get --code`, `deploy-code`, ticket 40) failed after the lease was taken; the lease is still held unless `get --atomic` returned it. */
  codeFailed: 10,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
