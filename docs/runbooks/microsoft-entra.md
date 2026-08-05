# Microsoft 365 — Entra app registration

A one-time app registration in your own Microsoft tenant so members can
connect Microsoft 365 to the brain. Identity, consent, and tokens stay
inside your tenant boundary; nothing is registered anywhere else, and
single-tenant apps have no Microsoft review or verification process. Each
member still individually signs in and consents before the brain can act as
them (delegated permissions only; the connector can never see more than the
signed-in member can).

Once registered, the owner pastes three values into the box dashboard →
Connectors → Microsoft 365, and each member clicks **Connect**. Refresh
tokens ride a 90-day sliding window that renews on every use, so active
members never re-sign in.

## Steps (≈10 minutes, needs a Global/Application Administrator)

1. Sign in to the Entra admin center (commercial: entra.microsoft.com; see
   "Which cloud" below).
2. **App registrations → New registration**
   - Name: `Maslow Brain Connector`
   - Supported account types: "Accounts in this organizational directory
     only" (single tenant)
   - Redirect URI: type **Web**, value
     `https://<box-domain>/connect/callback` (shown copy-paste ready on the
     dashboard's Connectors page)
3. Copy the **Application (client) ID** and **Directory (tenant) ID**.
4. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions**, add (this is `MICROSOFT_SCOPES` in
   `apps/box/src/connectors/microsoft.ts`; keep them in sync):

   | Scope                                                       | Covers                                                |
   | ----------------------------------------------------------- | ----------------------------------------------------- |
   | `openid`, `profile`, `offline_access`                       | sign-in + token refresh (no data access)              |
   | `User.Read`                                                 | the member's own basic profile                        |
   | `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`  | Outlook mail                                          |
   | `Calendars.ReadWrite`                                       | Outlook calendar                                      |
   | `Contacts.ReadWrite`                                        | Outlook contacts                                      |
   | `Files.ReadWrite.All`                                       | OneDrive + shared files (Word/Excel/PowerPoint docs)  |
   | `Sites.ReadWrite.All`                                       | SharePoint                                            |
   | `Chat.ReadWrite`, `ChannelMessage.Read.All`, `ChannelMessage.Send` | Teams messages                                 |
   | `Team.ReadBasic.All`, `Channel.ReadBasic.All`               | list teams/channels                                   |
   | `OnlineMeetings.ReadWrite`                                  | Teams meetings                                        |

   All delegated: the connector acts as the signed-in member, never
   app-wide. `ChannelMessage.*` require the admin-consent step below.

5. Grant admin consent for the tenant (the button on the API permissions
   page). This also removes the consent screen for every member; Connect
   becomes a single sign-in.
6. **Certificates & secrets → New client secret** (24-month expiry; set a
   calendar rotation reminder, and the dashboard's Edit button takes the new
   value). Copy the **Value** (not the Secret ID) once.
7. Enter on the box dashboard (owner): client ID, tenant ID, client secret.
   The enable is validated live against the tenant's token endpoint; a
   typo'd value is rejected on the spot.

## Which cloud

- Commercial or GCC (moderate): the steps above as-is.
- GCC-High or DoD: registration happens in the gov portal (portal.azure.us)
  and the box would need the `.us` login/Graph endpoints. Those are not
  currently wired into the connector; a code change is required before this
  runbook applies.

## Containment

- Delegated only: no app-wide or tenant-wide data access, no application
  permissions.
- Revocable at any time: disable the enterprise application in Entra and
  every member's connection stops working immediately; individual members
  can also be revoked from their user page.
