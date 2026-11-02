/**
 * Statement-level tokenizer for Studio's Model-API-code texts (F2).
 *
 * The v1 extractor works line by line and masks strings with a regex. That is enough to find a
 * variable name, but not to read an expression: real texts carry `"\"Login\""`, `"<a href=\"30093\">"`
 * and `"Don\'t"`, and a line-and-regex reader either truncates those at the first inner quote or
 * mistakes an escaped quote for the end of the literal. Since **the expressions are the payload** of
 * the flow IR, this splits properly instead: a single pass that knows C# string literals, verbatim
 * literals, line comments and block comments, and cuts statements at the `;` that are code.
 *
 * It returns comments as their own items, because two of them are load-bearing: the
 * `/*** creating I<Kind> '<Name>' ***\/` anchor, and the `// default value` marker that tells an
 * authored value from one Studio emitted because it had to emit something.
 */

export interface CodeStatement {
  kind: "statement";
  /** The statement's code with comments removed and outer whitespace trimmed; no trailing `;`. */
  code: string;
  /** Source text of the statement including its trailing comment, for `raw`. */
  raw: string;
  /** 1-based line the statement starts on. */
  line: number;
  /** True when a `// default value` comment trailed it — Studio's marker for "not authored". */
  isDefault: boolean;
}

export interface CodeComment {
  kind: "comment";
  /** Comment body without its `//` or `/* *\/` delimiters, trimmed. */
  text: string;
  line: number;
}

export type CodeItem = CodeStatement | CodeComment;

const DEFAULT_VALUE_MARKER = /^default value\b/i;

/**
 * Splits one element text into statements and comments.
 *
 * A `;` inside a string literal, a line comment or a block comment never ends a statement, and a
 * `//` inside a string literal never starts a comment. Anything after the last `;` that is not
 * whitespace or a brace is returned as a final statement, so a truncated text still yields what it
 * had rather than silently losing its tail.
 */
export function tokenize(text: string): CodeItem[] {
  const items: CodeItem[] = [];
  let line = 1;
  let i = 0;
  // The statement being accumulated: its code, its raw source, and where it began.
  let code = "";
  let raw = "";
  let startLine = line;
  let started = false;
  /** Comments seen while accumulating the current statement, to resolve `isDefault`. */
  let trailing: string[] = [];

  const beginIfNeeded = (): void => {
    if (!started) {
      started = true;
      startLine = line;
    }
  };

  const flush = (): void => {
    const trimmed = code.trim();
    if (trimmed.length > 0) {
      items.push({
        kind: "statement",
        code: trimmed,
        raw: raw.trim(),
        line: startLine,
        isDefault: trailing.some((c) => DEFAULT_VALUE_MARKER.test(c))
      });
    }
    code = "";
    raw = "";
    started = false;
    trailing = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\n") {
      line++;
      // A newline inside an unterminated statement is ordinary whitespace; the statement continues.
      if (started) {
        code += " ";
        raw += "\n";
      }
      i++;
      continue;
    }

    // Line comment. `// default value` belongs to the statement it trails, which is why comments
    // are collected into `trailing` as well as emitted.
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const body = text.slice(i + 2, end === -1 ? text.length : end);
      const commentLine = line;
      trailing.push(body.trim());
      if (!started) items.push({ kind: "comment", text: body.trim(), line: commentLine });
      if (started) raw += `//${body}`;
      i = end === -1 ? text.length : end;
      continue;
    }

    // Block comment, including the `/*** creating … ***\/` anchor.
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      const body = text.slice(i + 2, close === -1 ? text.length : close);
      const commentLine = line;
      for (const c of text.slice(i, end)) if (c === "\n") line++;
      if (started) raw += text.slice(i, end);
      else items.push({ kind: "comment", text: body.replace(/^\*+|\*+$/g, "").trim(), line: commentLine });
      i = end;
      continue;
    }

    // Verbatim string literal: `@"…"`, where `""` is an escaped quote and `\` is not an escape.
    if (ch === "@" && text[i + 1] === '"') {
      const start = i;
      i += 2;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (text[i] === "\n") line++;
        i++;
      }
      beginIfNeeded();
      const literal = text.slice(start, i);
      code += literal;
      raw += literal;
      continue;
    }

    // Regular string literal: `\"` and `\\` are escapes, so neither ends it.
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        if (text[i] === "\n") line++;
        i++;
      }
      beginIfNeeded();
      const literal = text.slice(start, i);
      code += literal;
      raw += literal;
      continue;
    }

    if (ch === ";") {
      beginIfNeeded();
      raw += ch;
      i++;
      // Consume a trailing line comment on the same line, so `// default value` lands on this
      // statement rather than on the next one.
      let j = i;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
      if (text[j] === "/" && text[j + 1] === "/") {
        const end = text.indexOf("\n", j);
        const body = text.slice(j + 2, end === -1 ? text.length : end);
        trailing.push(body.trim());
        raw += text.slice(i, end === -1 ? text.length : end);
        i = end === -1 ? text.length : end;
      }
      flush();
      continue;
    }

    // Braces are the lambda's own frame, never part of a statement — and they END one. The lambda
    // header carries no `;`, so without flushing here it merged with the first real declaration
    // (`(IMobileFlow login) => { var login2 = login.CreateScreen("Login")`), the merged statement
    // was discarded as "the lambda header", and the element's own variable was never bound.
    if (ch === "{" || ch === "}") {
      flush();
      i++;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      if (started) {
        code += ch === "\r" ? "" : ch;
        raw += ch;
      }
      i++;
      continue;
    }

    beginIfNeeded();
    code += ch;
    raw += ch;
    i++;
  }
  flush();
  return items;
}

