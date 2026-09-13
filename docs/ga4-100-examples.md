# GA4 in GTM: 100 Linked Examples

Version: 1.0
Purpose: a reference library of 100 GA4 tracking setups, each a tag, its trigger, and the variables it uses, wired together correctly. Use it to learn how conditions change the trigger and how tags, triggers, and variables link.

Two files:
- This index. Read it to understand each example and to find the one you need.
- `GA4_100_Examples_Container.json`. A real GTM container export with all 101 tags, 100 triggers, and 17 variables. Import it to click through the live links.

## How to import (read the warning first)

Warning: import into an empty sandbox container only. This adds 101 tags. Do not import into a live production container.

Steps: GTM > Admin > Import Container > choose the JSON > pick a new workspace > choose Overwrite (in the sandbox) > confirm. Then open any GA4 event tag and follow its firing trigger and its `{{variable}}` references.

Note: the measurement ID is a placeholder `G-XXXXXXXXXX` held in the constant variable `GA4 - Measurement ID`. Set your real ID there once and every tag inherits it.

## How the linking works

Every example follows the same three-way link:

1. The trigger decides when to fire, using conditions on variables.
2. The tag lists that trigger in its `firingTriggerId`, so the trigger fires the tag.
3. The tag reads variables through `{{Variable Name}}` references in its parameters.

Here is one example fully expanded, an outbound link click. Watch the three IDs that connect the pieces.

Trigger (fires on a link click that leaves the site):
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "triggerId": "10",
  "name": "Click - Outbound",
  "type": "LINK_CLICK",
  "waitForTags": {
    "type": "BOOLEAN",
    "value": "true"
  },
  "checkValidation": {
    "type": "BOOLEAN",
    "value": "false"
  },
  "waitForTagsTimeout": {
    "type": "TEMPLATE",
    "value": "2000"
  },
  "uniqueTriggerId": {
    "type": "TEMPLATE",
    "value": "10"
  },
  "filter": [
    {
      "type": "CONTAINS",
      "parameter": [
        {
          "type": "TEMPLATE",
          "key": "arg0",
          "value": "{{Click URL}}"
        },
        {
          "type": "TEMPLATE",
          "key": "arg1",
          "value": "example.com"
        },
        {
          "type": "BOOLEAN",
          "key": "negate",
          "value": "true"
        }
      ]
    },
    {
      "type": "MATCH_REGEX",
      "parameter": [
        {
          "type": "TEMPLATE",
          "key": "arg0",
          "value": "{{Click URL}}"
        },
        {
          "type": "TEMPLATE",
          "key": "arg1",
          "value": "mailto:|tel:"
        },
        {
          "type": "BOOLEAN",
          "key": "negate",
          "value": "true"
        }
      ]
    }
  ]
}
```
This trigger uses two conditions combined with AND, both negated: the click URL does not contain your own domain, and does not start with mailto or tel. That is how you isolate true outbound links.

Tag (sends the GA4 event, and points back at the trigger by its id):
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "tagId": "10",
  "name": "GA4 - Outbound link click",
  "type": "gaawe",
  "parameter": [
    {
      "type": "BOOLEAN",
      "key": "sendEcommerceData",
      "value": "false"
    },
    {
      "type": "LIST",
      "key": "eventSettingsTable",
      "list": [
        {
          "type": "MAP",
          "map": [
            {
              "type": "TEMPLATE",
              "key": "parameter",
              "value": "link_url"
            },
            {
              "type": "TEMPLATE",
              "key": "parameterValue",
              "value": "{{Click URL}}"
            }
          ]
        },
        {
          "type": "MAP",
          "map": [
            {
              "type": "TEMPLATE",
              "key": "parameter",
              "value": "link_text"
            },
            {
              "type": "TEMPLATE",
              "key": "parameterValue",
              "value": "{{Click Text}}"
            }
          ]
        }
      ]
    },
    {
      "type": "TEMPLATE",
      "key": "eventName",
      "value": "click"
    },
    {
      "type": "TEMPLATE",
      "key": "measurementIdOverride",
      "value": "{{GA4 - Measurement ID}}"
    }
  ],
  "firingTriggerId": [
    "10"
  ],
  "tagFiringOption": "ONCE_PER_EVENT"
}
```
The `firingTriggerId` holds the trigger id above. The parameters read the built-in `{{Click URL}}` and `{{Click Text}}`, and `measurementIdOverride` links to the variable below.

