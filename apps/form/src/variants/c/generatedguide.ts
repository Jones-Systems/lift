// Generated from the sealed c/v3 package by generate-source.py. Do not edit.
export const guide = {
  "thesis": "Your training is the page; the coach writes in the margin.",
  "adjectives": [
    "spacious",
    "legible",
    "accountable"
  ],
  "avoided": [
    "clinical",
    "cute",
    "hyped"
  ],
  "sources": [
    [
      "Owner website design-system (Guidugli v1, via website-structure.json)",
      "Documentation architecture: thesis, source map, color roles and forbidden pairs, type specimens, space/grid, surfaces, identity, imagery, motion and reduced motion, voice do/don't, accessibility adaptations (AX-n), numbered component anatomy and state specimens, page purposes",
      "Same section order here; AX-n list (§9); numbered components C-01…C-25; page-purpose map in pages.md",
      "Bridal aesthetic: ivory/espresso, Cormorant italic, zero-radius luxury, tracked uppercase eyebrows"
    ],
    [
      "Original Form directions (Daylight/Studio/Dusk, owner-created)",
      "\"Next session\" first on Today; a duration-led session; a calm week view; Today/Plan/Coach/Progress tabs; \"Review session\" verb clarity",
      "Today leads with the session and a gutter-held \"35 min\"; \"Start workout\" is explicit",
      "Dusk dark appearance; Studio's cream + terracotta + display serif (the current AI cliché); the generic card-with-illustration hero"
    ],
    [
      "Original Form Studio selected screens",
      "\"Make it your set\": enter what you did, then confirm; \"the target is guidance\"; a partial workout is saved honestly",
      "Workout active-set well + Confirm set; the copy \"The target is a guide. Record what you did.\"; Finish saves only confirmed sets",
      "Huge-numeral cards repeated per field; brown figurative art; tracked caps eyebrows"
    ],
    [
      "Headspace Today (reference only)",
      "Bright surface, greeting, a vertical timeline of today's items with visible completion",
      "Visible completion becomes tick boxes in the gutter and the week tally",
      "Illustration tiles; timeline dots"
    ],
    [
      "Fitbod upcoming workouts (reference only)",
      "Separating next from upcoming; count summaries; an explicit loading state",
      "Plan separates Today, Logged and Planned through gutter state and detail line",
      "Dark surfaces; calorie estimates (out of scope by brief)"
    ],
    [
      "Fitbod workout overview (reference only)",
      "Exercise heading with sets × reps × load; persistent primary start",
      "Today's session list lists 3 × 8–10 per movement; primary action persistent",
      "Photo thumbnails with muscle maps; dark theme"
    ],
    [
      "Hevy set logging (reference only)",
      "Previous vs current values; per-set completion check; explicit Finish",
      "Each set row shows Monday's value in entrySm; tick box per set; \"Finish and save\"",
      "Spreadsheet columns with zeros, all-caps headers, blue-on-everything"
    ],
    [
      "Hevy profile trend (reference only)",
      "One weekly metric, a readable bar trend, a metric selector",
      "Progress tally rows with a Sets / Minutes / Sessions segment",
      "Vertical bars with axis ticks; social counts"
    ],
    [
      "Ladder coach context (reference only)",
      "A named context, duration and goal; preview before commitment",
      "Coach starts with \"About today · Full-body strength\"; the draft-change panel is a preview before apply",
      "Dark neon look; star ratings; coach photography"
    ]
  ],
  "contrast": [
    [
      "text.primary on page",
      "16.98",
      "7",
      "Body, titles"
    ],
    [
      "text.primary on well",
      "15.69",
      "7",
      "Active set"
    ],
    [
      "text.secondary on page / well",
      "7.49 / 6.92",
      "4.5",
      "Leads, meta"
    ],
    [
      "text.tertiary on page / well",
      "5.19 / 4.79",
      "4.5",
      "Targets, rest days"
    ],
    [
      "text.accent on page / well / selected",
      "7.85 / 7.25 / 6.59",
      "4.5",
      "Text actions, selected segment"
    ],
    [
      "text.note on page",
      "7.85",
      "4.5",
      "Coach notes"
    ],
    [
      "primaryLabel on primaryBg / pressed",
      "7.85 / 10.61",
      "4.5",
      "Buttons"
    ],
    [
      "primaryLabelDisabled on primaryBgDisabled",
      "4.84",
      "4.5",
      "Disabled button (kept readable on purpose)"
    ],
    [
      "text.onMark on highlight",
      "13.04",
      "7",
      "Confirmed values"
    ],
    [
      "text.secondary on highlight",
      "5.75",
      "4.5",
      "Allowed for \"so far\" sub-labels only"
    ],
    [
      "text.error on page / error well",
      "6.24 / 5.41",
      "4.5",
      "Errors"
    ],
    [
      "line.control on page / well",
      "3.62 / 3.35",
      "3",
      "Control edges"
    ],
    [
      "line.margin on page",
      "7.85",
      "3",
      "Margin rule"
    ],
    [
      "chart.bar on page; barPast on page / track",
      "7.85; 4.30 / 3.97",
      "3",
      "Tally bars"
    ],
    [
      "icon default / muted / selected on bar",
      "16.98 / 7.49 / 7.85",
      "3",
      "Tab bar"
    ]
  ],
  "forbidden": [
    [
      "Any text other than text.primary / text.secondary on highlighter",
      "Tertiary is 3.99:1; ballpoint on highlighter reads as a link."
    ],
    [
      "Highlighter as a chart mark, border, icon or lone indicator",
      "1.2:1 against white; it fails as a non-text graphic. Highlighter always sits behind text that carries the meaning."
    ],
    [
      "line.ruling as the only edge of a control",
      "1.33:1. Controls use line.control."
    ],
    [
      "Ballpoint fill behind anything but the primary action and the selected tab indicator",
      "One tinted primary per screen."
    ],
    [
      "Correction red for \"undo\" or ordinary secondary actions",
      "Red means a correction or a stop, not \"less important\"."
    ],
    [
      "Correction red and highlighter on the same entry",
      "A value cannot be both confirmed and wrong."
    ],
    [
      "Border + shadow on one surface",
      "One separation method per surface."
    ]
  ],
  "motion": [
    [
      "Stepper −/+",
      "Very high",
      "None; value swaps instantly",
      "duration.instant",
      "Same"
    ],
    [
      "Button / chip press",
      "High",
      "Scale to 0.97 (motion.scale.press) and pressed color",
      "120 ms easing.out",
      "Color only, no scale"
    ],
    [
      "Row press",
      "High",
      "surface.pressed wash, instant",
      "0",
      "Same"
    ],
    [
      "Tab switch",
      "High",
      "None",
      "—",
      "—"
    ],
    [
      "Confirm set (signature)",
      "~11 per session",
      "Tick stroke draws (dash 0→1) in 160 ms; at the same moment the highlighter swipe grows scaleX 0→1 from its left edge over 220 ms easing.out; one light-impact haptic on the press frame",
      "160 / 220 ms",
      "Tick and swipe fade in (opacity 0→1, 120 ms); haptic unchanged"
    ],
    [
      "Undo confirmed set",
      "Occasional",
      "Swipe recedes scaleX 1→0 toward its left edge, tick fades out",
      "160 ms easing.standard",
      "Opacity 1→0, 120 ms"
    ],
    [
      "Coach \"Apply\" / Plan change",
      "Rare",
      "Changed text gets a swipe drawn exactly like Confirm set; the change notice enters by opacity + translateY 8→0",
      "220 ms",
      "Opacity only, 120 ms"
    ],
    [
      "Row expand / collapse",
      "Occasional",
      "Height and body opacity; chevron rotates motion.rotation.disclosure = 180°",
      "200 ms easing.out / standard",
      "Instant height, 120 ms opacity"
    ],
    [
      "Sheet present / dismiss",
      "Rare",
      "translateY 24→0 + opacity; scrim opacity 0→1",
      "240 ms easing.out",
      "Opacity only, 120 ms"
    ]
  ],
  "voice": [
    [
      "\"Ready when you are, Alex.\"",
      "\"Let's crush it today!\""
    ],
    [
      "\"The target is a guide. Record what you did.\"",
      "\"Hit your target!\""
    ],
    [
      "\"Saved 7 confirmed sets. Sets you didn't confirm aren't recorded.\"",
      "\"Workout complete!\""
    ],
    [
      "\"Monday's squats moved well. I'd try 12 kg today.\"",
      "\"AI Coach recommends +20% load\""
    ],
    [
      "\"Sharp or worsening pain is a reason to check with a health professional.\"",
      "Any diagnosis, calorie, body-fat or recovery-score claim"
    ],
    [
      "\"Friday's session moved to Saturday. Undo\"",
      "\"Plan updated successfully\""
    ]
  ],
  "a11y": [
    [
      "AX-1",
      "Every interactive element has a hit area of at least 44 × 44 (size.touchMin). Visible chips (36) and tick boxes (28) extend their hit area with hitSlop."
    ],
    [
      "AX-2",
      "Text minimum is 13 pt; reading text is 17. All Text scales with Dynamic Type, capped by a11y.maxScaleDisplay 1.4 (display, figures), maxScaleBody 2.0 (reading text, entries, labels) and maxScaleTab 1.3 (tab labels)."
    ],
    [
      "AX-3",
      "At a font scale ≥ 1.3 the margin stacks (§5). Nothing truncates except tab labels, which never wrap."
    ],
    [
      "AX-4",
      "Focus (keyboard/Web and Full Keyboard Access) is a 2 pt line.focus outline with a 2 pt offset, following the control's radius. It is never removed."
    ],
    [
      "AX-5",
      "State is never shown by color alone. Confirmed = tick + swipe + \"Confirmed\" in the accessibility label. Current tab = color + 3 pt indicator + accessibilityState.selected. Today in Plan = \"Today\" text + underline."
    ],
    [
      "AX-6",
      "Highlighter carries only text.primary/text.secondary. Tertiary never sits on it."
    ],
    [
      "AX-7",
      "The margin rule, ruling, swipes and note pins are decorative (accessible={false}, importantForAccessibility=\"no\"). Their meaning is always also in text."
    ],
    [
      "AX-8",
      "A gutter and its entry are read as one element: each row is an accessible group whose label starts with the gutter fact (\"Set 1. 10 reps at 12 kilograms. Confirmed.\")."
    ],
    [
      "AX-9",
      "Coach notes are announced with the prefix \"Coach note:\"; coach messages with \"Coach:\"; yours with \"You:\"."
    ],
    [
      "AX-10",
      "Steppers use accessibilityRole=\"adjustable\" with accessibilityActions increment/decrement and accessibilityValue text (\"10 reps\"). The −/+ buttons remain individually focusable for switch users."
    ],
    [
      "AX-11",
      "Confirm set, Apply and Undo post an announcement (AccessibilityInfo.announceForAccessibility) that matches the visible notice text."
    ],
    [
      "AX-12",
      "Reduce Motion follows §8; nothing auto-plays."
    ],
    [
      "AX-13",
      "Units are spoken in full: \"kg\" is labelled \"kilograms\" and \"×\" is labelled \"at\" in accessibility labels."
    ],
    [
      "AX-14",
      "Disabled controls keep 4.84:1 label contrast and are paired with a reason line where the reason is not obvious."
    ]
  ],
  "purposes": [
    [
      "Today",
      "Show the next workout and the week at a glance; start it",
      "Start workout",
      "Minutes"
    ],
    [
      "Plan",
      "See and change the week; nothing moves without you",
      "(per row) Move / version",
      "Day and date"
    ],
    [
      "Workout",
      "Follow the movement and confirm each set you actually did",
      "Confirm set N",
      "Set number, cue number"
    ],
    [
      "Coach",
      "Talk about today; review, apply or undo a drafted change",
      "Apply to today",
      "Speaker and time"
    ],
    [
      "Progress",
      "Read what you have recorded and how it trends",
      "— (metric switch)",
      "Week"
    ]
  ],
  "components": [
    {
      "id": "C-01",
      "key": "c01",
      "name": "Margin section",
      "anatomy": "The signature layout primitive. It is a vertical block whose rows each pair a gutter\nfact with content, and it draws the margin rule beside them.\n\nAnatomy:\n0. Section heading (optional) — type.titleLg text.primary at contentLeft,\n   accessibilityRole=\"header\", layout.sectionHeadingToBody 12 above the first\n   row; the margin rule starts at the heading's top. Optional trailing C-10 text\n   action right-aligned on the heading's first line.\n1. Gutter column — layout.gutterLeft 20, width layout.gutterWidth 44.\n2. Margin rule — x layout.ruleLeft 72, width layout.ruleWidth 2, color\n   role.line.margin, height = section height (from the top of the first row to the bottom\n   of the last row). Absolutely positioned and decorative.\n3. Content column — x layout.contentLeft 88 to W − layout.contentRightInset 20.\n4. Note pin (optional, per row) — size.notePin 8 square, radius 0, fill\n   role.line.margin, left = ruleLeft + size.notePinOffset (−3), vertically\n   centered on the first line of the pinned coach note.\n\n| State | Visual |\n| --- | --- |\n| default | As above. |\n| stacked (font scale ≥ a11y.stackedMarginScale) | Rule at x 20 (layout.stackedMarginRuleLeft); content at x 36 (stackedMarginContentLeft); gutter text renders on its own line above each row's content, inline (e.g. \"Set 1\"), same type roles; pins sit on the rule at x 17. |\n\nAccessibility: the rule and pins are hidden from assistive technology. Rows read as\n\"gutter fact, content\".",
      "states": [
        {
          "name": "default",
          "description": "As above."
        },
        {
          "name": "stacked (font scale ≥ a11y.stackedMarginScale)",
          "description": "Rule at x 20 (layout.stackedMarginRuleLeft); content at x 36 (stackedMarginContentLeft); gutter text renders on its own line above each row's content, inline (e.g. \"Set 1\"), same type roles; pins sit on the rule at x 17."
        }
      ]
    },
    {
      "id": "C-02",
      "key": "c02",
      "name": "Top bar",
      "anatomy": "Height layout.topBarHeight 52, below the safe area. Background role.surface.bar.\n\nAnatomy: 1 wordmark \"Form\" (type.wordmark, text.primary) at x 20,\nvertically centered. 2 optional right slot: one C-10 text action or one 44 × 44 icon\nbutton, right edge at W − 12 (optical). 3 bottom edge: 1 pt role.line.ruling.\n\n| State | Visual |\n| --- | --- |\n| rest (scroll offset 0) | No bottom edge. |\n| scrolled (offset > 0) | 1 pt bottom ruling appears instantly. |\n\ntestID: c-<page>-topbar. The wordmark has accessibilityRole=\"header\" only on\nToday; elsewhere the page title is the header.",
      "states": [
        {
          "name": "rest (scroll offset 0)",
          "description": "No bottom edge."
        },
        {
          "name": "scrolled (offset > 0)",
          "description": "1 pt bottom ruling appears instantly."
        }
      ]
    },
    {
      "id": "C-03",
      "key": "c03",
      "name": "Page header",
      "anatomy": "Crosses the margin (x 20 → W − 20).\n\nAnatomy (top to bottom): 1 date or context line, type.metaMd,\ntext.secondary, layout.pageHeaderTop 8 below the top bar. 2 title,\ntype.displayXl, text.primary, dateToTitle 4 below, max 3 lines, never\ntruncated. 3 optional lead, type.bodyLead, text.secondary, titleToLead\n12 below, max 3 lines at default size. Then layout.headerBottom 32 to the\nfirst section.\n\n| State | Visual |\n| --- | --- |\n| default | As above. |\n| no lead | Title → section is 32. |\n| large text | Title wraps freely (maxScale 1.4); lead wraps freely. |\n\nThe title has accessibilityRole=\"header\". testIDs: c-<page>-date, c-<page>-title, c-<page>-lead.",
      "states": [
        {
          "name": "default",
          "description": "As above."
        },
        {
          "name": "no lead",
          "description": "Title → section is 32."
        },
        {
          "name": "large text",
          "description": "Title wraps freely (maxScale 1.4); lead wraps freely."
        }
      ]
    },
    {
      "id": "C-04",
      "key": "c04",
      "name": "Gutter marker",
      "anatomy": "A two-line fact in the gutter, left-aligned in 44 pt.\n\n| Variant | Line 1 | Line 2 | Example |\n| --- | --- | --- | --- |\n| day | labelSm word | figureGutter numeral | Wed / 7 |\n| set | labelSm \"Set\" | figureGutter | Set / 1 |\n| cue | — | figureGutter | 1 |\n| speaker | labelSm \"You\" or \"Coach\" | entrySm time | You / 7:24 |\n| week | labelSm month | figureGutter day | Sep / 28 |\n| minutes | figureGutter value | labelSm \"min\" | 35 / min |\n\nNumerals nudge 2 pt down (space.hair) for optical baseline alignment with content.\n\n| State | Word color | Numeral color | Extra |\n| --- | --- | --- | --- |\n| default | text.secondary | text.primary | — |\n| current (today, active set) | text.accent | text.accent | 2 pt line.selected underline, 24 wide, 2 below the numeral (size.currentDayUnderline) |\n| done | text.secondary | text.primary | — |\n| muted (rest, pending) | text.tertiary | text.tertiary | — |\n| coach speaker | text.note | text.tertiary (time) | — |",
      "states": [
        {
          "name": "default",
          "description": "text.secondary · text.primary · —"
        },
        {
          "name": "current (today, active set)",
          "description": "text.accent · text.accent · 2 pt line.selected underline, 24 wide, 2 below the numeral (size.currentDayUnderline)"
        },
        {
          "name": "done",
          "description": "text.secondary · text.primary · —"
        },
        {
          "name": "muted (rest, pending)",
          "description": "text.tertiary · text.tertiary · —"
        },
        {
          "name": "coach speaker",
          "description": "text.note · text.tertiary (time) · —"
        }
      ]
    },
    {
      "id": "C-05",
      "key": "c05",
      "name": "Ruled entry row",
      "anatomy": "A single line in the log.\n\nGeometry: min height size.rowLogMin 56 (log variant) or size.rowListMin\n48 (list variant). Padding 12 top and 14 bottom. Gutter marker (C-04) in the gutter;\ncontent column holds: 1 primary line (titleMd, bodyMd or entryMd per\nvariant), 2 optional detail line (metaMd or entrySm, text.secondary,\n4 below), 3 optional trailing slot (tick box C-07, chevron 18, or value),\nright-aligned to W − 20, vertically centered on the primary line. 4 bottom\nruling 1 pt line.ruling from contentLeft to W − 20 (omitted on the last row\nof a section and on cue/preview variants).\n\nVariants: log (set rows, day rows), list (recent entries), cue\n(numbered form cue: gutter cue numeral in text.tertiary, content bodyMd, no ruling, min height 32,\npadding 4/4), preview (Today session movements: no gutter, bodyMd name +\ntrailing entrySm target, min height 32, no ruling).\n\n| State | Visual | Interactive? |\n| --- | --- | --- |\n| default | As above | If pressable |\n| pressed | Wash surface.pressed from contentLeft − 8 to W − 12, radius 4, full row height; the margin rule stays visible | — |\n| focus | 2 pt line.focus outline offset 2 around the same wash rect | — |\n| current | Gutter marker current; primary line text.primary | — |\n| done | Tick box checked; values in entryMd text.primary with highlighter swipe (C-06) when confirmed this session | — |\n| pending | Values in entrySm text.tertiary (targets); tick box empty | No |\n| muted (rest day) | Gutter muted; primary line text.tertiary | No |\n| disabled | text.disabled; no press | No |\n| expanded | See C-15/C-21 | — |\n\nAccessibility: one accessible element per row; its label = gutter fact + primary + detail + state.",
      "states": [
        {
          "name": "default",
          "description": "As above · If pressable"
        },
        {
          "name": "pressed",
          "description": "Wash surface.pressed from contentLeft − 8 to W − 12, radius 4, full row height; the margin rule stays visible · —"
        },
        {
          "name": "focus",
          "description": "2 pt line.focus outline offset 2 around the same wash rect · —"
        },
        {
          "name": "current",
          "description": "Gutter marker current; primary line text.primary · —"
        },
        {
          "name": "done",
          "description": "Tick box checked; values in entryMd text.primary with highlighter swipe (C-06) when confirmed this session · —"
        },
        {
          "name": "pending",
          "description": "Values in entrySm text.tertiary (targets); tick box empty · No"
        },
        {
          "name": "muted (rest day)",
          "description": "Gutter muted; primary line text.tertiary · No"
        },
        {
          "name": "disabled",
          "description": "text.disabled; no press · No"
        },
        {
          "name": "expanded",
          "description": "See C-15/C-21 · —"
        }
      ]
    },
    {
      "id": "C-06",
      "key": "c06",
      "name": "Highlighter swipe",
      "anatomy": "V2 geometry is defined in DESIGN.md §7 and matches the viewed v1 CSS:\nsize.swipeOverhangX = 0 pt; top = mark.swipeTop = 0.38 and bottom edge =\nmark.swipeBottom = 0.92 of the text run's containing box. The base box uses\nleft:0 and right:0. Apply mark.swipeSkewDegrees = −10 as skewX(-10deg);\nformat the number token as ${token}deg on native. There is no fixed-point\nslant token. Use an equivalent transformed native view or SVG path behind the\nmeasured text run. Keep transformed overflow visible; do not add 4 pt padding\nor clip the skew. Resting skew is vertically centered; drawing scaleX uses the\nleft-center origin. Single-line runs only. If a run wraps, mark its first line;\nCoach's movement and dose are separate lines. No pixels change from v1.\n\n| State | Visual | Motion (§8) |\n| --- | --- | --- |\n| hidden | Not rendered | — |\n| drawing | scaleX 0 → 1, origin left | 220 ms easing.out (RM: opacity 120) |\n| shown | Static | — |\n| receding | scaleX 1 → 0, origin left | 160 ms easing.standard (RM: opacity 120) |\n\nMeaning is fixed: confirmed or applied by you. It is never used for emphasis, for headings, or\nfor data the user did not confirm. Decorative for accessibility; the row label\ncarries \"Confirmed\" or \"Applied\".",
      "states": [
        {
          "name": "hidden",
          "description": "Not rendered · —"
        },
        {
          "name": "drawing",
          "description": "scaleX 0 → 1, origin left · 220 ms easing.out (RM: opacity 120)"
        },
        {
          "name": "shown",
          "description": "Static · —"
        },
        {
          "name": "receding",
          "description": "scaleX 1 → 0, origin left · 160 ms easing.standard (RM: opacity 120)"
        }
      ]
    },
    {
      "id": "C-07",
      "key": "c07",
      "name": "Tick box",
      "anatomy": "Visible size size.tickBox 28 (C-14 uses size.weekTick 22), radius\nradius.xs 4. An indicator, not a control: it is never pressable on its own.\n\n| State | Fill | Border | Glyph |\n| --- | --- | --- | --- |\n| empty | surface.page | border.tick 2 line.control | — |\n| current | surface.page | 2 line.selected | — |\n| checked | action.primaryBg | none | check path, stroke size.tickStroke 2.5, icon.onAction, 16 × 16 (12 × 12 at 22), centered; draws over 160 ms on confirm |\n| disabled | surface.page | 2 color.ink.300 | — |",
      "states": [
        {
          "name": "empty",
          "description": "surface.page · border.tick 2 line.control · —"
        },
        {
          "name": "current",
          "description": "surface.page · 2 line.selected · —"
        },
        {
          "name": "checked",
          "description": "action.primaryBg · none · check path, stroke size.tickStroke 2.5, icon.onAction, 16 × 16 (12 × 12 at 22), centered; draws over 160 ms on confirm"
        },
        {
          "name": "disabled",
          "description": "surface.page · 2 color.ink.300 · —"
        }
      ]
    },
    {
      "id": "C-08",
      "key": "c08",
      "name": "Primary button",
      "anatomy": "Height size.buttonPrimaryHeight 56, radius radius.sm 8, background\naction.primaryBg, label type.labelLg action.primaryLabel, centered,\nhorizontal padding 20. Width: full (x 20 → W − 20) when it crosses the margin\n(page primary actions), or fill the container (draft panel, rail). One per screen.\nThere is no arrow or icon.\n\n| State | Background | Label | Other |\n| --- | --- | --- | --- |\n| default | action.primaryBg | action.primaryLabel | — |\n| pressed | action.primaryBgPressed | same | scale 0.97, 120 ms (RM: none) |\n| disabled | action.primaryBgDisabled | action.primaryLabelDisabled | accessibilityState.disabled |\n| focus | default | default | 2 pt line.focus outline, offset 2, radius 10 |\n\naccessibilityRole=\"button\"; the label equals the visible text.",
      "states": [
        {
          "name": "default",
          "description": "action.primaryBg · action.primaryLabel · —"
        },
        {
          "name": "pressed",
          "description": "action.primaryBgPressed · same · scale 0.97, 120 ms (RM: none)"
        },
        {
          "name": "disabled",
          "description": "action.primaryBgDisabled · action.primaryLabelDisabled · accessibilityState.disabled"
        },
        {
          "name": "focus",
          "description": "default · default · 2 pt line.focus outline, offset 2, radius 10"
        }
      ]
    },
    {
      "id": "C-09",
      "key": "c09",
      "name": "Secondary button",
      "anatomy": "Height size.buttonSecondaryHeight 48, radius 8, transparent, border\nborder.control 1.5 action.secondaryBorder, label labelLg\naction.secondaryLabel, padding x 16, width = content (min 120) unless stated.\n\n| State | Visual |\n| --- | --- |\n| default | As above |\n| pressed | Fill surface.pressed; scale 0.97 (RM: none) |\n| disabled | Border and label color.ink.300 |\n| focus | 2 pt outline offset 2 |\n| caution variant (sheet \"Start over\") | Border and label role.text.error; pressed fill surface.error |",
      "states": [
        {
          "name": "default",
          "description": "As above"
        },
        {
          "name": "pressed",
          "description": "Fill surface.pressed; scale 0.97 (RM: none)"
        },
        {
          "name": "disabled",
          "description": "Border and label color.ink.300"
        },
        {
          "name": "focus",
          "description": "2 pt outline offset 2"
        },
        {
          "name": "caution variant (sheet \"Start over\")",
          "description": "Border and label role.text.error; pressed fill surface.error"
        }
      ]
    },
    {
      "id": "C-10",
      "key": "c10",
      "name": "Text action",
      "anatomy": "type.labelMd, text.accent, underline (1 pt, textDecorationLine:\n'underline'), hit height size.textActionHeight 44, horizontal hit padding\n8, left-aligned with its column. No arrow.\n\n| Variant / state | Visual |\n| --- | --- |\n| default | As above |\n| pressed | Color color.ballpoint.700 |\n| disabled | text.disabled, no underline |\n| focus | 2 pt outline offset 2 around the 44-high hit rect, radius 4 |\n| undo | Leading undo-2 icon 18 icon.selected, gap 4, label \"Undo\" |\n| caution (an action that directly discards data) | role.text.error, underline |\n| confirmation opener (Workout “Start over”, c-workout-reset) | Default role.text.accent, underline; presents C-24 and does not mutate sets. Explicit C-04 exception to the old label-based caution assignment. |\n\nThe Start over label has two distinct roles. c-workout-reset is the blue C-10 opener in both active and saved Workout. c-workout-reset-confirm is the separate C-09 caution button inside C-24; only that button clears data. Apply caution styling by the action performed, not by matching the label text.",
      "states": [
        {
          "name": "default",
          "description": "As above"
        },
        {
          "name": "pressed",
          "description": "Color color.ballpoint.700"
        },
        {
          "name": "disabled",
          "description": "text.disabled, no underline"
        },
        {
          "name": "focus",
          "description": "2 pt outline offset 2 around the 44-high hit rect, radius 4"
        },
        {
          "name": "undo",
          "description": "Leading undo-2 icon 18 icon.selected, gap 4, label \"Undo\""
        },
        {
          "name": "caution (an action that directly discards data)",
          "description": "role.text.error, underline"
        },
        {
          "name": "confirmation opener (Workout “Start over”, c-workout-reset)",
          "description": "Default role.text.accent, underline; presents C-24 and does not mutate sets. Explicit C-04 exception to the old label-based caution assignment."
        }
      ]
    },
    {
      "id": "C-11",
      "key": "c11",
      "name": "Stepper",
      "anatomy": "Used in pairs inside the active-set well (Workout). Each stepper is one row,\nfull well inner width.\n\nGeometry (well inner width = content width − 32; 262 at W 402):\n1. Label, labelSm text.secondary, width 56, left (\"Reps\", \"Load\").\n2. Minus button, 44 × 44 (size.stepperButton), radius 4, border 1.5\n   line.control, minus icon 22 icon.default, 8 after the label.\n3. Value slot, flexible (≥ size.stepperValueMinWidth 88), centered:\n   value in type.figureLg text.primary plus unit in metaMd\n   text.secondary 4 after it on the same baseline (\"10\" \"reps\", \"12\" \"kg\";\n   for load 0 the slot shows \"Body\" + \"weight\" in metaMd, and minus is disabled).\n4. Plus button, as minus with the plus icon, right edge at the well's inner right.\nRow height size.stepperHeight 64; 8 between the two steppers.\n\n| State | Visual |\n| --- | --- |\n| default | As above |\n| button pressed | Button fill surface.pressed; value changes instantly (no animation) |\n| at min | Minus border and icon color.ink.300, accessibilityState.disabled |\n| at max | Plus likewise |\n| focus | Outline around the whole stepper row (adjustable group) |\n| read-only (confirmed) | Not rendered; confirmed values appear in the row instead |\n\nSteps come from fixtures.json (repsMin/Max step 1; loadStepKg\n2, loadMinKg, loadMaxKg). Accessibility: the row is\naccessibilityRole=\"adjustable\" with label \"Reps\" and value \"10 reps\"; the −/+\nbuttons are labelled \"Fewer reps\"/\"More reps\", \"Less load\"/\"More load\".\ntestIDs: c-workout-reps-minus, c-workout-reps-value, c-workout-reps-plus,\nc-workout-load-minus, c-workout-load-value, c-workout-load-plus.",
      "states": [
        {
          "name": "default",
          "description": "As above"
        },
        {
          "name": "button pressed",
          "description": "Button fill surface.pressed; value changes instantly (no animation)"
        },
        {
          "name": "at min",
          "description": "Minus border and icon color.ink.300, accessibilityState.disabled"
        },
        {
          "name": "at max",
          "description": "Plus likewise"
        },
        {
          "name": "focus",
          "description": "Outline around the whole stepper row (adjustable group)"
        },
        {
          "name": "read-only (confirmed)",
          "description": "Not rendered; confirmed values appear in the row instead"
        }
      ]
    },
    {
      "id": "C-12",
      "key": "c12",
      "name": "Segmented selector",
      "anatomy": "Content-column width, height size.segmentHeight 40, container border 1.5\nline.control, radius 4, three equal segments separated by 1.5 line.control.\nLabel labelMd, centered.\n\n| State | Fill | Label | Border |\n| --- | --- | --- | --- |\n| unselected | surface.page | text.secondary | — |\n| pressed | surface.pressed | text.secondary | — |\n| selected | surface.selected | text.accent | 2 pt line.selected inset on that segment |\n| focus | — | — | 2 pt outline offset 2 on the segment |\n\naccessibilityRole=\"tab\" per segment inside a tablist; selected state set. No weight change.",
      "states": [
        {
          "name": "unselected",
          "description": "surface.page · text.secondary · —"
        },
        {
          "name": "pressed",
          "description": "surface.pressed · text.secondary · —"
        },
        {
          "name": "selected",
          "description": "surface.selected · text.accent · 2 pt line.selected inset on that segment"
        },
        {
          "name": "focus",
          "description": "— · — · 2 pt outline offset 2 on the segment"
        }
      ]
    },
    {
      "id": "C-13",
      "key": "c13",
      "name": "Session summary (Today)",
      "anatomy": "A margin section.\n\nAnatomy: 1 gutter minutes marker (\"35\"/\"min\"; \"20\"/\"min\" in the short\nvariant). 2 titleMd session title. 3 metaMd text.secondary detail line,\n4 below. 4 movement preview list (C-05 preview variant), 12 below. 5 text action\ntoggling the version, 8 below. 6 coach margin note (pinned, noteMd\ntext.note, prefixed by nothing), 20 below, followed by a C-10 text action, 4 below.\n\n| State | Difference |\n| --- | --- |\n| full | 35 min · 5 movements · 11 sets; five preview rows; toggle \"Short on time? Use the 20-minute version\" |\n| short | 20 min · 3 movements · 6 sets; three preview rows (2 × each); minutes numeral swiped (C-06, drawn on change); toggle \"Back to 35 minutes\" |\n| coach-changed (box squat applied) | First preview row reads \"Box squat to a bench · 2 × 8\"; that name gets a swipe |\n| workout in progress (≥ 1 confirmed set today) | Detail line appends \"· 3 of 11 sets confirmed\"; primary label becomes \"Continue workout\" |\n| saved | Detail \"Saved · N sets\" (N = confirmed sets); primary becomes secondary \"Review today's log\" (navigates to Workout saved state) |",
      "states": [
        {
          "name": "full",
          "description": "35 min · 5 movements · 11 sets; five preview rows; toggle \"Short on time? Use the 20-minute version\""
        },
        {
          "name": "short",
          "description": "20 min · 3 movements · 6 sets; three preview rows (2 × each); minutes numeral swiped (C-06, drawn on change); toggle \"Back to 35 minutes\""
        },
        {
          "name": "coach-changed (box squat applied)",
          "description": "First preview row reads \"Box squat to a bench · 2 × 8\"; that name gets a swipe"
        },
        {
          "name": "workout in progress (≥ 1 confirmed set today)",
          "description": "Detail line appends \"· 3 of 11 sets confirmed\"; primary label becomes \"Continue workout\""
        },
        {
          "name": "saved",
          "description": "Detail \"Saved · N sets\" (N = confirmed sets); primary becomes secondary \"Review today's log\" (navigates to Workout saved state)"
        }
      ]
    },
    {
      "id": "C-14",
      "key": "c14",
      "name": "Week tally",
      "anatomy": "Sentence (bodyMd, text.primary) above a row of three items, 12 between them.\nItem = tick box (22) + labelSm day word, 8 apart; items 24 apart; row height 44.\n\n| Item state | Tick | Label |\n| --- | --- | --- |\n| done | checked | text.secondary |\n| today | current | text.accent + underline 2 |\n| today saved | checked | text.accent |\n| planned | empty | text.secondary |\n| moved (Plan moved Fri → Sat) | empty | label reads \"Sat\" |\n\nNot pressable. Label: \"This week: Monday logged, Wednesday today, Friday planned.\"",
      "states": [
        {
          "name": "default",
          "description": "Sentence (bodyMd, text.primary) above a row of three items, 12 between them.\nItem = tick box (22) + labelSm day word, 8 apart; items 24 apart; row height 44."
        }
      ]
    },
    {
      "id": "C-15",
      "key": "c15",
      "name": "Expandable day row (Plan)",
      "anatomy": "C-05 log variant with gutter day marker, primary titleMd (session) or\nbodyMd (rest), detail metaMd, trailing chevron-down 18 for session rows.\n\nExpanded body: 12 below the detail line, a well (surface.well, radius 8,\npadding 16, content-column width) containing: 1 preview list (C-05 preview), 2 actions,\n16 below: one C-09 secondary button and/or one C-10 text action, 12 apart, stacked.\n\n| State | Visual |\n| --- | --- |\n| collapsed | Chevron down |\n| pressed | Row wash |\n| expanded | Chevron rotates from 0° to motion.rotation.disclosure = 180°; well visible (motion.duration.expand 200 ms, motion.easing.out; collapse uses motion.easing.standard). RM rotation and height change instantly; body opacity uses motion.duration.reducedFade 120 ms. |\n| logged | Expandable; the well shows \"Logged · 11 sets · 34 min\" and no actions |\n| today | Gutter current; detail starts \"Today\"; the well offers \"Use the 20-minute version\" (secondary) and \"Open workout\" (text action) |\n| planned | The well offers \"Move to Saturday\" (secondary) |\n| changed | Changed gutter numeral or detail gets a swipe; a C-16 notice appears directly below the row |\n| rest | Not pressable, no chevron, muted |\n| target of a move (Sat after the move) | Becomes a planned session row with the swipe on its title; Fri becomes rest (\"Moved to Saturday\", muted) |\n\nOnly one row is expanded at a time. accessibilityState.expanded is set.",
      "states": [
        {
          "name": "collapsed",
          "description": "Chevron down"
        },
        {
          "name": "pressed",
          "description": "Row wash"
        },
        {
          "name": "expanded",
          "description": "Chevron rotates from 0° to motion.rotation.disclosure = 180°; well visible (motion.duration.expand 200 ms, motion.easing.out; collapse uses motion.easing.standard). RM rotation and height change instantly; body opacity uses motion.duration.reducedFade 120 ms."
        },
        {
          "name": "logged",
          "description": "Expandable; the well shows \"Logged · 11 sets · 34 min\" and no actions"
        },
        {
          "name": "today",
          "description": "Gutter current; detail starts \"Today\"; the well offers \"Use the 20-minute version\" (secondary) and \"Open workout\" (text action)"
        },
        {
          "name": "planned",
          "description": "The well offers \"Move to Saturday\" (secondary)"
        },
        {
          "name": "changed",
          "description": "Changed gutter numeral or detail gets a swipe; a C-16 notice appears directly below the row"
        },
        {
          "name": "rest",
          "description": "Not pressable, no chevron, muted"
        },
        {
          "name": "target of a move (Sat after the move)",
          "description": "Becomes a planned session row with the swipe on its title; Fri becomes rest (\"Moved to Saturday\", muted)"
        }
      ]
    },
    {
      "id": "C-16",
      "key": "c16",
      "name": "Change notice",
      "anatomy": "An inline message in the content column, placed directly under the changed\nelement (row, panel or rail). bodyMd text.primary message, then a C-10 undo text\naction 4 below. 12 above and 16 below. No box, no color fill; the swipe on the\nchanged value is the visual signal.\n\n| State | Visual |\n| --- | --- |\n| hidden | — |\n| visible | Opacity + translateY 8 → 0, 220 ms (RM opacity 120) |\n| after undo | Notice removed; the change reverts; the swipe recedes; the announcement \"Undone.\" is posted |\n\nIt persists until undo, until the next change on the same page, or until the page resets.\nIt does not auto-dismiss on a timer, so older users are not rushed.",
      "states": [
        {
          "name": "hidden",
          "description": "—"
        },
        {
          "name": "visible",
          "description": "Opacity + translateY 8 → 0, 220 ms (RM opacity 120)"
        },
        {
          "name": "after undo",
          "description": "Notice removed; the change reverts; the swipe recedes; the announcement \"Undone.\" is posted"
        }
      ]
    },
    {
      "id": "C-17",
      "key": "c17",
      "name": "Draft-change panel (Coach)",
      "anatomy": "The one bordered surface. It crosses the margin (x 20 → W − 20) because it\nholds the page's primary action. The margin rule is interrupted around it.\n\nAnatomy: background surface.raised, border 1.5 line.selected, radius 8,\npadding 16 (bottom 20).\n1. Title titleMd text.primary (\"Draft change to today\").\n2. A mini-margin, 12 below: two rows, each with a 40-wide label column (labelSm\n   text.secondary: \"Was\", \"Now\") and a value. \"Was\" value is entrySm\n   text.tertiary with textDecorationLine: 'line-through'; \"Now\" value is\n   entryMd text.primary. 8 between rows.\n3. Keep line, metaMd text.secondary, 12 below.\n4. Primary button (C-08, panel inner width), 16 below.\n5. Text action \"Not now\" (C-10), 4 below, left.\n\n| State | Visual |\n| --- | --- |\n| draft | As above |\n| applied | Items 4–5 are replaced by the applied message (bodyMd) + an undo text action; the \"Now\" value gets a swipe drawn on apply; border stays |\n| dismissed | Collapses to one line: metaMd dismissed message + text action \"Review draft\" (reopens draft); no border, no panel fill |\n| undone | Returns to draft; a C-16 notice under the panel reads \"Undone. Today is back to the original plan.\" |\n| superseded | The other draft (if any) stays independent; only one panel can be applied per effect type |\n\nAnnouncements: \"Applied. Box squat replaces goblet squat today.\" testIDs per\ndraft key k: c-coach-draft-<k>, c-coach-draft-<k>-apply,\nc-coach-draft-<k>-dismiss, c-coach-draft-<k>-undo, c-coach-draft-<k>-reopen.",
      "states": [
        {
          "name": "draft",
          "description": "As above"
        },
        {
          "name": "applied",
          "description": "Items 4–5 are replaced by the applied message (bodyMd) + an undo text action; the \"Now\" value gets a swipe drawn on apply; border stays"
        },
        {
          "name": "dismissed",
          "description": "Collapses to one line: metaMd dismissed message + text action \"Review draft\" (reopens draft); no border, no panel fill"
        },
        {
          "name": "undone",
          "description": "Returns to draft; a C-16 notice under the panel reads \"Undone. Today is back to the original plan.\""
        },
        {
          "name": "superseded",
          "description": "The other draft (if any) stays independent; only one panel can be applied per effect type"
        }
      ]
    },
    {
      "id": "C-18",
      "key": "c18",
      "name": "Conversation entry (Coach)",
      "anatomy": "A margin row with no ruling and no bubble. Gutter: speaker marker. Content:\n\n| Speaker | Text style | Extra |\n| --- | --- | --- |\n| you | bodyMd text.primary | — |\n| coach | noteMd text.note | Note pin on the rule at the first line |\n\n20 between entries; 8 between an entry and its attached draft panel. New entries\nappear without motion (RM same). Accessibility label: \"You, 7:24: …\" or \"Coach note, 7:24: …\".\ntestID: c-coach-entry-<index> (0-based, in display order).",
      "states": [
        {
          "name": "you",
          "description": "bodyMd text.primary · —"
        },
        {
          "name": "coach",
          "description": "noteMd text.note · Note pin on the rule at the first line"
        }
      ]
    },
    {
      "id": "C-19",
      "key": "c19",
      "name": "Suggestion chip",
      "anatomy": "Visible height size.chipHeight 36 (hit 44 via hitSlop 4), radius 4, border\n1.5 line.control, padding x 12, label labelMd text.primary. Wraps in\nthe content column; gap 8 horizontally and vertically.\n\n| State | Visual |\n| --- | --- |\n| default | As above |\n| pressed | Fill surface.pressed, scale 0.97 (RM none) |\n| used | Removed from the row (each suggestion is used once) |\n| focus | 2 pt outline offset 2 |\n| none left | Row replaced by metaMd text.secondary \"That's all the suggestions for today.\" |\n\ntestID: c-coach-chip-<id>.",
      "states": [
        {
          "name": "default",
          "description": "As above"
        },
        {
          "name": "pressed",
          "description": "Fill surface.pressed, scale 0.97 (RM none)"
        },
        {
          "name": "used",
          "description": "Removed from the row (each suggestion is used once)"
        },
        {
          "name": "focus",
          "description": "2 pt outline offset 2"
        },
        {
          "name": "none left",
          "description": "Row replaced by metaMd text.secondary \"That's all the suggestions for today.\""
        }
      ]
    },
    {
      "id": "C-20",
      "key": "c20",
      "name": "Compose field",
      "anatomy": "Content column, well background, border 1.5 line.control, radius 8,\nmin height size.composeMinHeight 48, max composeMaxHeight 120 (then\nscrolls), padding 12 left, 14 top/bottom, bodyMd. Placeholder \"Write a note\nto your coach\" in text.tertiary. Send button: 44 × 44 inside the right edge,\narrow-up icon 22, transparent.\n\n| State | Border | Send |\n| --- | --- | --- |\n| empty | 1.5 line.control | icon.disabled, disabled |\n| focused | 2 line.focus | per content |\n| filled | 1.5 line.control (2 line.focus while focused) | icon.selected, enabled |\n| sent | Clears; your entry + fixed coach reply append | disabled |\n\nThe keyboard return key is \"send\" (returnKeyType=\"send\", blurOnSubmit). No\nmicrophone. testIDs: c-coach-compose, c-coach-send.",
      "states": [
        {
          "name": "empty",
          "description": "1.5 line.control · icon.disabled, disabled"
        },
        {
          "name": "focused",
          "description": "2 line.focus · per content"
        },
        {
          "name": "filled",
          "description": "1.5 line.control (2 line.focus while focused) · icon.selected, enabled"
        },
        {
          "name": "sent",
          "description": "Clears; your entry + fixed coach reply append · disabled"
        }
      ]
    },
    {
      "id": "C-21",
      "key": "c21",
      "name": "Tally row (Progress)",
      "anatomy": "A margin row of height size.tallyRowHeight 44 with the gutter week marker. Content:\n1 track, role.chart.track, height size.tallyBarHeight 16, radius\nradius.bar 2, width = content width − size.tallyValueWidth 56 − 8,\nvertically centered. 2 bar, same height and radius, width = track width ×\nvalue / chart.scaleMax<Metric> (minimum chart.minBarPct 2% when the value is > 0),\ncolor chart.barPast (or chart.bar for the current week). 3 value,\nentryMd text.primary, right-aligned in the 56 column.\n\n| State | Visual |\n| --- | --- |\n| default (past week) | barPast |\n| current week | bar color chart.bar; a metaMd text.secondary line \"This week so far\" sits 4 below the track (row grows to 64) |\n| pressed | Row wash |\n| expanded | Below the row a well (radius 8, padding 12/16) lists that week's sessions in metaMd, one per line, 8 apart |\n| focus | Outline on the row wash rect |\n| zero | Track only; value \"0\" |\n\nMetric changes swap values instantly (no bar animation; a frequent action).\nLabel: \"Week of September 28: 28 sets.\" testID: c-progress-week-<index> (0 =\noldest).",
      "states": [
        {
          "name": "default (past week)",
          "description": "barPast"
        },
        {
          "name": "current week",
          "description": "bar color chart.bar; a metaMd text.secondary line \"This week so far\" sits 4 below the track (row grows to 64)"
        },
        {
          "name": "pressed",
          "description": "Row wash"
        },
        {
          "name": "expanded",
          "description": "Below the row a well (radius 8, padding 12/16) lists that week's sessions in metaMd, one per line, 8 apart"
        },
        {
          "name": "focus",
          "description": "Outline on the row wash rect"
        },
        {
          "name": "zero",
          "description": "Track only; value \"0\""
        }
      ]
    },
    {
      "id": "C-22",
      "key": "c22",
      "name": "Action rail (Workout)",
      "anatomy": "Pinned above the tab bar. Height layout.actionRailHeight 80, surface.bar,\n1 pt top line.ruling, shadow.rail while content is beneath it, padding 12 ×\n20.\n\n| State | Content |\n| --- | --- |\n| confirm | Primary button full width: \"Confirm set N\" |\n| confirm + undo | Undo text action (auto width) left, 12 gap, primary button flexible: \"Confirm set N\" |\n| movement done | Undo (if last action was a confirm) + primary \"Next: <next movement>\" |\n| last movement done | Undo + primary \"Finish and save\" |\n| saved | Secondary button full width \"Back to Today\" |\n\ntestIDs: c-workout-rail, c-workout-confirm, c-workout-undo,\nc-workout-next, c-workout-finish, c-workout-back-today.",
      "states": [
        {
          "name": "confirm",
          "description": "Primary button full width: \"Confirm set N\""
        },
        {
          "name": "confirm + undo",
          "description": "Undo text action (auto width) left, 12 gap, primary button flexible: \"Confirm set N\""
        },
        {
          "name": "movement done",
          "description": "Undo (if last action was a confirm) + primary \"Next: <next movement>\""
        },
        {
          "name": "last movement done",
          "description": "Undo + primary \"Finish and save\""
        },
        {
          "name": "saved",
          "description": "Secondary button full width \"Back to Today\""
        }
      ]
    },
    {
      "id": "C-23",
      "key": "c23",
      "name": "Tab bar",
      "anatomy": "Height layout.tabBarHeight 56 + bottom safe area, surface.bar, 1 pt top\nline.ruling. Five equal items: Today, Plan, Workout, Coach, Progress.\n\nItem anatomy: 1 indicator size.tabIndicatorWidth 24 × tabIndicatorHeight 3, radius 0,\nline.selected, top-centered at y 0, shown only when selected. 2 icon 22 at y 8. 3\nlabel labelSm at y 34, centered, single line, never wraps (maxScale 1.3).\n\n| State | Icon | Label | Indicator |\n| --- | --- | --- | --- |\n| unselected | icon.muted | text.secondary | — |\n| selected | icon.selected | text.accent | shown |\n| pressed | Item wash surface.pressed, radius 4 | — | — |\n| focus | 2 pt outline | — | — |\n\naccessibilityRole=\"tab\", accessibilityState.selected. testIDs:\nc-tab-today, c-tab-plan, c-tab-workout, c-tab-coach, c-tab-progress.\nSwitching tabs calls onScreenChange(screen) and does not animate.",
      "states": [
        {
          "name": "unselected",
          "description": "icon.muted · text.secondary · —"
        },
        {
          "name": "selected",
          "description": "icon.selected · text.accent · shown"
        },
        {
          "name": "pressed",
          "description": "Item wash surface.pressed, radius 4 · — · —"
        },
        {
          "name": "focus",
          "description": "2 pt outline · — · —"
        }
      ]
    },
    {
      "id": "C-24",
      "key": "c24",
      "name": "Confirmation sheet (Workout \"Start over\")",
      "anatomy": "A bottom sheet over overlay.scrim. White, radius radius.lg 20 on the top corners,\nshadow.sheet, padding 24 × 20, plus the bottom safe area.\n\nAnatomy: 1 title titleLg (\"Start this workout over?\"). 2 body bodyMd\ntext.secondary, 8 below. 3 primary button \"Keep my sets\" (full), 24 below.\n4 secondary button, C-09 caution variant, \"Start over\" (c-workout-reset-confirm, full width), 12 below. Its label and border use role.text.error. The opener outside this sheet (c-workout-reset) is a separate blue C-10 action and does not clear data.\n\n| State | Visual |\n| --- | --- |\n| closed | — |\n| opening | translateY 24 → 0 plus opacity, motion.duration.sheet 240 ms and motion.easing.out; RM opacity only, motion.duration.reducedFade 120 ms |\n| open | Focus moves to the title; Close, Keep my sets, backdrop, system Back and accessibility escape all dismiss without changing sets |\n| dragging | Follow positive downward drag only after activation; keep resting shape, width and padding; see exact contract below |\n| cancelling | Return the current drag offset to 0 and scrim to its resting opacity over motion.duration.sheet / motion.easing.out |\n| closing | From current drag offset, move a further motion.distance.sheetFrom 24 pt downward and fade sheet/scrim to 0 over motion.duration.sheet / motion.easing.out; RM uses opacity only for 120 ms |\n\nNative gesture contract (v2 C-02):\n\n1. Use the existing custom overlay surface inside a transparent modal; do not\n   substitute a native pageSheet container that changes size, position or\n   backdrop. Add no visible drag handle or extra header. Gesture attachment\n   changes no resting geometry.\n2. One pointer (gesture.sheetDismiss.maxPointers = 1) may start in the title,\n   explanatory body or existing non-control padding. A start in Close, Keep my\n   sets, Start over, or another control's hit rectangle cannot start the pan.\n   If text needs an internal scroll area at enlarged sizes, its pan can begin\n   only at content offset 0 and in the downward direction; the title region\n   remains available independently.\n3. Activate only when positive translationY reaches\n   activationTravel = 12 pt and translationY >= abs(translationX) ×\n   verticalDominance = 1.25. An upward or predominantly horizontal gesture\n   does not capture the sheet. Consume the release after activation so it\n   cannot also trigger a backdrop or button press.\n4. During normal-motion tracking, offsetY = clamp(translationY, 0,\n   measuredSheetHeight); opacity of the sheet stays 1. Scrim opacity equals its\n   canonical resting opacity × (1 − offsetY / measuredSheetHeight). No scale,\n   spring bounce, resize or haptic accompanies the drag.\n5. On release, dismiss if offsetY >= dismissTravel = 96 pt, OR if offsetY >=\n   flingMinTravel = 24 pt AND positive downward velocityY >=\n   dismissVelocity = 900 pt/s. Otherwise cancel. Normalize a gesture API's\n   velocity to points per second before comparing. Cancellation by the OS,\n   interruption or a second pointer also returns the sheet to its open state.\n6. A successful pan uses the same nondestructive close handler as Close, Keep\n   my sets, backdrop, system Back and accessibility escape. It leaves every\n   confirmed set intact and restores accessibility focus to the initiating\n   Start over control. Only the explicit caution action Start over clears the\n   sets. Expose the title and dismiss controls to VoiceOver; the pan is optional.\n7. Reduce Motion keeps the same recognition and release thresholds while\n   leaving the sheet and scrim visually stationary during tracking. Successful\n   dismissal fades both over motion.duration.reducedFade 120 ms with\n   motion.easing.out; cancellation needs no visual movement. No translation,\n   scale or haptic is introduced by that fallback. Runtime behavior is for the\n   native builder to verify; this is specified intent, not a viewed gesture.\n\ntestIDs: c-workout-reset-sheet, c-workout-reset-keep, c-workout-reset-confirm.\nThe native Close control uses c-workout-reset-close; no new visible element is added.",
      "states": [
        {
          "name": "closed",
          "description": "—"
        },
        {
          "name": "opening",
          "description": "translateY 24 → 0 plus opacity, motion.duration.sheet 240 ms and motion.easing.out; RM opacity only, motion.duration.reducedFade 120 ms"
        },
        {
          "name": "open",
          "description": "Focus moves to the title; Close, Keep my sets, backdrop, system Back and accessibility escape all dismiss without changing sets"
        },
        {
          "name": "dragging",
          "description": "Follow positive downward drag only after activation; keep resting shape, width and padding; see exact contract below"
        },
        {
          "name": "cancelling",
          "description": "Return the current drag offset to 0 and scrim to its resting opacity over motion.duration.sheet / motion.easing.out"
        },
        {
          "name": "closing",
          "description": "From current drag offset, move a further motion.distance.sheetFrom 24 pt downward and fade sheet/scrim to 0 over motion.duration.sheet / motion.easing.out; RM uses opacity only for 120 ms"
        }
      ]
    },
    {
      "id": "C-25",
      "key": "c25",
      "name": "Showcase specimen frame",
      "anatomy": "Used only when showcase is true (see pages.md §Showcase). The frame is a margin\nsection whose gutter holds the component ID (labelSm \"C-07\") and whose\ncontent holds: the component name (titleMd), one metaMd sentence of purpose,\nand then each state specimen stacked with a labelSm text.secondary state\ncaption above it (sentence case, e.g. \"Checked\"). Specimens are built from the\nsame production components and tokens, in fixed demo states (no live\ninteraction needed, but they remain functional).\n\ntestIDs: c-showcase-<cid> for the frame (e.g. c-showcase-c07) and\nc-showcase-<cid>-<state> per specimen (state in kebab-case, e.g.\nc-showcase-c07-checked).",
      "states": [
        {
          "name": "default",
          "description": "Used only when showcase is true (see pages.md §Showcase). The frame is a margin\nsection whose gutter holds the component ID (labelSm \"C-07\") and whose\ncontent holds: the component name (titleMd), one metaMd sentence of purpose,\nand then each state specimen stacked with a labelSm text.secondary state\ncaption above it (sentence case, e.g. \"Checked\"). Specimens are built from the\nsame production components and tokens, in fixed demo states (no live\ninteraction needed, but they remain functional)."
        }
      ]
    }
  ],
  "tokens": [
    {
      "path": "color.paper.white",
      "description": "Page paper. At least 70% of every screen."
    },
    {
      "path": "color.paper.tint",
      "description": "Cool well: active-set well, compose field, expanded rows."
    },
    {
      "path": "color.ink.900",
      "description": "Navy-black ink: titles, body, entries."
    },
    {
      "path": "color.ink.700",
      "description": "Secondary ink: leads, meta, previous values."
    },
    {
      "path": "color.ink.500",
      "description": "Tertiary ink: planned/target values, rest days. Never on highlighter."
    },
    {
      "path": "color.ink.300",
      "description": "Disabled text and disabled icon only (exempt from contrast)."
    },
    {
      "path": "color.ballpoint.600",
      "description": "Ballpoint blue: margin rule, primary action, coach notes, selected state."
    },
    {
      "path": "color.ballpoint.700",
      "description": "Pressed primary action."
    },
    {
      "path": "color.ballpoint.100",
      "description": "Selected chip/segment fill, pressed row wash."
    },
    {
      "path": "color.highlighter.400",
      "description": "Highlighter swipe behind confirmed values. Fill only, never text, never a lone chart mark."
    },
    {
      "path": "color.correction.600",
      "description": "Red-pen correction: errors, struck values, Stop-advice."
    },
    {
      "path": "color.correction.100",
      "description": "Error well."
    },
    {
      "path": "color.ruling.200",
      "description": "Notebook ruling hairline between log lines (decorative, non-essential)."
    },
    {
      "path": "color.ruling.500",
      "description": "Control boundary: stepper, compose, empty tick box (needs ≥3:1)."
    },
    {
      "path": "color.scrim",
      "description": "Modal scrim."
    },
    {
      "path": "role.surface.page",
      "description": ""
    },
    {
      "path": "role.surface.well",
      "description": ""
    },
    {
      "path": "role.surface.raised",
      "description": "Draft-change panel and sheets; separated by border or shadow, never both."
    },
    {
      "path": "role.surface.bar",
      "description": "Tab bar and action rail."
    },
    {
      "path": "role.surface.selected",
      "description": ""
    },
    {
      "path": "role.surface.pressed",
      "description": ""
    },
    {
      "path": "role.surface.error",
      "description": ""
    },
    {
      "path": "role.text.primary",
      "description": ""
    },
    {
      "path": "role.text.secondary",
      "description": ""
    },
    {
      "path": "role.text.tertiary",
      "description": ""
    },
    {
      "path": "role.text.disabled",
      "description": ""
    },
    {
      "path": "role.text.onAction",
      "description": ""
    },
    {
      "path": "role.text.accent",
      "description": "Links, selected labels, text actions."
    },
    {
      "path": "role.text.note",
      "description": "Coach margin notes (italic)."
    },
    {
      "path": "role.text.error",
      "description": ""
    },
    {
      "path": "role.text.onMark",
      "description": "Only primary ink sits on highlighter."
    },
    {
      "path": "role.line.ruling",
      "description": ""
    },
    {
      "path": "role.line.control",
      "description": ""
    },
    {
      "path": "role.line.margin",
      "description": "The signature margin rule."
    },
    {
      "path": "role.line.focus",
      "description": ""
    },
    {
      "path": "role.line.selected",
      "description": ""
    },
    {
      "path": "role.line.error",
      "description": ""
    },
    {
      "path": "role.action.primaryBg",
      "description": ""
    },
    {
      "path": "role.action.primaryBgPressed",
      "description": ""
    },
    {
      "path": "role.action.primaryBgDisabled",
      "description": "Disabled primary fill; label uses role.action.primaryLabelDisabled."
    },
    {
      "path": "role.action.primaryLabel",
      "description": ""
    },
    {
      "path": "role.action.primaryLabelDisabled",
      "description": ""
    },
    {
      "path": "role.action.secondaryBorder",
      "description": ""
    },
    {
      "path": "role.action.secondaryLabel",
      "description": ""
    },
    {
      "path": "role.mark.highlight",
      "description": ""
    },
    {
      "path": "role.icon.default",
      "description": ""
    },
    {
      "path": "role.icon.muted",
      "description": ""
    },
    {
      "path": "role.icon.selected",
      "description": ""
    },
    {
      "path": "role.icon.onAction",
      "description": ""
    },
    {
      "path": "role.icon.disabled",
      "description": ""
    },
    {
      "path": "role.chart.bar",
      "description": ""
    },
    {
      "path": "role.chart.barPast",
      "description": "Earlier weeks' bars, 4.30:1 on white and 3.97:1 on track; the current week uses chart.bar."
    },
    {
      "path": "role.chart.track",
      "description": ""
    },
    {
      "path": "role.overlay.scrim",
      "description": ""
    },
    {
      "path": "font.family.sansRegular",
      "description": ""
    },
    {
      "path": "font.family.sansMedium",
      "description": ""
    },
    {
      "path": "font.family.sansSemiBold",
      "description": ""
    },
    {
      "path": "font.family.sansBold",
      "description": ""
    },
    {
      "path": "font.family.sansExtraBold",
      "description": ""
    },
    {
      "path": "font.family.sansBlack",
      "description": ""
    },
    {
      "path": "font.family.sansMediumItalic",
      "description": ""
    },
    {
      "path": "font.family.monoRegular",
      "description": ""
    },
    {
      "path": "font.family.monoMedium",
      "description": ""
    },
    {
      "path": "font.family.monoSemiBold",
      "description": ""
    },
    {
      "path": "font.weight.regular",
      "description": ""
    },
    {
      "path": "font.weight.medium",
      "description": ""
    },
    {
      "path": "font.weight.semiBold",
      "description": ""
    },
    {
      "path": "font.weight.bold",
      "description": ""
    },
    {
      "path": "font.weight.extraBold",
      "description": ""
    },
    {
      "path": "font.weight.black",
      "description": ""
    },
    {
      "path": "type.wordmark",
      "description": "'Form' wordmark in top bar."
    },
    {
      "path": "type.displayXl",
      "description": "Page title; the only text that crosses the margin."
    },
    {
      "path": "type.displayLg",
      "description": "Completion and empty-state titles."
    },
    {
      "path": "type.titleLg",
      "description": "Section headings in the content column."
    },
    {
      "path": "type.titleMd",
      "description": "Item titles: session name, movement name in rows."
    },
    {
      "path": "type.bodyLead",
      "description": "One editorial lead sentence under a page title."
    },
    {
      "path": "type.bodyMd",
      "description": ""
    },
    {
      "path": "type.bodyStrong",
      "description": ""
    },
    {
      "path": "type.noteMd",
      "description": "Coach margin note and coach messages."
    },
    {
      "path": "type.noteSm",
      "description": "Short coach annotations inside rows."
    },
    {
      "path": "type.metaMd",
      "description": "Date line, meta and helper text."
    },
    {
      "path": "type.labelLg",
      "description": "Primary and secondary button labels."
    },
    {
      "path": "type.labelMd",
      "description": "Text actions, chips, segments."
    },
    {
      "path": "type.labelSm",
      "description": "Gutter words (Mon, Set, You) and tab labels."
    },
    {
      "path": "type.entryMd",
      "description": "Recorded log entries: 10 × 12 kg."
    },
    {
      "path": "type.entrySm",
      "description": "Previous/target values in rows."
    },
    {
      "path": "type.figureLg",
      "description": "Stepper values."
    },
    {
      "path": "type.figureGutter",
      "description": "Gutter numerals: day of month, set number, week day."
    },
    {
      "path": "space.none",
      "description": ""
    },
    {
      "path": "space.hair",
      "description": ""
    },
    {
      "path": "space.xxs",
      "description": ""
    },
    {
      "path": "space.xs",
      "description": ""
    },
    {
      "path": "space.sm",
      "description": ""
    },
    {
      "path": "space.md",
      "description": ""
    },
    {
      "path": "space.lg",
      "description": ""
    },
    {
      "path": "space.xl",
      "description": ""
    },
    {
      "path": "space.xxl",
      "description": ""
    },
    {
      "path": "space.x3l",
      "description": ""
    },
    {
      "path": "space.x4l",
      "description": ""
    },
    {
      "path": "space.x5l",
      "description": ""
    },
    {
      "path": "space.x6l",
      "description": ""
    },
    {
      "path": "layout.screenInsetX",
      "description": "Left and right page inset."
    },
    {
      "path": "layout.gutterLeft",
      "description": "Gutter column starts at screen x=20."
    },
    {
      "path": "layout.gutterWidth",
      "description": "Gutter column width (x 20–64). Holds dates, set numbers, speaker, week."
    },
    {
      "path": "layout.ruleLeft",
      "description": "Margin rule starts at x=72 (8 after gutter)."
    },
    {
      "path": "layout.ruleWidth",
      "description": "Margin rule thickness."
    },
    {
      "path": "layout.contentLeft",
      "description": "Content column starts at x=88 (14 after rule). Width = screen width − 108."
    },
    {
      "path": "layout.contentRightInset",
      "description": ""
    },
    {
      "path": "layout.contentWidthIphone17",
      "description": "Content column at 402-pt width."
    },
    {
      "path": "layout.contentWidthProMax",
      "description": "Content column at 440-pt width."
    },
    {
      "path": "layout.fullWidthIphone17",
      "description": "Full-bleed-to-insets width for title and primary action at 402."
    },
    {
      "path": "layout.topBarHeight",
      "description": "Below status bar safe area."
    },
    {
      "path": "layout.tabBarHeight",
      "description": "Above home-indicator safe area."
    },
    {
      "path": "layout.actionRailHeight",
      "description": "Workout sticky rail: 12 top + 56 button + 12 bottom, above tab bar."
    },
    {
      "path": "layout.pageHeaderTop",
      "description": "Top bar bottom → date line."
    },
    {
      "path": "layout.dateToTitle",
      "description": ""
    },
    {
      "path": "layout.titleToLead",
      "description": ""
    },
    {
      "path": "layout.headerBottom",
      "description": "Page header → first section."
    },
    {
      "path": "layout.sectionGap",
      "description": "Between sections."
    },
    {
      "path": "layout.sectionHeadingToBody",
      "description": ""
    },
    {
      "path": "layout.scrollBottomPad",
      "description": "After last element, before rail/tab bar."
    },
    {
      "path": "layout.stackedMarginRuleLeft",
      "description": "At fontScale ≥ stackedMarginScale the rule moves to x=20."
    },
    {
      "path": "layout.stackedMarginContentLeft",
      "description": "…and content starts at x=36 with gutter text stacked above each entry."
    },
    {
      "path": "size.touchMin",
      "description": ""
    },
    {
      "path": "size.iconSm",
      "description": ""
    },
    {
      "path": "size.iconMd",
      "description": ""
    },
    {
      "path": "size.iconLg",
      "description": ""
    },
    {
      "path": "size.iconStroke",
      "description": "Lucide stroke width."
    },
    {
      "path": "size.buttonPrimaryHeight",
      "description": ""
    },
    {
      "path": "size.buttonSecondaryHeight",
      "description": ""
    },
    {
      "path": "size.textActionHeight",
      "description": ""
    },
    {
      "path": "size.rowLogMin",
      "description": "Set row / day row minimum height."
    },
    {
      "path": "size.rowListMin",
      "description": "Simple ruled entry minimum height."
    },
    {
      "path": "size.tickBox",
      "description": "Visible tick box; hit area extends to 44."
    },
    {
      "path": "size.tickStroke",
      "description": ""
    },
    {
      "path": "size.stepperButton",
      "description": ""
    },
    {
      "path": "size.stepperHeight",
      "description": "Stepper body height."
    },
    {
      "path": "size.stepperValueMinWidth",
      "description": "Fixed slot so digits never shift layout."
    },
    {
      "path": "size.chipHeight",
      "description": "Visible; hit area 44 via hitSlop 4."
    },
    {
      "path": "size.segmentHeight",
      "description": ""
    },
    {
      "path": "size.composeMinHeight",
      "description": ""
    },
    {
      "path": "size.composeMaxHeight",
      "description": ""
    },
    {
      "path": "size.sendButton",
      "description": ""
    },
    {
      "path": "size.notePin",
      "description": "Square pin on the margin rule where a coach note attaches."
    },
    {
      "path": "size.notePinOffset",
      "description": "Pin left offset relative to ruleLeft (centres 8 on a 2 rule)."
    },
    {
      "path": "size.tabIndicatorWidth",
      "description": ""
    },
    {
      "path": "size.tabIndicatorHeight",
      "description": ""
    },
    {
      "path": "size.tallyBarHeight",
      "description": ""
    },
    {
      "path": "size.tallyRowHeight",
      "description": ""
    },
    {
      "path": "size.tallyValueWidth",
      "description": "Right-aligned value column."
    },
    {
      "path": "size.weekTick",
      "description": "Square tick in the Today week tally."
    },
    {
      "path": "size.swipeOverhangX",
      "description": "Zero explicit horizontal extension of the untransformed highlight box. Matches v1 CSS left:0;right:0. Skew may paint beyond that box; do not clip it."
    },
    {
      "path": "size.disclosureIcon",
      "description": ""
    },
    {
      "path": "size.currentDayUnderline",
      "description": "Ballpoint underline under the current day's gutter numeral (Plan, Today tally)."
    },
    {
      "path": "mark.swipeTop",
      "description": "Swipe top edge at 38% of line height."
    },
    {
      "path": "mark.swipeBottom",
      "description": "Swipe bottom edge at 92% of line height."
    },
    {
      "path": "mark.swipeSkewDegrees",
      "description": "Angle in degrees matching the viewed v1 CSS skewX(-10deg). Native transform string is `${token}deg`; this is an angle, not a fixed point slant."
    },
    {
      "path": "radius.none",
      "description": ""
    },
    {
      "path": "radius.xs",
      "description": "Tick box, chips, swipe, inputs, segment."
    },
    {
      "path": "radius.sm",
      "description": "Buttons, active-set well, draft panel."
    },
    {
      "path": "radius.lg",
      "description": "Sheet top corners."
    },
    {
      "path": "radius.bar",
      "description": "Tally bars."
    },
    {
      "path": "border.hairline",
      "description": "Ruling and rail top line (render at 1 pt, not StyleSheet.hairlineWidth, for web/native parity)."
    },
    {
      "path": "border.control",
      "description": "Stepper, compose, secondary button, draft panel."
    },
    {
      "path": "border.tick",
      "description": "Empty tick box."
    },
    {
      "path": "border.focus",
      "description": ""
    },
    {
      "path": "border.focusOffset",
      "description": ""
    },
    {
      "path": "border.selected",
      "description": ""
    },
    {
      "path": "shadow.sheet",
      "description": "Bottom sheet only."
    },
    {
      "path": "shadow.rail",
      "description": "Workout action rail when content scrolls under it."
    },
    {
      "path": "motion.duration.instant",
      "description": "Color/opacity of frequent controls; stepper values."
    },
    {
      "path": "motion.duration.press",
      "description": "Press scale feedback."
    },
    {
      "path": "motion.duration.tick",
      "description": "Tick stroke draw; swipe recede on Undo."
    },
    {
      "path": "motion.duration.swipe",
      "description": "Highlighter swipe draw — the one orchestrated moment."
    },
    {
      "path": "motion.duration.expand",
      "description": "Row disclosure height/opacity."
    },
    {
      "path": "motion.duration.sheet",
      "description": "Sheet present."
    },
    {
      "path": "motion.duration.reducedFade",
      "description": "Reduce Motion replacement for any translate/scale."
    },
    {
      "path": "motion.easing.out",
      "description": "Enters, swipe, expand."
    },
    {
      "path": "motion.easing.standard",
      "description": "Collapse, recede."
    },
    {
      "path": "motion.scale.press",
      "description": "Buttons and chips on press."
    },
    {
      "path": "motion.scale.swipeFrom",
      "description": "scaleX origin left; swipe only (not an element appearing)."
    },
    {
      "path": "motion.scale.tickFrom",
      "description": "Stroke dash progress start."
    },
    {
      "path": "motion.distance.sheetFrom",
      "description": ""
    },
    {
      "path": "motion.distance.noticeFrom",
      "description": ""
    },
    {
      "path": "motion.rotation.disclosure",
      "description": "Expanded disclosure chevron rotation in degrees. Collapsed is 0; native formats `${token}deg`. Existing C-15 intent, now canonical; no change to inherited reference pixels."
    },
    {
      "path": "a11y.maxScaleDisplay",
      "description": "maxFontSizeMultiplier for displayXl/displayLg/figureLg."
    },
    {
      "path": "a11y.maxScaleBody",
      "description": "maxFontSizeMultiplier for reading text, entries, labels."
    },
    {
      "path": "a11y.maxScaleTab",
      "description": "Tab labels."
    },
    {
      "path": "a11y.stackedMarginScale",
      "description": "PixelRatio.getFontScale() at or above this switches every margin layout to stacked margin."
    },
    {
      "path": "a11y.disabledMinContrast",
      "description": "Disabled text is exempt; it is always paired with a reason line in text.secondary."
    },
    {
      "path": "chart.scaleMaxSets",
      "description": ""
    },
    {
      "path": "chart.scaleMaxMinutes",
      "description": ""
    },
    {
      "path": "chart.scaleMaxSessions",
      "description": ""
    },
    {
      "path": "chart.minBarPct",
      "description": "A non-zero value never draws narrower than 2% (≥4 pt)."
    },
    {
      "path": "render.safeTop",
      "description": ""
    },
    {
      "path": "render.safeBottom",
      "description": ""
    },
    {
      "path": "render.phoneWidth",
      "description": ""
    },
    {
      "path": "render.phoneHeight",
      "description": ""
    },
    {
      "path": "render.maxWidth",
      "description": ""
    },
    {
      "path": "render.maxHeight",
      "description": ""
    },
    {
      "path": "render.islandWidth",
      "description": ""
    },
    {
      "path": "render.islandHeight",
      "description": ""
    },
    {
      "path": "render.islandTop",
      "description": ""
    },
    {
      "path": "render.islandRadius",
      "description": ""
    },
    {
      "path": "render.homeWidth",
      "description": ""
    },
    {
      "path": "render.homeHeight",
      "description": ""
    },
    {
      "path": "render.homeBottom",
      "description": ""
    },
    {
      "path": "render.rowPadBottom",
      "description": ""
    },
    {
      "path": "render.stepperLabelWidth",
      "description": ""
    },
    {
      "path": "render.tabLabelTop",
      "description": ""
    },
    {
      "path": "render.tabIconTop",
      "description": ""
    },
    {
      "path": "render.statusTop",
      "description": ""
    },
    {
      "path": "render.statusInset",
      "description": ""
    },
    {
      "path": "render.statusIconGap",
      "description": ""
    },
    {
      "path": "render.contentRailGap",
      "description": ""
    },
    {
      "path": "render.draftLabelWidth",
      "description": ""
    },
    {
      "path": "render.pinLeft",
      "description": ""
    },
    {
      "path": "render.pinTop",
      "description": ""
    },
    {
      "path": "render.planChevronWidth",
      "description": ""
    },
    {
      "path": "render.stepperCompactMin",
      "description": ""
    },
    {
      "path": "render.scale",
      "description": ""
    },
    {
      "path": "accessibilityType.wordmark.size",
      "description": ""
    },
    {
      "path": "accessibilityType.wordmark.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.displayXl.size",
      "description": ""
    },
    {
      "path": "accessibilityType.displayXl.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.displayLg.size",
      "description": ""
    },
    {
      "path": "accessibilityType.displayLg.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.titleLg.size",
      "description": ""
    },
    {
      "path": "accessibilityType.titleLg.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.titleMd.size",
      "description": ""
    },
    {
      "path": "accessibilityType.titleMd.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.bodyLead.size",
      "description": ""
    },
    {
      "path": "accessibilityType.bodyLead.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.bodyMd.size",
      "description": ""
    },
    {
      "path": "accessibilityType.bodyMd.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.bodyStrong.size",
      "description": ""
    },
    {
      "path": "accessibilityType.bodyStrong.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.noteMd.size",
      "description": ""
    },
    {
      "path": "accessibilityType.noteMd.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.noteSm.size",
      "description": ""
    },
    {
      "path": "accessibilityType.noteSm.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.metaMd.size",
      "description": ""
    },
    {
      "path": "accessibilityType.metaMd.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.labelLg.size",
      "description": ""
    },
    {
      "path": "accessibilityType.labelLg.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.labelMd.size",
      "description": ""
    },
    {
      "path": "accessibilityType.labelMd.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.labelSm.size",
      "description": ""
    },
    {
      "path": "accessibilityType.labelSm.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.entryMd.size",
      "description": ""
    },
    {
      "path": "accessibilityType.entryMd.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.entrySm.size",
      "description": ""
    },
    {
      "path": "accessibilityType.entrySm.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.figureLg.size",
      "description": ""
    },
    {
      "path": "accessibilityType.figureLg.line_height",
      "description": ""
    },
    {
      "path": "accessibilityType.figureGutter.size",
      "description": ""
    },
    {
      "path": "accessibilityType.figureGutter.line_height",
      "description": ""
    },
    {
      "path": "gesture.sheetDismiss.activationTravel",
      "description": "Positive downward translation required to activate after vertical direction is established."
    },
    {
      "path": "gesture.sheetDismiss.verticalDominance",
      "description": "Activate only when positive dy >= abs(dx) multiplied by this ratio."
    },
    {
      "path": "gesture.sheetDismiss.dismissTravel",
      "description": "Release at or beyond this downward travel commits nondestructive dismissal."
    },
    {
      "path": "gesture.sheetDismiss.flingMinTravel",
      "description": "Minimum downward travel before positive release velocity can commit dismissal."
    },
    {
      "path": "gesture.sheetDismiss.dismissVelocity",
      "description": "Positive downward velocity threshold in points per second. A native API reporting points per millisecond must multiply by 1000 before comparison."
    },
    {
      "path": "gesture.sheetDismiss.maxPointers",
      "description": "Only a one-finger pan begins sheet dismissal."
    }
  ],
  "flow": [
    "All five pages are tab roots. Today Start workout goes to Workout; Ask about today goes to Coach; See the plan goes to Plan. All tab navigation preserves local demo values and resets scroll. Every root remains reachable from the tab bar.",
    "Today: full default, shorter plan through version action and Undo. Plan: default collapsed days; expand today's plan or Friday; move Friday to Saturday and Undo. Workout: editable targets → explicitly Confirm set → confirmed row and Undo → next movement → Finish early and save → saved summary → Back to Today. Start over is a dismissible confirmation sheet with Keep my sets / Close, backdrop press, system Back, accessibility escape and the C-24 downward-pan contract. Every dismiss route preserves sets; only the explicit Start over caution button clears them. Coach: opening notes and draft → Apply / Not now → applied with Undo / Review draft; suggestion and compose append only local scripted notes. Progress: sets default → minutes/sessions selector; a week expands to recorded entries.",
    "Declared static reference states: today default; plan default and moved; workout default, confirmed and saved; coach default and applied; progress default. Additional interactive microstates share those components, and their full state matrices are in `component-contract.md`. No remote loading, account error or permission-denied state is applicable to this synchronous local demo. Empty compose disables Send; zero confirmed sets disables Finish; disabled plan changes after recording explain why. Zero-data tally and button disabled specimens belong in the gallery component catalogue, not invented product screens.",
    "Primary evidence: all five defaults on both devices, all declared states on both devices. Text-heavy Coach and Workout get accessibility1 references at 1.4× reading text with the rule at x20 and content x36. Non-default scroll positions are recorded separately when below-fold content matters. Native swipe dismiss, keyboard avoidance and haptics remain builder intent.",
    "V3 C-04: both active and saved Workout use the blue `c-workout-reset` link to present confirmation only. The separate `c-workout-reset-confirm` is the red caution action that clears sets. Opening or dismissing the sheet never clears data.\n"
  ],
  "separation": "Separation methods are exclusive: space, ruling, border or shadow. Choose one per surface."
} as const;
