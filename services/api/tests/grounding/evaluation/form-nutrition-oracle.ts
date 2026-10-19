import type { ObservationEntry, ResearchCoverage, CorpusStatus } from '../../../src/grounding/index.js';

// Frozen independently from source packets at 0c68e727, never from producer output or composer.
export const proteinOriginal: ObservationEntry = {
  "record": {
    "kind": "source_observation",
    "topic_ids": [
      "NUT-I3"
    ],
    "accessed": "2026-10-11",
    "clinical_readiness": "CL-0",
    "conflicts": [],
    "id": "NUT-S034",
    "title": "Protein supplementation and resistance training: qualified original FFM estimate",
    "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC5867436/",
    "doi": "10.1136/bjsports-2017-097608",
    "pmid": "28698222",
    "published": "2017 online /2018 issue",
    "access_level": "partial",
    "locator": "Selected original Methods: Inclusion criteria, Data extraction, Data syntheses, Meta-analyses, Heterogeneity and risk of bias; Results: Participant characteristics, RET characteristics, Meta-analyses, Figure 3 caption and Table 1 no-covariates FFM row; October 11 retained appraisal only.",
    "summary": "The no-covariates fat-free-mass (FFM) model reported an average protein supplement-comparator difference of 0.30 kg (95% CI 0.09–0.52; p=0.007) across 27 studies, against identical resistance training plus placebo or no protein supplement. The whole review included 49 studies / 1,863 participants; the FFM endpoint participant denominator is unknown. Eligible participants were healthy and non-energy-restricted, training at least six weeks and at least twice weekly, without other potentially hypertrophic supplement agents. FFM includes lean or bone-free mass when FFM is unavailable, measured by DXA, hydrodensitometry or BodPod: a proxy, not direct muscle mass or an individual benefit guarantee. The retained protein breakpoint of 1.62 g/kg/day (CI 1.03–2.20) is imprecise and supplies no individual ceiling or intake target. The 2020 correction adds an author conflict-of-interest disclosure and reports no numerical revision; its body was not reverified in the later appraisal.",
    "source_native_certainty": "Reported statistical estimate and interval, transcribed rather than recalculated; no formal certainty grade captured.",
    "form_appraisal": "Candidate informative observation only, CL-0; no completed formal certainty appraisal or scientific acceptance. Endpoint participant counts, underlying trial/cohort reconciliation and supplements remain unaudited. Studies with at least three high/unclear risk domains were excluded; endpoint-specific exclusions were reported. The correction adds Schoenfeld's Dymatize Nutrition advisory-board disclosure; disclosure alone establishes neither bias magnitude nor invalidity. Selected excerpt verification applies only to its recorded excerpt and named spans, not this entire record, retained packet passages or complete edition.",
    "applicability": "Eligible trial populations only; no extrapolation to energy restriction, illness or individualized prescriptions. Individual applicability is unassessed. No individual benefit, muscle-mass guarantee or intake target follows. Other NUT-I3 questions—distribution, per-meal amounts, timing, sources/quality, older adults and upper intakes—remain uncovered by this observation.",
    "rights_status": "Metadata and original paraphrase; publication/product reuse rights remain unassessed. No new rights clearance or original passages captured.",
    "freshness_status": "Reuses selected original inspection of October 11, 2026; no fresh web access. Original/correction DOI and PMID linkage was verified reciprocally in that appraisal; correction body was not reverified. Known correction is not comprehensive later-notice clearance; current notices remain unknown and recorded access failures are preserved.",
    "provenance": "Form-owned follow-up observation reusing retained NUT-S001 and NUT-S016, claim NUT-CLM-001 and lineage WS36-LIN04. Original DOI 10.1136/bjsports-2017-097608, PMID 28698222, PMC5867436; correction DOI 10.1136/bjsports-2017-097608corr1, PMID 32943392. Bound to docs/knowledge/source-appraisal/protein-original-followup.json SHA256 7d85f9a8ddba378cbc6bbfb1180534f0ed4c10dcce9322dde4e0f36732be8e8d and methods/nut-i3-protein-original.md SHA256 7f34beff90a965f75d0eea7d89698bc441a54cf77c43b17322ba2cafe1d40114. A new observation of existing evidence, not an independent replication, additional intervention or new participants; do not double-count. No runtime adoption or original-passage-verification promotion."
  },
  "source_path": "sources/nut-i3-protein-original.md",
  "line": 9,
  "source_packet_sha256": "f8bbcf9e56c96a7b9122121d4498d84cd628e52a73fb7594f1d6016575a731e2"
};

