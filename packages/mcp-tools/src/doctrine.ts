/**
 * What the `start` tool returns: identity + the brain's live catalog + the
 * re-derived behavior doctrine (HOW_TO_WORK below).
 *
 * The old house rules were earned against the 28-tool surface (~230 headless
 * trials); that surface is gone, so the doctrine was re-derived against the new
 * 17-tool surface — agents ran BARE first, and only rules that fixed a measured
 * miss went back in. What survived: personal-fact privacy, contradiction
 * surfacing, define-a-type-when-none-fits. Everything
 * else (search-before-write, inline links, merge-not-delete, provenance, …) is
 * innate on this surface and stays out. Validated over ~60 headless trials +
 * a combined baseline delivered from this very return. The tool descriptions
 * (tool-registry.ts) carry the mechanics; earlier text lives in git history.
 */

export interface CatalogProperty {
  readonly name: string;
  readonly kind: string;
  readonly required: boolean;
  readonly deprecated: boolean;
  readonly ref_type?: string;
  readonly enum_values?: readonly string[];
}

export interface CatalogSnapshot {
  readonly types: ReadonlyArray<{
    readonly name: string;
    readonly deprecated: boolean;
    readonly count: number;
    readonly properties: readonly CatalogProperty[];
  }>;
  readonly members: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly email?: string | null;
    readonly role: string;
    readonly status: string;
  }>;
  readonly rels: readonly string[];
}

function renderProperty(p: CatalogProperty): string {
  const req = p.required ? "*" : "";
  if (p.kind === "enum" && p.enum_values?.length) {
    return `${p.name}${req} (enum: ${p.enum_values.join(" | ")})`;
  }
  if ((p.kind === "ref" || p.kind === "ref[]") && p.ref_type) {
    return `${p.name}${req} (${p.kind} → ${p.ref_type})`;
  }
  return `${p.name}${req} (${p.kind})`;
}

/** The catalog as compact text — appended to start, kept scannable. The
 *  caller's home slug (fs_homes) makes the filesystem line concrete; a
 *  home-less account (service bots) gets the shared root alone. */
export function renderCatalog(cat: CatalogSnapshot, homeSlug?: string): string {
  const types = cat.types.filter((t) => !t.deprecated);
  const typeLines =
    types.length === 0
      ? "(no types defined yet — objects so far are untyped notes)"
      : types
          .map((t) => {
            const props = t.properties.filter((p) => !p.deprecated).map(renderProperty);
            const propStr = props.length > 0 ? `: ${props.join(", ")}` : "";
            return `- ${t.name} — ${t.count} live${propStr}`;
          })
          .join("\n");
  const memberLines = cat.members
    .filter((m) => m.status === "active")
    .map((m) => `- ${m.name} (${m.role}) — id ${m.id}${m.email ? ` — ${m.email}` : ""}`)
    .join("\n");
  const rels = cat.rels.length > 0 ? cat.rels.join(", ") : "(none yet)";
  return [
    "## Types in this brain (* = required property)",
    typeLines,
    "",
    "## Members (use these ids for shared_with; use the email to reach them on chat)",
    memberLines,
    "",
    "## Relationship verbs in use",
    rels,
    "",
    homeSlug !== undefined ? `Files: /shared · your home: /home/${homeSlug}` : "Files: /shared",
  ].join("\n");
}

