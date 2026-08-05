import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarqueeLayer, SelectionBar, type SelectionBarProps } from "./SelectionBar";
import {
  ApiError,
  ConflictError,
  type LinkObjectInput,
  type PatchObjectInput,
} from "../../lib/api";
import { BULK_MAX, type BulkTarget, type BulkWriter } from "../../lib/graph/selection";
import { buildSpatialHash } from "../../lib/graph/renderer";
import type { Whoami } from "../../lib/api";

/**
 * What these pin is the bar's CONTRACT, not its pixels:
 *
 *  - a viewer sees the selection and NONE of the mutating actions (a disabled
 *    button advertising an action their account will never have is worse than
 *    no button);
 *  - nothing is written until the confirm step is taken — the bar composes an
 *    intent, says what it is about to do with the count in it, and only then
 *    writes;
 *  - each object gets its own row, and object #2's 409 lands on object #2's
 *    row with its own message and its own retry button;
 *  - the batch reports the PARTIAL result ("1 of 2 written"), never a blanket
 *    success;
 *  - retrying re-runs the same plan, so the successes are not re-written and
 *    the failed row keeps the idempotency key it was minted with.
 */

const member: Whoami = {
  id: "acct-1",
  name: "Alice",
  role: "member",
  scopes: ["read", "write"],
  status: "active",
};

const viewer: Whoami = { ...member, id: "acct-2", role: "viewer", scopes: ["read"] };

const targets: BulkTarget[] = [
  { index: 0, id: "obj-1", title: "Morning Ember", type: "deal" },
  { index: 1, id: "obj-2", title: "Highland Roast", type: "deal" },
];

interface Fake {
  writer: BulkWriter;
  patches: Array<{ id: string; patch: PatchObjectInput }>;
  links: Array<{ id: string; input: LinkObjectInput }>;
}

function fakeWriter(fail: (id: string, attempt: number) => unknown | null = () => null): Fake {
  const attempts = new Map<string, number>();
  const patches: Array<{ id: string; patch: PatchObjectInput }> = [];
  const links: Array<{ id: string; input: LinkObjectInput }> = [];
  const bump = (id: string): number => {
    const n = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, n);
    return n;
  };
  return {
    patches,
    links,
    writer: {
      readVersion: async (id) => (id === "obj-1" ? 4 : 9),
      patch: async (id, patch) => {
        const boom = fail(id, bump(id));
        if (boom) throw boom;
        patches.push({ id, patch });
        return { id, version: patch.baseVersion + 1 };
      },
      link: async (id, input) => {
        const boom = fail(id, bump(id));
        if (boom) throw boom;
        links.push({ id, input });
        return { from: id, rel: input.rel, to: input.to };
      },
    },
  };
}

function mount(over: Partial<SelectionBarProps> = {}) {
  const props: SelectionBarProps = {
    user: member,
    targets,
    onClear: vi.fn(),
    onOpenAll: vi.fn(),
    search: async () => [],
    ...over,
  };
  return { props, ...render(<SelectionBar {...props} />) };
}

/* ------------------------------------------------------------------ */

describe("SelectionBar — the read surface", () => {
  it("renders nothing at all with an empty selection", () => {
    const { container } = mount({ targets: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the selection and names the gesture that built it", () => {
    mount();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByText(/alt-drag to box-select/)).toBeInTheDocument();
  });

  it("opens the whole selection as one peek stack", () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole("button", { name: /open all/i }));
    expect(props.onOpenAll).toHaveBeenCalledWith(["obj-1", "obj-2"]);
  });
});

describe("SelectionBar — a viewer", () => {
  it("sees the selection and opens it, but is offered no write at all", () => {
    mount({ user: viewer });
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open all/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /link all to/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set a property/i })).not.toBeInTheDocument();
  });
});

