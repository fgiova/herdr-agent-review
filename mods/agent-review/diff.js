// ponytail: no C-quoted paths ("a/x\ty") and no --no-prefix diffs; add unquoting if such paths show up
export function parseUnified(text) {
  const files = [];
  let f = null, h = null, oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0;
  for (const line of text.split("\n")) {
    if (h && (oldLeft > 0 || newLeft > 0)) {
      const t = line[0], body = line.slice(1);
      if (t === "\\") continue;
      if (t === "-") { h.rows.push({ type: "-", oldNo: oldNo++, newNo: null, text: body }); oldLeft--; }
      else if (t === "+") { h.rows.push({ type: "+", oldNo: null, newNo: newNo++, text: body }); newLeft--; }
      else { h.rows.push({ type: " ", oldNo: oldNo++, newNo: newNo++, text: body }); oldLeft--; newLeft--; }
      continue;
    }
    let m;
    if ((m = line.match(/^diff --git a\/(.*) b\/(.*)$/))) {
      f = { path: m[2], oldPath: m[1], status: "modified", index: null, binary: false, blocks: [] };
      files.push(f); h = null;
    } else if (!f) continue;
    else if ((m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/))) {
      oldNo = +m[1]; newNo = +m[3]; oldLeft = +(m[2] ?? 1); newLeft = +(m[4] ?? 1);
      h = { header: line, oldStart: oldNo, newStart: newNo, rows: [] };
      f.blocks.push(h);
    } else if (line.startsWith("\\")) continue;
    else if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) { f.status = "renamed"; f.oldPath = line.slice(12); }
    else if (line.startsWith("rename to ")) f.path = line.slice(10);
    else if (line.startsWith("index ")) f.index = line.slice(6).split(" ")[0];
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.binary = true;
    else if (line.startsWith("--- a/")) f.oldPath = line.slice(6);
    else if (line.startsWith("+++ b/")) f.path = line.slice(6);
  }
  return files;
}

// Keeps a file's first `max` diff lines, so huge files never reach highlighting or the list; returns how many were dropped.
export function capRows(f, max) {
  let left = max, cut = 0;
  f.blocks = f.blocks.filter((b) => {
    if (left <= 0) { cut += b.rows.length; return false; }
    if (b.rows.length > left) { cut += b.rows.length - left; b.rows = b.rows.slice(0, left); }
    left -= b.rows.length;
    return true;
  });
  return cut;
}

export function pairSplit(block) {
  const out = [];
  let dels = [], adds = [];
  const side = (r, no, tok) => ({ no, text: r.text, type: r.type, tok });
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++)
      out.push({ left: dels[i] ? side(dels[i], dels[i].oldNo, dels[i].ot) : null, right: adds[i] ? side(adds[i], adds[i].newNo, adds[i].nt) : null });
    dels = []; adds = [];
  };
  for (const r of block.rows) {
    if (r.type === "-") { if (adds.length) flush(); dels.push(r); }
    else if (r.type === "+") adds.push(r);
    else { flush(); out.push({ left: side(r, r.oldNo, r.ot), right: side(r, r.newNo, r.nt) }); }
  }
  flush();
  return out;
}

const tokenize = (s) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

export function wordDiff(a, b) {
  const ta = tokenize(a), tb = tokenize(b), n = ta.length, m = tb.length;
  const whole = (s, changed) => (s ? [[s, changed]] : []);
  // ponytail: O(n*m) LCS, Myers if long lines are needed
  if (n > 400 || m > 400) return { a: whole(a, false), b: whole(b, false) };
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = ta[i] === tb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ra = [], rb = [];
  const push = (out, t, c) => { const last = out[out.length - 1]; last && last[1] === c ? (last[0] += t) : out.push([t, c]); };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ta[i] === tb[j]) { push(ra, ta[i++], false); push(rb, tb[j++], false); }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) push(ra, ta[i++], true);
    else push(rb, tb[j++], true);
  }
  return { a: ra, b: rb };
}

