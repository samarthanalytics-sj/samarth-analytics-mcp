# GTM: Sample Tags for Every Other Tag Type

Version: 1.0
Purpose: one importable, linked reference for the non-GA4 tag types. Google's own tags (Ads, Floodlight, Remarketing, Conversion Linker, the Google Tag) as their real native config, and third-party pixels (Meta, TikTok, LinkedIn, Hotjar, Clarity, Bing, Pinterest) as Custom HTML. Companion to the GA4 100-examples file.

Two files:
- This index. Read it to understand each tag type and find the sample you need.
- `GTM_Other_Tag_Types_Container.json`. A GTM container export with 31 tags, 7 triggers, and 19 variables, all linked. Import to a sandbox to inspect.

## Read before importing

- Sandbox only. This adds 31 tags. Do not import to production.
- Every vendor ID is a placeholder (conversion ID, pixel ID, partner ID, advertiser ID). Replace them in the constant variables before anything works.
- Universal Analytics tags are included for reference only. UA is deprecated and stopped processing data in July 2024. Do not use them for new work.

## Two things that shape this file

1. Google native versus Custom HTML. Google's tags have structured fields you configure. The rest have no native GTM tag type, so they are shown as Custom HTML. In production you should use the gallery template for each (see the mapping near the end), because templates are sandboxed, are faster, and support GTM consent settings. Custom HTML does not.

2. Shared triggers. Only 7 triggers fire all 31 tags. This is the point of the linking: one `purchase` Custom Event trigger fires the Google Ads conversion, the Floodlight tag, the Meta Purchase, the TikTok payment, the Bing event, and the image pixel at once. Open the trigger, then look at how many tags list its id in `firingTriggerId`.

## Consent warning

These samples omit consent settings for clarity. In production, every marketing tag here (Google Ads, Meta, TikTok, Bing, LinkedIn, Pinterest) must be consent-gated. Native and template tags can carry GTM consent settings and respond to Consent Mode. Custom HTML pixels cannot, so they need a consent-check blocking trigger or, better, a gallery template. This is a strong reason to move the Custom HTML pixels to templates.

## How the linking works, expanded

### Google Ads purchase conversion
A native Google Ads tag. It reads the conversion ID from a constant and the order details from data layer variables, and fires on the shared purchase trigger.

