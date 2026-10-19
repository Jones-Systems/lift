// Generated from the sealed b/v1 package by generate-source.py. Do not edit.
export const fixtures = {
  "system": "FORM2-B-SYSTEM",
  "version": "1.0.0-draft",
  "fixtureOnly": true,
  "user": {
    "name": "Alex"
  },
  "activeDate": "2026-09-30",
  "locale": "en-US",
  "loadUnit": "kg",
  "plans": {
    "full": {
      "name": "Full-body strength",
      "minutes": 35,
      "exerciseIds": [
        "goblet-squat",
        "floor-press",
        "supported-row",
        "dumbbell-hinge",
        "calf-raise"
      ],
      "plannedSetCount": 11
    },
    "short": {
      "name": "Full-body strength",
      "minutes": 20,
      "exerciseIds": [
        "goblet-squat",
        "floor-press",
        "supported-row"
      ],
      "plannedSetCount": 7
    }
  },
  "exercises": [
    {
      "id": "goblet-squat",
      "name": "Goblet squat",
      "station": 1,
      "sets": 3,
      "targetRepsMin": 8,
      "targetRepsMax": 10,
      "proposedReps": 10,
      "proposedLoadKg": 12,
      "loadLabel": "One dumbbell",
      "cue": "Keep your whole foot on the floor. Stand tall between reps."
    },
    {
      "id": "floor-press",
      "name": "Dumbbell floor press",
      "station": 2,
      "sets": 2,
      "targetRepsMin": 8,
      "targetRepsMax": 10,
      "proposedReps": 10,
      "proposedLoadKg": 8,
      "loadLabel": "Each dumbbell",
      "cue": "Let your upper arms touch the floor gently, then press up."
    },
    {
      "id": "supported-row",
      "name": "Supported dumbbell row",
      "station": 3,
      "sets": 2,
      "targetRepsMin": 8,
      "targetRepsMax": 10,
      "proposedReps": 10,
      "proposedLoadKg": 12,
      "loadLabel": "Each side; one dumbbell",
      "cue": "Keep your support hand steady. Draw the weight toward your hip."
    },
    {
      "id": "dumbbell-hinge",
      "name": "Dumbbell hinge",
      "station": 4,
      "sets": 2,
      "targetRepsMin": 8,
      "targetRepsMax": 10,
      "proposedReps": 10,
      "proposedLoadKg": 10,
      "loadLabel": "Each dumbbell",
      "cue": "Move your hips back and keep the weights close to your legs."
    },
    {
      "id": "calf-raise",
      "name": "Standing calf raise",
      "station": 5,
      "sets": 2,
      "targetRepsMin": 10,
      "targetRepsMax": 12,
      "proposedReps": 12,
      "proposedLoadKg": 0,
      "loadLabel": "Bodyweight; added weight 0 kg",
      "cue": "Use support if helpful. Lift and lower your heels with control."
    }
  ],
  "schedule": [
    {
      "date": "2026-09-28",
      "dayLabel": "Mon",
      "dateLabel": "28",
      "kind": "recorded",
      "sessionId": "recorded-2026-09-28"
    },
    {
      "date": "2026-09-29",
      "dayLabel": "Tue",
      "dateLabel": "29",
      "kind": "rest",
      "sessionId": null
    },
    {
      "date": "2026-09-30",
      "dayLabel": "Wed",
      "dateLabel": "30",
      "kind": "planned",
      "sessionId": "planned-2026-09-30"
    },
    {
      "date": "2026-10-01",
      "dayLabel": "Thu",
      "dateLabel": "1",
      "kind": "rest",
      "sessionId": null
    },
    {
      "date": "2026-10-02",
      "dayLabel": "Fri",
      "dateLabel": "2",
      "kind": "planned",
      "sessionId": "planned-2026-10-02"
    },
    {
      "date": "2026-10-03",
      "dayLabel": "Sat",
      "dateLabel": "3",
      "kind": "rest",
      "sessionId": null
    },
    {
      "date": "2026-10-04",
      "dayLabel": "Sun",
      "dateLabel": "4",
      "kind": "rest",
      "sessionId": null
    }
  ],
  "recordedSessions": [
    {
      "id": "recorded-2026-09-07",
      "date": "2026-09-07",
      "name": "Full-body strength",
      "planKey": "full",
      "plannedSetCount": 11,
      "status": "partial",
      "confirmedSets": [
        {
          "id": "recorded-2026-09-07:goblet-squat:1",
          "exerciseId": "goblet-squat",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:goblet-squat:2",
          "exerciseId": "goblet-squat",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:goblet-squat:3",
          "exerciseId": "goblet-squat",
          "setNumber": 3,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:floor-press:1",
          "exerciseId": "floor-press",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:floor-press:2",
          "exerciseId": "floor-press",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:supported-row:1",
          "exerciseId": "supported-row",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:supported-row:2",
          "exerciseId": "supported-row",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:dumbbell-hinge:1",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:dumbbell-hinge:2",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-07:calf-raise:1",
          "exerciseId": "calf-raise",
          "setNumber": 1,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        }
      ]
    },
    {
      "id": "recorded-2026-09-10",
      "date": "2026-09-10",
      "name": "Full-body strength",
      "planKey": "full",
      "plannedSetCount": 11,
      "status": "partial",
      "confirmedSets": [
        {
          "id": "recorded-2026-09-10:goblet-squat:1",
          "exerciseId": "goblet-squat",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:goblet-squat:2",
          "exerciseId": "goblet-squat",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:goblet-squat:3",
          "exerciseId": "goblet-squat",
          "setNumber": 3,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:floor-press:1",
          "exerciseId": "floor-press",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:floor-press:2",
          "exerciseId": "floor-press",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:supported-row:1",
          "exerciseId": "supported-row",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:supported-row:2",
          "exerciseId": "supported-row",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:dumbbell-hinge:1",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:dumbbell-hinge:2",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-10:calf-raise:1",
          "exerciseId": "calf-raise",
          "setNumber": 1,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        }
      ]
    },
    {
      "id": "recorded-2026-09-14",
      "date": "2026-09-14",
      "name": "Full-body strength",
      "planKey": "full",
      "plannedSetCount": 11,
      "status": "recorded",
      "confirmedSets": [
        {
          "id": "recorded-2026-09-14:goblet-squat:1",
          "exerciseId": "goblet-squat",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:goblet-squat:2",
          "exerciseId": "goblet-squat",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:goblet-squat:3",
          "exerciseId": "goblet-squat",
          "setNumber": 3,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:floor-press:1",
          "exerciseId": "floor-press",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:floor-press:2",
          "exerciseId": "floor-press",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:supported-row:1",
          "exerciseId": "supported-row",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:supported-row:2",
          "exerciseId": "supported-row",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:dumbbell-hinge:1",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:dumbbell-hinge:2",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:calf-raise:1",
          "exerciseId": "calf-raise",
          "setNumber": 1,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-14:calf-raise:2",
          "exerciseId": "calf-raise",
          "setNumber": 2,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        }
      ]
    },
    {
      "id": "recorded-2026-09-17",
      "date": "2026-09-17",
      "name": "Full-body strength",
      "planKey": "full",
      "plannedSetCount": 11,
      "status": "recorded",
      "confirmedSets": [
        {
          "id": "recorded-2026-09-17:goblet-squat:1",
          "exerciseId": "goblet-squat",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:goblet-squat:2",
          "exerciseId": "goblet-squat",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:goblet-squat:3",
          "exerciseId": "goblet-squat",
          "setNumber": 3,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:floor-press:1",
          "exerciseId": "floor-press",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:floor-press:2",
          "exerciseId": "floor-press",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:supported-row:1",
          "exerciseId": "supported-row",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:supported-row:2",
          "exerciseId": "supported-row",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:dumbbell-hinge:1",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:dumbbell-hinge:2",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:calf-raise:1",
          "exerciseId": "calf-raise",
          "setNumber": 1,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-17:calf-raise:2",
          "exerciseId": "calf-raise",
          "setNumber": 2,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        }
      ]
    },
    {
      "id": "recorded-2026-09-21",
      "date": "2026-09-21",
      "name": "Full-body strength",
      "planKey": "full",
      "plannedSetCount": 11,
      "status": "partial",
      "confirmedSets": [
        {
          "id": "recorded-2026-09-21:goblet-squat:1",
          "exerciseId": "goblet-squat",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:goblet-squat:2",
          "exerciseId": "goblet-squat",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:goblet-squat:3",
          "exerciseId": "goblet-squat",
          "setNumber": 3,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:floor-press:1",
          "exerciseId": "floor-press",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:floor-press:2",
          "exerciseId": "floor-press",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:supported-row:1",
          "exerciseId": "supported-row",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:supported-row:2",
          "exerciseId": "supported-row",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:dumbbell-hinge:1",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:dumbbell-hinge:2",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-21:calf-raise:1",
          "exerciseId": "calf-raise",
          "setNumber": 1,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        }
      ]
    },
    {
      "id": "recorded-2026-09-23",
      "date": "2026-09-23",
      "name": "Full-body strength",
      "planKey": "full",
      "plannedSetCount": 11,
      "status": "partial",
      "confirmedSets": [
        {
          "id": "recorded-2026-09-23:goblet-squat:1",
          "exerciseId": "goblet-squat",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:goblet-squat:2",
          "exerciseId": "goblet-squat",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:goblet-squat:3",
          "exerciseId": "goblet-squat",
          "setNumber": 3,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:floor-press:1",
          "exerciseId": "floor-press",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:floor-press:2",
          "exerciseId": "floor-press",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:supported-row:1",
          "exerciseId": "supported-row",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:supported-row:2",
          "exerciseId": "supported-row",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:dumbbell-hinge:1",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:dumbbell-hinge:2",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-23:calf-raise:1",
          "exerciseId": "calf-raise",
          "setNumber": 1,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        }
      ]
    },
    {
      "id": "recorded-2026-09-25",
      "date": "2026-09-25",
      "name": "Full-body strength",
      "planKey": "full",
      "plannedSetCount": 11,
      "status": "recorded",
      "confirmedSets": [
        {
          "id": "recorded-2026-09-25:goblet-squat:1",
          "exerciseId": "goblet-squat",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:goblet-squat:2",
          "exerciseId": "goblet-squat",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:goblet-squat:3",
          "exerciseId": "goblet-squat",
          "setNumber": 3,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:floor-press:1",
          "exerciseId": "floor-press",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:floor-press:2",
          "exerciseId": "floor-press",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:supported-row:1",
          "exerciseId": "supported-row",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:supported-row:2",
          "exerciseId": "supported-row",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:dumbbell-hinge:1",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:dumbbell-hinge:2",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:calf-raise:1",
          "exerciseId": "calf-raise",
          "setNumber": 1,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-25:calf-raise:2",
          "exerciseId": "calf-raise",
          "setNumber": 2,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        }
      ]
    },
    {
      "id": "recorded-2026-09-28",
      "date": "2026-09-28",
      "name": "Full-body strength",
      "planKey": "full",
      "plannedSetCount": 11,
      "status": "recorded",
      "confirmedSets": [
        {
          "id": "recorded-2026-09-28:goblet-squat:1",
          "exerciseId": "goblet-squat",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:goblet-squat:2",
          "exerciseId": "goblet-squat",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:goblet-squat:3",
          "exerciseId": "goblet-squat",
          "setNumber": 3,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:floor-press:1",
          "exerciseId": "floor-press",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:floor-press:2",
          "exerciseId": "floor-press",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 8,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:supported-row:1",
          "exerciseId": "supported-row",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:supported-row:2",
          "exerciseId": "supported-row",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 12,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:dumbbell-hinge:1",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 1,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:dumbbell-hinge:2",
          "exerciseId": "dumbbell-hinge",
          "setNumber": 2,
          "repetitions": 10,
          "loadKg": 10,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:calf-raise:1",
          "exerciseId": "calf-raise",
          "setNumber": 1,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        },
        {
          "id": "recorded-2026-09-28:calf-raise:2",
          "exerciseId": "calf-raise",
          "setNumber": 2,
          "repetitions": 12,
          "loadKg": 0,
          "confirmed": true
        }
      ]
    }
  ],
  "weeklySummary": [
    {
      "weekStart": "2026-09-07",
      "label": "Sep 7",
      "sets": 20,
      "sessions": 2
    },
    {
      "weekStart": "2026-09-14",
      "label": "Sep 14",
      "sets": 22,
      "sessions": 2
    },
    {
      "weekStart": "2026-09-21",
      "label": "Sep 21",
      "sets": 31,
      "sessions": 3
    },
    {
      "weekStart": "2026-09-28",
      "label": "Sep 28",
      "sets": 11,
      "sessions": 1
    }
  ],
  "initialState": {
    "screen": "today",
    "selectedPlanDate": "2026-09-30",
    "pendingPlanKey": "full",
    "activeSession": null,
    "selectedProgressWeek": "2026-09-28",
    "progressMetric": "sets",
    "coachState": "proposed",
    "confirmedCurrentSets": []
  },
  "captureFixture": {
    "id": "workout-active-one-recorded",
    "description": "Explicit screenshot/showcase state; opening Workout alone does not create this record.",
    "activeSessionId": "planned-2026-09-30",
    "planKey": "full",
    "currentExerciseId": "goblet-squat",
    "currentSetNumber": 2,
    "confirmedCurrentSets": [
      {
        "id": "planned-2026-09-30:goblet-squat:1",
        "exerciseId": "goblet-squat",
        "setNumber": 1,
        "repetitions": 10,
        "loadKg": 12,
        "confirmed": true
      }
    ],
    "draft": {
      "repetitions": "10",
      "loadKg": "12"
    },
    "progressStillExcludesUnfinishedSession": true
  },
  "longTextFixture": {
    "exerciseName": "Supported single-arm dumbbell row with a bench",
    "cue": "Place one hand on a stable support and keep your feet comfortable. Draw the dumbbell toward your hip, then lower it with control. Adjust the position if it does not feel comfortable.",
    "message": "I only have twenty minutes between work and picking someone up. Can I keep the squat, press and row today and leave the rest for another time?"
  },
  "recordingRules": {
    "onlyConfirmedSetsCount": true,
    "plannedValuesAreNotRecords": true,
    "finishRequiredToAddSessionToProgress": true,
    "zeroSetFinishAddsNoSession": true,
    "partialSessionCountsOnce": true,
    "duplicateConfirmationIsNoOp": true,
    "changingPlanWithConfirmedSetsBlocked": true,
    "resetOwner": "gallery",
    "persistence": "in-memory while variant remains mounted"
  },
  "inputDemoConstraints": {
    "repMinimum": 1,
    "repMaximum": 100,
    "weightKgMinimum": 0,
    "weightKgMaximum": 300,
    "weightStepperKg": 1,
    "repetitionsStepper": 1,
    "decimalCommaAccepted": true,
    "interpretation": "UI example limits, not training advice"
  }
} as const;
