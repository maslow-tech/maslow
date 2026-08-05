import { describe, expect, it } from "vitest";
import type { TypeSummary } from "./api";
import {
  clearAllViewConfigs,
  clearViewConfig,
  defaultConfigFor,
  normalizeConfig,
  parseViewConfigKey,
  purgeForeignViewConfigs,
  readViewConfig,
  toListQuery,
  viewConfigKey,
  writeViewConfig,
  type Filter,
  type ViewConfig,
} from "./viewConfig";

/**
 * Two properties are load-bearing here: the config compiles to the SAME
 * where/sort language the server whitelists (no second filter dialect), and the
 * persisted copy — which can embed a private object's id inside a filter
 * literal — never survives an account change or a stale release's shape.
 */

const A = "acct-aaaa";
const B = "acct-bbbb";

const deal: TypeSummary = {
  id: 1,
  name: "deal",
  label: "Deal",
  description: null,
  icon: "",
  deprecated: false,
  count: 12,
  properties: [
    {
      name: "stage",
      kind: "enum",
      required: false,
      deprecated: false,
      enum_values: ["new", "won"],
    },
    { name: "amount", kind: "decimal", required: false, deprecated: false },
    { name: "close_date", kind: "date", required: false, deprecated: false },
    { name: "owner", kind: "ref", required: false, deprecated: false, ref_type: "person" },
    { name: "watchers", kind: "ref[]", required: false, deprecated: false, ref_type: "person" },
    { name: "legacy_code", kind: "text", required: false, deprecated: true },
    { name: "notes", kind: "text", required: false, deprecated: false },
    { name: "source", kind: "text", required: false, deprecated: false },
    { name: "region", kind: "text", required: false, deprecated: false },
    { name: "score", kind: "int", required: false, deprecated: false },
    { name: "priority", kind: "int", required: false, deprecated: false },
    { name: "archived", kind: "bool", required: false, deprecated: false },
  ],
};

function cfg(over: Partial<ViewConfig> = {}): ViewConfig {
  return { ...defaultConfigFor(deal), ...over };
}

describe("defaultConfigFor", () => {
  it("picks columns, a group-by candidate and a date property", () => {
    const c = defaultConfigFor(deal);

    expect(c.layout).toBe("table");
    expect(c.filters).toEqual([]);
    expect(c.sort).toEqual([{ prop: "updated_at", dir: "desc" }]);
    // low-cardinality enum, and the type's OWN date property
    expect(c.groupBy).toBe("stage");
    expect(c.dateProp).toBe("close_date");
    // refs are links, not cells; deprecated props are gone entirely
    const keys = c.columns.map((col) => col.key);
    expect(keys).not.toContain("owner");
    expect(keys).not.toContain("watchers");
    expect(keys).not.toContain("legacy_code");
    // first six visible, the rest wait in the column menu
    expect(c.columns.filter((col) => col.visible).map((col) => col.key)).toEqual([
      "stage",
      "amount",
      "close_date",
      "notes",
      "source",
      "region",
    ]);
    expect(c.columns.filter((col) => !col.visible).map((col) => col.key)).toEqual([
      "score",
      "priority",
      "archived",
    ]);
  });

  it("falls back to the spine date when the type has no date property, and to null with no type", () => {
    const noDate: TypeSummary = {
      ...deal,
      properties: deal.properties.filter((p) => p.kind !== "date"),
    };
    expect(defaultConfigFor(noDate).dateProp).toBe("updated_at");

    const unknown = defaultConfigFor(null);
    expect(unknown.dateProp).toBeNull();
    expect(unknown.groupBy).toBeNull();
    expect(unknown.columns).toEqual([]);
    expect(unknown.layout).toBe("table");
  });

  it("refuses a high-cardinality enum as a board axis", () => {
    const tagSoup: TypeSummary = {
      ...deal,
      properties: [
        {
          name: "tag",
          kind: "enum",
          required: false,
          deprecated: false,
          enum_values: Array.from({ length: 40 }, (_, i) => `t${i}`),
        },
      ],
    };
    expect(defaultConfigFor(tagSoup).groupBy).toBeNull();
  });
});

