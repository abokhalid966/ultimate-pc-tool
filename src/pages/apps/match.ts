// Which toolkit apps are already installed. Kept free of imports so dev/apps.test.ts can test it.

interface CatalogEntry {
  id: string;
  match?: RegExp;
}

interface WingetEntry {
  id: string;
  /** winget shortened the id to fit its table, so only its start is known. */
  partialId: boolean;
}

/**
 * Catalog ids that are installed: winget knows them by id (a shortened id counts when it is a
 * long enough start of the catalog id), or a program with a matching name is in the installed list.
 */
export function installedCatalogIds(catalog: CatalogEntry[], winget: WingetEntry[], programNames: string[]): Set<string> {
  const exact = new Set(winget.filter((p) => !p.partialId).map((p) => p.id.toLowerCase()));
  const prefixes = winget.filter((p) => p.partialId && p.id.length >= 8).map((p) => p.id.toLowerCase());
  const found = new Set<string>();
  for (const app of catalog) {
    const id = app.id.toLowerCase();
    const byWinget = exact.has(id) || prefixes.some((p) => id.startsWith(p));
    const byName = !!app.match && programNames.some((n) => app.match!.test(n.trim()));
    if (byWinget || byName) found.add(app.id);
  }
  return found;
}
