/**
 * reissue-owner-token — break-glass owner-token minter. The
 * single-owner-locked-out-BEFORE-first-login recovery path: run it via the
 * tools-profile compose service
 *   docker compose --profile tools run --rm \
 *     -e BRAIN_REISSUE_OWNER_EMAIL=<owner@corp> reissue-owner-token
 * It prints a fresh OWNER_TOKEN ONCE. It connects as brain_owner (host/compose
 * access = the box operator's own key) — NOT the request-serving brain_app pool,
 * and NOT superuser — so the app can never reach this even if SQL-injected.
 *
 * This is NOT an Admin-class method (the app instantiates Admin): the token gen
 * + SQL call live ONLY here, importing just generateToken.
 */
import { Client } from "pg";
import { generateToken } from "@brain/mcp-tools";

async function main(): Promise<void> {
  const email = process.env.BRAIN_REISSUE_OWNER_EMAIL;
  if (!email || !email.trim()) {
    console.error("BRAIN_REISSUE_OWNER_EMAIL is required (the locked-out owner's email).");
    process.exit(1);
  }
  const ownerUrl = process.env.BRAIN_OWNER_DATABASE_URL;
  if (!ownerUrl) {
    console.error(
      "BRAIN_OWNER_DATABASE_URL is required (this runs as brain_owner, never the app pool).",
    );
    process.exit(1);
  }

  const { token, hash } = generateToken("brain_owner");
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // The SECURITY DEFINER function (0041) does the lookup + rotate + audit in
    // one call; a RAISE (unknown/only-revoked owner) surfaces as a query error.
    await client.query("SELECT brain_reissue_owner_token($1, $2)", [email.trim(), hash]);
  } catch (err) {
    console.error(`reissue failed: ${(err as Error).message}`);
    await client.end().catch(() => {});
    process.exit(1);
  }
  await client.end().catch(() => {});
  // Printed ONCE — store it securely, then it's gone (only the hash is kept).
  console.log(`OWNER_TOKEN=${token}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
