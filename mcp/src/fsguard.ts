import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, relative, resolve } from "node:path";

/** Folders the MCP may write flows into. Default: the directory the server was started in. */
export function flowRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MAESTRO_DECK_FLOWS_DIRS;
  const roots = raw ? raw.split(delimiter).filter(Boolean) : [process.cwd()];
  return roots.map((r) => resolve(r));
}

/** The real path of the nearest existing ancestor, so a symlink cannot lead outside a root. */
function realAncestor(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return realpathSync(cur);
}

/**
 * Resolves a flow path for writing and checks it stays inside an allowed folder and is a YAML file.
 * Returns the absolute path, or throws with a message that says what is allowed.
 */
export function resolveWritableFlow(path: string, roots: string[]): string {
  const base = roots[0] ?? process.cwd();
  const abs = isAbsolute(path) ? resolve(path) : resolve(base, path);
  if (![".yaml", ".yml"].includes(extname(abs))) throw new Error("A flow file must end in .yaml or .yml.");
  const real = resolve(realAncestor(dirname(abs)), abs.slice(dirname(abs).length + 1));
  const inside = roots.some((root) => {
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    const rel = relative(realRoot, real);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!inside) {
    throw new Error(`Writing outside the allowed folders is refused. Allowed: ${roots.join(", ")}. Set MAESTRO_DECK_FLOWS_DIRS to allow more.`);
  }
  return abs;
}
