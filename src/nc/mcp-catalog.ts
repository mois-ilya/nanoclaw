/** Connectors the owner can add from the Mini App. The URL is fixed here, never taken from a request. */

export interface CatalogEntry {
  id: string;
  /** Name of the entry in container.json, so the agent's tools are `mcp__<serverName>__<tool>`. */
  serverName: string;
  title: string;
  description: string;
  /** https only; the secret is sent to this URL by nanogate and nowhere else. */
  url: string;
  keyRe: RegExp;
  keyLabel: string;
  keyHelp: string;
  keyUrl: string;
  /** Header that makes the upstream hide its writing tools (`readOnly` toggle). */
  readOnlyHeader: string;
  /** The upstream's `readOnlyHint` annotations are believed (fixed trusted URL). Only `true` is implemented in Stage 1. */
  trustAnnotations: boolean;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'github',
    serverName: 'github',
    title: 'GitHub',
    description: 'Репозитории, issues и pull requests от вашего имени.',
    url: 'https://api.githubcopilot.com/mcp/',
    keyRe: /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,255})$/,
    keyLabel: 'Personal access token',
    keyHelp:
      'Лучше fine-grained: выберите репозитории и права (Contents, Issues, Pull requests — Read/Write по необходимости). ' +
      'Классический токен: repo, read:org.',
    keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    readOnlyHeader: 'X-MCP-Readonly',
    trustAnnotations: true,
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.id === id);
}