Variable (the shared measurement ID every tag links to):
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "variableId": "1",
  "name": "GA4 - Measurement ID",
  "type": "c",
  "parameter": [
    {
      "type": "TEMPLATE",
      "key": "value",
      "value": "G-XXXXXXXXXX"
    }
  ]
}
```

### A data layer form example

When the site pushes a `form_submit` event, you catch it with a Custom Event trigger and read the pushed `form_id` with a Data Layer Variable.

```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "triggerId": "38",
  "name": "CE - form_submit",
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
          "value": "form_submit"
        }
      ]
    }
  ]
}
```
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "tagId": "38",
  "name": "GA4 - Contact form (data layer)",
  "type": "gaawe",
  "parameter": [
    {
      "type": "BOOLEAN",
      "key": "sendEcommerceData",
      "value": "false"
    },
    {
      "type": "LIST",
      "key": "eventSettingsTable",
      "list": [
        {
          "type": "MAP",
          "map": [
            {
              "type": "TEMPLATE",
              "key": "parameter",
              "value": "form_id"
            },
            {
              "type": "TEMPLATE",
              "key": "parameterValue",
              "value": "{{DLV - form_id}}"
            }
          ]
        }
      ]
    },
    {
      "type": "TEMPLATE",
      "key": "eventName",
      "value": "generate_lead"
    },
    {
      "type": "TEMPLATE",
      "key": "measurementIdOverride",
      "value": "{{GA4 - Measurement ID}}"
    }
  ],
  "firingTriggerId": [
    "38"
  ],
  "tagFiringOption": "ONCE_PER_EVENT"
}
```
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "variableId": "6",
  "name": "DLV - form_id",
  "type": "v",
  "parameter": [
    {
      "type": "INTEGER",
      "key": "dataLayerVersion",
      "value": "2"
    },
    {
      "type": "BOOLEAN",
      "key": "setDefaultValue",
      "value": "true"
    },
    {
      "type": "TEMPLATE",
      "key": "name",
      "value": "form_id"
    },
    {
      "type": "TEMPLATE",
      "key": "defaultValue",
      "value": "(not set)"
    }
  ]
}
```
The event name is matched in `customEventFilter`, not the normal filter. The tag reads `{{DLV - form_id}}`, which reads `form_id` from the data layer.

### An ecommerce example

Ecommerce events turn on `sendEcommerceData`, which makes the tag read the `items` array from the data layer. No item variable is needed.

```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "triggerId": "57",
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
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "tagId": "57",
  "name": "GA4 - Purchase",
  "type": "gaawe",
  "parameter": [
    {
      "type": "BOOLEAN",
      "key": "sendEcommerceData",
      "value": "true"
    },
    {
      "type": "TEMPLATE",
      "key": "getEcommerceDataFrom",
      "value": "dataLayer"
    },
    {
      "type": "TEMPLATE",
      "key": "eventName",
      "value": "purchase"
    },
    {
      "type": "TEMPLATE",
      "key": "measurementIdOverride",
      "value": "{{GA4 - Measurement ID}}"
    }
  ],
  "firingTriggerId": [
    "57"
  ],
  "tagFiringOption": "ONCE_PER_EVENT"
}
```

### A conditional example with a cookie

This fires only when a members-only element is clicked and the user_type cookie equals member. Two conditions, one on the clicked element, one on a cookie variable.

```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "triggerId": "95",
  "name": "Click - Premium feature",
  "type": "CLICK",
  "filter": [
    {
      "type": "CSS_SELECTOR",
      "parameter": [
        {
          "type": "TEMPLATE",
          "key": "arg0",
          "value": "{{Click Element}}"
        },
        {
          "type": "TEMPLATE",
          "key": "arg1",
          "value": ".premium-feature"
        }
      ]
    },
    {
      "type": "EQUALS",
      "parameter": [
        {
          "type": "TEMPLATE",
          "key": "arg0",
          "value": "{{Cookie - user_type}}"
        },
        {
          "type": "TEMPLATE",
          "key": "arg1",
          "value": "member"
        }
      ]
    }
  ]
}
```
```json
{
  "accountId": "000000000",
  "containerId": "00000000",
  "tagId": "95",
  "name": "GA4 - Premium click (members only)",
  "type": "gaawe",
  "parameter": [
    {
      "type": "BOOLEAN",
      "key": "sendEcommerceData",
      "value": "false"
    },
    {
      "type": "TEMPLATE",
      "key": "eventName",
      "value": "premium_click"
    },
    {
      "type": "TEMPLATE",
      "key": "measurementIdOverride",
      "value": "{{GA4 - Measurement ID}}"
    }
  ],
  "firingTriggerId": [
    "95"
  ],
  "tagFiringOption": "ONCE_PER_EVENT"
}
```

## The 100 examples

Grouped by category. Condition is the plain-language version of the trigger's rule. Variables lists the custom variables used, or notes that only built-ins are needed.

### Page & navigation (8)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 1 | Virtual pageview (SPA push) | Custom Event | event = virtualPageview | DLV - page_path | `page_view` | page_path={{DLV - page_path}} |
| 2 | SPA route change | History Change | SPA route change | built-ins only | `page_view` | page_location={{Page URL}} |
| 3 | Blog section view | Page View | Page Path starts with /blog/ | RegEx - Page Category | `content_group_view` | content_group={{RegEx - Page Category}} |
| 4 | Thank-you page view | Page View | Page Path equals /thank-you | built-ins only | `conversion_page_view` | - |
| 5 | Pricing page view | Page View | Page Path equals /pricing | built-ins only | `pricing_view` | - |
| 6 | Multiple landing pages | Page View | Page Path matches regex ^/(lp1\|lp2\|lp3)$ | built-ins only | `landing_view` | - |
| 7 | 404 page (by title) | Page View | JS - Page Title contains 404 | JS - Page Title | `page_not_found` | page_location={{Page URL}} |
| 8 | Pageview blocked on staging | All Pages | all pages | built-ins (blocking trigger) | `page_view_prod` | - |

### Outbound & link clicks (12)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 9 | Outbound link click | Click - Just Links | Click URL does not contain example.com AND Click URL does not match regex mailto:\|tel: | built-ins only | `click` | link_url={{Click URL}}, link_text={{Click Text}} |
| 10 | Email link (mailto) | Click - Just Links | Click URL starts with mailto: | built-ins only | `contact_email` | - |
| 11 | Phone link (tel) | Click - Just Links | Click URL starts with tel: | built-ins only | `contact_phone` | - |
| 12 | WhatsApp click | Click - Just Links | Click URL contains wa.me | built-ins only | `whatsapp_click` | - |
| 13 | PDF download | Click - Just Links | Click URL ends with .pdf | CJS - File Name from URL | `file_download` | file_extension=pdf, file_name={{CJS - File Name from URL}} |
| 14 | File download (multi type) | Click - Just Links | Click URL matches regex \.(pdf\|docx?\|xlsx?\|zip)$ | CJS - File Name from URL | `file_download` | file_name={{CJS - File Name from URL}} |
| 15 | Facebook social click | Click - Just Links | Click URL contains facebook.com | built-ins only | `social_click` | social_network=facebook |
| 16 | LinkedIn social click | Click - Just Links | Click URL contains linkedin.com | built-ins only | `social_click` | social_network=linkedin |
| 17 | Nav menu link | Click - All Elements | Click Element matches CSS nav.main-nav a | built-ins only | `navigation_click` | link_text={{Click Text}} |
| 18 | Footer link | Click - All Elements | Click Element matches CSS footer a | built-ins only | `footer_click` | - |
| 19 | Breadcrumb link | Click - All Elements | Click Element matches CSS .breadcrumb a | built-ins only | `breadcrumb_click` | - |
| 20 | On-page anchor link | Click - Just Links | Click URL contains # | built-ins only | `anchor_click` | - |

### Button & CTA clicks (12)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 21 | Hero CTA by ID | Click - All Elements | Click ID equals hero-cta | built-ins only | `cta_click` | cta_location=hero, cta_label={{Click Text}} |
| 22 | CTA by class | Click - All Elements | Click Classes contains btn-primary | built-ins only | `cta_click` | cta_label={{Click Text}} |
| 23 | CTA by data attribute | Click - All Elements | Click Element matches CSS [data-cta] | built-ins only | `cta_click` | cta_label={{Click Text}} |
| 24 | Add-to-cart button (no DL) | Click - All Elements | Click Element matches CSS button.add-to-cart | built-ins only | `add_to_cart_click` | - |
| 25 | Book Now by text | Click - All Elements | Click Text equals Book Now | built-ins only | `booking_intent` | - |
| 26 | Signup button | Click - All Elements | Click ID equals signup-btn | built-ins only | `sign_up_click` | - |
| 27 | iOS app download | Click - All Elements | Click Element matches CSS a.app-store | built-ins only | `app_download` | store=ios |
| 28 | Android app download | Click - All Elements | Click Element matches CSS a.play-store | built-ins only | `app_download` | store=android |
| 29 | Video thumbnail click | Click - All Elements | Click Classes contains video-thumb | built-ins only | `video_click` | - |
| 30 | Accordion open | Click - All Elements | Click Element matches CSS .accordion-header | built-ins only | `accordion_open` | - |
| 31 | Tab switch | Click - All Elements | Click Element matches CSS .tab-button | built-ins only | `tab_switch` | - |
| 32 | Chat widget open | Click - All Elements | Click Element matches CSS #chat-launcher | built-ins only | `chat_open` | - |

### Forms (14)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 33 | Form submit (native) | Form Submission | any form | built-ins only | `form_submit` | form_id={{Form ID}} |
| 34 | Contact form (by Form ID) | Form Submission | Form ID equals contact-form | built-ins only | `generate_lead` | form_name=Contact |
| 35 | Form on specific page | Form Submission | Page Path equals /contact | built-ins only | `form_submit` | form_id={{Form ID}} |
| 36 | Newsletter (data layer) | Custom Event | event = newsletter_signup | built-ins only | `sign_up` | method=newsletter |
| 37 | Contact form (data layer) | Custom Event | event = form_submit | DLV - form_id | `generate_lead` | form_id={{DLV - form_id}} |
| 38 | Contact Form 7 submit | Custom Event | event = wpcf7mailsent | DLV - form_name | `form_submit` | form_name={{DLV - form_name}} |
| 39 | Gravity Forms submit | Custom Event | event = gform_confirmation_loaded | built-ins only | `form_submit` | - |
| 40 | HubSpot form submit | Custom Event | event = hubspotFormSubmit | built-ins only | `generate_lead` | - |
| 41 | Form success (visibility) | Element Visibility | element .form-success visible >=50% | DLV - form_id | `form_submit` | form_id={{DLV - form_id}} |
| 42 | Form start | Custom Event | event = form_start | built-ins only | `form_start` | - |
| 43 | Form error | Custom Event | event = form_error | DLV - error_message | `form_error` | error_message={{DLV - error_message}} |
| 44 | Multi-step form step | Custom Event | event = form_step | DLV - step | `form_step` | step_number={{DLV - step}} |
| 45 | Quote request form | Form Submission | Form ID equals quote-form | built-ins only | `generate_lead` | value=1 |
| 46 | Demo request (data layer) | Custom Event | event = demo_request | built-ins only | `generate_lead` | form_name=Demo |

### Ecommerce (18)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 47 | View Item List | Custom Event | event = view_item_list | data layer ecommerce object | `view_item_list` | - |
| 48 | Select Item | Custom Event | event = select_item | data layer ecommerce object | `select_item` | - |
| 49 | View Item | Custom Event | event = view_item | data layer ecommerce object | `view_item` | - |
| 50 | Add To Cart | Custom Event | event = add_to_cart | data layer ecommerce object | `add_to_cart` | - |
| 51 | Remove From Cart | Custom Event | event = remove_from_cart | data layer ecommerce object | `remove_from_cart` | - |
| 52 | View Cart | Custom Event | event = view_cart | data layer ecommerce object | `view_cart` | - |
| 53 | Begin Checkout | Custom Event | event = begin_checkout | data layer ecommerce object | `begin_checkout` | - |
| 54 | Add Shipping Info | Custom Event | event = add_shipping_info | data layer ecommerce object | `add_shipping_info` | - |
| 55 | Add Payment Info | Custom Event | event = add_payment_info | data layer ecommerce object | `add_payment_info` | - |
| 56 | Purchase | Custom Event | event = purchase | data layer ecommerce object | `purchase` | - |
| 57 | Refund | Custom Event | event = refund | data layer ecommerce object | `refund` | - |
| 58 | Add To Wishlist | Custom Event | event = add_to_wishlist | data layer ecommerce object | `add_to_wishlist` | - |
| 59 | View Promotion | Custom Event | event = view_promotion | data layer ecommerce object | `view_promotion` | - |
| 60 | Select Promotion | Custom Event | event = select_promotion | data layer ecommerce object | `select_promotion` | - |
| 61 | Add to cart (button fallback) | Click - All Elements | Click Element matches CSS .add-to-cart | built-ins only | `add_to_cart` | currency=USD |
| 62 | Purchase on confirmation page | Page View | Page Path equals /order-confirmation | data layer ecommerce object | `purchase` | - |
| 63 | Coupon applied | Custom Event | event = coupon_applied | DLV - coupon | `coupon_apply` | coupon={{DLV - coupon}} |
| 64 | Shipping option selected | Click - All Elements | Click Element matches CSS input[name=shipping] | built-ins only | `shipping_select` | - |

### Engagement (12)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 65 | Scroll 90% | Scroll Depth | scroll reaches 90% | built-ins only | `scroll` | percent_scrolled={{Scroll Depth Threshold}} |
| 66 | Scroll milestones | Scroll Depth | scroll reaches 25, 50, 75, 90% | built-ins only | `scroll` | percent_scrolled={{Scroll Depth Threshold}} |
| 67 | Video start | YouTube Video | YouTube: start | built-ins only | `video_start` | video_title={{Video Title}} |
| 68 | Video progress | YouTube Video | YouTube: progress | built-ins only | `video_progress` | video_percent={{Video Percent}} |
| 69 | Video complete | YouTube Video | YouTube: complete | built-ins only | `video_complete` | video_title={{Video Title}} |
| 70 | Engaged 30 seconds | Timer | 30s elapsed | built-ins only | `engaged_30s` | - |
| 71 | Engaged 60 seconds | Timer | 60s elapsed | built-ins only | `engaged_60s` | - |
| 72 | Text copied | Custom Event | event = text_copied | built-ins only | `content_copy` | - |
| 73 | Print intent | Custom Event | event = print | built-ins only | `print_intent` | - |
| 74 | Article read | Custom Event | event = article_read | built-ins only | `content_read` | - |
| 75 | Gallery image view | Click - All Elements | Click Element matches CSS .gallery-image | built-ins only | `gallery_view` | - |
| 76 | FAQ expand | Click - All Elements | Click Element matches CSS .faq-question | built-ins only | `faq_expand` | - |

### Search & filters (8)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 77 | Site search (query param) | Page View | Page Path equals /search | URL - Search Query | `search` | search_term={{URL - Search Query}} |
| 78 | Search (data layer) | Custom Event | event = search | DLV - search_term | `search` | search_term={{DLV - search_term}} |
| 79 | Search no results | Custom Event | event = search_no_results | DLV - search_term | `no_results` | search_term={{DLV - search_term}} |
| 80 | Filter applied | Custom Event | event = filter_applied | DLV - filter_type | `filter_use` | filter_type={{DLV - filter_type}} |
| 81 | Sort changed | Click - All Elements | Click Element matches CSS select.sort | built-ins only | `sort_change` | - |
| 82 | Pagination click | Click - All Elements | Click Element matches CSS .pagination a | built-ins only | `pagination_click` | - |
| 83 | Autocomplete suggestion | Custom Event | event = autocomplete_select | built-ins only | `search_suggestion` | - |
| 84 | Category filter | Click - All Elements | Click Element matches CSS .category-filter | built-ins only | `category_filter` | - |

### User & account (10)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 85 | Login | Custom Event | event = login | DLV - method | `login` | method={{DLV - method}} |
| 86 | Login with Google | Custom Event | event = login AND DLV - method equals google | DLV - method | `login` | method=google |
| 87 | Sign up | Custom Event | event = sign_up | DLV - method | `sign_up` | method={{DLV - method}} |
| 88 | Logout | Custom Event | event = logout | built-ins only | `logout` | - |
| 89 | Profile update | Custom Event | event = profile_update | built-ins only | `profile_update` | - |
| 90 | Newsletter subscribe | Custom Event | event = newsletter_subscribe | built-ins only | `newsletter_subscribe` | - |
| 91 | Account created | Custom Event | event = account_created | built-ins only | `sign_up` | method=email |
| 92 | Loyalty join | Custom Event | event = loyalty_signup | built-ins only | `join_group` | group_id=loyalty |
| 93 | Password reset | Custom Event | event = password_reset | built-ins only | `password_reset` | - |
| 94 | Premium click (members only) | Click - All Elements | Click Element matches CSS .premium-feature AND Cookie - user_type equals member | Cookie - user_type | `premium_click` | - |

### Conditional & diagnostics (6)

| # | Example | Trigger type | Condition | Variables | GA4 event | Key parameters |
|---|---|---|---|---|---|---|
| 95 | Consent-gated add to cart | Custom Event | event = add_to_cart | consentSettings = NEEDED (ad_storage, analytics_storage) | `add_to_cart` | - |
| 96 | Geo-conditional pageview | Custom Event | event = gtm.dom AND DLV - country equals IN | DLV - country, Lookup - Country Currency | `india_pageview` | currency={{Lookup - Country Currency}} |
| 97 | Signup prompt (logged out) | Click - All Elements | Click Element matches CSS .signup AND Cookie - user_type does not equal member | Cookie - user_type (negated) | `signup_prompt` | - |
| 98 | JavaScript error | JavaScript Error | a JS error occurs | built-ins only | `exception` | description={{Error Message}}, fatal=false |
| 99 | 404 tracking (by path) | Page View | Page Path equals /404 | built-ins only | `page_not_found` | page_location={{Page URL}} |
| 100 | Debug-mode test event | Custom Event | event = add_to_cart AND Debug Mode equals true | Debug Mode (built-in) | `debug_test` | - |

## Variables created (17)

Examples that only need built-in variables (Click URL, Page Path, Form ID, and so on) do not add a custom variable. These are the custom variables the examples share.

| Variable | Type | Purpose |
|---|---|---|
| GA4 - Measurement ID | Constant | Holds the G- ID once; every event tag links to it via measurementIdOverride. |
| JS - Page Title | Custom JavaScript | Reads document.title for 404 detection by title. |
| CJS - File Name from URL | Custom JavaScript | Extracts the file name from a clicked URL for download events. |
| URL - Search Query | URL | Reads the ?s= query parameter for site search. |
| Cookie - user_type | 1st Party Cookie | Reads the user_type cookie to gate member-only events. |
| DLV - form_id | Data Layer Variable | Reads form_id from the data layer. |
| DLV - form_name | Data Layer Variable | Reads form_name from the data layer. |
| DLV - error_message | Data Layer Variable | Reads a form error message from the data layer. |
| DLV - step | Data Layer Variable | Reads the step number of a multi-step form. |
| DLV - coupon | Data Layer Variable | Reads an applied coupon code. |
| DLV - search_term | Data Layer Variable | Reads the search term from the data layer. |
| DLV - filter_type | Data Layer Variable | Reads which filter the user applied. |
| DLV - method | Data Layer Variable | Reads the login or signup method. |
| DLV - country | Data Layer Variable | Reads the user country for geo conditions. |
| DLV - page_path | Data Layer Variable | Reads the virtual page path for SPA pageviews. |
| RegEx - Page Category | RegEx Table | Maps the page path to a content group using regex rows. |
| Lookup - Country Currency | Lookup Table | Maps a country code to a currency using exact-match rows. |

## What conditions are covered

Across the 100 examples the trigger types used are: Page View, Custom Event, Click - Just Links, Click - All Elements, Form Submission, Element Visibility, Scroll Depth, YouTube Video, Timer, History Change, JavaScript Error, and All Pages. The operators shown are: equals, contains, starts with, ends with, matches regex, matches CSS selector, negation (does not contain, does not equal), and numeric scroll thresholds. Variable types shown are: Constant, Data Layer Variable, URL, 1st Party Cookie, Custom JavaScript, Lookup Table, and RegEx Table.