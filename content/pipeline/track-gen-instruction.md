You are generating one kart-racing track as a single JSON object. Output ONLY the
JSON object. No prose, no markdown fence, no trailing commentary.

The input body gives this track's creative brief: its id, name, theme, target
length in metres, and the character it should have. Everything else below is
fixed and identical for every track.

# The exact schema

```
{
  "id": string,
  "name": string,
  "controlPoints": [ { "position": {"x": number, "y": number, "z": number},
                       "width": number, "banking": number,
                       "surface": "tarmac" | "dirt" | "boost" | "offtrack" } ],
  "checkpointS": [ number ],
  "itemBoxes": [ { "s": number, "lateral": number } ],
  "ramps": [ { "sStart": number, "sEnd": number, "launch": number } ],
  "boostPads": [ { "s": number, "lateral": number, "halfWidth": number } ],
  "startPositions": [ { "s": number, "lateral": number } ],
  "bounds": { "min": {"x","y","z"}, "max": {"x","y","z"} }
}
```

No other keys. No key omitted. Every number a JSON number, never a string.

# `s` is a normalised loop parameter in [0, 1), NEVER metres

This is the single rule most likely to be got wrong, so read it twice. `s = 0` is
the start line and `s` wraps back to `0` after `1`. A value like `30` does not
mean "30 metres along the track" — it is out of range and the track is rejected.

To place something N metres along a track of total length L, write `N / L`.
`checkpointS`, `itemBoxes[].s`, `boostPads[].s`, `ramps[].sStart`, `ramps[].sEnd`
and `startPositions[].s` are ALL in [0, 1).

# Geometry

- `controlPoints` is a **closed loop**: the last point connects back to the first.
  Do NOT repeat the first point at the end.
- Between 40 and 80 control points. Space them roughly evenly, 15–35 m apart.
- `position.x` and `position.z` are the ground plane. `position.y` is elevation;
  keep it within ±25 m of 0 and change it gradually — no more than 4 m between
  consecutive points, or karts launch off the geometry.
- No two consecutive control points may be identical.
- `width` is the FULL track width in metres, always positive. Use 14–22 m on
  straights and 16–26 m through corners. Vary it smoothly: no more than 3 m of
  change between consecutive points.
- `banking` is radians, in [-0.35, 0.35]. Bank INTO corners (positive when the
  track turns one way, negative the other) and use 0 on straights.
- `surface` is `"tarmac"` for most of the lap. Use `"dirt"` for a deliberate
  loose-surface section if the brief asks for one. Do not use `"offtrack"` or
  `"boost"` on control points — those are runtime states, not track material.
- The loop must not self-intersect in the xz plane. Keep any two non-adjacent
  control points at least 40 m apart in xz.

# Derived values you must compute yourself

Let `L` be the total length of the closed control polygon: sum the straight-line
distance between each consecutive pair of control points, including the final
point back to the first. Every metres-to-`s` conversion below uses this `L`.

# `checkpointS`

- Between 8 and 16 values, all in [0, 1), **strictly ascending**.
- The first value must be greater than 0 — do not place a checkpoint at exactly 0.
- Spread them roughly evenly around the lap, with one shortly after each major
  corner so a shortcut cannot skip the ring.

# `startPositions` — exactly 8, and the spacing rule is hard

Exactly 8 entries, laid out as a 4-row by 2-column starting grid BEHIND the start
line (that is, at `s` values just under 1.0, ascending toward the line).

Compute a row spacing of 8 metres as `d = 8 / L`. Use these `s` values, in order:

  row 0: `1 - 1*d`   row 1: `1 - 2*d`   row 2: `1 - 3*d`   row 3: `1 - 4*d`

Two karts per row, at `lateral` of `-w4` and `+w4`, where `w4` is one quarter of
the narrowest `width` among the control points nearest the start line. This gives
eight entries: (1-1d, -w4), (1-1d, +w4), (1-2d, -w4), (1-2d, +w4), and so on.

Every pair of start positions must end up at least 1.8 m apart, measured as
`hypot(ds * L, lateralA - lateralB)` where `ds` is the wrapped difference in `s`.
The layout above satisfies this as long as `w4` is at least 1.0 — if a quarter
width is smaller than that, widen the track near the start line instead.

# `lateral` is metres from the centreline, and must stay well inside the track

Positive `lateral` is to the RIGHT of the direction of travel. For every
`itemBoxes[].lateral`, `boostPads[].lateral` and `startPositions[].lateral`, the
absolute value must not exceed HALF the track width at that point — and because
the width is interpolated, keep every one of them within **0.7 x half-width** to
leave margin. With a 16 m width that means |lateral| <= 5.6.

# `itemBoxes`

- Between 12 and 32 of them, in ascending `s`.
- Place them in rows of 3 to 5 across the track at the same `s`, on straights and
  corner exits — never mid-corner and never in the braking zone before a hairpin.
- Keep them at least 20 m of arc away from the start line.

# `ramps`

- Between 0 and 4. `sStart` and `sEnd` both in [0, 1), and `sStart` must be
  strictly less than `sEnd`. Never let a ramp wrap past 1.0.
- Make each ramp 12–30 m of arc long: `sEnd - sStart` around `20 / L`.
- `launch` is upward impulse in m/s, between 4 and 12.
- Put ramps on straights, never inside a corner.

# `boostPads`

- Between 2 and 8. `halfWidth` is the pad's lateral half-extent in metres, 1.5–4.0.
- Place them on corner exits and long straights. Keep `|lateral| + halfWidth`
  within 0.7 x half-track-width at that `s`.

# `bounds`

An axis-aligned box that **encloses every control point** with at least 60 m of
margin on x and z, and at least 30 m on y. Compute it from the control points you
actually generated — do not guess it.

# Before you emit

Check each of these against the numbers you actually wrote:

1. Every `s` value is >= 0 and < 1.
2. `checkpointS` is strictly ascending and its first value is > 0.
3. `startPositions` has exactly 8 entries.
4. Every `lateral` is within 0.7 x half-width at its own `s`.
5. `controlPoints` has 40–80 entries and no two consecutive ones are identical.
6. Every `ramps[i].sStart < ramps[i].sEnd`.
7. `bounds` encloses every control point.
8. The output is one JSON object and nothing else.
