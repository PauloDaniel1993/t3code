import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FRONTMATTER_OPEN_PATTERN = /^---\r?(?:\n|$)/;
const FIELD_PATTERN = /^\s*\*\*([^*]+?):\*\*\s*(.*?)\s*$/;
const PLAIN_FIELD_PATTERN = /^\s*(Type|Status|Blocked by):\s*(.*?)\s*$/i;
const BULLET_PATTERN = /^\s*[-*+]\s+(.+?)\s*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export type WayfinderDialect = "frontmatter" | "field-lines" | "plain-lines";
export type WayfinderNodeStatus = "open" | "claimed" | "resolved" | "out_of_scope";
export type WayfinderEdgeKind = "blocks" | "undermines";
export type WayfinderLintCode =
  | "malformed_frontmatter"
  | "malformed_map_metadata"
  | "unresolved_blocker"
  | "snapshot_truncated"
  | "ticket_truncated"
  | "map_truncated";

export interface WayfinderLint {
  readonly code: WayfinderLintCode;
  readonly message: string;
  readonly mapId?: string;
  readonly ticketId?: string;
}

export interface WayfinderEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: WayfinderEdgeKind;
}

export interface WayfinderNode {
  readonly id: string;
  readonly ordinal: number;
  readonly label: string;
  readonly relativePath: string;
  readonly type: string;
  readonly status: WayfinderNodeStatus;
  readonly isFrontier: boolean;
  readonly isUndermined: boolean;
  readonly claimedBy: string | null;
  readonly rank: number;
  readonly cyclic: boolean;
}

export interface WayfinderFogEntry {
  readonly title: string;
  readonly description: string;
  readonly clearsWith: string | null;
}

export interface WayfinderMapCounts {
  readonly total: number;
  readonly open: number;
  readonly claimed: number;
  readonly resolved: number;
  readonly outOfScope: number;
  readonly frontier: number;
}

export interface WayfinderMap {
  readonly id: string;
  readonly dialect: WayfinderDialect;
  readonly title: string;
  readonly mapRelativePath: string;
  readonly destination: string;
  readonly notes: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<WayfinderNode>;
  readonly edges: ReadonlyArray<WayfinderEdge>;
  readonly fog: ReadonlyArray<WayfinderFogEntry>;
  readonly decisions: ReadonlyArray<string>;
  readonly outOfScope: ReadonlyArray<string>;
  readonly counts: WayfinderMapCounts;
  readonly truncated: boolean;
}

export interface WayfinderMapsSnapshot {
  readonly maps: ReadonlyArray<WayfinderMap>;
  readonly lints: ReadonlyArray<WayfinderLint>;
  readonly truncated: boolean;
}

export interface WayfinderMarkdownFile {
  readonly relativePath: string;
  readonly contents: string;
  readonly truncated?: boolean;
}

export interface WayfinderMapSource {
  readonly id: string;
  readonly map: WayfinderMarkdownFile;
  readonly tickets: ReadonlyArray<WayfinderMarkdownFile>;
  readonly truncated?: boolean;
}

export interface WayfinderMapParseResult {
  readonly map: WayfinderMap;
  readonly lints: ReadonlyArray<WayfinderLint>;
}

interface ClassifiedLine {
  readonly text: string;
  readonly fenced: boolean;
}

interface Heading {
  readonly level: number;
  readonly title: string;
}

interface ParsedMetadata {
  readonly dialect: WayfinderDialect;
  readonly values: Readonly<Record<string, unknown>>;
  readonly malformed: boolean;
}

interface ParsedTicket {
  readonly node: WayfinderNode;
  readonly blockedBy: ReadonlyArray<string>;
  readonly underminedBy: ReadonlyArray<string>;
  readonly undermines: ReadonlyArray<string>;
  readonly dialect: WayfinderDialect;
}

