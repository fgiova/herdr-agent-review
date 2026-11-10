// Review: sidebar (threads, "Viewed" per file, one message to the space's Claude agent) and, with props {view: "diff", root}, the split diff pane.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar, Textarea, TextareaState } from "gpui-base";
import { spaces, panes, agents, focused, exec, theme, shared, setShared, settings, watchFolder, readTextFile, writeTextFile, props } from "herdr";
import { parseUnified, capRows, pairSplit, wordDiff, anchor, mergeAgent, reviewMessage } from "./diff.js";
import { annotate, mergeChanged, SYNTAX } from "./highlight.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused(), ps = panes();
  // A focused mod pane (the diff itself) has no folder: use a terminal of its tab.
  const pane = f?.pane ? ps.find(p => p.pane === f.pane && !p.mod) ?? ps.find(p => p.tab === f.tab && p.terminal) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const base = (p) => p.split("/").pop();
// Viewed holds while the file's "index a..b" line is the one saved.
const fp = (f) => f.index ?? "-";
// ponytail: per-file and whole-list caps keep a huge diff renderable (the virtual list takes at most 10000 items).
const MAX_FILE_ROWS = 1500;
const MAX_ITEMS = 9000;
const PLUS_W = 16; // the "+" column at the left of each side's line numbers
const VIEWED_W = 90; // right end of a diff file header: the Viewed checkbox
// Uncommitted changes vs HEAD (empty tree without commits) plus untracked files, as one unified diff.
// The flags keep git from writing under .git, or the folder watch would trigger itself.
const R = "--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false";
const DIFF = `git ${R} rev-parse --git-dir >/dev/null || exit 2; B=$(git ${R} rev-parse -q --verify HEAD || git hash-object -t tree /dev/null); echo "$B"; `
  + `git ${R} diff $B --no-color --no-ext-diff --no-textconv; `
  + `git ${R} ls-files -z -o --exclude-standard | xargs -0 -n1 git ${R} diff --no-index --no-color --no-ext-diff -- /dev/null; exit 0`;

async function act(name, args) {
  const r = await exec("herdr-app", ["do", name, JSON.stringify(args)]);
  const j = JSON.parse(r.stdout || "{}");
  if (r.code || j.error) throw new Error(`${name}: ${j.error ?? r.stderr}`);
  return j;
}

async function spotlight(pane) {
  if (!panes().find(p => p.pane === pane)?.zoomed) await act("pane.zoom", { pane });
  await act("pane.focus", { pane });
}

// Claude Code agents with a pane in the shown space: chosen one first by focus, active tab, recency.
function claudeAgents(chosen) {
  const space = spaces().find((s) => s.active), f = focused(), ps = panes();
  const ours = agents().filter(a => a.app === "claude-code" && a.space === space?.id && ps.some(p => p.pane === a.pane));
  const pick = ours.find(a => a.address === chosen) ?? ours.find(a => a.focused) ?? ours.find(a => a.tab === f?.tab)
    ?? [...ours].sort((a, b) => b.seq - a.seq)[0];
  return { ours, pick };
}

