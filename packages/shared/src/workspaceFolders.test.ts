import { describe, expect, it } from "vite-plus/test";

import { allocateFolderLabels } from "./workspaceFolders.ts";

const labels = (entries: Parameters<typeof allocateFolderLabels>[0]) =>
  allocateFolderLabels(entries).map((folder) => folder.label);

describe("allocateFolderLabels", () => {
  it("lets every folder keep its preferred label before repeats take a suffix", () => {
    expect(
      labels([
        { path: "/srv/one/app", name: "app" },
        { path: "/srv/two/app", name: "app" },
        { path: "/srv/app-2", name: "app-2" },
      ]),
    ).toEqual(["app", "app-3", "app-2"]);
  });

  it("compares labels case-insensitively and keeps each folder's own casing", () => {
    expect(
      labels([
        { path: "C:\\work\\App", name: "App" },
        { path: "D:\\work\\app", name: "app" },
        { path: "E:\\work\\APP-2", name: "APP-2" },
      ]),
    ).toEqual(["App", "app-3", "APP-2"]);
  });

  it("makes names one path segment, so sanitized names collide like plain ones", () => {
    expect(
      labels([
        { path: "/srv/a", name: "web/api" },
        { path: "/srv/b", name: "web:api" },
        { path: "/srv/c", name: "tab\there" },
      ]),
    ).toEqual(["web-api", "web-api-2", "tab-here"]);
  });

  it("falls back to the basename, then to folder, when a name is not a usable segment", () => {
    expect(
      labels([
        { path: "C:\\work\\api\\", name: ".." },
        { uri: "vscode-remote://ssh-remote+devbox/srv/docs", name: "." },
        { path: "/", name: "." },
      ]),
    ).toEqual(["api", "docs", "folder"]);
  });

  it("reserves labels for remote folders too, so availability never renumbers", () => {
    const folders = [
      { uri: "vscode-remote://ssh-remote+devbox/srv/api", name: "api" },
      { path: "/srv/api", name: "api" },
    ];
    expect(labels(folders)).toEqual(["api", "api-2"]);
    expect(allocateFolderLabels(folders)[0]).toEqual({ ...folders[0], label: "api" });
  });
});
