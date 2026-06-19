import type { SidebarCategoryAssignment, SidebarOrganization } from "@t3tools/contracts/settings";
import { derivePhysicalProjectKey } from "../logicalProject";
import type { Project } from "../types";

type SidebarCategoryAssignmentProject = Pick<
  Project,
  "environmentId" | "workspaceRoot" | "repositoryIdentity"
>;

interface AssignmentCandidate {
  readonly sourceKey: string;
  readonly assignment: SidebarCategoryAssignment;
}

function compareAssignmentCandidates(
  left: AssignmentCandidate,
  right: AssignmentCandidate,
): number {
  const updatedAtComparison = left.assignment.updatedAt.localeCompare(right.assignment.updatedAt);
  if (updatedAtComparison !== 0) {
    return updatedAtComparison;
  }
  return left.sourceKey.localeCompare(right.sourceKey);
}

export function deriveSidebarCategoryAssignmentKey(
  project: SidebarCategoryAssignmentProject,
): string {
  return project.repositoryIdentity?.canonicalKey?.trim() || derivePhysicalProjectKey(project);
}

export function buildCanonicalAssignmentKeyByPhysicalKey(
  projects: ReadonlyArray<SidebarCategoryAssignmentProject>,
): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const project of projects) {
    const canonicalKey = project.repositoryIdentity?.canonicalKey?.trim();
    if (!canonicalKey) {
      continue;
    }
    mapping.set(derivePhysicalProjectKey(project), canonicalKey);
  }
  return mapping;
}

export function resolveSidebarCategoryAssignment(
  sidebarOrganization: SidebarOrganization,
  project: SidebarCategoryAssignmentProject,
): SidebarCategoryAssignment | undefined {
  return sidebarOrganization.projectCategoryAssignments[
    deriveSidebarCategoryAssignmentKey(project)
  ];
}

export function assignSidebarCategory(
  sidebarOrganization: SidebarOrganization,
  input: {
    assignmentKey: string;
    categoryId: string | null;
    updatedAt: string;
  },
): SidebarOrganization {
  const nextAssignments = {
    ...sidebarOrganization.projectCategoryAssignments,
  };
  if (input.categoryId === null) {
    delete nextAssignments[input.assignmentKey];
  } else {
    nextAssignments[input.assignmentKey] = {
      categoryId: input.categoryId,
      updatedAt: input.updatedAt,
    };
  }

  return {
    ...sidebarOrganization,
    projectCategoryAssignments: nextAssignments,
  };
}

export function migrateSidebarCategoryAssignments(
  sidebarOrganization: SidebarOrganization,
  projects: ReadonlyArray<SidebarCategoryAssignmentProject>,
): SidebarOrganization {
  const canonicalAssignmentKeysByPhysicalKey = buildCanonicalAssignmentKeyByPhysicalKey(projects);
  const nextAssignments: Record<string, SidebarCategoryAssignment> = {};
  const chosenCandidates = new Map<string, AssignmentCandidate>();

  for (const [assignmentKey, assignment] of Object.entries(
    sidebarOrganization.projectCategoryAssignments,
  )) {
    const migratedKey = canonicalAssignmentKeysByPhysicalKey.get(assignmentKey) ?? assignmentKey;
    const candidate: AssignmentCandidate = {
      sourceKey: assignmentKey,
      assignment,
    };
    const existing = chosenCandidates.get(migratedKey);
    if (!existing || compareAssignmentCandidates(existing, candidate) < 0) {
      chosenCandidates.set(migratedKey, candidate);
      nextAssignments[migratedKey] = assignment;
    }
  }

  const currentEntries = Object.entries(sidebarOrganization.projectCategoryAssignments);
  const hasChanged =
    currentEntries.length !== Object.keys(nextAssignments).length ||
    currentEntries.some(([assignmentKey, assignment]) => {
      const nextAssignment = nextAssignments[assignmentKey];
      return (
        !nextAssignment ||
        nextAssignment.categoryId !== assignment.categoryId ||
        nextAssignment.updatedAt !== assignment.updatedAt
      );
    });
  if (!hasChanged) {
    return sidebarOrganization;
  }

  return {
    ...sidebarOrganization,
    projectCategoryAssignments: nextAssignments,
  };
}