export default class Review extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.view === "diff") return this.initDiff(p, cx);
    this.files = []; this.gen = 0;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // Diff pane: {view: "diff", root}. Rows are a flat list of items (file | sep | row) for one virtual list.
  initDiff(props, cx) {
    // Panes opened before `on` was passed: the machine of a terminal inside root (remote pane ids are "machine/…").
    const inRoot = props.root && panes().find(p => p.cwd && (p.cwd === props.root || p.cwd.startsWith(`${props.root}/`)));
    this.view = "diff"; this.root = props.root;
    this.on = props.on !== undefined ? props.on : inRoot?.pane.includes("/") ? inRoot.pane.split("/")[0] : inRoot ? null : location().on;
    this.files = []; this.items = []; this.sizes = []; this.gen = 0; this.wd = new Map();
    this.sx = 0; this.maxChars = 0;
    this.scroll = VirtualListScrollHandle.new(); this.fh = cx.focus_handle(); this.textW = 0; this.composer = null; this.sel = null; this.flip = new Map();
    this.ta = TextareaState.new({ placeholder: "Comment…", rows: 4 });
    this.gotoN = Date.now() - 5000; // a goto set just before this pane opened still applies
    this.loadDiff(cx);
    cx.timer.every(10000, (cx) => this.loadDiff(cx));
  }

  loadDiff(cx) {
    if (this.loading || !this.root) return;
    this.loading = true;
    const root = this.root, before = [this.gen, this.error];
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", DIFF], { cwd: root, on: this.on });
        if (root !== this.root) return; // the sidebar moved to another repo meanwhile
        if (r.code !== 0) throw new Error(r.code === 2 ? "Not a git repository" : r.stderr.trim() || `git: exit ${r.code}`);
        this.error = null;
        if (r.stdout !== this.raw) { this.raw = r.stdout; this.files = parseUnified(r.stdout.slice(r.stdout.indexOf("\n") + 1)); for (const f of this.files) { f.cut = capRows(f, MAX_FILE_ROWS); annotate(f.blocks, f.path); } this.wd = new Map(); this.gen++; }
        this.prune(r.stdout.slice(0, r.stdout.indexOf("\n")));
        this.watch(cx);
        await this.takeAgent();
      } catch (e) { if (root === this.root) this.error = String(e?.message ?? e); }
      finally { this.loading = false; if (root !== this.root) this.loadDiff(cx); else if (before[0] !== this.gen || before[1] !== this.error) cx.notify(); }
    });
  }

  // Agent replies appended to <git-dir>/herdr-review.jsonl (commands in reviewMessage): merged into the store, then the file is emptied.
  // Read by the pane and the sidebar: a line taken by both is added once (same id) and only one empty write passes the CAS.
  // ponytail: a file over 1 MiB is never read; on another machine the file is emptied by line count, not compare-and-swap.
  async takeAgent() {
    const root = this.root;
    try {
      if (!this.gitDir) { const g = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: this.root, on: this.on }); if (g.code) return; this.gitDir = g.stdout.trim(); }
      const path = `${this.gitDir}/herdr-review.jsonl`, raw = await readTextFile(path, { on: this.on });
      if (!raw || root !== this.root) return;
      this.setComments(all => (mergeAgent(raw, all), all));
      if (!this.on) await writeTextFile(path, "", raw); // rejects if the agent appended meanwhile: the next look takes it all again, ids dedup
      else await exec("sh", ["-c", '[ "$(wc -l < "$1")" -eq "$2" ] && : > "$1"', "sh", path, String((raw.match(/\n/g) ?? []).length)], { on: this.on });
    } catch { /* retried at the next look */ }
  }

  // One loop per watched root; a loop whose root is no longer shown ends at its next event.
  watch(cx) {
    const root = this.root;
    if (this.on || (this.watching ??= new Set()).has(root)) return; // watchFolder is local: remote repos refresh on the timer
    this.watching.add(root);
    cx.spawn(async (cx) => {
      try { while (root === this.root) { await watchFolder(root); if (root === this.root) this.loadDiff(cx); } } catch { } finally { this.watching.delete(root); }
    });
  }

  // Flat list: file | sep | row, each row followed by the threads anchored to it (comment items) and the open composer.
  build(st, key) {
    this.built = key; this.items = []; this.sizes = []; this.maxChars = 0;
    const scope = st.scope ?? null, comp = this.composer, push = (it, size) => { if (this.items.length < 9999) { this.items.push(it); this.sizes.push(it.h = size); } };
    const clip = (s) => s && { ...s, text: (s.text.length > 4000 ? s.text.slice(0, 4000) + "…" : s.text).replace(/\t/g, "    ") };
    const wrap = (text, cols) => String(text).split("\n").flatMap(p => {
      const out = [];
      for (let i; p.length > cols; p = p.slice(i).trimStart()) { i = p.lastIndexOf(" ", cols); if (i <= 0) i = cols; out.push(p.slice(0, i)); }
      return [...out, p];
    });
    const composer = (side) => push({ kind: "composer", key: "composer", side }, 120);
    const thread = (th, orphan) => {
      const side = th[0].side === "old" ? "old" : "new";
      for (const c of th) {
        const depth = c.parentId ? 1 : 0, lines = wrap(c.text ?? "", Math.max(10, Math.floor(((this.textW || 400) - 16 * depth) / 7.2)));
        push({ kind: "comment", key: `c:${c.id}`, file: th[0].file, c, side, depth, lines, orphan }, 34 + 18 * lines.length);
      }
      if (comp?.after === th[0].id) composer(side);
    };
    const byFile = {};
    for (const th of this.threads()) (byFile[th[0].file] ??= []).push(th);
    // Rows only change with the diff: built once per file and generation, so a rebuild (comment, selection) stays cheap.
    if (this.rowsGen !== this.gen) { this.rowsGen = this.gen; this.rowCache = new Map(); }
    for (const f of this.files) {
      if (scope && f.path !== scope) continue;
      push({ kind: "file", key: f.path, file: f.path, f, shut: this.shut(f, st) }, 32);
      if (this.items.at(-1).shut) { delete byFile[f.path]; continue; }
      let fr = this.rowCache.get(f.path);
      if (!fr) {
        const rows = f.blocks.flatMap((h, hi) => [{ kind: "sep", key: `${f.path}#${hi}`, file: f.path, text: h.header, h: 22 },
          ...pairSplit(h).map((p, ri) => ({ kind: "row", key: `${f.path}#${hi}.${ri}`, file: f.path, left: clip(p.left), right: clip(p.right), h: 20 }))]);
        if (f.cut) rows.push({ kind: "sep", key: `${f.path}#cut`, file: f.path, text: `… ${f.cut} more lines not shown`, h: 22 });
        const lines = { old: new Map(), new: new Map() };
        let maxc = 0;
        for (const r of rows) if (r.kind === "row") {
          if (r.left) lines.old.set(r.left.no, r);
          if (r.right) lines.new.set(r.right.no, r);
          maxc = Math.max(maxc, r.left?.text.length ?? 0, r.right?.text.length ?? 0);
        }
        this.rowCache.set(f.path, fr = { rows, lines, maxc });
      }
      const { rows, lines } = fr, near = {}, orphans = [];
      for (const th of byFile[f.path] ?? []) {
        const r = anchor(th[0], lines);
        r ? (near[r.key] ??= []).push(th) : orphans.push(th);
      }
      delete byFile[f.path];
      this.maxChars = Math.max(this.maxChars, fr.maxc);
      const room = Math.max(0, MAX_ITEMS - this.items.length);
      rows.forEach((r, i) => {
        if (i >= room) return orphans.push(...(near[r.key] ?? []));
        this.items.push(r); this.sizes.push(r.h);
        for (const th of near[r.key] ?? []) thread(th);
        if (comp?.row === r.key) composer(comp.side);
      });
      if (rows.length > room) push({ kind: "sep", key: `${f.path}#budget`, file: f.path, text: `… ${rows.length - room} more lines not shown: the diff is too large, double-click the file in the sidebar to view it alone` }, 22);
      if (orphans.length) { push({ kind: "sep", key: `${f.path}#orphans`, file: f.path, text: "Comments no longer anchored to the diff" }, 22); orphans.forEach(th => thread(th, true)); }
    }
    const rest = Object.values(byFile).flat().filter(th => !scope || th[0].file === scope);
    if (rest.length) { push({ kind: "sep", key: "#orphans", text: "Comments on files no longer in the diff" }, 22); rest.forEach(th => thread(th, true)); }
  }

  // Viewed files start collapsed, like GitLab; a click on the header flips that until Viewed changes.
  shut(f, st) { const seen = st.viewed?.[f.path] === fp(f); return this.flip.get(f.path) === seen ? !seen : seen; }

  diffItem(it, t, st) {
    const tag = (text, color) => div().px(4).rounded(4).border_1().border_color(t.border).text_size(10).text_color(color).child(text);
    // Comment and composer items sit in the column of their side: old left, new right.
    const half = (side, el, h) => h_flex().w_full().h(h)
      .child(div().flex_1().min_w(0).h_full().py(3).overflow_hidden().when(side === "old", e => e.child(el)))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(div().flex_1().min_w(0).h_full().py(3).overflow_hidden().when(side !== "old", e => e.child(el)));
    if (it.kind === "comment") {
      const c = it.c, user = c.source === "user", agent = c.source === "agent", sel = this.sel === c.id;
      return half(it.side, v_flex().ml(48 + 16 * it.depth).mr(8).px(8).py(4).rounded(4).border_1()
        .border_color(agent ? t.accent : sel ? t.foreground : t.border).bg(sel ? t.selected : agent ? t.accent + "14" : t.raised)
        .child(h_flex().h(18).gap(6).items_center().text_size(11)
          .child(div().flex_none().font_semibold().text_color(agent ? t.accent : t.dim).child(user ? "you" : c.author ?? c.source))
          .when(it.orphan && !it.depth, e => e.child(div().flex_none().text_color(t.dim).child(`${c.file}:${c.line}`)))
          .when(Boolean(c.end) && !it.depth, e => e.child(div().flex_none().text_color(t.dim).child(`lines ${c.line}–${c.end}`)))
          .when(user && !c.sent, e => e.child(div().flex_none().text_color(t.blocked).child("unsent")))
          .child(div().flex_1().min_w(0).truncate().text_right().text_color(t.dim).child(!sel ? "" : user ? "r reply · e edit · d delete" : "r reply")))
        .children(it.lines.map(l => div().h(18).whitespace_nowrap().overflow_hidden().child(l || " "))), it.h);
    }
    if (it.kind === "composer") {
      const c = this.composer, what = c.editId ? "Edit" : c.parentId ? "Reply" : `New comment, ${c.end ? `lines ${c.line}–${c.end}` : `line ${c.line}`}${c.side === "old" ? " (old)" : ""}${c.end ? "" : " · shift-click a line for a range"}`;
      return half(it.side, v_flex().ml(48).mr(8).p(4).gap(4).rounded(4).border_1().border_color(t.accent).bg(t.raised)
        .child(div().h(18).text_size(11).text_color(t.dim).truncate().child(`${what} · ctrl-s save · esc cancel`))
        .child(Textarea.new(this.ta).h(80)), it.h);
    }
    if (it.kind === "file") {
      const f = it.f, seen = st.viewed?.[f.path] === fp(f), [letter, color] = { added: ["A", t.ansi2], deleted: ["D", t.ansi1], renamed: ["R", t.accent] }[f.status] ?? ["M", t.blocked];
      return h_flex().w_full().h(32).px(12).gap(8).items_center().bg(t.raised).border_t(1).border_b(1).border_color(t.border)
        .child(div().w(10).flex_none().text_color(t.dim).child(it.shut ? "▸" : "▾"))
        .child(div().w(12).flex_none().text_color(color).child(letter))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(f.status === "renamed" ? `${f.oldPath} → ${f.path}` : f.path))
        .when(f.binary, e => e.child(tag("binary", t.dim)))
        .child(h_flex().w(VIEWED_W - 12).flex_none().gap(6).items_center().justify_end().text_size(11).text_color(t.dim)
          .child(div().w(14).h(14).flex().items_center().justify_center().rounded(3).border_1().border_color(seen ? t.accent : t.input)
            .bg(seen ? t.accent : t.background).text_size(10).text_color(t.accent_foreground).child(seen ? "✓" : ""))
          .child("Viewed"));
    }
    if (it.kind === "sep") return div().w_full().h(22).px(12).flex().items_center().bg(t.canvas).text_color(t.dim).child(div().min_w(0).truncate().child(it.text));
    const { left: l, right: r } = it, k = l?.type === "-" && r?.type === "+" && `${l.text}\0${r.text}`;
    let w = k && this.wd.get(k);
    if (k && !w) this.wd.set(k, w = wordDiff(l.text, r.text));
    // Code scrolls sideways by this.sx (both sides together); line numbers stay put.
    const all = st.comments ?? {}, cp = this.composer, picked = cp?.file && !cp.editId && !cp.parentId ? cp : this.sel && all[this.sel] && this.rootOf(all[this.sel], all);
    const span = picked?.file === it.file ? picked : null, inSpan = (s, side) => span && s && span.side === side && s.no >= span.line && s.no <= (span.end ?? span.line);
    const cell = (s, segs, bg, hi, side) => h_flex().flex_1().min_w(0).h_full().gap(8).bg(!s ? t.chrome : s.type === " " ? t.background : bg)
      .when(Boolean(inSpan(s, side)), e => e.bg(t.accent + "30"))
      .child(div().w(PLUS_W).flex_none().flex().items_center().justify_center().opacity(s ? 1 : 0)
        .child(div().size(13).flex().items_center().justify_center().rounded(3).text_size(11).font_bold()
          .bg(inSpan(s, side) ? t.accent : t.accent + "33").text_color(inSpan(s, side) ? t.accent_foreground : t.accent).child("+")))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(s ? String(s.no) : ""))
      .child(!s ? div() : h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden()
        .child(h_flex().flex_none().ml(-this.sx).children(mergeChanged(s.tok ?? [[s.text, null]], segs).map(([x, kind, c]) =>
          div().flex_none().whitespace_nowrap().when(Boolean(kind), e => e.text_color(t[SYNTAX[kind]])).when(c, e => e.bg(hi)).child(x.replace(/\t/g, "    "))))));
    return h_flex().w_full().h(20)
      .child(cell(l, w?.a, t.ansi1 + "18", t.ansi1 + "40", "old"))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(cell(r, w?.b, t.ansi2 + "18", t.ansi2 + "40", "new"));
  }

  renderDiff() {
    const t = theme(), st = shared(`review:${this.root}`) ?? {}, scope = st.scope ?? null;
    const built = `${this.gen}:${scope}:${this.textW}:${JSON.stringify(st.comments ?? {})}:${JSON.stringify(this.composer)}:${JSON.stringify(st.viewed ?? {})}:${JSON.stringify([...this.flip])}`;
    if (this.built !== built) this.build(st, built);
    const g = shared("review.goto");
    if (g?.root === this.root && g.n > this.gotoN) {
      const i = this.items.findIndex(it => it.kind === "file" && it.file === g.file);
      if (i >= 0) { this.gotoN = g.n; this.scroll.scroll_to_item(i, "top"); }
    }
    const count = this.items.filter(it => it.kind === "file").length;
    const status = this.error ?? (this.raw === undefined ? "Loading…" : !count ? "No changes" : null);
    return v_flex().id("review-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.fh).on_key_down((e, cx) => this.diffKey(e, cx))
      .on_size_change((s, cx) => { this.paneW = s.width; const w = Math.floor((s.width - 1) / 2) - 74; if (w !== this.textW) { this.textW = w; cx.notify(); } })
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Diff"))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(base(this.root ?? "")))
        .when(Boolean(scope), e => e.child(div().px(4).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.accent).child(`only ${scope}`)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(`${count} ${count === 1 ? "file" : "files"}`)))
      .child(div().flex_1().min_h(0).relative().on_mouse_down("left", (e) => { this.shift = e.modifiers?.shift; this.downX = e.local_position.x; this.down = e.local_position.x > (e.bounds?.width ?? this.paneW ?? Infinity) - VIEWED_W; })
        .on_scroll_wheel((e, cx) => this.scrollX(e, cx)).font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .child(v_virtual_list("review-diff-list", this.items.length, this.sizes, (i) => this.items[i].key,
          (range) => this.items.slice(range.start, range.end).map(it => this.diffItem(it, t, st))).track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => this.itemClick(key, null, cx)).on_item_secondary_click((key, e, cx) => this.itemClick(key, e, cx)))
        .child(Scrollbar.vertical("review-diff-list").viewport_from_layout().absolute().inset_0())
        .when(Boolean(status), e => e.child(div().absolute().top(8).px(12).text_color(this.error ? t.blocked : t.dim).child(status))));
  }

  // Sideways: a horizontal swipe, or shift + wheel. Vertical scrolling stays with the list.
  // ponytail: width from the longest line at ~7.2 px per char (12 px mono); measure if fonts vary.
  scrollX(e, cx) {
    const dx = e.modifiers?.shift && !e.delta.x ? e.delta.y : e.delta.x;
    if (!dx || (!e.modifiers?.shift && Math.abs(dx) < Math.abs(e.delta.y))) return;
    const max = Math.max(0, Math.ceil(this.maxChars * 7.2) - (this.textW || 0) + 16);
    const sx = Math.min(max, Math.max(0, this.sx - dx));
    if (sx !== this.sx) { this.sx = sx; cx.notify(); }
  }

  // Click on a row: comment on the new side (old if the row has only that); right click: the side under the pointer.
  // Click on a comment selects it (keys r/e/d), a second click replies.
  itemClick(key, e, cx) {
    const it = this.items.find(x => x.key === key);
    if (!it || it.kind === "composer") return;
    if (it.kind === "file") {
      if (e) return;
      if (this.down) return this.toggleViewed(it.f);
      const seen = (this.store().viewed ?? {})[it.file] === fp(it.f);
      this.flip.get(it.file) === seen ? this.flip.delete(it.file) : this.flip.set(it.file, seen);
      return cx.notify();
    }
    if (it.kind === "comment") {
      if (e) return;
      if (this.sel === it.c.id && !this.composer) return this.openComposer(cx, { reply: it.c });
      if (this.composer && !this.ta.value().trim()) this.composer = null;
      this.sel = it.c.id; this.fh.focus(); cx.notify();
      return;
    }
    if (it.kind !== "row") return;
    const half = ((this.paneW ?? 0) - 1) / 2, x = this.downX ?? -1, plus = !e && (x >= 0 && x < PLUS_W || x >= half && x < half + 1 + PLUS_W);
    let side = e ? ((e.local_position?.x ?? 0) < (e.bounds?.width ?? 0) / 2 ? "old" : "new") : plus ? (x < half ? "old" : "new") : "new";
    if (!(side === "old" ? it.left : it.right)) side = side === "old" ? "new" : "old";
    const s = side === "old" ? it.left : it.right, a = this.anchorAt, c = this.composer;
    // Shift-click, or a click on a second "+", on the same file and side stretches the open new comment over a range.
    if (!e && (this.shift || plus) && a && c && !c.editId && !c.parentId && a.file === it.file && a.side === side) {
      const at = (x) => side === "old" ? x.left : x.right, nos = this.items.filter(x => x.kind === "row" && x.file === a.file && at(x)).map(x => at(x).no);
      const to = this.spanTo ?? a.no, dir = Math.sign(to - a.no);
      // "+" on an end of the selection drops that line; on the only line, it closes the comment.
      if (plus && s.no === to) return to === a.no ? this.closeComposer(cx) : this.span(nos[nos.indexOf(to) - dir], cx);
      if (plus && s.no === a.no) { this.anchorAt = { ...a, no: nos[nos.indexOf(a.no) + dir] }; return this.span(to, cx); }
      return this.span(s.no, cx);
    }
    this.anchorAt = { file: it.file, side, no: s.no }; this.spanTo = s.no;
    this.openComposer(cx, { file: it.file, side, line: s.no, ctx: s.text, row: it.key });
  }

  // The open new comment covers the lines from anchorAt to `to` (one file and side) and sits under the last one.
  span(to, cx) {
    const { file, side, no } = this.anchorAt, lo = Math.min(no, to), hi = Math.max(no, to), at = (x) => side === "old" ? x.left : x.right;
    const rows = this.items.filter(x => x.kind === "row" && x.file === file && at(x) && at(x).no >= lo && at(x).no <= hi), last = rows.at(-1);
    if (!last) return;
    this.spanTo = to;
    this.composer = { ...this.composer, line: lo, end: hi > lo ? hi : undefined, ctx: at(last).text, row: last.key, code: hi > lo ? rows.slice(0, 80).map(x => at(x).text) : undefined };
    cx.notify();
  }

  // One composer at a time: {row} for a new comment under a row, {after: root id} to reply to or edit a thread.
  openComposer(cx, { reply, edit, ...c }) {
    const all = this.store().comments ?? {}, root = (reply || edit) && this.rootOf(reply || edit, all);
    this.composer = reply ? { file: root.file, side: root.side, line: root.line, parentId: root.id, after: root.id }
      : edit ? { editId: edit.id, side: root.side, after: root.id } : c;
    this.ta.set_value(edit?.text ?? "");
    cx.notify();
    cx.spawn(async (cx) => { await cx.sleep(50); this.ta.focus(); });
  }

  closeComposer(cx) { this.composer = null; this.ta.set_value(""); this.fh.focus(); cx.notify(); }

  saveComposer(cx) {
    const c = this.composer, text = this.ta.value().trim();
    if (!c) return;
    if (text) c.editId ? this.editComment(c.editId, text) : this.addComment({ ...c, text });
    this.closeComposer(cx);
  }

  diffKey(e, cx) {
    if (e.keystroke === "escape") { if (this.composer) this.closeComposer(cx); else if (this.sel) { this.sel = null; cx.notify(); } return; }
    if (e.keystroke === "ctrl-s") return this.composer && this.saveComposer(cx);
    const k = this.composer, a = this.anchorAt;
    if ((e.keystroke === "shift-down" || e.keystroke === "shift-up") && k && !k.editId && !k.parentId && a?.file === k.file) {
      const at = (x) => a.side === "old" ? x.left : x.right, nos = this.items.filter(x => x.kind === "row" && x.file === a.file && at(x)).map(x => at(x).no);
      const next = nos[nos.indexOf(this.spanTo ?? a.no) + (e.keystroke === "shift-down" ? 1 : -1)];
      if (next != null) this.span(next, cx);
      return cx.stop_propagation();
    }
    const c = !this.composer && this.sel && (this.store().comments ?? {})[this.sel];
    if (!c) return;
    if (e.keystroke === "r") this.openComposer(cx, { reply: c });
    else if (c.source === "user" && e.keystroke === "e") this.openComposer(cx, { edit: c });
    else if (c.source === "user" && (e.keystroke === "d" || e.keystroke === "backspace")) { this.sel = null; this.deleteComment(c.id); }
  }

  // Comment store helpers. Each write re-reads the store first: the sidebar writes it too.
  setComments(fn) { const st = this.store(); this.save({ ...st, comments: fn({ ...st.comments }) }); }
  addComment({ file, side, line, end, code, ctx, parentId, text }) {
    const id = `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.setComments(all => ({ ...all, [id]: { id, source: "user", author: "user", file, side, line, text,
      at: new Date().toISOString(), parentId: parentId ?? null, sent: false, ...(ctx == null ? {} : { ctx }), ...(end ? { end, code } : {}) } }));
    return id;
  }
  editComment(id, text) { this.setComments(all => all[id] ? { ...all, [id]: { ...all[id], text, sent: false } } : all); }
  // Deleting a root deletes its whole thread.
  deleteComment(id) {
    this.setComments(all => { const gone = (c) => c && (c.id === id || gone(all[c.parentId])); return Object.fromEntries(Object.entries(all).filter(([, c]) => !gone(c))); });
  }

  // Comments, Viewed and scope per repo, in shared state.
  // A new HEAD (commit, checkout) closes the threads on files no longer in the diff.
  prune(head) {
    const st = this.store();
    if (st.head === head) return;
    const live = new Set(this.files.map(f => f.path)), all = st.comments ?? {};
    const comments = Object.fromEntries(Object.entries(all).filter(([, c]) => live.has(c.file)));
    this.save({ ...st, head, comments, scope: st.scope && !live.has(st.scope) ? null : st.scope ?? null });
  }

  store() { return shared(`review:${this.root}`) ?? { comments: {}, viewed: {} }; }
  save(s) { if (JSON.stringify(s) !== JSON.stringify(this.store())) setShared(`review:${this.root}`, s); }
  rootOf(c, all) { while (c.parentId && all[c.parentId]) c = all[c.parentId]; return c; }

  // Sidebar: the repo follows the focused pane; its files come from loadDiff, like the pane's.
  refresh(cx) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = this.gitDir = this.raw = this.current = undefined;
      this.files = []; this.error = null; this.note = null;
    }
    if (this.root) return this.loadDiff(cx);
    if (!cwd || this.resolving) return;
    this.resolving = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.error = "Not a git repository"; return; }
        [this.root, this.gitDir] = top.stdout.trim().split("\n"); this.on = on;
        this.loadDiff(cx);
      } finally { this.resolving = false; if (key() !== context) this.refresh(cx); cx.notify(); }
    });
  }

  threads() {
    const all = this.store().comments, byRoot = {};
    for (const c of Object.values(all)) (byRoot[this.rootOf(c, all).id] ??= []).push(c);
    return Object.values(byRoot).map(cs => cs.sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || String(a.at).localeCompare(String(b.at))));
  }
  pending() { return this.threads().flat().filter(c => c.source === "user" && !c.sent); }

  toggleViewed(f) {
    const st = this.store();
    this.save({ ...st, viewed: { ...st.viewed, [f.path]: st.viewed?.[f.path] === fp(f) ? null : fp(f) } });
  }

  clean() {
    const st = this.store(), keep = {};
    for (const t of this.threads()) {
      const done = t.every(c => c.source !== "user" || c.sent) && t.some(c => c.source !== "user");
      if (!done) for (const c of t) keep[c.id] = c;
    }
    this.save({ ...st, comments: keep });
  }

  task(cx, what, job) {
    this.note = null; this.ok = false; this.busy = what; cx.notify();
    cx.spawn(async (cx) => {
      try { await job(); } catch (e) { this.note = String(e?.message ?? e); }
      finally { this.busy = null; cx.notify(); }
    });
  }

  diffPane() {
    const tabs = new Set(spaces().find(s => s.active)?.tabs.map(t => t.id));
    return panes().find(p => p.mod === "agent-review" && tabs.has(p.tab));
  }

  openDiff(cx) {
    if (this.busy) return; // a split already on its way
    const shown = this.diffPane()?.pane, pane = focused()?.pane, root = this.root;
    this.task(cx, "diff", async () => spotlight(shown ?? (await act("pane.split", { direction: "right", mod: "agent-review", props: { view: "diff", root, on: this.on ?? null }, ...(pane ? { pane } : {}) })).pane));
  }

  // Click: scroll the diff pane to the file, opening or showing the pane. Scoped to another file, the scope moves here.
  open(path, cx) {
    const st = this.store();
    if (st.scope && st.scope !== path) this.save({ ...st, scope: path });
    this.current = path;
    setShared("review.goto", { root: this.root, file: path, n: Date.now() });
    this.openDiff(cx);
  }

  send(cx) {
    const { pick } = claudeAgents(this.agent), pend = this.pending();
    if (!pick || !pend.length || this.busy) return;
    const ids = new Set(pend.map(c => c.id));
    const text = reviewMessage(this.root, `${this.gitDir}/herdr-review.jsonl`, this.threads().filter(t => t.some(c => ids.has(c.id))), ids);
    if (text.length > 50000) { this.ok = false; this.note = `Message too large (${Math.round(text.length / 1000)} KB > 50 KB): not sent`; cx.notify(); return; }
    this.task(cx, "send", async () => {
      const r = await exec("hc", ["send", pick.address, text]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc send: exit ${r.code}`);
      const st = this.store(), comments = { ...st.comments };
      for (const id of ids) if (comments[id]) comments[id] = { ...comments[id], sent: true };
      this.save({ ...st, comments });
      this.ok = true; this.note = `Sent ${ids.size} ${ids.size === 1 ? "comment" : "comments"} to ${pick.tab_name} (${pick.address})`;
    });
  }

  render(cx) {
    if (this.view === "diff") return this.renderDiff();
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), st = this.root ? this.store() : { comments: {}, viewed: {} };
    const threads = this.root ? this.threads() : [], pend = this.root ? this.pending() : [];
    const { ours, pick } = claudeAgents(this.agent);
    const paths = [...new Set([...this.files.map(f => f.path), ...threads.map(th => th[0].file)])];
    const viewed = this.files.filter(f => st.viewed?.[f.path] === fp(f)).length;
    const button = (id, text, on, action) => div().id(id).h(26).px(10).flex().items_center().rounded(7).text_size(12)
      .bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.dim).when(on, e => e.cursor_pointer().hover(s => s.opacity(0.88)))
      .on_click((_e, cx) => on && action(cx)).child(text);
    const tag = (text, color) => div().px(4).rounded(4).border_1().border_color(t.border).text_size(10).text_color(color).child(text);
    const file = (path, depth) => {
      const f = this.files.find(x => x.path === path), on = f && st.viewed?.[path] === fp(f);
      const count = threads.filter(th => th[0].file === path).length, todo = pend.filter(c => c.file === path).length;
      return h_flex().id(`f-${path}`).h(26).pl(6 + 14 * depth).pr(6).gap(6).items_center().rounded(6).when(Boolean(f), e => e.cursor_pointer().hover(s => s.bg(t.hover)))
        .when(this.current === path, e => e.bg(t.selected)).on_click((e, cx) => f && (e.click_count === 2 ? this.save({ ...this.store(), scope: st.scope === path ? null : path }) : this.open(path, cx)))
        .child(div().w(12).flex_none().text_size(11).text_color(t.accent).child(on ? "✓" : ""))
        .child(div().flex_1().min_w(0).truncate().text_color(on ? t.dim : t.foreground).child(base(path)))
        .when(st.scope === path, e => e.child(tag("only this", t.accent)))
        .when(todo > 0, e => e.child(tag(`${todo} unsent`, t.blocked)))
        .when(!todo && count > 0, e => e.child(tag(`${count} ${count === 1 ? "thread" : "threads"}`, t.dim)));
    };
    const dir = (name, path, depth, shut) => h_flex().id(`d-${path}`).h(24).pl(6 + 14 * depth).pr(6).gap(6).items_center().rounded(6)
      .cursor_pointer().hover(s => s.bg(t.hover)).text_color(t.muted)
      .on_click((_e, cx) => { this.closed ??= new Set(); this.closed.has(path) ? this.closed.delete(path) : this.closed.add(path); cx.notify(); })
      .child(div().w(12).flex_none().text_size(11).child(shut ? "▸" : "▾")).child(div().flex_1().min_w(0).truncate().child(name));
    const root = {}, rows = [];
    for (const path of paths) { let n = root; const parts = path.split("/"); for (const d of parts.slice(0, -1)) n = n[`${d}/`] ??= {}; n[parts.at(-1)] = path; }
    const walk = (n, depth, pre) => {
      for (const k of Object.keys(n).sort((a, b) => b.endsWith("/") - a.endsWith("/") || a.localeCompare(b))) {
        if (!k.endsWith("/")) { rows.push(file(n[k], depth)); continue; }
        const shut = Boolean(this.closed?.has(pre + k));
        rows.push(dir(k.slice(0, -1), pre + k, depth, shut));
        if (!shut) walk(n[k], depth + 1, pre + k);
      }
    };
    walk(root, 0, "");
    const status = this.error ?? (!this.root ? "No repository" : this.raw === undefined ? "Loading…" : !paths.length ? "No changes" : null);
    return v_flex().id("review").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Review"))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.root ? base(this.root) : ""))
        .child(tag(`Viewed ${viewed}/${this.files.length}`, t.muted))
        .child(div().flex_1())
        .when(Boolean(this.root), e => e.child(button("diff", this.diffPane() ? "Show diff" : "Open diff", !this.busy, cx => this.openDiff(cx))))
        .child(div().id("refresh").px(4).cursor_pointer().text_color(t.dim).hover(s => s.text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx)).child("↻")))
      .child(v_flex().id("review-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).children(rows)
        .when(Boolean(status), e => e.child(div().p(8).text_color(t.dim).child(status))))
      .child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .when(ours.length > 1, e => e.child(h_flex().flex_wrap().gap(6).children(ours.map(a =>
          div().id(`a-${a.address}`).px(8).py(2).rounded(6).border_1().border_color(a === pick ? t.accent : t.border).bg(a === pick ? t.selected : t.raised)
            .text_size(11).cursor_pointer().on_click((_e, cx) => { this.agent = a.address; cx.notify(); }).child(`${a.tab_name} · ${a.address}`)))))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(pick ? `→ ${pick.tab_name} (${pick.address})` : "No Claude agent in this space"))
          .child(button("clean", "Clear sent", !this.busy, () => this.clean()))
          .child(button("send", this.busy === "send" ? "Sending…" : `Send review (${pend.length})`, Boolean(pick && pend.length && !this.busy), cx => this.send(cx))))
        .when(Boolean(this.note), e => e.child(div().text_size(11).text_color(this.ok ? t.dim : t.blocked).child(this.note))));
  }
}
