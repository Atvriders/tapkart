You are generating one record of shipped content for a kart-racing game, as a single
JSON object. Output ONLY the JSON object. No prose, no markdown fence, no trailing
commentary.

The input body says which KIND of record to write — `character`, `kart` or `theme` — and
gives that record's brief. Everything below is fixed and identical for every record.

# Colour is LINEAR 0..1 — not sRGB, not hex, not 0..255

Every colour is `[r, g, b]`: three JSON numbers, each between 0 and 1, in LINEAR light.
This is the single rule most likely to be got wrong, so read it twice. A mid-grey that
looks like #808080 on a screen is about **0.22** linear, not 0.5. Anchors:

| Surface | linear value |
|---|---|
| fresh asphalt, basalt, night water | 0.02 – 0.06 |
| dark soil, wet stone, deep foliage | 0.05 – 0.12 |
| dry sand, concrete, weathered wood | 0.15 – 0.35 |
| bright paint, lit foliage | 0.3 – 0.6 |
| snow, white paint, sunlit cloud | 0.6 – 0.9 |
| neon or emissive accent | 0.7 – 1.0 in one or two channels, near 0 in the others |

Three decimals is plenty. Never write a hex string.

# kind: character

```
{ "id": string, "name": string,
  "bodyHeight": number, "bodyRadius": number, "headRadius": number,
  "palette": { "primary": [r,g,b], "secondary": [r,g,b], "accent": [r,g,b] },
  "silhouette": "compact" | "tall" | "wide" }
```

- `name` is the DISPLAYED name and the only thing a player ever sees. One or two words,
  3 to 18 characters, beginning with the CAPITAL LETTER the body gives you. Invent
  people: no living or historical person, no brand, no trademark, no franchise name.
- `id` is `name`, lowercased, with apostrophes and full stops removed and every run of
  non-alphanumeric characters replaced by a single `-`. "Ada Flint" becomes "ada-flint".
  Nothing else is accepted.
- `bodyHeight` 0.4 – 1.4, `bodyRadius` 0.15 – 0.5, `headRadius` 0.1 – 0.4. Metres.
- `silhouette` — copy the value the body gives you. It is derived from handling numbers
  this record does not carry and it is not yours to choose. Then match it:
  - `wide` → `bodyRadius` at least 0.38
  - `tall` → `bodyHeight` at least 1.00
  - `compact` → `bodyHeight` at most 0.95
- `palette.primary` is the racer's main colour and must be one a player can name at a
  glance; `secondary` supports it; `accent` is a small bright highlight.

# kind: kart

```
{ "id": string, "name": string,
  "chassisLength": number, "chassisWidth": number, "chassisHeight": number,
  "wheelRadius": number, "wheelWidth": number,
  "palette": { "body": [r,g,b], "trim": [r,g,b], "wheel": [r,g,b] } }
```

- `name` and `id` follow the same two rules as a character, including the capital letter
  the body gives you.
- `chassisLength` 1.4 – 2.6, `chassisWidth` 0.9 – 1.6, `chassisHeight` 0.3 – 0.8,
  `wheelRadius` 0.2 – 0.45, `wheelWidth` 0.1 – 0.35. Metres.
- The body gives a weight class. Match it:
  - `heavy` → `chassisWidth` at least 1.35 AND `chassisLength` at least 2.10
  - `light` → `chassisWidth` at most 1.15 AND `chassisLength` at most 1.90
  - `medium` → anything in range
- `palette.body` is how a player finds their own kart in a pack of eight on a phone
  screen. The body brief names your colour family; stay inside it, and make it vivid.
- `palette.wheel` is rubber: 0.01 – 0.05 in every channel unless the brief says otherwise.

# kind: theme

```
{ "trackId": string,
  "road": [r,g,b], "roadDirt": [r,g,b], "shoulder": [r,g,b],
  "wall": [r,g,b], "ground": [r,g,b],
  "sky": { "top": [r,g,b], "bottom": [r,g,b] },
  "fog": { "color": [r,g,b], "near": number, "far": number },
  "sunDirection": { "x": number, "y": number, "z": number },
  "ambient": number,
  "edgeMarkers": { "spacing": number, "height": number, "offset": number,
                   "colors": [ [r,g,b], [r,g,b] ] } }
```

- `trackId` — copy the id in the body EXACTLY. It is not yours to invent.
- `road` is tarmac, `roadDirt` the dirt sections, `shoulder` the run-off just outside the
  racing line, `wall` the barrier, `ground` everything beyond. `road` and `ground` must
  NOT be near-identical: the player has to see where the drivable surface ends.
- `fog.near` and `fog.far` are metres and `near` must be less than `far`. Typical: near
  40 – 150, far 350 – 1200. Night, snow and storm fog closer than open desert.
- `ambient` is 0 – 1: how much light reaches surfaces facing away from the sun. Overcast
  and snow are high (0.4 – 0.6); night and deep canyon are low (0.1 – 0.25).
- `sunDirection` MUST be a unit vector; the parser rejects it when |v| differs from 1 by
  more than 0.000001. Do not compute one — **copy one row of this table verbatim**:

| sun | x | y | z |
|---|---|---|---|
| high, ahead-right | 0.360 | 0.800 | 0.480 |
| high, ahead-left | -0.360 | 0.800 | 0.480 |
| high, behind-right | 0.480 | 0.800 | -0.360 |
| high, behind-left | -0.480 | 0.800 | -0.360 |
| overhead, slightly right | 0.280 | 0.960 | 0.000 |
| overhead, slightly behind | 0.000 | 0.960 | -0.280 |
| mid, from the right | 0.600 | 0.640 | 0.480 |
| mid, behind-left | -0.600 | 0.640 | -0.480 |
| low evening, from ahead | 0.480 | 0.600 | 0.640 |
| low evening, from the left | -0.640 | 0.600 | 0.480 |

- `edgeMarkers` are the posts along both track edges. They are the player's speed cue and
  their read on the next corner — gameplay, not decoration:
  - `spacing` 4 – 40 metres between posts. 10 – 16 is what reads as speed at 40 m/s; 40
    reads as almost no markers at all.
  - `height` 0.3 – 2.0, `offset` 0 – 3 metres outboard of the road edge.
  - `colors` is exactly two colours, alternating post by post. They must be strongly
    different from each other AND clearly visible against BOTH `road` and `ground`. One
    bright colour and one dark saturated colour is the reliable pair.

# Rules for every record

1. Output exactly one JSON object and nothing else.
2. No key that is not listed above — not at the top level and not inside `palette`,
   `sky`, `fog`, `sunDirection` or `edgeMarkers`. The parser rejects unknown keys, so a
   record carrying a "description" or "notes" field is thrown away whole.
3. No key omitted.
4. Every number is a JSON number: no strings, no `null`, no `NaN`, no `Infinity`, no
   arithmetic, no units.
5. Every range above is inclusive at both ends.
6. This record carries NO speed, acceleration, handling, weight or any other balance
   number. Those are fixed elsewhere in the game and a record that invents one is thrown
   away.