describe("SelectionBar — set a property", () => {
  it("writes nothing until the confirm step is taken", async () => {
    const fake = fakeWriter();
    mount({ writer: fake.writer });

    fireEvent.click(screen.getByRole("button", { name: /set a property/i }));
    fireEvent.change(screen.getByLabelText("Property"), { target: { value: "status" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: /review 2 writes/i }));

    // The confirm sentence says the count and the change, out loud.
    expect(screen.getByText(/Set “status” to "done" on 2 objects/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is undone automatically/)).toBeInTheDocument();
    expect(fake.patches).toEqual([]);
  });

  it("writes one transaction per object, each against its own baseVersion", async () => {
    const fake = fakeWriter();
    mount({ writer: fake.writer });

    fireEvent.click(screen.getByRole("button", { name: /set a property/i }));
    fireEvent.change(screen.getByLabelText("Property"), { target: { value: "status" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: /review 2 writes/i }));
    fireEvent.click(screen.getByRole("button", { name: /^write 2$/i }));

    await waitFor(() => expect(screen.getByText("2 of 2 written")).toBeInTheDocument());
    expect(fake.patches).toEqual([
      { id: "obj-1", patch: { baseVersion: 4, props: { status: "done" } } },
      { id: "obj-2", patch: { baseVersion: 9, props: { status: "done" } } },
    ]);
  });

  it("clears a key with an explicit null, and hides the value box for it", () => {
    const fake = fakeWriter();
    mount({ writer: fake.writer });
    fireEvent.click(screen.getByRole("button", { name: /set a property/i }));
    fireEvent.change(screen.getByLabelText("Property"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Value is"), { target: { value: "clear" } });
    expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /review 2 writes/i }));
    expect(screen.getByText(/Clear “owner” on 2 objects/)).toBeInTheDocument();
  });

  it("will not review a property name the box would refuse", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /set a property/i }));
    fireEvent.change(screen.getByLabelText("Property"), { target: { value: "2 fast" } });
    expect(screen.getByRole("button", { name: /review 2 writes/i })).toBeDisabled();
  });
});

describe("SelectionBar — per-object failure", () => {
  const openAndWrite = (): void => {
    fireEvent.click(screen.getByRole("button", { name: /set a property/i }));
    fireEvent.change(screen.getByLabelText("Property"), { target: { value: "status" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: /review 2 writes/i }));
    fireEvent.click(screen.getByRole("button", { name: /^write 2$/i }));
  };

  it("puts object #2's 409 on object #2's row and still writes object #1", async () => {
    const fake = fakeWriter((id) =>
      id === "obj-2" ? new ConflictError("conflict", 12, null) : null,
    );
    mount({ writer: fake.writer });
    openAndWrite();

    await waitFor(() =>
      expect(screen.getByTestId("bulk-row-obj-2")).toHaveAttribute("data-state", "conflict"),
    );
    expect(screen.getByTestId("bulk-row-obj-1")).toHaveAttribute("data-state", "done");

    const failed = within(screen.getByTestId("bulk-row-obj-2"));
    expect(failed.getByText(/changed by someone else \(now v12\)/)).toBeInTheDocument();
    expect(failed.getByRole("button", { name: /retry/i })).toBeInTheDocument();

    // Partial success is reported as a count, never as "done".
    expect(screen.getByText("1 of 2 written · 1 changed underneath you")).toBeInTheDocument();
    expect(fake.patches.map((p) => p.id)).toEqual(["obj-1"]);
  });

  it("retries the failed row alone, leaving the row that already landed", async () => {
    let firstPass = true;
    const fake = fakeWriter((id) =>
      id === "obj-2" && firstPass ? new ConflictError("conflict", 12, null) : null,
    );
    mount({ writer: fake.writer });
    openAndWrite();
    await waitFor(() => expect(screen.getByText(/1 of 2 written/)).toBeInTheDocument());

    firstPass = false;
    fireEvent.click(
      within(screen.getByTestId("bulk-row-obj-2")).getByRole("button", { name: /retry/i }),
    );

    await waitFor(() => expect(screen.getByText("2 of 2 written")).toBeInTheDocument());
    // obj-1 was written once and never again.
    expect(fake.patches.map((p) => p.id)).toEqual(["obj-1", "obj-2"]);
  });

  it("offers a retry-all for the failures and nothing else", async () => {
    let firstPass = true;
    const fake = fakeWriter((id) =>
      firstPass && id === "obj-2" ? new ApiError(503, "down") : null,
    );
    mount({ writer: fake.writer });
    openAndWrite();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry 1 failed/i })).toBeInTheDocument(),
    );

    firstPass = false;
    fireEvent.click(screen.getByRole("button", { name: /retry 1 failed/i }));
    await waitFor(() => expect(screen.getByText("2 of 2 written")).toBeInTheDocument());
    expect(fake.patches.map((p) => p.id)).toEqual(["obj-1", "obj-2"]);
  });
});

