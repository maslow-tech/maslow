import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QuickCreate, isTypingTarget } from "./QuickCreate";
import { api, type CreateObjectInput } from "../lib/api";

/**
 * What these pin is the CREATE contract, not the widgets: one user intent is
 * one idempotency key reused across retries (so a lost response can never
 * become a duplicate object), a changed intent is a new key, and a note goes
 * to the box as an untyped object.
 */

// cmdk scrolls the selected item into view on mount; jsdom has no layout and
// therefore no scrollIntoView. Stubbed here rather than in the shared setup so
// this file owns its own environment need.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const types = [
  {
    id: 1,
    name: "person",
    label: "People",
    description: null,
    icon: "",
    deprecated: false,
    count: 3,
    properties: [],
  },
  {
    id: 2,
    name: "old_thing",
    label: null,
    description: null,
    icon: "",
    deprecated: true,
    count: 0,
    properties: [],
  },
];

function setup(create: (i: CreateObjectInput) => Promise<{ id: string; version: number }>) {
  vi.spyOn(api, "types").mockResolvedValue(types);
  const spy = vi.spyOn(api, "createObject").mockImplementation(create);
  const onCreated = vi.fn();
  render(<QuickCreate onClose={() => {}} onCreated={onCreated} />);
  return { spy, onCreated };
}

type Spy = { mock: { calls: unknown[][] } };

const calls = (spy: Spy) => spy.mock.calls.map((c) => c[0] as CreateObjectInput);

/** The nth create's payload, or a loud failure if it never happened. */
function nth(spy: Spy, i: number): CreateObjectInput {
  const call = spy.mock.calls[i];
  if (!call) throw new Error(`expected a create #${i}, got ${spy.mock.calls.length}`);
  return call[0] as CreateObjectInput;
}

describe("QuickCreate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("creates a note as an untyped object and hands back the id", async () => {
    const { spy, onCreated } = setup(async () => ({ id: "obj-1", version: 1 }));
    fireEvent.click(await screen.findByText("Note"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  Standup  " } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("obj-1"));
    const input = nth(spy, 0);
    expect(input.type).toBeUndefined();
    expect(input.title).toBe("Standup");
    expect(input.idempotencyKey).toBeTruthy();
  });

  it("offers live types but not deprecated ones, and sends the type name", async () => {
    const { spy, onCreated } = setup(async () => ({ id: "p-9", version: 1 }));
    fireEvent.click(await screen.findByText("People"));
    expect(screen.queryByText("Old Thing")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("p-9"));
    expect(nth(spy, 0).type).toBe("person");
  });

  it("omits an empty title rather than sending one", async () => {
    const { spy, onCreated } = setup(async () => ({ id: "obj-2", version: 1 }));
    fireEvent.click(await screen.findByText("Note"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("obj-2"));
    expect(nth(spy, 0).title).toBeUndefined();
  });

  it("reuses ONE idempotency key across retries of the same intent", async () => {
    let attempt = 0;
    const { spy, onCreated } = setup(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network died");
      return { id: "obj-3", version: 1 };
    });
    fireEvent.click(await screen.findByText("Note"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retry me" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("obj-3"));
    expect(calls(spy)).toHaveLength(2);
    expect(nth(spy, 0).idempotencyKey).toBe(nth(spy, 1).idempotencyKey);
  });

  it("mints a FRESH key when the intent changes after a failure", async () => {
    const { spy } = setup(async () => {
      throw new Error("network died");
    });
    fireEvent.click(await screen.findByText("Note"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(nth(spy, 0).idempotencyKey).not.toBe(nth(spy, 1).idempotencyKey);
  });
});

describe("isTypingTarget", () => {
  it("yields to inputs, textareas and the block editor", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const span = document.createElement("span");
    editor.appendChild(span);
    document.body.append(input, textarea, editor);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(span)).toBe(true);
  });

  it("does not fire on plain page chrome", () => {
    const div = document.createElement("div");
    document.body.append(div);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
