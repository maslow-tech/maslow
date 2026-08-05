# Google OAuth client registration (Google connector)

You register your own OAuth client in your own Google account. That keeps the
app private to your org (no Google verification review) and matches the box
trust model: your credentials, your box. About 5 minutes, once per org; after
this every member clicks **Connect** on the dashboard's Connectors page.

You need a Google account with permission to create a Cloud project (any
Workspace admin, or the org's Google account owner).

## Steps (console.cloud.google.com)

1. Create a project; name it e.g. `maslow-brain`. No billing needed.
2. Enable the APIs: APIs & Services → Library → enable the **Gmail API**,
   **Google Calendar API**, and **Google Drive API**.
3. Configure the consent screen (APIs & Services → OAuth consent screen):
   - Google Workspace org: choose "Internal". No review, refresh tokens
     never expire, restricted Gmail scopes allowed inside the org. This is
     the normal path, and the caveats below do not apply.
   - Plain Gmail account: choose "External". App name + support email, save.
     See "External-app caveats" below.
   - Scopes page: you can skip adding scopes here; consent is driven by what
     the box requests.
4. Create the OAuth client: APIs & Services → Credentials → Create
   credentials → OAuth client ID.
   - Application type: **Web application**
   - Authorized redirect URI: exactly the value shown on the box dashboard's
     Connectors page next to the Google fields,
     `https://<box-domain>/connect/callback`
     (e.g. `https://brain.example.com/connect/callback`).
5. Copy the Client ID and Client secret into the dashboard → Connectors →
   Google → Enable (owner-only).
6. Each member clicks **Connect**, completes Google consent, and is done.
   The `google` tool (Gmail + Calendar + Drive, running as that member) then
   appears in their agents' tool list; it stays hidden until they connect.

## External-app caveats (plain Gmail accounts only)

- In "Testing" publishing status, refresh tokens expire every 7 days (weekly
  re-Connect). Fix: OAuth consent screen → **Publish app** ("In production")
  without submitting for verification. Users then see a one-time "Google
  hasn't verified this app" interstitial (Advanced → continue), and refresh
  tokens stop expiring. The 100-user cap does not matter for a box.
- Do not submit for verification. That is the weeks-long review this setup
  avoids, and it is unnecessary for a private per-org client.

## Adding Calendar / Drive scopes later

Use the same project, client, and pasted credentials: enable the API in the
console, add the scope to `GOOGLE_SCOPES` in
`apps/box/src/connectors/google.ts`, rebuild; members re-Connect once to
grant the new scope.
