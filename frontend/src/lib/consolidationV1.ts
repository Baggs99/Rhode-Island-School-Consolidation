import type { BudgetsMap } from './budgets';
import type { LeaEnrollmentMap } from './enrollment';
import type { DistrictAnchorsMap } from './anchors';
import { milesBetween } from './geoDistance';

export interface ConsolidationParamsV1 {
  adminReductionRate: number;
  costPerStudentMile: number;
  affectedShare: number;
}

export interface SpokeDetail {
  key: string;
  name: string;
  enrollment: number;
  distanceMiles: number;
  cost: number;
}

export interface ConsolidationResultV1 {
  hubKey: string;
  hubName: string;
  combinedEnrollment: number;
  combinedSpending: number;
  hubSpending: number;
  spokesSpending: number;
  baselinePerPupil: number;
  adminBaselineHub: number;
  adminBaselineSpokes: number;
  adminSavings: number;
  transportationIncrease: number;
  netImpact: number;
  projectedSpending: number;
  projectedPerPupil: number;
  adminSavingsPctCombined: number;
  transportIncreasePctCombined: number;
  netImpactPctCombined: number;
  adminSavingsPctSpokesSpending: number;
  transportIncreasePctSpokesSpending: number;
  netImpactPctSpokesSpending: number;
  spokeBreakdown: SpokeDetail[];
  warnings: string[];
  missing: { budgets: string[]; enrollment: string[]; anchors: string[] };
  ok: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function computeConsolidationV1(
  selectedKeys: string[],
  budgets: BudgetsMap,
  enrollments: LeaEnrollmentMap,
  anchors: DistrictAnchorsMap,
  params: ConsolidationParamsV1,
): ConsolidationResultV1 {
  const rate = clamp(params.adminReductionRate, 0, 1);
  const cpsm = Math.max(0, params.costPerStudentMile);
  const share = clamp(params.affectedShare, 0, 1);

  const unique = [...new Set(selectedKeys)];
  const missingBudgets: string[] = [];
  const missingEnrollment: string[] = [];
  const missingAnchors: string[] = [];
  const warnings: string[] = [];

  const empty: ConsolidationResultV1 = {
    hubKey: '', hubName: '', combinedEnrollment: 0, combinedSpending: 0,
    hubSpending: 0, spokesSpending: 0,
    baselinePerPupil: 0, adminBaselineHub: 0, adminBaselineSpokes: 0,
    adminSavings: 0, transportationIncrease: 0, netImpact: 0,
    projectedSpending: 0, projectedPerPupil: 0,
    adminSavingsPctCombined: 0, transportIncreasePctCombined: 0, netImpactPctCombined: 0,
    adminSavingsPctSpokesSpending: 0, transportIncreasePctSpokesSpending: 0, netImpactPctSpokesSpending: 0,
    spokeBreakdown: [],
    warnings: [], missing: { budgets: [], enrollment: [], anchors: [] }, ok: false,
  };

  if (unique.length < 2) {
    return { ...empty, warnings: ['Select at least 2 districts'] };
  }

  for (const k of unique) {
    const b = budgets[k];
    const e = enrollments[k];
    const a = anchors[k];
    if (!b) missingBudgets.push(k);
    if (!e || !e.total || e.total <= 0) missingEnrollment.push(k);
    if (!a) missingAnchors.push(k);
    if (b?.flags?.length) {
      for (const f of b.flags) warnings.push(`${b.displayName}: ${f}`);
    }
  }

  if (missingBudgets.length || missingEnrollment.length || missingAnchors.length) {
    return {
      ...empty,
      warnings,
      missing: { budgets: missingBudgets, enrollment: missingEnrollment, anchors: missingAnchors },
    };
  }

  let hubKey = unique[0];
  let hubEnroll = 0;
  for (const k of unique) {
    const total = enrollments[k].total;
    if (total > hubEnroll) { hubEnroll = total; hubKey = k; }
  }

  const hubAnchor = anchors[hubKey];
  const hubBudget = budgets[hubKey];

  let combinedEnrollment = 0;
  let combinedSpending = 0;
  let adminBaselineSpokes = 0;
  const adminBaselineHub = hubBudget.centralAdministrationModel;

  for (const k of unique) {
    combinedEnrollment += enrollments[k].total;
    combinedSpending += budgets[k].totalExpenditures;
    if (k !== hubKey) {
      adminBaselineSpokes += budgets[k].centralAdministrationModel;
    }
  }

  const baselinePerPupil = combinedEnrollment > 0 ? combinedSpending / combinedEnrollment : 0;
  const adminSavings = rate * adminBaselineSpokes;

  const spokeBreakdown: SpokeDetail[] = [];
  let transportationIncrease = 0;

  for (const k of unique) {
    if (k === hubKey) continue;
    const a = anchors[k];
    const dist = milesBetween(
      { lat: a.lat, lon: a.lon },
      { lat: hubAnchor.lat, lon: hubAnchor.lon },
    );
    if (dist > 60) warnings.push(`${a.displayName}: distance ${dist.toFixed(1)} mi seems high`);
    const enr = enrollments[k].total;
    const cost = dist * enr * share * cpsm;
    transportationIncrease += cost;
    spokeBreakdown.push({
      key: k,
      name: anchors[k].displayName,
      enrollment: enr,
      distanceMiles: Math.round(dist * 10) / 10,
      cost: Math.round(cost),
    });
  }
  spokeBreakdown.sort((a, b) => b.cost - a.cost);

  const netImpact = adminSavings - transportationIncrease;
  const projectedSpending = combinedSpending - netImpact;
  const projectedPerPupil = combinedEnrollment > 0 ? projectedSpending / combinedEnrollment : 0;

  const hubSpending = hubBudget.totalExpenditures;
  const spokesSpending = combinedSpending - hubSpending;

  const safePct = (num: number, den: number) => (den > 0 ? num / den : 0);

  return {
    hubKey,
    hubName: hubAnchor.displayName,
    combinedEnrollment,
    combinedSpending,
    hubSpending,
    spokesSpending,
    baselinePerPupil,
    adminBaselineHub,
    adminBaselineSpokes,
    adminSavings,
    transportationIncrease,
    netImpact,
    projectedSpending,
    projectedPerPupil,
    adminSavingsPctCombined: safePct(adminSavings, combinedSpending),
    transportIncreasePctCombined: safePct(transportationIncrease, combinedSpending),
    netImpactPctCombined: safePct(netImpact, combinedSpending),
    adminSavingsPctSpokesSpending: safePct(adminSavings, spokesSpending),
    transportIncreasePctSpokesSpending: safePct(transportationIncrease, spokesSpending),
    netImpactPctSpokesSpending: safePct(netImpact, spokesSpending),
    spokeBreakdown,
    warnings,
    missing: { budgets: [], enrollment: [], anchors: [] },
    ok: true,
  };
}
