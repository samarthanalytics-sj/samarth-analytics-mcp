# Generates docs/samarth-gtm-mcp-linkedin-guide.pdf — a square PDF carousel
# for a LinkedIn document post. One idea per slide, large type, dark theme.
# Run: python docs/make-linkedin-guide-pdf.py

from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

PAGE = 720  # square slides; LinkedIn renders each PDF page as one carousel card

BG = HexColor("#0B1220")
PANEL = HexColor("#141E33")
WHITE = HexColor("#F4F7FB")
MUTED = HexColor("#9AA8C0")
ACCENT = HexColor("#2DD4A8")
AMBER = HexColor("#F5B14C")

M = 56  # margin


def slide_bg(c, kicker, page_num, total):
    c.setFillColor(BG)
    c.rect(0, 0, PAGE, PAGE, fill=1, stroke=0)
    c.setFillColor(ACCENT)
    c.rect(0, PAGE - 8, PAGE, 8, fill=1, stroke=0)
    if kicker:
        c.setFillColor(ACCENT)
        c.setFont("Helvetica-Bold", 15)
        c.drawString(M, PAGE - 64, kicker.upper())
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 12)
    c.drawString(M, 30, "Samarth GTM MCP  ·  github.com/samarthanalytics-sj/samarth-analytics-mcp")
    c.drawRightString(PAGE - M, 30, f"{page_num} / {total}")


