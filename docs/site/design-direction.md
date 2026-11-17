# Public site design direction (v3, 17 Nov 2026)

Feedback on v2 (navy + brass, serif): "looks generic, colour scheme not great, make it user friendly".

## Options considered

**A. Sunrise ledger (chosen).** Warm off-white base `#FBF7F0`, deep green primary `#14532D` (money, trust), sunrise orange
`#F97316` used only for the main call to action and small highlights, charcoal text `#1F2328`. Friendly grotesque display
(Bricolage Grotesque) with a clean sans for text (Plus Jakarta Sans, tabular figures). Signature visual: an example invoice
card that splits into "80% today" and "the rest later", under a sunrise arc that marks the days until the buyer pays.
Rhythm: split hero -> full-width calculator band -> 3 icon steps -> product mock (invoice list + payout notice) ->
green buyer band -> safeguards list -> FAQ.

**B. Market colours.** Terracotta, ochre and kitenge-style patterns. Distinctive and local, but busy, close to cliché,
and ochre/terracotta make AA contrast hard for text and buttons. Weak "money is safe here" signal.

**C. Green field.** Mostly full-bleed deep green with cream type and lime accents. Strong and confident, but heavy and
dark again (the thing Deng disliked), and long green pages tire the eye on phones.

## Why A

- It is light and optimistic, and the sunrise idea comes straight from the name (mapema = early), so it is ours, not a template.
- Green reads as money and trust in Kenya (and is distinct from bank blues and from v2's navy).
- The hero visual explains the product in one look (invoice -> 80% today + balance later), which is the main
  user-friendliness win; the calculator then lets people try their own numbers right away.
- Contrast is easy: green `#14532D` on `#FBF7F0` is 9.6:1; charcoal text 15:1; muted `#57534E` 7.2:1; orange buttons
  carry charcoal text (6.4:1) and orange text uses `#A33A0F` (6.5:1).

## Rules

One primary action per section (suppliers: "Check what you'd get" -> calculator; buyers: "Book a call").
Plain English, short sentences. Body 17px, tap targets >= 48px, sticky mobile CTA, accordion FAQ built on
`<details>` (works without JS). Product mocks are drawn in HTML/CSS, labelled "Example", with no real names,
logos, testimonials or statistics. Legal and CBK wording, placeholders, forms, Swahili switch and noindex are unchanged.
