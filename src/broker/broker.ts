// The broker: a fixed registry of verbs, each bound to a host-driver method. `handle` takes one
// request, validates it, runs the guards on its target (`assertSlotOwned` or `assertFlavorOwned`,
// ticket 10), runs the verb under a time bound, writes one audit line, and answers. It never throws:
// every failure is an error response of a `HostErrorKind`, its message redacted.
//
// This file is transport-free; pipe.ts puts it behind the named pipe and index.ts starts it as the
// Windows service. Tickets 25, 30, 31, 33, 39, 40 and 43 register their verbs the way verbs.ts does.

import type { FlavorKey } from "../core/flavors.js";
import { GuardError } from "../core/guards.js";
import { DEFAULT_INSTALL_ROOT, type SlotNames, type SlotRef } from "../core/names.js";
import { redact } from "../core/redact.js";
import { systemClock, type Clock } from "../host/clock.js";
import type { HostMethod } from "../host/driver.js";
import { HostError } from "../host/errors.js";
import { assertFlavorOwned, assertSlotOwned, type OwnedContext } from "../host/owned.js";
import type { AuditEntry, AuditOutcome, AuditSink } from "./audit.js";
import {
  ProtocolError,
  errorResponse,
  parseRequest,
  requestIdOf,
  targetOf,
  verbTimeout,
  type BrokerRequest,
  type BrokerResponse,
  type WireResult,
} from "./protocol.js";

/** What a verb is given: the validated request and the names its target resolved to. */
export interface VerbContext {
  readonly request: BrokerRequest;
  readonly root: string;
  /** The slot and every name it owns, for a `slot` verb, after the guards passed. */
  readonly slot?: SlotRef;
  readonly names?: SlotNames;
  /** The flavor, for a `flavor` verb, after the guards passed. */
  readonly flavor?: FlavorKey;
  /** The verb's arguments, as its `args` check returned them. */
  readonly args: unknown;
}

export interface VerbSpec {
  /** What the request must name: nothing, a slot record or a flavor. */
  readonly target: "none" | "slot" | "flavor";
  /** Checks and returns the verb's arguments; throws to refuse. Absent: the verb takes none. */
  readonly args?: (args: Readonly<Record<string, unknown>>) => unknown;
  /** The time the verb may take (default `verbTimeout(verb)`); past it the caller is answered `Retryable`. */
  readonly timeoutMs?: number;
  run(ctx: VerbContext): Promise<WireResult>;
}

export interface BrokerOptions {
  /** The install root; defaults to `DEFAULT_INSTALL_ROOT`. */
  readonly root?: string;
  /** Forwarded to the guards: the host's junction and real-path probes. */
  readonly isReparsePoint?: (path: string) => boolean;
  readonly realPath?: (path: string) => string;
  readonly audit?: AuditSink;
  readonly clock?: Clock;
  /** Told when an audit line could not be written; the request is still answered. */
  readonly onAuditError?: (err: unknown) => void;
}

/** The kind a failure is answered with: its own for a `HostError`, `Refused` for a guard or protocol error, else `Retryable`. */
function failureOf(err: unknown): { kind: HostError["kind"]; message: string } {
  if (err instanceof HostError) return { kind: err.kind, message: redact(err.message) };
  if (err instanceof GuardError || err instanceof ProtocolError) return { kind: "Refused", message: redact(err.message) };
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "Retryable", message: redact(`the broker failed: ${message}`) };
}

export class Broker {
  private readonly verbs = new Map<HostMethod, VerbSpec>();
  private readonly root: string;
  private readonly owned: OwnedContext;
  private readonly clock: Clock;

  constructor(private readonly options: BrokerOptions = {}) {
    this.root = options.root ?? DEFAULT_INSTALL_ROOT;
    this.owned = { root: this.root, isReparsePoint: options.isReparsePoint, realPath: options.realPath };
    this.clock = options.clock ?? systemClock;
  }

  /** Adds a verb. A verb is registered once; a second registration is a programming error. */
  register(verb: HostMethod, spec: VerbSpec): this {
    if (this.verbs.has(verb)) throw new Error(`the broker already has a "${verb}" verb`);
    this.verbs.set(verb, spec);
    return this;
  }

