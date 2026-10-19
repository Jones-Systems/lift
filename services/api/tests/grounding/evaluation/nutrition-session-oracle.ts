import type { ObservationEntry } from '../../../src/grounding/index.js';

// Independent packet expectation; OLP-S03 stays an unresolved off-page qualification, not a new cohort.
export const olderSoyDairy: ObservationEntry = {
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
};