// A comment's row in `lines` ({old, new}: Map line number -> split row): its own line while that still holds the text saved
// at creation (ctx), else the nearest line with that text; undefined = orphan. Comments without ctx (older ones) keep their number.
// ponytail: exact match only, the nearest duplicate wins; fuzzy match if anchors drift on real edits.
export function anchor(c, lines) {
  const side = c.side === "old" ? "old" : "new", m = lines[side], ln = c.end ?? c.line, at = m.get(ln), text = (r) => (side === "old" ? r.left : r.right).text;
  if (c.ctx == null || (at && text(at) === c.ctx)) return at;
  let best;
  for (const [no, r] of m) if (text(r) === c.ctx && (!best || Math.abs(no - ln) < Math.abs(best[0] - ln))) best = [no, r];
  return best?.[1];
}

// Agent lines from <git-dir>/herdr-review.jsonl merged into `all` (comment map, mutated); returns how many were added.
// A reply needs an existing parentId and takes its thread's file/side/line; a new note needs file + line. Bad lines are skipped.
export function mergeAgent(raw, all) {
  let added = 0;
  for (const line of raw.split("\n")) {
    let n;
    try { n = JSON.parse(line); } catch { continue; }
    if (typeof n?.text !== "string" || !n.text.trim()) continue;
    let h = 5381;
    for (let i = 0; i < line.length; i++) h = ((h * 33) ^ line.charCodeAt(i)) >>> 0;
    const id = String(n.id ?? `agent:${h.toString(36)}`); // no id: the same line always gets the same one
    if (all[id]) continue;
    let root = n.parentId != null ? all[n.parentId] : null;
    while (root?.parentId && all[root.parentId]) root = all[root.parentId];
    if (n.parentId != null ? !root : !(typeof n.file === "string" && n.file && Number.isInteger(n.line) && n.line > 0)) continue;
    const at = root ?? { file: n.file, side: n.side === "old" ? "old" : "new", line: n.line };
    all[id] = { id, source: "agent", author: String(n.author || "claude"), file: at.file, side: at.side, line: at.line,
      text: n.text, at: String(n.at ?? new Date().toISOString()), parentId: root?.id ?? null, sent: false };
    added++;
  }
  return added;
}

// The "Send review" message: threads (root first) grouped by file; `ids` = the comments not sent yet; `file` = the agent channel.
export function reviewMessage(root, file, threads, ids, commit) {
  const indent = (s) => s.trim().replace(/\n/g, "\n    "), lines = [commit?.sha === "branch"
    ? `Review of all changes committed on the current branch of repo ${root} (since it left the default branch). Comments to address:`
    : commit
    ? `Review of commit ${commit.short} ("${commit.subject}") in repo ${root}. Line numbers refer to that commit: find the same code in the current files. Comments to address:`
    : `Review of repo ${root}. Comments to address:`];
  for (const f of [...new Set(threads.map(t => t[0].file))]) {
    lines.push("", `## ${f}`);
    for (const [r, ...replies] of threads.filter(t => t[0].file === f)) {
      lines.push(`- ${f}:${r.line}${r.end ? `-${r.end}` : ""}${r.side === "old" ? " (old side)" : ""} [thread ${r.id}] — ${indent(r.text)}`);
      if (r.code?.length) lines.push("    ```", ...r.code.map(l => `    ${l}`), "    ```");
      for (const c of replies) lines.push(`  ${c.source === "user" ? "user" : c.author}${ids.has(c.id) ? " (new)" : ""}: ${indent(c.text)}`);
    }
  }
  lines.push("", "Apply the requested changes. Then reply to each thread (its id is in [thread …]) by appending a line with:",
    `jq -nc --arg p '<thread id>' --arg t '<what you did>' '{id:"agent:\\(now)", parentId:$p, author:"claude", text:$t, at:(now|todate)}' >> '${file}'`,
    "For a new note on a line (not a reply):",
    `jq -nc --arg f '<path>' --argjson l <line> --arg t '<note>' '{id:"agent:\\(now)", file:$f, side:"new", line:$l, author:"claude", text:$t, at:(now|todate)}' >> '${file}'`);
  return lines.join("\n");
}

