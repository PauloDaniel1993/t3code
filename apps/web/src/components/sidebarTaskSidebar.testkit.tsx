import { vi } from "vite-plus/test";
import type { ReactNode } from "react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

const sidebarHarness = vi.hoisted(() => ({
  threads: [] as ReadonlyArray<EnvironmentThreadShell>,
  projects: [] as ReadonlyArray<EnvironmentProject>,
  enabled: true,
  menu: vi.fn(async (_items: unknown, _position: unknown) => "delete"),
  remove: vi.fn(async () => ({ _tag: "Success" as const })),
  archive: vi.fn(async () => ({ _tag: "Success" as const })),
  selection: [] as Array<{ threadKey: string; thread: EnvironmentThreadShell }>,
}));
vi.mock("./Sidebar.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Sidebar.logic")>();
  return {
    ...actual,
    selectRenderedSidebarThreads: (
      ...args: [ReadonlyArray<string>, ReadonlyMap<string, EnvironmentThreadShell>]
    ) => {
      const result = actual.selectRenderedSidebarThreads(...args);
      sidebarHarness.selection = result;
      return result;
    },
  };
});
vi.mock("../state/entities", () => ({
  useThreadShells: () => sidebarHarness.threads,
  useProjects: () => sidebarHarness.projects,
  useAllEnvironmentProjectSnapshotsReady: () => false,
  readThreadShell: () => null,
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: "configs",
  primaryServerKeybindingsAtom: "bindings",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "configs" ? config : atom === "bindings" ? [] : snapshots,
}));
const config = new Map([
  ["local", { environment: { capabilities: { threadTasks: true } }, providers: [], settings: {} }],
]);
const snapshots = new Map();
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      selector({
        ...DEFAULT_CLIENT_SETTINGS,
        threadTasksEnabled: sidebarHarness.enabled,
        confirmThreadDelete: false,
      }),
  };
});
vi.mock("../state/environments", () => ({
  useEnvironmentIdentities: () => identities,
  useConnectedEnvironmentIds: () => [],
  useEnvironmentMachines: () => machines,
  usePrimaryEnvironmentId: () => "local",
}));
const identities = [{ environmentId: "local", label: "Local" }];
const machines = new Map();
vi.mock("../state/threads", () => ({ threadEnvironment: {}, environmentThreadDetails: {} }));
vi.mock("../state/vcs", () => ({ vcsEnvironment: {} }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, dataUpdatedAt: 0 }),
}));
vi.mock("../state/queries", () => ({ useThreadSearch: () => ({ matches: [] }) }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => noop }));
const noop = () => {};
vi.mock("../state/terminalSessions", () => ({ useThreadRunningTerminalIds: () => emptyIds }));
const emptyIds: string[] = [];
vi.mock("../hooks/useThreadActions", () => ({ useThreadActions: () => actions }));
const actions = {
  archiveThread: sidebarHarness.archive,
  deleteThread: sidebarHarness.remove,
  settleThread: noop,
  unsettleThread: noop,
  snoozeThread: noop,
  unsnoozeThread: noop,
  pinThread: noop,
  unpinThread: noop,
  confirmAndUnpinThread: noop,
  setThreadAutoSettle: noop,
  reorderPinnedThread: noop,
  reorderActiveThread: noop,
  markThreadUnread: noop,
};
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: noop }),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: noop }),
}));
vi.mock("../hooks/useTerminalFocus", () => ({ useTerminalFocus: () => false }));
vi.mock("../hooks/useNowMinute", () => ({ useNowMinute: () => minute }));
const minute = 1_800_000_000_000;
vi.mock("../shortcutModifierState", () => ({
  useShortcutModifierState: () => ({ alt: false, ctrl: false, meta: false, shift: false }),
}));
vi.mock("../hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => noop }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: noop }));
vi.mock("../composerDraftStore", () => ({
  useThreadHasUnsentDraft: () => false,
  composerDraftHasUserContent: () => false,
  useComposerDraftStore: (selector: (state: typeof drafts) => unknown) => selector(drafts),
}));
const drafts = {
  draftThreadsByThreadKey: {},
  draftsByThreadKey: {},
  clearComposerContent: noop,
  clearDraftThread: noop,
};
vi.mock("@tanstack/react-router", () => ({ useParams: () => null, useRouter: () => router }));
const router = { navigate: noop, state: { location: { pathname: "/" } } };
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: sidebarHarness.menu },
    dialogs: { confirm: async () => true },
  }),
}));
vi.mock("./SidebarTaskPeek", () => ({
  SidebarTaskPeek: () => null,
  closeSidebarTaskPeek: noop,
  leaveSidebarTaskPeek: noop,
  openSidebarTaskPeek: noop,
}));
vi.mock("./sidebarTaskPresentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebarTaskPresentation")>()),
  useSidebarTaskProjection: () => null,
}));
vi.mock("./ThreadHoverCard", () => ({
  ThreadHoverCard: ({ children }: { children: ReactNode }) => children,
  ThreadHoverCardPopup: () => null,
}));
vi.mock("./ThreadStatusIndicators", () => ({
  threadChangeRequestSnapshotsAtom: "snapshots",
  setThreadChangeRequestSnapshot: noop,
  ThreadPullRequestBadgeControl: () => null,
  ThreadPullRequestsMiniList: () => null,
  ThreadWorktreeIndicator: () => null,
  nextThreadChangeRequestSnapshot: () => null,
  prStatusIndicator: () => null,
  resolveThreadPullRequestBadge: () => null,
  terminalStatusFromRunningIds: () => null,
  synchronizeTerminalPulse: noop,
  useLinkedThreadPullRequest: () => null,
}));
vi.mock("./Sidebar.motion", () => ({
  createSidebarListMotion: () => ({ dispose: noop, update: noop, release: noop, suspend: noop }),
}));
vi.mock("./chat/ThreadContextDragGhost", () => ({ ThreadContextDragGhost: () => null }));
vi.mock("./chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: noop }),
  SidebarContent: ({ fixedHeader, children }: { fixedHeader: ReactNode; children: ReactNode }) => (
    <div>
      {fixedHeader}
      {children}
    </div>
  ),
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));
vi.mock("./sidebar/SidebarThreadHeader", () => ({
  SidebarHeaderIconButton: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  SidebarThreadHeader: ({
    onSearchQueryChange,
  }: {
    onSearchQueryChange: (value: string) => void;
  }) => (
    <input
      aria-label="Search threads"
      onChange={(event) => onSearchQueryChange(event.target.value)}
    />
  ),
}));
vi.mock("./ui/combobox", () => ({
  useComboboxFilter: () => ({ contains: () => true }),
  Combobox: () => null,
  ComboboxEmpty: () => null,
  ComboboxSearchInput: () => null,
  ComboboxItem: () => null,
  ComboboxList: () => null,
  ComboboxPopup: () => null,
  ComboboxTrigger: () => null,
}));
vi.mock("./ui/tooltip", async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipProvider: ({ children }: { children: ReactNode }) => children,
    TooltipPopup: () => null,
    TooltipTrigger: ({
      render,
      children,
    }: {
      render: React.ReactElement<{ children?: ReactNode }>;
      children: ReactNode;
    }) => cloneElement(render, {}, children),
  };
});
vi.mock("./ui/collapsible-section-header", () => ({
  CollapsibleSectionHeader: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("./ui/menu", () => ({
  Menu: () => null,
  MenuItem: () => null,
  MenuPopup: () => null,
  MenuSeparator: () => null,
  MenuShortcut: () => null,
  MenuTrigger: () => null,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: noop },
  stackedThreadToast: (input: unknown) => input,
}));

export function getSidebarHarness() {
  return sidebarHarness;
}
