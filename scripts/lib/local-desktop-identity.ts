/** The V2 local build must coexist with both the official and alpha.local apps. */
export const LOCAL_DESKTOP_IDENTITY = {
  appId: "com.t3tools.t3code.v2.local",
  packageName: "t3code-v2-local",
  productName: "T3 v2.local",
  homeName: ".t3.v2",
  metadataFileName: ".t3code-install.json",
} as const;

export const LOCAL_DESKTOP_BOOTSTRAP_VERSION = "t3code-v2-local-bootstrap-1";

/** Prevent packaging or installing stale bundles without the pre-ready isolation hook. */
export const hasLocalDesktopBootstrap = (source: string): boolean =>
  source.includes(LOCAL_DESKTOP_BOOTSTRAP_VERSION) &&
  source.includes("T3CODE_LOCAL_BOOTSTRAP_VERSION");