describe("toListQuery", () => {
  const q = (filters: Filter[]) => toListQuery(cfg({ filters, sort: [] })).where;

  it("emits nothing for an empty config", () => {
    expect(toListQuery(cfg({ filters: [], sort: [] }))).toEqual({});
  });

  it("emits a bare leaf for one filter and an `and` for several", () => {
    expect(q([{ prop: "stage", op: "eq", value: "won" }])).toEqual({
      field: "stage",
      op: "eq",
      value: "won",
    });
    expect(
      q([
        { prop: "stage", op: "eq", value: "won" },
        { prop: "amount", op: "gt", value: 100 },
      ]),
    ).toEqual({
      and: [
        { field: "stage", op: "eq", value: "won" },
        { field: "amount", op: "gt", value: 100 },
      ],
    });
  });

  it("compiles every operator the server accepts", () => {
    expect(q([{ prop: "stage", op: "eq", value: "won" }])).toMatchObject({
      op: "eq",
      value: "won",
    });
    expect(q([{ prop: "stage", op: "ne", value: "won" }])).toMatchObject({
      op: "ne",
      value: "won",
    });
    expect(q([{ prop: "amount", op: "lt", value: 5 }])).toMatchObject({ op: "lt", value: 5 });
    expect(q([{ prop: "amount", op: "lte", value: 5 }])).toMatchObject({ op: "lte", value: 5 });
    expect(q([{ prop: "amount", op: "gt", value: 5 }])).toMatchObject({ op: "gt", value: 5 });
    expect(q([{ prop: "amount", op: "gte", value: 5 }])).toMatchObject({ op: "gte", value: 5 });
    expect(q([{ prop: "archived", op: "eq", value: false }])).toMatchObject({ value: false });
    expect(q([{ prop: "stage", op: "in", value: ["won", "new"] }])).toMatchObject({
      op: "in",
      value: ["won", "new"],
    });
    expect(q([{ prop: "close_date", op: "is_null" }])).toEqual({
      field: "close_date",
      op: "is_null",
    });
    expect(q([{ prop: "close_date", op: "is_not_null" }])).toEqual({
      field: "close_date",
      op: "is_not_null",
    });
  });

  it("wraps like/ilike in wildcards unless the value already carries one", () => {
    expect(q([{ prop: "notes", op: "ilike", value: "acme" }])).toEqual({
      field: "notes",
      op: "ilike",
      value: "%acme%",
    });
    expect(q([{ prop: "notes", op: "like", value: "acme" }])).toMatchObject({ value: "%acme%" });
    // an explicit pattern is the user's own — don't double-wrap it
    expect(q([{ prop: "notes", op: "ilike", value: "acme%" }])).toMatchObject({ value: "acme%" });
    // underscores are data (`in_progress`), not single-char wildcards
    expect(q([{ prop: "notes", op: "ilike", value: "in_progress" }])).toMatchObject({
      value: "%in_progress%",
    });
  });

  it("sends only the first sort entry, in the server's SortSpec shape", () => {
    const out = toListQuery(
      cfg({
        sort: [
          { prop: "close_date", dir: "asc" },
          { prop: "amount", dir: "desc" },
        ],
      }),
    );
    expect(out.sort).toEqual({ field: "close_date", dir: "asc" });
  });

  it("sends no sort at all when the config has none", () => {
    expect(toListQuery(cfg({ sort: [] })).sort).toBeUndefined();
  });
});

describe("persistence", () => {
  it("round-trips a config through localStorage", () => {
    const saved = cfg({
      layout: "board",
      filters: [{ prop: "stage", op: "in", value: ["won", "new"] }],
      sort: [{ prop: "amount", dir: "asc" }],
      groupBy: "stage",
      columns: [
        { key: "stage", visible: true, width: 180 },
        { key: "amount", visible: false },
      ],
    });
    writeViewConfig(A, "deal", saved);

    expect(readViewConfig(A, "deal", defaultConfigFor(deal))).toEqual(saved);
    expect(localStorage.getItem(viewConfigKey(A, "deal"))).toContain("board");
  });

  it("keeps configs separate per type and returns the fallback for an unsaved one", () => {
    writeViewConfig(A, "deal", cfg({ layout: "gallery" }));

    expect(readViewConfig(A, "deal", defaultConfigFor(deal)).layout).toBe("gallery");
    expect(readViewConfig(A, "person", defaultConfigFor(deal))).toEqual(defaultConfigFor(deal));
  });

  it("resets one type and clears everything on logout", () => {
    writeViewConfig(A, "deal", cfg({ layout: "board" }));
    writeViewConfig(A, "task", cfg({ layout: "calendar" }));
    localStorage.setItem("brain-theme", "dark");

    clearViewConfig(A, "deal");
    expect(readViewConfig(A, "deal", defaultConfigFor(deal)).layout).toBe("table");

    expect(clearAllViewConfigs()).toBe(1);
    expect(localStorage.getItem(viewConfigKey(A, "task"))).toBeNull();
    // unrelated app state is untouched
    expect(localStorage.getItem("brain-theme")).toBe("dark");
  });

  it("parses its own keys and ignores anything else", () => {
    expect(parseViewConfigKey(viewConfigKey(A, "deal"))).toEqual({
      accountId: A,
      typeName: "deal",
    });
    expect(parseViewConfigKey("brain.draft.acct.obj")).toBeNull();
    expect(parseViewConfigKey("brain.view.nodots")).toBeNull();
  });
});

