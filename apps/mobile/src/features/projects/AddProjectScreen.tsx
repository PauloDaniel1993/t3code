import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Button } from "../../components/ui/Button";
import {
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  buildAddProjectRemoteSourceReadiness,
  buildProjectCreateCommand,
  canCreateProjectInEnvironment,
  findExistingAddProject,
  getAddProjectInitialQuery,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  getNewProjectPathPreview,
  getNewProjectPublishTarget,
  getNewProjectPublishTargets,
  getNewProjectRepository,
  defaultHostCloneUrl,
  normalizePastedCloneUrl,
  parseAddProjectRemoteSource,
  resolveAddProjectPath,
  resolveAddProjectKind,
  sortAddProjectProviderSources,
  type AddProjectRemoteSource,
} from "@t3tools/client-runtime/operations/projects";
import {
  connectionStatusText,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
} from "@t3tools/client-runtime/state/filesystem";
import {
  appendBrowsePathSegment,
  findProjectByWorkspaceFile,
  inferProjectTitleFromPath,
  isWindowsPlatform,
} from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  CommandId,
  type EnvironmentId,
  type EnvironmentMachineKind,
  ProjectId,
  type Project,
  FilesystemBrowseError,
  resolveEnvironmentMachineKind,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  StackActions,
  useNavigation,
  type NavigationState,
  type ParamListBase,
} from "@react-navigation/native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ListRow, ListSection, SectionTitle } from "./AddProjectList";
import { ServerPathBrowser as FolderBrowser } from "./ServerPathBrowser";
import { WorkspaceProjectFolders } from "./WorkspaceProjectFolders";
import {
  resolveMobileAddProjectTarget,
  workspaceFileActionError,
  workspaceFileMutationOutcome,
} from "./workspace-file-projects";
import { useProjects, useServerConfigs, waitForProject } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { SourceControlIcon } from "./SourceControlIcon";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { resolveAddProjectEnvironment } from "./AddProjectScreen.logic";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";

interface EnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platform: string;
  readonly machine: EnvironmentMachineKind;
  readonly baseDirectory: string | null;
  readonly newProjectsRoot: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly supportsCloneTracking: boolean;
  readonly workspaceFileProjects: boolean;
}

const isFilesystemBrowseError = Schema.is(FilesystemBrowseError);

const environmentOptionOrder = Order.mapInput(
  Order.Struct({
    label: Order.String,
  }),
  (environment: EnvironmentOption) => ({ label: environment.label }),
);

function platformFromOs(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

function stringParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function sourceFromParam(value: string | string[] | undefined): AddProjectRemoteSource {
  return parseAddProjectRemoteSource(stringParam(value));
}

function AddProjectShell(props: { readonly children: ReactNode; readonly title: string }) {
  const insets = useSafeAreaInsets();

  return (
    // A collapsible wrapper lets formSheet resizing mistake the full-height view for a header and collapse the ScrollView.
    <SettingsScreen title={props.title}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: Platform.OS === "android" ? 16 : 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: Platform.OS === "android" ? 16 : 10,
        }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}

function PrimaryActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress: () => void;
}) {
  return <Button {...props} tone="primary" fullWidth />;
}

function ProjectPathInput(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <TextInput
      className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
      value={props.value}
      editable={!props.disabled}
      accessibilityLabel="Project path on environment"
      onChangeText={props.onChangeText}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder="~/projects/my-app"
      returnKeyType="done"
      onSubmitEditing={props.onSubmit}
    />
  );
}

