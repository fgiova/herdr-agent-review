// Light syntax highlighting for diff lines: regexes per language family, block comments carried line to line.
// Kept identical in mods/gitlab and mods/agent-review (a mod can't import another's files).
// ponytail: no grammar; multi-line strings and nested languages (JS in HTML) are not tracked.

const words = (s) => new Set(s.split(" "));
const C_KEYWORDS = words("abstract as async await break case catch class const continue debugger default defer delete do else enum export extends false final finally fn for from func function go goto if impl implements import in instanceof interface is let match mod module mut namespace new nil null of override package private protected pub public readonly return satisfies select static struct super switch this throw throws trait true try type typeof undefined use var void while with yield");
const PHP_KEYWORDS = words("abstract and array as break case catch class clone const continue declare default do echo else elseif empty enum extends false final finally fn for foreach function global if implements include instanceof interface isset list match namespace new null or print private protected public readonly require return self static switch throw trait true try unset use var while yield");
const PY_KEYWORDS = words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield");
const SH_KEYWORDS = words("case do done elif else esac export fi for function if in local readonly return set shift then until unset while");
const SQL_KEYWORDS = words("add alter and as asc between by case create delete desc distinct drop else end exists foreign from group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table then union unique update values when where with");
const GQL_KEYWORDS = words("enum extend fragment implements input interface mutation on query scalar schema subscription type union directive true false null");

const C = { line: ["//"], block: ["/*", "*/"], quotes: "\"'`", keywords: C_KEYWORDS };
const LANGS = {
  c: C,
  php: { line: ["//", "#"], block: ["/*", "*/"], quotes: "\"'", keywords: PHP_KEYWORDS, dollar: true },
  py: { line: ["#"], quotes: "\"'", keywords: PY_KEYWORDS },
  rb: { line: ["#"], quotes: "\"'", keywords: words("begin class def do else elsif end ensure false if module nil require rescue return self then true unless until when while yield") },
  sh: { line: ["#"], quotes: "\"'", keywords: SH_KEYWORDS, dollar: true },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: "'\"", keywords: SQL_KEYWORDS, nocase: true },
  gql: { line: ["#"], quotes: "\"", keywords: GQL_KEYWORDS },
  css: { block: ["/*", "*/"], quotes: "\"'", keywords: words("important media import from to"), props: true },
  json: { quotes: "\"", keywords: words("true false null"), keys: "json" },
  yaml: { line: ["#"], quotes: "\"'", keywords: words("true false null yes no on off"), keys: "yaml" },
  toml: { line: ["#"], quotes: "\"'", keywords: words("true false"), keys: "toml" },
  html: { block: ["<!--", "-->"], quotes: "\"'", tags: true },
  md: { md: true },
};
const EXT = {
  js: "c", jsx: "c", mjs: "c", cjs: "c", ts: "c", tsx: "c", mts: "c", cts: "c", java: "c", kt: "c", kts: "c", scala: "c", go: "c", rs: "c",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", cs: "c", swift: "c", dart: "c", groovy: "c", gradle: "c",
  php: "php", py: "py", rb: "rb", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", env: "sh", sql: "sql", graphql: "gql", gql: "gql",
  css: "css", scss: "css", less: "css", json: "json", jsonc: "c", yaml: "yaml", yml: "yaml", toml: "toml", ini: "toml",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", md: "md", markdown: "md",
};

export function languageOf(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  if (name === "dockerfile" || name === "makefile" || name.startsWith(".env")) return LANGS.sh;
  if (name.endsWith(".blade.php")) return LANGS.html;
  return LANGS[EXT[name.split(".").pop()]] ?? null;
}

