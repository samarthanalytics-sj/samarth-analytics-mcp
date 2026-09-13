<!--
Canonical reference for how GTM web containers work and the expert decisions behind tag/trigger/variable
creation. The key decision rules here are distilled into the chat brain's system prompt as
GTM_DECISION_RULES (+ GTM_CREATION_METHODOLOGY / GTM_TRIGGER_VARIABLE_REFERENCE) in
apps/desktop/src/shared/gtm-methodology.ts. Per Appendix B, this file is the reference; the system
prompt stays a distilled subset rather than the whole guide.
-->

# Google Tag Manager: A Practical Understanding Guide

Version: 2.0

Purpose: understand how GTM web containers actually work, and learn the decisions an expert makes: which trigger to use, which variable to read, when to match with equals versus contains, when to use page path versus page URL, and how click, form, and ecommerce tracking are built.

How to read this: sections 1 and 2 give the mental model. Read them first. Everything after is a decision reference. Section 8 has the practical playbooks for click, form, and ecommerce. Section 9 lists the mistakes to catch.

## Contents

1. The mental model
2. The one fork that explains everything: data layer versus auto-event
3. Trigger types: what each listens for and when to use it
4. Trigger conditions: equals, contains, regex, and how filters combine
5. What to match on: page path versus page URL, and click and form fields
6. Variable types: what each does and when to use it
7. Tag types: what each sends, its key parameters, its expected trigger
8. Event tracking by use case: click, form, ecommerce
9. Common mistakes to catch
10. Appendix A: type-code reference
11. Appendix B: optional system prompt for LLM use

---

## 1. The mental model

GTM has three building blocks. The whole system is these three and how they point at each other.

- Variable: a named value, resolved at runtime. Examples: the current page path, a cookie, a value read from the data layer, a constant, the output of custom JavaScript.
- Trigger: a rule that decides WHEN a tag can fire. It listens for an event and applies conditions.
- Tag: the action that runs. It sends data to GA4, Google Ads, a pixel, or executes code. A tag does nothing until a trigger fires it.

How they connect:

```
Trigger  --(fires)-->  Tag  --(reads)-->  Variable
   ^                     ^                    ^
   |  conditions use     |  parameters use    |
   +---------------------+--------------------+
              {{Variable Name}} references
```

Read it as: variables are the inputs, triggers are the gate, tags are the action. Both trigger conditions and tag parameters reference variables by name with the {{...}} syntax.

Two rules to hold from the start:

- A tag with no firing trigger never runs.
- A {{Variable Name}} reference only works if a variable or built-in with that exact name exists.

---

## 2. The one fork that explains everything: data layer versus auto-event

GTM finds out an event happened in one of two ways. Which one you use decides your trigger, your variables, and how reliable the tracking is.

### Path A: the data layer

The website pushes a structured message:

```javascript
dataLayer.push({
  event: 'form_submit',
  form_id: 'newsletter',
  form_name: 'Footer Newsletter'
});
```

You catch it with a Custom Event trigger that matches the event name, and you read the extra fields (form_id, form_name) with Data Layer Variables.

Use this when: the value or event is available in the data layer, or a developer can add it. This is the reliable path. The data is intentional, structured, and stable across design changes.

### Path B: auto-event listeners

GTM watches the page itself. When a user clicks, submits a form, scrolls, or plays a video, GTM pushes its own internal event (gtm.click, gtm.formSubmit, gtm.scrollDepth, and so on). You catch these with the matching built-in trigger types (Click, Form Submission, Scroll Depth), and you read details with Click and Form built-in variables or by scraping the DOM.

Use this when: there is no data layer and you cannot get one added, and the interaction is a standard click or scroll that GTM can observe.

### Why this matters

The same goal is built two different ways depending on the path:

| Goal | Data layer path | Auto-event path |
|---|---|---|
| Track a form submit | Custom Event on `form_submit`, read `{{DLV - form_id}}` | Form Submission trigger, read `{{Form ID}}` or scrape DOM |
| Track a button click | Custom Event on a pushed `cta_click` | Click trigger with a condition on `{{Click Text}}` or `{{Click ID}}` |
| Ecommerce | Custom Event on `purchase`, read `{{DLV - ecommerce.items}}` | Not possible reliably. Ecommerce needs a data layer. |

