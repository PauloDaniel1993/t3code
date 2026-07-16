export function resolveDiffIndicators(style: "color" | "color-and-markers"): "bars" | "classic" {
  return style === "color-and-markers" ? "classic" : "bars";
}
