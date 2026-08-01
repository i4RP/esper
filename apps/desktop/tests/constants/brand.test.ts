import { describe, expect, it } from "vitest";

import {
  BRAND,
  RELEASES_URL,
  REPO_URL,
  SUPPORT_URL,
  WEB_APP_HOST,
  brandDocsUrl,
  hostMatchesDomain,
  isBrandHost,
} from "../../src/constants/brand";

describe("BRAND", () => {
  // The whole point of the constant is that nothing reaches the upstream
  // project's identity any more — a stray "amical" here means a build would
  // register the upstream URL scheme or claim its bundle id.
  it("carries no upstream identity", () => {
    const identity = JSON.stringify(BRAND).toLowerCase();
    expect(identity).not.toContain("amical");
    expect(BRAND.bundleId).toBe("jp.btcpay.esper");
    expect(BRAND.scheme).toBe("esper");
  });

  // Null is load-bearing: every cloud consumer branches on these being unset
  // and fails closed. A non-null value here silently re-enables update checks,
  // remote-config CTAs and the browser session handoff against a host we do
  // not control, in a binary signed with our certificate.
  it("keeps cloud endpoints unset until a backend exists", () => {
    expect(BRAND.domain).toBeNull();
    expect(BRAND.updateServer).toBeNull();
    expect(WEB_APP_HOST).toBeNull();
  });

  it("derives repository URLs from the configured repo", () => {
    expect(REPO_URL).toBe("https://github.com/i4RP/esper");
    expect(RELEASES_URL).toBe("https://github.com/i4RP/esper/releases");
    expect(SUPPORT_URL).toBe("https://github.com/i4RP/esper/issues");
  });
});

describe("hostMatchesDomain", () => {
  const domain = "esper.example";

  it("accepts the domain itself and its subdomains", () => {
    expect(hostMatchesDomain("esper.example", domain)).toBe(true);
    expect(hostMatchesDomain("app.esper.example", domain)).toBe(true);
    expect(hostMatchesDomain("cdn.assets.esper.example", domain)).toBe(true);
  });

  it("is case insensitive and tolerates the trailing-dot FQDN form", () => {
    expect(hostMatchesDomain("APP.Esper.Example", domain)).toBe(true);
    expect(hostMatchesDomain("app.esper.example.", domain)).toBe(true);
  });

  // Each of these is a host an attacker can register today. They must not be
  // mistaken for ours, or a remote payload could hand `openExternal` a URL
  // that looks like the brand and isn't.
  it("rejects look-alike hosts", () => {
    expect(hostMatchesDomain("evilesper.example", domain)).toBe(false);
    expect(hostMatchesDomain("esper.example.evil.test", domain)).toBe(false);
    expect(hostMatchesDomain("esper-example", domain)).toBe(false);
    expect(hostMatchesDomain("", domain)).toBe(false);
  });

  it("rejects everything when no domain is configured", () => {
    expect(hostMatchesDomain("esper.example", null)).toBe(false);
    expect(hostMatchesDomain("anything.at.all", null)).toBe(false);
    expect(hostMatchesDomain("", null)).toBe(false);
  });
});

describe("isBrandHost", () => {
  // Bound to the live BRAND.domain, which is null — so it is a blanket deny.
  it("rejects every host while no brand domain is configured", () => {
    expect(isBrandHost("esper.example")).toBe(false);
    expect(isBrandHost("github.com")).toBe(false);
    expect(isBrandHost("localhost")).toBe(false);
  });
});

describe("brandDocsUrl", () => {
  it("returns null while no brand domain is configured", () => {
    expect(brandDocsUrl("shortcuts")).toBeNull();
    expect(brandDocsUrl("/shortcuts")).toBeNull();
  });
});