function classifyLines(contents: string): ReadonlyArray<ClassifiedLine> {
  const lines = contents.split(/\r?\n/);
  let activeFence: { marker: "`" | "~"; length: number } | undefined;

  return lines.map((text) => {
    const match = FENCE_PATTERN.exec(text);
    if (activeFence) {
      const closesFence =
        match !== null &&
        match[1]?.[0] === activeFence.marker &&
        match[1].length >= activeFence.length &&
        (match[2] ?? "").trim().length === 0;
      if (closesFence) {
        activeFence = undefined;
      }
      return { text, fenced: true };
    }

    if (match) {
      const run = match[1] ?? "";
      activeFence = {
        marker: run[0] as "`" | "~",
        length: run.length,
      };
      return { text, fenced: true };
    }

    return { text, fenced: false };
  });
}

function parseHeading(text: string): Heading | undefined {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(text.trim());
  const marker = match?.[1];
  const title = match?.[2]?.trim();
  if (!marker || !title) {
    return undefined;
  }
  return { level: marker.length, title };
}

function normaliseFieldName(field: string): string {
  return field
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function parseFieldMetadata(lines: ReadonlyArray<ClassifiedLine>): ParsedMetadata {
  const values: Record<string, unknown> = {};
  let malformed = false;
  let sawTopLevelHeading = false;

  for (const line of lines) {
    if (line.fenced) {
      continue;
    }

    const heading = parseHeading(line.text);
    if (heading) {
      if (heading.level === 1 && !sawTopLevelHeading) {
        sawTopLevelHeading = true;
        continue;
      }
      break;
    }

    const field = FIELD_PATTERN.exec(line.text);
    if (field) {
      const name = field[1]?.trim();
      if (!name) {
        malformed = true;
        continue;
      }
      values[normaliseFieldName(name)] = field[2]?.trim() ?? "";
      continue;
    }

    const trimmed = line.text.trim();
    if (trimmed.startsWith("**") && trimmed.includes(":")) {
      malformed = true;
    }
  }

  return { dialect: "field-lines", values, malformed };
}

function parsePlainLineMetadata(lines: ReadonlyArray<ClassifiedLine>): ParsedMetadata {
  const values: Record<string, unknown> = {};
  let sawTopLevelHeading = false;

  for (const line of lines) {
    if (line.fenced) {
      continue;
    }

    const heading = parseHeading(line.text);
    if (heading) {
      if (heading.level === 1 && !sawTopLevelHeading) {
        sawTopLevelHeading = true;
        continue;
      }
      break;
    }

    const field = PLAIN_FIELD_PATTERN.exec(line.text);
    if (field?.[1]) {
      values[normaliseFieldName(field[1])] = field[2]?.trim() ?? "";
    }
  }

  return { dialect: "plain-lines", values, malformed: false };
}

function parseMetadata(contents: string, lines: ReadonlyArray<ClassifiedLine>): ParsedMetadata {
  const frontmatter = FRONTMATTER_PATTERN.exec(contents);
  if (!frontmatter) {
    if (FRONTMATTER_OPEN_PATTERN.test(contents)) {
      return { dialect: "frontmatter", values: {}, malformed: true };
    }
    const fieldMetadata = parseFieldMetadata(lines);
    if (fieldMetadata.malformed || Object.keys(fieldMetadata.values).length > 0) {
      return fieldMetadata;
    }
    const plainLineMetadata = parsePlainLineMetadata(lines);
    return Object.keys(plainLineMetadata.values).length > 0 ? plainLineMetadata : fieldMetadata;
  }

  try {
    const parsed: unknown = parseYamlDocument(frontmatter[1] ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { dialect: "frontmatter", values: {}, malformed: true };
    }
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      values[normaliseFieldName(key)] = value;
    }
    return { dialect: "frontmatter", values, malformed: false };
  } catch {
    return { dialect: "frontmatter", values: {}, malformed: true };
  }
}

function scalarString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function stringList(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map(scalarString).filter((entry) => entry.length > 0);
  }

  const text = scalarString(value);
  if (!text || /^(?:\[\]|none|null|n\/a|-|\u2014)$/i.test(text)) {
    return [];
  }

  const unwrapped = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return unwrapped
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
    .filter((entry) => entry.length > 0);
}

function firstMetadataValue(
  values: Readonly<Record<string, unknown>>,
  ...names: ReadonlyArray<string>
): unknown {
  for (const name of names) {
    if (Object.hasOwn(values, name)) {
      return values[name];
    }
  }
  return undefined;
}

