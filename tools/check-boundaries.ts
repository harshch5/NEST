import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * A module may import its own files, the platform, or another module's
 * public index. Type-only imports are included because they are still imports.
 */
export interface Violation {
  file: string;
  importPath: string;
  reason: string;
}

interface Token {
  kind: "identifier" | "string" | "punctuation";
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;

    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      let value = "";
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          i++;
          if (i < source.length) value += source[i++]!;
        } else {
          value += source[i++]!;
        }
      }
      if (i < source.length) i++;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (char === "`") {
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
        } else if (source[i] === "`") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = i++;
      while (i < source.length && /[\w$]/.test(source[i]!)) i++;
      tokens.push({ kind: "identifier", value: source.slice(start, i) });
      continue;
    }

    tokens.push({ kind: "punctuation", value: char });
    i++;
  }

  return tokens;
}

function importedPaths(source: string): string[] {
  const tokens = tokenize(source);
  const paths: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "identifier" || (token.value !== "import" && token.value !== "export")) continue;
    if (tokens[i - 1]?.value === ".") continue;

    const next = tokens[i + 1];
    if (token.value === "import" && next?.kind === "string") {
      paths.push(next.value);
      continue;
    }
    if (token.value === "import" && next?.value === "(" && tokens[i + 2]?.kind === "string") {
      paths.push(tokens[i + 2]!.value);
      continue;
    }
    if (token.value === "import" && next?.value === ".") continue;

    let braces = 0;
    let brackets = 0;
    let parens = 0;
    for (let j = i + 1; j < tokens.length; j++) {
      const current = tokens[j]!;
      if (current.value === ";" && braces === 0 && brackets === 0 && parens === 0) break;
      if (
        current.kind === "identifier" &&
        current.value === "from" &&
        braces === 0 &&
        brackets === 0 &&
        parens === 0 &&
        tokens[j + 1]?.kind === "string"
      ) {
        paths.push(tokens[j + 1]!.value);
        break;
      }

      if (current.value === "{") braces++;
      else if (current.value === "}") braces--;
      else if (current.value === "[") brackets++;
      else if (current.value === "]") brackets--;
      else if (current.value === "(") parens++;
      else if (current.value === ")") parens--;
    }
  }

  return paths;
}

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

function resolvedImportCandidates(importer: string, importPath: string): string[] {
  if (!importPath.startsWith(".")) return [];

  const target = resolve(dirname(importer), importPath);
  const extension = extname(target);
  if (extension === ".js") {
    return [target.slice(0, -3) + ".ts", target];
  }
  if (extension) return [target];
  return [target, `${target}.ts`, resolve(target, "index.ts")];
}

function isWithin(directory: string, target: string): boolean {
  const relativePath = relative(directory, target);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

export function findViolations(root: string): Violation[] {
  const sourceRoot = resolve(root);
  const modulesRoot = resolve(sourceRoot, "modules");
  const platformRoot = resolve(sourceRoot, "platform");
  const violations: Violation[] = [];

  for (const file of listTypeScriptFiles(modulesRoot)) {
    const moduleRelativePath = relative(modulesRoot, file);
    const moduleName = moduleRelativePath.split(sep)[0]!;
    const moduleRoot = resolve(modulesRoot, moduleName);

    for (const importPath of importedPaths(readFileSync(file, "utf8"))) {
      const candidates = resolvedImportCandidates(file, importPath);
      const allowed = candidates.some((target) => {
        if (isWithin(moduleRoot, target)) return true;
        if (isWithin(platformRoot, target)) return true;

        const otherModuleRelativePath = relative(modulesRoot, target);
        const segments = otherModuleRelativePath.split(sep);
        return (
          segments.length === 2 &&
          segments[0] !== moduleName &&
          segments[1] === "index.ts"
        );
      });

      if (!allowed) {
        violations.push({
          file: relative(sourceRoot, file).split(sep).join("/"),
          importPath,
          reason: "imports must stay within the module, use platform, or target another module's index.ts",
        });
      }
    }
  }

  return violations;
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const violations = findViolations(sourceRoot);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file} -> ${violation.importPath}: ${violation.reason}`);
    }
    process.exitCode = 1;
  }
}