def wrap(c, text, font, size, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if c.stringWidth(trial, font, size) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def title(c, y, text, size=40, color=WHITE, max_w=PAGE - 2 * M):
    c.setFillColor(color)
    c.setFont("Helvetica-Bold", size)
    for line in wrap(c, text, "Helvetica-Bold", size, max_w):
        c.drawString(M, y, line)
        y -= size * 1.18
    return y


def body(c, y, text, size=19, color=MUTED, max_w=PAGE - 2 * M, x=M):
    c.setFillColor(color)
    c.setFont("Helvetica", size)
    for line in wrap(c, text, "Helvetica", size, max_w):
        c.drawString(x, y, line)
        y -= size * 1.42
    return y


def bullet(c, y, head, sub=None, color=WHITE):
    c.setFillColor(ACCENT)
    c.circle(M + 5, y + 6, 4, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont("Helvetica-Bold", 20)
    for i, line in enumerate(wrap(c, head, "Helvetica-Bold", 20, PAGE - 2 * M - 28)):
        c.drawString(M + 22, y, line)
        y -= 26
    if sub:
        y = body(c, y, sub, size=16, x=M + 22, max_w=PAGE - 2 * M - 28)
    return y - 12


def code_panel(c, y, lines, size=16):
    pad = 18
    h = pad * 2 + len(lines) * size * 1.5
    c.setFillColor(PANEL)
    c.roundRect(M, y - h, PAGE - 2 * M, h, 10, fill=1, stroke=0)
    ty = y - pad - size
    for ln in lines:
        if ln.startswith("#"):
            c.setFillColor(MUTED)
        else:
            c.setFillColor(ACCENT)
        c.setFont("Courier-Bold", size)
        c.drawString(M + pad, ty, ln)
        ty -= size * 1.5
    return y - h - 20


def prompt_card(c, y, text):
    size = 18
    lines = wrap(c, text, "Helvetica-Bold", size, PAGE - 2 * M - 56)
    h = 30 + len(lines) * size * 1.35
    c.setFillColor(PANEL)
    c.roundRect(M, y - h, PAGE - 2 * M, h, 10, fill=1, stroke=0)
    c.setFillColor(AMBER)
    c.setFont("Helvetica-Bold", size)
    c.drawString(M + 18, y - 30, "“")
    c.setFillColor(WHITE)
    ty = y - 30
    for ln in lines:
        c.drawString(M + 38, ty, ln)
        ty -= size * 1.35
    return y - h - 16


def build(path):
    c = canvas.Canvas(path, pagesize=(PAGE, PAGE))
    total = 10

    # 1 — Cover
    slide_bg(c, "", 1, total)
    c.setFillColor(ACCENT)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(M, PAGE - 120, "FREE SETUP GUIDE  ·  10 MINUTES")
    y = title(c, PAGE - 190, "Talk to Google Tag Manager.", 46)
    y = title(c, y - 6, "Literally.", 46, ACCENT)
    y = body(c, y - 24,
             "Connect Claude or Cursor straight to your GTM containers and GA4 — "
             "audit, explore, and document in plain English. Read-only by default, "
             "so it's safe for client work.", 21)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(M, 110, "Samarth GTM MCP — open source, MIT licensed")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 15)
    c.drawString(M, 84, "Swipe for the full setup →")
    c.showPage()

    # 2 — What it is
    slide_bg(c, "What you're setting up", 2, total)
    y = title(c, PAGE - 130, "An MCP server with 107 GTM + GA4 tools")
    y -= 16
    y = bullet(c, y, "Full GTM API v2 surface",
               "Tags, triggers, variables, versions, server-side containers, zones, custom templates.")
    y = bullet(c, y, "Read-only GA4 included",
               "Admin + reporting tools to reconcile what's configured vs. what's actually collected.")
    y = bullet(c, y, "Built-in audits",
               "Including a Consent Mode v2 engine validated by a 170-case test suite.")
    y = bullet(c, y, "Works with any MCP client",
               "Claude Desktop, Claude Code, Cursor — local stdio or team HTTP deployment.")
    c.showPage()

    # 3 — Prerequisites
    slide_bg(c, "Before you start", 3, total)
    y = title(c, PAGE - 130, "You need four things")
    y -= 20
    y = bullet(c, y, "Node.js 18 or newer")
    y = bullet(c, y, "A Google Cloud project", "With the Tag Manager API enabled (free).")
    y = bullet(c, y, "A Google account with GTM access", "Whatever containers you can see, the AI can see.")
    y = bullet(c, y, "An MCP client", "Claude Desktop, Claude Code, or Cursor.")
    y = body(c, y - 10,
             "No anonymous access exists for the GTM API — someone has to own an OAuth app. "
             "This guide uses your own (5 extra minutes, full control).", 17)
    c.showPage()

    # 4 — Install
    slide_bg(c, "Step 1 of 3", 4, total)
    y = title(c, PAGE - 130, "Install & build")
    y -= 24
    y = code_panel(c, y, [
        "git clone github.com/samarthanalytics-sj/samarth-analytics-mcp",
        "cd samarth-analytics-mcp && npm install",
        "cp .env.example .env",
        "npm run build",
    ], size=13)
    y = body(c, y, "Then create an OAuth 2.0 Client ID (type: Desktop app) in Google "
                   "Cloud Console and drop it into .env:", 18, WHITE)
    y -= 6
    code_panel(c, y, [
        "GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret",
    ], size=14)
    c.showPage()

    # 5 — Auth
    slide_bg(c, "Step 2 of 3", 5, total)
    y = title(c, PAGE - 130, "Authorize with Google — once")
    y -= 24
    y = code_panel(c, y, ["npm run auth:google"], size=20)
    y = bullet(c, y, "Opens your browser to Google's consent screen")
    y = bullet(c, y, "Captures the redirect automatically", "A tiny local callback server does the token exchange.")
    y = bullet(c, y, "Saves tokens to a local, gitignored file", "Nothing to copy-paste. Re-run any time access expires.")
    c.showPage()

    # 6 — Connect
    slide_bg(c, "Step 3 of 3", 6, total)
    y = title(c, PAGE - 130, "Connect your AI client")
    y = body(c, y - 4, "Claude Desktop — add to claude_desktop_config.json:", 18, WHITE)
    y -= 8
    y = code_panel(c, y, [
        '{ "mcpServers": { "samarth-gtm": {',
        '    "command": "node",',
        '    "args": ["/path/to/dist/index.js"]',
        '} } }',
    ], size=15)
    y = body(c, y, "Same JSON works in Cursor (Settings → MCP) and Claude Code "
                   "(.claude/mcp_config.json). Keep credentials in .env — it's loaded "
                   "automatically. Restart the client and you're live.", 18)
    c.showPage()

    # 7 — Prompts
    slide_bg(c, "Try these first", 7, total)
    y = title(c, PAGE - 130, "Your first five prompts", 34)
    y -= 14
    y = prompt_card(c, y, "List my GTM accounts and containers.")
    y = prompt_card(c, y, "Audit container GTM-XXXXXXX for common GA4 implementation issues.")
    y = prompt_card(c, y, "Show me every tag that fires on All Pages, with its triggers.")
    y = prompt_card(c, y, "Export this workspace as JSON.")
    y = prompt_card(c, y, "Compare what GA4 actually collects vs. what GTM is configured to send.")
    c.showPage()

    # 8 — Guardrails
    slide_bg(c, "The important part", 8, total)
    y = title(c, PAGE - 130, "Safe for client containers")
    y = body(c, y - 4, "It ships read-only. Three separate flags gate every kind of change:", 18, WHITE)
    y -= 8
    y = code_panel(c, y, [
        "GTM_MCP_ENABLE_WRITES=false",
        "GTM_MCP_ENABLE_PUBLISH=false",
        "GTM_MCP_ENABLE_DELETES=false",
        "DRY_RUN=false  # simulate writes",
    ], size=16)
    y = bullet(c, y, "Every mutation also requires confirm: true", "Per call. The AI proposes; you approve.")
    y = bullet(c, y, "Agency posture: leave them all false", "AI does the reading and auditing. You make the changes.")
    c.showPage()

    # 9 — Production
    slide_bg(c, "Under the hood", 9, total)
    y = title(c, PAGE - 130, "Built for real workloads")
    y -= 16
    y = bullet(c, y, "Automatic pagination", "List tools follow every page transparently, with safety bounds.")
    y = bullet(c, y, "Retry with backoff + jitter", "Rate limits and transient errors are absorbed — on reads only. Mutations never auto-retry.")
    y = bullet(c, y, "Two transports", "stdio for local clients; Streamable HTTP for team and cloud deployments.")
    y = bullet(c, y, "Validated inputs, surfaced errors", "Zod schemas on every tool; detailed Google API errors back to the client.")
    c.showPage()

    # 10 — CTA
    slide_bg(c, "", 10, total)
    y = title(c, PAGE - 170, "Stop clicking.", 48)
    y = title(c, y - 6, "Start asking.", 48, ACCENT)
    y = body(c, y - 24,
             "Samarth GTM MCP is open source under the MIT license. "
             "Star it, fork it, or open an issue:", 21)
    c.setFillColor(PANEL)
    c.roundRect(M, y - 64, PAGE - 2 * M, 52, 10, fill=1, stroke=0)
    c.setFillColor(ACCENT)
    c.setFont("Courier-Bold", 15)
    c.drawString(M + 16, y - 44, "github.com/samarthanalytics-sj/samarth-analytics-mcp")
    y -= 100
    y = body(c, y, "Follow Samarth Analytics for the next post: 5 prompts that replace an hour of GTM clicking.", 18, WHITE)
    c.showPage()

    c.save()


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(__file__), "samarth-gtm-mcp-linkedin-guide.pdf")
    build(out)
    print(f"wrote {out}")
