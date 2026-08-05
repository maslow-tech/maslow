import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy, Plug } from "lucide-react";
import {
  api,
  ApiError,
  errorMessage,
  type ConnectorStatus,
  type CustomConnectorDefinition,
  type Whoami,
} from "../lib/api";
import { Empty, LoadError, Spinner } from "../components/bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * Connectors. Two independent layers per provider:
 *   - OWNER config: supply the provider credential / OAuth client (stored
 *     encrypted; never echoed back). Configured state shows Edit/Disable only —
 *     fields appear when editing.
 *   - per-member CONNECT (OAuth providers): once configured, ANY member links
 *     their own provider account via the consent flow.
 * The server enforces both gates — this UI is convenience, not the boundary.
 */
export function ConnectorsView({ user }: { user: Whoami }) {
  const isOwner = user.role === "owner";
  const [items, setItems] = useState<ConnectorStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Distinct from `error` (mutation/OAuth-callback banner): a failed INITIAL
  // load shows LoadError+Retry instead of an infinite skeleton.
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = () => {
    setLoadError(null);
    return api
      .connectors()
      .then(setItems)
      .catch((e: unknown) => setLoadError(errorMessage(e)));
  };
  useEffect(() => {
    reload();
    // The OAuth callback lands back here with ?connected= / ?error= — surface
    // it once, then clean the URL.
    const q = new URLSearchParams(location.search);
    const connected = q.get("connected");
    const err = q.get("error");
    if (connected) setNotice(`Connected ${connected}.`);
    if (err) setError(`Connect failed (${err}) — try again.`);
    if (connected || err) history.replaceState(null, "", location.pathname);
  }, []);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Connectors</h1>
        <p className="mt-1 text-[13.5px] text-mut">
          {isOwner
            ? "Enable a provider with its credential; members then connect their own accounts."
            : "Connect your accounts on providers an owner has enabled."}
        </p>
      </header>

      <div className="min-h-0 flex-1 px-8 py-6">
        {notice && (
          <Banner tone="ok" onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        )}
        {error && (
          <Banner tone="err" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        {!items && !loadError && <Spinner />}
        {!items && loadError && <LoadError message={loadError} onRetry={() => void reload()} />}
        {items && items.length === 0 && <Empty>No connectors available.</Empty>}
        {items && (
          // Masonry columns, not a grid: a short enabled card no longer forces
          // a gap beside a tall one (grid coupled row heights).
          <div className="max-w-[1100px] gap-4 lg:columns-2">
            {items.map((c) => (
              <Card key={c.provider} className="mb-4 break-inside-avoid">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2.5 text-[14px]">
                    <ProviderLogo provider={c.provider} />
                    {c.name}
                    {c.orgEnabled && <Badge variant="default">org</Badge>}
                    {c.myPersonalEnabled && <Badge variant="outline">you</Badge>}
                    {!c.orgEnabled && !c.myPersonalEnabled && (
                      <Badge variant="secondary">not enabled</Badge>
                    )}
                    {c.oauth && c.connected && <Badge variant="outline">connected</Badge>}
                  </CardTitle>
                  <CardDescription>
                    {c.orgEnabled || c.myPersonalEnabled
                      ? c.oauth
                        ? "Connect your account so the brain's agents can act as you."
                        : "Enabled — the brain's agents can use this connector."
                      : c.selfAdoptable
                        ? "Add your own credential below to use this, or ask an owner to enable it org-wide."
                        : isOwner
                          ? "Follow the setup guide below to enable this connector."
                          : "Not available yet — ask an owner to enable it."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {c.oauth && c.orgEnabled && (
                    <ConnectRow connector={c} onError={setError} onChanged={reload} />
                  )}
                  <AccessPanel connector={c} />
                  {isOwner && c.setup && <SetupGuide connector={c} />}
                  {isOwner && <OwnerConfig connector={c} onError={setError} onChanged={reload} />}
                  {/* Bring-your-own personal credential — any member, on
                      api-key / custom connectors (personal OAuth clients: PR1b). */}
                  {c.selfAdoptable && (
                    <PersonalConfig connector={c} onError={setError} onChanged={reload} />
                  )}
                  {isOwner && c.custom && (
                    <CustomAdmin connector={c} onError={setError} onChanged={reload} />
                  )}
                </CardContent>
              </Card>
            ))}
            {isOwner && (
              <Card className="mb-4 break-inside-avoid border-dashed">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2.5 text-[14px]">
                    <Plug size={18} aria-hidden />
                    Custom connector
                  </CardTitle>
                  <CardDescription>
                    Point the brain's agents at any HTTP API: a base URL, how the credential
                    attaches, and your usage instructions. Agents get a{" "}
                    <code className="font-mono text-[12px]">&lt;slug&gt;_fetch</code> tool.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Disclosure label="New connector">
                    <CustomConnectorForm onError={setError} onSaved={reload} />
                  </Disclosure>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A chevron-row inline expander — the card grows; nothing overlays the form. */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line-soft py-2.5">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-[13px] font-medium"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {label}
      </button>
      {open && <div className="pt-3 pl-[18.5px]">{children}</div>}
    </div>
  );
}

/** Member-facing: what the connector can touch, per app, plus the raw scopes.
 *  Leads with the per-person framing so nobody reads the list as org-wide
 *  access. */
function AccessPanel({ connector }: { connector: ConnectorStatus }) {
  return (
    <Disclosure label="What it can access">
      {connector.oauth && (
        <p className="mb-3 text-[12.5px] leading-relaxed text-mut">
          These permissions are granted <b>per person</b>. When you click Connect, you're
          authorizing the brain to act on <b>your own account only</b> — it can never see another
          person's mail, files, or messages, and it can never see more than you yourself can. You
          can disconnect at any time.
        </p>
      )}
      <table className="w-full text-[12.5px]">
        <tbody>
          {connector.access.map((row) => (
            <tr key={row.app} className="align-top">
              <td className="w-[150px] py-1 pr-3 font-medium whitespace-nowrap">{row.app}</td>
              <td className="py-1 text-mut">{row.allows}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {connector.scopes && connector.scopes.length > 0 && (
        <Disclosure label={`Technical scopes (${connector.scopes.length})`}>
          <ul className="flex flex-col gap-1">
            {connector.scopes.map((s) => (
              <li key={s} className="font-mono text-[11.5px] break-all text-dim">
                {s}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Disclosure>
  );
}

/** Owner-facing: the registration walkthrough, with this box's redirect URI
 *  substituted into the step that needs it (copy button included). */
function SetupGuide({ connector }: { connector: ConnectorStatus }) {
  const setup = connector.setup!;
  const token = "{{redirectUri}}";
  // Guarantee the redirect URI is visible for every OAuth connector even if
  // no step text carries the token (a mis-registered redirect URI breaks
  // every member's Connect with redirect_uri_mismatch).
  const tokenInSteps = setup.steps.some((s) => s.includes(token));
  return (
    <Disclosure label="Setup guide (owner)">
      <p className="mb-3 text-[12.5px] leading-relaxed text-mut">{setup.intro}</p>
      {connector.oauth && !tokenInSteps && (
        <p className="mb-3 text-[12.5px]">
          Authorized redirect URI: <RedirectUri redirectUri={connector.redirectUri ?? null} />
        </p>
      )}
      <ol className="flex list-decimal flex-col gap-2 pl-4 text-[12.5px] leading-relaxed">
        {setup.steps.map((step, i) => (
          <li key={i}>
            <SetupStep text={step} redirectUri={connector.redirectUri ?? null} />
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}

function RedirectUri({ redirectUri }: { redirectUri: string | null }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <code className="font-mono text-[11.5px] break-all select-all">
        {redirectUri ?? "https://<your-box-domain>/connect/callback"}
      </code>
      {redirectUri && <CopyButton value={redirectUri} />}
    </span>
  );
}

function SetupStep({ text, redirectUri }: { text: string; redirectUri: string | null }) {
  // Substitute EVERY occurrence of the token, not just the first.
  const parts = text.split("{{redirectUri}}");
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <RedirectUri redirectUri={redirectUri} />}
          {part}
        </span>
      ))}
    </>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ponytail: clipboard API needs a secure context — over plain http the
  // button hides and the select-all <code> is the copy path.
  if (!navigator.clipboard) return null;
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 text-[11px] text-dim hover:opacity-70"
      title="Copy"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          },
          () => {
            /* permission denied — the select-all code element remains */
          },
        );
      }}
    >
      <Copy size={11} aria-hidden />
      {copied ? "copied" : "copy"}
    </button>
  );
}

function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: "ok" | "err";
  children: React.ReactNode;
  onDismiss: () => void;
}) {
  const cls =
    tone === "err"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-line-soft bg-accent/40";
  return (
    <div
      className={`mb-4 flex max-w-[520px] items-center justify-between rounded-none border px-3.5 py-2.5 text-[13px] ${cls}`}
    >
      <span>{children}</span>
      <button className="ml-3 text-[12px] underline opacity-70" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  );
}

/** Per-member connect / disconnect for OAuth providers. Connect fetches the
 *  provider consent URL and sends the browser there; the callback returns to
 *  this page. */
function ConnectRow({
  connector,
  onError,
  onChanged,
}: {
  connector: ConnectorStatus;
  onError: (msg: string | null) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      const { consentUrl } = await api.connectConnector(connector.provider);
      location.assign(consentUrl);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "could not start the connect flow");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.disconnectConnector(connector.provider);
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "could not disconnect");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 pb-1">
      {connector.connected ? (
        <>
          <span className="text-[13px] text-mut">Your account is connected.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Disconnect
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" disabled={busy} onClick={() => void connect()}>
          {busy ? "Redirecting…" : "Connect"}
        </Button>
      )}
    </div>
  );
}

/** Owner-only enable/configure/disable. Configured state is COLLAPSED (no
 *  fields) — Edit reveals them; stored values are NEVER rendered back and
 *  submitting replaces the whole credential set. */
function OwnerConfig({
  connector,
  onError,
  onChanged,
}: {
  connector: ConnectorStatus;
  onError: (msg: string | null) => void;
  onChanged: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // Inline two-step confirm before disabling org-wide — the tool DISAPPEARS for
  // every member, mirroring the custom-delete pattern.
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const showFields = editing || !connector.orgEnabled;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.enableConnector(connector.provider, values, "org");
      setValues({});
      setEditing(false);
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "could not save configuration");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.disableConnector(connector.provider, "org");
      setValues({});
      setEditing(false);
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "could not disable connector");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="border-t border-line-soft pt-4">
      <div className="mb-3 text-[12px] font-semibold tracking-[.06em] text-dim uppercase">
        {connector.orgEnabled ? "Org credential (owner)" : "Enable org-wide (owner)"}
      </div>

      {!showFields && (
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] text-mut">Configured.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          {confirmingDisable ? (
            <>
              <span className="text-[12.5px] text-destructive">
                Disable for every member? The tool disappears fleet-wide.
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirmingDisable(false);
                  void disable();
                }}
              >
                Confirm
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingDisable(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingDisable(true)}
            >
              Disable
            </Button>
          )}
        </div>
      )}

      {showFields && (
        <>
          <div className="flex flex-col gap-3">
            {connector.fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`${connector.provider}-${f.key}`}>{f.label}</Label>
                <Input
                  id={`${connector.provider}-${f.key}`}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  required
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={connector.orgEnabled ? "configured — enter to replace" : f.label}
                  className="max-w-[420px] font-mono text-[12.5px]"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-2.5">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : connector.orgEnabled ? "Save" : "Enable org-wide"}
            </Button>
            {connector.orgEnabled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setValues({});
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </>
      )}
    </form>
  );
}