const packetCoverage: ResearchCoverage = {
  "schema": "form.research-coverage/v1",
  "authority_effect": "none",
  "source_plan": "sources/businesslessons/core/plans/form-knowledge-research-plan.md",
  "source_plan_revision": "8a5cac17ae5cfae942c76bbeeb24bf2bd2a12902",
  "units": [
    {
      "unit_id": "FND-A1",
      "title": "Claim schema and evidence grading — deep. Deps: none; E2.",
      "state": "unsearched"
    },
    {
      "unit_id": "FND-A2",
      "title": "Canonical ontology and vocabulary — medium. Deps: E3.",
      "state": "unsearched"
    },
    {
      "unit_id": "FND-A3",
      "title": "Search protocol, source registry and freshness policy — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "FND-A4",
      "title": "Prior-evidence reuse audit — medium. Deps: E1, E2, E3.",
      "state": "unsearched"
    },
    {
      "unit_id": "FND-A5",
      "title": "Premise register setup — light. Out: the §5 register created as a live artifact.",
      "state": "unsearched"
    },
    {
      "unit_id": "FND-A6",
      "title": "Scope and referral-boundary frame — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "EXU-B1",
      "title": "Family inventory and coverage rule — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "EXU-B2",
      "title": "Variant expansion per family — medium. W2. Deps: B1, ANA-C1, FND-A2.",
      "state": "unsearched"
    },
    {
      "unit_id": "EXU-B3",
      "title": "Equipment taxonomy and substitution equivalence — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "EXU-B4",
      "title": "Technique standards, faults, cues and media — medium. W2. Deps: B2.",
      "state": "partial"
    },
    {
      "unit_id": "EXU-B5",
      "title": "Non-resistance modality catalog (mobility, stretching, plyometric, conditioning) — light/medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "ANA-C1",
      "title": "Muscle inventory and functional anatomy — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "ANA-C2",
      "title": "Role taxonomy and evidence ladder — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "ANA-C3",
      "title": "Variant role binding — deep for contested bindings, medium otherwise. W2. Deps: EXU-B2, C1, C2, MEC-D1, MEC-D2.",
      "state": "unsearched"
    },
    {
      "unit_id": "ANA-C4",
      "title": "Volume attribution across roles — medium. W2. Deps: C3, DOS-E3.",
      "state": "unsearched"
    },
    {
      "unit_id": "MEC-D1",
      "title": "Resistance profiles and strength curves — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "MEC-D2",
      "title": "Joint and positional demand per variant — deep. W2. Deps: EXU-B2, ANA-C1.",
      "state": "unsearched"
    },
    {
      "unit_id": "MEC-D3",
      "title": "Practical constraints — light. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "DOS-E1",
      "title": "Goal taxonomy and outcome measures — medium.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E2",
      "title": "Load and rep range — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "DOS-E3",
      "title": "Volume dose-response — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "DOS-E4",
      "title": "Effort and proximity to failure — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "DOS-E5",
      "title": "Tempo, rep duration, pauses and eccentric emphasis — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "DOS-E6",
      "title": "ROM, muscle length and lengthened partials — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "DOS-E7",
      "title": "Frequency and rest intervals — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "DOS-E8",
      "title": "Set structures, ordering and warm-up — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "APL-F1",
      "title": "Region- and muscle-specific dose responses — deep. W2. Deps: DOS-E2 through E6.",
      "state": "unsearched"
    },
    {
      "unit_id": "APL-F2",
      "title": "Population moderators — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "APL-F3",
      "title": "Special-population boundaries — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "APL-F4",
      "title": "Individual variability and N-of-1 inference limits — deep. W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "PRG-G1",
      "title": "Progression models and autoregulation — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "PRG-G2",
      "title": "Program structure — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "PRG-G3",
      "title": "Adaptation operations — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "PRG-G4",
      "title": "Progress measurement — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "CAR-H1",
      "title": "Activity guidelines and health targets — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "CAR-H2",
      "title": "Intensity prescription and measurement — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "CAR-H3",
      "title": "Modalities and methods — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "CAR-H4",
      "title": "Concurrent-training interference and sequencing — deep. W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "CAR-H5",
      "title": "Cardio in energy balance and body composition — medium. W2. Deps: NUT-I1, NUT-I2.",
      "state": "unsearched"
    },
    {
      "unit_id": "NUT-I1",
      "title": "Energy-need estimation and uncertainty — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "NUT-I2",
      "title": "Deficit, surplus and rate — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "NUT-I3",
      "title": "Protein — deep.",
      "state": "partial"
    },
    {
      "unit_id": "NUT-I4",
      "title": "Carbohydrate, fat, fiber, micronutrient basics, dietary patterns and alcohol — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "NUT-I5",
      "title": "Food composition and logging accuracy — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "NUT-I6",
      "title": "Supplements — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "NUT-I7",
      "title": "Nutrition boundaries and communication — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "REC-J1",
      "title": "Sleep — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "REC-J2",
      "title": "Hydration, electrolytes and heat — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "REC-J3",
      "title": "Fatigue, soreness, readiness and overreaching — deep.",
      "state": "unsearched"
    },
    {
      "unit_id": "REC-J4",
      "title": "Recovery modalities — medium.",
      "state": "unsearched"
    },
    {
      "unit_id": "REC-J5",
      "title": "Life stress, menstrual cycle and age effects on recovery — medium. Evidence in this area is expected to be weak.",
      "state": "unsearched"
    },
    {
      "unit_id": "INJ-K1",
      "title": "Tissue types, classification and terminology — light/medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "INJ-K2",
      "title": "Healing physiology and timelines — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "INJ-K3",
      "title": "Pain science and symptom monitoring — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "INJ-K4",
      "title": "Return-to-activity frameworks — deep. W2. Deps: K1–K3, K7.",
      "state": "unsearched"
    },
    {
      "unit_id": "INJ-K5",
      "title": "Region-specific common conditions — deep. W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "INJ-K6",
      "title": "Post-surgical and arthroplasty states — deep. W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "INJ-K7",
      "title": "Red flags, urgent referral and preparticipation screening — deep. W1. This is safety-critical and runs early.",
      "state": "unsearched"
    },
    {
      "unit_id": "INJ-K8",
      "title": "Injury risk factors and prevention claims — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "INT-L1",
      "title": "Constraint model — deep. W2. Deps: FND-A2, MEC-D2, INJ-K1.",
      "state": "unsearched"
    },
    {
      "unit_id": "INT-L2",
      "title": "Interaction and regional-interdependence evidence — deep. W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "INT-L3",
      "title": "Response-exploration evidence — deep. W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "INT-L4",
      "title": "Reasoning-method options — deep. W3. Deps: L1–L3, FBK-O3, KNG-R4.",
      "state": "unsearched"
    },
    {
      "unit_id": "INT-L5",
      "title": "Clinical feature design boundary — deep. W3.",
      "state": "unsearched"
    },
    {
      "unit_id": "ANT-M1",
      "title": "Segment-proportion variation — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "ANT-M2",
      "title": "Proportions → mechanics → recommendation — deep. W2. Final synthesis deps: ANT-M1 and only the declared MEC-D2 squat/deadlift/bench/pull-up/overhead-press slices; searches need not wait for their synthesis.",
      "state": "unsearched"
    },
    {
      "unit_id": "ANT-M3",
      "title": "Mobility versus structural limits — medium. W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "PHO-N1",
      "title": "Feasibility and accuracy — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "PHO-N2",
      "title": "Error sources and capture protocol — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "PHO-N3",
      "title": "Uncertainty propagation and decision sensitivity — deep. W2. Deps: N1, ANT-M2.",
      "state": "unsearched"
    },
    {
      "unit_id": "PHO-N4",
      "title": "Adjacent photo claims — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "PHO-N5",
      "title": "Privacy, biometrics, fairness and processing — deep. W1. Overlaps SAF-S2 and is scoped to photos.",
      "state": "unsearched"
    },
    {
      "unit_id": "FBK-O1",
      "title": "Validity of effort self-report — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "FBK-O2",
      "title": "Sensation proxies — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "FBK-O3",
      "title": "Pain, discomfort, weakness and joint-noise interpretation — deep. W1. Deps: INJ-K3, INJ-K7.",
      "state": "unsearched"
    },
    {
      "unit_id": "FBK-O4",
      "title": "Feedback elicitation design — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "CRE-Q1",
      "title": "Corpus location, inventory, rights and attribution — medium. W0. Deps: E4.",
      "state": "unsearched"
    },
    {
      "unit_id": "CRE-Q2",
      "title": "Extraction protocol — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "CRE-Q3",
      "title": "Creator-to-science mapping — deep. W2. Deps: Q2 plus the matched science units.",
      "state": "unsearched"
    },
    {
      "unit_id": "CRE-Q4",
      "title": "Presentation policy — medium. W3.",
      "state": "unsearched"
    },
    {
      "unit_id": "KNG-R1",
      "title": "Applying certainty grading and the contradiction-register procedure — medium. W1. Deps: FND-A1.",
      "state": "unsearched"
    },
    {
      "unit_id": "KNG-R2",
      "title": "Freshness monitoring and update triggers — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "KNG-R3",
      "title": "Corpus structure and retrieval design — deep. W3. Reuses H-004.",
      "state": "unsearched"
    },
    {
      "unit_id": "KNG-R4",
      "title": "Grounded answer policy — deep. W3. Reuses H-004 grounded-AI, memory and consent work.",
      "state": "unsearched"
    },
    {
      "unit_id": "KNG-R5",
      "title": "Evaluation design — deep. W3.",
      "state": "unsearched"
    },
    {
      "unit_id": "SAF-S1",
      "title": "Regulatory landscape: wellness versus clinical features — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "SAF-S2",
      "title": "Health-data privacy — deep. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "SAF-S3",
      "title": "Substantiation for health and marketing claims (FTC) — medium. W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "SAF-S4",
      "title": "Professional-oversight models — medium. W3. Pairs with INT-L5.",
      "state": "unsearched"
    },
    {
      "unit_id": "EVL-U1",
      "title": "App QA scenario suite — W0 seed, W3 final. §8.",
      "state": "unsearched"
    },
    {
      "unit_id": "EVL-U2",
      "title": "Research-mechanism pilot — after FND-A1–A3. §9.",
      "state": "unsearched"
    },
    {
      "unit_id": "DMD-W1",
      "title": "Question-demand inventory and chat-coverage audit — deep, W0 seed / W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "BEH-X1",
      "title": "Adherence, preference, behavior change and expectation-setting — medium, W1.",
      "state": "partial"
    },
    {
      "unit_id": "HLT-Y1",
      "title": "General health literacy for trainees — medium, W1.",
      "state": "partial"
    },
    {
      "unit_id": "HLT-Y2",
      "title": "Medication, procedure and substance interactions with training (boundary literacy only) — deep, W1. Consolidates the beta-blocker item from F3, the NSAID item from J4 and the GLP-1 item from I7 (I7 keeps its nutrition angle).",
      "state": "unsearched"
    },
    {
      "unit_id": "HLT-Y3",
      "title": "Performance-enhancing drugs, SARMs, steroids and hormone questions — medium, W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "BCM-Z1",
      "title": "Body-weight and body-composition measurement validity — medium, W1.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K9",
      "title": "Training around injury — deep, W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "FBK-O5",
      "title": "Sensation-guided variant selection and feedback-to-technique heuristics — medium, W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "APL-F5",
      "title": "Adaptive and disability populations (not disease) — medium, W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "APL-F6",
      "title": "Representation, region and localization audit — medium, W1, then rolling.",
      "state": "unsearched"
    },
    {
      "unit_id": "SAF-S5",
      "title": "Scope-of-practice for advice — medium, W1.",
      "state": "unsearched"
    },
    {
      "unit_id": "EVL-U3",
      "title": "Product outcome and safety-signal evaluation design (non-clinical) — medium, W3.",
      "state": "unsearched"
    },
    {
      "unit_id": "CLN-V1",
      "title": "Existing evidence for digital and remote MSK assessment — deep, W2.",
      "state": "unsearched"
    },
    {
      "unit_id": "CLN-V2",
      "title": "Validation-study and reference-standard design — deep, W3.",
      "state": "unsearched"
    },
    {
      "unit_id": "CLN-V3",
      "title": "LLM health-advice safety-evaluation literature — medium, W2.",
      "state": "unsearched"
    }
  ]
};

// Transport orders unit IDs lexically; preserve all independently frozen packet values.
export const proteinCoverage: ResearchCoverage = {
  ...packetCoverage,
  units: [...packetCoverage.units].sort((a, b) => a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0),
};

export const proteinCorpusStatus: CorpusStatus = {
  state: 'partial', scope: 'fenced source_observation records only', clinical_readiness: 'CL-0',
  limitation: 'Research observations only; no claim promotion, clinical validation, answer generation, catalog or cue ingestion.',
  units_without_observations: proteinCoverage.units.filter(unit => unit.state === 'unsearched').map(unit => unit.unit_id).sort(),
  source_packets_without_records: [],
};