function firstHeading(lines: ReadonlyArray<ClassifiedLine>, level: number): string {
  for (const line of lines) {
    if (line.fenced) {
      continue;
    }
    const heading = parseHeading(line.text);
    if (heading?.level === level) {
      return heading.title;
    }
  }
  return "";
}

function removeHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function isProseLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || FIELD_PATTERN.test(trimmed) || /^(?:---+|___+|\*\*\*+)$/.test(trimmed)) {
    return false;
  }
  if (/^<[^<>]+>$/.test(trimmed)) {
    return false;
  }
  return removeHtmlComments(trimmed).trim().length > 0;
}

function hasProseUnderHeading(
  lines: ReadonlyArray<ClassifiedLine>,
  acceptedTitles: ReadonlySet<string>,
): boolean {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.fenced) {
      continue;
    }
    const heading = parseHeading(line.text);
    if (heading?.level !== 2 || !acceptedTitles.has(heading.title.trim().toLowerCase())) {
      continue;
    }

    const body: Array<string> = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const bodyLine = lines[bodyIndex];
      if (!bodyLine) {
        continue;
      }
      if (!bodyLine.fenced && parseHeading(bodyLine.text)) {
        break;
      }
      if (!bodyLine.fenced) {
        body.push(bodyLine.text);
      }
    }

    const uncommented = removeHtmlComments(body.join("\n"));
    if (uncommented.split("\n").some(isProseLine)) {
      return true;
    }
  }
  return false;
}

function deriveStatus(
  lines: ReadonlyArray<ClassifiedLine>,
  metadata: Readonly<Record<string, unknown>>,
  claimedBy: string | null,
): WayfinderNodeStatus {
  if (hasProseUnderHeading(lines, new Set(["ruled out"]))) {
    return "out_of_scope";
  }

  const storedStatus = scalarString(firstMetadataValue(metadata, "status")).toLowerCase();
  if (
    storedStatus === "closed" ||
    storedStatus === "resolved" ||
    hasProseUnderHeading(lines, new Set(["answer", "resolution"]))
  ) {
    return "resolved";
  }

  return storedStatus === "claimed" || claimedBy ? "claimed" : "open";
}

function ordinalFromPath(relativePath: string): { raw: string; value: number } | undefined {
  const filename = relativePath.replace(/\\/g, "/").split("/").at(-1) ?? relativePath;
  const match = /^(\d+)(?:[-_.]|$)/.exec(filename);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? { raw: match[1], value } : undefined;
}

function humaniseTicketPath(relativePath: string): string {
  const filename = relativePath.replace(/\\/g, "/").split("/").at(-1) ?? relativePath;
  return filename
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_.]?/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function parseOrdinal(value: unknown): number | undefined {
  const text = scalarString(value);
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  const ordinal = Number.parseInt(text, 10);
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}

function parseTicket(
  ticket: WayfinderMarkdownFile,
  fallbackOrdinal: number,
  mapId: string,
  lints: Array<WayfinderLint>,
): ParsedTicket {
  const lines = classifyLines(ticket.contents);
  const metadata = parseMetadata(ticket.contents, lines);
  const pathOrdinal = ordinalFromPath(ticket.relativePath);
  const metadataOrdinal = parseOrdinal(
    firstMetadataValue(metadata.values, "ordinal", "number", "ticket_number"),
  );
  const ordinal = metadataOrdinal ?? pathOrdinal?.value ?? fallbackOrdinal;
  const metadataId = scalarString(firstMetadataValue(metadata.values, "id", "ticket_id"));
  const id = metadataId || pathOrdinal?.raw || String(ordinal);
  const claimedByValue = scalarString(
    firstMetadataValue(metadata.values, "claimed_by", "claimedby", "owner"),
  );
  const claimedBy = claimedByValue || null;
  const heading = firstHeading(lines, 1);
  const label =
    scalarString(firstMetadataValue(metadata.values, "title", "label")) ||
    heading ||
    humaniseTicketPath(ticket.relativePath) ||
    id;
  const type = scalarString(firstMetadataValue(metadata.values, "type")) || "task";

  if (metadata.malformed) {
    lints.push({
      code: "malformed_frontmatter",
      message: `Ticket ${id} has malformed metadata.`,
      mapId,
      ticketId: id,
    });
  }
  if (ticket.truncated) {
    lints.push({
      code: "ticket_truncated",
      message: `Ticket ${id} was truncated while reading; its derived status may be incomplete.`,
      mapId,
      ticketId: id,
    });
  }

  return {
    node: {
      id,
      ordinal,
      label,
      relativePath: ticket.relativePath,
      type,
      status: deriveStatus(lines, metadata.values, claimedBy),
      isFrontier: false,
      isUndermined: false,
      claimedBy,
      rank: 0,
      cyclic: false,
    },
    blockedBy: stringList(
      firstMetadataValue(metadata.values, "blocked_by", "blockedby", "blocked"),
    ),
    underminedBy: stringList(firstMetadataValue(metadata.values, "undermined_by", "underminedby")),
    undermines: stringList(firstMetadataValue(metadata.values, "undermines")),
    dialect: metadata.dialect,
  };
}

