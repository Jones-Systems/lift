import type { CorpusStatus, ObservationEntry, ResearchCoverage, SourceBinding } from '../../../src/grounding/index.js';

// Packet-derived expectations pinned in source; never generated from the composer or built projection.
export const expectedSource: SourceBinding = {
  "repository": "Jones-Systems/BusinessLessons",
  "revision": "7636efca55195b1dc6a5980864452575478116b7",
  "corpusRoot": "research/form-knowledge-campaign-2026-10-01",
  "corpusInputSha256": "78ffb7674b95dfb946f9f30d318ba6dfa07332cad364298f6c7daf4c8055b824"
};

export const expectedCoverage: ResearchCoverage = {
  "schema": "form.research-coverage/v1",
  "authority_effect": "none",
  "source_plan": "plans/form-knowledge-research-plan.md",
  "source_plan_revision": "2023a6d73010a7ffeb533c87d4b991a456337278",
  "units": [
    {
      "unit_id": "ANA-C1",
      "title": "Muscle inventory and functional anatomy — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "ANA-C2",
      "title": "Role taxonomy and evidence ladder — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "ANA-C3",
      "title": "Variant role binding — deep for contested bindings, medium otherwise. W2. Deps: EXU-B2, C1, C2, MEC-D1, MEC-D2.",
      "state": "partial"
    },
    {
      "unit_id": "ANA-C4",
      "title": "Volume attribution across roles — medium. W2. Deps: C3, DOS-E3.",
      "state": "partial"
    },
    {
      "unit_id": "ANT-M1",
      "title": "Segment-proportion variation — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "ANT-M2",
      "title": "Proportions → mechanics → recommendation — deep. W2. Final synthesis deps: ANT-M1 and only the declared MEC-D2 squat/deadlift/bench/pull-up/overhead-press slices; searches need not wait for their synthesis.",
      "state": "partial"
    },
    {
      "unit_id": "ANT-M3",
      "title": "Mobility versus structural limits — medium. W2.",
      "state": "partial"
    },
    {
      "unit_id": "APL-F1",
      "title": "Region- and muscle-specific dose responses — deep. W2. Deps: DOS-E2 through E6.",
      "state": "partial"
    },
    {
      "unit_id": "APL-F2",
      "title": "Population moderators — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "APL-F3",
      "title": "Special-population boundaries — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "APL-F4",
      "title": "Individual variability and N-of-1 inference limits — deep. W2.",
      "state": "partial"
    },
    {
      "unit_id": "APL-F5",
      "title": "Adaptive and disability populations (not disease) — medium, W1.",
      "state": "partial"
    },
    {
      "unit_id": "APL-F6",
      "title": "Representation, region and localization audit — medium, W1, then rolling.",
      "state": "partial"
    },
    {
      "unit_id": "BCM-Z1",
      "title": "Body-weight and body-composition measurement validity — medium, W1.",
      "state": "partial"
    },
    {
      "unit_id": "BEH-X1",
      "title": "Adherence, preference, behavior change and expectation-setting — medium, W1.",
      "state": "partial"
    },
    {
      "unit_id": "CAR-H1",
      "title": "Activity guidelines and health targets — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "CAR-H2",
      "title": "Intensity prescription and measurement — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "CAR-H3",
      "title": "Modalities and methods — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "CAR-H4",
      "title": "Concurrent-training interference and sequencing — deep. W2.",
      "state": "partial"
    },
    {
      "unit_id": "CAR-H5",
      "title": "Cardio in energy balance and body composition — medium. W2. Deps: NUT-I1, NUT-I2.",
      "state": "partial"
    },
    {
      "unit_id": "CLN-V1",
      "title": "Existing evidence for digital and remote MSK assessment — deep, W2.",
      "state": "partial"
    },
    {
      "unit_id": "CLN-V2",
      "title": "Validation-study and reference-standard design — deep, W3.",
      "state": "partial"
    },
    {
      "unit_id": "CLN-V3",
      "title": "LLM health-advice safety-evaluation literature — medium, W2.",
      "state": "partial"
    },
    {
      "unit_id": "CRE-Q1",
      "title": "Corpus location, inventory, rights and attribution — medium. W0. Deps: E4.",
      "state": "partial"
    },
    {
      "unit_id": "CRE-Q2",
      "title": "Extraction protocol — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "CRE-Q3",
      "title": "Creator-to-science mapping — deep. W2. Deps: Q2 plus the matched science units.",
      "state": "partial"
    },
    {
      "unit_id": "CRE-Q4",
      "title": "Presentation policy — medium. W3.",
      "state": "partial"
    },
    {
      "unit_id": "DMD-W1",
      "title": "Question-demand inventory and chat-coverage audit — deep, W0 seed / W1.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E1",
      "title": "Goal taxonomy and outcome measures — medium.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E2",
      "title": "Load and rep range — deep.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E3",
      "title": "Volume dose-response — deep.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E4",
      "title": "Effort and proximity to failure — deep.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E5",
      "title": "Tempo, rep duration, pauses and eccentric emphasis — medium.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E6",
      "title": "ROM, muscle length and lengthened partials — deep.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E7",
      "title": "Frequency and rest intervals — medium.",
      "state": "partial"
    },
    {
      "unit_id": "DOS-E8",
      "title": "Set structures, ordering and warm-up — medium.",
      "state": "partial"
    },
    {
      "unit_id": "EVL-U1",
      "title": "App QA scenario suite — W0 seed, W3 final. §8.",
      "state": "partial"
    },
    {
      "unit_id": "EVL-U2",
      "title": "Research-mechanism pilot — after FND-A1–A3. §9.",
      "state": "unsearched"
    },
    {
      "unit_id": "EVL-U3",
      "title": "Product outcome and safety-signal evaluation design (non-clinical) — medium, W3.",
      "state": "partial"
    },
    {
      "unit_id": "EXU-B1",
      "title": "Family inventory and coverage rule — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "EXU-B2",
      "title": "Variant expansion per family — medium. W2. Deps: B1, ANA-C1, FND-A2.",
      "state": "partial"
    },
    {
      "unit_id": "EXU-B3",
      "title": "Equipment taxonomy and substitution equivalence — medium. W1.",
      "state": "partial"
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
      "unit_id": "FBK-O1",
      "title": "Validity of effort self-report — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "FBK-O2",
      "title": "Sensation proxies — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "FBK-O3",
      "title": "Pain, discomfort, weakness and joint-noise interpretation — deep. W1. Deps: INJ-K3, INJ-K7.",
      "state": "partial"
    },
    {
      "unit_id": "FBK-O4",
      "title": "Feedback elicitation design — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "FBK-O5",
      "title": "Sensation-guided variant selection and feedback-to-technique heuristics — medium, W2.",
      "state": "partial"
    },
    {
      "unit_id": "FND-A1",
      "title": "Claim schema and evidence grading — deep. Deps: none; E2.",
      "state": "partial"
    },
    {
      "unit_id": "FND-A2",
      "title": "Canonical ontology and vocabulary — medium. Deps: E3.",
      "state": "partial"
    },
    {
      "unit_id": "FND-A3",
      "title": "Search protocol, source registry and freshness policy — medium.",
      "state": "partial"
    },
    {
      "unit_id": "FND-A4",
      "title": "Prior-evidence reuse audit — medium. Deps: E1, E2, E3.",
      "state": "partial"
    },
    {
      "unit_id": "FND-A5",
      "title": "Premise register setup — light. Out: the §5 register created as a live artifact.",
      "state": "partial"
    },
    {
      "unit_id": "FND-A6",
      "title": "Scope and referral-boundary frame — medium.",
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
      "state": "partial"
    },
    {
      "unit_id": "HLT-Y3",
      "title": "Performance-enhancing drugs, SARMs, steroids and hormone questions — medium, W1.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K1",
      "title": "Tissue types, classification and terminology — light/medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K2",
      "title": "Healing physiology and timelines — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K3",
      "title": "Pain science and symptom monitoring — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K4",
      "title": "Return-to-activity frameworks — deep. W2. Deps: K1–K3, K7.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K5",
      "title": "Region-specific common conditions — deep. W2.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K6",
      "title": "Post-surgical and arthroplasty states — deep. W2.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K7",
      "title": "Red flags, urgent referral and preparticipation screening — deep. W1. This is safety-critical and runs early.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K8",
      "title": "Injury risk factors and prevention claims — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "INJ-K9",
      "title": "Training around injury — deep, W2.",
      "state": "partial"
    },
    {
      "unit_id": "INT-L1",
      "title": "Constraint model — deep. W2. Deps: FND-A2, MEC-D2, INJ-K1.",
      "state": "partial"
    },
    {
      "unit_id": "INT-L2",
      "title": "Interaction and regional-interdependence evidence — deep. W2.",
      "state": "partial"
    },
    {
      "unit_id": "INT-L3",
      "title": "Response-exploration evidence — deep. W2.",
      "state": "partial"
    },
    {
      "unit_id": "INT-L4",
      "title": "Reasoning-method options — deep. W3. Deps: L1–L3, FBK-O3, KNG-R4.",
      "state": "partial"
    },
    {
      "unit_id": "INT-L5",
      "title": "Clinical feature design boundary — deep. W3.",
      "state": "partial"
    },
    {
      "unit_id": "KNG-R1",
      "title": "Applying certainty grading and the contradiction-register procedure — medium. W1. Deps: FND-A1.",
      "state": "partial"
    },
    {
      "unit_id": "KNG-R2",
      "title": "Freshness monitoring and update triggers — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "KNG-R3",
      "title": "Corpus structure and retrieval design — deep. W3. Reuses H-004.",
      "state": "partial"
    },
    {
      "unit_id": "KNG-R4",
      "title": "Grounded answer policy — deep. W3. Reuses H-004 grounded-AI, memory and consent work.",
      "state": "partial"
    },
    {
      "unit_id": "KNG-R5",
      "title": "Evaluation design — deep. W3.",
      "state": "partial"
    },
    {
      "unit_id": "MEC-D1",
      "title": "Resistance profiles and strength curves — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "MEC-D2",
      "title": "Joint and positional demand per variant — deep. W2. Deps: EXU-B2, ANA-C1.",
      "state": "partial"
    },
    {
      "unit_id": "MEC-D3",
      "title": "Practical constraints — light. W1.",
      "state": "partial"
    },
    {
      "unit_id": "NUT-I1",
      "title": "Energy-need estimation and uncertainty — deep.",
      "state": "partial"
    },
    {
      "unit_id": "NUT-I2",
      "title": "Deficit, surplus and rate — deep.",
      "state": "partial"
    },
    {
      "unit_id": "NUT-I3",
      "title": "Protein — deep.",
      "state": "partial"
    },
    {
      "unit_id": "NUT-I4",
      "title": "Carbohydrate, fat, fiber, micronutrient basics, dietary patterns and alcohol — medium.",
      "state": "partial"
    },
    {
      "unit_id": "NUT-I5",
      "title": "Food composition and logging accuracy — medium.",
      "state": "partial"
    },
    {
      "unit_id": "NUT-I6",
      "title": "Supplements — deep.",
      "state": "partial"
    },
    {
      "unit_id": "NUT-I7",
      "title": "Nutrition boundaries and communication — deep.",
      "state": "partial"
    },
    {
      "unit_id": "PHO-N1",
      "title": "Feasibility and accuracy — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "PHO-N2",
      "title": "Error sources and capture protocol — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "PHO-N3",
      "title": "Uncertainty propagation and decision sensitivity — deep. W2. Deps: N1, ANT-M2.",
      "state": "partial"
    },
    {
      "unit_id": "PHO-N4",
      "title": "Adjacent photo claims — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "PHO-N5",
      "title": "Privacy, biometrics, fairness and processing — deep. W1. Overlaps SAF-S2 and is scoped to photos.",
      "state": "partial"
    },
    {
      "unit_id": "PRG-G1",
      "title": "Progression models and autoregulation — medium.",
      "state": "partial"
    },
    {
      "unit_id": "PRG-G2",
      "title": "Program structure — medium.",
      "state": "partial"
    },
    {
      "unit_id": "PRG-G3",
      "title": "Adaptation operations — deep.",
      "state": "partial"
    },
    {
      "unit_id": "PRG-G4",
      "title": "Progress measurement — deep.",
      "state": "partial"
    },
    {
      "unit_id": "REC-J1",
      "title": "Sleep — medium.",
      "state": "partial"
    },
    {
      "unit_id": "REC-J2",
      "title": "Hydration, electrolytes and heat — medium.",
      "state": "partial"
    },
    {
      "unit_id": "REC-J3",
      "title": "Fatigue, soreness, readiness and overreaching — deep.",
      "state": "partial"
    },
    {
      "unit_id": "REC-J4",
      "title": "Recovery modalities — medium.",
      "state": "partial"
    },
    {
      "unit_id": "REC-J5",
      "title": "Life stress, menstrual cycle and age effects on recovery — medium. Evidence in this area is expected to be weak.",
      "state": "partial"
    },
    {
      "unit_id": "SAF-S1",
      "title": "Regulatory landscape: wellness versus clinical features — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "SAF-S2",
      "title": "Health-data privacy — deep. W1.",
      "state": "partial"
    },
    {
      "unit_id": "SAF-S3",
      "title": "Substantiation for health and marketing claims (FTC) — medium. W1.",
      "state": "partial"
    },
    {
      "unit_id": "SAF-S4",
      "title": "Professional-oversight models — medium. W3. Pairs with INT-L5.",
      "state": "partial"
    },
    {
      "unit_id": "SAF-S5",
      "title": "Scope-of-practice for advice — medium, W1.",
      "state": "partial"
    }
  ]
};