Prefer the data layer. Auto-event listeners are convenient but fragile: they break on AJAX forms, single-page apps, framework-generated class names, and any redesign that changes the markup. Use them as a fallback, not a default.

Everything in the sections below assumes you know which path you are on.

---

## 3. Trigger types: what each listens for and when to use it

### The page load lifecycle

Five triggers fire in order as a page loads. Pick based on how early you need to run.

| Trigger | Internal event | Fires | Use when |
|---|---|---|---|
| Consent Initialization | gtm.init_consent | First, before anything | Only for setting consent defaults. Nothing else. |
| Initialization | gtm.init | After consent, before page view | Something must run before all other tags. |
| Page View | gtm.js | Standard page load point | Default for config tags and most page-load tags. |
| DOM Ready | gtm.dom | HTML parsed, DOM available | You need to read an element from the page. |
| Window Loaded | gtm.load | All resources loaded | You need images, or a third-party script to have settled. |

Rule: use Page View unless you have a specific reason to go earlier or later. Reading DOM elements needs DOM Ready or later, because the element must exist when the variable is read.

### Interaction triggers

| Trigger | Listens for | Use when | Watch out for |
|---|---|---|---|
| Click - All Elements | A click on any element | Buttons, divs, spans, icons | Noisy. Always add a condition so it does not fire on every click. |
| Click - Just Links | A click on an `<a>` link | Links, especially outbound and downloads | Has a "wait for tags" option that delays navigation so the tag fires first. Turn it on for links that leave the site. Misses links whose navigation is driven by JavaScript. |
| Form Submission | A native form submit | Simple HTML forms that do a real submit | Fails on AJAX forms, forms with JavaScript validation that stops the default submit, and single-page apps. See section 8.2. |
| Element Visibility | An element entering the viewport | Thank-you messages with no redirect, lazy-loaded content, impression tracking, a component appearing in a single-page app | Configure the on-screen ratio and whether it fires once or every time. |
| Scroll Depth | Reaching a scroll percentage or pixel | Content engagement, article read depth | Set thresholds deliberately. Firing at 10, 25, 50, 75, 90 is common but sends a lot of events. |
| YouTube Video | Play, pause, progress, complete on an embedded YouTube player | Video engagement | Only works for YouTube iframe embeds with the JS API enabled. |
| History Change | The URL history changing without a full page load | Single-page app route changes | This is how you get "page views" in a React or Vue app. Pair it with a config or event tag. |
| Timer | A time interval passing | Time on page thresholds, delayed actions | Fires repeatedly unless you limit it. |
| Custom Event | A named data layer event | The data layer path for anything: clicks, forms, ecommerce, custom interactions | The event name is matched in customEventFilter, not the normal filter. |
| Trigger Group | A set of other triggers all having fired | A tag should only fire after several conditions have each been met | Order-independent. All members must have fired at least once. |

Decision shortcut:

- Value or event is in the data layer, use Custom Event.
- Standard click and no data layer, use Click - Just Links for links, Click - All Elements for everything else, with a condition.
- Form and no data layer, try Form Submission, but expect to fall back to Element Visibility on the success message or a developer-pushed event.
- Single-page app navigation, use History Change.

---

## 4. Trigger conditions: equals, contains, regex, and how filters combine

### How filters combine

A trigger's conditions all combine with AND. There is no OR inside one trigger.

- To express OR, use a regex with `a|b|c`, or make two triggers.
- Each condition compares a left side (usually a `{{variable}}`) against a value using an operator, with an optional negate flag that inverts it.

### The operators

| Operator | Meaning | Use when |
|---|---|---|
| equals | Exact match of the whole value | You know the exact value. Page Path equals `/contact`. Form ID equals `newsletter`. |
| contains | The value appears somewhere inside | The target is a substring of a larger dynamic string and you accept partial matching. |
| starts with | Prefix match | Matching a section of a site by its path prefix, like `/blog/`. |
| ends with | Suffix match | Matching a file type or a suffix, like `.pdf`. |
| matches RegEx | Matches a regular expression | You need OR, or a real pattern. Anchor it with `^` and `$`. |
| matches CSS selector | The clicked or submitted element matches a selector | Targeting elements by structure, like `button.primary` or `[data-cta]`. |
| greater / less | Numeric comparison | Scroll depth, timer counts, numeric data layer values. |

