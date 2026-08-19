import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeVariables,
  type MobileThemeId,
} from "../../../lib/mobileTheme";

export type TaskAgentThemeMode = "light" | "dark";

export interface TaskAgentTextTheme {
  readonly foreground: string;
  readonly muted: string;
  readonly dim: string;
  readonly statedReason: string;
  readonly info: string;
  readonly success: string;
  readonly warn: string;
  readonly danger: string;
  readonly teal: string;
  readonly violet: string;
  readonly coral: string;
}

export interface TaskAgentTheme {
  readonly background: string;
  readonly card: string;
  readonly text: TaskAgentTextTheme;
}

const DARK_TASK_AGENT_THEME: TaskAgentTheme = {
  // Opaque --bg from mockup.css:42; CONTRAST.md:29-48 ranges from 17.8216:1 (--fg) to 4.8552:1 (--dim) here.
  background: "#0a0a0a",
  // Opaque --card from mockup.css:51; CONTRAST.md:30-48 ranges from 17.0987:1 (--fg) to 4.6583:1 (--dim) here.
  card: "#101013",
  text: {
    // --fg from mockup.css:44; CONTRAST.md:29-30: 17.8216:1 on --bg, 17.0987:1 on --card.
    foreground: "#f1f3f7",
    // --muted from mockup.css:45; CONTRAST.md:31-32: 7.8486:1 on --bg, 7.5302:1 on --card.
    muted: "#a3a3a3",
    // --dim from mockup.css:46; CONTRAST.md:33-34: 4.8552:1 on --bg, 4.6583:1 on --card.
    dim: "#787e8a",
    // The mandatory unavailable-control reason reuses --dim; CONTRAST.md:199-202: 4.6921:1 on the dark sheet composite, 4.6583:1 on --card.
    statedReason: "#787e8a",
    // --info from mockup.css:54; CONTRAST.md:35-36: 7.7871:1 on --bg, 7.4712:1 on --card.
    info: "#60a5fa",
    // --success from mockup.css:55; CONTRAST.md:37-38: 10.2985:1 on --bg, 9.8808:1 on --card.
    success: "#34d399",
    // --warn from mockup.css:56; CONTRAST.md:39-40: 11.8597:1 on --bg, 11.3786:1 on --card.
    warn: "#fbbf24",
    // --danger from mockup.css:57; CONTRAST.md:41-42: 7.1573:1 on --bg, 6.8670:1 on --card.
    danger: "#f87171",
    // --teal from mockup.css:58; CONTRAST.md:43-44: 10.6356:1 on --bg, 10.2042:1 on --card.
    teal: "#2dd4bf",
    // --violet from mockup.css:59; CONTRAST.md:45-46: 7.4926:1 on --bg, 7.1887:1 on --card.
    violet: "#c084fc",
    // --coral from mockup.css:60; CONTRAST.md:47-48: 6.4776:1 on --bg, 6.2149:1 on --card.
    coral: "#e0764e",
  },
};

const LIGHT_TASK_AGENT_THEME: TaskAgentTheme = {
  // Opaque --bg from mockup.css:87; CONTRAST.md:56-75 ranges from 16.5480:1 (--fg) to 4.6903:1 (--coral) here.
  background: "#f7f7f8",
  // Opaque --card from mockup.css:96; CONTRAST.md:57-75 ranges from 17.7168:1 (--fg) to 5.0216:1 (--coral) here.
  card: "#ffffff",
  text: {
    // --fg from mockup.css:89; CONTRAST.md:56-57: 16.5480:1 on --bg, 17.7168:1 on --card.
    foreground: "#18181b",
    // --muted from mockup.css:90; CONTRAST.md:58-59: 7.2199:1 on --bg, 7.7298:1 on --card.
    muted: "#52525b",
    // --dim from mockup.css:91; CONTRAST.md:60-61: 4.9335:1 on --bg, 5.2820:1 on --card.
    dim: "#6b6b73",
    // The mandatory unavailable-control reason reuses --dim; CONTRAST.md:199-202: 4.9126:1 on the light sheet composite, 5.2820:1 on --card.
    statedReason: "#6b6b73",
    // --info from mockup.css:99; CONTRAST.md:62-63: 6.2595:1 on --bg, 6.7016:1 on --card.
    info: "#1d4ed8",
    // --success from mockup.css:100; CONTRAST.md:64-65: 5.1221:1 on --bg, 5.4839:1 on --card.
    success: "#047857",
    // --warn from mockup.css:101; CONTRAST.md:66-67: 5.5360:1 on --bg, 5.9270:1 on --card.
    warn: "#8a5a00",
    // --danger from mockup.css:102; CONTRAST.md:68-69: 6.0432:1 on --bg, 6.4700:1 on --card.
    danger: "#b91c1c",
    // --teal from mockup.css:103; CONTRAST.md:70-71: 5.1122:1 on --bg, 5.4733:1 on --card.
    teal: "#0f766e",
    // --violet from mockup.css:104; CONTRAST.md:72-73: 6.5226:1 on --bg, 6.9833:1 on --card.
    violet: "#7e22ce",
    // --coral from mockup.css:105; CONTRAST.md:74-75: 4.6903:1 on --bg, 5.0216:1 on --card.
    coral: "#b45309",
  },
};

export const TASK_AGENT_THEMES: Readonly<Record<TaskAgentThemeMode, TaskAgentTheme>> = {
  dark: DARK_TASK_AGENT_THEME,
  light: LIGHT_TASK_AGENT_THEME,
};

function deriveTaskAgentTheme(mode: TaskAgentThemeMode, themeId: MobileThemeId): TaskAgentTheme {
  const variables = getMobileThemeVariables(themeId, mode);
  const taskTheme = TASK_AGENT_THEMES[mode];

  return {
    background: variables["--color-screen"],
    card: variables["--color-card"],
    text: {
      // Status colors remain task-specific so their meaning does not change with the app theme.
      ...taskTheme.text,
      foreground: variables["--color-foreground"],
      muted: variables["--color-foreground-secondary"],
      dim: variables["--color-foreground-muted"],
      statedReason: variables["--color-foreground-muted"],
    },
  };
}

export function getTaskAgentTheme(
  mode: TaskAgentThemeMode,
  themeId: MobileThemeId = DEFAULT_MOBILE_THEME_ID,
): TaskAgentTheme {
  return themeId === DEFAULT_MOBILE_THEME_ID
    ? TASK_AGENT_THEMES[mode]
    : deriveTaskAgentTheme(mode, themeId);
}