/** Any member's OWN personal credential for a self-adoptable connector — the
 *  "bring your own key" path. Independent of the org credential: a member can
 *  set theirs whether or not the org has one (personal-first resolution means
 *  theirs wins for their own calls). */
function PersonalConfig({
  connector,
  onError,
  onChanged,
}: {
  connector: ConnectorStatus;
  onError: (msg: string | null) => void;
  onChanged: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const showFields = editing || !connector.myPersonalEnabled;

  const run = async (fn: () => Promise<unknown>, fail: string) => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await fn();
      setValues({});
      setEditing(false);
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : fail);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () => api.enableConnector(connector.provider, values, "personal"),
      "could not save your credential",
    );
  };

  return (
    <form onSubmit={submit} className="border-t border-line-soft pt-4">
      <div className="mb-3 text-[12px] font-semibold tracking-[.06em] text-dim uppercase">
        {connector.myPersonalEnabled ? "Your credential" : "Use your own credential"}
      </div>

      {!showFields ? (
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] text-mut">Your own credential is set.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(
                () => api.disableConnector(connector.provider, "personal"),
                "could not remove your credential",
              )
            }
          >
            Remove
          </Button>
        </div>
      ) : (
        <>
          <p className="mb-3 max-w-[420px] text-[12.5px] leading-relaxed text-mut">
            Stored for <b>you only</b> and used for your own calls (it takes precedence over any
            org-wide credential). Encrypted at rest; never shown back.
          </p>
          <div className="flex flex-col gap-3">
            {connector.fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`${connector.provider}-personal-${f.key}`}>{f.label}</Label>
                <Input
                  id={`${connector.provider}-personal-${f.key}`}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  required
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={connector.myPersonalEnabled ? "set — enter to replace" : f.label}
                  className="max-w-[420px] font-mono text-[12.5px]"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-2.5">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : connector.myPersonalEnabled ? "Save" : "Use my credential"}
            </Button>
            {connector.myPersonalEnabled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setValues({});
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </>
      )}
    </form>
  );
}

