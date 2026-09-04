import type { ModelCatalogueEntry } from "@t3tools/contracts";

/** The catalogue stores benchmark confidence as a percentage in the 0-100 range. */
export function formatModelConfidence(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

/** Available models first, then alphabetical. The copy keeps the input immutable. */
export function sortCatalogueRows(
  rows: ReadonlyArray<ModelCatalogueEntry>,
): ReadonlyArray<ModelCatalogueEntry> {
  return [...rows].sort((left, right) => {
    const leftAvailable = left.availability.length > 0 ? 0 : 1;
    const rightAvailable = right.availability.length > 0 ? 0 : 1;
    if (leftAvailable !== rightAvailable) return leftAvailable - rightAvailable;
    return left.name.localeCompare(right.name);
  });
}

export function filterCatalogueRows(
  rows: ReadonlyArray<ModelCatalogueEntry>,
  filters: { readonly query: string; readonly availableOnly: boolean },
): ReadonlyArray<ModelCatalogueEntry> {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.availableOnly && row.availability.length === 0) return false;
    if (query === "") return true;
    return (
      row.name.toLowerCase().includes(query) ||
      row.sourceModelId.toLowerCase().includes(query) ||
      (row.vendorLabel ?? "").toLowerCase().includes(query)
    );
  });
}