function useBrowsePathInput(
  environment: EnvironmentOption | null,
  pinnedDirectoryName = "",
  includeWorkspaceFiles = false,
) {
  const environmentId = environment?.environmentId ?? null;
  const environmentBaseDirectory = environment?.baseDirectory ?? null;
  const clonePathCaseSensitive = !isWindowsPlatform(environment?.platform ?? "");
  const [pathInput, commitPathInput] = useState(() =>
    getCloneDestinationPath(
      getAddProjectInitialQuery(environmentBaseDirectory),
      pinnedDirectoryName,
    ),
  );
  const previousEnvironmentIdRef = useRef(environmentId);
  const environmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const [browseNavigation] = useState(createBrowseNavigationCoordinator);
  const [isBrowseNavigating, setIsBrowseNavigating] = useState(false);
  const setPathInput = (path: string) => {
    browseNavigation.invalidate();
    setIsBrowseNavigating(false);
    commitPathInput(path);
  };
  const navigateToBrowsePath = async (input: {
    readonly browseDirectoryPath: string;
    readonly selectedDirectoryName?: string;
  }) => {
    const selectedDirectoryPath = input.selectedDirectoryName
      ? appendBrowsePathSegment(input.browseDirectoryPath, input.selectedDirectoryName)
      : input.browseDirectoryPath;
    const nextPathInput =
      pinnedDirectoryName && input.selectedDirectoryName
        ? getCloneDestinationBrowsePath({
            browseDirectoryPath: input.browseDirectoryPath,
            selectedDirectoryName: input.selectedDirectoryName,
            cloneDirectoryName: pinnedDirectoryName,
            caseSensitive: clonePathCaseSensitive,
          })
        : getCloneDestinationPath(selectedDirectoryPath, pinnedDirectoryName);
    setIsBrowseNavigating(true);
    const committed = await browseNavigation.run(
      async () => {
        if (
          environment &&
          readEnvironmentScope(environment.environmentId, AuthFilesystemReadScope) &&
          canPreloadBrowsePath(environmentRuntime?.connectionState)
        ) {
          await loadBrowsePath({
            environmentId: environment.environmentId,
            input: {
              partialPath: selectedDirectoryPath,
              ...(includeWorkspaceFiles ? { includeWorkspaceFiles: true } : {}),
            },
          });
        }
      },
      () => commitPathInput(nextPathInput),
    );
    if (committed) {
      setIsBrowseNavigating(false);
    }
    return committed;
  };

  useEffect(() => {
    if (environmentId !== null && environmentId !== previousEnvironmentIdRef.current) {
      previousEnvironmentIdRef.current = environmentId;
      setPathInput(
        getCloneDestinationPath(
          getAddProjectInitialQuery(environmentBaseDirectory),
          pinnedDirectoryName,
        ),
      );
    }
  }, [environmentBaseDirectory, environmentId, pinnedDirectoryName, setPathInput]);

  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  return { isBrowseNavigating, pathInput, setPathInput, navigateToBrowsePath };
}

function useEnvironmentOptions(
  selectedEnvironmentId: EnvironmentId | null = null,
): ReadonlyArray<EnvironmentOption> {
  const serverConfigByEnvironmentId = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { connectedEnvironments } = useRemoteConnectionStatus();

  return ((): ReadonlyArray<EnvironmentOption> => {
    const runtimeByEnvironmentId = new Map(
      connectedEnvironments.map((environment) => [environment.environmentId, environment] as const),
    );
    const options = Object.values(savedConnectionsById).map((connection) => {
      const config = serverConfigByEnvironmentId.get(connection.environmentId);
      const runtime = runtimeByEnvironmentId.get(connection.environmentId);
      return {
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        platform: platformFromOs(config?.environment.platform.os ?? null),
        machine: resolveEnvironmentMachineKind(config ?? null),
        baseDirectory: config?.settings.addProjectBaseDirectory ?? null,
        newProjectsRoot: config?.newProjectsRoot ?? null,
        connectionState: runtime?.connectionState ?? "available",
        connectionError: runtime?.connectionError ?? null,
        connectionErrorTraceId: runtime?.connectionErrorTraceId ?? null,
        supportsCloneTracking: config?.environment.capabilities.projectCloneTracking === true,
        workspaceFileProjects: config?.workspaceFileProjects === true,
      };
    });
    return Arr.sort(
      options.filter(
        (environment) =>
          canCreateProjectInEnvironment(environment.connectionState) ||
          environment.environmentId === selectedEnvironmentId,
      ),
      environmentOptionOrder,
    );
  })();
}

function useSelectedEnvironment(requestedEnvironmentId: EnvironmentId | null): {
  readonly environmentOptions: ReadonlyArray<EnvironmentOption>;
  readonly selectedEnvironment: EnvironmentOption | null;
  readonly setSelectedEnvironmentId: (environmentId: EnvironmentId) => void;
} {
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(requestedEnvironmentId);
  const [previousRequest, setPreviousRequest] = useState(requestedEnvironmentId);
  if (previousRequest !== requestedEnvironmentId) {
    setPreviousRequest(requestedEnvironmentId);
    setSelectedEnvironmentId(requestedEnvironmentId);
  }
  const environmentOptions = useEnvironmentOptions(selectedEnvironmentId);
  const selectedEnvironment =
    environmentOptions.find((environment) => environment.environmentId === selectedEnvironmentId) ??
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ??
    null;

  return {
    environmentOptions,
    selectedEnvironment,
    setSelectedEnvironmentId,
  };
}

function EmptyEnvironmentState() {
  const navigation = useNavigation();

  return (
    <View className="items-center gap-3 rounded-2xl bg-grouped-card px-5 py-8">
      <Text className="text-center text-lg font-t3-bold">Environment unavailable</Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        Start or reconnect an environment before adding a project.
      </Text>
      <View className="mt-1">
        <Button
          label="Add environment"
          tone="primary"
          onPress={() => navigation.dispatch(StackActions.replace("ConnectionsNew"))}
        />
      </View>
    </View>
  );
}

