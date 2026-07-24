# Cross-platform chat integrations (GTM, GA4, Google Ads)

The desktop chat is single-product by default: a GTM chat has GTM tools, a GA4 chat has GA4 tools,
an Ads chat has Ads tools. **Integrations** let a user optionally connect another platform to the
current chat so a workflow that spans two products finishes in one place.

Everything here is opt-in. With no integration selected, each chat behaves exactly as it did before
the feature existed, down to a byte-identical system prompt.

Source of truth: `apps/desktop/src/shared/chat-integrations.ts` (pure, framework-free, shared by
the renderer chips, the IPC boundary and the chat service).

---

## The integration matrix

| Chat | Can connect | Cannot connect |
| --- | --- | --- |
| **GTM** | GA4, Google Ads | - |
| **GA4** | GTM | Google Ads |
| **Google Ads** | GTM | GA4 |

The asymmetry is deliberate. GTM is the delivery mechanism both data platforms need, so it pairs
with either. GA4 and Google Ads have nothing to hand each other **directly** - what connects them is
a container - so they are never offered to one another. No chat offers itself.

To reach the GA4 <-> Ads seam, connect **both** to a GTM chat (see below).

## Turning it on

Chips sit above the working-context bar in the chat, one per platform the current chat may connect.
Clicking one connects that platform for this chat. The choice is stored per **app account + chat
product** in the renderer, so it survives tab switches and restarts, and switching Google accounts
starts fresh.

Connecting a platform also displays **that platform's own context bar**, because a connected
platform needs a working target (container / property / Ads account) just as much as the primary
one does.

---

## What each connection enables

### GTM + Google Ads

Build a Google Ads conversion tag without copy-pasting ids.

1. `list_google_ads_conversion_actions` on the selected Ads account; **reuse** a matching action.
2. If nothing fits, `create_google_ads_conversion_action` mints one (a **live** Ads write - see
   Safety below). Google assigns the Label on creation; it cannot be chosen.
3. `create_gtm_tracking_tag` with `platform: google_ads_conversion`, passing the action's
   `conversionId` and `conversionLabel` as **literal** values - never `{{variables}}`, never
   invented ones.
4. Guards the model applies: an action with `taggable: false` (offline import, app, store visit,
   Analytics-imported) can never fire from GTM, so its `note` is reported instead of a dead tag; the
   container is checked for an existing tag carrying the same id+label, which would double-count;
   and a missing Conversion Linker (`gclidw`) is offered.

**Example prompts**

- "Create a conversion action for the demo request form and build its GTM tag."
- "Which conversion action should the contact form fire, and is the tag already there?"

### GTM + GA4

Create GA4 events end to end.

