import type { ObservationEntry } from '../../../src/grounding/index.js';
import type { NutritionJob, NutritionTopic } from '../../../src/domain-features/nutrition/index.js';

// Frozen directly from retained Markdown packets; qualifications and narrative conflicts remain unchanged.
export const nutritionHttpPackets: readonly {
  job: NutritionJob; topic: NutritionTopic; question: string; entry: ObservationEntry;
}[] = [
  {
    "job": "energy-uncertainty",
    "topic": "NUT-I1",
    "question": "age specific predictive equations",
    "entry": {
      "record": {
        "id": "ENE-S03",
        "kind": "source_observation",
        "topic_ids": [
          "NUT-I1",
          "NUT-I5"
        ],
        "title": "Development and validation of age-specific predictive equations for total energy expenditure and physical activity levels for older adults.",
        "url": "https://pubmed.ncbi.nlm.nih.gov/38503654/",
        "doi": "10.1016/j.ajcnut.2024.02.005",
        "pmid": "38503654",
        "published": "2024-03-19 online; May2024 issue",
        "accessed": "2026-10-02",
        "access_level": "abstract",
        "locator": "Original indexed Abstract Methods/Results/Conclusions; Europe PMC commentCorrectionList; PMC11347810 XML HTTP500 and browser CAPTCHA blocked full-text appraisal.",
        "summary": "TEE prediction development/internal validation using1657 adults aged65–90,1019 women. Abstract reports approximately ±30% limits of agreement using anthropometry/population-mean activity, ±20% with activity categories, and ±10% with RMR plus median absolute error about4%. These are population/method-specific agreement results, not universal calculator accuracy. Sex-stratified split and leave-one-out validation are not independent external validation.",
        "source_native_certainty": "No formal certainty grading in inspected abstract.",
        "form_appraisal": "Partial measurement-validation evidence; full methods, exact limits, reference measurements, cohort exclusions and funding unavailable. Researcher narrative qualifications: Linked 'Comment in': PMID38702107, DOI10.1016/j.ajcnut.2024.02.024, 'Predicting total energy expenditure.' This is commentary, not a correction; content remains unavailable.; Funding/COI not inspected.",
        "applicability": "Older adults65–90; transfer to young lifters or other activity classification methods unestablished.",
        "rights_status": "Full-text license not inspected; abstract metadata/original paraphrase only.",
        "freshness_status": "2024; indexed linked commentary retained. No indexed correction/retraction relation observed; not comprehensive clearance.",
        "clinical_readiness": "CL-0",
        "provenance": "Europe PMC original core abstract/identifier metadata; DOI absent from source corpus. Original access label: abstract_only. Original narrative conflicts retained in exact return; no local source edge inferred.",
        "conflicts": []
      },
      "source_path": "sources/energy-macros-appraisal.md",
      "line": 60,
      "source_packet_sha256": "8e986ca19350ee0762d6ec6ca9dcd86267bbbcc50ce42086aecedcd3a1f64e7e"
    }
  },
  {
    "job": "deficit-surplus-rate",
    "topic": "NUT-I2",
    "question": "bulking phase",
    "entry": {
      "record": {
        "id": "ENE-S04",
        "kind": "source_observation",
        "topic_ids": [
          "NUT-I2",
          "NUT-I4"
        ],
        "title": "Time-Restricted Eating during a Bulking Phase Is Associated with Reduced Fat Accumulation, while Muscle and Strength Gains Are Maintained: A 12-Wk Randomized Controlled Trial.",
        "url": "https://pubmed.ncbi.nlm.nih.gov/42442697/",
        "doi": "10.1016/j.tjnut.2026.101722",
        "pmid": "42442697",
        "published": "2026-07-13",
        "accessed": "2026-10-02",
        "access_level": "abstract",
        "locator": "Original indexed Abstract Methods/Results/Conclusions; registration DRKS00038177.",
        "summary": "23 randomized trained adults,12 weeks,3 training sessions/week, prescribed energy surplus. Restricted-window group achieved less energy, protein and carbohydrate than prescribed. BIA FFM gains1.34±.78 versus1.38±1.42kg; fat gains2.00±2.49 versus4.36±2.26kg,p=.009; body-mass gains2.19±2.40 versus3.90±2.14kg,p=.018. Intervals and endpoint completer counts unavailable. Intended surplus, achieved intake and meal window are confounded.",
        "source_native_certainty": "No formal certainty grade in abstract; no equivalence test established.",
        "form_appraisal": "Partial only: unequal achieved macronutrients/energy and BIA outcomes preclude isolating meal window or surplus magnitude. Researcher narrative qualifications: Funding/COI unavailable.; BIA-derived 'muscle mass' is not direct muscle imaging.; No isolated randomized contrast of achieved energy surplus.",
        "applicability": "Trained adults in one12-week bulking protocol; sex/age breakdown and complete adherence/attrition methods unavailable.",
        "rights_status": "Original full text/license unavailable; abstract paraphrase only.",
        "freshness_status": "Current2026 trial; no explicit targeted-search status notice found, not clearance.",
        "clinical_readiness": "CL-0",
        "provenance": "Europe PMC original indexed abstract/core metadata; exact DOI absent from corpus. Original access label: abstract_only. Original narrative conflicts retained in exact return; no local source edge inferred.",
        "conflicts": []
      },
      "source_path": "sources/energy-macros-appraisal.md",
      "line": 88,
      "source_packet_sha256": "8e986ca19350ee0762d6ec6ca9dcd86267bbbcc50ce42086aecedcd3a1f64e7e"
    }
  },
  {
    "job": "protein",
    "topic": "NUT-I3",
    "question": "soy dairy per protocol",
    "entry": {
      "record": {
        "access_level": "partial",
        "accessed": "2026-10-02",
        "applicability": "Mixed-sex, community-dwelling adults; aggregate not exclusively ≥55.",
        "clinical_readiness": "CL-0",
        "conflicts": [
          "OLP-S03"
        ],
        "doi": "10.1016/j.clnu.2015.01.018",
        "form_appraisal": "Unadopted: attrition, per-protocol selection, age transfer and proof-version limits. Abstract and proof intake values disagree; do not silently reconcile them.",
        "freshness_status": "Historical trial; final-table verification unresolved.",
        "id": "OLP-S02",
        "kind": "source_observation",
        "locator": "Indexed abstract; original publisher-proof PDF at https://r.jordan.im/download/protein/thomson2016-2.pdf, Methods §§2.1–2.6, Tables 1–3 and funding",
        "pmid": "25702958",
        "provenance": "ACTRN12612000177853; review-linked cohort. Dairy Health and Nutrition Consortium funding; sponsor assisted diet design; authors declared no COI.",
        "published": "2015-02-07 online; 2016-02 issue",
        "rights_status": "Elsevier all rights reserved; public readability does not authorize reuse.",
        "source_native_certainty": "Authors report attenuated strength gains with soy; no formal certainty grade.",
        "summary": "Twelve-week soy/dairy training comparison; protocol age range 50–79. Only 83 of 179 randomized were per-protocol completers. Its strength signal requires the exercise-specific qualification in OLP-S03.",
        "title": "Muscle strength gains during resistance exercise training are attenuated with soy compared with dairy or usual protein intake in older adults: A randomized controlled trial",
        "topic_ids": [
          "NUT-I3"
        ],
        "url": "https://pubmed.ncbi.nlm.nih.gov/25702958/"
      },
      "source_path": "sources/older-protein-008.md",
      "line": 32,
      "source_packet_sha256": "14c28efb5e424fd1986beba0c01b592bb3e06a8acbc8819543632c81c60b47ce"
    }
  },
  {
    "job": "nutrients-dietary-patterns",
    "topic": "NUT-I4",
    "question": "table24",
    "entry": {
      "record": {
        "access_level": "official",
        "accessed": "2026-10-02",
        "applicability": "Provided trial menus; not participant-specific consumed-food density.",
        "clinical_readiness": "CL-0",
        "conflicts": [],
        "doi": "10.1038/s41591-025-03842-0",
        "form_appraisal": "Verified version change; not a new outcome analysis or independent study.",
        "freshness_status": "Official update inspected2026-10-02; corrected PDF independently unavailable.",
        "id": "DPT-S01",
        "kind": "source_observation",
        "locator": "Crossmark Change Details and original publisher Change history",
        "pmid": null,
        "provenance": "Crossmark and publisher change history agree; same underlying NUT-S014 trial. No separate correction DOI identified.",
        "published": "2025-12-15",
        "rights_status": "Metadata and original factual paraphrase only.",
        "source_native_certainty": "Official correction of reported composition values.",
        "summary": "Supplementary Table24 energy densities changed from MPF1.37/UPF1.70 to MPF1.25/UPF1.60kcal/g.",
        "title": "Official December2025 update to UPDATE trial supplementary energy density",
        "topic_ids": [
          "NUT-I4"
        ],
        "url": "https://crossmark.crossref.org/dialog/?doi=10.1038%2Fs41591-025-03842-0"
      },
      "source_path": "sources/diet-processing-009.md",
      "line": 5,
      "source_packet_sha256": "29c5bebc93878a4ff0378da8cc479e516390608f37dfe4d1e4aa07d1183ac736"
    }
  },
  {
    "job": "logging-accuracy",
    "topic": "NUT-I5",
    "question": "319 dietary record apps",
    "entry": {
      "record": {
        "id": "FLG-S004",
        "kind": "source_observation",
        "topic_ids": [
          "NUT-I5"
        ],
        "title": "A Systematic Review and Meta-Analysis of Validation Studies Performed on Dietary Record Apps",
        "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC8634532/",
        "doi": "10.1093/advances/nmab058",
        "pmid": "34019624",
        "published": "2021",
        "accessed": "2026-10-02",
        "access_level": "full",
        "locator": "Methods: search, eligibility and analysis; Results: energy agreement and food-composition database subgroup; disclosures",
        "summary": "Fourteen studies were included; eleven assessed energy. Pooled app-minus-reference energy difference was −202 kcal/day (95% CI −319 to −85; I²=72%). In studies using the same food-composition database for app and comparator, difference was −57 (−116 to 2; I²=0%). Most references were conventional dietary reports rather than independent biomarkers.",
        "source_native_certainty": "Review authors emphasize heterogeneous validation methods and database-related differences; no formal clinical certainty grade identified.",
        "form_appraisal": "Supports separating database disagreement from recording error. Shared databases may improve agreement while retaining shared errors. The pooled difference cannot be used as a personal intake correction.",
        "applicability": "English-language app-validation studies published January 2013–October 2019; historical apps, varied adult samples and comparators.",
        "rights_status": "CC BY 4.0 identified in public full text.",
        "freshness_status": "Search cutoff October 2019; 2021 publication. Not a current exhaustive review of 2026 app versions.",
        "clinical_readiness": "CL-0",
        "provenance": "Primary review full text/Europe PMC XML; searched Web of Science/regional databases, PubMed, Medline, Google Scholar and citations, with two-stage screening. Authors reported no funding and no conflicts. Underlying cohorts overlap with the broader dietary-assessment literature and are not independent evidence when also cited separately. Root additive normalization only; exact original retained: {\"narrative_conflicts\": [\"Average app underestimation is not a universal direction or magnitude of individual error.\", \"Agreement with another self-report instrument is weaker validation than agreement with an independent reference.\"], \"original_kind\": \"systematic_review_meta_analysis\"}.",
        "conflicts": []
      },
      "source_path": "sources/logging-body-e1.md",
      "line": 86,
      "source_packet_sha256": "79b943671920aa3173d5cb8ce99b5f733c1f1f1a78258bbd21f55ef079950400"
    }
  },
  {
    "job": "supplements",
    "topic": "NUT-I6",
    "question": "800 sleep",
    "entry": {
      "record": {
        "id": "CAF-S13",
        "kind": "source_observation",
        "topic_ids": [
          "NUT-I6",
          "REC-J1"
        ],
        "title": "Caffeine, 800-m running performance and sleep quality",
        "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC6770771/",
        "doi": "10.3390/nu11092040",
        "pmid": "31480553",
        "published": "2019-09-01",
        "accessed": "2026-10-02",
        "access_level": "full",
        "locator": "Methods2.1/2.2/2.6; Results3; Tables1–2",
        "summary": "Sleep impairment alongside a performance null in the same protocol.",
        "source_native_certainty": "Ungraded crossover trial.",
        "form_appraisal": "Unknown; timing/reporting discrepancies preserved.",
        "applicability": "Male trained runners; actigraphy, not PSG.",
        "rights_status": "CC BY 4.0.",
        "freshness_status": "Historical included trial.",
        "clinical_readiness": "CL-0",
        "provenance": "Europe PMC XML. No external funding or COI. Included in NUT-S025 and CAF-S08. Root additive normalization only; exact original/defaults retained: {\"narrative_conflicts\": [\"CAF-CNF-03\"]}.",
        "conflicts": []
      },
      "source_path": "sources/caffeine-e1.md",
      "line": 333,
      "source_packet_sha256": "1efbd0be7f9e0fadfca6978c0c92247564b7c599f580811129d46577261868cd"
    }
  },
  {
    "job": "nutrition-boundaries",
    "topic": "NUT-I7",
    "question": "figure appendix print",
    "entry": {
      "record": {
        "published": "2024-02-07",
        "conflicts": [],
        "freshness_status": "Indexed correction inspected; direct retrieval failed. Do not import old printed CAT2 scoring.",
        "provenance": "Official BMJ correction; no new validation data, funding or COI supplied in inspected notice.",
        "topic_ids": [
          "NUT-I7"
        ],
        "id": "NBR-S002",
        "kind": "source_observation",
        "title": "CAT2 development-paper correction",
        "source_native_certainty": "Publisher correction notice.",
        "applicability": "Version lineage for NBR-S001; no participant outcomes.",
        "locator": "Single-page correction: Figure 2 and online supplemental appendix 1",
        "form_appraisal": "High confidence in correction existence and named targets; changed cells and current appendix were not inspected.",
        "url": "https://bjsm.bmj.com/content/bjsports/58/3/e2.full.pdf",
        "access_level": "partial",
        "pmid": null,
        "clinical_readiness": "CL-0",
        "summary": "The correction reports updates to Figure 2 and supplemental appendix 1 in the online version rather than print.",
        "accessed": "2026-10-02",
        "rights_status": "Notice states no commercial reuse; permission required where applicable.",
        "doi": "10.1136/bjsports-2023-106914corr1"
      },
      "source_path": "sources/nutrition-boundaries-deep.md",
      "line": 32,
      "source_packet_sha256": "e8563066c6635ac40b760ef6ffafcd298aeb26fd37ddac1f0440e7dbff6eb972"
    }
  }
];
