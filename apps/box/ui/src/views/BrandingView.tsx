import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, ApiError, type Branding } from "../lib/api";
import { DEFAULT_BRAND } from "../lib/branding";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ACCEPT = "image/png,image/jpeg,image/svg+xml,image/x-icon,.ico";
/** Keep the data URL under the server's ~256 KB cap with headroom. */
const MAX_BYTES = 180 * 1024;

/**
 * Owner-only white-label controls. Name shows in the sidebar, login screen, and
 * browser tab title; the favicon shows in every browser tab on the box's
 * domain (dashboard, /mcp, /oauth). Both are stored server-side (box_kv) and
 * served to everyone — this page just sets them.
 */
export function BrandingView({ brand, onChange }: { brand: Branding; onChange: () => void }) {
  const [name, setName] = useState(brand.name ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (body: Parameters<typeof api.setBranding>[0], msg: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.setBranding(body);
      onChange();
      setNotice(msg);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    void run({ name: name.trim() || null }, "Name saved.");
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("Image is too large — pick something under ~180 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => void run({ faviconDataUrl: String(reader.result) }, "Favicon updated.");
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Branding</h1>
        <p className="mt-1 text-[13.5px] text-mut">
          Make this brain look like yours. Shown to everyone on this box.
        </p>
      </header>

      <div className="min-h-0 flex-1 px-8 py-6">
        {notice && (
          <div className="mb-4 flex max-w-[560px] items-center justify-between rounded-none border border-line-soft bg-accent/40 px-3.5 py-2.5 text-[13px]">
            <span>{notice}</span>
            <button
              className="ml-3 text-[12px] underline opacity-70"
              onClick={() => setNotice(null)}
            >
              dismiss
            </button>
          </div>
        )}
        {error && (
          <div className="mb-4 flex max-w-[560px] items-center justify-between rounded-none border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
            <span>{error}</span>
            <button
              className="ml-3 text-[12px] underline opacity-70"
              onClick={() => setError(null)}
            >
              dismiss
            </button>
          </div>
        )}

        <div className="flex max-w-[560px] flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-[14px]">Display name</CardTitle>
              <CardDescription>
                Appears in the sidebar, on the login screen, and in the browser tab. Blank falls
                back to “{DEFAULT_BRAND}”.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveName} className="flex items-end gap-2.5">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="brand-name" className="text-[12px]">
                    Company name
                  </Label>
                  <Input
                    id="brand-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={DEFAULT_BRAND}
                    maxLength={200}
                  />
                </div>
                <Button type="submit" size="sm" className="h-9" disabled={busy}>
                  Save
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-[14px]">Favicon</CardTitle>
              <CardDescription>
                The tab icon shown across the dashboard, the MCP URL, and the sign-in pages. PNG,
                SVG, ICO, or JPEG, up to ~180 KB.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-none border border-line-soft bg-panel">
                  {brand.hasFavicon ? (
                    <img
                      src={`/favicon.ico?v=${Date.now()}`}
                      alt="Current favicon"
                      className="h-8 w-8 object-contain"
                    />
                  ) : (
                    <span className="text-[11px] text-dim">none</span>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPT}
                  onChange={onFile}
                  className="hidden"
                  aria-label="Upload favicon"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  Upload image
                </Button>
                {brand.hasFavicon && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run({ faviconDataUrl: null }, "Favicon removed.")}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
