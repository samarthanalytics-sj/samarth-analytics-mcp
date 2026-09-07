# Server-side QA runbook

A short, repeatable checklist for signing off server-side (sGTM) work built with
this app: the server-container audit and its Apply-fix flow, and the live GTM
Preview / Meta Events Manager checks that config audits cannot prove.

## Why two passes

The app's `audit_server_container` reads the container CONFIGURATION via the GTM
API: a client claims requests, server tags carry their destination ids, no
silent gaps, CAPI credential/dedup pitfalls. It CANNOT prove that the deployed
tagging host receives traffic, that events actually arrive at a destination, or
that Event Match Quality rose. Those need the live checks in pass 2.

- Pass 1 (config + Apply-fix) runs in the desktop app, offline of the site.
- Pass 2 (runtime) needs a published container, real traffic, and access to
  GTM Preview and Meta Events Manager.

---

## Pass 1: desktop server-audit + Apply-fix (about 3 minutes)

1. Launch the app: `npm --prefix apps/desktop run dev` (or the installed build).
   Sign in to the Google account that owns your GTM.
2. Server tab -> Audit configuration -> pick a SERVER container + workspace ->
   Run audit.
3. To force a fixable finding so there is something to click, in GTM either
   pause one server tag, or set a Test Event Code on a Meta CAPI tag, then
   re-run the audit.
4. Confirm the UI shows:
   - the "N auto-fixable finding(s)" summary line,
   - a per-finding Apply fix button on each non-destructive fixable finding,
   - and, when two or more are fixable, the Apply all N fixes button.
5. Click Apply fix on one finding. It should cycle Applying... -> Applied, then
   the finding drops off after the automatic re-audit. Confirm in GTM that the
   tag actually un-paused / the Test Event Code cleared. It stays a DRAFT until
   you publish.
6. Click Apply all with two or more fixable findings. They apply in order, then
   the view re-audits once.

Report anything that looks off (button placement, wording, the apply-all bar)
so the component can be adjusted.

---

## Pass 2: GTM Preview + Meta Events Manager EMQ (about 10 minutes, needs traffic)

1. In the SERVER container, open Preview, load your site, and trigger a
   conversion (for example a test purchase). Confirm the GA4 relay and the Meta
   CAPI tag fire and that each carries an event_id.
2. Meta Events Manager -> Test Events: paste the server container's test code,
   run the conversion, and confirm the event arrives SERVER-SIDE with em / ph /
   fbp / fbc present (not blank).
3. Dedup: confirm the same conversion's browser Pixel event and the server CAPI
   event share ONE event_id, so Events Manager reports them deduplicated rather
   than double-counted.
4. Data Tag / EMQ: after create_stape_data_pipeline is published and has a day
   of traffic, check Events Manager -> your dataset -> Event Match Quality. It
   should tick up versus before the enrichment.
5. Clear the Test Event Code before go-live. The audit's Apply fix in pass 1
   does exactly this.

---

## Related tools

- `audit_server_container` - the config audit driving pass 1.
- `verify_server_endpoint` - GET <serverUrl>/healthy to confirm the host is
  deployed and reachable.
- `create_stape_data_pipeline` - the Data Tag -> Data Client enrichment that
  raises Meta EMQ (pass 2, step 4).
- `create_meta_capi_server_tag` (and the Snapchat / Microsoft variants) - build
  the CAPI tag with mapEmqVariables on so user_data resolves from the enriched
  event.
