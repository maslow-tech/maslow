import { useEffect, useState, type FormEvent } from "react";
import { Tags, X } from "lucide-react";
import { api, ApiError, errorMessage, type Member, type TagRow, type Whoami } from "../lib/api";
import { Empty, LoadError, Spinner } from "../components/bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Mirrors the server's TAG_SLUG_RE — the client refuses the same shapes the
 *  server would, so a typo fails before a round-trip. */
export const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG_HINT = "slug must be lowercase letters/digits/dashes (max 63 chars)";

/**
 * Access: tag governance (wave 3). Everyone can see the tags and who holds
 * them; the OWNER creates custom tags and grants/revokes holders. The server
 * re-checks the owner role per request — this UI is convenience, not the
 * gate, and its error messages are shown verbatim.
 *
 * Legibility (post-live-test rework): the page leads with GROUPS — the org
 * tag and the owner-minted custom tags, the only rows anyone can act on.
 * Personal identity tags are automatic, inert, and one-per-person, so they
 * collapse into a summary line (expandable) instead of drowning the two rows
 * that matter under sixteen `person-xxxxxxxx` rows; tags whose holder is not
 * an active account (revoked members, the internal system actor) don't render
 * at all.
 */
export function AccessView({ user }: { user: Whoami }) {
  const isOwner = user.role === "owner";
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPersonal, setShowPersonal] = useState(false);
  // Distinct from `error` (mutation banner): a failed INITIAL load shows
  // LoadError+Retry instead of an infinite skeleton.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    setLoadError(null);
    return Promise.all([api.tags(), api.members()])
      .then(([t, m]) => {
        setTags(t.tags);
        setMembers(m);
      })
      .catch((e: unknown) => setLoadError(errorMessage(e)));
  };
  useEffect(() => {
    void reload();
  }, []);

  /** One mutation at a time; the server's message surfaces verbatim. */
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "something went wrong — try again");
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string) => members?.find((m) => m.id === id)?.name ?? id;

  // Groups are the page; identities are a footnote. A personal tag renders
  // only when its holder is a live account — revoked members and the internal
  // system actor would otherwise fill the table with rows nobody can act on.
  const groups = (tags ?? []).filter((t) => t.kind !== "personal");
  const personal = (tags ?? []).filter((t) => {
    if (t.kind !== "personal") return false;
    const holder = members?.find((m) => m.id === t.holders[0]);
    return holder !== undefined && holder.status === "active";
  });

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Access</h1>
        <p className="mt-1 text-[13.5px] text-mut">
          {isOwner
            ? "Groups control who sees what: share an object into a group and only its holders can open it. Everyone also has an automatic personal tag — that's what “private” means."
            : "Groups control who sees what. Ask an owner to create groups or change who's in them."}
        </p>
      </header>

      <div className="min-h-0 flex-1 px-8 py-6">
        {error && (
          <div className="mb-4 max-w-[720px] rounded-none border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
            {error}
          </div>
        )}

        {!tags && !loadError && <Spinner />}
        {!tags && loadError && <LoadError message={loadError} onRetry={() => void reload()} />}
        {tags && tags.length === 0 && <Empty>No tags yet — this box may still be migrating.</Empty>}
        {tags && tags.length > 0 && (
          <div className="max-w-[900px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Group</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Who's in it</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((t) => (
                  <TagRowLine
                    key={t.slug}
                    tag={t}
                    members={members ?? []}
                    isOwner={isOwner}
                    busy={busy}
                    nameOf={nameOf}
                    onGrant={(accountId) => void run(() => api.grantTag(t.slug, accountId))}
                    onRevoke={(accountId) => void run(() => api.revokeTag(t.slug, accountId))}
                  />
                ))}
              </TableBody>
            </Table>

            {isOwner && groups.length <= 1 && (
              <p className="mt-5 max-w-[720px] text-[13px] text-mut">
                No groups yet. Create one below (say <code className="font-mono">pricing</code> or{" "}
                <code className="font-mono">leadership</code>), add people to it, then use{" "}
                <span className="font-medium">Share</span> on any object to open it to that group.
              </p>
            )}
            {isOwner && (
              <CreateTag busy={busy} onCreate={(slug) => void run(() => api.createTag(slug))} />
            )}

            {personal.length > 0 && (
              <div className="mt-8 border-t border-line-soft pt-4">
                <button
                  type="button"
                  onClick={() => setShowPersonal((v) => !v)}
                  aria-expanded={showPersonal}
                  className="text-[12.5px] text-mut transition-colors hover:text-ink"
                >
                  {showPersonal ? "Hide" : "Show"} personal tags ({personal.length}) — automatic,
                  one per person; they're how private objects stay private
                </button>
                {showPersonal && (
                  <ul className="mt-3 space-y-1.5">
                    {personal.map((t) => (
                      <li key={t.slug} className="flex items-baseline gap-3 text-[13px]">
                        <span>{t.holders[0] ? nameOf(t.holders[0]) : "—"}</span>
                        <span className="font-mono text-[11.5px] text-dim">{t.slug}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function kindBadge(kind: TagRow["kind"]) {
  if (kind === "org") return <Badge variant="default">org</Badge>;
  if (kind === "custom") return <Badge variant="outline">custom</Badge>;
  return <Badge variant="secondary">personal</Badge>;
}

function TagRowLine({
  tag,
  members,
  isOwner,
  busy,
  nameOf,
  onGrant,
  onRevoke,
}: {
  tag: TagRow;
  members: Member[];
  isOwner: boolean;
  busy: boolean;
  nameOf: (id: string) => string;
  onGrant: (accountId: string) => void;
  onRevoke: (accountId: string) => void;
}) {
  // Only CUSTOM tags are managed here. Personal tags are the identity itself
  // (1:1, never granted) and the org tag is held by everyone at birth.
  const managed = isOwner && tag.kind === "custom";
  // Candidates: active humans who don't already hold it. Historical service
  // accounts are excluded — they were never grantable and rows may persist.
  const candidates = members.filter((m) => m.status === "active" && !tag.holders.includes(m.id));
  // Holders shown (and counted) are ACTIVE accounts only. Revoked accounts
  // keep their account_tags rows in the DB — harmless (a dead token never
  // authenticates, so RLS never evaluates for them) but "everyone (18)" on a
  // 2-person box answered the question "who can read this?" with a lie.
  const activeHolders = tag.holders.filter((id) =>
    members.some((m) => m.id === id && m.status === "active"),
  );
  return (
    <TableRow>
      <TableCell className="font-mono text-[12.5px] font-medium">{tag.slug}</TableCell>
      <TableCell>{kindBadge(tag.kind)}</TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          {tag.kind === "custom" ? (
            <>
              {activeHolders.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-none border border-line-soft bg-hover px-2 py-0.5 text-[12px]"
                >
                  {nameOf(id)}
                  {managed && (
                    <button
                      type="button"
                      aria-label={`Remove ${nameOf(id)} from ${tag.slug}`}
                      disabled={busy}
                      onClick={() => onRevoke(id)}
                      className="text-dim transition-colors hover:text-ink disabled:opacity-50"
                    >
                      <X size={11} aria-hidden />
                    </button>
                  )}
                </span>
              ))}
              {activeHolders.length === 0 && (
                <span className="text-[12px] text-dim">nobody yet</span>
              )}
              {managed && candidates.length > 0 && (
                <AddHolder
                  tagSlug={tag.slug}
                  candidates={candidates}
                  busy={busy}
                  onPick={onGrant}
                />
              )}
            </>
          ) : (
            // Inert: a count, not chips — these rows are not editable identity
            // facts, and per-name chips would only invite clicks that refuse.
            <span className="text-[12px] text-mut">
              {tag.kind === "personal"
                ? tag.holders[0]
                  ? nameOf(tag.holders[0])
                  : "—"
                : `everyone (${activeHolders.length})`}
            </span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** The add-holder picker: choosing a member IS the grant (no second button). */
function AddHolder({
  tagSlug,
  candidates,
  busy,
  onPick,
}: {
  tagSlug: string;
  candidates: Member[];
  busy: boolean;
  onPick: (accountId: string) => void;
}) {
  return (
    <Select
      value={null}
      onValueChange={(v: string | null) => {
        if (v) onPick(v);
      }}
    >
      <SelectTrigger size="sm" disabled={busy} aria-label={`Add a holder to ${tagSlug}`}>
        <SelectValue placeholder="Add holder…" />
      </SelectTrigger>
      <SelectContent>
        {candidates.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CreateTag({ busy, onCreate }: { busy: boolean; onCreate: (slug: string) => void }) {
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const s = slug.trim();
    // The same shape the server enforces — refuse it here so a typo never
    // costs a round-trip (the server still re-checks).
    if (!TAG_SLUG_RE.test(s)) {
      setError(SLUG_HINT);
      return;
    }
    setError(null);
    onCreate(s);
    setSlug("");
  };

  return (
    <Card className="mt-6 max-w-[720px]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <Tags size={14} aria-hidden />
          Create a tag
        </CardTitle>
        <CardDescription>
          A custom group tag — grant it to members above, then share objects into it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <div className="mb-3 text-[12.5px] text-destructive">{error}</div>}
        <form onSubmit={submit} className="flex flex-wrap gap-2.5">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="c-suite"
            aria-label="Tag slug"
            required
            className="flex-1 basis-[200px] font-mono"
          />
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