function SourceControlRow(props: {
  readonly source: AddProjectRemoteSource;
  readonly selectedEnvironmentId: EnvironmentId;
  readonly ready: boolean;
  readonly hint: string;
  readonly isFirst: boolean;
}) {
  const navigation = useNavigation();
  const title =
    props.source === "url" ? "Git URL" : `${addProjectRemoteSourceLabel(props.source)} repository`;
  const subtitle =
    props.source === "url"
      ? "Clone from a remote URL"
      : `Clone ${addProjectRemoteSourceLabel(props.source)} ${props.hint}`;
  const icon =
    props.source === "url" ? (
      <SymbolView
        name="link"
        size={Platform.OS === "android" ? 24 : 17}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    ) : (
      <SourceControlIcon
        icon={sourceControlClients.get(props.source).icon}
        size={Platform.OS === "android" ? 24 : 18}
        colorClassName="accent-icon"
      />
    );

  if (!props.ready) {
    return (
      <ListRow title={title} subtitle={props.hint} icon={icon} disabled isFirst={props.isFirst} />
    );
  }

  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      icon={icon}
      isFirst={props.isFirst}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("AddProjectRepository", {
            environmentId: props.selectedEnvironmentId,
            source: props.source,
          }),
        )
      }
    />
  );
}

export function AddProjectSourceScreen(props: { readonly environmentId?: string | string[] }) {
  const navigation = useNavigation();
  const { environmentOptions, selectedEnvironment, setSelectedEnvironmentId } =
    useSelectedEnvironment(stringParam(props.environmentId) as EnvironmentId | null);
  const canWriteSourceControl = useEnvironmentScope(
    selectedEnvironment?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canCreateProject = useEnvironmentScope(
    selectedEnvironment?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const isConnected = canCreateProjectInEnvironment(selectedEnvironment?.connectionState);
  const canCloneProject = isConnected && canWriteSourceControl && canCreateProject;
  const discoveryState = useEnvironmentQuery(
    selectedEnvironment === null || !isConnected
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: selectedEnvironment.environmentId,
          input: {},
        }),
  );
  const readiness = buildAddProjectRemoteSourceReadiness(discoveryState.data);

  return (
    <AddProjectShell title="Add project">
      {selectedEnvironment === null ? <EmptyEnvironmentState /> : null}

      {environmentOptions.length > 1 || (selectedEnvironment !== null && !isConnected) ? (
        <>
          <SectionTitle>Environments</SectionTitle>
          <ListSection>
            {environmentOptions.map((environment, index) => (
              <ListRow
                key={environment.environmentId}
                title={environment.label}
                subtitle={
                  canCreateProjectInEnvironment(environment.connectionState)
                    ? undefined
                    : connectionStatusText({
                        phase: environment.connectionState,
                        error: environment.connectionError,
                        traceId: environment.connectionErrorTraceId,
                      })
                }
                icon={
                  <EnvironmentMachineSymbol
                    kind={environment.machine}
                    size={Platform.OS === "android" ? 24 : 17}
                    tintColorClassName="accent-icon"
                  />
                }
                selected={environment.environmentId === selectedEnvironment?.environmentId}
                disabled={!canCreateProjectInEnvironment(environment.connectionState)}
                isFirst={index === 0}
                right={
                  environment.environmentId === selectedEnvironment?.environmentId ? (
                    <SymbolView
                      name="checkmark"
                      size={Platform.OS === "android" ? 20 : 14}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  ) : null
                }
                onPress={() => setSelectedEnvironmentId(environment.environmentId)}
              />
            ))}
          </ListSection>
        </>
      ) : null}

      {selectedEnvironment ? (
        <>
          <ListSection>
            {selectedEnvironment.newProjectsRoot !== null ? (
              <ListRow
                title="New project"
                subtitle="Start a new Git repository from a name"
                disabled={!isConnected}
                icon={
                  <SymbolView
                    name="plus"
                    size={Platform.OS === "android" ? 24 : 17}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                  />
                }
                isFirst
                onPress={() =>
                  navigation.dispatch(
                    StackActions.push("AddProjectNew", {
                      environmentId: selectedEnvironment.environmentId,
                    }),
                  )
                }
              />
            ) : null}
            <ListRow
              title={
                selectedEnvironment.workspaceFileProjects
                  ? "Folder or workspace file"
                  : "Local folder"
              }
              subtitle={
                !canCreateProject
                  ? "This connection cannot add projects."
                  : selectedEnvironment.workspaceFileProjects
                    ? "Browse on this environment"
                    : "Browse a folder on disk"
              }
              icon={
                <SymbolView
                  name="folder.badge.plus"
                  size={Platform.OS === "android" ? 24 : 17}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              }
              isFirst={selectedEnvironment.newProjectsRoot === null}
              disabled={!isConnected || !canCreateProject}
              onPress={() =>
                navigation.dispatch(
                  StackActions.push("AddProjectLocal", {
                    environmentId: selectedEnvironment.environmentId,
                  }),
                )
              }
            />
            {(["url", ...sortAddProjectProviderSources(readiness)] as AddProjectRemoteSource[]).map(
              (candidate) => (
                <SourceControlRow
                  key={candidate}
                  source={candidate}
                  selectedEnvironmentId={selectedEnvironment.environmentId}
                  ready={canCloneProject && readiness(candidate).ready}
                  hint={
                    !canCloneProject
                      ? "This connection cannot clone projects."
                      : readiness(candidate).ready
                        ? addProjectRemoteSourcePathHint(candidate)
                        : (readiness(candidate).hint ?? "")
                  }
                  isFirst={false}
                />
              ),
            )}
          </ListSection>
          {discoveryState.isPending ? (
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          ) : null}
        </>
      ) : null}
    </AddProjectShell>
  );
}

