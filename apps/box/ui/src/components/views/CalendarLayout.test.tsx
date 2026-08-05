import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CalendarLayout,
  addDays,
  daysBetween,
  initialAnchor,
  monthGridDays,
  parseStoredDate,
  rangeLabel,
  storedDayKey,
  timeLabel,
  weekGridDays,
  weekdayOf,
  withDay,
} from "./CalendarLayout";
import { applyFields, type LayoutProps, type PatchFields } from "../../views/TypeView";
import type { ListItem, PropDef } from "../../lib/api";
import type { ViewConfig } from "../../lib/viewConfig";

/**
 * What these pin:
 *
 *  1. **A date-only value never shifts a day.** Every placement and every
 *     rewrite of `2026-07-21` is string work — no `new Date()` anywhere on that
 *     path — so the layout behaves identically in Auckland and in Honolulu. The
 *     instant forms keep their time-of-day and their offset text verbatim.
 *  2. **A drag is ONE patch of ONE property**, CAS'd against the row's own
 *     version, in the representation the value already had.
 *  3. **The optimistic chip is explicitly reverted.** When the write does not
 *     land, the chip is back in its old cell on the next render and the member
 *     is told — the layout never keeps a private copy of where it wishes the
 *     object were.
 *  4. **Keyboard can do everything the mouse can**, and the affordances vanish
 *     for a viewer and for a spine date the box owns.
 */

const prop = (over: Partial<PropDef> & { name: string; kind: string }): PropDef => ({
  required: false,
  deprecated: false,
  ...over,
});

const propDefs: PropDef[] = [
  prop({ name: "due", kind: "date" }),
  prop({ name: "status", kind: "enum", enum_values: ["open", "done"] }),
];

const config = (over: Partial<ViewConfig> = {}): ViewConfig => ({
  layout: "calendar",
  filters: [],
  sort: [{ prop: "updated_at", dir: "desc" }],
  groupBy: null,
  dateProp: "due",
  columns: [],
  ...over,
});

const row = (over: Partial<ListItem> & { id: string }): ListItem => ({
  title: "Row",
  version: 3,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  visibility: "org",
  props: {},
  ...over,
});

/**
 * Every fixture row sits in July 2026, so `initialAnchor` opens on July 2026
 * whatever today happens to be (today's month if we are in it, the earliest
 * loaded row's month otherwise — both are July 2026 here). No clock faking, and
 * therefore no fake-timer interaction with `waitFor`.
 */
const kickoff = row({ id: "o1", title: "Kickoff", props: { due: "2026-07-21" } });
const review = row({ id: "o2", title: "Review", props: { due: "2026-07-21" } });
const loose = row({ id: "o3", title: "Loose end", props: {} });

function props(over: Partial<LayoutProps> = {}): LayoutProps {
  return {
    rows: [kickoff],
    propDefs,
    config: config(),
    onConfigChange: vi.fn(),
    onPatch: vi.fn().mockResolvedValue(undefined),
    onOpen: vi.fn(),
    readOnly: false,
    ...over,
  };
}

