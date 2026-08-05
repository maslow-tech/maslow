import { describe, expect, it } from "vitest";
import {
  graphSendPreview,
  graphSendToken,
  isGmailSendPath,
  isGraphSendPath,
  pendingConfirmation,
  sendToken,
} from "@brain/shared";
import { markExternal, STANDING_INSTRUCTION } from "@brain/box";

describe("sendToken — content-bound, cc/order-stable", () => {
  it("is stable under cc-absent == cc-empty and recipient reordering", () => {
    const a = sendToken({ to: ["b@x.com", "a@x.com"], subject: "hi", text: "yo" });
    const b = sendToken({ to: ["a@x.com", "b@x.com"], cc: [], subject: "hi", text: "yo" });
    expect(a).toBe(b);
  });
  it("differs when a recipient, subject, or body changes", () => {
    const base = sendToken({ to: ["a@x.com"], subject: "hi", text: "yo" });
    expect(sendToken({ to: ["a@x.com", "c@x.com"], subject: "hi", text: "yo" })).not.toBe(base);
    expect(sendToken({ to: ["a@x.com"], subject: "HELLO", text: "yo" })).not.toBe(base);
    expect(sendToken({ to: ["a@x.com"], subject: "hi", text: "different" })).not.toBe(base);
  });
});

describe("isGmailSendPath / isGraphSendPath — normalization-safe", () => {
  it("matches gmail send shapes incl. evasion forms", () => {
    expect(isGmailSendPath("/gmail/v1/users/me/messages/send")).toBe(true);
    expect(isGmailSendPath("/gmail/v1/users/me/drafts/send")).toBe(true);
    expect(isGmailSendPath("/gmail/v1/users/me/messages/../messages/send")).toBe(true); // dot-dot
    expect(isGmailSendPath("/gmail/v1/users/me/MESSAGES/SEND")).toBe(true); // case
  });
  it("does NOT match read/modify/list or other services", () => {
    expect(isGmailSendPath("/gmail/v1/users/me/messages/abc/modify")).toBe(false);
    expect(isGmailSendPath("/gmail/v1/users/me/messages/abc/trash")).toBe(false);
    expect(isGmailSendPath("/gmail/v1/users/me/messages")).toBe(false);
    expect(isGmailSendPath("/calendar/v3/events")).toBe(false);
  });
  it("matches graph send shapes, not reads", () => {
    expect(isGraphSendPath("/v1.0/me/sendMail")).toBe(true);
    expect(isGraphSendPath("/v1.0/users/x/sendMail")).toBe(true);
    expect(isGraphSendPath("/v1.0/me/messages/AAA/send")).toBe(true);
    expect(isGraphSendPath("/v1.0/me/messages")).toBe(false);
    expect(isGraphSendPath("/v1.0/me/drive")).toBe(false);
  });
});

describe("graphSendPreview / token", () => {
  it("extracts recipients + subject from a sendMail payload without throwing on odd shapes", () => {
    const body = {
      message: {
        subject: "Q3",
        toRecipients: [{ emailAddress: { address: "a@x.com" } }],
        ccRecipients: [{ emailAddress: { address: "c@x.com" } }],
        body: { content: "hello" },
      },
    };
    const p = graphSendPreview(body);
    expect(p.to).toEqual(["a@x.com"]);
    expect(p.cc).toEqual(["c@x.com"]);
    expect(p.subject).toBe("Q3");
    expect(graphSendToken(body)).toBe(graphSendToken({ ...body })); // deterministic
    expect(() => graphSendPreview("garbage")).not.toThrow();
  });
});

describe("pendingConfirmation", () => {
  it("returns a successful envelope carrying the token + note, nothing sent", () => {
    const r = pendingConfirmation("google", { to: ["a@x.com"] }, "tok123");
    expect(r.successful).toBe(true);
    expect(r.data.pending_confirmation).toBe(true);
    expect(r.data.confirm_token).toBe("tok123");
    expect(String(r.data.note)).toContain("confirm");
  });
});

describe("markExternal", () => {
  it("wraps a successful result under .data.data with the standing note", () => {
    const wrapped = markExternal("google", { successful: true, data: { body: "email text" } }) as {
      data: { __external_content: boolean; source: string; note: string; data: unknown };
    };
    expect(wrapped.data.__external_content).toBe(true);
    expect(wrapped.data.source).toBe("google");
    expect(wrapped.data.note).toBe(STANDING_INSTRUCTION);
    expect(wrapped.data.data).toEqual({ body: "email text" }); // original nested clean
  });
  it("passes failures + teach envelopes through UNCHANGED", () => {
    const fail = { successful: false, error: "nope" };
    expect(markExternal("google", fail)).toBe(fail);
    const teach = { instructions: "call me with a path" }; // no successful:true
    expect(markExternal("custom", teach)).toBe(teach);
  });
});
