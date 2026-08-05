import { describe, expect, it, vi } from "vitest";
import { ApiError, type FsLock, type FsTrashEntry, type FsVersion } from "./api";
import {
  diffUrls,
  displayPath,
  errText,
  fmtBytes,
  isWritablePath,
  loadDiffPair,
  loadHistory,
  loadLock,
  loadTrash,
  lockHolder,
  locksFromListing,
  reasonLabel,
  restoreAndReload,
  toggleLock,
  tooBigToDiff,
  UNLOCKED,
  VERSION_DIFF_MAX,
} from "./fsversions";

describe("fmtBytes", () => {
  it("keeps small sizes in bytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });
  it("scales to KB/MB/GB with one decimal until 10", () => {
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(15 * 1024)).toBe("15 KB");
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

describe("reasonLabel", () => {
  it("says what the snapshot captured, in human words", () => {
    expect(reasonLabel("overwrite")).toBe("before an edit");
    expect(reasonLabel("delete")).toBe("before a delete");
  });
  it("passes an unknown reason through rather than inventing one", () => {
    expect(reasonLabel("something-new")).toBe("something-new");
  });
});

describe("tooBigToDiff", () => {
  it("refuses to pull huge payloads into the browser for a diff", () => {
    expect(tooBigToDiff(10, 10)).toBe(false);
    expect(tooBigToDiff(VERSION_DIFF_MAX + 1, 0)).toBe(true);
    expect(tooBigToDiff(0, VERSION_DIFF_MAX + 1)).toBe(true);
  });
});

// ---- the choreography the file-manager surfaces run on ---------------------
// Every call the History panel, the Trash view and the lock toggle make goes
// through these helpers, so a fake api pins the ORDER and the DIRECTION of
// each exchange without a browser.

const version = (over: Partial<FsVersion> = {}): FsVersion => ({
  version_no: 1,
  reason: "overwrite",
  size_bytes: 12,
  edited_by: "Ishaan Sharma",
  created_at: "2026-07-21T10:00:00Z",
  ...over,
});

const trashEntry = (over: Partial<FsTrashEntry> = {}): FsTrashEntry => ({
  path: "/shared/notes.md",
  size_bytes: 12,
  deleted_at: "2026-07-21T10:00:00Z",
  edited_by: "Ishaan Sharma",
  ...over,
});

const locked = (name: string | null = "Alice"): FsLock => ({
  locked_by: "acct-1",
  locked_by_name: name,
  locked_at: "2026-07-21T10:00:00Z",
});

const urls = {
  fsVersionUrl: (p: string, v: number) =>
    `/api/v1/files/version?path=${encodeURIComponent(p)}&v=${v}`,
  fsFileUrl: (p: string) => `/api/v1/files/file?path=${encodeURIComponent(p)}`,
};

describe("loadHistory", () => {
  it("hands back the server's version list for the file it was asked about", async () => {
    const fsHistory = vi.fn().mockResolvedValue({ versions: [version({ version_no: 2 })] });
    await expect(loadHistory({ fsHistory }, "/shared/notes.md")).resolves.toEqual([
      version({ version_no: 2 }),
    ]);
    expect(fsHistory).toHaveBeenCalledWith("/shared/notes.md");
  });
  it("lets a refusal reach the caller — a failed history is never an empty one", async () => {
    const fsHistory = vi.fn().mockRejectedValue(new ApiError(404, "not found"));
    await expect(loadHistory({ fsHistory }, "/shared/gone.md")).rejects.toThrow("not found");
  });
});

describe("diffUrls — the snapshot is the LEFT side, the live file the RIGHT", () => {
  it("pairs v<n> as `from` and the current bytes as `to`", () => {
    expect(diffUrls(urls, "/shared/a b.md", 3)).toEqual({
      from: "/api/v1/files/version?path=%2Fshared%2Fa%20b.md&v=3",
      to: "/api/v1/files/file?path=%2Fshared%2Fa%20b.md",
    });
  });
});

describe("loadDiffPair", () => {
  it("fetches both sides and keeps them in old→now order", async () => {
    const fetchText = vi.fn().mockImplementation((u: string) => Promise.resolve(`body of ${u}`));
    await expect(loadDiffPair(fetchText, { from: "/v", to: "/live" })).resolves.toEqual({
      from: "body of /v",
      to: "body of /live",
    });
    expect(fetchText.mock.calls.map((c) => c[0])).toEqual(["/v", "/live"]);
  });
  it("fails the pair when either side fails — never half a diff", async () => {
    const fetchText = vi
      .fn()
      .mockImplementation((u: string) =>
        u === "/live" ? Promise.reject(new Error("500")) : Promise.resolve("old"),
      );
    await expect(loadDiffPair(fetchText, { from: "/v", to: "/live" })).rejects.toThrow("500");
  });
});

describe("restoreAndReload — reload only after the write actually landed", () => {
  it("restores a specific version, then reloads", async () => {
    const order: string[] = [];
    const fsRestore = vi.fn().mockImplementation(() => {
      order.push("restore");
      return Promise.resolve({ ok: true });
    });
    await restoreAndReload({ fsRestore }, "/shared/notes.md", 2, () => {
      order.push("reload");
    });
    expect(fsRestore).toHaveBeenCalledWith("/shared/notes.md", 2);
    expect(order).toEqual(["restore", "reload"]);
  });
  it("restores a deleted path with no version (the trash case)", async () => {
    const fsRestore = vi.fn().mockResolvedValue({ ok: true });
    await restoreAndReload({ fsRestore }, "/shared/gone.md", undefined, () => {});
    expect(fsRestore).toHaveBeenCalledWith("/shared/gone.md", undefined);
  });
  it("does NOT reload when the restore was refused (EEXIST/ELOCKED)", async () => {
    const fsRestore = vi.fn().mockRejectedValue(new ApiError(400, "EEXIST: /shared/notes.md"));
    const reload = vi.fn();
    await expect(
      restoreAndReload({ fsRestore }, "/shared/notes.md", undefined, reload),
    ).rejects.toThrow("EEXIST");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("loadTrash", () => {
  it("asks for the whole tree at the root and scopes to the folder elsewhere", async () => {
    const fsTrash = vi.fn().mockResolvedValue({ entries: [trashEntry()] });
    await expect(loadTrash({ fsTrash }, "/")).resolves.toEqual([trashEntry()]);
    expect(fsTrash).toHaveBeenCalledWith(undefined);
    await loadTrash({ fsTrash }, "/shared");
    expect(fsTrash).toHaveBeenLastCalledWith("/shared");
  });
});

describe("lockHolder", () => {
  it("is null when nothing holds the path", () => {
    expect(lockHolder(null)).toBeNull();
    expect(lockHolder(UNLOCKED)).toBeNull();
  });
  it("names the holder, and says `someone` when the name didn't resolve", () => {
    expect(lockHolder(locked("Alice"))).toBe("Alice");
    expect(lockHolder(locked(null))).toBe("someone");
  });
});

describe("loadLock", () => {
  it("reads the lock", async () => {
    const fsLockInfo = vi.fn().mockResolvedValue(locked());
    await expect(loadLock({ fsLockInfo }, "/shared")).resolves.toEqual(locked());
  });
  it("reads as UNLOCKED when the lock can't be read — the store is the boundary", async () => {
    const fsLockInfo = vi.fn().mockRejectedValue(new ApiError(500, "boom"));
    await expect(loadLock({ fsLockInfo }, "/shared")).resolves.toEqual(UNLOCKED);
  });
});

describe("locksFromListing — the listing already carries every row's lock", () => {
  it("keys the folder's own lock and each row's by FULL path (no N+1 reads)", () => {
    expect(
      locksFromListing("/shared/reports", {
        lock: UNLOCKED,
        entries: [
          { name: "q3.md", lock: locked() },
          { name: "q4.md", lock: UNLOCKED },
        ],
      }),
    ).toEqual({
      "/shared/reports": UNLOCKED,
      "/shared/reports/q3.md": locked(),
      "/shared/reports/q4.md": UNLOCKED,
    });
  });
  it("leaves out anything the server sent no lock for, rather than guessing", () => {
    expect(locksFromListing("/shared", { entries: [{ name: "a.md" }] })).toEqual({});
  });
});

describe("isWritablePath — the UI never offers a control the store must refuse", () => {
  it("says no to the fixed roots (FsStore.assertWritable refuses them)", () => {
    expect(isWritablePath("/shared", "/home/alice")).toBe(false);
    expect(isWritablePath("/home/alice", "/home/alice")).toBe(false);
    expect(isWritablePath("/home", "/home/alice")).toBe(false);
    expect(isWritablePath("/", "/home/alice")).toBe(false);
  });
  it("says yes inside /shared and inside your own home", () => {
    expect(isWritablePath("/shared/reports", "/home/alice")).toBe(true);
    expect(isWritablePath("/home/alice/notes.md", "/home/alice")).toBe(true);
  });
  it("says no to a foreign home, and to anything outside both trees", () => {
    expect(isWritablePath("/home/ishaan/notes.md", "/home/alice")).toBe(false);
    expect(isWritablePath("/tmp/scratch.txt", "/home/alice")).toBe(false);
    expect(isWritablePath("/home/alice/notes.md", null)).toBe(false);
  });
});

describe("displayPath — the raw /home/<slug> is never printed", () => {
  it("collapses your home to `~`, exactly as the path bar renders it", () => {
    expect(displayPath("/home/alice", "/home/alice")).toBe("~");
    expect(displayPath("/home/alice/notes.md", "/home/alice")).toBe("~/notes.md");
  });
  it("leaves shared paths (and anything not under your home) alone", () => {
    expect(displayPath("/shared/q3.md", "/home/alice")).toBe("/shared/q3.md");
    expect(displayPath("/home/alicex/notes.md", "/home/alice")).toBe("/home/alicex/notes.md");
    expect(displayPath("/shared/q3.md", null)).toBe("/shared/q3.md");
  });
});

describe("toggleLock", () => {
  it("locks an unlocked path and unlocks a locked one", async () => {
    const fsLock = vi.fn().mockResolvedValue(locked());
    const fsUnlock = vi.fn().mockResolvedValue(UNLOCKED);
    await expect(toggleLock({ fsLock, fsUnlock }, "/shared/reports", null)).resolves.toEqual(
      locked(),
    );
    expect(fsLock).toHaveBeenCalledWith("/shared/reports");
    expect(fsUnlock).not.toHaveBeenCalled();

    await expect(toggleLock({ fsLock, fsUnlock }, "/shared/reports", locked())).resolves.toEqual(
      UNLOCKED,
    );
    expect(fsUnlock).toHaveBeenCalledWith("/shared/reports");
  });
  it("treats an unlocked payload as unlocked, not as a holder", async () => {
    const fsLock = vi.fn().mockResolvedValue(locked());
    const fsUnlock = vi.fn().mockResolvedValue(UNLOCKED);
    await toggleLock({ fsLock, fsUnlock }, "/shared/reports", UNLOCKED);
    expect(fsLock).toHaveBeenCalledTimes(1);
  });
  it("lets the store's refusal through (a lock cannot be stolen)", async () => {
    const fsLock = vi.fn().mockRejectedValue(new ApiError(400, "already locked by Ishaan Sharma"));
    const fsUnlock = vi.fn();
    await expect(toggleLock({ fsLock, fsUnlock }, "/shared/reports", null)).rejects.toThrow(
      "already locked",
    );
  });
});

describe("errText", () => {
  it("shows the server's own words for an API refusal", () => {
    expect(errText(new ApiError(400, "ELOCKED: /shared is locked by Alice"), "nope")).toBe(
      "ELOCKED: /shared is locked by Alice",
    );
  });
  it("falls back for anything else — a raw fetch failure is not a message", () => {
    expect(errText(new TypeError("Failed to fetch"), "could not change the lock")).toBe(
      "could not change the lock",
    );
    expect(errText("nope", "fallback")).toBe("fallback");
  });
});