describe("account mismatch", () => {
  it("purges another member's saved views when a second account signs in", () => {
    // a filter literal can name a private object — this is content, not a preference
    writeViewConfig(
      A,
      "deal",
      cfg({ filters: [{ prop: "id", op: "eq", value: "private-obj-1" }] }),
    );
    writeViewConfig(A, "task", cfg({ layout: "board" }));
    writeViewConfig(B, "deal", cfg({ layout: "gallery" }));

    expect(purgeForeignViewConfigs(B)).toBe(2);
    expect(localStorage.getItem(viewConfigKey(A, "deal"))).toBeNull();
    expect(localStorage.getItem(viewConfigKey(A, "task"))).toBeNull();
    expect(readViewConfig(B, "deal", defaultConfigFor(deal)).layout).toBe("gallery");
  });

  it("wipes everything when the current account is unknown", () => {
    writeViewConfig(A, "deal", cfg());
    writeViewConfig(B, "deal", cfg());

    expect(purgeForeignViewConfigs("")).toBe(2);
    expect(localStorage.length).toBe(0);
  });

  it("purges on read, so a foreign config never reaches a render", () => {
    writeViewConfig(A, "deal", cfg({ layout: "board" }));

    const asB = readViewConfig(B, "deal", defaultConfigFor(deal));
    expect(asB).toEqual(defaultConfigFor(deal));
    expect(localStorage.getItem(viewConfigKey(A, "deal"))).toBeNull();
  });

  it("never writes or reads without an account id", () => {
    writeViewConfig("", "deal", cfg({ layout: "board" }));
    expect(localStorage.length).toBe(0);
    expect(readViewConfig("", "deal", defaultConfigFor(deal))).toEqual(defaultConfigFor(deal));
  });
});

describe("migration of older / unknown stored shapes", () => {
  const fallback = defaultConfigFor(deal);

  it("falls back to defaults for a shape from an older release", () => {
    // what the pre-phase-3 TypeView would have stored, if it had stored anything
    localStorage.setItem(
      viewConfigKey(A, "deal"),
      JSON.stringify({ view: "list", conds: [{ field: "stage", op: "eq", value: "won" }] }),
    );

    expect(readViewConfig(A, "deal", fallback)).toEqual(fallback);
  });

  it("survives corrupt JSON and drops it", () => {
    localStorage.setItem(viewConfigKey(A, "deal"), "{not json");

    expect(readViewConfig(A, "deal", fallback)).toEqual(fallback);
    expect(localStorage.getItem(viewConfigKey(A, "deal"))).toBeNull();
  });

  it("keeps the valid parts of a partly broken config", () => {
    localStorage.setItem(
      viewConfigKey(A, "deal"),
      JSON.stringify({
        layout: "kanban", // not a layout we ship
        filters: [
          { prop: "stage", op: "eq", value: "won" },
          { prop: "stage", op: "regex", value: "w.*" }, // op the server would reject
          { prop: "amount", op: "in", value: "not-an-array" },
          { op: "eq", value: "no prop" },
          "nonsense",
        ],
        sort: [{ prop: "amount", dir: "sideways" }, { dir: "asc" }],
        groupBy: 42,
        dateProp: null,
        columns: [
          { key: "stage", width: "wide" },
          { key: "amount", visible: false, width: 120 },
          { visible: true },
        ],
      }),
    );

    const c = readViewConfig(A, "deal", fallback);
    expect(c.layout).toBe("table");
    expect(c.filters).toEqual([{ prop: "stage", op: "eq", value: "won" }]);
    expect(c.sort).toEqual([{ prop: "amount", dir: "asc" }]);
    expect(c.groupBy).toBe(fallback.groupBy);
    expect(c.dateProp).toBeNull();
    expect(c.columns).toEqual([
      { key: "stage", visible: true },
      { key: "amount", visible: false, width: 120 },
    ]);
    // and it still compiles to a query the server would accept
    expect(toListQuery(c)).toEqual({
      where: { field: "stage", op: "eq", value: "won" },
      sort: { field: "amount", dir: "asc" },
    });
  });

  it("normalizes non-objects without throwing", () => {
    expect(normalizeConfig(null, fallback)).toEqual(fallback);
    expect(normalizeConfig("board", fallback)).toEqual(fallback);
    expect(normalizeConfig([1, 2, 3], fallback)).toEqual(fallback);
    expect(normalizeConfig(7, fallback)).toEqual(fallback);
  });
});
