import { type EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { desktopLocalBackendId, isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { readLocalApi } from "../localApi";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";

/** Native paths are offered only when the desktop can address the selected environment. */
export function useWorkspaceFileNativePicker(environmentId: EnvironmentId) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bootstraps = useDesktopLocalBootstraps();
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const desktopInstanceId =
    environment && isDesktopLocalConnectionTarget(environment.entry.target)
      ? (bootstraps.find((bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl)?.id ??
        null)
      : null;
  const available =
    typeof window !== "undefined" &&
    typeof window.desktopBridge?.pickWorkspaceFile === "function" &&
    (environmentId === primaryEnvironmentId || desktopInstanceId !== null);

  return available
    ? async (initialPath: string) => {
        const api = readLocalApi();
        if (!api) return null;
        const bridge = window.desktopBridge;
        const configuration = (await bridge?.getWslState().catch(() => null)) ?? null;
        const target = resolveProjectPickerTarget({
          browseEnvironmentId: environmentId,
          primaryEnvironmentId,
          desktopInstanceId,
          wslConfiguration: configuration,
        });
        const picked = await api.dialogs.pickWorkspaceFile({
          initialPath,
          ...(target ? { targetEnvironmentId: target } : {}),
        });
        if (!picked || !parseWslUncPath(picked)) return picked;
        const primaryRunningDistro =
          bridge
            ?.getLocalEnvironmentBootstraps()
            .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
          null;
        const selection = resolveWslProjectSelection(
          picked,
          applyWslEnvironmentConfiguration(
            environments.flatMap((candidate) => {
              const backendId = desktopLocalBackendId(candidate.entry.target);
              return backendId
                ? [
                    {
                      environmentId: candidate.environmentId,
                      backendId,
                      runningDistro:
                        bootstraps.find(
                          (bootstrap) => bootstrap.httpBaseUrl === candidate.displayUrl,
                        )?.runningDistro ?? null,
                    },
                  ]
                : [];
            }),
            primaryEnvironmentId,
            configuration,
            primaryRunningDistro,
          ),
        );
        if (!selection || selection.environmentId !== environmentId)
          throw new Error(
            "Choose a workspace file on the selected environment, or select its WSL environment first.",
          );
        return selection.linuxPath;
      }
    : null;
}
