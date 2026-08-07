# Feature request: Retoucher

**Status:** proposed · **Priority:** high (proposed as the project's current top priority)
**Mockup:** [`mockups/retoucher-flow.html`](../../mockups/retoucher-flow.html)

## Problem

Generated images are usually 95% right and 5% wrong, and the 5% is always the same
thing: the brand logo, the hang tag, the label text, a badge, a repeating pattern.
The model cannot reproduce it from a text prompt alone.

Today the only recovery is **Reprompt**, which regenerates the whole image. That
rerolls everything the user already liked — the scene, the lighting, the composition —
to fix one small square. Users reroll five times, burn credits, and still end up with
a garbled logo.

## Proposal

Add **Retoucher**: fix one zone of a generated image instead of regenerating all of it,
using a pixel-accurate reference cropped from the product's own base images.

Two pieces:

### 1. Retouch details (parallel to the base images)

Next to the product's base image strip, a second strip of **retouch details**. A retouch
detail is a crop of a base image — the user clicks a base image, drags a box around the
logo / tag / text / design, names it, and saves it. That crop becomes a reusable
reference: "this is exactly what this element looks like."

Details are stored on the product, so they are cut once and reused across every
generation, batch and retouch.

### 2. Retouch a generated image

On the image detail view (next to *Reprompt this image*):

1. User clicks **Retouch**.
2. User crops the zone that needs fixing, directly on the generated image.
3. A small popup opens anchored to that zone, containing:
   - a **text prompt** ("redraw the hang tag with the exact brand logo, keep the fabric texture"),
   - a **retouch image** picker — thumbnails of the product's retouch details, plus a
     *none* option for prompt-only retouches.
4. User clicks **Retouch** → we generate a **new image**.
5. The new image carries the **`retouch`** tag **plus every tag its parent had**, so it
   stays inside the same product, batch and campaign filters.

## Flow

```
base image ──crop──► retouch detail ─────────────┐
                                                 ▼
generated image ──crop zone──► [ prompt + retouch detail ] ──► new image
                                                                 tags: parent tags + `retouch`
                                                                 parent_id: <generated image>
```

## Data model

```
RetouchDetail
  id, product_id, source_image_id
  rect { x, y, w, h }      // 0–1 fractions of the source image, never pixels
  name, thumb_url

RetouchJob
  id, parent_image_id
  zone { x, y, w, h }      // 0–1 fractions of the parent image
  prompt
  detail_id               // nullable — prompt-only retouch is valid
  model, quality

Image (output)
  tags     = parent.tags + ["retouch"]
  parent_id = parent.id
  retouch_depth = parent.retouch_depth + 1
```

Rects are stored as fractions so the same detail works against 1K and 4K outputs
without rescaling.

## Behaviour notes

- The zone is **padded** before it goes to the edit model, so it has context to blend
  the seam; the stored zone stays the user's exact rect (used for the before/after diff).
- Retouches **chain**. A retouched image is a valid parent: `gen_a → gen_a_r1 → gen_a_r2`.
  Apply the `retouch` tag once and track depth in its own field, so filters don't get noisy.
- Keep `parent_id` — it gives before/after comparison and lineage for free.
- Prompt-only retouch (no detail attached) must remain valid.
- The popup anchors under the drawn zone and is clamped inside the image. Below 760px
  it becomes a bottom sheet, so it never covers the zone being retouched.

## Open questions

- Can a retouch attach **more than one** detail (e.g. logo + badge in a single zone)?
- Should details be shared **across products** for a brand — one brand logo, cut once,
  usable on every ASIN?
- Should a retouch that fails visibly offer "retry with a tighter zone" automatically?
- Does the retouched output cost a full generation credit, or a reduced one?
- Auto-detect: can we pre-suggest the zone by matching the retouch detail against the
  generated image, so the user only confirms it? (The mockup fakes this with the
  *Select the hang tag* button.)

## Mockup

`mockups/retoucher-flow.html` — self-contained, no build step, open it in a browser.
It reproduces the current MiniMango Studio product page and image detail view, and
walks the full flow:

1. Crop a retouch detail from a base image (*+ Crop from image*).
2. Open a generated image → **Retouch a zone** → drag the zone.
3. Fill the popup (prompt + retouch image) → **Retouch**.
4. See the before/after, the inherited tags plus `retouch`, and the new image landing
   in the product's generated grid next to its parent.

Generation is simulated; artwork is placeholder SVG standing in for real product photos.
