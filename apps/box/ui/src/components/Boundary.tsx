/**
 * One crashing widget must cost you the widget, not the page.
 *
 * React unmounts the WHOLE tree when a render throws and nothing catches it, so
 * a single component reading a field off a shape it did not expect takes the
 * entire application with it — white screen, no nav, no way back. That is not
 * hypothetical here: a since-removed Home-header widget once read a nested
 * field off an unfixtured demo response, and hosted-demo rendered a blank
 * page on EVERY route for as long as it existed. Nothing above it caught the
 * throw because there was nothing above it at all.
 *
 * An error boundary is the one thing React still has no hook for, so this is
 * the only class component in the SPA — kept deliberately tiny.
 *
 * `fallback` defaults to NOTHING, which is how these surfaces already treat a
 * load they could not complete: a widget that cannot render is a widget that
 * is not there. Pass a node where the hole would otherwise read as a broken
 * page.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface BoundaryProps {
  children: ReactNode;
  /** What to render instead of the crashed subtree. Default: nothing. */
  fallback?: ReactNode;
  /** Names the subtree in the console line — the only place this can be read. */
  label?: string;
}

export class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is where this goes: the box ships no client error sink, and a
    // contained crash must not grow a banner on the surfaces around it.
    console.error(`[${this.props.label ?? "boundary"}]`, error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