/** Small inline brand marks — no webfonts, no external images (CSP: self). */
function ProviderLogo({ provider }: { provider: string }) {
  if (provider === "google") {
    // The Google "G" (the connector is all of Google, not just Gmail).
    return (
      <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden>
        <path
          fill="#4285F4"
          d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.394 3.622v3.011h3.878c2.269-2.089 3.578-5.165 3.578-8.82z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.956-1.075 7.942-2.907l-3.878-3.011c-1.075.72-2.45 1.145-4.064 1.145-3.125 0-5.771-2.111-6.715-4.948H1.276v3.11A11.995 11.995 0 0 0 12 24z"
        />
        <path
          fill="#FBBC05"
          d="M5.285 14.28A7.213 7.213 0 0 1 4.909 12c0-.791.136-1.56.376-2.28V6.611H1.276a11.995 11.995 0 0 0 0 10.778l4.009-3.11z"
        />
        <path
          fill="#EA4335"
          d="M12 4.773c1.762 0 3.344.605 4.587 1.794l3.442-3.442C17.951 1.19 15.235 0 12 0A11.995 11.995 0 0 0 1.276 6.61l4.009 3.11C6.229 6.884 8.875 4.773 12 4.773z"
        />
      </svg>
    );
  }
  if (provider === "msgraph") {
    // The Microsoft four squares.
    return (
      <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden>
        <rect x="1" y="1" width="10.5" height="10.5" fill="#F25022" />
        <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00" />
        <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF" />
        <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900" />
      </svg>
    );
  }
  if (provider === "samgov") {
    // SAM.gov's brand element is the US flag next to its wordmark — an
    // accurate flag (7 visible stripes at this size, starred canton).
    return (
      <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden>
        <g>
          <rect x="1" y="5.5" width="22" height="13" rx="1" fill="#fff" />
          <path
            fill="#B22234"
            d="M1 6.5a1 1 0 0 1 1-1h20a1 1 0 0 1 1 1v.86H1zM1 9.21h22v1.86H1zM1 12.93h22v1.86H1zM1 16.64h22v.86a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"
          />
          <path d="M1 6.5a1 1 0 0 1 1-1h9.5v7H1z" fill="#3C3B6E" />
          <g fill="#fff">
            <circle cx="3.2" cy="7" r=".55" />
            <circle cx="5.9" cy="7" r=".55" />
            <circle cx="8.6" cy="7" r=".55" />
            <circle cx="4.55" cy="8.5" r=".55" />
            <circle cx="7.25" cy="8.5" r=".55" />
            <circle cx="9.95" cy="8.5" r=".55" />
            <circle cx="3.2" cy="10" r=".55" />
            <circle cx="5.9" cy="10" r=".55" />
            <circle cx="8.6" cy="10" r=".55" />
            <circle cx="4.55" cy="11.5" r=".55" />
            <circle cx="7.25" cy="11.5" r=".55" />
            <circle cx="9.95" cy="11.5" r=".55" />
          </g>
        </g>
      </svg>
    );
  }
  // Custom connectors have no brand asset — a neutral plug.
  return <Plug size={18} aria-hidden className="text-mut" />;
}