  /** The registered verbs, in registration order. */
  registered(): HostMethod[] {
    return [...this.verbs.keys()];
  }

  /** Answers one request. Never throws. */
  async handle(raw: unknown): Promise<BrokerResponse> {
    const started = this.clock.now();
    const time = new Date(started).toISOString();
    let request: BrokerRequest | undefined;
    let response: BrokerResponse;
    let outcome: AuditOutcome;
    try {
      request = parseRequest(raw);
      const result = await this.run(request);
      response = { id: request.id, ok: true, result };
      outcome = result.ok ? "ok" : "not-ok";
    } catch (err) {
      const failure = failureOf(err);
      response = errorResponse(request?.id ?? requestIdOf(raw), failure.kind, failure.message);
      outcome = request ? failure.kind : "malformed";
    }
    await this.audit({
      time,
      id: request?.id ?? null,
      verb: request?.verb ?? null,
      target: request ? targetOf(request) : null,
      outcome,
      ms: Math.max(0, this.clock.now() - started),
    });
    return response;
  }

  /** Records a request the transport refused before it reached `handle` (no token, too large, not JSON). */
  async rejected(outcome: "unauthorised" | "malformed", started: number): Promise<void> {
    await this.audit({
      time: new Date(started).toISOString(),
      id: null,
      verb: null,
      target: null,
      outcome,
      ms: Math.max(0, this.clock.now() - started),
    });
  }

  private async audit(entry: AuditEntry): Promise<void> {
    if (!this.options.audit) return;
    try {
      await this.options.audit.write(entry);
    } catch (err) {
      this.options.onAuditError?.(err);
    }
  }

  private async run(request: BrokerRequest): Promise<WireResult> {
    const spec = this.verbs.get(request.verb);
    if (!spec) throw new HostError("Refused", `the broker has no "${request.verb}" verb`);
    const ctx = this.resolve(spec, request);
    const work = spec.run(ctx);
    const timeoutMs = spec.timeoutMs ?? verbTimeout(request.verb);
    let timer: NodeJS.Timeout | undefined;
    const overrun = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HostError("Retryable", `${request.verb} did not finish within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const result = await Promise.race([work, overrun]);
      if (typeof result?.ok !== "boolean" || typeof result.detail !== "string") {
        throw new Error(`${request.verb} returned no ok and detail`);
      }
      return { ...result, detail: redact(result.detail) };
    } finally {
      clearTimeout(timer);
      // A verb that overran still settles later; its failure has nowhere to go.
      work.catch(() => {});
    }
  }

  /** The target checks and guards, then the context the verb runs with. */
  private resolve(spec: VerbSpec, request: BrokerRequest): VerbContext {
    const base = { request, root: this.root };
    const args = this.argsOf(spec, request);
    switch (spec.target) {
      case "none":
        if (request.slot || request.flavor !== undefined) throw new ProtocolError(`${request.verb} names no slot or flavor`);
        return { ...base, args };
      case "slot": {
        if (!request.slot) throw new ProtocolError(`${request.verb} needs a slot`);
        const names = assertSlotOwned(request.slot, this.owned);
        return { ...base, args, slot: request.slot, names };
      }
      case "flavor": {
        if (request.flavor === undefined) throw new ProtocolError(`${request.verb} needs a flavor`);
        assertFlavorOwned(request.flavor, this.owned);
        return { ...base, args, flavor: request.flavor };
      }
    }
  }

  private argsOf(spec: VerbSpec, request: BrokerRequest): unknown {
    const args = request.args ?? {};
    if (spec.args) return spec.args(args);
    if (Object.keys(args).length > 0) throw new ProtocolError(`${request.verb} takes no arguments`);
    return undefined;
  }
}

/** A transport that hands requests straight to an in-process broker (the round trip through JSON kept). */
export function inProcessTransport(broker: Broker): { call(request: BrokerRequest): Promise<unknown> } {
  return { call: async (request) => JSON.parse(JSON.stringify(await broker.handle(JSON.parse(JSON.stringify(request))))) };
}