function getActiveRoute(navigation: {
  getState: () => NavigationState<ParamListBase> | undefined;
}) {
  const state = navigation.getState();
  return state?.routes[state.index];
}

function useOpenNewTaskDraft() {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const selectDetail = useSelectWorkspaceDetail();
  return (
    params: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      title: string;
      cloning?: "1";
      draftId?: string;
    },
    originRoute: NavigationState<ParamListBase>["routes"][number] | undefined,
  ) => {
    const activeRoute = getActiveRoute(navigation);
    // A warm link can change the task without replacing its native route key.
    if (
      !originRoute ||
      activeRoute?.key !== originRoute.key ||
      activeRoute.name !== originRoute.name ||
      activeRoute.params !== originRoute.params
    )
      return;
    selectDetail({ name: "Thread", params: { draft: params } });
  };
}

async function draftWithPrompt(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  prompt: string,
): Promise<string> {
  await waitForComposerDraftsLoaded();
  const draftId = createNewTaskDraft({ environmentId, projectId });
  setComposerDraftText(draftId, prompt);
  return draftId;
}

function useCreateProject(environment: EnvironmentOption | null) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const navigation = useNavigation();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const projects = useProjects();

  return async (workspaceRoot: string, originRoute = getActiveRoute(navigation)) => {
    if (
      !environment ||
      !canCreateProjectInEnvironment(environment.connectionState) ||
      !readEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope)
    ) {
      Dialog.alert(
        "Project not added",
        `This connection cannot add projects right now. Any existing files remain at ${workspaceRoot}.`,
      );
      return;
    }

    const existing = findExistingAddProject({
      projects,
      environmentId: environment.environmentId,
      path: workspaceRoot,
    });
    if (existing) {
      Dialog.alert("Project already exists", existing.title);
      openNewTaskDraft(
        {
          environmentId: existing.environmentId,
          projectId: existing.id,
          title: existing.title,
        },
        originRoute,
      );
      return;
    }

    const projectId = ProjectId.make(uuidv4());
    const command = buildProjectCreateCommand({
      commandId: CommandId.make(uuidv4()),
      projectId,
      workspaceRoot,
    });
    const result = await createProject({
      environmentId: environment.environmentId,
      input: command,
    });
    if (AsyncResult.isFailure(result)) {
      return result;
    }
    // A successful command can precede its project in the client store. The
    // draft treats a missing project as a reason to return to the chooser.
    const project = await waitForProject(
      { environmentId: environment.environmentId, projectId },
      15_000,
    );
    if (project === null) {
      Dialog.alert(
        "Project added",
        "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
      );
      return result;
    }
    openNewTaskDraft(
      {
        environmentId: environment.environmentId,
        projectId,
        title: inferProjectTitleFromPath(workspaceRoot),
      },
      originRoute,
    );
    return result;
  };
}

function useEnvironmentFromParam(
  environmentIdParam: string | string[] | undefined,
): EnvironmentOption | null {
  const environmentOptions = useEnvironmentOptions();
  const environmentId = stringParam(environmentIdParam) as EnvironmentId | null;
  return resolveAddProjectEnvironment(environmentOptions, environmentId);
}

