import type { Admin, Writer } from "@brain/mcp-tools";
import type { SchemaExecutor } from "@brain/schema";

/**
 * Seed a realistic demo company brain — "Meridian Federal Solutions", a
 * 30-person GovCon (cloud + DevSecOps for federal agencies). Built to show
 * every dashboard feature against believable content: agencies, contracts,
 * opportunities with capture state, people (COs/CORs), meeting notes with
 * markdown tables, bid/no-bid decisions, compliance playbooks, dense
 * cross-links, and private objects. Deterministic: dev-box drops the DB
 * before calling this.
 */

interface SeededToken {
  readonly name: string;
  readonly permission: "owner" | "member" | "viewer";
  readonly token: string;
  readonly accountId: string;
}

interface Deps {
  readonly admin: Admin;
  readonly writer: Writer;
  readonly executor: SchemaExecutor;
}

const W = { scopes: ["read", "write"] as const };

export async function seedBrain({ admin, writer, executor }: Deps): Promise<SeededToken[]> {
  // ---- accounts -----------------------------------------------------------
  const owner = await admin.bootstrapOwner({ name: "Alice", email: "alice@meridianfed.example" });
  const maya = await admin.createUser(owner.id, {
    name: "Maya Chen",
    email: "maya@meridianfed.example",
    permission: "member",
  });
  const sam = await admin.createUser(owner.id, {
    name: "Sam Rivera",
    email: "sam@meridianfed.example",
    permission: "member",
  });
  const board = await admin.createUser(owner.id, {
    name: "Board Observer",
    email: "observer@meridianfed.example",
    permission: "viewer",
  });

  const asOwner = { actorId: owner.id, ...W };
  const asMaya = { actorId: maya.id, ...W };
  const asSam = { actorId: sam.id, ...W };

  // ---- schema -------------------------------------------------------------
  const agency = await executor.defineType(
    { name: "agency", label: "Agency", description: "Federal agencies and components we serve" },
    owner.id,
  );
  await executor.addProperty(
    { typeId: agency.typeId, name: "abbreviation", kind: "text" },
    owner.id,
  );
  await executor.addProperty(
    {
      typeId: agency.typeId,
      name: "sector",
      kind: "enum",
      enumValues: ["civilian", "defense", "intel"],
    },
    owner.id,
  );

  const contract = await executor.defineType(
    { name: "contract", label: "Contract", description: "Awarded work — task orders and BPAs" },
    owner.id,
  );
  await executor.addProperty(
    { typeId: contract.typeId, name: "contract_number", kind: "text" },
    owner.id,
  );
  await executor.addProperty({ typeId: contract.typeId, name: "vehicle", kind: "text" }, owner.id);
  await executor.addProperty({ typeId: contract.typeId, name: "value_usd", kind: "int" }, owner.id);
  await executor.addProperty(
    {
      typeId: contract.typeId,
      name: "phase",
      kind: "enum",
      enumValues: ["active", "option_year", "closeout", "closed"],
    },
    owner.id,
  );
  await executor.addProperty({ typeId: contract.typeId, name: "pop_end", kind: "date" }, owner.id);
  await executor.addProperty(
    { typeId: contract.typeId, name: "customer", kind: "ref", refTypeName: "agency" },
    owner.id,
  );

  const opportunity = await executor.defineType(
    {
      name: "opportunity",
      label: "Opportunity",
      description: "The pipeline — from first scent to submitted",
    },
    owner.id,
  );
  await executor.addProperty(
    {
      typeId: opportunity.typeId,
      name: "stage",
      kind: "enum",
      enumValues: ["identified", "capture", "proposal", "submitted", "won", "lost"],
    },
    owner.id,
  );
  await executor.addProperty(
    { typeId: opportunity.typeId, name: "ceiling_usd", kind: "int" },
    owner.id,
  );
  await executor.addProperty({ typeId: opportunity.typeId, name: "pwin", kind: "int" }, owner.id);
  await executor.addProperty(
    { typeId: opportunity.typeId, name: "due_date", kind: "date" },
    owner.id,
  );
  await executor.addProperty(
    { typeId: opportunity.typeId, name: "solicitation", kind: "text" },
    owner.id,
  );
  await executor.addProperty(
    { typeId: opportunity.typeId, name: "customer", kind: "ref", refTypeName: "agency" },
    owner.id,
  );

  const person = await executor.defineType(
    { name: "person", label: "Person", description: "COs, CORs, PMs, and partners" },
    owner.id,
  );
  await executor.addProperty({ typeId: person.typeId, name: "job_title", kind: "text" }, owner.id);
  await executor.addProperty({ typeId: person.typeId, name: "email", kind: "text" }, owner.id);
  await executor.addProperty(
    { typeId: person.typeId, name: "organization", kind: "ref", refTypeName: "agency" },
    owner.id,
  );

  const meeting = await executor.defineType(
    {
      name: "meeting",
      label: "Meeting",
      description: "Customer syncs, capture reviews, debriefs",
    },
    owner.id,
  );
  await executor.addProperty({ typeId: meeting.typeId, name: "held_on", kind: "date" }, owner.id);
  await executor.addProperty(
    { typeId: meeting.typeId, name: "customer", kind: "ref", refTypeName: "agency" },
    owner.id,
  );
  await executor.addProperty(
    { typeId: meeting.typeId, name: "attendees", kind: "ref[]", refTypeName: "person" },
    owner.id,
  );

  const decision = await executor.defineType(
    { name: "decision", label: "Decision", description: "Bid/no-bid calls and their rationale" },
    owner.id,
  );
  await executor.addProperty(
    {
      typeId: decision.typeId,
      name: "verdict",
      kind: "enum",
      enumValues: ["proposed", "accepted", "superseded"],
    },
    owner.id,
  );
  await executor.addProperty(
    { typeId: decision.typeId, name: "decided_on", kind: "date" },
    owner.id,
  );

  const playbook = await executor.defineType(
    {
      name: "playbook",
      label: "Playbook",
      description: "How Meridian runs — compliance, proposals, incidents",
    },
    owner.id,
  );
  await executor.addProperty({ typeId: playbook.typeId, name: "area", kind: "text" }, owner.id);

  // ---- helper ---------------------------------------------------------------
  const mk = async (
    ctx: typeof asOwner,
    input: Parameters<Writer["write"]>[1],
  ): Promise<string> => {
    // A demo brain is a SHARED fixture: default the seed org-visible (the
    // wave-2 writer default is private, which would strand every cross-member
    // ref and link below). Entries that opt into private still win.
    const r = await writer.write(ctx, { visibility: "org", ...input });
    return (r as { id: string }).id;
  };

  // ---- agencies ---------------------------------------------------------------
  const cisa = await mk(asOwner, {
    type: "agency",
    title: "DHS CISA",
    props: { abbreviation: "CISA", sector: "civilian" },
    body: `Cybersecurity and Infrastructure Security Agency. Our anchor civilian
customer since 2023 — the SOC modernization BPA is the reference we win with.

**Buying pattern:** BPAs off GSA MAS, strong small-business goals, technical
evaluations weight past performance heavily.`,
  });

  const va = await mk(asOwner, {
    type: "agency",
    title: "Department of Veterans Affairs",
    props: { abbreviation: "VA", sector: "civilian" },
    body: `Largest civilian IT budget in government. We entered through the EHR
data-migration task order; OIT is consolidating vendors, which cuts both ways.

**Watch:** the Loma Linda refresh is our expansion play — win it and we're a
two-contract incumbent going into the FY27 recompete.`,
  });

  const usaf = await mk(asMaya, {
    type: "agency",
    title: "US Air Force — AFLCMC",
    props: { abbreviation: "AFLCMC", sector: "defense" },
    body: `Air Force Life Cycle Management Center. Our first defense customer
(DevSecOps enablement, closed March 2026 with a 4.8 CPARS). Kessel Run is the
door back in.`,
  });

  const gsa = await mk(asMaya, {
    type: "agency",
    title: "General Services Administration",
    props: { abbreviation: "GSA", sector: "civilian" },
    body: `Both a customer target and our contract-vehicle home (GSA MAS,
category 54151S). The cloud IDIQ on-ramp closes in September — a must-bid for
vehicle position even at low pwin.`,
  });

  // ---- people -----------------------------------------------------------------
  const okafor = await mk(asMaya, {
    type: "person",
    title: "Dana Okafor",
    props: {
      job_title: "Contracting Officer",
      email: "dana.okafor@cisa.example.gov",
      organization: cisa,
    },
    body: `CO on the SOC modernization BPA. By-the-book, communicates only
through official channels during open procurements. Respects vendors who keep
mods clean and CDRLs on time.`,
    links: [{ rel: "works_at", to: cisa }],
  });

  const raman = await mk(asOwner, {
    type: "person",
    title: "Priya Raman",
    props: { job_title: "COR", email: "priya.raman@va.example.gov", organization: va },
    body: `COR on the EHR data-migration task order. Deeply technical (ex-DBA),
reads every deliverable. Our monthly status reviews with her run long and
that's a good sign — she's our best reference at VA.`,
    links: [{ rel: "works_at", to: va }],
  });

  const silva = await mk(asSam, {
    type: "person",
    title: "Marco Silva",
    props: {
      job_title: "Program Manager, Kessel Run",
      email: "marco.silva@usaf.example.mil",
      organization: usaf,
    },
    body: `PM on the Kessel Run data-pipeline effort. Met at AFCEA West. Wants
contractors who ship inside their platform, not around it. Follow up quarterly.`,
    links: [{ rel: "works_at", to: usaf }],
  });

  // ---- contracts ----------------------------------------------------------------
  const socBpa = await mk(asOwner, {
    type: "contract",
    title: "CISA SOC Modernization BPA",
    props: {
      contract_number: "70RCSA23FR0000012",
      vehicle: "GSA MAS 54151S",
      value_usd: 8_750_000,
      phase: "option_year",
      pop_end: "2027-09-29",
      customer: cisa,
    },
    body: `Five-year BPA modernizing CISA's security-operations tooling:
SIEM consolidation, detection-as-code, SOAR runbooks.

## Health
- Option year 2 exercised on time; **CPARS 4.6** last cycle.
- Staffing at 11 FTE; one open req (detection engineer, TS/SCI preferred).

## Risks
- FY27 budget pressure on the SIEM licensing line — flagged to Dana Okafor.
- Recompete expected as a full-and-open RFQ in early FY27; past performance
  from this BPA is the moat.`,
    links: [
      { rel: "with", to: cisa },
      { rel: "point_of_contact", to: okafor },
    ],
  });

  const vaTo = await mk(asOwner, {
    type: "contract",
    title: "VA EHR Data Migration — TO 47QTCA24F0087",
    props: {
      contract_number: "47QTCA24F0087",
      vehicle: "GSA MAS 54151S",
      value_usd: 4_200_000,
      phase: "active",
      pop_end: "2027-03-31",
      customer: va,
    },
    body: `Task order migrating legacy VistA data into the new EHR platform for
three VISN-22 facilities.

## Deliverable status (July)
| CDRL | Item | Due | Status |
|---|---|---|---|
| A003 | Migration runbook v3 | Jul 15 | on track |
| A004 | Data-quality report | Jul 31 | on track |
| A007 | Cutover rehearsal report | Aug 22 | at risk — env access |

The A007 risk is a VA-side environment provisioning delay; Priya Raman is
escalating internally. Documented in the July status review.`,
    links: [
      { rel: "with", to: va },
      { rel: "point_of_contact", to: raman },
    ],
  });

  await mk(asSam, {
    type: "contract",
    title: "AFLCMC DevSecOps Enablement",
    props: {
      contract_number: "FA8730-24-F-0113",
      vehicle: "SEWP V",
      value_usd: 1_900_000,
      phase: "closed",
      pop_end: "2026-03-15",
      customer: usaf,
    },
    body: `Twelve-month platform enablement: pipeline hardening, IL5 ATO
support, 40-engineer enablement program. Closed March 2026, **CPARS 4.8** —
our strongest past-performance citation for defense pursuits.`,
    links: [{ rel: "with", to: usaf }],
  });

  // ---- opportunities --------------------------------------------------------------
  const lomaLinda = await mk(asMaya, {
    type: "opportunity",
    title: "VA Loma Linda Infrastructure Refresh",
    props: {
      stage: "proposal",
      ceiling_usd: 2_900_000,
      pwin: 65,
      due_date: "2026-07-21",
      solicitation: "36C26226Q0455",
      customer: va,
    },
    body: `Datacenter-to-cloud refresh for the Loma Linda VAMC, riding our EHR
incumbency at VISN-22.

## Proposal status
- Pink team done July 3 — technical volume strong, price volume thin.
- **Red team July 14.** Volumes due **July 21, 2:00 PM ET**.
- Win themes: incumbent data knowledge, zero-downtime cutover record, local
  cleared staff.

## Open items
- [ ] Sam: past-performance write-up from the EHR task order
- [ ] Maya: teaming agreement countersigned by network partner
- [ ] Pricing review against the PTW analysis (owner)`,
    links: [
      { rel: "with", to: va },
      { rel: "references", to: vaTo },
    ],
  });

  const ztPhase2 = await mk(asMaya, {
    type: "opportunity",
    title: "CISA Zero Trust Phase 2",
    props: {
      stage: "capture",
      ceiling_usd: 12_000_000,
      pwin: 45,
      due_date: "2026-10-09",
      solicitation: "70RCSA26R00000031 (draft)",
      customer: cisa,
    },
    body: `Follow-on to the ZT architecture pilots — identity, micro-segmentation,
and continuous validation across CISA's operational divisions. Draft RFP out;
final expected mid-August.

## Capture plan
1. Shape past-performance narrative around the SOC BPA (same eval office).
2. Decide prime vs sub with Aegis Federal by **July 25** (see teaming decision).
3. Callplan: Dana Okafor (vehicle Q&A only), CTO office industry day July 30.`,
    links: [
      { rel: "with", to: cisa },
      { rel: "references", to: socBpa },
    ],
  });

  const kesselRun = await mk(asSam, {
    type: "opportunity",
    title: "USAF Kessel Run Data Pipeline",
    props: {
      stage: "submitted",
      ceiling_usd: 3_400_000,
      pwin: 55,
      due_date: "2026-06-27",
      solicitation: "FA8730-26-R-0027",
      customer: usaf,
    },
    body: `Streaming data pipeline for mission-planning workloads inside the
Kessel Run platform. **Submitted June 27.** Award expected late August.

Debrief prep: if lost, request within 3 days; the AFLCMC CPARS 4.8 and Marco
Silva's platform-native evaluation criteria were our strongest angles.`,
    links: [
      { rel: "with", to: usaf },
      { rel: "point_of_contact", to: silva },
    ],
  });

  const gsaOnRamp = await mk(asMaya, {
    type: "opportunity",
    title: "GSA Cloud IDIQ On-Ramp",
    props: {
      stage: "identified",
      ceiling_usd: 50_000_000,
      pwin: 25,
      due_date: "2026-09-18",
      solicitation: "47QTCB26R0009",
      customer: gsa,
    },
    body: `On-ramp to the governmentwide cloud IDIQ. Ceiling is programmatic —
the prize is **vehicle position** for FY27–31, not near-term revenue. Low pwin
as a first-time on-ramper; bid decision accepted June 30 (see decision).`,
    links: [{ rel: "with", to: gsa }],
  });

  // ---- meetings --------------------------------------------------------------------
  await mk(asOwner, {
    type: "meeting",
    title: "VA — July monthly status review",
    props: { held_on: "2026-07-02", customer: va },
    body: `## Agenda
EHR task order monthlies with Priya Raman.

| Topic | Outcome |
|---|---|
| A003 runbook v3 | Draft accepted, minor comments by Jul 10 |
| A007 env access | VA provisioning slipped 2 weeks — **escalated** |
| Loma Linda | Priya confirmed eval board is VISN-level, not central OIT |

## Actions
- [ ] Sam: respond to A003 comments by July 10
- [ ] Alice: risk memo on A007 slip for the contract file
- [x] Maya: log the eval-board intel on the Loma Linda opportunity`,
    links: [
      { rel: "about", to: vaTo },
      { rel: "attendees", to: raman },
    ],
  });

  await mk(asMaya, {
    type: "meeting",
    title: "Loma Linda pink-team readout",
    props: { held_on: "2026-07-03", customer: va },
    body: `Pink team scored the technical volume **blue/green** across factors;
price volume needs the PTW pass before red team.

Key edits: lead with the zero-downtime cutover metric (14 cutovers, zero
unplanned downtime) in the executive summary; move the staffing matrix to an
appendix; tighten the transition-in plan to 30 days.`,
    links: [{ rel: "about", to: lomaLinda }],
  });

  await mk(asSam, {
    type: "meeting",
    title: "CISA industry day — Zero Trust Phase 2",
    props: { held_on: "2026-06-24", customer: cisa },
    body: `CTO office briefed the phase-2 scope. Notable: continuous-validation
tooling will be **GFE**, so don't price a COTS stack; evaluation will weight
demonstrated SOC integration experience — squarely our SOC BPA story.

Aegis Federal was present and pitching prime. Teaming decision needed before
the final RFP drops (target July 25).`,
    links: [
      { rel: "about", to: ztPhase2 },
      { rel: "attendees", to: okafor },
    ],
  });

  // ---- decisions --------------------------------------------------------------------
  await mk(asOwner, {
    type: "decision",
    title: "Bid the GSA Cloud IDIQ on-ramp",
    props: { verdict: "accepted", decided_on: "2026-06-30" },
    body: `## Context
First-time on-rampers rarely win, and B&P for an IDIQ volume set is ~$120k.

## Decision
Bid anyway. Vehicle position drives the FY27–31 pipeline; without a seat, we
sub on every large cloud pursuit and cap our margin.

## Consequences
- B&P budget reallocated from the Q4 marketing line.
- Maya owns the volume plan; draft outline due July 18.`,
    links: [{ rel: "motivated_by", to: gsaOnRamp }],
  });

  const teaming = await mk(asMaya, {
    type: "decision",
    title: "Teaming posture on Zero Trust Phase 2: prime with Aegis as sub",
    props: { verdict: "proposed", decided_on: "2026-07-07" },
    body: `## Context
Aegis Federal wants to prime with us as sub. Our SOC BPA past performance is
the strongest technical citation either firm has for this eval office.

## Proposal
**We prime.** Offer Aegis the identity workstream (~30%) as sub. If they
refuse and prime against us, we still hold the past-performance high ground.

## Risk
Aegis has the incumbent ZT phase-1 architect on staff. If they walk, recruit
for that skill set immediately.`,
    links: [{ rel: "motivated_by", to: ztPhase2 }],
  });

  await mk(asOwner, {
    type: "decision",
    title: "Pursue CMMC Level 2 certification by Q1 FY27",
    props: { verdict: "accepted", decided_on: "2026-05-20" },
    body: `Defense pipeline (Kessel Run and everything behind it) increasingly
requires CMMC L2 at award. Self-assessment scored 88/110; remediation plan is
the compliance playbook. Assessment window booked for **January 2027**.`,
    links: [{ rel: "motivated_by", to: kesselRun }],
  });

  // ---- playbooks --------------------------------------------------------------------
  await mk(asSam, {
    type: "playbook",
    title: "CMMC Level 2 evidence collection",
    props: { area: "compliance" },
    body: `How we collect and maintain the 110-control evidence base.

## Cadence
1. Control owners update evidence in the GRC tracker **monthly**.
2. Quarterly internal audit samples 15 controls; findings get 30-day fixes.
3. POA&M items older than 90 days escalate to the owner directly.

## CUI handling
- CUI lives only in the enclave (GCC High). **Never** in the corporate tenant.
- Suspected spill → run the CUI spill playbook within the hour.`,
  });

  await mk(asMaya, {
    type: "playbook",
    title: "Proposal color-team process",
    props: { area: "growth" },
    body: `## Gates
| Team | When | Question it answers |
|---|---|---|
| Blue | Capture → proposal handoff | Do we have a win strategy? |
| Pink | ~60% draft | Is the story compliant and compelling? |
| Red | ~95% draft | Would an evaluator score this blue? |
| Gold | Pre-submission | Is it signed, priced, and submittable? |

Every review produces written comments in the proposal workspace within 24
hours — verbal-only feedback doesn't count.`,
  });

  await mk(asSam, {
    type: "playbook",
    title: "CUI spill incident response",
    props: { area: "security" },
    body: `Suspected CUI outside the enclave is a **drop-everything event**.

1. Isolate: revoke sharing, snapshot the artifact, note timestamps.
2. Notify the FSO within **1 hour** of discovery.
3. FSO determines reportability (DFARS 252.204-7012: 72-hour clock).
4. Preserve images for the after-action; never delete before the FSO clears it.
5. After-action within 5 business days; update the evidence base.`,
  });

  // ---- deprecated + deleted demo state ---------------------------------------------------
  // A legacy type: the vendor-tracking experiment, retired after Q1. The type
  // (and its one record) stay readable but render struck-through everywhere.
  const vendor = await executor.defineType(
    {
      name: "vendor",
      label: "Vendor",
      description: "(legacy) subcontractor tracking — folded into teaming decisions",
    },
    owner.id,
  );
  await executor.addProperty({ typeId: vendor.typeId, name: "cage_code", kind: "text" }, owner.id);
  await mk(asOwner, {
    type: "vendor",
    title: "Aegis Federal",
    props: { cage_code: "7XKq4" },
    body: `Legacy vendor record from the Q1 vendor-tracking experiment. Kept for
history — teaming posture now lives on decisions (see Zero Trust Phase 2).`,
  });
  await executor.deprecateType(vendor.typeId, owner.id);

  // A deprecated property: opportunities briefly tracked NAICS inline; the
  // catalog keeps the column but hides it from columns/filters/writes.
  const naics = await executor.addProperty(
    { typeId: opportunity.typeId, name: "naics", kind: "text" },
    owner.id,
  );
  await executor.deprecateProperty(naics.propertyId, owner.id);

  // Deleted objects: tombstones the trash shows (soft-delete keeps them forever).
  const lostOpp = await mk(asMaya, {
    type: "opportunity",
    title: "DHS HQ Network Refresh",
    props: {
      stage: "lost",
      ceiling_usd: 6_500_000,
      pwin: 20,
      due_date: "2026-04-17",
      solicitation: "70RDAD26R00000009",
      customer: cisa,
    },
    body: `Lost to the incumbent in April. Debrief: our transition-in plan was
scored acceptable vs their outstanding; price was within 3%. Deleted after the
post-mortem was folded into the capture playbook.`,
  });
  await writer.softDelete(asMaya, lostOpp);

  const staleMeeting = await mk(asSam, {
    type: "meeting",
    title: "GSA vehicle office sync (cancelled)",
    props: { held_on: "2026-06-12", customer: gsa },
    body: `Cancelled by the vehicle office — rescheduled content was covered in
the June 24 industry day instead. Deleted to keep the meeting list honest.`,
  });
  await writer.softDelete(asSam, staleMeeting);

  // ---- untyped notes (free-form, outside every database) -------------------------------
  await mk(asOwner, {
    title: "Scratch — AFCEA West follow-ups",
    body: `Loose notes from the conference floor, to be filed properly later.

- Kessel Run intro came from the Booz table, oddly — send Marco the platform
  one-pager.
- Two SDVOSB primes hunting for a cloud sub on VA work: **Summit Ridge** and
  Calvary Federal. Summit Ridge felt more real.
- Idea: a capability brief specifically for VISN-level buyers — shorter, more
  outcome numbers, less architecture.`,
  });

  await mk(asSam, {
    title: "All-hands notes — July 3",
    body: `Quick capture from the monthly all-hands.

## Said out loud
- Loma Linda red team is the **only** July priority for delivery folks with
  spare cycles.
- CMMC evidence collection is now a monthly cadence — control owners assigned.
- New hire: detection engineer req approved (SOC BPA staffing).

## Parking lot
- Should playbooks live in the brain or the wiki? (Leaning brain — linkable.)`,
  });

  // ---- private objects (permission-scoping demo) ---------------------------------------
  await mk(asOwner, {
    type: "decision",
    title: "PTW analysis — Loma Linda (close hold)",
    visibility: "private",
    props: { verdict: "proposed", decided_on: "2026-07-05" },
    body: `**Private — owner only.** Price-to-win: $2.61M ± 4%, anchored on the
incumbent network vendor's GSA rates and VISN-22's FY26 obligation pattern.
Bid at $2.58M (11.2% margin) and hold — do not chase below $2.5M.`,
    links: [{ rel: "about", to: lomaLinda }],
  });

  await mk(asMaya, {
    type: "meeting",
    title: "Maya ↔ Alice 1:1 — comp discussion",
    visibility: "private",
    sharedWith: [owner.id],
    props: { held_on: "2026-07-03" },
    body: `**Private — shared with Alice only.** Discussed Maya's case for a
capture-director title ahead of the October cycle, tied to the Zero Trust
prime decision landing. Revisit in the September 1:1.`,
    links: [{ rel: "about", to: teaming }],
  });

  return [
    { name: "Alice", permission: "owner", token: owner.token, accountId: owner.id },
    { name: "Maya Chen", permission: "member", token: maya.token, accountId: maya.id },
    { name: "Sam Rivera", permission: "member", token: sam.token, accountId: sam.id },
    { name: "Board Observer", permission: "viewer", token: board.token, accountId: board.id },
  ];
}
