// Resolve a Simpro job into the composite "AssignedTo" ID expected by the
// vendor-order POST endpoint.
//
// Background: in Simpro a Purchase Order is bound to a job's specific
// Cost Centre. The API stores this via an opaque integer that maps
// (Job, Section, CostCenter) -> AssignedTo.ID. You can't synthesise this
// integer; you have to fetch it from
//   /jobs/{jobId}/sections/{sectionId}/costCenters/
//
// Most service jobs have exactly 1 section + 1 cost centre, so we can
// auto-resolve. Larger jobs (multi-section construction) have several;
// in that case we list them and ask the caller to pick costCenterId.

import { SimproClient } from "../simpro/client.js";

interface SectionRow {
  ID: number;
  Name?: string;
  Description?: string;
  DisplayOrder?: number;
}

interface CostCenterRow {
  ID: number; // <- This IS the AssignedTo composite ID
  CostCenter?: { ID?: number; Name?: string };
  JobID?: number;
  Name?: string;
  Total?: { IncTax?: number };
}

export interface JobAssignmentResolution {
  /** The integer to send as AssignedTo on the PO POST. */
  matchedId?: number;
  /** All Job-Section-CostCenter combos found, for disambiguation. */
  candidates: {
    assignedToId: number;
    sectionId: number;
    costCenterId: number;
    label: string;
  }[];
  note: string;
}

export async function resolveJobAssignment(
  client: SimproClient,
  jobId: string | number,
  costCenterId?: string | number,
): Promise<JobAssignmentResolution> {
  // 1. Fetch sections of the job.
  const sectionsPath = client.companyPath(`/jobs/${encodeURIComponent(String(jobId))}/sections/`);
  let sections: SectionRow[];
  try {
    sections = (await client.get<SectionRow[]>(sectionsPath)) ?? [];
  } catch (err) {
    return {
      candidates: [],
      note:
        `Could not load sections for job #${jobId}. ` +
        `Simpro said: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (sections.length === 0) {
    return {
      candidates: [],
      note: `Job #${jobId} has no sections — cannot attach a PO to it.`,
    };
  }

  // 2. For every section, fetch its cost centres. Each cost centre row's
  //    .ID is the composite AssignedTo we need.
  const candidates: JobAssignmentResolution["candidates"] = [];
  for (const sec of sections) {
    const ccPath = client.companyPath(
      `/jobs/${encodeURIComponent(String(jobId))}/sections/${sec.ID}/costCenters/`,
    );
    try {
      const ccs = (await client.get<CostCenterRow[]>(ccPath)) ?? [];
      for (const cc of ccs) {
        candidates.push({
          assignedToId: cc.ID,
          sectionId: sec.ID,
          costCenterId: cc.CostCenter?.ID ?? -1,
          label: `${cc.CostCenter?.Name ?? "(unnamed cost centre)"}` +
                 `${sec.Name ? ` / section ${sec.Name}` : ""}`,
        });
      }
    } catch {
      // Skip silently if a section's cost centres can't be loaded.
    }
  }
  if (candidates.length === 0) {
    return {
      candidates: [],
      note: `Job #${jobId} has no cost centres — cannot attach a PO. Fix this in the Simpro web UI first.`,
    };
  }

  // 3. If caller specified costCenterId, filter to it.
  if (costCenterId !== undefined && costCenterId !== null && costCenterId !== "") {
    const wantedCc = Number(costCenterId);
    const matched = candidates.filter((c) => c.costCenterId === wantedCc);
    if (matched.length === 0) {
      return {
        candidates,
        note:
          `Cost centre #${costCenterId} not found on job #${jobId}. ` +
          `Available cost centres on this job:\n` +
          candidates.map((c) => `  - ${c.label} (costCenterId: ${c.costCenterId})`).join("\n"),
      };
    }
    if (matched.length > 1) {
      return {
        candidates: matched,
        note:
          `Cost centre #${costCenterId} appears in multiple sections of job #${jobId}. ` +
          `Pass an explicit AssignedTo via rawPayload, choosing one of:\n` +
          matched.map((c) => `  - ${c.label} (assignedToId: ${c.assignedToId})`).join("\n"),
      };
    }
    return {
      matchedId: matched[0].assignedToId,
      candidates: matched,
      note: `Resolved job #${jobId} cost-centre #${costCenterId} -> AssignedTo #${matched[0].assignedToId} (${matched[0].label})`,
    };
  }

  // 4. No cost centre specified. If only one candidate, use it. Otherwise
  //    ask the caller to disambiguate.
  if (candidates.length === 1) {
    return {
      matchedId: candidates[0].assignedToId,
      candidates,
      note: `Job #${jobId} has one cost centre, auto-attached: ${candidates[0].label} (AssignedTo #${candidates[0].assignedToId})`,
    };
  }
  return {
    candidates,
    note:
      `Job #${jobId} has ${candidates.length} cost centres. ` +
      `Re-run with a costCenterId from the list:\n` +
      candidates.map((c) => `  - ${c.label} (costCenterId: ${c.costCenterId})`).join("\n"),
  };
}
