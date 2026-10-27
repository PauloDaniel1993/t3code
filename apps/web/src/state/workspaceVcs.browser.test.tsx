import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
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
const primary = { isRepo: true, refName: "feature" } as VcsStatusResult;
function Probe({
  lease,
  tuple = members,
  onChange,
}: {
  lease: boolean;
  tuple?: typeof members;
  onChange: (value: ReturnType<typeof useSidebarBranchAgreement>) => void;
}) {
  const value = useSidebarBranchAgreement(environmentId, tuple, primary, lease);
  useLayoutEffect(() => {
    onChange(value);
  });
  return null;
}
function setup() {
  fixtures.branch.mockReset();
  fixtures.full.mockReset();
}

it("leases only secondary member roots and releases them offscreen while retaining the hint", async () => {
  setup();
  let latest!: ReturnType<typeof useSidebarBranchAgreement>;
  const onChange = (value: typeof latest) => {
    latest = value;
  };
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
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
      <Probe lease={lease} onChange={onChange} />
    </RegistryContext.Provider>
  );
  await using screen = await render(view(true));
  expect(latest?.hint).toBe("2/2");
  expect(acquired).toBe(1);
  expect(fixtures.branch).toHaveBeenCalledWith({ environmentId, input: { cwd: "/sets/web" } });
  expect(fixtures.full).not.toHaveBeenCalled();
  await screen.rerender(view(false));
  expect(released).toBe(1);
  expect(latest?.hint).toBe("2/2");
  await screen.unmount();
});

it("never subscribes for current-checkout or one-member rows", async () => {
  setup();
  let latest!: ReturnType<typeof useSidebarBranchAgreement>;
  const onChange = (value: typeof latest) => {
    latest = value;
  };
  await using screen = await render(<Probe lease tuple={[]} onChange={onChange} />);
  expect(latest).toBeNull();
  await screen.rerender(<Probe lease tuple={[members[0]!]} onChange={onChange} />);
  expect(fixtures.branch).not.toHaveBeenCalled();
  expect(fixtures.full).not.toHaveBeenCalled();
});
