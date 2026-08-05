import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, KeyRound, Minus, ShieldOff, UserMinus, UserPlus } from "lucide-react";
import {
  api,
  ApiError,
  type Member,
  type OwnerRemoval,
  type TagRow,
  type Whoami,
} from "../lib/api";
import { revokeAvailability } from "../lib/member-actions";
import { Empty, Spinner } from "../components/bits";
import { fmtDateTime } from "../lib/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Pending = { kind: "rotate" | "revoke" | "remove-owner"; member: Member } | null;

/** A removal still in its veto window — neither cancelled nor executed. */
export function isPendingRemoval(r: OwnerRemoval): boolean {
  return r.cancelled_at === null && r.executed_at === null;
}

/**
 * Members: everyone can see who has access; the OWNER can add members, rotate
 * tokens, and revoke access. Minted tokens exist client-side exactly once —
 * the server stores only their hash, so the copy moment here is the only
 * chance to grab one. Admin calls are CSRF'd and the server re-checks the
 * owner role from the DB per request — this UI is convenience, not the gate.
 */
export function MembersView({ user }: { user: Whoami }) {
  const isOwner = user.role === "owner";
  const [members, setMembers] = useState<Member[] | null>(null);
  // Custom group tags each member holds (wave 3) — shown as chips. Org and
  // personal tags are birthright noise, so only `custom` rows are kept; an
  // older box without /api/v1/tags simply shows no chips.
  const [tagRows, setTagRows] = useState<TagRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  // one-shot minted tokens by account id (create or rotate)
  const [minted, setMinted] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  // Owner removals (wave 5) — only the PENDING ones matter here: they render a
  // veto banner on the target and gate the "Remove owner" affordance. An older
  // box without the route simply shows none.
  const [removals, setRemovals] = useState<OwnerRemoval[]>([]);

  const reloadRemovals = () =>
    api
      .ownerRemovals()
      .then((r) => setRemovals(r.removals.filter(isPendingRemoval)))
      .catch(() => undefined);
  const reload = () =>
    Promise.all([api.members().then(setMembers).catch(console.error), reloadRemovals()]);
  useEffect(() => {
    void reload();
    api
      .tags()
      .then((r) => setTagRows(r.tags.filter((t) => t.kind === "custom")))
      .catch(() => undefined);
  }, []);

  const pendingRemovalFor = (accountId: string) => removals.find((r) => r.target_id === accountId);

  const cancelRemoval = async (removal: OwnerRemoval) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelOwnerRemoval(removal.id);
      await reloadRemovals();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "cancel failed");
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async () => {
    if (!pending || busy) return;
    // The dialog can only be opened from an enabled control, but re-check here
    // too: a stale `pending` (the member was promoted to owner in another tab
    // between click and confirm) must not fire a call the server will refuse.
    if (pending.kind === "revoke" && !revokeAvailability(pending.member, user).enabled) {
      setPending(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === "rotate") {
        const r = await api.rotateToken(pending.member.id);
        setMinted((t) => ({ ...t, [pending.member.id]: r.token }));
      } else if (pending.kind === "remove-owner") {
        // The server is the gate (last owner, already pending, not an owner) —
        // its refusals are written to be shown, so they surface verbatim.
        await api.initiateOwnerRemoval(pending.member.id);
        await reloadRemovals();
      } else {
        await api.revokeAccount(pending.member.id);
        await reload();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `${pending.kind} failed`);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Members</h1>
        <p className="mt-1 text-[13.5px] text-mut">
          {isOwner
            ? "Who can open this brain. Tokens are shown once — copy them when minted."
            : "Who can open this brain. Ask an owner to add members or rotate tokens."}
        </p>
      </header>

      <div className="min-h-0 flex-1 px-8 py-6">
        {error && (
          <div className="mb-4 max-w-[720px] rounded-none border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
            {error}
          </div>
        )}

        {/* The veto window (wave 5): every pending owner removal is announced
            where any owner — the target included — can cancel it. */}
        {isOwner &&
          removals.map((r) => (
            <div
              key={r.id}
              role="status"
              aria-label={`Owner removal pending for ${r.target_name}`}
              className="mb-4 flex max-w-[720px] flex-wrap items-center gap-3 rounded-none border border-line bg-hover px-3.5 py-2.5 text-[13px]"
            >
              <span>
                Owner removal pending — <span className="font-medium">{r.target_name}</span> loses
                owner access {fmtDateTime(r.effective_at)}. Initiated by {r.initiated_by_name}; any
                owner can cancel before then.
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                className="ml-auto"
                aria-label={`Cancel removal of ${r.target_name}`}
                onClick={() => void cancelRemoval(r)}
              >
                Cancel
              </Button>
            </div>
          ))}

        {!members && <Spinner />}
        {members && members.length === 0 && <Empty>No members yet.</Empty>}
        {members && members.length > 0 && (
          <div className="max-w-[900px]">
            {members.some((m) => m.status !== "active") && (
              <div className="mb-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowRevoked((v) => !v)}
                  aria-pressed={showRevoked}
                  className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground"
                >
                  <span
                    className={`relative h-[17px] w-[30px] shrink-0 ${showRevoked ? "bg-primary" : "bg-border"}`}
                  >
                    <span
                      className={`absolute top-[2px] h-[13px] w-[13px] bg-white transition-all ${showRevoked ? "left-[15px]" : "left-[2px]"}`}
                    />
                  </span>
                  Show revoked
                </button>
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Status</TableHead>
                  {isOwner && <TableHead className="text-right">Token</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members
                  .filter((m) => showRevoked || m.status === "active")
                  .map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">
                        {m.name}
                        {m.id === user.id && (
                          <span className="ml-2 text-[11px] text-muted-foreground">you</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={m.role === "owner" ? "default" : "secondary"}>
                          {m.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[12px] text-muted-foreground">
                        {m.scopes.join(" · ")}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex flex-wrap gap-1">
                          {tagRows
                            .filter((t) => t.holders.includes(m.id))
                            .map((t) => (
                              <Badge
                                key={t.slug}
                                variant="outline"
                                className="font-mono text-[10.5px]"
                              >
                                {t.slug}
                              </Badge>
                            ))}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={m.status === "active" ? "outline" : "destructive"}>
                          {m.status}
                        </Badge>
                      </TableCell>
                      {isOwner && (
                        <TableCell className="text-right">
                          {minted[m.id] ? (
                            <TokenReveal token={minted[m.id]!} />
                          ) : (
                            <span className="inline-flex gap-1.5">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="outline"
                                      size="icon-sm"
                                      disabled={busy || m.status !== "active"}
                                      onClick={() => setPending({ kind: "rotate", member: m })}
                                    >
                                      <KeyRound aria-hidden />
                                    </Button>
                                  }
                                />
                                <TooltipContent>Rotate token</TooltipContent>
                              </Tooltip>
                              {/* Revoke is OFFERED only where the server will
                                  accept it (see revokeAvailability) — an owner,
                                  or yourself, gets an inert marker carrying the
                                  reason, never a live button that fails after
                                  the confirm dialog. */}
                              {(() => {
                                const rev = revokeAvailability(m, user);
                                return (
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        rev.enabled ? (
                                          <Button
                                            variant="destructive"
                                            size="icon-sm"
                                            disabled={busy}
                                            onClick={() =>
                                              setPending({ kind: "revoke", member: m })
                                            }
                                          >
                                            <ShieldOff aria-hidden />
                                          </Button>
                                        ) : (
                                          <span
                                            role="img"
                                            aria-label={rev.reason}
                                            className="inline-flex size-7 items-center justify-center text-muted-foreground/50"
                                          >
                                            <Minus aria-hidden />
                                          </span>
                                        )
                                      }
                                    />
                                    <TooltipContent>{rev.reason}</TooltipContent>
                                  </Tooltip>
                                );
                              })()}
                              {/* Owner removal (wave 5): revoke refuses owners
                                  (peers), so an owner row gets its own delayed
                                  removal with a veto window instead. Hidden
                                  while one is already pending — the banner
                                  above carries that state and its Cancel. */}
                              {m.role === "owner" &&
                                m.status === "active" &&
                                (pendingRemovalFor(m.id) ? (
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <span
                                          role="img"
                                          aria-label="Owner removal pending"
                                          className="inline-flex size-7 items-center justify-center text-muted-foreground/50"
                                        >
                                          <UserMinus aria-hidden />
                                        </span>
                                      }
                                    />
                                    <TooltipContent>
                                      Owner removal pending — takes effect{" "}
                                      {fmtDateTime(pendingRemovalFor(m.id)!.effective_at)}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          variant="destructive"
                                          size="icon-sm"
                                          disabled={busy}
                                          aria-label={`Remove owner ${m.name}`}
                                          onClick={() =>
                                            setPending({ kind: "remove-owner", member: m })
                                          }
                                        >
                                          <UserMinus aria-hidden />
                                        </Button>
                                      }
                                    />
                                    <TooltipContent>Remove owner…</TooltipContent>
                                  </Tooltip>
                                ))}
                            </span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
              </TableBody>
            </Table>

            {isOwner && (
              <AddMember
                onCreated={(id, token) => {
                  setMinted((t) => ({ ...t, [id]: token }));
                  reload();
                }}
              />
            )}
          </div>
        )}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "rotate"
                ? `Rotate ${pending.member.name}'s token?`
                : pending?.kind === "remove-owner"
                  ? `Remove ${pending.member.name} as an owner?`
                  : `Revoke ${pending?.member.name}'s access?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "rotate"
                ? "Their current token stops working immediately. The new one is shown once — copy it and pass it along."
                : pending?.kind === "remove-owner"
                  ? "Not immediate: the removal takes effect after a waiting period, and any owner — including them — can cancel it before then."
                  : "They lose access to the brain entirely. This cannot be undone from here."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmPending();
              }}
            >
              {busy
                ? "Working…"
                : pending?.kind === "rotate"
                  ? "Rotate token"
                  : pending?.kind === "remove-owner"
                    ? "Remove owner"
                    : "Revoke access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The one-shot token: monospace, copy button, never fetchable again. */
function TokenReveal({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-[320px] items-center gap-1.5 rounded-none border border-line bg-panel2 py-1 pr-1 pl-2">
      <code className="truncate font-mono text-[11.5px] text-ink">{token}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Copy token"
        onClick={() => {
          navigator.clipboard.writeText(token).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </span>
  );
}

function AddMember({ onCreated }: { onCreated: (id: string, token: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createMember({ name: name.trim(), email: email.trim(), permission });
      onCreated(r.id, r.token);
      setName("");
      setEmail("");
      setPermission("member");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not add member");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-6 max-w-[720px]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <UserPlus size={14} aria-hidden />
          Add a member
        </CardTitle>
        <CardDescription>
          The token appears once in the table above — the box stores only its hash.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <div className="mb-3 text-[12.5px] text-destructive">{error}</div>}
        <form onSubmit={submit} className="flex flex-wrap gap-2.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            required
            className="flex-1 basis-[160px]"
          />
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@company.com"
            type="email"
            required
            className="flex-1 basis-[200px]"
          />
          <Select value={permission} onValueChange={(v) => v && setPermission(v)}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">member</SelectItem>
              <SelectItem value="viewer">viewer</SelectItem>
              <SelectItem value="owner">owner</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={busy}>
            {busy ? "Minting…" : "Add & mint token"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
