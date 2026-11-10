// Data files: the team catalog and the component catalog (canonical
// component -> description + aliases, one file, one concept). Both are
// validated against TypeBox schemas: malformed shapes fail startup with a
// path-bearing message instead of being coerced.
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Config } from "./config.ts";
import { TEAM_UUID_PATTERN } from "./normalize.ts";

export interface TeamEntry {
  id: string;
  components: string[];
  members: string[];
  /** Optional; null reads as absent. */
  description?: string | null;
}

export type TeamCatalog = Record<string, TeamEntry>;

export interface ComponentEntry {
  description: string;
  aliases: string[];
}

export type ComponentCatalog = Record<string, ComponentEntry>;

export function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const TeamSchema = Type.Object(
  {
    id: Type.String({ pattern: TEAM_UUID_PATTERN }),
    components: Type.Array(Type.String()),
    members: Type.Array(Type.String()),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
const TeamsSchema = Type.Record(Type.String(), TeamSchema);

const ComponentSchema = Type.Object(
  {
    description: Type.String(),
    aliases: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
const ComponentsSchema = Type.Record(Type.String(), ComponentSchema);

/** Validate a catalog against its schema; the file label prefixes the
 * path-bearing error (e.g. teams.json/T/id: must match pattern). */
function parseCatalog<T>(
  schema: typeof TeamsSchema | typeof ComponentsSchema,
  data: unknown,
  label: string,
  what: string,
): T {
  const errors = [...Value.Errors(schema, data)];
  if (errors.length > 0) {
    const first =
      errors.find(
        (error) => error.instancePath !== "" && error.keyword !== "additionalProperties",
      ) ?? errors[0];
    throw new Error(`${label}${first.instancePath}: ${first.message} (${what})`);
  }
  return data as T;
}

/** teams.json -> validated {team: {id, components, members}}.

Each team needs a UUID-shaped Cloud id — the authoritative source for Team
writes — plus list-of-string components/members. An optional description
(string) prefixes the team criteria. The shape check is deliberately loose
on the id suffix (Cloud appends "-<number>" tenant suffixes). */
export function loadTeamConfig(path: string): TeamCatalog {
  const teams = parseCatalog<TeamCatalog>(TeamsSchema, loadJson(path), path, "team catalog");
  if (Object.keys(teams).length === 0) {
    throw new Error(`${path}: expected a non-empty JSON object of teams`);
  }
  return teams;
}

/** components.json -> validated {canonical: {description, aliases}}.
 * Aliases live inside their canonical entry, so an alias can never point
 * outside the catalog — the old cross-file target check is structural now. */
export function loadComponents(path: string): ComponentCatalog {
  return parseCatalog<ComponentCatalog>(
    ComponentsSchema,
    loadJson(path),
    path,
    "component catalog",
  );
}

/** alias -> canonical, derived from the component catalog. */
export function aliasMap(components: ComponentCatalog): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const [canonical, entry] of Object.entries(components)) {
    for (const alias of entry.aliases) {
      aliases[alias] = canonical;
    }
  }
  return aliases;
}

/** canonical -> description, derived from the component catalog. */
export function descriptionMap(components: ComponentCatalog): Record<string, string> {
  return Object.fromEntries(
    Object.entries(components).map(([canonical, entry]) => [canonical, entry.description]),
  );
}

export interface Catalogs {
  teams: TeamCatalog;
  components: ComponentCatalog;
  aliases: Record<string, string>;
  descriptions: Record<string, string>;
}

/** Validate the catalogs. Audit state is NOT loaded here: each mode owns
 * the resources it actually requires. */
export function validateConfigFiles(config: Config): Catalogs {
  const teams = loadTeamConfig(config.teamConfigFile);
  const components = loadComponents(config.componentCatalogFile);
  return {
    teams,
    components,
    aliases: aliasMap(components),
    descriptions: descriptionMap(components),
  };
}
