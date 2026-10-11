export function ProjectWorkspaceLabel({
  project,
}: {
  readonly project: {
    readonly workspaceFile?: string | null | undefined;
    readonly folders?: ReadonlyArray<unknown> | undefined;
    readonly memberProjects?: ReadonlyArray<{
      readonly workspaceFile?: string | null | undefined;
      readonly folders?: ReadonlyArray<unknown> | undefined;
    }>;
  };
}) {
  const multiple = (project.memberProjects ?? [project]).some(
    (member) => member.workspaceFile != null && (member.folders?.length ?? 0) > 1,
  );
  return multiple ? (
    <span className="shrink-0 text-3xs text-muted-foreground">Multi-root</span>
  ) : null;
}