const HOW_TO_WORK = `## How to work

- Skills first. This org's encoded routines are listed in the Skills section above
  (when any exist) with their triggers. When a task matches one, get it and follow
  its body — never improvise a process the brain has already encoded. Skills are
  'skill'-type objects (title = name, when_to_run = trigger, body = steps; define the
  skill type if the catalog lacks it). When you finish a repeatable process no skill
  covered, offer to save it as one — the org shouldn't do anything from scratch twice.
- Personal facts about the user — appointments, travel, reminders, health, family,
  anything that isn't the org's business — are PRIVATE. Write them with visibility
  'private' so only they can see them; never write a personal fact org-visible.
- Visibility: there is no separate "private" flag under the hood — an object's
  AUDIENCE is the whole truth. Every write starts with an audience of exactly
  its creator; "org-visible" just means the audience is the org group. get
  shows an object's audience as "who can see:" in the SAME vocabulary share
  accepts, and share returns the resulting audience. To let others see
  something, use the share tool — who: groups you belong to or a member's
  email; require: tags every viewer must also hold. ASK the person you are
  working for before sharing, unless they just told you to share it — then
  just do it. You can only share into groups you yourself hold. Publishing is
  the mistake you cannot take back quietly; sharing late is always recoverable.
  Write org-visible directly (visibility:'org') only when the content is
  OBVIOUSLY the org's shared record — a customer, contract, decision, meeting.
  When you kept something private because you weren't confident it was org
  business, don't leave it buried — say so and ask whether to share it.
- When the user tells you something that contradicts what's already recorded, don't
  silently overwrite it and don't silently refuse — surface the conflict, ask which is
  right, and once they confirm, make the change and attribute it to them.
- Never force data into a type that doesn't really fit. If nothing fits, define a new
  type — defining types is normal and expected; do it whenever the data is a kind of
  thing the brain doesn't have yet.
- Write it down: decisions, facts, feedback, how-we-work. If it will matter later it
  goes in the brain — what isn't written is lost.
- Say why: pass reason on write/edit when the "why" isn't obvious from the content
  itself — it's shown next to the data later, so a change doesn't need archaeology.
- Don't duplicate. Before you add a record, search for it (and check neighbors of what
  it relates to) — if it already exists, edit or link that one instead of creating a
  second. One real thing = one object; two records for it is a bug, not thoroughness.
- Link, don't strand. Tie every object to what it relates to with a rel verb (about,
  feedback_on, applies_to, reports_to). A fact nothing points to is unreachable.
- A ref/ref[] property (claimed_by, decided_by, account_owner, ...) points at another
  OBJECT, found via search or list — never at a member's id from the Members section
  above. A member id is a login identity, not a graph object; it will never resolve as
  a link target. If the person doesn't have their own object yet, search first — if
  this brain has no type to represent people at all yet, define one (e.g. "person")
  per the type-definition rule above, don't force them into an unrelated type or a
  plain note as a substitute.
- Answer by traversing, not just searching: find one relevant object, then follow its
  links (neighbors) to the rest — feedback and process knowledge are reached by link,
  not keyword. Anchor feedback on what it applies to, so traversing there always finds
  it. Recurring kinds (feedback, decisions) deserve their own type so you can list
  them all.
- Search finds by MEANING as well as words, and that cuts both ways: a hit labeled
  match:'semantic' or 'graph' is related to your question, not proof it answers it.
  Semantic search ALWAYS returns the nearest things it has — even when the brain
  simply doesn't contain the answer — so read the hit (get) before asserting anything
  from it, and if nothing you read actually answers the question, say the brain
  doesn't have it. "The brain has nothing on this" is a correct, useful answer;
  paraphrasing a near-miss into a confident claim is how wrong answers are born.
- Derived facts are a paradigm this brain supports: a 'fact' is a typed object whose
  title states one thing plainly, carrying confidence (int 0–100), rationale (one line
  explaining the score), kind (enum: extracted | synthesized), derived_on (date), and
  fact_status (enum: active | stale | retired), linked (about) to every source object
  — the links ARE the provenance. Define the fact type the first time facts are
  needed, per the type rule above. One real-world fact = one fact object forever:
  re-deriving means editing and re-scoring the existing fact, never writing a second;
  when newer writes contradict a fact, mark it stale and cut its confidence — don't
  delete it. Respect human edits to facts (re-score only, never overwrite their
  wording). Derive facts when asked to, or on a scheduled routine — not as a side
  effect of every conversation.

FILES — a real, persistent filesystem, reached only through the bash tool.
- /shared: every member sees it. /home/<you>: only you — other homes don't even
  show up. /tmp and anywhere else: scratch, gone when the script ends. You start
  in /home/<you>.
- Write under /shared or /home/<you> and it stays — across your calls, sessions,
  and (for /shared) other members. Even on a timeout, files written before the
  cutoff are saved.
- Edits and deletes are recoverable, in the shell: 'history <path>' lists prior
  versions, 'diff <path> [version]' shows what changed, 'restore <path>
  [version]' rolls a file back, and 'rm' is a soft delete — 'restore --list
  [prefix]' shows what's in the trash, 'restore <path>' brings it back. Only the
  last few versions of text files are kept: this is undo, not an archive, so
  still read a file before you overwrite it.
- A human can LOCK a file or folder from the dashboard; writes under it are
  refused with ELOCKED, naming who holds it. That is a person saying "don't
  touch this" — ask them to unlock it; never route around a lock by writing a
  copy beside it or restoring over it.
- Attach a file to a record by putting its path in a text property (spec_path:
  "/shared/apollo/spec.md"), never the file's bytes. Match audiences: a shared
  record points at a /shared path, a private one at a /home path — never a /home
  path on a record others see (they can't open it).
- A path in a property is a contract. Before you rm or rename a /shared file,
  search records for its path (the bash result also warns when some point at it).
  Prefer adding a file over moving one.
- Humans browse the same tree on the dashboard Files page — drop deliverables in
  /shared. No network: you can't pull a file attached to the chat; ask the human
  to upload it there, then read the path they give you.
- Standing context: /shared/start.md (org-wide) and /home/<you>/start.md (just
  you) are rendered into every session's start. When the user wants something
  remembered in every future session — conventions, priorities, "always do X" —
  write it to the right one of those files; anywhere else and start won't carry it.
- Limits: 100MB per file, 2GB per brain. Tools: coreutils + jq/yq/sqlite3/xan/rg,
  js-exec (JS/TS — inline TS wants --strip-types), and python3 with an offline
  toolkit (openpyxl, pypdf,
  beautifulsoup4, tabulate, python-dateutil, markdown — pure-Python; no numpy/
  pandas, no pip, no network).`;

/** Render caps for the standing-context files — enforced at render time so a
 *  runaway file can never balloon start; the notice points at the full file. */
export const ORG_CONTEXT_CAP = 4096;
export const PERSONAL_CONTEXT_CAP = 2048;

