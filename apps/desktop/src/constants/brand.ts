/**
 * Single source of truth for Esper's brand identity. Everything that used to
 * hardcode the upstream (Amical) name, bundle id, URL scheme or web domain
 * reads from here, so re-pointing the app — or switching cloud features on
 * under an Esper-branded backend — is a one-file edit.
 *
 * `domain` and `updateServer` are deliberately null: Esper has no backend of
 * its own yet, and pointing them at the upstream hosts would mean shipping an
 * Esper-signed binary that trusts a third party for OAuth redirects, banner
 * content and update payloads. Every consumer fails closed instead — remote
 * config CTAs are rejected, the web-session handoff refuses to open a browser,
 * docs/community links hide themselves, and the updater never checks.
 */
export const BRAND = {
  name: "Esper",
  /** Bundle id / Windows AppUserModelID. Must match forge's appBundleId. */
  bundleId: "jp.btcpay.esper",
  /** Deep-link scheme (esper://oauth/callback). Must match forge's protocols. */
  scheme: "esper",
  /** Web domain backing cloud features. Null until the Esper backend exists. */
  domain: null as string | null,
  /** Origin of the update feed. Null disables update checks entirely. */
  updateServer: null as string | null,
  /** Source repository — release notes, issue reports, publish target. */
  repo: { owner: "i4RP", name: "esper" },
} as const;

export const REPO_URL = `https://github.com/${BRAND.repo.owner}/${BRAND.repo.name}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
/** Where a user is sent to report a failure. Issues, not a support desk. */
export const SUPPORT_URL = `${REPO_URL}/issues`;

/**
 * Host of the web app. CTAs pointing here get the signed-in session handoff so
 * the user lands authenticated instead of on a login wall. Null with no domain.
 */
export const WEB_APP_HOST = BRAND.domain ? `app.${BRAND.domain}` : null;

/**
 * Host-matching rule, split out from `isBrandHost` so it stays testable while
 * `BRAND.domain` is null. Matches the domain itself and its subdomains only —
 * the leading dot is what keeps `evilesper.com` from passing as `esper.com`,
 * and the trailing-dot strip keeps the FQDN form `esper.com.` from slipping by.
 */
export function hostMatchesDomain(
  hostname: string,
  domain: string | null,
): boolean {
  if (!domain) {
    return false;
  }

  const target = domain.toLowerCase().replace(/\.$/, "");
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === target || host.endsWith(`.${target}`);
}

/**
 * True only for the brand's own domain and its subdomains. Used to gate every
 * URL that arrives from a server (remote config, session handoff) before it is
 * handed to the shell — `openExternal` honours any scheme/host it is given and
 * can't be undone, so an unconfigured domain must reject everything.
 */
export function isBrandHost(hostname: string): boolean {
  return hostMatchesDomain(hostname, BRAND.domain);
}

/**
 * Documentation deep link, or null while no domain is configured — callers hide
 * their "learn more" affordance rather than opening a dead link.
 */
export function brandDocsUrl(path: string): string | null {
  return BRAND.domain
    ? `https://${BRAND.domain}/docs/${path.replace(/^\/+/, "")}`
    : null;
}
