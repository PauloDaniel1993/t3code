import { describe, expect, it } from "vite-plus/test";

import {
  parseWayfinderMap,
  parseWayfinderMaps,
  type WayfinderMarkdownFile,
  type WayfinderMapSource,
} from "./WayfinderMarkdown.ts";

const defaultMap = [
  "# Test map",
  "",
  "## Destination",
  "",
  "Reach a sound decision.",
  "",
  "## Notes",
  "",
  "Keep the evidence attached.",
].join("\n");

function ticket(relativePath: string, contents: string, truncated = false): WayfinderMarkdownFile {
  return { relativePath, contents, truncated };
}

function source(
  tickets: ReadonlyArray<WayfinderMarkdownFile>,
  mapContents = defaultMap,
  overrides: Partial<WayfinderMapSource> = {},
): WayfinderMapSource {
  return {
    id: "test-map",
    map: { relativePath: ".plan/test-map/map.md", contents: mapContents },
    tickets,
    ...overrides,
  };
}

function parseSingleTicket(contents: string) {
  return parseWayfinderMap(source([ticket(".plan/test-map/tickets/01-question.md", contents)])).map
    .nodes[0];
}

describe("WayfinderMarkdown", () => {
  describe("derived status", () => {
    it.each([
      {
        name: "answer prose resolves a ticket",
        contents: "# Question\n\n## Answer\n\nUse the smaller model.",
        expected: "resolved",
      },
      {
        name: "resolution prose resolves a ticket",
        contents: "# Question\n\n## Resolution\n\nKeep the adapter pure.",
        expected: "resolved",
      },
      {
        name: "a bare answer heading stays open",
        contents: "# Question\n\n## Answer\n\n   \n",
        expected: "open",
      },
      {
        name: "an answer immediately followed by another heading stays open",
        contents: "# Question\n\n## Answer\n\n## Notes\n\nStill investigating.",
        expected: "open",
      },
      {
        name: "a placeholder and comment under answer stay open",
        contents: "# Question\n\n## Answer\n\n<!-- fill this in -->\n<answer goes here>",
        expected: "open",
      },
      {
        name: "ruled-out prose outranks answer prose",
        contents:
          "# Question\n\n## Answer\n\nOne answer.\n\n## Ruled out\n\nOutside the destination.",
        expected: "out_of_scope",
      },
      {
        name: "a bare ruled-out heading does not outrank a resolution",
        contents: "# Question\n\n## Ruled out\n\n## Resolution\n\nA real resolution.",
        expected: "resolved",
      },
      {
        name: "claimed_by claims an otherwise open ticket",
        contents: "# Question\n\n**Claimed by:** session-7\n\n## Question\n\nWhat next?",
        expected: "claimed",
      },
      {
        name: "answer prose outranks claimed_by",
        contents: "# Question\n\n**Claimed by:** session-7\n\n## Answer\n\nThe answer is complete.",
        expected: "resolved",
      },
      {
        name: "legacy closed status resolves a field-line ticket",
        contents: "# Question\n\n**Status:** closed\n\n## Question\n\nWhat next?",
        expected: "resolved",
      },
    ])("$name", ({ contents, expected }) => {
      expect(parseSingleTicket(contents)?.status).toBe(expected);
    });

    it.each([
      {
        name: "an empty plain Status line stays open",
        status: "",
        body: "## Question\n\nWhat next?",
        expected: "open",
      },
      {
        name: "plain claimed status claims a ticket",
        status: "claimed",
        body: "## Question\n\nWhat next?",
        expected: "claimed",
      },
      {
        name: "plain resolved status resolves a ticket",
        status: "resolved",
        body: "## Question\n\nWhat next?",
        expected: "resolved",
      },
      {
        name: "answer prose outranks plain claimed status",
        status: "claimed",
        body: "## Answer\n\nThe decision is complete.",
        expected: "resolved",
      },
      {
        name: "ruled-out prose outranks plain resolved status",
        status: "resolved",
        body: "## Ruled out\n\nOutside the destination.",
        expected: "out_of_scope",
      },
    ])("$name", ({ status, body, expected }) => {
      const contents = [
        "# Question",
        "",
        "Type: task",
        `Status: ${status}`,
        "Blocked by:",
        "",
        body,
      ].join("\n");

      expect(parseSingleTicket(contents)?.status).toBe(expected);
    });
  });

  it.each([
    {
      name: "backtick fence",
      contents: ["# Question", "", "```markdown", "## Answer", "Not an answer.", "```"].join("\n"),
    },
    {
      name: "tilde fence",
      contents: ["# Question", "", "~~~markdown", "## Answer", "Not an answer.", "~~~"].join("\n"),
    },
    {
      name: "four-backtick fence containing a three-backtick fence",
      contents: [
        "# Question",
        "",
        "````markdown",
        "```",
        "## Answer",
        "Not an answer.",
        "```",
        "````",
      ].join("\n"),
    },
  ])("ignores structural-looking content in a $name", ({ contents }) => {
    expect(parseSingleTicket(contents)?.status).toBe("open");
  });

  it("does not read field metadata from a fence", () => {
    const node = parseSingleTicket(
      ["# Question", "", "```markdown", "**Claimed by:** phantom-session", "```"].join("\n"),
    );

    expect(node?.claimedBy).toBeNull();
    expect(node?.status).toBe("open");
  });

  it("keeps fenced plain-line status and answer content transparent", () => {
    const parsed = parseWayfinderMap(
      source([
        ticket(
          ".scratch/test-map/issues/05-documented-format.md",
          [
            "# Documented format",
            "",
            "Type: task",
            "Status:",
            "Blocked by:",
            "",
            "```markdown",
            "Status: resolved",
            "## Answer",
            "This is an example, not the ticket answer.",
            "```",
          ].join("\n"),
        ),
      ]),
    );

    expect(parsed.map.dialect).toBe("plain-lines");
    expect(parsed.map.nodes[0]).toMatchObject({
      status: "open",
      isFrontier: true,
    });
  });

  it("resolves zero-padded string and numeric blocker lists identically", () => {
    const baseTickets = [
      ticket(
        ".plan/test-map/tickets/02-first.md",
        ["---", "type: research", "blocked_by: []", "---", "# First"].join("\n"),
      ),
      ticket(
        ".plan/test-map/tickets/03-second.md",
        ["---", "type: prototype", "blocked_by: []", "---", "# Second"].join("\n"),
      ),
    ];
    const padded = parseWayfinderMap(
      source([
        ...baseTickets,
        ticket(
          ".plan/test-map/tickets/04-dependent.md",
          ["---", "type: task", "blocked_by: [02, 03]", "---", "# Dependent"].join("\n"),
        ),
      ]),
    );
    const numeric = parseWayfinderMap(
      source([
        ...baseTickets,
        ticket(
          ".plan/test-map/tickets/04-dependent.md",
          ["---", "type: task", "blocked_by: [2, 3]", "---", "# Dependent"].join("\n"),
        ),
      ]),
    );

    expect(padded.map.edges).toEqual([
      { from: "02", to: "04", kind: "blocks" },
      { from: "03", to: "04", kind: "blocks" },
    ]);
    expect(numeric.map.edges).toEqual(padded.map.edges);
  });

  it("drops an unresolved blocker and emits a lint naming the referencing ticket", () => {
    const parsed = parseWayfinderMap(
      source([
        ticket(
          ".plan/test-map/tickets/04-dependent.md",
          ["---", "type: task", "blocked_by: [99]", "---", "# Dependent"].join("\n"),
        ),
      ]),
    );

    expect(parsed.map.edges).toEqual([]);
    expect(parsed.lints).toContainEqual({
      code: "unresolved_blocker",
      message: "Ticket 04 references unresolved blocker 99.",
      mapId: "test-map",
      ticketId: "04",
    });
  });

  // The frontier answers "what can I pick up right now", so a ticket someone
  // has already claimed is not on it even when nothing blocks it. This matches
  // the wayfinder skill's own definition (open, unblocked, AND unclaimed) and
  // is the one place our derived status and the frontier disagree, so it is
  // pinned here in every dialect that can express a claim.
  it.each([
    {
      dialect: "plain-lines",
      contents: ["# Claimed", "", "Type: task", "Status: claimed"].join("\n"),
      relativePath: ".scratch/test-map/issues/01-claimed.md",
    },
    {
      dialect: "field-lines",
      contents: ["# Claimed", "", "**Claimed by:** session-7"].join("\n"),
      relativePath: ".plan/test-map/tickets/01-claimed.md",
    },
    {
      dialect: "frontmatter",
      contents: ["---", "type: task", 'claimed_by: "session-7"', "---", "# Claimed"].join("\n"),
      relativePath: ".plan/test-map/tickets/01-claimed.md",
    },
  ])(
    "an unblocked $dialect ticket that is claimed is not frontier",
    ({ contents, relativePath }) => {
      const node = parseWayfinderMap(source([ticket(relativePath, contents)])).map.nodes[0];

      expect(node?.status).toBe("claimed");
      expect(node?.isFrontier).toBe(false);
    },
  );

  it("resolves comma-separated plain-line blockers and derives the frontier", () => {
    const parsed = parseWayfinderMap(
      source([
        ticket(
          ".scratch/test-map/issues/01-resolved.md",
          ["# Resolved", "", "Type: research", "Status: resolved", "Blocked by:"].join("\n"),
        ),
        ticket(
          ".scratch/test-map/issues/02-claimed.md",
          ["# Claimed", "", "Type: prototype", "Status: claimed", "Blocked by:"].join("\n"),
        ),
        ticket(
          ".scratch/test-map/issues/03-blocked.md",
          ["# Blocked", "", "Type: task", "Status:", "Blocked by: 01, 02, 99"].join("\n"),
        ),
        ticket(
          ".scratch/test-map/issues/04-frontier.md",
          ["# Frontier", "", "Type: grilling", "Status:", "Blocked by: 01"].join("\n"),
        ),
      ]),
    );

    expect(parsed.map.edges).toEqual([
      { from: "01", to: "03", kind: "blocks" },
      { from: "01", to: "04", kind: "blocks" },
      { from: "02", to: "03", kind: "blocks" },
    ]);
    expect(parsed.lints).toContainEqual({
      code: "unresolved_blocker",
      message: "Ticket 03 references unresolved blocker 99.",
      mapId: "test-map",
      ticketId: "03",
    });
    expect(parsed.map.nodes.find((node) => node.id === "02")?.isFrontier).toBe(false);
    expect(parsed.map.nodes.find((node) => node.id === "03")?.isFrontier).toBe(false);
    expect(parsed.map.nodes.find((node) => node.id === "04")?.isFrontier).toBe(true);
  });

  it("normalises frontmatter metadata", () => {
    const mapContents = [
      "---",
      "title: Frontmatter effort",
      "destination: Ship a stable parser.",
      "notes: Preserve partial results.",
      "---",
      "# Ignored fallback title",
    ].join("\n");
    const parsed = parseWayfinderMap(
      source(
        [
          ticket(
            ".plan/test-map/tickets/02-investigate.md",
            [
              "---",
              "type: research",
              "blocked_by: []",
              "claimed_by: agent-2",
              "---",
              "# Investigate the boundary",
              "",
              "## Question",
              "",
              "Where should parsing stop?",
            ].join("\n"),
          ),
        ],
        mapContents,
      ),
    );

    expect(parsed.map).toMatchObject({
      dialect: "frontmatter",
      title: "Frontmatter effort",
      destination: "Ship a stable parser.",
      notes: ["Preserve partial results."],
    });
    expect(parsed.map.nodes[0]).toMatchObject({
      id: "02",
      ordinal: 2,
      label: "Investigate the boundary",
      type: "research",
      status: "claimed",
      claimedBy: "agent-2",
    });
  });

  it("normalises field-line metadata to the same model", () => {
    const mapContents = [
      "# Field effort",
      "",
      "**Destination:** Ship a stable parser.",
      "**Notes:** Preserve partial results.",
    ].join("\n");
    const parsed = parseWayfinderMap(
      source(
        [
          ticket(
            ".plan/test-map/tickets/02-investigate.md",
            [
              "# Investigate the boundary",
              "",
              "**Type:** research",
              "**Blocked by:** []",
              "**Claimed by:** agent-2",
              "",
              "## Question",
              "",
              "Where should parsing stop?",
            ].join("\n"),
          ),
        ],
        mapContents,
      ),
    );

    expect(parsed.map).toMatchObject({
      dialect: "field-lines",
      title: "Field effort",
      destination: "Ship a stable parser.",
      notes: ["Preserve partial results."],
    });
    expect(parsed.map.nodes[0]).toMatchObject({
      id: "02",
      ordinal: 2,
      label: "Investigate the boundary",
      type: "research",
      status: "claimed",
      claimedBy: "agent-2",
    });
  });

  it("normalises known plain-line metadata without swallowing prose containing colons", () => {
    const parsed = parseWayfinderMap(
      source([
        ticket(
          ".scratch/test-map/issues/02-investigate.md",
          [
            "# Investigate the boundary",
            "",
            "Type: research",
            "Status:",
            "Blocked by:",
            "Context: Status: resolved is documented here, not declared.",
            "",
            "## Question",
            "",
            "Where should parsing stop?",
          ].join("\n"),
        ),
      ]),
    );

    expect(parsed.map.dialect).toBe("plain-lines");
    expect(parsed.map.nodes[0]).toMatchObject({
      id: "02",
      ordinal: 2,
      label: "Investigate the boundary",
      type: "research",
      status: "open",
    });
  });

  it("parses map prose, indexes, fog anchors, and counts", () => {
    const mapContents = [
      "# Parser map",
      "",
      "## Destination",
      "",
      "A parser that cannot resolve itself.",
      "",
      "## Notes",
      "",
      "Treat fences as a pre-pass.",
      "",
      "## Decisions so far",
      "",
      "- [Use YAML 1.2](./tickets/01-yaml.md) - leading zeroes stay strings.",
      "",
      "## Not yet specified",
      "",
      "- **Map discovery.** Decide which roots are bounded. <clears-with: 02>",
      "- **Relay recovery.** Confirm reconnect catch-up. <clears-with>01</clears-with>",
      "- **Rendering budget.** Measure before animating.",
      "",
      "## Out of scope",
      "",
      "- Mobile rendering - there is no right panel.",
    ].join("\n");
    const parsed = parseWayfinderMap(
      source(
        [
          ticket(
            ".plan/test-map/tickets/01-yaml.md",
            [
              "---",
              "type: research",
              "blocked_by: []",
              "---",
              "# YAML",
              "",
              "## Answer",
              "",
              "Use YAML 1.2.",
            ].join("\n"),
          ),
          ticket(
            ".plan/test-map/tickets/02-discovery.md",
            ["---", "type: task", "blocked_by: [01]", "---", "# Discovery"].join("\n"),
          ),
        ],
        mapContents,
      ),
    );

    expect(parsed.map.destination).toBe("A parser that cannot resolve itself.");
    expect(parsed.map.notes).toEqual(["Treat fences as a pre-pass."]);
    expect(parsed.map.decisions).toEqual([
      "[Use YAML 1.2](./tickets/01-yaml.md) - leading zeroes stay strings.",
    ]);
    expect(parsed.map.fog).toEqual([
      {
        title: "Map discovery.",
        description: "Decide which roots are bounded.",
        clearsWith: "02",
      },
      {
        title: "Relay recovery.",
        description: "Confirm reconnect catch-up.",
        clearsWith: "01",
      },
      {
        title: "Rendering budget.",
        description: "Measure before animating.",
        clearsWith: null,
      },
    ]);
    expect(parsed.map.outOfScope).toEqual(["Mobile rendering - there is no right panel."]);
    expect(parsed.map.counts).toMatchObject({
      total: 2,
      open: 1,
      resolved: 1,
      frontier: 1,
    });
  });

  it("recomputes frontier when a blocker changes state", () => {
    const dependent = ticket(
      ".plan/test-map/tickets/02-dependent.md",
      ["---", "type: task", "blocked_by: [01]", "---", "# Dependent"].join("\n"),
    );
    const openBlocker = ticket(
      ".plan/test-map/tickets/01-blocker.md",
      ["---", "type: research", "blocked_by: []", "---", "# Blocker"].join("\n"),
    );
    const resolvedBlocker = ticket(
      ".plan/test-map/tickets/01-blocker.md",
      [
        "---",
        "type: research",
        "blocked_by: []",
        "---",
        "# Blocker",
        "",
        "## Answer",
        "",
        "The blocker is resolved.",
      ].join("\n"),
    );

    const before = parseWayfinderMap(source([openBlocker, dependent])).map.nodes.find(
      (node) => node.id === "02",
    );
    const after = parseWayfinderMap(source([resolvedBlocker, dependent])).map.nodes.find(
      (node) => node.id === "02",
    );

    expect(before?.isFrontier).toBe(false);
    expect(after?.isFrontier).toBe(true);
  });

  it("marks targets of unresolved undermines edges as undermined", () => {
    const parsed = parseWayfinderMap(
      source([
        ticket(
          ".plan/test-map/tickets/01-decision.md",
          ["---", "type: task", "blocked_by: []", "undermined_by: [02]", "---", "# Decision"].join(
            "\n",
          ),
        ),
        ticket(
          ".plan/test-map/tickets/02-new-evidence.md",
          ["---", "type: research", "blocked_by: []", "---", "# New evidence"].join("\n"),
        ),
      ]),
    );

    expect(parsed.map.edges).toContainEqual({ from: "02", to: "01", kind: "undermines" });
    expect(parsed.map.nodes.find((node) => node.id === "01")?.isUndermined).toBe(true);
  });

  it("assigns cyclic and cycle-dependent nodes a finite rank above acyclic nodes", () => {
    const parsed = parseWayfinderMap(
      source([
        ticket(
          ".plan/test-map/tickets/01-root.md",
          ["---", "type: task", "blocked_by: []", "---", "# Root"].join("\n"),
        ),
        ticket(
          ".plan/test-map/tickets/02-cycle-a.md",
          ["---", "type: task", "blocked_by: [03]", "---", "# Cycle A"].join("\n"),
        ),
        ticket(
          ".plan/test-map/tickets/03-cycle-b.md",
          ["---", "type: task", "blocked_by: [02]", "---", "# Cycle B"].join("\n"),
        ),
        ticket(
          ".plan/test-map/tickets/04-downstream.md",
          ["---", "type: task", "blocked_by: [03]", "---", "# Downstream"].join("\n"),
        ),
      ]),
    );

    expect(parsed.map.nodes.find((node) => node.id === "01")).toMatchObject({
      rank: 0,
      cyclic: false,
    });
    for (const id of ["02", "03", "04"]) {
      expect(parsed.map.nodes.find((node) => node.id === id)).toMatchObject({
        rank: 1,
        cyclic: true,
      });
    }
  });

  it("degrades malformed and truncated content to typed lints and a partial snapshot", () => {
    const malformedMap = ["---", "title: [unterminated", "---", "# Fallback map"].join("\n");
    const malformedTicket = ticket(
      ".plan/test-map/tickets/01-broken.md",
      ["---", "blocked_by: [", "---", "# Broken ticket"].join("\n"),
      true,
    );

    expect(() =>
      parseWayfinderMaps(
        [
          source([malformedTicket], malformedMap, {
            map: {
              relativePath: ".plan/test-map/map.md",
              contents: malformedMap,
              truncated: true,
            },
          }),
        ],
        true,
      ),
    ).not.toThrow();

    const snapshot = parseWayfinderMaps(
      [
        source([malformedTicket], malformedMap, {
          map: {
            relativePath: ".plan/test-map/map.md",
            contents: malformedMap,
            truncated: true,
          },
        }),
      ],
      true,
    );

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.maps[0]?.nodes).toHaveLength(1);
    expect(snapshot.lints.map((lint) => lint.code)).toEqual(
      expect.arrayContaining([
        "malformed_frontmatter",
        "malformed_map_metadata",
        "snapshot_truncated",
        "ticket_truncated",
        "map_truncated",
      ]),
    );
  });
});