describe("SelectionBar — link all to…", () => {
  it("picks a target, confirms, and gives every object its own idempotency key", async () => {
    const fake = fakeWriter();
    mount({
      writer: fake.writer,
      search: async () => [{ id: "hub-1", title: "Q3 pipeline", type: "project" }],
    });

    fireEvent.click(screen.getByRole("button", { name: /link all to/i }));
    fireEvent.change(screen.getByLabelText(/link every selected object to/i), {
      target: { value: "pipeline" },
    });
    const hit = await screen.findByRole("button", { name: /q3 pipeline/i });
    fireEvent.click(hit);
    fireEvent.click(screen.getByRole("button", { name: /review 2 links/i }));

    expect(
      screen.getByText(/Link 2 objects to “Q3 pipeline” with the verb “about”/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^write 2$/i }));

    await waitFor(() => expect(screen.getByText("2 of 2 written")).toBeInTheDocument());
    expect(fake.links.map((l) => ({ id: l.id, to: l.input.to, rel: l.input.rel }))).toEqual([
      { id: "obj-1", to: "hub-1", rel: "about" },
      { id: "obj-2", to: "hub-1", rel: "about" },
    ]);
    const keys = fake.links.map((l) => l.input.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    // A link edit has no version to compare against, so nothing was read.
    expect(fake.patches).toEqual([]);
  });

  it("will not review a verb the link route would refuse", async () => {
    mount({ search: async () => [{ id: "hub-1", title: "Q3 pipeline", type: null }] });
    fireEvent.click(screen.getByRole("button", { name: /link all to/i }));
    fireEvent.change(screen.getByLabelText(/link every selected object to/i), {
      target: { value: "pipeline" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /q3 pipeline/i }));
    fireEvent.change(screen.getByLabelText(/with the verb/i), { target: { value: "is about" } });
    expect(screen.getByRole("button", { name: /review 2 links/i })).toBeDisabled();
  });
});

describe("SelectionBar — the cap", () => {
  it("refuses a selection past the bulk limit, and says why", () => {
    const many: BulkTarget[] = Array.from({ length: BULK_MAX + 1 }, (_, i) => ({
      index: i,
      id: `o-${i}`,
      title: `Object ${i}`,
      type: null,
    }));
    mount({ targets: many });
    expect(screen.getByRole("button", { name: /set a property/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /link all to/i })).toBeDisabled();
    expect(screen.getByText(/past the 200-object bulk limit/)).toBeInTheDocument();
    // Reading the selection is still fine.
    expect(screen.getByRole("button", { name: /open all/i })).not.toBeDisabled();
  });
});