### The decision people get wrong: equals versus contains

Default to equals. Reach for contains only when you have a reason.

- equals is precise. Page Path equals `/blog` matches only `/blog`.
- contains is loose and creates false positives. Page Path contains `/blog` also matches `/blog-archive`, `/not-a-blog`, and `/blogger-outreach`. The tag fires on pages you did not intend.

If you need "the section starting at /blog", use starts with `/blog/`, not contains `/blog`. If you need one exact page, use equals. Use contains only for genuine substring cases, for example a class list that holds many classes and you are checking for one of them.

### When to use regex, and its cost

Regex is powerful and error-prone. Use it when you truly need OR or pattern matching, for example matching several thank-you pages at once:

```
{{Page Path}} matches RegEx  ^/(thank-you|confirmation|success)/?$
```

Costs to accept: it is harder to read, harder to hand over, and easy to get wrong. Always anchor with `^` and `$` so it does not over-match. An unanchored `thank-you` matches `/not-thank-you-page` too.

---

## 5. What to match on: page path versus page URL, and click and form fields

Choosing the operator is half the decision. Choosing the variable you compare against is the other half.

### Page Path versus Page URL versus Page Hostname

| Variable | Returns | Example |
|---|---|---|
| Page Path | The path only | `/products/shoes` |
| Page URL | The whole URL | `https://shop.example.com/products/shoes?color=red#reviews` |
| Page Hostname | The host only | `shop.example.com` |

Decisions:

- Match on Page Path to identify a page. Page Path equals `/contact` is correct.
- Do not use Page URL equals `/contact`. It never matches, because Page URL is the full string, not the path.
- Page URL contains `/contact` works but is loose. It also matches when `/contact` appears in a query parameter, and it matches on any hostname. Use Page Path instead.
- Use Page Hostname to separate environments or domains, for example to stop a tag firing on staging: Page Hostname equals `www.example.com`.
- Use Page URL only when you genuinely need the whole thing: protocol, a query parameter you cannot get another way, or a cross-domain check.

### Matching on a query parameter

Do not do Page URL contains `utm_source=google`. It is fragile and order-dependent. Instead, make a URL variable set to the Query component with the key `utm_source`, then match that variable equals `google`. Cleaner and exact.

### Click conditions: which click variable to match on

When a Click trigger fires, you decide which detail of the clicked element to test.

| Variable | Holds | Match on it when |
|---|---|---|
| Click URL | The link destination | The element is a link and you care where it goes. |
| Click Text | The visible text | You are targeting by label, but know the text can change and breaks in other languages. |
| Click ID | The element id | Best case. Stable and precise if the element has an id. |
| Click Classes | The full class list | You are checking for one class. Use contains here, because the list holds many classes. Fragile if classes are framework-generated and churn. |
| Click Element | The DOM element itself | You want to match with a CSS selector, for example `[data-cta="signup"]`. |

Preference order for stability: a stable id or a `data-` attribute, then Click URL, then Click Text or Click Classes as a last resort. Text and framework classes change often and quietly break your triggers.

### Form conditions

For a Form Submission trigger, the same idea applies. Match on Form ID (best), or Form Classes, or the Form Element with a CSS selector. Often you also add a Page Path condition so the trigger only fires on the page that holds the form.

---

## 6. Variable types: what each does and when to use it

### Getting a value: the reliability ladder

When you need a value, prefer sources in this order. Higher is more reliable.

1. Data Layer Variable. The value is in the data layer because someone put it there on purpose.
2. First Party Cookie, or a global JavaScript value the site sets.
3. DOM Element. Reading text or an attribute off the page. Fragile. Last resort.

### The variable types