function zeroPadNormalised(value: string): string | undefined {
  const trimmed = value.trim().replace(/^#/, "");
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed.replace(/^0+(?=\d)/, "");
}

function resolveReference(
  reference: string,
  tickets: ReadonlyArray<ParsedTicket>,
): ParsedTicket | undefined {
  const exactId = tickets.find((ticket) => ticket.node.id === reference);
  if (exactId) {
    return exactId;
  }

  const exactOrdinal = tickets.find((ticket) => String(ticket.node.ordinal) === reference);
  if (exactOrdinal) {
    return exactOrdinal;
  }

  const normalisedReference = zeroPadNormalised(reference);
  if (normalisedReference === undefined) {
    return undefined;
  }
  return tickets.find(
    (ticket) =>
      zeroPadNormalised(ticket.node.id) === normalisedReference ||
      zeroPadNormalised(String(ticket.node.ordinal)) === normalisedReference,
  );
}

function edgeKey(edge: WayfinderEdge): string {
  return `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
}

function resolveEdges(
  tickets: ReadonlyArray<ParsedTicket>,
  mapId: string,
  lints: Array<WayfinderLint>,
): ReadonlyArray<WayfinderEdge> {
  const edges = new Map<string, WayfinderEdge>();

  for (const ticket of tickets) {
    for (const referenceValue of ticket.blockedBy) {
      const reference = String(referenceValue).trim();
      const blocker = resolveReference(reference, tickets);
      if (!blocker) {
        lints.push({
          code: "unresolved_blocker",
          message: `Ticket ${ticket.node.id} references unresolved blocker ${reference}.`,
          mapId,
          ticketId: ticket.node.id,
        });
        continue;
      }
      const edge: WayfinderEdge = { from: blocker.node.id, to: ticket.node.id, kind: "blocks" };
      edges.set(edgeKey(edge), edge);
    }

    for (const referenceValue of ticket.underminedBy) {
      const underminer = resolveReference(String(referenceValue).trim(), tickets);
      if (underminer) {
        const edge: WayfinderEdge = {
          from: underminer.node.id,
          to: ticket.node.id,
          kind: "undermines",
        };
        edges.set(edgeKey(edge), edge);
      }
    }

    for (const referenceValue of ticket.undermines) {
      const undermined = resolveReference(String(referenceValue).trim(), tickets);
      if (undermined) {
        const edge: WayfinderEdge = {
          from: ticket.node.id,
          to: undermined.node.id,
          kind: "undermines",
        };
        edges.set(edgeKey(edge), edge);
      }
    }
  }

  return [...edges.values()].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind),
  );
}

function rankNodes(
  nodes: ReadonlyArray<WayfinderNode>,
  edges: ReadonlyArray<WayfinderEdge>,
): ReadonlyArray<WayfinderNode> {
  const blockEdges = edges.filter((edge) => edge.kind === "blocks");
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as Array<string>]));
  const rank = new Map(nodes.map((node) => [node.id, 0]));

  for (const edge of blockEdges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const queue = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort((left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0));
  const emitted = new Set<string>();
  let maximumRank = -1;

  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || emitted.has(id)) {
      continue;
    }
    emitted.add(id);
    maximumRank = Math.max(maximumRank, rank.get(id) ?? 0);

    for (const dependent of outgoing.get(id) ?? []) {
      rank.set(dependent, Math.max(rank.get(dependent) ?? 0, (rank.get(id) ?? 0) + 1));
      const remaining = Math.max(0, (indegree.get(dependent) ?? 0) - 1);
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        queue.push(dependent);
      }
    }
  }

  const cyclicRank = maximumRank + 1;
  return nodes.map((node) => ({
    ...node,
    rank: emitted.has(node.id) ? (rank.get(node.id) ?? 0) : cyclicRank,
    cyclic: !emitted.has(node.id),
  }));
}

function deriveGraphState(
  nodes: ReadonlyArray<WayfinderNode>,
  edges: ReadonlyArray<WayfinderEdge>,
): ReadonlyArray<WayfinderNode> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const blockerIds = new Map(nodes.map((node) => [node.id, [] as Array<string>]));
  const underminerIds = new Map(nodes.map((node) => [node.id, [] as Array<string>]));

  for (const edge of edges) {
    if (edge.kind === "blocks") {
      blockerIds.get(edge.to)?.push(edge.from);
    } else {
      underminerIds.get(edge.to)?.push(edge.from);
    }
  }

  const blockerIsSatisfied = (id: string): boolean => {
    const status = nodesById.get(id)?.status;
    return status === "resolved" || status === "out_of_scope";
  };

  return nodes.map((node) => ({
    ...node,
    isFrontier: node.status === "open" && (blockerIds.get(node.id) ?? []).every(blockerIsSatisfied),
    isUndermined: (underminerIds.get(node.id) ?? []).some(
      (id) => nodesById.get(id)?.status !== "resolved",
    ),
  }));
}

function findSection(
  lines: ReadonlyArray<ClassifiedLine>,
  acceptedTitles: ReadonlySet<string>,
): { start: number; end: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.fenced) {
      continue;
    }
    const heading = parseHeading(line.text);
    if (heading?.level !== 2 || !acceptedTitles.has(heading.title.toLowerCase())) {
      continue;
    }

    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next];
      if (nextLine && !nextLine.fenced && parseHeading(nextLine.text)?.level === 2) {
        end = next;
        break;
      }
    }
    return { start: index + 1, end };
  }
  return undefined;
}

function sectionText(
  lines: ReadonlyArray<ClassifiedLine>,
  acceptedTitles: ReadonlySet<string>,
): string {
  const section = findSection(lines, acceptedTitles);
  if (!section) {
    return "";
  }
  return lines
    .slice(section.start, section.end)
    .map((line) => line.text)
    .join("\n")
    .trim();
}

function sectionBullets(
  lines: ReadonlyArray<ClassifiedLine>,
  acceptedTitles: ReadonlySet<string>,
): ReadonlyArray<string> {
  const section = findSection(lines, acceptedTitles);
  if (!section) {
    return [];
  }

  const bullets: Array<string> = [];
  for (const line of lines.slice(section.start, section.end)) {
    if (line.fenced) {
      continue;
    }
    const bullet = BULLET_PATTERN.exec(line.text)?.[1]?.trim();
    if (bullet) {
      bullets.push(bullet);
    }
  }
  return bullets;
}

function parseNotes(
  lines: ReadonlyArray<ClassifiedLine>,
  metadata: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  const notes = sectionText(lines, new Set(["notes"]));
  if (notes) {
    return notes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  const metadataNotes = firstMetadataValue(metadata, "notes");
  if (Array.isArray(metadataNotes)) {
    return metadataNotes.map(scalarString).filter((note) => note.length > 0);
  }
  const metadataNote = scalarString(metadataNotes);
  return metadataNote ? [metadataNote] : [];
}

function parseFog(lines: ReadonlyArray<ClassifiedLine>): ReadonlyArray<WayfinderFogEntry> {
  return sectionBullets(lines, new Set(["not yet specified", "fog", "fog of war"])).map(
    (bullet) => {
      // Both anchor spellings appear in the wild: the attribute form
      // `<clears-with: 02>` and the element form `<clears-with>02</clears-with>`.
      // Accept either rather than guessing, since this markdown is written by an
      // agent mid-turn and a missed anchor silently drops the fog link.
      const anchor =
        /\s*<clears-with(?::\s*([^>]*)>|\s*>\s*([^<]*?)\s*<\/\s*clears-with\s*>)\s*/i.exec(bullet);
      const withoutAnchor = anchor ? bullet.replace(anchor[0], " ").trim() : bullet;
      const boldTitle = /^\*\*(.+?)\*\*\s*(.*)$/.exec(withoutAnchor);
      return {
        title: (boldTitle?.[1] ?? withoutAnchor).trim(),
        description: (boldTitle?.[2] ?? "").trim(),
        clearsWith: (anchor?.[1] ?? anchor?.[2])?.trim() || null,
      };
    },
  );
}

function countNodes(nodes: ReadonlyArray<WayfinderNode>): WayfinderMapCounts {
  return {
    total: nodes.length,
    open: nodes.filter((node) => node.status === "open").length,
    claimed: nodes.filter((node) => node.status === "claimed").length,
    resolved: nodes.filter((node) => node.status === "resolved").length,
    outOfScope: nodes.filter((node) => node.status === "out_of_scope").length,
    frontier: nodes.filter((node) => node.isFrontier).length,
  };
}

export function parseWayfinderMap(source: WayfinderMapSource): WayfinderMapParseResult {
  const lints: Array<WayfinderLint> = [];
  const mapLines = classifyLines(source.map.contents);
  const mapMetadata = parseMetadata(source.map.contents, mapLines);
  const tickets = [...source.tickets]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((ticket, index) => parseTicket(ticket, index + 1, source.id, lints));

  if (mapMetadata.malformed) {
    lints.push({
      code: "malformed_map_metadata",
      message: `Map ${source.id} has malformed metadata.`,
      mapId: source.id,
    });
  }

  const truncated = Boolean(
    source.truncated || source.map.truncated || source.tickets.some((ticket) => ticket.truncated),
  );
  if (
    (source.truncated || source.map.truncated) &&
    !lints.some((lint) => lint.code === "map_truncated")
  ) {
    lints.push({
      code: "map_truncated",
      message: `Map ${source.id} was truncated while reading.`,
      mapId: source.id,
    });
  }

  const edges = resolveEdges(tickets, source.id, lints);
  const rankedNodes = rankNodes(
    tickets.map((ticket) => ticket.node),
    edges,
  );
  const nodes = deriveGraphState(rankedNodes, edges);
  const title =
    scalarString(firstMetadataValue(mapMetadata.values, "title", "name")) ||
    firstHeading(mapLines, 1) ||
    source.id;
  const destination =
    sectionText(mapLines, new Set(["destination"])) ||
    scalarString(firstMetadataValue(mapMetadata.values, "destination"));
  const notes = parseNotes(mapLines, mapMetadata.values);
  const dialect =
    mapMetadata.dialect === "frontmatter" ||
    tickets.some((ticket) => ticket.dialect === "frontmatter")
      ? "frontmatter"
      : mapMetadata.dialect === "plain-lines" ||
          tickets.some((ticket) => ticket.dialect === "plain-lines")
        ? "plain-lines"
        : "field-lines";

  return {
    map: {
      id: source.id,
      dialect,
      title,
      mapRelativePath: source.map.relativePath,
      destination,
      notes,
      nodes,
      edges,
      fog: parseFog(mapLines),
      decisions: sectionBullets(mapLines, new Set(["decisions", "decisions so far"])),
      outOfScope: sectionBullets(mapLines, new Set(["out of scope"])),
      counts: countNodes(nodes),
      truncated,
    },
    lints,
  };
}

export function parseWayfinderMaps(
  sources: ReadonlyArray<WayfinderMapSource>,
  truncated = false,
): WayfinderMapsSnapshot {
  const parsed = sources.map(parseWayfinderMap);
  const lints = parsed.flatMap((result) => result.lints);
  if (truncated) {
    lints.push({
      code: "snapshot_truncated",
      message: "The wayfinder maps snapshot was truncated.",
    });
  }
  return {
    maps: parsed.map((result) => result.map),
    lints,
    truncated: truncated || parsed.some((result) => result.map.truncated),
  };
}