// One line → { tokens: [[text, kind]], state }; kind: null | keyword | string | number | comment | function | type | property | variable.
// `state` is the open block comment, if any, carried to the next line of the same side.
export function tokenize(line, lang, state = null) {
  const out = [];
  const push = (text, kind) => { if (!text) return; const last = out.at(-1); last && last[1] === kind ? (last[0] += text) : out.push([text, kind]); };
  if (!lang) return { tokens: [[line, null]], state: null };
  if (lang.md) {
    if (/^\s*#{1,6}\s/.test(line)) return { tokens: [[line, "keyword"]], state: null };
    for (const part of line.split(/(`[^`]*`)/)) push(part, part.startsWith("`") && part.length > 1 ? "string" : null);
    return { tokens: out, state: null };
  }
  let i = 0;
  if (lang.keys === "yaml" || lang.keys === "toml") {
    const m = line.match(/^(\s*(?:-\s+)?)([\w.\-"'$@/]+)(\s*[:=])(?=\s|$)/);
    if (m && !line.trimStart().startsWith("#")) { push(m[1], null); push(m[2], "property"); push(m[3], null); i = m[0].length; }
  }
  while (i < line.length) {
    const rest = line.slice(i);
    if (state) {
      const end = line.indexOf(state, i);
      if (end < 0) { push(rest, "comment"); return { tokens: out, state }; }
      push(line.slice(i, end + state.length), "comment"); i = end + state.length; state = null; continue;
    }
    if (lang.block && rest.startsWith(lang.block[0])) { state = lang.block[1]; push(lang.block[0], "comment"); i += lang.block[0].length; continue; }
    if (lang.line?.some((p) => rest.startsWith(p) && (p !== "#" || !/\w/.test(line[i - 1] ?? "")))) { push(rest, "comment"); break; }
    const q = rest[0];
    if (lang.quotes?.includes(q)) {
      let j = 1;
      while (j < rest.length && rest[j] !== q) j += rest[j] === "\\" ? 2 : 1;
      const str = rest.slice(0, j + 1);
      const key = lang.keys === "json" && /^\s*:/.test(rest.slice(str.length));
      push(str, key ? "property" : "string"); i += str.length; continue;
    }
    if (lang.tags) {
      const m = rest.match(/^<\/?[\w:.-]+|^\/?>/);
      if (m) { push(m[0], "keyword"); i += m[0].length; continue; }
      const a = rest.match(/^[\w:@.-]+(?==)/);
      if (a && line.lastIndexOf("<", i) > line.lastIndexOf(">", i)) { push(a[0], "property"); i += a[0].length; continue; }
    }
    let m = rest.match(/^(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/);
    if (m && !/[\w$]/.test(line[i - 1] ?? "")) { push(m[0], "number"); i += m[0].length; continue; }
    m = rest.match(/^[A-Za-z_$@][\w$]*/);
    if (m) {
      const w = m[0], after = rest.slice(w.length);
      const kind = (lang.nocase ? lang.keywords?.has(w.toLowerCase()) : lang.keywords?.has(w)) ? "keyword"
        : lang.dollar && w.startsWith("$") ? "variable"
        : lang.props && /^\s*:/.test(after) && !/^\s*:\s*[\w-]+\s*\{/.test(after) ? "property"
        : /^[A-Z]/.test(w) && !lang.tags ? "type"
        : /^\s*\(/.test(after) ? "function" : null;
      push(w, kind); i += w.length; continue;
    }
    push(rest[0], null); i++;
  }
  return { tokens: out, state };
}

// Tokens for every row of a file's blocks, old side (r.ot) and new side (r.nt), each side carrying its own state.
export function annotate(blocks, path) {
  const lang = languageOf(path);
  if (!lang) return;
  for (const b of blocks) {
    let so = null, sn = null;
    for (const r of b.rows) {
      if (r.type !== "+") { const x = tokenize(r.text, lang, so); r.ot = x.tokens; so = x.state; }
      if (r.type !== "-") { const y = tokenize(r.text, lang, sn); r.nt = y.tokens; sn = y.state; }
    }
  }
}

// Theme color per token kind.
export const SYNTAX = { keyword: "ansi5", string: "ansi2", number: "ansi3", comment: "dim", function: "ansi4", type: "ansi6", property: "ansi4", variable: "ansi6" };

// Syntax tokens cut at the word-diff boundaries: [[text, kind, changed]].
export function mergeChanged(tokens, segs) {
  if (!segs) return tokens.map(([text, kind]) => [text, kind, false]);
  const out = [];
  let si = 0, sOff = 0;
  for (const [text, kind] of tokens) {
    let t = text;
    while (t) {
      const seg = segs[si];
      if (!seg) { out.push([t, kind, false]); break; }
      const room = seg[0].length - sOff, take = t.slice(0, room);
      out.push([take, kind, seg[1]]);
      t = t.slice(take.length); sOff += take.length;
      if (sOff >= seg[0].length) { si++; sOff = 0; }
    }
  }
  return out;
}

// node mods/<mod>/highlight.js
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv?.[1]}`) {
  const { deepStrictEqual: eq } = (await import("node:assert")).default;
  const ts = languageOf("src/a.ts");
  eq(tokenize("const x = foo(1, 'a'); // hi", ts).tokens, [["const", "keyword"], [" x = ", null], ["foo", "function"], ["(", null],
    ["1", "number"], [", ", null], ["'a'", "string"], ["); ", null], ["// hi", "comment"]]);
  const a = tokenize("a /* open", ts);
  eq([a.tokens, a.state], [[["a ", null], ["/* open", "comment"]], "*/"]);
  eq(tokenize("still */ b", ts, "*/").tokens, [["still */", "comment"], [" b", null]]);
  eq(tokenize("  name: \"x\" # c", languageOf("a.yml")).tokens, [["  ", null], ["name", "property"], [": ", null], ["\"x\"", "string"], [" ", null], ["# c", "comment"]]);
  eq(tokenize("{\"k\": true}", languageOf("a.json")).tokens, [["{", null], ["\"k\"", "property"], [": ", null], ["true", "keyword"], ["}", null]]);
  eq(tokenize("$x = new Foo();", languageOf("a.php")).tokens.map((t) => t[1]), ["variable", null, "keyword", null, "type", null]);
  eq(tokenize("abc", null).tokens, [["abc", null]]);
  eq(mergeChanged([["const", "keyword"], [" a", null]], [["con", false], ["st a", true]]), [["con", "keyword", false], ["st", "keyword", true], [" a", null, true]]);
  eq(languageOf("Dockerfile"), languageOf("x.sh"));
  console.log("ok");
}