/**
 * Splits a call's argument list on the commas that are at paren/bracket/angle depth 0 and outside
 * string literals, so `SetArgumentValue(p, "A(1, 2)")` is two arguments and not three.
 * `inner` is the text between the call's own parentheses.
 */
export function splitArguments(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < inner.length) {
        if (inner[i] === "\\") {
          i += 2;
          continue;
        }
        if (inner[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      current += inner.slice(start, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/**
 * The text between the parentheses of the **last** call in `code`, or undefined when there is none.
 * Used to read `…CreateAssignment("a", "b")` without a regex that an inner `)` could fool.
 */
export function callArguments(code: string, method: string): string[] | undefined {
  const needle = `.${method}(`;
  const at = code.lastIndexOf(needle);
  if (at === -1) return undefined;
  const open = at + needle.length - 1;
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"') {
      i++;
      while (i < code.length) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return splitArguments(code.slice(open + 1, i));
    }
    i++;
  }
  return undefined;
}

/**
 * Given the text that follows a call's **opening** parenthesis, returns the text up to the matching
 * close parenthesis — the call's own argument list, with any chained `.Foo(bar)` after it excluded.
 *
 * `CREATE_RE` hands the parser everything after `CreateNode<…>(`, which on a real statement is
 * `).ConnectedBelow(startNode);`. Cutting that at the last `)` (the obvious shortcut) yields
 * `).ConnectedBelow(startNode` and was read as the node's label; balancing the parentheses is the
 * only way to tell a call's arguments from what was chained onto its result.
 */
export function balancedSlice(afterOpenParen: string): string {
  let depth = 1;
  let i = 0;
  while (i < afterOpenParen.length) {
    const ch = afterOpenParen[i];
    if (ch === '"') {
      i++;
      while (i < afterOpenParen.length) {
        if (afterOpenParen[i] === "\\") {
          i += 2;
          continue;
        }
        if (afterOpenParen[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return afterOpenParen.slice(0, i);
    }
    i++;
  }
  return afterOpenParen;
}

/** True when an argument is a quoted string literal rather than `null`, a number or a variable. */
export function isStringLiteral(argument: string): boolean {
  const t = argument.trim();
  return (t.startsWith('"') && t.length >= 2) || (t.startsWith('@"') && t.length >= 3);
}

/**
 * Decodes a C# string literal to the text it denotes: `"\"Login\""` → `"Login"` (quotes included,
 * since that is what OutSystems expression text looks like), `"Don\'t"` → `Don't`.
 *
 * Anything that is not a quoted literal — `null`, a number, an enum path, a variable — is returned
 * trimmed and unchanged, so the caller can tell `null` from the literal `"null"` by comparing to the
 * raw argument rather than by a flag.
 */
export function literalValue(argument: string): string {
  const trimmed = argument.trim();
  if (trimmed.startsWith('@"') && trimmed.endsWith('"') && trimmed.length >= 3) {
    return trimmed.slice(2, -1).replace(/""/g, '"');
  }
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) return trimmed;
  const body = trimmed.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const next = body[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "0":
        out += "\0";
        break;
      case "u": {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += "u";
        }
        break;
      }
      case undefined:
        out += "\\";
        break;
      default:
        // `\"`, `\\`, `\'` and anything else: the escaped character itself.
        out += next;
    }
  }
  return out;
}
