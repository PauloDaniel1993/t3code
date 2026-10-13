import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useSidebarBranchAgreement } from "./workspaceVcs";

const fixtures = vi.hoisted(() => ({ branch: vi.fn(), full: vi.fn() }));
vi.mock("./vcs", () => ({
  vcsEnvironment: {
    branchStatus: (...args: unknown[]) => fixtures.branch(...args),
    status: (...args: unknown[]) => fixtures.full(...args),
  },
}));
const environmentId = EnvironmentId.make("environment");
const members = [
  { repositoryRoot: "/api", path: "/sets/api", branch: "feature" },
  { repositoryRoot: "/web", path: "/sets/web", branch: "feature-web" },
];
let renderer: ReactTestRenderer;
let latest: ReturnType<typeof useSidebarBranchAgreement>;
const primary = { isRepo: true, refName: "feature" } as VcsStatusResult;
function Probe({ lease, tuple = members }: { lease: boolean; tuple?: typeof members }) {
  const value = useSidebarBranchAgreement(environmentId, tuple, primary, lease);
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
  fixtures.branch.mockReset();
  fixtures.full.mockReset();
});

it("leases only secondary member roots and releases them offscreen while retaining the hint", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
  let acquired = 0;
  let released = 0;
  const branchAtom = Atom.make((get) => {
    acquired++;
    get.addFinalizer(() => {
      released++;
    });
    return AsyncResult.success({ isRepo: true, refName: "feature-web" });
  });
  fixtures.branch.mockReturnValue(branchAtom);
  const view = (lease: boolean) => (
    <RegistryContext.Provider value={registry}>
      <Probe lease={lease} />
    </RegistryContext.Provider>
  );
  await act(() => {
    renderer = create(view(true));
  });
  expect(latest?.hint).toBe("2/2");
  expect(acquired).toBe(1);
  expect(fixtures.branch).toHaveBeenCalledWith({ environmentId, input: { cwd: "/sets/web" } });
  expect(fixtures.full).not.toHaveBeenCalled();
  await act(() => renderer.update(view(false)));
  expect(released).toBe(1);
  expect(latest?.hint).toBe("2/2");
  await act(() => renderer.unmount());
  registry.dispose();
});

it("never subscribes for current-checkout or one-member rows", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(<Probe lease tuple={[]} />);
  });
  expect(latest).toBeNull();
  await act(() => renderer.update(<Probe lease tuple={[members[0]!]} />));
  expect(fixtures.branch).not.toHaveBeenCalled();
  expect(fixtures.full).not.toHaveBeenCalled();
});