1. Resolve the Measurement ID from the **selected** GA4 property via `list_ga4_data_streams` (the
   web stream's `measurementId`). It is never invented, and never assumed from an id already sitting
   in the container.
2. `create_gtm_tracking_tag` with `platform: ga4_event`, that Measurement ID, the event name and a
   trigger.
3. Offered follow-ups: `create_ga4_key_event` when the event should count as a conversion, and
   `create_ga4_custom_dimension` for any event parameter the user wants to **report** on (collected
   is not the same as reportable - this is the most common "why can't I see it in GA4" cause).
4. Verification: `check_gtm_measurement_ids` flags GA4 ids in the container that match no stream the
   user can access (typo, wrong property, another account).
5. Combined output: `analytics_scorecard` and `generate_analytics_report` accept `ga4Property`, so
   one container-plus-property score or report replaces two partial ones.

**Example prompts**

- "Add a newsletter_signup event to the site and make it a key event."
- "Score this container together with the property."

### GTM + Google Ads: per-phone-number call conversions

The fully automated version of "track every phone number on this page separately". Requires the
Google Ads chip in a GTM chat (or the GTM chip in an Ads chat).

1. **Detect.** `detect_page_phone_numbers` scans one or more page URLs and returns every **unique**
   number, merged across pages and normalized to E.164 where possible. It finds both `tel:` links and
   numbers printed as visible text, and reports which is which via `clickable`.
2. **Confirm.** The chat shows the numbers, where each was seen, how many times, and whether it is
   clickable. Nothing has been created at this point.
3. **Plan.** `plan_phone_conversion_tracking` reads the page, the Ads account's existing conversion
   actions and the container's existing tags, then returns a complete per-number plan: reuse an
   action or create one, the exact tag and trigger, whether the tag is already present, and whether a
   Conversion Linker is missing. Still read-only.
4. **Approve.** You review that plan. Then each `create_google_ads_conversion_action` shows its own
   approval card (see Safety below), and each GTM tag lands in the draft workspace.

**Identity and determinism.** A number written `+1 555 123 4567`, `(555) 123-4567` and
`tel:+15551234567` is recognised as one line and gets one action, one tag and one trigger. Names are
derived from the number itself, so a re-scan reuses its own work instead of creating parallel
duplicates, and `tagExists` marks steps already implemented. Two different lines that share a label
("Call us") never collide.

**Trigger scoping.** Each tag fires only for its own number: the trigger is `Click URL contains
tel:<that number>`, not the shared `startsWith tel:` that the generic phone suggestion uses.

**The country is never guessed.** A bare 10-digit number becomes `+1...` only when the same site
carries explicit `+1` evidence. With no evidence it is returned unnormalized with a note, rather than
being wired to a number in the wrong country.

**Text-only numbers.** A number that is not a `tel:` link has no click to fire on, so click-to-call
cannot track it. By default the plan marks it `unsupported` and says why. With
`allowWebsiteCall: true` (only after you agree to number swapping) it plans a `WEBSITE_CALL`
conversion action plus the GTM call-conversion tag: Google replaces the displayed number with a
forwarding number and counts the call itself.

**Example prompts**

- "Scan https://example.com/contact and set up separate Google Ads conversion tracking for every
  phone number."
- "What phone numbers are on these three pages?"

### GTM + GA4 + Ads (both connected)

`audit_google_ads_ga4_link` becomes available: it reports whether the property is linked to the Ads
account (direct vs manager-level vs missing), whether GA4-imported conversion actions still match
current key events, and the classic double-count where a GA4 import and a website tag are both
primary. This audit needs to see **both** sides, so it is unavailable in any other configuration.

**Example prompt:** "Why do conversions differ between GA4 and Google Ads?"

### GA4 chat + GTM

The container tools join the GA4 chat so the tag is built there instead of switching tabs: resolve
this property's Measurement ID, then `create_gtm_tracking_tag` in the working container. The chat
never claims the event is collecting until the container is published and the tag verified.

### Google Ads chat + GTM

The mirror image: after choosing or creating the conversion action, its GTM tag is built here from
the literal Conversion ID and Label, with the same untaggable / double-count / Conversion Linker
guards. A `null` conversionLabel means Google published no snippet, and is reported as such rather
than fabricated.

---

## Safety model

Integrations **add tools, never permissions**. Everything the app already enforced still applies.

**A connected platform grants its workflow, not its administrative surface.** A connected platform
contributes all of its **read** tools plus only the writes listed in `CONNECTED_WRITE_ALLOWLIST`:

| Connected platform | Writes it contributes | Deliberately excluded |
| --- | --- | --- |
| **GTM** | create/update tag, trigger, variable; enable built-in variables; pause/consent; measurement-id and event-parameter edits | every `delete_*` and `delete_unused_*`, workspace/environment administration |
| **GA4** | `create_ga4_key_event`, `create_ga4_custom_dimension`, `create_ga4_custom_metric` | every delete/archive (archiving is irreversible), property and account administration, access bindings, data retention, link management |
| **Google Ads** | `create_google_ads_conversion_action` | anything that moves money or data (campaign status, budgets, negative keywords, the three uploads) and edits to an existing action |

A chat's **own** product is never narrowed by this - the GA4 chat still owns the whole GA4 surface.
The excluded tools are not hidden capabilities; they live in that platform's own chat, where the
prompt, context bar and memory scope belong to it. The system prompt tells the model to say so
rather than attempt a tool it does not have.

**Three approval tiers.** A write falls into exactly one:

| Tier | Behaviour | Applies to |
| --- | --- | --- |
| Auto-apply | No card. The write lands in a **draft** GTM workspace, is never published by the app, and the Revert button covers it. | Every GTM create/edit |
| **Approval card** (`Tool.approval`) | One plain card, no typed word. Args are editable before approving. | `create_google_ads_conversion_action` - additive, but **live** in the ad account and not revertible by this app |
| Destructive card | Two steps, type "delete" to confirm. | Every `delete_*` / `archive_*` |

Unchanged by integrations:

- **GTM writes are draft-only.** They land in a draft workspace and are never published by the app.
- **Deletes still require the two-step card.** The new middle tier only moved a live-account create
  out of auto-apply; it did not relax anything.
- **Read-only sessions stay read-only.** With writes off for the chat, a connected platform
  contributes reads and nothing else.
- **Container-kind scoping still applies.** A server container withholds web-only builders even
  from a connected-GTM chat.
- **The change journal and Revert** now also open for a GA4/Ads chat that writes to a container.

## Context isolation

- Each platform's working target appears in the prompt **only** when the chat covers it: its own
  product, or a platform explicitly connected. An unconnected platform's saved context stays out,
  because it can point at a different client entirely.
- A GA4 chat never sees the Ads account and an Ads chat never sees the property, connected or not -
  the matrix forbids the pairing and the context block refuses it independently.
- Cached read results (the tool-result carry-over) are keyed by account + product + target **and the
  connected platforms and their targets**, so disconnecting a platform, or switching its target,
  never lets stale results inform the next answer.
- Memories are scoped to the clients the chat covers. A connected platform's client counts, because
  connecting it displays its context bar - the target is explicitly chosen for this thread rather
  than inherited from another tab.
- Chip selections are stored per app account + product, so switching Google accounts starts clean.

## Limitations

- **Optional and per-chat.** Integrations are not global settings and are not shared between chats.
- **Google Ads needs a developer token.** If none is wired for the session, the Ads chip is dropped
  before the prompt is built: no Ads workflow text is generated, matching a registry that has no Ads
  tools. Nothing is half-advertised.
- **A connected platform still needs a target.** With no container selected, a connected-GTM chat
  asks (or uses `set_gtm_container`) rather than guessing.
- **No admin surface through a chip.** See the table above; use the platform's own chat.
- **GA4 <-> Ads only through GTM.** They are never offered to each other directly.
- **Config plane only.** Building a tag proves nothing about firing. Runtime evidence comes from the
  GTM tab's tag verification, and the chat never claims collection before publish plus verification.
- **Phone detection is bounded and heuristic.** Up to 10 URLs per call. Visible-text matching is
  deliberately conservative (a country code or grouping punctuation is required; dates, prices,
  percentages and long unpunctuated ids are rejected), so a number written unusually can be missed.
  A page that returns no readable text is reported as such, so "none found" is never presented as
  "none exist".
- **`WEBSITE_CALL` creation depends on the account.** The type is now forwarded to the API and
  dry-run validated first, but Google may still reject it depending on account eligibility. That
  rejection is reported verbatim with nothing written.

## Where the code lives

| Concern | File |
| --- | --- |
| Matrix, labels, hints, write allowlist, availability, prompt builder | `apps/desktop/src/shared/chat-integrations.ts` |
| Phone normalization, merging, naming, plan builder (pure) | `apps/desktop/src/shared/phone-numbers.ts` |
| Phone scanning I/O (drives the browser, reads the DOM) | `apps/desktop/src/main/suggestions/scan-phones.ts` |
| Visible-text capture for text-number detection | `apps/web-audit-mcp/src/agent/tag-suggest/collect.ts` (`textSample`), plus the cheerio and multi drivers |
| Chips, per-account persistence, context bars | `apps/desktop/src/renderer/src/App.tsx` |
| Wire sanitizing | `apps/desktop/src/main/ipc/chat-ipc.ts` |
| Availability gating, prompt composition, context + memory + carry-over scoping | `apps/desktop/src/main/services/chat-service.ts` |
| Tool scoping (the enforcement) | `apps/desktop/src/main/tools/registry.ts` |
| Tests | `apps/desktop/src/shared/__tests__/chat-integrations.test.ts`, `.../tools/__tests__/registry.test.ts`, `.../services/__tests__/chat-prompt.test.ts` |
