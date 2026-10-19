# Agent Mailbox brand

**Agents that wake each other.**

Agent Mailbox is a local inbox for coding agents. The mark is a single envelope: one message, delivered and waiting. It follows the [lysiu logo design language](https://lysiu.com/logo-design-language.md): one symbol, generous space, shallow relief.

## Identity

The app icon uses a soft white-to-lavender surface (`#FFFFFF` to `#EEEBF8`), an inset lavender outline (`#A997E8` at 55% opacity), and the envelope in a violet gradient (`#8458F0` to `#5D3BC8`) with a lighter flap (`#C3ADFF` to `#9A7CF5`). A diffuse shadow gives the envelope slight depth. Keep the envelope at roughly 43% of the artboard width and optically centred; do not add a flag, a second envelope, arrows, or any text inside the tile.

| Color | Hex | Use |
| --- | --- | --- |
| Violet | `#6E48DC` | Mark, primary accents |
| Ink | `#2A2050` | Headings and body text |
| Lavender | `#EEEBF8` | Soft surfaces |
| Muted | `#6B6388` | Supporting text |
| White | `#FFFFFF` | Surfaces and reverse marks |

## Files

| Asset | Use |
| --- | --- |
| `app-icon.svg` | Canonical editable 1024 × 1024 master |
| `mark.svg` | Monochrome silhouette for single-colour and template contexts (flap edge cut out) |
| `../agent-mailbox.png` | 1024 px raster export of the master, used by the README |

Keep the mark at least 16 pixels wide. Use the monochrome mark where gradients would reduce clarity.

## Regenerating the PNG

The SVG is the source of truth. Export with a renderer that keeps the SVG drop shadow (Inkscape or resvg); ImageMagick's built-in SVG renderer may omit it.

```sh
inkscape assets/brand/app-icon.svg --export-type=png --export-width=1024 --export-filename=assets/agent-mailbox.png
```
