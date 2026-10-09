# PRODUCT.md — Zulu Assistant Ops Board

## Register
Product (ops dashboard) — with one deliberate brand-grade indulgence: the
phosphor-terminal fiction. Design serves the monitoring task first; the theme is
the reward for looking at it forty times a day.

## Users & purpose
One user: the owner, a solo operator running a fleet of background jobs and
agents on one Mac (launchd jobs, Docker, endpoints, Claude agent sessions). Contexts: glanced at
on a desk monitor between tasks, checked from a phone via Tailscale, possibly
parked full-screen on a spare display. The single job of every screen: **"what
needs me right now, and did everything run?"** — answered in under three
seconds, without reading every card.

## Brand personality
Phosphor CRT ops hardware from an alternate timeline where terminals kept
evolving. Classic Terminal.app "Homebrew" lineage: pure-black surface, `#00ee00`
green ink, Menlo everywhere, glyph+label status chips. Confident, dense,
machine-like, a little theatrical — never cute.

## Anti-references (what this must never become)
- Generic SaaS dashboard: gradients, pastels, rounded-2xl cards, Inter, drop
  shadows on white.
- 2005 skin-culture kitsch: heavy bevels, aggressive scanlines that cost
  legibility, sound effects.
- Any regression of the current look: the established phosphor style is the
  baseline, and changes move forward from it, never back. Depth and motion may
  only *deepen* the phosphor identity.

## Non-negotiables
- Dark theme only. Green text on black is a must.
- Status is never color-alone: glyph + label chips, CVD-safe shape/height
  channels in history strips (dataviz-validated palette in `public/style.css`).
- Motion conveys state (status changes, attention) or theme identity at
  whisper-level opacity; everything honors `prefers-reduced-motion`.
- Zero build step, zero dependencies — vanilla HTML/CSS/JS served by the
  zero-dep Node server. Phone rendering via Tailscale must stay fast.
- Legibility beats theater on every conflict.

## Strategic principles
1. Attention hierarchy is the product: NEEDS ATTENTION row → domain groups →
   detail. Nothing may dilute it.
2. Time is a first-class axis (timeline of past/upcoming slots), not just
   point-in-time status.
3. Every severity escalation must be visible from across the room.
4. The board is glanceable art when healthy, an alarm panel when not.

## Surfaces beyond the board
The phosphor charter extends to the cmux side of the console:
- **`?dock=1`**: the board compacted for the cmux Dock (~360px). Same tokens; only density changes. Healthy cards fold into their domain count, so the attention list and WORK stay above the fold.
- **`phosphor` custom sidebar** (`system/cmux/sidebars/phosphor.js`): black ground and the green scale #28FE14 / #00A600 / #0D5F0D; the other colors are the board's status hues. Every state is glyph + label (◉ RUN · ▲ INPUT · ○ IDLE · ·CX for Codex).
- **No pulse animation:** the sidebar runtime cannot read reduced-motion.
- **Group headers are labels only:** a workspace never hides behind a group name.
- phosphor is attention-first: it opens on ATTENTION (needs input → approval → blocked → unread) with calm one-line folds for everything else ("✓ nothing needs you"). The full roster is one tap away (ALL). It lives in the right sidebar; the left sidebar stays cmux's own.
- Context is a first-class dimension of an agent: every tile and sidebar row shows how full its context window is (glyph + % + bar, amber ≥60, red ≥80). The Dock view surfaces only the warm and hot ones. Right after a compaction, the value is an honest estimate, marked `est`, until the session's next turn.