| Type | What it does | Use when | Notes |
|---|---|---|---|
| Data Layer Variable (DLV) | Reads a key from the data layer | The value is in the data layer | Use version 2. Set a default value for when the key is missing. Reach nested keys with dots, like `ecommerce.value`. This is the workhorse. |
| Constant | A fixed value | An ID or string is used in many places | Store a measurement ID once as a constant, then reference it everywhere. Change it in one spot. |
| First Party Cookie | Reads a cookie by name | The value lives in a cookie | Reads only the site's own cookies. |
| URL | Parses part of the current URL | You need the host, path, a query parameter, or a fragment | Set the component: HOST, PATH, QUERY with a key, or FRAGMENT. |
| Lookup Table | Maps an input to an output by exact match | You have a fixed set of known values to convert | Country to currency, hostname to environment name. First exact match wins. |
| RegEx Table | Maps an input to an output by regex | The inputs are patterns, not fixed values | URL patterns to a page category. Can output capture groups. More flexible than Lookup, harder to read. |
| Custom JavaScript | A function that returns a value | You need logic, or to combine or transform other variables | Runs every time it is evaluated. Keep it small. Errors here can break tags. |
| JavaScript Variable | Reads a global window property by dotted name | The value is a simple global the site already sets | Reads globals only. Fails if the global is not set yet. |
| DOM Element | Reads text or an attribute from an element | There is no data layer and no other source | Fragile. Breaks when markup changes. Timing matters, so read it on DOM Ready or later. |
| Auto-Event Variable | Details of the element that triggered a click or form event | Inside Click and Form triggers, to read the element's attributes | Only meaningful during an auto-event. |

### Lookup Table versus RegEx Table

- Use Lookup Table when the input is one of a known list. `GB` to `GBP`, `US` to `USD`.
- Use RegEx Table when the input is a pattern. `^/products/` to `Product`, `^/blog/` to `Blog`. The first matching row wins, so order the rows from specific to general.

### DLV versus DOM versus Custom JavaScript

You often need one value and have three ways to get it. Choose in this order:

- DLV if it is in the data layer. Reliable and cheap.
- Custom JavaScript or JavaScript Variable if the value is a global the site sets, or needs a small transformation.
- DOM Element only if there is no other way. It is the source most likely to break silently after a site update.

---

## 7. Tag types: what each sends, its key parameters, its expected trigger

| Tag type (code) | Sends | Key parameters | Expected trigger | Usually reads |
|---|---|---|---|---|
| Google Tag (googtag) | Sets up GA4 or Google Ads and sends the first page view | The measurement or account ID | Page View, once per load | A constant holding the ID |
| GA4 Event (gaawe) | A GA4 event with parameters | eventName, the event parameter table, a link to the config | The trigger for that event: Custom Event, Click, Form | DLVs and click or form variables for the parameters |
| Google Ads Conversion (awct) | A conversion to Google Ads | conversionId, conversionLabel, value, currency, orderId | The conversion trigger: purchase, form submit | Transaction ID, value, currency variables |
| Conversion Linker (gclidw) | Stores ad click IDs in first party cookies for attribution | Almost none | Page View, once per load, on all pages | Nothing. One per container. |
| Google Ads Remarketing (sp) | Builds audiences, and for dynamic remarketing sends product IDs | conversionId, dynamic remarketing fields | Page View and key events | Product or page type variables |
| Floodlight (flc) | A conversion count to Campaign Manager 360 | advertiser, group, activity tags | The conversion trigger | Order and value variables |
| Microsoft Ads UET (baut) | UET page and event data to Microsoft Ads | tag ID, event action and category | Page View and events | Event detail variables |
| Custom template (cvt_...) | A vendor pixel through a sandboxed template | Vendor specific | Varies by vendor | Varies |
| Custom HTML (html) | Whatever HTML or JavaScript you write | The HTML block | Varies | Any variable via {{...}} |

### On Custom HTML

Use a Custom HTML tag only when there is no template for what you need. Prefer a custom template when one exists, because templates are sandboxed, respect consent settings, and are safer and faster. Heavy use of Custom HTML is a warning sign in an audit: it can bypass consent, slow the page, and create security risk.

### The Google Ads pair

A Google Ads Conversion tag needs a Conversion Linker in the same container. The linker captures the click ID on landing and stores it, so the conversion later can be attributed. One linker, firing on all pages, serves every Google Ads conversion tag.

---

## 8. Event tracking by use case

These are the practical playbooks. Each shows the data layer path and the auto-event path.

### 8.1 Click tracking

Goal: record when a user clicks a link or button, with details about what they clicked.

Data layer path:

- Trigger: Custom Event matching the pushed event, for example `cta_click`.
- Tag: GA4 Event, event name `cta_click` or a standard name, with parameters read from the pushed fields.
- Variables: DLVs for the pushed fields, like `{{DLV - cta_label}}`.

