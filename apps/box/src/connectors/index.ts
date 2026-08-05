import { ConnectorConfigStore } from "./config-store.js";
export { ConnectorConfigStore } from "./config-store.js";
export { CONNECTOR_CATALOG } from "./catalog.js";
export { CustomConnectorStore, customFetch, validateDefinition } from "./custom.js";
export { TokenVault } from "./vault.js";
export type { RefreshFn } from "./vault.js";
export { beginOAuth, completeOAuth } from "./oauth-flow.js";
export type { ExchangeFn } from "./oauth-flow.js";
export type { TokenFingerprint, EffectiveFingerprint } from "./vault.js";
export {
  GOOGLE_PROVIDER,
  googleCreds,
  googleAuthorizeUrl,
  googleValidateClient,
  googleExchange,
  googleRefresh,
  googleApi,
  googleDoctrine,
  gmailSearch,
  gmailRead,
  gmailSend,
  fail,
} from "./google.js";
export { markExternal } from "./untrusted.js";
export {
  MICROSOFT_PROVIDER,
  microsoftCreds,
  microsoftAuthorizeUrl,
  microsoftValidateClient,
  microsoftExchange,
  microsoftRefresh,
  microsoftApi,
  microsoftDoctrine,
} from "./microsoft.js";
export type { GmailResult, ApiRequest } from "./google.js";

/** The "owner-stored config row → typed provider creds" composition, in ONE
 *  place (box.ts backends + dashboard app-creds both go through it). Returns
 *  null when the provider isn't enabled OR the row won't decrypt — the same
 *  null-on-missing contract as getConfig. */
export async function loadCreds<C>(
  configStore: ConnectorConfigStore,
  provider: string,
  parse: (fields: Record<string, string>) => C | null,
): Promise<C | null> {
  const stored = await configStore.getConfig(provider);
  return stored ? parse(stored) : null;
}
