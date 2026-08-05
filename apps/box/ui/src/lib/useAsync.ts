import { useCallback, useEffect, useRef, useState } from "react";
import { shouldSurface, errorMessage } from "./api";

/**
 * useAsync — the ONE read-path loader for primary content
 * that today renders <Spinner/> forever on a rejected fetch. Returns
 * {data,error,loading,reload}: a rejection becomes a retryable error (via
 * <LoadError onRetry={reload}/>) instead of an infinite skeleton.
 *
 * Hardened against the four read-path traps (the pure logic — shouldSurface /
 * errorMessage — is unit-tested in useAsync.test.ts):
 *  - a 401 is swallowed (api.ts already flips the app to Login);
 *  - errors during a version-skew forced reload are suppressed;
 *  - retry is MANUAL (no auto-retry loop against a reloading page);
 *  - a latest-call token + mounted ref drop resolutions from superseded deps
 *    (e.g. ObjectView switching ids rapidly) so a stale response can't overwrite
 *    a newer one or set state after unmount.
 */
interface AsyncState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const mounted = useRef(true);
  const callId = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const id = ++callId.current;
    setLoading(true);
    setError(null);
    fn().then(
      (result) => {
        // Drop a superseded/unmounted resolution — only the latest call wins.
        if (!mounted.current || id !== callId.current) return;
        setData(result);
        setLoading(false);
      },
      (err: unknown) => {
        if (!mounted.current || id !== callId.current) return;
        setLoading(false);
        if (shouldSurface(err)) setError(errorMessage(err));
        // else: 401 / abort / mid-reload — leave the app to its own handling.
      },
    );
    // fn is recreated per render by callers; the explicit `deps` + nonce drive
    // re-runs (fn itself is intentionally not a dep — it would loop every render).
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