/** Auto-seed contents: start ENSURES both standing-context files exist (first
 *  write-scoped caller seeds them), so the sections are always present and
 *  self-teaching rather than a hidden feature someone must discover. */
export const ORG_CONTEXT_TEMPLATE =
  "(Nothing here yet. This file is shown to EVERY member's session at start — put " +
  'org-wide standing context here: conventions, current priorities, "always do X". ' +
  "Edit /shared/start.md through any agent or the dashboard Files page.)";
export const PERSONAL_CONTEXT_TEMPLATE =
  "(Nothing here yet. Only YOUR sessions see this file — put personal standing " +
  "context here: preferences, reminders, how you like your answers. Edit it through " +
  "any agent or the dashboard Files page.)";
/** per-skill-line cap in the skills index. */
const SKILL_LINE_CAP = 200;

/** The live, derived, and editable sections appended to start. All optional —
 *  an absent/empty value renders no section at all. */
export interface StartSections {
  /** one line per live skill, "title — when_to_run" (pre-joined by the handler). */
  readonly skills?: readonly string[];
  /** true when more skills exist beyond the listed page. */
  readonly moreSkills?: boolean;
  /** contents of /shared/start.md (org-editable standing context). */
  readonly orgContext?: string;
  /** contents of the caller's /home/<slug>/start.md (private standing context). */
  readonly personalContext?: string;
}

/** slice() cuts UTF-16 code units — drop a lone trailing high surrogate so a
 *  clip landing mid-emoji never emits an invalid character. */
const clipAt = (s: string, cap: number): string => s.slice(0, cap).replace(/[\uD800-\uDBFF]$/, "");

function renderStandingContext(
  audience: string,
  path: string,
  body: string,
  cap: number,
): string | undefined {
  const text = body.trim();
  // NUL sniff: a binary file at the path (someone's stray PNG) must not pour
  // mojibake into every session's start — skip it, the file stays browsable.
  if (text === "" || text.includes("\u0000")) return undefined;
  const clipped =
    text.length > cap ? `${clipAt(text, cap)}\n[truncated — read ${path} for the rest]` : text;
  return `## Standing context — ${audience} (edit ${path} to change it)\n${clipped}`;
}

function renderSkills(sections: StartSections): string | undefined {
  if (!sections.skills || sections.skills.length === 0) return undefined;
  // Titles/triggers are member-authored: collapse whitespace so a newline in a
  // trigger can't break the one-line-per-skill format (or fake a ## section).
  const lines = sections.skills
    .map((l) => l.replace(/\s+/g, " ").trim())
    .map((l) => `- ${l.length > SKILL_LINE_CAP ? `${clipAt(l, SKILL_LINE_CAP)}…` : l}`);
  if (sections.moreSkills) lines.push("…more exist — search type:'skill'");
  return (
    "## Skills — this org's encoded routines (match a task to its trigger, then " +
    "get the skill and follow its body)\n" +
    lines.join("\n")
  );
}

/** Compose the full start text for an authenticated account. homeSlug is the
 *  caller's fs_homes slug (thread it from the start handler via
 *  fsStore.homeSlug); omit it for accounts without a filesystem home.
 *  connectorLines are the CALLER's live usable connectors (ToolDeps.connectors,
 *  computed per call — org-keyed + this member's own OAuth connections), each
 *  pre-rendered by the box; empty/omitted renders no section. sections carries
 *  the skills index and the standing-context file contents (see StartSections). */
export function composeStart(
  account: { name: string; role: string },
  catalog: CatalogSnapshot,
  homeSlug?: string,
  connectorLines?: readonly string[],
  sections: StartSections = {},
): string {
  const connectors =
    connectorLines && connectorLines.length > 0
      ? "## Connectors live for YOU right now (each tool teaches itself when called " +
        "with no arguments — prefer these over outside integrations for org work)\n" +
        connectorLines.map((l) => `- ${l}`).join("\n")
      : undefined;
  const parts = [
    `You are connected to this org's brain as ${account.name} (${account.role}).`,
    renderCatalog(catalog, homeSlug),
    renderSkills(sections),
    connectors,
    sections.orgContext !== undefined
      ? renderStandingContext(
          "org-wide, every session sees this",
          "/shared/start.md",
          sections.orgContext,
          ORG_CONTEXT_CAP,
        )
      : undefined,
    sections.personalContext !== undefined && homeSlug !== undefined
      ? renderStandingContext(
          "just you, only your sessions see this",
          `/home/${homeSlug}/start.md`,
          sections.personalContext,
          PERSONAL_CONTEXT_CAP,
        )
      : undefined,
    HOW_TO_WORK,
  ];
  return parts.filter((p): p is string => p !== undefined).join("\n\n");
}

/**
 * What MCP initialize.instructions carries — the short pointer that gets a
 * fresh session to call start. Kept one sentence on purpose.
 */
export const INITIALIZE_INSTRUCTIONS =
  "You have a team brain (Maslow) connected. At the start of a chat, call its start " +
  "tool first — it returns who you are and what the brain currently contains. Use the " +
  "brain to look things up and to record what you learn.";