describe("SelectionBar — the selection changing under a composed intent", () => {
  it("abandons the confirm step, because its sentence named a count that is now wrong", () => {
    const { rerender } = mount();
    fireEvent.click(screen.getByRole("button", { name: /set a property/i }));
    fireEvent.change(screen.getByLabelText("Property"), { target: { value: "status" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: /review 2 writes/i }));
    expect(screen.getByRole("button", { name: /^write 2$/i })).toBeInTheDocument();

    rerender(
      <SelectionBar
        user={member}
        targets={[targets[0]!]}
        onClear={vi.fn()}
        onOpenAll={vi.fn()}
        search={async () => []}
      />,
    );
    expect(screen.queryByRole("button", { name: /^write/i })).not.toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * the marquee
 * ------------------------------------------------------------------ */

/**
 * jsdom ships no `PointerEvent`, so Testing Library falls back to a plain
 * `Event` and every modifier flag on it is lost — which would make the whole
 * marquee suite pass vacuously. A MouseEvent subclass carries `altKey`,
 * `shiftKey` and the coordinates, which is exactly what the gesture reads.
 */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
if (typeof (window as { PointerEvent?: unknown }).PointerEvent !== "function") {
  (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
}

describe("MarqueeLayer", () => {
  // Four nodes on a line at world x = 0, 100, 200, 300; the fake projection is
  // 1:1, so a screen rect is a world rect.
  const xy = new Float32Array([0, 0, 100, 0, 200, 0, 300, 0]);
  const projection = {
    screenToWorld: (sx: number, sy: number) => ({ x: sx, y: sy }),
    hash: () => buildSpatialHash(xy, 4, 80),
    positions: () => xy,
  };

  function layer(onSelect = vi.fn()) {
    if (typeof Element.prototype.setPointerCapture !== "function") {
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
    }
    render(<MarqueeLayer projection={projection} onSelect={onSelect} />);
    return { el: screen.getByTestId("graph-marquee-layer"), onSelect };
  }

  it("stays out of the way until Alt is held — the camera keeps every other drag", () => {
    const { el } = layer();
    expect(el).toHaveAttribute("data-armed", "false");
    expect(el.style.pointerEvents).toBe("none");

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    expect(el).toHaveAttribute("data-armed", "false");

    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(el).toHaveAttribute("data-armed", "true");
    expect(el.style.pointerEvents).toBe("auto");

    fireEvent.keyUp(window, { key: "Alt", altKey: false });
    expect(el).toHaveAttribute("data-armed", "false");
  });

  it("disarms on blur, so alt-tabbing away never leaves the layer eating the camera", () => {
    const { el } = layer();
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.blur(window);
    expect(el).toHaveAttribute("data-armed", "false");
  });

  it("alt-drag selects exactly the nodes inside the box, replacing the selection", () => {
    const { el, onSelect } = layer();
    fireEvent.pointerDown(el, { clientX: 90, clientY: -10, altKey: true, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 210, clientY: 10, altKey: true, pointerId: 1 });
    expect(screen.getByTestId("graph-marquee-rect")).toBeInTheDocument();
    fireEvent.pointerUp(el, { clientX: 210, clientY: 10, altKey: true, pointerId: 1 });

    expect(onSelect).toHaveBeenCalledWith([1, 2], "replace");
    expect(screen.queryByTestId("graph-marquee-rect")).not.toBeInTheDocument();
  });

  it("alt+shift-drag ADDS to the selection instead of replacing it", () => {
    const { el, onSelect } = layer();
    fireEvent.pointerDown(el, {
      clientX: 90,
      clientY: -10,
      altKey: true,
      shiftKey: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(el, {
      clientX: 210,
      clientY: 10,
      altKey: true,
      shiftKey: true,
      pointerId: 1,
    });
    fireEvent.pointerUp(el, {
      clientX: 210,
      clientY: 10,
      altKey: true,
      shiftKey: true,
      pointerId: 1,
    });
    expect(onSelect).toHaveBeenCalledWith([1, 2], "add");
  });

  it("does not clear the selection when an alt-click merely wobbled", () => {
    const { el, onSelect } = layer();
    fireEvent.pointerDown(el, { clientX: 100, clientY: 0, altKey: true, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 101, clientY: 1, altKey: true, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 101, clientY: 1, altKey: true, pointerId: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores a drag with no modifier at all", () => {
    const { el, onSelect } = layer();
    fireEvent.pointerDown(el, { clientX: 90, clientY: -10, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 210, clientY: 10, pointerId: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
