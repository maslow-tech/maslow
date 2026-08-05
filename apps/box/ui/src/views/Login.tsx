import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { useTheme } from "../lib/theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Token-paste sign-in. Light skin: black-and-white paper card. Dark skin: the
 * aurora glass card, continuous with the box's OAuth visual language. Either
 * way the token is posted once and exchanged for a read-only session cookie.
 */
export function Login({ onSignedIn, brandName }: { onSignedIn: () => void; brandName: string }) {
  const { mono } = useTheme();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That token was not recognized. Check it and try again."
          : "Could not reach the brain. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center overflow-hidden bg-ground p-6">
      {!mono && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0"
          style={{
            background: `radial-gradient(60% 55% at 22% 18%, rgba(74,108,245,.30), transparent 60%),
              radial-gradient(55% 50% at 82% 26%, rgba(74,168,255,.22), transparent 62%),
              radial-gradient(70% 60% at 50% 108%, rgba(34,211,238,.16), transparent 60%), #060608`,
            filter: "saturate(115%)",
          }}
        >
          <div
            className="absolute -inset-[20%]"
            style={{
              background:
                "radial-gradient(40% 40% at 50% 40%, rgba(74,108,245,.10), transparent 70%)",
              animation: "drift 14s ease-in-out infinite alternate",
            }}
          />
        </div>
      )}

      <form
        onSubmit={submit}
        className={`relative w-full max-w-[392px] rounded-none border px-8 pt-9 pb-7 ${
          mono
            ? "border-line bg-ground shadow-[0_1px_2px_rgba(0,0,0,.05),0_16px_48px_-24px_rgba(0,0,0,.25)]"
            : "border-line bg-[rgba(20,20,26,.72)] shadow-[0_1px_0_rgba(255,255,255,.05)_inset,0_30px_80px_-20px_rgba(0,0,0,.7)] backdrop-blur-[22px]"
        }`}
        style={{ animation: "rise .6s cubic-bezier(.2,.8,.2,1) both" }}
      >
        <div className="mb-1 text-center font-pixel text-[12px] tracking-tight text-mut">
          {brandName}
        </div>
        <h1 className="font-pixel text-center text-[22px] leading-tight tracking-[0.01em]">
          Open your brain
        </h1>
        <p className="mt-2 mb-6 text-center text-[13.5px] leading-relaxed text-mut">
          Paste your access token to browse everything your company knows.
        </p>

        {error && (
          <div className="mb-3.5 flex items-center gap-2 rounded-none border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive">
            <span aria-hidden>⚠</span>
            <span>{error}</span>
          </div>
        )}

        <Label htmlFor="tok" className="mb-1.5 text-xs text-mut">
          Access token
        </Label>
        <Input
          id="tok"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="brain_sk_…"
          autoComplete="off"
          autoFocus
          required
          spellCheck={false}
          className="h-11 rounded-none bg-panel2 font-mono tracking-wide placeholder:font-sans"
        />

        <Button
          type="submit"
          disabled={busy}
          className="btn-primary mt-4 h-11 w-full rounded-none border-0 text-[14.5px] font-[650]"
        >
          {busy ? "Signing in…" : "Sign in →"}
        </Button>
      </form>
    </div>
  );
}