Trigger (shared by every purchase tag):
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "triggerId": "2",
  "name": "CE - purchase",
  "type": "CUSTOM_EVENT",
  "customEventFilter": [
    {
      "type": "EQUALS",
      "parameter": [
        {
          "type": "TEMPLATE",
          "key": "arg0",
          "value": "{{_event}}"
        },
        {
          "type": "TEMPLATE",
          "key": "arg1",
          "value": "purchase"
        }
      ]
    }
  ]
}
```
Tag:
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "tagId": "5",
  "name": "Google Ads - Purchase conversion",
  "type": "awct",
  "parameter": [
    {
      "type": "BOOLEAN",
      "key": "enableConversionLinker",
      "value": "true"
    },
    {
      "type": "TEMPLATE",
      "key": "conversionId",
      "value": "{{Google Ads - Conversion ID}}"
    },
    {
      "type": "TEMPLATE",
      "key": "conversionLabel",
      "value": "{{Google Ads - Purchase Label}}"
    },
    {
      "type": "TEMPLATE",
      "key": "conversionValue",
      "value": "{{DLV - value}}"
    },
    {
      "type": "TEMPLATE",
      "key": "currencyCode",
      "value": "{{DLV - currency}}"
    },
    {
      "type": "TEMPLATE",
      "key": "orderId",
      "value": "{{DLV - transaction_id}}"
    },
    {
      "type": "BOOLEAN",
      "key": "enableEnhancedConversion",
      "value": "false"
    }
  ],
  "firingTriggerId": [
    "2"
  ],
  "tagFiringOption": "ONCE_PER_EVENT"
}
```
Constant it links to:
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "variableId": "2",
  "name": "Google Ads - Conversion ID",
  "type": "c",
  "parameter": [
    {
      "type": "TEMPLATE",
      "key": "value",
      "value": "AW-000000000"
    }
  ]
}
```
The `conversionId` and `conversionLabel` come from constants, so you change the ID once. `conversionValue`, `currencyCode`, and `orderId` read data layer variables filled at purchase.

### Meta Pixel: base plus event (Custom HTML)
The base tag loads the pixel once on every page. The event tag assumes the base has loaded and just tracks. This base-plus-event split is how all the Custom HTML pixels work.

Base (all pages):
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "tagId": "16",
  "name": "Meta - Base pixel + PageView",
  "type": "html",
  "parameter": [
    {
      "type": "TEMPLATE",
      "key": "html",
      "value": "<script>\n!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?\nn.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;\nn.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;\nt.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,\ndocument,'script','https://connect.facebook.net/en_US/fbevents.js');\nfbq('init','{{Meta Pixel ID}}');\nfbq('track','PageView');\n</script>"
    },
    {
      "type": "BOOLEAN",
      "key": "supportDocumentWrite",
      "value": "false"
    }
  ],
  "firingTriggerId": [
    "2147479553"
  ],
  "tagFiringOption": "ONCE_PER_LOAD"
}
```
Purchase event (shared purchase trigger):
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "tagId": "17",
  "name": "Meta - Purchase event",
  "type": "html",
  "parameter": [
    {
      "type": "TEMPLATE",
      "key": "html",
      "value": "<script>\nfbq('track','Purchase',{value:{{DLV - value}},currency:'{{DLV - currency}}',content_ids:{{DLV - content_ids}},content_type:'product'});\n</script>"
    },
    {
      "type": "BOOLEAN",
      "key": "supportDocumentWrite",
      "value": "false"
    }
  ],
  "firingTriggerId": [
    "2"
  ],
  "tagFiringOption": "ONCE_PER_EVENT"
}
```
The pixel ID comes from the `{{Meta Pixel ID}}` constant inside the script. The event reads `{{DLV - value}}`, `{{DLV - currency}}`, and `{{DLV - content_ids}}`. GTM substitutes those variables into the HTML before it runs.

## The 31 samples

### Google Tag (config) (3)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 1 | Google Tag - GA4 config | Google Tag | All Pages | all pages | tagId={{GA4 - Measurement ID}} | constants only |
| 2 | Google Tag - GA4 config (no auto page_view) | Google Tag | All Pages | all pages | send_page_view=false (for SPAs) | constants only |
| 3 | Google Tag - Google Ads config | Google Tag | All Pages | all pages | tagId={{Google Ads - Conversion ID}} | constants only |

### Conversion Linker (1)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 4 | Conversion Linker | Conversion Linker | All Pages | all pages | stores gclid in first-party cookies | constants only |

### Google Ads Conversion (4)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 5 | Google Ads - Purchase conversion | Google Ads Conversion | Custom Event | event = purchase | value/currency/orderId from data layer | DLV - value, DLV - currency, DLV - transaction_id |
| 6 | Google Ads - Lead conversion | Google Ads Conversion | Custom Event | event = form_submit | no value; fires on form_submit | constants only |
| 7 | Google Ads - Page-based conversion | Google Ads Conversion | Page View | Page Path equals /thank-you | fires on /thank-you page view | constants only |
| 8 | Google Ads - Purchase with Enhanced Conversions | Google Ads Conversion | Custom Event | event = purchase | enhanced conversions on; needs user-provided data | DLV - value, DLV - currency |

### Google Ads Call Conversion (1)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 9 | Google Ads - Call conversion | Google Ads Call Conversion | Click - Just Links | Click URL starts with tel: | fires on tel: click | constants only |

### Google Ads Remarketing (2)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 10 | Google Ads - Remarketing (basic) | Google Ads Remarketing | All Pages | all pages | builds audiences on all pages | constants only |
| 11 | Google Ads - Dynamic remarketing | Google Ads Remarketing | All Pages | all pages | sends product IDs, page type, value | DLV - content_ids, DLV - page_type, DLV - value |

### Floodlight (2)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 12 | Floodlight - Counter (all pages) | Floodlight Counter | All Pages | all pages | group/activity tags; standard ordinal | constants only |
| 13 | Floodlight - Counter on purchase | Floodlight Counter | Custom Event | event = purchase | per-session ordinal for conversions | constants only |

### Universal Analytics (LEGACY) (2)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 14 | UA - Pageview (LEGACY) | Universal Analytics | All Pages | all pages | DEPRECATED. Reference only. | GA - UA Settings |
| 15 | UA - Event (LEGACY) | Universal Analytics | Click - Just Links | Click URL does not contain example.com | DEPRECATED. Reference only. | GA - UA Settings |

### Meta Pixel (Custom HTML) (4)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 16 | Meta - Base pixel + PageView | Custom HTML | All Pages | all pages | fbq init + PageView | Meta Pixel ID |
| 17 | Meta - Purchase event | Custom HTML | Custom Event | event = purchase | fbq('track','Purchase') | DLV - value, DLV - currency, DLV - content_ids |
| 18 | Meta - Lead event | Custom HTML | Custom Event | event = form_submit | fbq('track','Lead') | constants only |
| 19 | Meta - AddToCart event | Custom HTML | Custom Event | event = add_to_cart | fbq('track','AddToCart') | DLV - content_ids |

### TikTok Pixel (Custom HTML) (2)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 20 | TikTok - Base pixel | Custom HTML | All Pages | all pages | ttq load + page | TikTok Pixel ID |
| 21 | TikTok - CompletePayment | Custom HTML | Custom Event | event = purchase | ttq.track('CompletePayment') | DLV - value, DLV - currency |

### Microsoft Ads UET (Custom HTML) (2)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 22 | Bing UET - Base tag | Custom HTML | All Pages | all pages | UET init + pageLoad | Bing UET Tag ID |
| 23 | Bing UET - Purchase event | Custom HTML | Custom Event | event = purchase | uetq.push('event','purchase') | DLV - value, DLV - currency |

### LinkedIn Insight (Custom HTML) (1)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 24 | LinkedIn - Insight base tag | Custom HTML | All Pages | all pages | partner id + insight loader | LinkedIn Partner ID |

### Hotjar (Custom HTML) (1)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 25 | Hotjar - Tracking code | Custom HTML | All Pages | all pages | hj init | Hotjar Site ID |

### Microsoft Clarity (Custom HTML) (1)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 26 | Clarity - Tracking code | Custom HTML | All Pages | all pages | clarity init | Clarity Project ID |

### Pinterest (Custom HTML) (1)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 27 | Pinterest - Base tag | Custom HTML | All Pages | all pages | pintrk load + page | Pinterest Tag ID |

### Generic Custom HTML (3)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 28 | Custom HTML - Third-party conversion pixel | Custom HTML | Custom Event | event = purchase | injects an image beacon on purchase | DLV - transaction_id, DLV - value |
| 29 | Custom HTML - dataLayer helper | Custom HTML | All Pages | all pages | pushes a computed page_section | constants only |
| 30 | Custom HTML - Beacon on click | Custom HTML | Click - All Elements | Click Classes contains btn-primary | sendBeacon on CTA click | Click Text (built-in) |

### Custom Image (1)

| # | Example | Tag type | Trigger | Condition | Key config | Variables |
|---|---|---|---|---|---|---|
| 31 | Custom Image - Tracking pixel | Custom Image | Custom Event | event = purchase | img beacon with URL params | DLV - value, DLV - transaction_id |

## Use the gallery template in production

The Custom HTML pixels above are for portability and learning. For a real container, replace each with its sandboxed template from the GTM gallery.

| Vendor | Shown here as | Use in production |
|---|---|---|
| Meta / Facebook | Custom HTML (fbq) | Facebook Pixel template (community) or server-side CAPI |
| TikTok | Custom HTML (ttq) | TikTok Pixel template |
| Microsoft Ads | Custom HTML (UET) | Microsoft Advertising UET template |
| LinkedIn | Custom HTML | LinkedIn Insight Tag template |
| Hotjar | Custom HTML | Hotjar template |
| Microsoft Clarity | Custom HTML | Microsoft Clarity template |
| Pinterest | Custom HTML | Pinterest Tag template |

## Variables created (19)

| Variable | Type | Holds |
|---|---|---|
| GA4 - Measurement ID | Constant | Your G- ID |
| Google Ads - Conversion ID | Constant | Your AW- ID |
| Google Ads - Purchase Label | Constant | Purchase conversion label |
| Google Ads - Lead Label | Constant | Lead conversion label |
| Google Ads - Call Label | Constant | Call conversion label |
| Floodlight - Advertiser ID | Constant | Floodlight advertiser ID |
| Meta Pixel ID | Constant | Meta pixel ID |
| TikTok Pixel ID | Constant | TikTok pixel ID |
| LinkedIn Partner ID | Constant | LinkedIn partner ID |
| Hotjar Site ID | Constant | Hotjar site ID |
| Clarity Project ID | Constant | Clarity project ID |
| Bing UET Tag ID | Constant | Bing UET tag ID |
| Pinterest Tag ID | Constant | Pinterest tag ID |
| GA - UA Settings | GA Settings (UA, legacy) | Legacy UA property (reference only) |
| DLV - value | Data Layer Variable | Order value from data layer |
| DLV - currency | Data Layer Variable | Currency from data layer |
| DLV - transaction_id | Data Layer Variable | Order ID from data layer |
| DLV - content_ids | Data Layer Variable | Product IDs from data layer |
| DLV - page_type | Data Layer Variable | Page type for dynamic remarketing |

## Tag types covered

Google Tag config (googtag), Conversion Linker (gclidw), Google Ads Conversion (awct), Google Ads Call Conversion (awcc), Google Ads Remarketing (sp), Floodlight Counter (flc), Universal Analytics (ua, legacy), Custom HTML (html), and Custom Image (img). The Custom HTML samples stand in for Meta, TikTok, Microsoft Ads UET, LinkedIn, Hotjar, Clarity, and Pinterest.