export const expectedCorpusStatus: CorpusStatus = {
  "state": "partial",
  "scope": "fenced source_observation records only",
  "clinical_readiness": "CL-0",
  "limitation": "Research observations only; no claim promotion, clinical validation, answer generation, catalog or cue ingestion.",
  "units_without_observations": [
    "CRE-Q3",
    "EVL-U2",
    "FND-A4"
  ],
  "source_packets_without_records": [
    "sources/exercise-inventory-sources.md"
  ]
};

export const expectedEntries: Readonly<Record<string, ObservationEntry>> = {
  "CNC-S01": {
    "record": {
      "id": "CNC-S01",
      "kind": "source_observation",
      "topic_ids": [
        "CAR-H4"
      ],
      "title": "Compatibility of Concurrent Aerobic and Strength Training for Skeletal Muscle Size and Function: An Updated Systematic Review and Meta-Analysis",
      "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC8891239/",
      "doi": "10.1007/s40279-021-01587-7",
      "pmid": "34757594",
      "published": "2021-11-10 online; 2022 issue",
      "accessed": "2026-10-02",
      "access_level": "full",
      "locator": "Results: Maximal Strength, Figure 2; Explosive Strength, Figure 3; Muscle Hypertrophy, Figure 4; subgroup figures S2–S14; Discussion limitations; Funding and Conflict of interest.",
      "summary": "The pooled concurrent-versus-identical-strength-prescription differences were near zero for maximal strength and muscle-size outcomes, but favored resistance-only training for explosive strength. Endpoint samples differed: strength 37 studies/967 participants; explosive strength 18/478; muscle-size outcomes 15/389.",
      "source_native_certainty": "No GRADE rating captured. Mean PEDro score 4.3±0.9; seven studies rated low quality. Random-effects estimates with 95% intervals.",
      "form_appraisal": "Preserve endpoints and mixed muscle-size measurements, including segmental DXA. Scheduling and modality subgroups compare studies rather than randomized schedules; subgroup significance alone does not establish a difference between subgroups. Intensity reporting was insufficient for a moderator analysis. Funding: no preparation funding; Projekt DEAL supported open access. Authors declared no relevant conflicts.",
      "applicability": "Healthy adults in supervised protocols lasting at least four weeks; elite training and long-term individual predictions remain limited.",
      "rights_status": "CC BY 4.0 verified; third-party exceptions apply.",
      "freshness_status": "Search updated March 2021; historical synthesis, inspected alongside newer reviews. No indexed correction relation returned; comprehensive integrity clearance not established.",
      "clinical_readiness": "CL-0",
      "provenance": "Original Europe PMC full-text XML inspected, PMC8891239; PMID metadata verified. Includes retained CAR trial evidence and overlaps later syntheses.",
      "conflicts": [
        "CNC-S02",
        "CNC-S03",
        "CNC-S04"
      ]
    },
    "source_path": "sources/concurrent-appraisal.md",
    "line": 7,
    "source_packet_sha256": "ea51c484d66e01c83bbe2b99c6a84c1aa0ffa8fdb2fb1391b1540ea1f220b68b"
  },
  "CNC-S02": {
    "record": {
      "id": "CNC-S02",
      "kind": "source_observation",
      "topic_ids": [
        "CAR-H4"
      ],
      "title": "Concurrent Strength and Endurance Training: A Systematic Review and Meta-Analysis on the Impact of Sex and Training Status",
      "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC10933151/",
      "doi": "10.1007/s40279-023-01943-9",
      "pmid": "37847373",
      "published": "2023-10-17 online; 2024 issue",
      "accessed": "2026-10-02",
      "access_level": "full",
      "locator": "Results: Study Characteristics; Concurrent Training Effects in Males and Females, Figures 3–4; Future Perspectives and Limitations; declarations.",
      "summary": "Fifty-nine studies contributed 1,346 participants across concurrent, strength-only and endurance-only comparisons. For lower-body strength, male and female pooled estimates differed, with an explicit subgroup-difference test. Power estimates did not show a significant sex difference. Hypertrophy evidence comprised only four male studies.",
      "source_native_certainty": "Cochrane risk-of-bias assessment; allocation concealment and detection bias commonly unclear. No GRADE rating captured.",
      "form_appraisal": "The sex comparison is tested, but remains a study-level moderator susceptible to differing programs and representation. It does not establish that women cannot experience interference. Training status was classifiable in only 61% of studies; none included highly strength-trained participants. Authors reported no financial support or relevant conflicts.",
      "applicability": "Healthy adults; predominantly untrained strength participants. Female hypertrophy and highly trained strength populations are inadequately represented.",
      "rights_status": "CC BY 4.0 verified.",
      "freshness_status": "Search November 14, 2022; newer women trial recorded separately. No indexed correction relation returned; no comprehensive integrity clearance.",
      "clinical_readiness": "CL-0",
      "provenance": "Original XML inspected, PMC10933151. Substantial included-study overlap with CNC-S01/S03; not independent participant replication.",
      "conflicts": [
        "CNC-S01",
        "CNC-S10"
      ]
    },
    "source_path": "sources/concurrent-appraisal.md",
    "line": 40,
    "source_packet_sha256": "ea51c484d66e01c83bbe2b99c6a84c1aa0ffa8fdb2fb1391b1540ea1f220b68b"
  },
  "CWI-S04": {
    "record": {
      "published": "2026-03-18",
      "conflicts": [],
      "freshness_status": "Article search cutoff 2025-06-30; actual execution dates not established. Targeted correction search found no resolving notice.",
      "provenance": "Publisher and PMC13122509 full XML inspected. Funding projects 2024AH040299 and 2024AH052361; no competing interests declared. Registry separately retained as CWI-S11. Root additive transport preserves original labels/metadata in exact return; normalization only: {\"kind\":\"systematic_review_network_meta_analysis\",\"clinical_readiness\":\"CL-0; do-not-surface protocol rankings; authority effect none.\",\"access_level\":\"full_text\",\"narrative_conflicts\":[\"CWI-CON07\",\"CWI-CON08\",\"CWI-CON09\"]}.",
      "topic_ids": [
        "REC-J4"
      ],
      "id": "CWI-S04",
      "kind": "source_observation",
      "title": "Cold water immersion protocol optimization across exercise modalities: a systematic review and network meta-analysis of resistance training, endurance exercise, and team sport applications",
      "source_native_certainty": "Native network rankings and certainty presentation not adopted as validated protocol guidance.",
      "applicability": "Approximately 85% male; CWI within one hour; outcomes within 72 hours. Cannot establish adaptation-protective timing.",
      "locator": "Abstract; registration/search methods; Strength outcome; Tables 5a and 6a; outcome-direction methods; perceived-recovery and muscle-damage results.",
      "form_appraisal": "Hold efficacy rankings from promotion pending registration, abstract/results and sign-direction reconciliation.",
      "url": "https://link.springer.com/article/10.1186/s13102-026-01653-5",
      "access_level": "partial",
      "pmid": "41845491",
      "clinical_readiness": "CL-0",
      "summary": "Reported 87 studies and 2313 participants; acute application and outcomes, not longitudinal hypertrophy.",
      "accessed": "2026-10-02",
      "rights_status": "CC BY-NC-ND 4.0; commercial reuse/adapted-content permission unresolved.",
      "doi": "10.1186/s13102-026-01653-5"
    },
    "source_path": "sources/cold-water-deep.md",
    "line": 86,
    "source_packet_sha256": "2f85b4059d1925e4741117138d7c899a9d84eff974d2ed0a4d3e6f9708960924"
  },
  "HYD-S03": {
    "record": {
      "id": "HYD-S03",
      "kind": "source_observation",
      "topic_ids": [
        "REC-J2"
      ],
      "title": "Sodium Hyperhydration Improves Performance With No Change in Thermal and Cardiovascular Strain in Female Cyclists Exercising in the Heat Across the Menstrual Cycle",
      "url": "https://pubmed.ncbi.nlm.nih.gov/39591960/",
      "doi": "10.1123/ijsnem.2024-0125",
      "pmid": "39591960",
      "published": "2025-01-23 online; 2025-03 print",
      "accessed": "2026-10-02",
      "access_level": "abstract",
      "locator": "Abstract: randomized crossover design, Results; PubMed Comments and corrections",
      "summary": "Twelve trained female cyclists/triathletes completed four heat trials. Abstract reports faster 200-kJ time trials with sodium versus placebo, but no significant rectal-temperature or heart-rate effect. Original record explicitly links an erratum. Performance estimates are held from claim promotion pending inspection of that notice and full supporting results.",
      "source_native_certainty": "No formal grade; authors call the intervention promising.",
      "form_appraisal": "Potential direct performance counterevidence to broad no-benefit hyperhydration wording. Full methods/results and correction substance unavailable; related full hydration report cannot substitute for corrected performance results.",
      "applicability": "Unacclimatized trained women undertaking prolonged cycling at 34°C/60% RH; not routine lifting or clinical heat-illness prevention.",
      "rights_status": "Not open access in Europe PMC metadata; license unverified.",
      "freshness_status": "Current 2025 primary study with known correction; not all-clear.",
      "clinical_readiness": "CL-0",
      "provenance": "Original MED abstract and reciprocal correction metadata inspected through Europe PMC core record. Shared cohort with HYD-S02; indexed first-publication date retained separately from print date.",
      "conflicts": [
        "HYD-S04"
      ]
    },
    "source_path": "sources/hydration-appraisal.md",
    "line": 59,
    "source_packet_sha256": "d9bf29ad92edb6a54cdc5b92d185daf645564f14ad2c7a739ec3b992f84f441f"
  },
  "HYD-S04": {
    "record": {
      "id": "HYD-S04",
      "kind": "source_observation",
      "topic_ids": [
        "REC-J2"
      ],
      "title": "Erratum: Sodium Hyperhydration Improves Performance With No Change in Thermal and Cardiovascular Strain in Female Cyclists Exercising in the Heat Across the Menstrual Cycle",
      "url": "https://pubmed.ncbi.nlm.nih.gov/39848241/",
      "doi": "10.1123/ijsnem.2025-0013",
      "pmid": "39848241",
      "published": "2025-01-23 online; 2025-05 print",
      "accessed": "2026-10-02",
      "access_level": "partial",
      "locator": "Publication type Published Erratum; Comments and corrections: ErratumFor PMID 39591960; page 269",
      "summary": "Official bibliographic record establishes a correction to HYD-S03. No abstract supplies the corrected text. Publisher notice retrieval returned HTTP 403; the nature and numerical impact of the correction remain unknown.",
      "source_native_certainty": "Correction notice; not an independent effectiveness study.",
      "form_appraisal": "Reliable lineage identification, insufficient access to determine correction impact. Do not assume cosmetic correction or unchanged estimates.",
      "applicability": "Maintenance and claim lineage only.",
      "rights_status": "Notice license and full text unavailable.",
      "freshness_status": "Known correction requiring follow-up before affected performance estimates are promoted.",
      "clinical_readiness": "CL-0",
      "provenance": "PubMed original notice and Europe PMC reciprocal ErratumFor/ErratumIn records inspected; Human Kinetics article-p269.xml denied access.",
      "conflicts": [
        "HYD-S03"
      ]
    },
    "source_path": "sources/hydration-appraisal.md",
    "line": 88,
    "source_packet_sha256": "d9bf29ad92edb6a54cdc5b92d185daf645564f14ad2c7a739ec3b992f84f441f"
  },
  "OLP-S01": {
    "record": {
      "access_level": "full",
      "accessed": "2026-10-02",
      "applicability": "Medically screened men, mean age 65±5; exact minimum age not captured. Background lacto-ovo foods remained in both diets. Not a vegan-versus-omnivore comparison.",
      "clinical_readiness": "CL-0",
      "conflicts": [],
      "doi": "10.1093/ajcn/76.3.511",
      "form_appraisal": "Unadopted appraisal: direct regional muscle endpoint, small analyzed sample, exclusions, imperfect diet matching and no equivalence margin. Twenty-six enrolled; three withdrew, one infection-related exclusion and one iron-deficiency exclusion.",
      "freshness_status": "Historical 2002 study; primary text reappraised 2026-10-02. No indexed notice found in inspected metadata; exhaustive clearance unknown.",
      "id": "OLP-S01",
      "kind": "source_observation",
      "locator": "Subjects and Methods; Tables 1–5; Results muscle size; funding footnote",
      "pmid": "12197993",
      "provenance": "PMC original manuscript; reference 35 in NUT-S008, not independent of that review. Funded by National Cattlemen's Beef Association, NIH, USDA and University of Arkansas student research support; separate author COI declaration not captured.",
      "published": "2002-09",
      "rights_status": "Public author manuscript; metadata and original paraphrase only. Reproduction permission not established.",
      "source_native_certainty": "Authors suggest predominant source did not influence gains under these conditions; no formal certainty grade. Reported power for the between-group muscle-area difference was approximately 0.50.",
      "summary": "Randomized soy-food versus beef comparison during 12 weeks of training in 21 analyzed older men. Regional CT muscle area and strength improved without detected between-group differences; equal supplied protein did not mean identical achieved whole-diet intake.",
      "title": "Effect of protein source on resistive-training-induced changes in body composition and muscle size in older men",
      "topic_ids": [
        "NUT-I3"
      ],
      "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC2556250/"
    },
    "source_path": "sources/older-protein-008.md",
    "line": 5,
    "source_packet_sha256": "14c28efb5e424fd1986beba0c01b592bb3e06a8acbc8819543632c81c60b47ce"
  }
};