Auto-event path:

- Trigger: Click - Just Links for links, or Click - All Elements for buttons, with a condition so it does not fire on every click. For outbound links, condition on Click URL, and turn on wait for tags.
- Tag: GA4 Event, with parameters from click variables.
- Variables: built-in Click URL, Click Text, Click ID.

Common GA4 parameters for clicks: `link_url`, `link_text`, `link_id`, `link_classes`, `click_url`, `click_text`, `cta_label`.

Example condition for outbound links only:

```
{{Click URL}} does not contain  example.com
```

### 8.2 Form tracking

Goal: record a successful form submission.

This is the case that breaks most often, because the native Form Submission trigger only fires on a real browser form submit. Many modern forms submit through JavaScript or AJAX and never trigger it.

Reliability order, best first:

1. A data layer event the form plugin or developer pushes on success, for example `form_submit`, `asc_form_submission`, or `cf7submission`. Catch it with a Custom Event trigger. Most reliable, because it fires on actual success, not on a click.
2. Element Visibility on the thank-you or confirmation message. Use this when the form shows a success state without changing the URL. Point the trigger at the success element's selector.
3. The native Form Submission trigger. Use only for simple HTML forms that do a real submit. Add the checkValidation option so it does not fire on failed validation.

Conditions on form triggers:

- Match Form ID equals the exact id, not contains.
- Often add Page Path equals the page that holds the form, so the trigger is scoped.

Tag: GA4 Event, event name `form_submit` or `generate_lead`, with parameters `form_id`, `form_name`, `form_destination`.

Example, data layer path:

```
Trigger: Custom Event, event name equals  form_submit
Tag: GA4 Event  form_submit,  form_id = {{DLV - form_id}}
```

### 8.3 Ecommerce

Goal: track the shopping funnel, from viewing a product to purchase.

Ecommerce needs a data layer. There is no reliable auto-event way to capture the product and order details. The site must push an `ecommerce` object with an `items` array.

The standard GA4 events, in funnel order: `view_item_list`, `select_item`, `view_item`, `add_to_cart`, `remove_from_cart`, `view_cart`, `begin_checkout`, `add_shipping_info`, `add_payment_info`, `purchase`, `refund`.

Example purchase push:

```javascript
dataLayer.push({
  event: 'purchase',
  ecommerce: {
    transaction_id: 'T-12345',
    value: 59.98,
    currency: 'GBP',
    items: [
      { item_id: 'SKU-1', item_name: 'Shoes', price: 29.99, quantity: 2 }
    ]
  }
});
```

Build it like this:

- Trigger: one Custom Event trigger per event name, for example a trigger matching `purchase`.
- Tag: GA4 Event with the matching event name, and the Send Ecommerce Data option turned on so it reads the items from the data layer.
- Variables: a DLV for `ecommerce.items` (or the whole `ecommerce` object), plus DLVs for `value`, `currency`, and `transaction_id` if you need them separately.

Key point: turn on the ecommerce data option on the tag so GA4 reads the `items` array. Without it, the items do not get sent.

### 8.4 Engagement: scroll, video, timer

- Scroll: Scroll Depth trigger at chosen percentages. Tag: GA4 Event `scroll`.
- Video: YouTube Video trigger on progress and complete. Tag: GA4 Event `video_start`, `video_progress`, `video_complete`.
- Time on page: Timer trigger with a limit, or rely on GA4's built-in engagement time.

---

## 9. Common mistakes to catch

An audit or a careful review should look for these.

- contains used where equals was needed. Page Path contains `/blog` firing on `/blog-archive`. Fix with equals or starts with or an anchored regex.
- Page URL used to match a path. Either it never matches (equals) or it matches too much (contains). Use Page Path.
- Query parameter matched with Page URL contains. Use a URL Query variable instead.
- DOM Element scraping where a data layer value exists. Fragile by choice. Switch to a DLV.
- The native Form Submission trigger on an AJAX form. It will not fire. Switch to a data layer event or Element Visibility.
- A tag with no firing trigger. It never runs. Either wire it up or delete it.
- Click Text or framework class names used as the match key. They change and break quietly. Prefer an id or a data attribute.
- Marketing and analytics tags firing with no consent gating in a region that requires consent.
- Hardcoded IDs repeated across many tags. Move them into a constant.
- Heavy use of Custom HTML where a sandboxed template exists.
- Unanchored regex that over-matches, like `thank-you` matching `/not-thank-you`.

