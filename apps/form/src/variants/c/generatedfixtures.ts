// Generated from the sealed c/v3 package by generate-source.py. Do not edit.
export const fixtures = {
  "$schema_note": "Fictional, static demo data for Form 2 Variation C (Margin). No real person, account, health or API data. Builders import values verbatim; copy strings in pages.md reference these keys.",
  "person": {
    "name": "Alex"
  },
  "calendar": {
    "todayIso": "2026-10-07",
    "todayLabel": "Wednesday, October 7",
    "weekLabel": "Week of October 5",
    "weekRange": "October 5–11"
  },
  "movements": {
    "goblet-squat": {
      "id": "goblet-squat",
      "name": "Goblet squat",
      "sets": 3,
      "repsTarget": "8–10",
      "repsDefault": 10,
      "repsMin": 1,
      "repsMax": 30,
      "loadKg": 12,
      "loadLabel": "12 kg",
      "loadStepKg": 2,
      "loadMinKg": 0,
      "loadMaxKg": 40,
      "last": {
        "dayLabel": "Monday",
        "reps": 10,
        "loadLabel": "10 kg"
      },
      "cues": [
        "Hold the bell at your chest, elbows pointing down.",
        "Sit down between your heels and keep your chest tall.",
        "Stand up by pushing the floor away."
      ]
    },
    "floor-press": {
      "id": "floor-press",
      "name": "Dumbbell floor press",
      "sets": 2,
      "repsTarget": "8–10",
      "repsDefault": 9,
      "repsMin": 1,
      "repsMax": 30,
      "loadKg": 10,
      "loadLabel": "10 kg each",
      "loadStepKg": 2,
      "loadMinKg": 0,
      "loadMaxKg": 40,
      "last": {
        "dayLabel": "Monday",
        "reps": 9,
        "loadLabel": "10 kg each"
      },
      "cues": [
        "Lie on the floor, knees bent, upper arms resting on the floor.",
        "Press both bells up until your arms are straight.",
        "Lower slowly until your elbows touch down."
      ]
    },
    "one-arm-row": {
      "id": "one-arm-row",
      "name": "One-arm dumbbell row",
      "sets": 2,
      "repsTarget": "10 each side",
      "repsDefault": 10,
      "repsMin": 1,
      "repsMax": 30,
      "loadKg": 12,
      "loadLabel": "12 kg",
      "loadStepKg": 2,
      "loadMinKg": 0,
      "loadMaxKg": 40,
      "last": {
        "dayLabel": "Monday",
        "reps": 10,
        "loadLabel": "12 kg"
      },
      "cues": [
        "One hand and knee on the bench, back flat.",
        "Pull the bell toward your hip.",
        "Lower it all the way before the next rep."
      ]
    },
    "romanian-deadlift": {
      "id": "romanian-deadlift",
      "name": "Dumbbell Romanian deadlift",
      "sets": 2,
      "repsTarget": "10",
      "repsDefault": 10,
      "repsMin": 1,
      "repsMax": 30,
      "loadKg": 14,
      "loadLabel": "14 kg each",
      "loadStepKg": 2,
      "loadMinKg": 0,
      "loadMaxKg": 40,
      "last": {
        "dayLabel": "Monday",
        "reps": 10,
        "loadLabel": "12 kg each"
      },
      "cues": [
        "Soft knees; slide the bells down your thighs.",
        "Push your hips back until you feel your hamstrings.",
        "Stand tall by bringing your hips forward."
      ]
    },
    "calf-raise": {
      "id": "calf-raise",
      "name": "Standing calf raise",
      "sets": 2,
      "repsTarget": "12",
      "repsDefault": 12,
      "repsMin": 1,
      "repsMax": 30,
      "loadKg": 0,
      "loadLabel": "Body weight",
      "loadStepKg": 2,
      "loadMinKg": 0,
      "loadMaxKg": 20,
      "last": {
        "dayLabel": "Monday",
        "reps": 12,
        "loadLabel": "Body weight"
      },
      "cues": [
        "Hold the rack lightly for balance.",
        "Rise onto the balls of your feet.",
        "Lower slowly, heels just below the step."
      ]
    },
    "box-squat": {
      "id": "box-squat",
      "name": "Box squat to a bench",
      "sets": 2,
      "repsTarget": "8",
      "repsDefault": 8,
      "repsMin": 1,
      "repsMax": 30,
      "loadKg": 10,
      "loadLabel": "10 kg",
      "loadStepKg": 2,
      "loadMinKg": 0,
      "loadMaxKg": 40,
      "last": {
        "dayLabel": "Monday",
        "reps": 10,
        "loadLabel": "10 kg"
      },
      "cues": [
        "Stand a short step in front of the bench.",
        "Sit back until you lightly touch the bench.",
        "Stand straight up without rocking."
      ]
    }
  },
  "sessions": {
    "full": {
      "id": "full-body-a",
      "title": "Full-body strength",
      "minutes": 35,
      "movementIds": [
        "goblet-squat",
        "floor-press",
        "one-arm-row",
        "romanian-deadlift",
        "calf-raise"
      ],
      "setTotal": 11
    },
    "short": {
      "id": "full-body-short",
      "title": "Full-body strength, short",
      "minutes": 20,
      "movementIds": [
        "goblet-squat",
        "floor-press",
        "one-arm-row"
      ],
      "setsPerMovement": 2,
      "setTotal": 6
    }
  },
  "week": [
    {
      "key": "mon",
      "dayShort": "Mon",
      "dayNumber": 5,
      "kind": "session",
      "status": "logged",
      "title": "Full-body strength",
      "detail": "Logged · 11 sets · 34 min"
    },
    {
      "key": "tue",
      "dayShort": "Tue",
      "dayNumber": 6,
      "kind": "rest",
      "status": "rest",
      "title": "Rest",
      "detail": "A walk is plenty."
    },
    {
      "key": "wed",
      "dayShort": "Wed",
      "dayNumber": 7,
      "kind": "session",
      "status": "today",
      "title": "Full-body strength",
      "detail": "Today · 35 min · 5 movements"
    },
    {
      "key": "thu",
      "dayShort": "Thu",
      "dayNumber": 8,
      "kind": "rest",
      "status": "rest",
      "title": "Rest",
      "detail": ""
    },
    {
      "key": "fri",
      "dayShort": "Fri",
      "dayNumber": 9,
      "kind": "session",
      "status": "planned",
      "title": "Full-body strength",
      "detail": "Planned · 35 min · 5 movements"
    },
    {
      "key": "sat",
      "dayShort": "Sat",
      "dayNumber": 10,
      "kind": "rest",
      "status": "rest",
      "title": "Rest",
      "detail": "Optional: 10 minutes of easy mobility."
    },
    {
      "key": "sun",
      "dayShort": "Sun",
      "dayNumber": 11,
      "kind": "rest",
      "status": "rest",
      "title": "Rest",
      "detail": ""
    }
  ],
  "planMoves": {
    "fri": {
      "targetKey": "sat",
      "label": "Move to Saturday",
      "notice": "Friday's session moved to Saturday."
    },
    "wed": {
      "targetKey": null,
      "label": "Use the 20-minute version",
      "notice": "Today is now the 20-minute version."
    }
  },
  "progress": {
    "weeks": [
      {
        "start": "Aug 17",
        "sets": 22,
        "minutes": 68,
        "sessions": 2
      },
      {
        "start": "Aug 24",
        "sets": 33,
        "minutes": 104,
        "sessions": 3
      },
      {
        "start": "Aug 31",
        "sets": 11,
        "minutes": 34,
        "sessions": 1
      },
      {
        "start": "Sep 7",
        "sets": 28,
        "minutes": 90,
        "sessions": 3
      },
      {
        "start": "Sep 14",
        "sets": 33,
        "minutes": 105,
        "sessions": 3
      },
      {
        "start": "Sep 21",
        "sets": 33,
        "minutes": 103,
        "sessions": 3
      },
      {
        "start": "Sep 28",
        "sets": 28,
        "minutes": 89,
        "sessions": 3
      },
      {
        "start": "Oct 5",
        "sets": 11,
        "minutes": 34,
        "sessions": 1,
        "current": true,
        "note": "so far"
      }
    ],
    "weekSessions": {
      "Sep 28": [
        "Mon Sep 28 · Full-body strength · 11 sets · 34 min",
        "Wed Sep 30 · Short version · 6 sets · 20 min",
        "Fri Oct 2 · Full-body strength · 11 sets · 35 min"
      ],
      "Oct 5": [
        "Mon Oct 5 · Full-body strength · 11 sets · 34 min"
      ],
      "default": [
        "3 sessions logged this week."
      ]
    },
    "leads": {
      "sets": "4 completed weeks: 122 sets.<br>Prior 3 completed weeks: 66.",
      "minutes": "4 completed weeks: 387 minutes.<br>Prior 3 completed weeks: 206.",
      "sessions": "4 completed weeks: 12 sessions.<br>Prior 3 completed weeks: 6."
    },
    "consistencyNote": "Steady beats big. You trained three times in 5 of the last 7 full weeks.",
    "recent": [
      {
        "dayShort": "Mon",
        "dayNumber": 5,
        "title": "Full-body strength",
        "entry": "11 sets · 34 min",
        "best": "Goblet squat 10 × 10 kg"
      },
      {
        "dayShort": "Fri",
        "dayNumber": 2,
        "title": "Full-body strength",
        "entry": "11 sets · 35 min",
        "best": "Romanian deadlift 10 × 12 kg each"
      },
      {
        "dayShort": "Wed",
        "dayNumber": 30,
        "title": "Short version",
        "entry": "6 sets · 20 min",
        "best": "Row 10 × 12 kg"
      }
    ]
  },
  "coach": {
    "context": "About today · Full-body strength",
    "opening": [
      {
        "speaker": "you",
        "time": "7:24",
        "text": "My left knee feels a bit stiff this morning. Should I still squat?"
      },
      {
        "speaker": "coach",
        "time": "7:24",
        "text": "Let's keep squatting, but make it easier on the knee: a box squat to a bench, 2 sets of 8 at 10 kg. If it still feels stiff, stop and log what you did."
      }
    ],
    "drafts": {
      "box-squat": {
        "title": "Draft change to today",
        "from": "Goblet squat · 3 × 8–10 · 12 kg",
        "to": "Box squat to a bench · 2 × 8 · 10 kg",
        "keep": "Everything else stays the same.",
        "apply": "Apply to today",
        "dismiss": "Not now",
        "applied": "Applied. Box squat replaces goblet squat today.",
        "dismissed": "Kept as planned. You can still apply it.",
        "effect": {
          "replaceMovement": "goblet-squat",
          "with": "box-squat"
        }
      },
      "short": {
        "title": "Draft change to today",
        "from": "35 min · 5 movements · 11 sets",
        "to": "20 min · squat, press, row · 6 sets",
        "keep": "Your Friday session stays the same.",
        "apply": "Use the 20-minute version",
        "dismiss": "Not now",
        "applied": "Applied. Today is the 20-minute version.",
        "dismissed": "Kept at 35 minutes.",
        "effect": {
          "sessionVariant": "short"
        }
      }
    },
    "suggestions": [
      {
        "id": "shorter",
        "chip": "Make today shorter",
        "you": "Can we make today shorter?",
        "coach": "Yes. The 20-minute version keeps squat, press and row, two sets each.",
        "draft": "short"
      },
      {
        "id": "why-box",
        "chip": "Why a box squat?",
        "you": "Why a box squat?",
        "coach": "The bench sets your depth, so every rep stops in the same place. It's a common way to keep squatting while a knee settles.",
        "draft": null
      },
      {
        "id": "hurts",
        "chip": "What if it hurts?",
        "you": "What if it hurts during the set?",
        "coach": "Stop the movement and log the reps you did. Sharp or worsening pain is a reason to check with a health professional, not to push through.",
        "draft": null
      }
    ],
    "followUpTimes": [
      "7:26",
      "7:27",
      "7:29",
      "7:31"
    ],
    "freeNoteReply": "Noted on today's page. For plan changes, pick one of the suggestions above.",
    "disclaimer": "Suggestions are general training guidance, not medical advice."
  }
} as const;
