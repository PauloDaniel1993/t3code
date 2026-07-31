const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const IGNORED_WORKSPACE_DIRS = [
  "\\.git",
  "\\.repos",
  "\\.t3-dev",
  "\\.logs",
  "\\.plans",
  "\\.macroscope",
  "\\.claude-work-test",
  "\\.idea",
  "\\.vscode",
  "output",
  "experiments",
  "release",
  "docs",
];
const mobileShikiRoot = path.dirname(require.resolve("shiki/package.json", { paths: [__dirname] }));
const resolveShikiDependencyRoot = (packageName) => {
  const entryPath = require.resolve(packageName, { paths: [mobileShikiRoot] });
  let currentDir = path.dirname(entryPath);

  while (!fs.existsSync(path.join(currentDir, "package.json"))) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not resolve package root for ${packageName}`);
    }
    currentDir = parentDir;
  }

  return currentDir;
};

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver = {
  ...config.resolver,
  blockList: [
    ...(Array.isArray(config.resolver?.blockList)
      ? config.resolver.blockList
      : config.resolver?.blockList
        ? [config.resolver.blockList]
        : []),
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.t3[/\\\\].*`),
    // Gradle creates and deletes CMake scratch dirs under node_modules while a
    // native build runs. Watching them crashes the file map with ENOENT.
    /[/\\]\.cxx[/\\].*/,
    // watchFolders spans the whole monorepo so workspace packages resolve, but
    // crawling these trees is pure cost and exhausts file descriptors on
    // Windows ("EMFILE: too many open files"). None of them are importable.
    new RegExp(
      `${escapedWorkspaceRoot}[/\\\\](?:${IGNORED_WORKSPACE_DIRS.join("|")})[/\\\\].*`,
    ),
    /[/\\]android[/\\](?:build|\.gradle|\.kotlin)[/\\].*/,
  ],
  extraNodeModules: {
    // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread
    ...(config.resolver?.extraNodeModules ?? {}),
    shiki: mobileShikiRoot,
    "@shikijs/core": resolveShikiDependencyRoot("@shikijs/core"),
    "@shikijs/engine-javascript": resolveShikiDependencyRoot("@shikijs/engine-javascript"),
    "@shikijs/engine-oniguruma": resolveShikiDependencyRoot("@shikijs/engine-oniguruma"),
    "@shikijs/langs": resolveShikiDependencyRoot("@shikijs/langs"),
    "@shikijs/themes": resolveShikiDependencyRoot("@shikijs/themes"),
    "@shikijs/types": resolveShikiDependencyRoot("@shikijs/types"),
    "@shikijs/vscode-textmate": resolveShikiDependencyRoot("@shikijs/vscode-textmate"),
  },
};

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  polyfills: { rem: 14 },
});