/** Owner admin for a CUSTOM connector: edit the definition, or delete the
 *  whole connector (definition + org credential). The credential itself is
 *  managed by OwnerConfig above, exactly like a catalog provider. */
function CustomAdmin({
  connector,
  onError,
  onChanged,
}: {
  connector: ConnectorStatus;
  onError: (msg: string | null) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.deleteCustomConnector(connector.provider);
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "could not delete the connector");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="mt-4 border-t border-line-soft pt-4">
      <Disclosure label="Edit definition">
        <CustomConnectorForm
          existing={{
            slug: connector.provider,
            name: connector.name,
            ...(connector.definition ? { def: connector.definition } : {}),
          }}
          onError={onError}
          onSaved={onChanged}
        />
      </Disclosure>
      <div className="mt-3 flex items-center gap-2.5">
        {confirming ? (
          <>
            <span className="text-[12.5px] text-mut">
              Delete this connector and its stored credential? The tool disappears for every member.
            </span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => setConfirming(true)}
          >
            Delete connector
          </Button>
        )}
      </div>
    </div>
  );
}

/** Create/edit form for a custom connector definition. The secret is
 *  optional: blank leaves the stored credential untouched (edit), non-blank
 *  stores/replaces it (which also enables the connector). */
function CustomConnectorForm({
  existing,
  onError,
  onSaved,
}: {
  existing?: { slug: string; name: string; def?: CustomConnectorDefinition };
  onError: (msg: string | null) => void;
  onSaved: () => void;
}) {
  const d = existing?.def;
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(d?.baseUrl ?? "");
  const [authKind, setAuthKind] = useState<"header" | "query" | "none">(d?.authKind ?? "header");
  const [authName, setAuthName] = useState(d?.authName ?? "");
  const [secret, setSecret] = useState("");
  const [prefixes, setPrefixes] = useState((d?.allowedPrefixes ?? []).join(", "));
  const [description, setDescription] = useState(d?.description ?? "");
  const [instructions, setInstructions] = useState(d?.instructions ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api.saveCustomConnector({
        slug: slug.trim(),
        name: name.trim() || slug.trim(),
        baseUrl: baseUrl.trim(),
        authKind,
        authName: authKind === "none" ? null : authName.trim(),
        allowedPrefixes: prefixes
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== ""),
        description: description.trim(),
        instructions: instructions.trim(),
        ...(secret.trim() !== "" ? { secret: secret.trim() } : {}),
      });
      setSecret("");
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "could not save the connector");
    } finally {
      setBusy(false);
    }
  };

  const field = "flex flex-col gap-1.5";
  return (
    <form onSubmit={submit} className="flex max-w-[460px] flex-col gap-3 pt-1">
      <div className="flex gap-3">
        <div className={`${field} flex-1`}>
          <Label htmlFor="cc-slug">Slug (tool = slug_fetch)</Label>
          <Input
            id="cc-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="weatherapi"
            disabled={existing !== undefined}
            required
          />
        </div>
        <div className={`${field} flex-1`}>
          <Label htmlFor="cc-name">Name</Label>
          <Input
            id="cc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Weather API"
          />
        </div>
      </div>
      <div className={field}>
        <Label htmlFor="cc-url">Base URL (https)</Label>
        <Input
          id="cc-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com"
          required
        />
      </div>
      <div className="flex gap-3">
        <div className={`${field} w-[150px]`}>
          <Label>Auth</Label>
          <Select
            value={authKind}
            onValueChange={(v) => v && setAuthKind(v as "header" | "query" | "none")}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="header">header</SelectItem>
              <SelectItem value="query">query param</SelectItem>
              <SelectItem value="none">none (public)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {authKind !== "none" && (
          <div className={`${field} flex-1`}>
            <Label htmlFor="cc-authname">
              {authKind === "header" ? "Header name" : "Query parameter"}
            </Label>
            <Input
              id="cc-authname"
              value={authName}
              onChange={(e) => setAuthName(e.target.value)}
              placeholder={authKind === "header" ? "X-Api-Key" : "api_key"}
              required
            />
          </div>
        )}
      </div>
      {authKind !== "none" && (
        <div className={field}>
          <Label htmlFor="cc-secret">
            Secret{existing ? " (blank = keep the stored one)" : ""}
          </Label>
          <Input
            id="cc-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
      <div className={field}>
        <Label htmlFor="cc-prefixes">Allowed path prefixes (comma-separated, blank = any)</Label>
        <Input
          id="cc-prefixes"
          value={prefixes}
          onChange={(e) => setPrefixes(e.target.value)}
          placeholder="/v1/, /v2/status"
        />
      </div>
      <div className={field}>
        <Label htmlFor="cc-desc">Tool description (what agents see in their tool list)</Label>
        <Textarea
          id="cc-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>
      <div className={field}>
        <Label htmlFor="cc-instr">Instructions (returned when the tool is called empty)</Label>
        <Textarea
          id="cc-instr"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={4}
          placeholder="Endpoints, required params, formats, budget discipline…"
        />
      </div>
      <div>
        <Button type="submit" size="sm" disabled={busy || slug.trim() === ""}>
          {busy ? "Saving…" : existing ? "Save changes" : "Create connector"}
        </Button>
      </div>
    </form>
  );
}