function dataTransfer() {
  const bag: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => {
      bag[k] = v;
    },
    getData: (k: string) => bag[k] ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

function cell(container: HTMLElement, day: string): HTMLElement {
  const el = container.querySelector(`[data-day="${day}"]`);
  if (!el) throw new Error(`no cell for ${day}`);
  return el as HTMLElement;
}

function chip(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

function dragChipTo(container: HTMLElement, name: RegExp, day: string | null) {
  const dt = dataTransfer();
  fireEvent.dragStart(chip(name), { dataTransfer: dt });
  const target =
    day === null
      ? (container.querySelector('[data-tray="unscheduled"]') as HTMLElement)
      : cell(container, day);
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
}

/**
 * The shell in miniature: it owns the rows, folds a successful patch in exactly
 * as `TypeView` does, and can be told to refuse — which is what a terminal
 * conflict looks like from a layout's side (the promise still resolves; `rows`
 * simply does not agree with what we asked for).
 */
function Harness({
  initial,
  refuse = false,
  onCall,
  ...rest
}: {
  initial: ListItem[];
  refuse?: boolean;
  onCall?: (id: string, baseVersion: number, fields: PatchFields) => void;
} & Partial<LayoutProps>) {
  const [rows, setRows] = useState(initial);
  return (
    <CalendarLayout
      {...props({ rows })}
      {...rest}
      rows={rows}
      onPatch={async (id, baseVersion, fields) => {
        onCall?.(id, baseVersion, fields);
        await Promise.resolve();
        if (refuse) return;
        setRows((prev) =>
          prev.map((r) => (r.id === id ? applyFields(r, fields, baseVersion + 1) : r)),
        );
      }}
    />
  );
}

describe("stored date representations", () => {
  it("reads each form without converting it", () => {
    expect(parseStoredDate("2026-07-21")).toEqual({ form: "date", day: "2026-07-21" });
    expect(parseStoredDate("2026-07-21T09:30")).toEqual({
      form: "naive",
      day: "2026-07-21",
      time: "09:30",
    });
    expect(parseStoredDate("2026-07-21T09:30:00Z")).toEqual({
      form: "zoned",
      day: "2026-07-21",
      time: "09:30:00",
      zone: "Z",
    });
    // Postgres' own text output, space-separated and half-offset.
    expect(parseStoredDate("2026-07-21 09:30:00+05:30")).toEqual({
      form: "zoned",
      day: "2026-07-21",
      time: "09:30:00",
      zone: "+05:30",
    });
  });

  it("treats anything it cannot place as unscheduled rather than guessing", () => {
    for (const bad of [null, undefined, 42, "", "someday", "2026-02-31", "next tuesday"]) {
      expect(parseStoredDate(bad)).toBeNull();
    }
  });

  it("places a date-only value on its own day, in any timezone", () => {
    // No Date is constructed on this path, so there is nothing for an offset to
    // move: the placement IS the string.
    expect(storedDayKey({ form: "date", day: "2026-07-21" })).toBe("2026-07-21");
    expect(storedDayKey({ form: "naive", day: "2026-01-01", time: "00:30" })).toBe("2026-01-01");
  });

  it("places a real instant on the viewer's local day", () => {
    const s = parseStoredDate("2026-07-21T12:00:00Z");
    expect(s).not.toBeNull();
    const iso = new Date("2026-07-21T12:00:00Z");
    const expected = `${iso.getFullYear()}-${String(iso.getMonth() + 1).padStart(2, "0")}-${String(
      iso.getDate(),
    ).padStart(2, "0")}`;
    expect(storedDayKey(s!)).toBe(expected);
  });

  it("rewrites in the same shape it read", () => {
    expect(withDay({ form: "date", day: "2026-07-21" }, "2026-07-23", "date")).toBe("2026-07-23");
    // A wall clock keeps its wall clock.
    expect(
      withDay({ form: "naive", day: "2026-07-21", time: "09:30" }, "2026-07-23", "timestamp"),
    ).toBe("2026-07-23T09:30");
    // An instant shifts by whole days: time-of-day AND offset text survive.
    const zoned = parseStoredDate("2026-07-21T09:00:00Z")!;
    const moved = withDay(zoned, addDays(storedDayKey(zoned), 2), "timestamp");
    expect(moved).toBe("2026-07-23T09:00:00Z");
    const half = parseStoredDate("2026-07-21T09:00:00+05:30")!;
    expect(withDay(half, addDays(storedDayKey(half), 1), "timestamp")).toMatch(/\+05:30$/);
  });

  it("invents a value only when there is none, and never one that can flip a day", () => {
    expect(withDay(null, "2026-07-23", "date")).toBe("2026-07-23");
    const iso = withDay(null, "2026-07-23", "timestamp");
    // Local noon, expressed as an instant: whatever the offset, it is still the
    // 23rd for the member who dropped it.
    const back = new Date(iso);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(6);
    expect(back.getDate()).toBe(23);
  });

  it("captions a wall clock verbatim and an instant in local time", () => {
    expect(timeLabel({ form: "date", day: "2026-07-21" })).toBeNull();
    expect(timeLabel({ form: "naive", day: "2026-07-21", time: "09:30:00" })).toBe("09:30");
    expect(timeLabel(parseStoredDate("2026-07-21T09:00:00Z"))).toMatch(/\d/);
  });
});

describe("grid arithmetic", () => {
  it("steps days across month, year and DST boundaries", () => {
    expect(addDays("2026-07-21", 2)).toBe("2026-07-23");
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    // US DST forward (2026-03-08) and back (2026-11-01): a local-time step
    // would land on the same day or skip one.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-11-01", "2026-10-31")).toBe(-1);
  });

  it("covers the month in whole Sunday-first weeks", () => {
    const july = monthGridDays("2026-07-15");
    expect(july.length % 7).toBe(0);
    expect(weekdayOf(july[0]!)).toBe(0);
    expect(weekdayOf(july[july.length - 1]!)).toBe(6);
    expect(july).toContain("2026-07-01");
    expect(july).toContain("2026-07-31");
    // February 2026 starts on a Sunday and has 28 days — exactly four weeks.
    expect(monthGridDays("2026-02-10")).toHaveLength(28);
  });

  it("gives a week seven days starting Sunday", () => {
    const w = weekGridDays("2026-07-22");
    expect(w).toHaveLength(7);
    expect(w[0]).toBe("2026-07-19");
    expect(w[6]).toBe("2026-07-25");
  });

  it("labels the range from the day key itself, never a day earlier", () => {
    expect(rangeLabel("2026-07-01", "month")).toMatch(/2026/);
    expect(rangeLabel("2026-07-01", "month")).toMatch(/July|Jul/);
  });

  it("opens on the month that actually holds rows", () => {
    expect(initialAnchor([row({ id: "x", props: { due: "2029-03-04" } })], "due")).toBe(
      "2029-03-04",
    );
    expect(initialAnchor([], "due")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("placement", () => {
  it("puts each object in its own day cell", () => {
    const { container } = render(<CalendarLayout {...props({ rows: [kickoff, review] })} />);
    const day = cell(container, "2026-07-21");
    expect(within(day).getByRole("button", { name: /Kickoff/ })).toBeTruthy();
    expect(within(day).getByRole("button", { name: /Review/ })).toBeTruthy();
    expect(within(cell(container, "2026-07-22")).queryByRole("button")).toBeNull();
  });

  it("collapses a crowded day behind +N and expands it on demand", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      row({ id: `m${i}`, title: `Task ${i}`, props: { due: "2026-07-21" } }),
    );
    const { container } = render(<CalendarLayout {...props({ rows: many })} />);
    const day = cell(container, "2026-07-21");
    expect(within(day).getAllByRole("button", { name: /Task/ })).toHaveLength(3);
    fireEvent.click(within(day).getByText("+3 more"));
    expect(within(day).getAllByRole("button", { name: /Task/ })).toHaveLength(6);
  });

  it("keeps objects with no date in the Unscheduled tray", () => {
    const { container } = render(<CalendarLayout {...props({ rows: [kickoff, loose] })} />);
    const tray = container.querySelector('[data-tray="unscheduled"]') as HTMLElement;
    expect(within(tray).getByRole("button", { name: /Loose end/ })).toBeTruthy();
    expect(
      within(cell(container, "2026-07-21")).getByRole("button", { name: /Kickoff/ }),
    ).toBeTruthy();
  });

  it("says how many rows fall outside the window instead of hiding them silently", () => {
    const far = row({ id: "far", title: "Far", props: { due: "2027-01-04" } });
    render(<CalendarLayout {...props({ rows: [kickoff, far] })} />);
    expect(screen.getByText(/1 object falls outside this/)).toBeTruthy();
  });
});

describe("rescheduling", () => {
  it("writes one patch of one property, CAS'd on the row's own version", async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<CalendarLayout {...props({ rows: [kickoff], onPatch })} />);
    dragChipTo(container, /Kickoff/, "2026-07-23");
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch).toHaveBeenCalledWith("o1", 3, { props: { due: "2026-07-23" } });
  });

  it("does not write when the chip is dropped back on its own day", async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<CalendarLayout {...props({ rows: [kickoff], onPatch })} />);
    dragChipTo(container, /Kickoff/, "2026-07-21");
    await Promise.resolve();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("moves the chip and keeps it there when the write lands", async () => {
    const calls: PatchFields[] = [];
    const { container } = render(
      <Harness initial={[kickoff]} onCall={(_id, _v, f) => calls.push(f)} />,
    );
    dragChipTo(container, /Kickoff/, "2026-07-24");
    await waitFor(() =>
      expect(
        within(cell(container, "2026-07-24")).queryByRole("button", { name: /Kickoff/ }),
      ).toBeTruthy(),
    );
    expect(
      within(cell(container, "2026-07-21")).queryByRole("button", { name: /Kickoff/ }),
    ).toBeNull();
    expect(calls).toEqual([{ props: { due: "2026-07-24" } }]);
  });

  it("explicitly reverts the chip when the write does not land, and says so", async () => {
    const { container } = render(<Harness initial={[kickoff]} refuse />);
    dragChipTo(container, /Kickoff/, "2026-07-24");
    await waitFor(() => expect(screen.getByText(/didn.t stick/)).toBeTruthy());
    // The optimistic override is gone: `rows` is the truth again.
    expect(
      within(cell(container, "2026-07-21")).getByRole("button", { name: /Kickoff/ }),
    ).toBeTruthy();
    expect(
      within(cell(container, "2026-07-24")).queryByRole("button", { name: /Kickoff/ }),
    ).toBeNull();
  });

  it("schedules an object dragged out of the tray, and unschedules one dropped into it", async () => {
    const calls: PatchFields[] = [];
    // `kickoff` rides along only to anchor the view on July 2026 — the tray
    // drag itself must not depend on what today happens to be.
    const { container } = render(
      <Harness initial={[kickoff, loose]} onCall={(_id, _v, f) => calls.push(f)} />,
    );
    dragChipTo(container, /Loose end/, "2026-07-23");
    await waitFor(() =>
      expect(
        within(cell(container, "2026-07-23")).queryByRole("button", { name: /Loose end/ }),
      ).toBeTruthy(),
    );
    dragChipTo(container, /Loose end/, null);
    await waitFor(() => expect(calls).toHaveLength(2));
    // `null` inside `props` deletes the key — the shell's documented erase.
    expect(calls[0]).toEqual({ props: { due: "2026-07-23" } });
    expect(calls[1]).toEqual({ props: { due: null } });
  });

  it("refuses to unschedule a required property rather than letting the server do it", async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const required = [prop({ name: "due", kind: "date", required: true })];
    const { container } = render(
      <CalendarLayout {...props({ rows: [kickoff], onPatch, propDefs: required })} />,
    );
    expect(container.querySelector('[data-tray="unscheduled"]')).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });
});

describe("keyboard", () => {
  it("moves a chip with M, arrows and Enter", async () => {
    const calls: PatchFields[] = [];
    const { container } = render(
      <Harness initial={[kickoff]} onCall={(_id, _v, f) => calls.push(f)} />,
    );
    const c = chip(/Kickoff/);
    c.focus();
    fireEvent.keyDown(c, { key: "m" });
    fireEvent.keyDown(c, { key: "ArrowRight" });
    fireEvent.keyDown(c, { key: "ArrowDown" });
    fireEvent.keyDown(c, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    // +1 day, then +7.
    expect(calls[0]).toEqual({ props: { due: "2026-07-29" } });
    await waitFor(() =>
      expect(
        within(cell(container, "2026-07-29")).queryByRole("button", { name: /Kickoff/ }),
      ).toBeTruthy(),
    );
  });

  it("writes nothing when the move is cancelled", async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(<CalendarLayout {...props({ rows: [kickoff], onPatch })} />);
    const c = chip(/Kickoff/);
    c.focus();
    fireEvent.keyDown(c, { key: "m" });
    fireEvent.keyDown(c, { key: "ArrowRight" });
    fireEvent.keyDown(c, { key: "Escape" });
    fireEvent.keyDown(c, { key: "Enter" });
    await Promise.resolve();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("unschedules with U", async () => {
    const calls: PatchFields[] = [];
    render(<Harness initial={[kickoff]} onCall={(_id, _v, f) => calls.push(f)} />);
    const c = chip(/Kickoff/);
    c.focus();
    fireEvent.keyDown(c, { key: "m" });
    fireEvent.keyDown(c, { key: "u" });
    await waitFor(() => expect(calls).toEqual([{ props: { due: null } }]));
  });
});

describe("affordances that must disappear", () => {
  it("gives a viewer no way to move anything", () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <CalendarLayout {...props({ rows: [kickoff], onPatch, readOnly: true })} />,
    );
    const c = chip(/Kickoff/);
    expect(c.getAttribute("draggable")).not.toBe("true");
    c.focus();
    fireEvent.keyDown(c, { key: "m" });
    fireEvent.keyDown(c, { key: "Enter" });
    expect(onPatch).not.toHaveBeenCalled();
    expect(container.querySelector('[data-tray="unscheduled"]')).toBeNull();
    expect(screen.getByText(/read-only access/)).toBeTruthy();
  });

  it("will not pretend a spine date can be rescheduled", async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const spineRow = row({ id: "s1", title: "Touched", updated_at: "2026-07-21T10:00:00Z" });
    const { container } = render(
      <CalendarLayout
        {...props({ rows: [spineRow], onPatch, config: config({ dateProp: "updated_at" }) })}
      />,
    );
    expect(screen.getByText(/set by the box/)).toBeTruthy();
    dragChipTo(container, /Touched/, "2026-07-24");
    await Promise.resolve();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("explains a date property that no longer exists instead of blanking", () => {
    const { container } = render(
      <CalendarLayout {...props({ rows: [kickoff], config: config({ dateProp: "gone" }) })} />,
    );
    expect(screen.getByText(/no longer has/)).toBeTruthy();
    // Everything reads as unscheduled — nothing is silently dropped.
    const tray = container.querySelector('[data-tray="unscheduled"]') as HTMLElement;
    expect(within(tray).getByRole("button", { name: /Kickoff/ })).toBeTruthy();
  });

  it("opens an object on a plain click", () => {
    const onOpen = vi.fn();
    render(<CalendarLayout {...props({ rows: [kickoff], onOpen })} />);
    fireEvent.click(chip(/Kickoff/));
    expect(onOpen).toHaveBeenCalledWith("o1");
  });
});
