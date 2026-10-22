import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

/**
 * Where Secret.reveal (the one way to read a Secret) may be referenced in non-test source, and how
 * many times, not counting its declaration. Adding a reference fails this test; the fix is to add
 * the file here, in the same PR that needs it, where a reviewer sees it. The host-side DPAPI store
 * (ticket 21) and the lease-file writer (ticket 34) are the expected additions.
 */
const ALLOWED: Readonly<Record<string, number>> = {};

const REVEAL_MODULE = "src/core/secret.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(repoRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot, undefined, configPath).options;
}

/** The Secret class's reveal member, as declared in `file`. */
function revealDeclaration(program: ts.Program, file: string): ts.Declaration {
  const source = program.getSourceFile(file);
  let found: ts.Declaration | undefined;
  source?.forEachChild((node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === "Secret") {
      found ??= node.members.find((m) => m.name && ts.isIdentifier(m.name) && m.name.text === "reveal");
    }
  });
  if (!found) throw new Error(`no Secret.reveal in ${file}`);
  return found;
}

/** Every reference to Secret.reveal in the program's root files, counted per file (relative to `root`). */
export function revealReferences(program: ts.Program, secretFile: string, root: string): Record<string, number> {
  const checker = program.getTypeChecker();
  const target = revealDeclaration(program, secretFile);
  const isReveal = (symbol: ts.Symbol | undefined) =>
    Boolean(symbol?.declarations?.includes(target));

  const counts: Record<string, number> = {};
  for (const fileName of program.getRootFileNames()) {
    const source = program.getSourceFile(fileName);
    if (!source) continue;
    let count = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isReveal(checker.getSymbolAtLocation(node.name))) count++;
      else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        isReveal(checker.getTypeAtLocation(node.expression).getNonNullableType().getProperty(node.argumentExpression.text))
      )
        count++;
      else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        const text = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
        if (text && isReveal(checker.getTypeAtLocation(node.parent).getProperty(text))) count++;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (count > 0) counts[relative(root, fileName).replaceAll("\\", "/")] = count;
  }
  return counts;
}

/** A program over in-memory files under `root`, falling back to the real files (for the libraries). */
function virtualProgram(root: string, files: Record<string, string>): ts.Program {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const virtual = new Map(Object.entries(files).map(([path, text]) => [join(root, path), text]));
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => {
    const text = virtual.get(name);
    return text === undefined ? getSourceFile(name, lang, ...rest) : ts.createSourceFile(name, text, lang);
  };
  host.fileExists = (name) => virtual.has(name) || fileExists(name);
  host.readFile = (name) => virtual.get(name) ?? readFile(name);
  host.directoryExists = (name) => name === root || name.startsWith(root + "/") || ts.sys.directoryExists(name);
  return ts.createProgram([...virtual.keys()], options, host);
}

describe("Secret.reveal() references", { timeout: 30_000 }, () => {
  it("appear only in the allowlisted files, as many times as the allowlist says", () => {
    const program = ts.createProgram(sourceFiles(join(repoRoot, "src")), compilerOptions());
    expect(revealReferences(program, join(repoRoot, REVEAL_MODULE), repoRoot)).toEqual(ALLOWED);
  });
});

describe("the reference finder", { timeout: 30_000 }, () => {
  const root = join(repoRoot, "virtual");
  const core = Object.fromEntries(
    ["src/core/secret.ts", "src/core/redact.ts"].map((path) => [path, readFileSync(join(repoRoot, path), "utf8")]),
  );
  const find = (code: string) =>
    revealReferences(
      virtualProgram(root, { ...core, "src/use.ts": `import { Secret } from "./core/secret.js";\n${code}` }),
      join(root, REVEAL_MODULE),
      root,
    );

  it("flags a new call site, property read, optional chain, literal element access and destructuring", () => {
    expect(find(`export const f = (s: Secret) => s.reveal();`)).toEqual({ "src/use.ts": 1 });
    expect(find(`export const f = (s: Secret) => { const r = s.reveal; return r.call(s); };`)).toEqual({ "src/use.ts": 1 });
    expect(find(`export const f = (s?: Secret) => s?.reveal?.();`)).toEqual({ "src/use.ts": 1 });
    expect(find(`export const f = (s: Secret) => s["reveal"]();`)).toEqual({ "src/use.ts": 1 });
    expect(find(`export const f = (s: Secret) => { const { reveal } = s; return reveal; };`)).toEqual({ "src/use.ts": 1 });
    expect(find(`export const f = (s: Secret) => { const { reveal: r } = s; return r; };`)).toEqual({ "src/use.ts": 1 });
    expect(find(`export const f = (s: Secret) => [s.reveal(), s.reveal()];`)).toEqual({ "src/use.ts": 2 });
  });

  it("ignores comments, strings and other members named reveal", () => {
    expect(
      find(`// s.reveal()\nexport const t = "reveal()";\nexport const o = { reveal: () => "x" };\nexport const r = o.reveal();`),
    ).toEqual({});
  });
});