if (typeof process !== "undefined" && import.meta.url === `file://${process.argv?.[1]}`) {
  const { deepStrictEqual: eq, ok } = (await import("node:assert")).default;
  const one = (s) => { const r = parseUnified(s); eq(r.length, 1); return r[0]; };

  let f = one(`diff --git a/x.js b/x.js\nindex 1111111..2222222 100644\n--- a/x.js\n+++ b/x.js\n@@ -1,3 +1,3 @@ fn\n a\n-b\n+B\n c\n`);
  eq([f.path, f.oldPath, f.status, f.index, f.binary], ["x.js", "x.js", "modified", "1111111..2222222", false]);
  const big = { blocks: [{ rows: [1, 2, 3] }, { rows: [4, 5, 6] }, { rows: [7] }] };
  eq([capRows(big, 4), big.blocks.map((b) => b.rows)], [3, [[1, 2, 3], [4]]]);
  eq(f.blocks[0].rows.map((r) => [r.type, r.oldNo, r.newNo, r.text]), [[" ", 1, 1, "a"], ["-", 2, null, "b"], ["+", null, 2, "B"], [" ", 3, 3, "c"]]);
  eq(pairSplit(f.blocks[0]).map((p) => [p.left?.text, p.right?.text]), [["a", "a"], ["b", "B"], ["c", "c"]]);

  f = one(`diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n`);
  eq([f.status, f.path, f.blocks[0].rows.map((r) => r.newNo)], ["added", "n.txt", [1, 2]]);

  f = one(`diff --git a/d.txt b/d.txt\ndeleted file mode 100644\nindex 4444444..0000000\n--- a/d.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n`);
  eq([f.status, f.path, f.blocks[0].rows], ["deleted", "d.txt", [{ type: "-", oldNo: 1, newNo: null, text: "gone" }]]);

  f = one(`diff --git a/old name.js b/new name.js\nsimilarity index 90%\nrename from old name.js\nrename to new name.js\nindex 5555555..6666666 100644\n--- a/old name.js\n+++ b/new name.js\n@@ -1 +1 @@\n-x\n+y\n`);
  eq([f.status, f.oldPath, f.path, f.index], ["renamed", "old name.js", "new name.js", "5555555..6666666"]);

  f = one(`diff --git a/b.js b/b.js\nindex 7..8 100644\n--- a/b.js\n+++ b/b.js\n@@ -1,5 +1,4 @@\n k\n-r1\n-r2\n--- r3\n+a1\n+a2\n k2\n`);
  const ps = pairSplit(f.blocks[0]);
  eq(ps.map((p) => [p.left?.no ?? null, p.right?.no ?? null]), [[1, 1], [2, 2], [3, 3], [4, null], [5, 4]]);
  eq(ps[3].left.text, "-- r3");

  f = one(`diff --git a/e.txt b/e.txt\nindex 9..a 100644\n--- a/e.txt\n+++ b/e.txt\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+x\n`);
  eq(f.blocks[0].rows.map((r) => r.type), ["-", "+"]);

  f = one(`diff --git a/i.png b/i.png\nindex b..c 100644\nBinary files a/i.png and b/i.png differ\n`);
  eq([f.binary, f.path, f.blocks.length, f.index], [true, "i.png", 0, "b..c"]);

  eq(wordDiff("foo bar", "foo bar"), { a: [["foo bar", false]], b: [["foo bar", false]] });
  eq(wordDiff("let a = 1;", "let b = 1;"), { a: [["let ", false], ["a", true], [" = 1;", false]], b: [["let ", false], ["b", true], [" = 1;", false]] });
  eq(wordDiff("f(x)", "f(x, y)"), { a: [["f(x)", false]], b: [["f(x", false], [", y", true], [")", false]] });
  eq(wordDiff("a b", "a  b"), { a: [["a", false], [" ", true], ["b", false]], b: [["a", false], ["  ", true], ["b", false]] });
  eq(wordDiff("", "new"), { a: [], b: [["new", true]] });
  eq(wordDiff("", ""), { a: [], b: [] });
  const long = "w ".repeat(300);
  eq(wordDiff(long, long + "x"), { a: [[long, false]], b: [[long + "x", false]] });

  const row = (no, text) => ({ right: { no, text } }), lines = { old: new Map(), new: new Map([[2, row(2, "x")], [4, row(4, "y")], [7, row(7, "y")]]) };
  eq(anchor({ side: "new", line: 2 }, lines), lines.new.get(2)); // no ctx: by number
  eq(anchor({ side: "new", line: 3 }, lines), undefined);
  eq(anchor({ side: "new", line: 2, ctx: "y" }, lines), lines.new.get(4)); // moved, nearest duplicate
  eq(anchor({ side: "new", line: 6, ctx: "y" }, lines), lines.new.get(7));
  eq(anchor({ side: "new", line: 2, ctx: "z" }, lines), undefined); // text gone: orphan
  eq(anchor({ side: "old", line: 2, ctx: "x" }, lines), undefined);

  const all = { r: { id: "r", parentId: null, file: "a.js", side: "old", line: 3, text: "x" }, q: { id: "q", parentId: "r", file: "a.js", side: "old", line: 3 } };
  const jl = ['{"id":"x1","parentId":"q","text":"done"}', "{broken", '{"id":"x2","parentId":"nope","text":"orphan"}', '{"id":"x3","file":"b.js","line":7,"author":"bot","text":"note"}',
    '{"id":"x4","parentId":"r","text":"  "}', '{"file":"b.js","line":0,"text":"line 0"}', '{"file":"b.js","line":2,"text":"no id"}', '{"id":"x1","parentId":"r","text":"duplicate"}', ""].join("\n");
  eq(mergeAgent(jl, all), 3);
  eq([all.x1.parentId, all.x1.file, all.x1.side, all.x1.line, all.x1.source, all.x1.author, all.x1.text, all.x1.sent], ["r", "a.js", "old", 3, "agent", "claude", "done", false]);
  eq([all.x3.parentId, all.x3.file, all.x3.side, all.x3.line, all.x3.author], [null, "b.js", "new", 7, "bot"]);
  ok(!all.x2 && !all.x4 && Object.keys(all).length === 5 && typeof all.x1.at === "string");
  eq(mergeAgent(jl, all), 0); // same lines again (file not emptied yet): nothing new
  const msg = reviewMessage("/r", "/r/.git/herdr-review.jsonl", [[all.r, all.x1]], new Set(["r"]));
  ok(msg.includes("[thread r]") && msg.includes(">> '/r/.git/herdr-review.jsonl'") && msg.includes('{id:"agent:\\(now)", parentId:$p'));

  const { execSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const repo = mkdtempSync(`${(await import("node:os")).tmpdir()}/review-`), git = (a) => execSync(`git -C "${repo}" ${a}`, { encoding: "utf8" });
  writeFileSync(`${repo}/a.js`, "const a = 1;\nconst b = 2;\n");
  git(`init -q && git -C "${repo}" add . && git -C "${repo}" -c user.name=t -c user.email=t@t commit -qm init`);
  writeFileSync(`${repo}/a.js`, "const a = 1;\nconst b = 3;\n");
  const real = git("diff");
  rmSync(repo, { recursive: true });
  const parsed = parseUnified(real);
  ok(parsed.length > 0 && parsed.every((x) => x.index && x.blocks.every((h) => h.rows.length && pairSplit(h).length)));
  console.log(`ok: inline fixtures + real git diff (${parsed.length} files, ${parsed.reduce((s, x) => s + x.blocks.length, 0)} blocks)`);
}