export function AddProjectRepositoryScreen(props: {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
}) {
  const lookupRepositoryQuery = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const navigation = useNavigation();
  const environment = useEnvironmentFromParam(props.environmentId);
  const source = sourceFromParam(props.source);
  const [repositoryInput, setRepositoryInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookupRepository = async () => {
    if (!environment || repositoryInput.trim().length === 0 || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    const provider = addProjectRemoteSourceProvider(source);
    if (!provider) {
      const remoteUrl = normalizePastedCloneUrl(repositoryInput);
      navigation.dispatch(
        StackActions.push("AddProjectDestination", {
          environmentId: environment.environmentId,
          source,
          remoteUrl,
          repositoryTitle: remoteUrl,
          repositoryName: getCloneDirectoryName(remoteUrl),
        }),
      );
      setIsSubmitting(false);
      return;
    }

    const result = await lookupRepositoryQuery({
      environmentId: environment.environmentId,
      input: {
        provider,
        repository: repositoryInput.trim(),
      },
    });
    if (AsyncResult.isFailure(result)) {
      setError(errorMessage(Cause.squash(result.cause)));
    } else {
      const repository = result.value;
      navigation.dispatch(
        StackActions.push("AddProjectDestination", {
          environmentId: environment.environmentId,
          source,
          remoteUrl: getDefaultCloneUrl(repository),
          repositoryTitle: repository.nameWithOwner,
          repositoryName: getCloneDirectoryName(repository.nameWithOwner),
        }),
      );
    }
    setIsSubmitting(false);
  };

  return (
    <AddProjectShell title={source === "url" ? "Git URL" : addProjectRemoteSourceLabel(source)}>
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          <TextInput
            className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
            value={repositoryInput}
            onChangeText={setRepositoryInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={
              source === "url"
                ? (defaultHostCloneUrl("org/repo") ?? "https://example.com/org/repo.git")
                : addProjectRemoteSourcePathHint(source)
            }
            returnKeyType="next"
            onSubmitEditing={() => void lookupRepository()}
          />
          <PrimaryActionButton
            label={source === "url" ? "Continue" : "Lookup repository"}
            disabled={isSubmitting || repositoryInput.trim().length === 0}
            onPress={() => void lookupRepository()}
            loading={isSubmitting}
          />
        </>
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}

export function AddProjectNewScreen(props: { readonly environmentId?: string | string[] }) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const navigation = useNavigation();
  const environmentOptions = useEnvironmentOptions().filter(
    (option) => option.newProjectsRoot !== null,
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    () => stringParam(props.environmentId) as EnvironmentId | null,
  );
  const environment = resolveAddProjectEnvironment(environmentOptions, selectedEnvironmentId);
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const discoveryState = useEnvironmentQuery(
    environment === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: environment.environmentId,
          input: {},
        }),
  );
  const publishTargets = getNewProjectPublishTargets(discoveryState.data);
  const [name, setName] = useState("");
  const [publishes, setPublishes] = useState(false);
  const [publishKind, setPublishKind] = useState<SourceControlProviderKind | null>(null);
  const publishTarget = getNewProjectPublishTarget(publishTargets, publishKind);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const pathPreview =
    environment?.newProjectsRoot != null
      ? getNewProjectPathPreview(environment.newProjectsRoot, trimmedName)
      : null;

  const showMachines =
    environmentOptions.length > 1 || (environment === null && environmentOptions.length > 0);
  const machineRows = showMachines ? (
    <ListSection>
      {environmentOptions.map((option, index) => {
        const selected = option.environmentId === environment?.environmentId;
        return (
          <ListRow
            key={option.environmentId}
            title={option.label}
            icon={
              <EnvironmentMachineSymbol
                kind={option.machine}
                size={Platform.OS === "android" ? 24 : 17}
                tintColorClassName="accent-icon"
              />
            }
            selected={selected}
            disabled={isSubmitting}
            isFirst={index === 0}
            right={
              selected ? (
                <SymbolView
                  name="checkmark"
                  size={Platform.OS === "android" ? 20 : 14}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              ) : null
            }
            onPress={() => setSelectedEnvironmentId(option.environmentId)}
          />
        );
      })}
    </ListSection>
  ) : null;

  // State lags a render behind, so a double tap could start a second create.
  const submittingRef = useRef(false);
  const submit = async () => {
    if (!environment || trimmedName.length === 0 || submittingRef.current) return;
    const originRoute = getActiveRoute(navigation);
    submittingRef.current = true;
    setError(null);
    setIsSubmitting(true);
    const result = await createNew({
      environmentId: environment.environmentId,
      input: { name: trimmedName },
    });
    if (AsyncResult.isFailure(result)) {
      submittingRef.current = false;
      setIsSubmitting(false);
      setError(errorMessage(Cause.squash(result.cause)));
      return;
    }
    const { projectId, workspaceRoot, commitError } = result.value;
    if (commitError !== undefined) {
      Dialog.alert("Created without a first commit", commitError);
    }
    if (publishes && publishTarget !== null) {
      void publishRepository({
        environmentId: environment.environmentId,
        input: {
          cwd: workspaceRoot,
          provider: publishTarget.definition.kind,
          repository: getNewProjectRepository(publishTarget, workspaceRoot),
          visibility: "private",
        },
      }).then((publishResult) => {
        if (AsyncResult.isFailure(publishResult)) {
          Dialog.alert(
            `Could not create the ${publishTarget.definition.label} repository`,
            errorMessage(Cause.squash(publishResult.cause)),
          );
        }
      });
    }
    // The draft screen resolves its project from the client store, so it
    // must not open before the create event has arrived.
    const project = await waitForProject(
      { environmentId: environment.environmentId, projectId },
      15_000,
    );
    submittingRef.current = false;
    setIsSubmitting(false);
    if (project === null) {
      setName("");
      setError(
        "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
      );
      return;
    }
    openNewTaskDraft(
      {
        environmentId: environment.environmentId,
        projectId,
        title: trimmedName,
      },
      originRoute,
    );
  };

  return (
    <AddProjectShell title="New project">
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          <TextInput
            className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
            value={name}
            onChangeText={setName}
            autoCorrect={false}
            autoFocus
            placeholder="Project name"
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
          {pathPreview !== null ? (
            <Text className="px-1 text-sm leading-snug text-foreground-muted" numberOfLines={2}>
              {trimmedName.length > 0
                ? `Creates ${pathPreview}`
                : `Goes in ${environment.newProjectsRoot}`}
              {showMachines ? ` on ${environment.label}` : null}
            </Text>
          ) : null}
          {machineRows}
          {publishTarget !== null ? (
            <ListSection>
              <ListRow
                title={`Create private repository on ${publishTarget.definition.label}`}
                subtitle={
                  trimmedName.length > 0 && pathPreview !== null
                    ? getNewProjectRepository(publishTarget, pathPreview)
                    : publishTarget.owner
                }
                icon={
                  <SourceControlIcon
                    icon={publishTarget.definition.icon}
                    size={Platform.OS === "android" ? 24 : 18}
                    colorClassName="accent-icon"
                  />
                }
                isFirst
                right={
                  <ThemedSwitch
                    accessibilityLabel={`Create private repository on ${publishTarget.definition.label}`}
                    value={publishes}
                    onValueChange={setPublishes}
                  />
                }
                onPress={() => setPublishes((current) => !current)}
              />
              {publishes && publishTargets.length > 1
                ? publishTargets.map((target) => {
                    const selected = target.definition.kind === publishTarget.definition.kind;
                    return (
                      <ListRow
                        key={target.definition.kind}
                        title={target.definition.label}
                        icon={
                          <SourceControlIcon
                            icon={target.definition.icon}
                            size={Platform.OS === "android" ? 24 : 17}
                            colorClassName="accent-icon"
                          />
                        }
                        selected={selected}
                        disabled={isSubmitting}
                        right={
                          selected ? (
                            <SymbolView
                              name="checkmark"
                              size={Platform.OS === "android" ? 20 : 14}
                              tintColorClassName="accent-icon"
                              type="monochrome"
                            />
                          ) : null
                        }
                        onPress={() => setPublishKind(target.definition.kind)}
                      />
                    );
                  })
                : null}
            </ListSection>
          ) : null}
          <PrimaryActionButton
            label="Create project"
            disabled={isSubmitting || trimmedName.length === 0}
            onPress={() => void submit()}
            loading={isSubmitting}
          />
          <ListSection>
            <ListRow
              title="Add existing project"
              subtitle="Open a folder or clone a repository"
              icon={
                <SymbolView
                  name="folder.badge.plus"
                  size={Platform.OS === "android" ? 24 : 17}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              }
              isFirst
              onPress={() =>
                navigation.canGoBack()
                  ? navigation.goBack()
                  : navigation.dispatch(StackActions.replace("AddProject"))
              }
            />
          </ListSection>
        </>
      ) : environmentOptions.length > 0 ? (
        machineRows
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}

export function AddProjectLocalFolderScreen(props: { readonly environmentId?: string | string[] }) {
  const environment = useEnvironmentFromParam(props.environmentId);
  const canCreateProject = useEnvironmentScope(
    environment?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const createProject = useCreateProject(environment);
  const navigation = useNavigation();
  const openNewTaskDraft = useOpenNewTaskDraft();
  const projects = useProjects();
  const importWorkspaceFile = useAtomCommand(projectEnvironment.importWorkspaceFile, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const browse = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    refresh: true,
  });
  const { isBrowseNavigating, navigateToBrowsePath, pathInput, setPathInput } = useBrowsePathInput(
    environment,
    "",
    environment?.workspaceFileProjects === true,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedProject, setSavedProject] = useState<Project | EnvironmentProject | null>(null);
  const [linkExisting, setLinkExisting] = useState(false);
  const [linkProjectId, setLinkProjectId] = useState<ProjectId | null>(null);
  const enabled = environment?.workspaceFileProjects === true;
  const workspaceFileInput = enabled && resolveAddProjectKind(pathInput, null) === "workspace-file";
  const displayedProject =
    savedProject === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === environment?.environmentId &&
            project.id === savedProject.id &&
            project.updatedAt >= savedProject.updatedAt,
        ) ?? savedProject);
  const plainProjects = projects.filter(
    (project) =>
      project.environmentId === environment?.environmentId && project.workspaceFile == null,
  );

  const submitPath = async () => {
    if (!environment || !canCreateProject || isBrowseNavigating || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    const error = await workspaceFileActionError(async () => {
      const resolved = resolveAddProjectPath({
        rawPath: pathInput,
        platform: environment.platform,
      });
      if (!resolved.ok) throw new Error(resolved.error);
      if (resolveAddProjectKind(pathInput, null) === "directory") {
        const result = await createProject(resolved.path);
        if (result?._tag === "Failure") throw squashAtomCommandFailure(result);
        return;
      }
      const listing = await browse({
        environmentId: environment.environmentId,
        input: {
          partialPath: pathInput.trim(),
          ...(enabled ? { includeWorkspaceFiles: true } : {}),
        },
      });
      if (listing._tag === "Failure") {
        const failure = squashAtomCommandFailure(listing);
        if (!isFilesystemBrowseError(failure) || failure.failure !== "read_directory_failed")
          throw failure;
      }
      const target = resolveMobileAddProjectTarget({
        path: pathInput,
        platform: environment.platform,
        workspaceFileProjects: enabled,
        browse: listing._tag === "Success" ? listing.value : null,
      });
      if (target.kind === "directory") {
        if (linkExisting && workspaceFileInput)
          throw new Error("The selected path is a folder. Choose a workspace file to link.");
        const result = await createProject(target.path);
        if (result?._tag === "Failure") throw squashAtomCommandFailure(result);
        return;
      }
      const existing = findProjectByWorkspaceFile(
        projects.filter((project) => project.environmentId === environment.environmentId),
        target.path,
      );
      if (existing) {
        setSavedProject(existing);
        return;
      }
      const selected = plainProjects.find((project) => project.id === linkProjectId);
      if (linkExisting && !selected) throw new Error("Choose an existing project to link.");
      const result =
        linkExisting && selected
          ? await updateProject({
              environmentId: environment.environmentId,
              input: { projectId: selected.id, workspaceFilePath: target.path },
            })
          : await importWorkspaceFile({
              environmentId: environment.environmentId,
              input: { projectId: ProjectId.make(uuidv4()), workspaceFilePath: target.path },
            });
      const outcome = workspaceFileMutationOutcome(result, !linkExisting);
      const project =
        outcome.project ??
        (await waitForProject({
          environmentId: environment.environmentId,
          projectId: outcome.projectId,
        }));
      if (project === null)
        throw new Error(
          "The project is saved on the environment but has not reached this device yet. It will appear in the project list once the connection catches up.",
        );
      setSavedProject(project);
    });
    if (error !== null) setError(error);
    setIsSubmitting(false);
  };
  const continueToProject = async () => {
    if (!environment || !savedProject || isSubmitting) return;
    const originRoute = getActiveRoute(navigation);
    setIsSubmitting(true);
    const error = await workspaceFileActionError(async () => {
      const project = await waitForProject({
        environmentId: environment.environmentId,
        projectId: savedProject.id,
      });
      if (project === null)
        throw new Error(
          "The project is saved but has not reached this device yet. Try opening it once the connection catches up.",
        );
      openNewTaskDraft(
        { environmentId: environment.environmentId, projectId: project.id, title: project.title },
        originRoute,
      );
    });
    if (error !== null) setError(error);
    setIsSubmitting(false);
  };

  return (
    <AddProjectShell title={enabled ? "Folder or workspace file" : "Local folder"}>
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        savedProject ? (
          <>
            <Text className="text-lg font-t3-bold">{displayedProject!.title}</Text>
            <WorkspaceProjectFolders
              project={displayedProject!}
              environmentId={environment.environmentId}
              enabled={enabled}
            />
            <PrimaryActionButton
              label="Open project"
              disabled={isSubmitting}
              loading={isSubmitting}
              onPress={() => void continueToProject()}
            />
          </>
        ) : (
          <>
            {!canCreateProject ? (
              <ErrorBanner message="This connection cannot add projects." />
            ) : null}
            <ProjectPathInput
              value={pathInput}
              onChangeText={setPathInput}
              onSubmit={() => void submitPath()}
              disabled={isSubmitting}
            />
            {workspaceFileInput && plainProjects.length > 0 ? (
              <>
                <Button
                  label={
                    linkExisting
                      ? "Import as a new project instead"
                      : "Link existing project instead"
                  }
                  tone="text"
                  disabled={isSubmitting}
                  onPress={() => setLinkExisting(!linkExisting)}
                />
                {linkExisting ? (
                  <>
                    <Text className="text-sm text-foreground-muted">
                      The workspace file must list the chosen project's folder first. Its title,
                      settings, and history are kept.
                    </Text>
                    <ListSection>
                      {plainProjects.map((project, index) => (
                        <ListRow
                          key={project.id}
                          title={project.title}
                          subtitle={project.workspaceRoot}
                          icon={
                            <SymbolView
                              name="folder"
                              size={20}
                              tintColorClassName="accent-icon-muted"
                            />
                          }
                          selected={project.id === linkProjectId}
                          disabled={isSubmitting}
                          isFirst={index === 0}
                          onPress={() => setLinkProjectId(project.id)}
                        />
                      ))}
                    </ListSection>
                  </>
                ) : null}
              </>
            ) : null}
            <PrimaryActionButton
              label="Add project"
              disabled={!canCreateProject || isBrowseNavigating || isSubmitting}
              onPress={() => void submitPath()}
              loading={isSubmitting}
            />
            <FolderBrowser
              environment={environment}
              navigateToBrowsePath={navigateToBrowsePath}
              pathInput={pathInput}
              setPathInput={setPathInput}
              includeWorkspaceFiles={enabled}
              disabled={isSubmitting}
            />
          </>
        )
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}
export function AddProjectDestinationScreen(props: {
  readonly environmentId?: string | string[];
  readonly remoteUrl?: string | string[];
  readonly repositoryTitle?: string | string[];
  readonly repositoryName?: string | string[];
  readonly prompt?: string | string[];
}) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const navigation = useNavigation();
  const environment = useEnvironmentFromParam(props.environmentId);
  const canWriteSourceControl = useEnvironmentScope(
    environment?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canCreateProject = useEnvironmentScope(
    environment?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canCloneProject = canWriteSourceControl && canCreateProject;
  const createProject = useCreateProject(environment);
  const remoteUrl = stringParam(props.remoteUrl);
  const repositoryTitle = stringParam(props.repositoryTitle);
  const prompt = stringParam(props.prompt);
  const repositoryName = stringParam(props.repositoryName)?.trim() ?? "";
  const { isBrowseNavigating, navigateToBrowsePath, pathInput, setPathInput } = useBrowsePathInput(
    environment,
    repositoryName,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitPath = async () => {
    if (
      !environment ||
      !readEnvironmentScope(environment.environmentId, AuthSourceControlWriteScope) ||
      !readEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope) ||
      !remoteUrl ||
      isBrowseNavigating ||
      isSubmitting
    ) {
      return;
    }
    setError(null);
    const resolved = resolveAddProjectPath({
      rawPath: pathInput,
      currentProjectCwd: null,
      platform: environment.platform,
    });
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }

    const originRoute = getActiveRoute(navigation);
    setIsSubmitting(true);
    if (environment.supportsCloneTracking) {
      const projectId = ProjectId.make(uuidv4());
      const title = inferProjectTitleFromPath(resolved.path);
      const startResult = await startProjectClone({
        environmentId: environment.environmentId,
        input: {
          projectId,
          title,
          createdAt: new Date().toISOString(),
          remoteUrl,
          destinationPath: resolved.path,
        },
      });
      if (AsyncResult.isFailure(startResult)) {
        setError(errorMessage(Cause.squash(startResult.cause)));
      } else {
        // Wait for the create event; the client store otherwise falls back to the project picker and loses clone controls.
        const project = await waitForProject(
          { environmentId: environment.environmentId, projectId },
          15_000,
        );
        if (project === null) {
          setError(
            "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
          );
        } else {
          openNewTaskDraft(
            {
              environmentId: environment.environmentId,
              projectId,
              title,
              cloning: "1",
              ...(prompt
                ? await draftWithPrompt(environment.environmentId, projectId, prompt).then(
                    (draftId) => ({ draftId }),
                    () => ({}),
                  )
                : {}),
            },
            originRoute,
          );
        }
      }
      setIsSubmitting(false);
      return;
    }
    const cloneResult = await cloneRepository({
      environmentId: environment.environmentId,
      input: {
        remoteUrl,
        destinationPath: resolved.path,
      },
    });
    if (AsyncResult.isFailure(cloneResult)) {
      setError(errorMessage(Cause.squash(cloneResult.cause)));
    } else {
      const createResult = await createProject(cloneResult.value.cwd, originRoute);
      if (createResult && AsyncResult.isFailure(createResult)) {
        setError(errorMessage(Cause.squash(createResult.cause)));
      }
    }
    setIsSubmitting(false);
  };

  return (
    <AddProjectShell title="Clone destination">
      {error ? <ErrorBanner message={error} /> : null}
      {repositoryTitle ? (
        <View className="rounded-[24px] bg-grouped-card px-4 py-3">
          <Text className="text-base font-t3-bold">{repositoryTitle}</Text>
          <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={2}>
            {remoteUrl}
          </Text>
        </View>
      ) : null}
      {environment ? (
        <>
          <ProjectPathInput value={pathInput} onChangeText={setPathInput} onSubmit={submitPath} />
          <PrimaryActionButton
            label="Clone project"
            disabled={!canCloneProject || isBrowseNavigating || isSubmitting || !remoteUrl}
            onPress={submitPath}
            loading={isSubmitting}
          />
          {!canCloneProject ? (
            <Text className="text-sm text-foreground-muted">
              This connection cannot clone projects.
            </Text>
          ) : null}
          <FolderBrowser
            environment={environment}
            navigateToBrowsePath={navigateToBrowsePath}
            pathInput={pathInput}
            setPathInput={setPathInput}
            pinnedDirectoryName={repositoryName}
          />
        </>
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}