---

## Appendix A: type-code reference

GTM stores types as short codes, not names. Translate them.

### Tag type codes

| Code | Meaning |
|---|---|
| googtag | Google Tag (sets up GA4 or Ads) |
| gaawe | GA4 Event |
| awct | Google Ads Conversion Tracking |
| gclidw | Conversion Linker |
| sp | Google Ads Remarketing |
| awcc | Google Ads Call Conversion |
| flc | Floodlight Counter |
| baut | Microsoft / Bing Ads UET |
| bzi | LinkedIn Insight Tag |
| hjtc | Hotjar Tracking Code |
| html | Custom HTML |
| img | Custom Image |
| ua | Universal Analytics (legacy, deprecated) |
| cvt_... | Custom template (gallery or private) |

### Trigger type codes

| Code | Meaning |
|---|---|
| PAGEVIEW | Page View |
| DOM_READY | DOM Ready |
| WINDOW_LOADED | Window Loaded |
| INIT | Initialization |
| CONSENT_INIT | Consent Initialization |
| CLICK | Click - All Elements |
| LINK_CLICK | Click - Just Links |
| FORM_SUBMISSION | Form Submission |
| ELEMENT_VISIBILITY | Element Visibility |
| SCROLL_DEPTH | Scroll Depth |
| YOU_TUBE_VIDEO | YouTube Video |
| HISTORY_CHANGE | History Change |
| TIMER | Timer |
| CUSTOM_EVENT | Custom Event (data layer) |
| TRIGGER_GROUP | Trigger Group |

### Variable type codes

| Code | Meaning |
|---|---|
| v | Data Layer Variable |
| c | Constant |
| k | First Party Cookie |
| u | URL |
| smm | Lookup Table |
| remm | RegEx Table |
| jsm | Custom JavaScript |
| j | JavaScript Variable |
| d | DOM Element |
| aev | Auto-Event Variable |
| gas | Google Analytics Settings (UA, legacy) |
| gtes | Google Tag Event Settings |
| awec | User-Provided Data (Enhanced Conversions) |
| cid | Container ID |

### Filter operator codes

| Code | Meaning |
|---|---|
| EQUALS | equals |
| CONTAINS | contains |
| STARTS_WITH | starts with |
| ENDS_WITH | ends with |
| MATCH_REGEX | matches regex |
| CSS_SELECTOR | matches a CSS selector |
| GREATER, LESS, GREATER_OR_EQUALS, LESS_OR_EQUALS | numeric comparison |

### Parameter value types

| Type | Shape |
|---|---|
| TEMPLATE | A string value, may contain {{...}} |
| BOOLEAN | true or false |
| INTEGER | A number |
| LIST | A list of entries, usually MAP rows. Used for tables. |
| MAP | Key and value pairs. One row of a table, or a nested object. |
| TAG_REFERENCE | A reference to another tag |

Reading rule for tables: a table is a LIST of MAP rows. Walk to the LIST with the right key, then read each MAP's pairs. The pair keys are usually parameter and parameterValue, or name and value, or key and value.

---

## Appendix B: optional system prompt for LLM use

If you feed this guide to a model, keep the system prompt short and let this guide be the reference the model reads. Do not paste the whole guide into the system prompt.

```
You are a GTM assistant. You read and reason about Google Tag Manager web
container exports in JSON.

You understand the object model: variables are values, triggers decide when
tags fire, tags are the actions. You know the key fork: a site either pushes a
data layer, matched with Custom Event triggers and Data Layer Variables, or it
relies on auto-event listeners, matched with Click and Form triggers.

Use the GTM understanding guide as your reference for type codes, the decision
rules (equals versus contains, page path versus page URL), and use-case
patterns. Do not rely on memory for type codes or field shapes.

Rules:
- Prefer equals over contains. Flag contains that risks false positives.
- Match a page by Page Path, not Page URL.
- Prefer a Data Layer Variable over DOM scraping.
- Every tag needs a firing trigger. Every {{Name}} must resolve.
- Never invent a type code. If unsure, say so.
- Output valid JSON that matches the export schema.
```
