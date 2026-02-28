/**
 * Budget data types and loader.
 *
 * budgets.json schema:
 *   { [normalizedDistrictKey]: DistrictBudget }
 *
 * Keys match enrollment and districts.geojson lookups.
 */

export interface BudgetComponents {
  districtManagement: number;
  programOperationsManagement: number;
}

export interface DistrictBudget {
  displayName: string;
  sourceFile: string;
  fiscalYear: string;
  totalExpenditures: number;
  centralAdministration: number;
  centralAdministrationModel: number;
  adminShareOfTotal: number | null;
  adminShareOfTotalModel: number | null;
  components: BudgetComponents;
  componentsModel: BudgetComponents;
  flags: string[];
}

export type BudgetsMap = Record<string, DistrictBudget>;

export async function loadBudgets(): Promise<BudgetsMap> {
  const res = await fetch('/budgets/budgets.json');
  if (!res.ok) throw new Error(`Failed to load budgets: ${res.status} ${res.statusText}`);
  return (await res.json()) as BudgetsMap;
}
