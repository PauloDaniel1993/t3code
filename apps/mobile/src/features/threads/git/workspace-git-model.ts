import type { VcsStatusResult } from "@t3tools/contracts";
import {
  isCheckoutDrifted,
  owningFolder,
  relativePathWithin,
  toCanonicalPath,
  type WorkspaceGitCheckout,
} from "@t3tools/shared/workspaceFolders";

type ChangesFolder = {
  readonly label: string;
  readonly effectivePath: string | null;
  readonly diffPath?: string | null;
  readonly unavailable?: boolean;
};

/** Unknown status cannot be treated as agreement or a clean checkout. */
export function workspaceGitSummary(
  checkouts: ReadonlyArray<WorkspaceGitCheckout>,
  statuses: ReadonlyArray<VcsStatusResult | null>,
  folders?: ReadonlyArray<ChangesFolder>,
  ownershipCheckouts: ReadonlyArray<WorkspaceGitCheckout> = checkouts,
) {
  const folderPaths = folders?.map((folder) => ({
    ...folder,
    path: folder.diffPath ?? folder.effectivePath,
  }));
  const checkoutPaths = ownershipCheckouts.map((checkout) => ({
    ...checkout,
    path: checkout.root,
  }));
  const members = checkouts.map((checkout, index) => {
    const status = statuses[index] ?? null;
    return {
      checkout,
      status,
      drifted: status?.isRepo === true && isCheckoutDrifted(checkout, status.refName),
    };
  });
  const known = members.every((member) => member.status?.isRepo === true);
  const branches = new Set(
    members.filter((member) => member.status?.isRepo).map((member) => member.status!.refName),
  );
  const mixed =
    branches.size > 1 && members.every((member) => member.checkout.expectedBranch === null);
  return {
    members,
    known,
    drifted: members.filter((member) => member.drifted).length,
    branch: !known
      ? "Loading branches…"
      : mixed
        ? "Mixed branches"
        : (members[0]?.status?.refName ?? "Detached HEAD"),
    files: members.flatMap(({ checkout, status }) =>
      (status?.workingTree.files ?? []).flatMap((file) => {
        // Git status paths are checkout-relative even when the subscription's
        // cwd is a workspace subfolder. Give each file to its deepest folder.
        const absolutePath = `${checkout.root.replace(/[\\/]+$/, "")}/${file.path}`;
        const owner = folderPaths
          ? owningFolder(absolutePath, folderPaths)
          : { label: checkout.label, path: checkout.root, unavailable: false };
        const ownerCheckout = owningFolder(absolutePath, checkoutPaths);
        if (ownerCheckout?.root !== checkout.root) return [];
        if (owner?.unavailable) return [];
        const relativePath = owner?.path ? relativePathWithin(owner.path, absolutePath) : file.path;
        if (relativePath === null || relativePath === "") return [];
        return [
          {
            ...file,
            checkout,
            folderLabel: owner?.label ?? null,
            displayPath: owner?.path
              ? toCanonicalPath(owner, relativePath, folders?.length ?? checkouts.length)
              : `${checkout.label} (repository)/${file.path}`,
          },
        ];
      }),
    ),
  };
}

export function worktreeBranchAgreement(
  members: ReadonlyArray<{ readonly branch: string }>,
  statuses: ReadonlyArray<Pick<VcsStatusResult, "isRepo" | "refName"> | null>,
) {
  if (
    members.length < 2 ||
    statuses.some((status) => status?.isRepo !== true) ||
    statuses.length !== members.length
  )
    return null;
  const agreed = members.filter(
    (member, index) => statuses[index]?.isRepo && statuses[index]?.refName === member.branch,
  ).length;
  return { agreed, total: members.length, drifted: agreed !== members.length };
}
