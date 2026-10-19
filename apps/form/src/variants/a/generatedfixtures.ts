// Generated from the immutable a/v2 ready package by generate-source.py. Do not edit.
// Fictional local demo data only (Alex; week Oct 5–11). No account, network or live coach.
export const fixtures = {
  "source": {
    "file": "app/app.js",
    "sha256": "0962e6adb680799abc6bd7bb0e50b8741b228e885b7b75bbdaadaccd5a3ec10a"
  },
  "moves": [
    {
      "id": "squat",
      "name": "Goblet squat",
      "full": 3,
      "short": 3,
      "reps": "8–10",
      "kg": 12,
      "each": false,
      "cue": "Sit between your feet.",
      "defReps": 10
    },
    {
      "id": "press",
      "name": "Dumbbell floor press",
      "full": 3,
      "short": 2,
      "reps": "8–10",
      "kg": 8,
      "each": true,
      "cue": "Lower with control.",
      "defReps": 10
    },
    {
      "id": "row",
      "name": "One-arm dumbbell row",
      "full": 3,
      "short": 2,
      "reps": "10–12",
      "kg": 10,
      "each": false,
      "cue": "Pull toward your hip.",
      "defReps": 12
    },
    {
      "id": "hinge",
      "name": "Dumbbell Romanian deadlift",
      "full": 1,
      "short": 0,
      "reps": "10",
      "kg": 14,
      "each": true,
      "cue": "Send your hips back.",
      "defReps": 10
    },
    {
      "id": "calf",
      "name": "Standing calf raise",
      "full": 1,
      "short": 0,
      "reps": "12",
      "kg": 0,
      "each": false,
      "cue": "Rise, pause, lower.",
      "defReps": 12
    }
  ],
  "days": [
    {
      "id": "mon",
      "label": "Mon",
      "date": 5,
      "long": "Monday, Oct 5",
      "kind": "done"
    },
    {
      "id": "tue",
      "label": "Tue",
      "date": 6,
      "long": "Tuesday, Oct 6",
      "kind": "rest"
    },
    {
      "id": "wed",
      "label": "Wed",
      "date": 7,
      "long": "Wednesday, Oct 7",
      "kind": "today"
    },
    {
      "id": "thu",
      "label": "Thu",
      "date": 8,
      "long": "Thursday, Oct 8",
      "kind": "rest"
    },
    {
      "id": "fri",
      "label": "Fri",
      "date": 9,
      "long": "Friday, Oct 9",
      "kind": "planned"
    },
    {
      "id": "sat",
      "label": "Sat",
      "date": 10,
      "long": "Saturday, Oct 10",
      "kind": "rest"
    },
    {
      "id": "sun",
      "label": "Sun",
      "date": 11,
      "long": "Sunday, Oct 11",
      "kind": "rest"
    }
  ],
  "history": [
    {
      "id": "w8",
      "day": "Mon, Oct 5",
      "min": 31,
      "sets": 11,
      "week": 3
    },
    {
      "id": "w7",
      "day": "Fri, Oct 2",
      "min": 35,
      "sets": 11,
      "week": 2
    },
    {
      "id": "w6",
      "day": "Wed, Sep 30",
      "min": 33,
      "sets": 11,
      "week": 2
    },
    {
      "id": "w5",
      "day": "Mon, Sep 28",
      "min": 35,
      "sets": 11,
      "week": 2
    },
    {
      "id": "w4",
      "day": "Fri, Sep 25",
      "min": 30,
      "sets": 11,
      "week": 1
    },
    {
      "id": "w3",
      "day": "Mon, Sep 21",
      "min": 35,
      "sets": 11,
      "week": 1
    },
    {
      "id": "w2",
      "day": "Fri, Sep 18",
      "min": 32,
      "sets": 11,
      "week": 0
    },
    {
      "id": "w1",
      "day": "Mon, Sep 14",
      "min": 35,
      "sets": 11,
      "week": 0
    }
  ],
  "weeks": [
    "Sep 14",
    "Sep 21",
    "Sep 28",
    "Oct 5"
  ],
  "restSeconds": 60,
  "planMinutes": {
    "short": 20,
    "full": 35
  },
  "seedLine": "Short on time? Keep the main three.",
  "footnote": "Sample replies, on this device.",
  "thisWeek": 3
} as const;
