import { GOOGLE_SCOPES } from "./google.js";
import { MICROSOFT_SCOPES } from "./microsoft.js";

/**
 * The hardcoded connector catalog: one entry per supported provider, listing
 * the credential fields an OWNER supplies to enable it, what the connector
 * can access (shown to every member before they Connect), and the owner
 * setup guide (rendered on the dashboard card itself — the instructions live
 * at the setup location, version-locked to the code they describe).
 * Deliberately no generic framework — a new provider is one entry here plus
 * its fetch/auth functions.
 */

interface ConnectorField {
  readonly key: string;
  readonly label: string;
  /** render as a password input; the stored value is never echoed back. */
  readonly secret?: boolean;
}

/** One row of the member-facing "What it can access" table. */
interface AccessRow {
  readonly app: string;
  readonly allows: string;
}

/** The owner-facing setup guide. Steps may contain the literal token
 *  `{{redirectUri}}`, which the UI replaces with THIS box's callback URL
 *  (plus a copy button). */
interface ConnectorSetup {
  readonly intro: string;
  readonly steps: readonly string[];
}

interface ConnectorEntry {
  readonly provider: string;
  readonly name: string;
  readonly fields: readonly ConnectorField[];
  readonly access: readonly AccessRow[];
  /** raw OAuth scope strings, folded behind "technical scopes" in the UI. */
  readonly scopes?: readonly string[];
  readonly setup: ConnectorSetup;
  /** true = per-member OAuth connect flow on top of the owner config (the
   *  fields are the org's OAuth client, not a ready-to-use credential). */
  readonly oauth?: boolean;
}

export const CONNECTOR_CATALOG: readonly ConnectorEntry[] = [
  {
    provider: "google",
    name: "Google",
    fields: [
      { key: "clientId", label: "OAuth client ID" },
      { key: "clientSecret", label: "OAuth client secret", secret: true },
    ],
    access: [
      {
        app: "Gmail",
        allows: "read, search, send, organize, and delete mail; manage filters & auto-reply",
      },
      { app: "Calendar", allows: "view, create, edit, and delete events" },
      {
        app: "Drive",
        allows: "read, create, edit, and delete files, incl. Docs/Sheets/Slides",
      },
    ],
    scopes: GOOGLE_SCOPES,
    setup: {
      intro:
        "One-time registration in YOUR Google account (~5 min). The app stays private to " +
        "your org — no Google review, and connections never expire. Each member then " +
        "connects their own account; agents only ever see what that member can see.",
      steps: [
        "Go to console.cloud.google.com (signed in as a Google Workspace admin) and create a project, e.g. “maslow-brain”.",
        "APIs & Services → Library: enable the Gmail API, Google Calendar API, and Google Drive API.",
        "APIs & Services → OAuth consent screen: choose Internal, name it (e.g. “Maslow Brain”), save.",
        "Credentials → Create credentials → OAuth client ID → Web application. Authorized redirect URI: {{redirectUri}}",
        "Copy the Client ID and Client secret into the fields below and click Enable.",
        "Every member (including you) clicks Connect on this card to link their own Google account.",
      ],
    },
    oauth: true,
  },
  {
    provider: "msgraph",
    name: "Microsoft 365",
    fields: [
      { key: "clientId", label: "Application (client) ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "tenantId", label: "Directory (tenant) ID" },
    ],
    access: [
      {
        app: "Outlook",
        allows: "read, send, and organize mail; full calendar and contacts",
      },
      {
        app: "Teams",
        allows: "read & send chats and channel messages; create meetings",
      },
      {
        app: "OneDrive & Office files",
        allows: "read, create, and edit files, incl. Word/Excel/PowerPoint",
      },
      { app: "SharePoint", allows: "read & edit sites and their documents" },
    ],
    scopes: MICROSOFT_SCOPES,
    setup: {
      intro:
        "One-time registration in YOUR Microsoft tenant (~10 min, needs a Global or " +
        "Application Administrator). The app stays private to your org — no Microsoft " +
        "review. Each member then connects their own account; agents only ever see " +
        "what that member can see.",
      steps: [
        "Go to entra.microsoft.com → App registrations → New registration. Name it (e.g. “Maslow Brain Connector”), choose “Accounts in this organizational directory only” (single tenant).",
        "Redirect URI: choose Web, value: {{redirectUri}}",
        "From the app's Overview page, copy the Application (client) ID and Directory (tenant) ID.",
        "API permissions → Add a permission → Microsoft Graph → Delegated: add the technical scopes listed under “What it can access”, then click Grant admin consent (this also removes the consent prompt for members).",
        "Certificates & secrets → New client secret (24-month expiry) — copy the VALUE, not the Secret ID.",
        "Paste all three values into the fields below and click Enable; members then click Connect.",
      ],
    },
    oauth: true,
  },
];
