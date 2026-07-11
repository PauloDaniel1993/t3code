import { describe, expect, it } from "vite-plus/test";

import { resolveAssetUrl, resolveUnexpiredAssetUrl } from "./assetUrls";

describe("resolveAssetUrl", () => {
  it("resolves an environment-relative asset URL", () => {
    expect(
      resolveAssetUrl("https://environment.example/base/", "/api/assets/signed-token/favicon.png"),
    ).toBe("https://environment.example/api/assets/signed-token/favicon.png");
  });

  it("rejects an invalid environment base URL", () => {
    expect(resolveAssetUrl("not a URL", "/api/assets/signed-token/favicon.png")).toBeNull();
  });
});

describe("resolveUnexpiredAssetUrl", () => {
  const result = {
    relativeUrl: "/api/assets/signed-token/attachment.pdf",
    expiresAt: 10_000,
  };

  it("transitions a signed attachment URL to unavailable at expiry", () => {
    expect(resolveUnexpiredAssetUrl("https://environment.example", result, 9_999)).toBe(
      "https://environment.example/api/assets/signed-token/attachment.pdf",
    );
    expect(resolveUnexpiredAssetUrl("https://environment.example", result, 10_000)).toBeNull();
  });
});
