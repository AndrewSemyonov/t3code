# Design review: T3 Code for iPhone, iPhone Duo and iPad

You are a senior product designer. Review the T3 Code mobile app from the screenshots in this pack. This is a read-only review. Do not edit files, start servers, or open browsers or simulators.

T3 Code is a client for coding agents. People use the phone and tablet apps to watch agents work on their own machines, answer the agent's questions, approve commands, review diffs and start new work. The desktop app is the reference for the product's look. The mobile app should feel like the same product, adapted to touch and to each screen size.

## What is in the pack

Every image is in `{{PACK}}`. Read each one before you score.

- `screens/<shape>/<scene>.png`: one scene on one device shape. Each tile is labelled with its device, appearance and text size.
- `desktop/<scene>.png`: the same data in the desktop web app at 1440×900, next to the iPad and iPhone captures, for the "conformance with desktop" axis.
- `flows/<task>.png`: a common task, one frame per step. The label above each frame names the action that led to it.

The data is a fixture. Thread titles, projects and machine names are made up, and project paths point at temporary folders. Do not score the fixture's wording or paths. Do score how the app lays them out, for example how it truncates a long path.

Screens:

{{SCREENS}}

Tasks, with the taps and distinct screens each one took:

{{FLOWS}}

References for the Codex and Claude iOS apps:

{{REFERENCES}}

## How to score

Score each axis from 1 to 10 for each device class. 10 is the best mobile app you know for this kind of work. 7 is solid but clearly behind the best.

Axes:

{{AXES}}

Device classes:

{{DEVICES}}

- **Visual design**: type, color, icons, spacing and hierarchy.
- **Layout quality**: use of the screen, safe areas, the keyboard, folds and rotation, large text.
- **Flow clarity**: how obvious each task is, from the flows and from what each screen offers next.
- **Polish**: alignment, truncation, clipped or overlapping content, empty space, state indicators.
- **Conformance with desktop**: whether this reads as the same product as the desktop app.
- **Quality versus Codex and Claude**: how this compares with the Codex and Claude iOS apps.

Then list the five fixes that would raise the scores most, most important first. Each fix names the screen and device, what is wrong, and the change you would make. Be specific: "the question panel leaves a 120 pt scroll area on the closed Duo; let it take the space above the composer" is useful, "improve spacing" is not.

## Reply format

Write your review in plain prose and short lists. End the reply with exactly one fenced `json` block in this shape, with your numbers and your five fixes:

```json
{{JSON}}
```
