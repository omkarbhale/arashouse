// A small option parser for the CLI: `--name value`, `--name=value`, boolean flags, options that may be
// repeated, and `--` to end the options (everything after it is passed through untouched, for `run`).

import { UsageError } from "../core/lease.js";

/**
 * `flag`: takes no value. `value`: needs one (`--holder x` or `--holder=x`). `optional`: a flag that may
 * carry a value only in the `--wait=30` form, so a positional argument after it is never swallowed.
 * `list`: needs a value, and may be given again; its values are in `lists`, in order.
 */
export type OptionKind = "flag" | "value" | "optional" | "list";

export interface ParsedArgs {
  readonly positionals: readonly string[];
  /** A flag maps to `true`; an option with a value to its text. */
  readonly options: Readonly<Record<string, string | true>>;
  /** Each `list` option given, with its values in order. */
  readonly lists: Readonly<Record<string, readonly string[]>>;
  /** What followed `--`; undefined when there was no `--`. */
  readonly rest: readonly string[] | undefined;
}

export function parseArgs(args: readonly string[], spec: Readonly<Record<string, OptionKind>>): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  const lists: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return { positionals, options, lists, rest: args.slice(i + 1) };
    if (!arg.startsWith("--") || arg === "-") {
      if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option ${arg}`);
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (kind === undefined) throw new UsageError(`unknown option --${name}`);
    if (kind === "list") {
      const value = eq !== -1 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === "--" || value === "") throw new UsageError(`--${name} needs a value`);
      (lists[name] ??= []).push(value);
      continue;
    }
    if (Object.hasOwn(options, name)) throw new UsageError(`--${name} given twice`);
    if (kind === "flag") {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      options[name] = true;
    } else if (eq !== -1) {
      options[name] = arg.slice(eq + 1);
    } else if (kind === "optional") {
      options[name] = true;
    } else {
      const value = args[i + 1];
      if (value === undefined || value === "--") throw new UsageError(`--${name} needs a value`);
      options[name] = value;
      i++;
    }
  }
  return { positionals, options, lists, rest: undefined };
}

/** The text of a value option, or undefined when it was not given. */
export function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  return value === true ? undefined : value;
}

/** A number of seconds (0 or more); `label` names the option in the error. */
export function parseSeconds(text: string, label: string): number {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new UsageError(`${label} must be a number of seconds, 0 or more`);
  return Number(text);
}
