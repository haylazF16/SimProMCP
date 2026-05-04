"""
Generate two coworker-facing PDF instruction documents:
  1. Goldman-Simpro-LAN-Setup.pdf       (~3 pages, post-server connect)
  2. Goldman-Simpro-Individual-Setup.pdf (~5-6 pages, standalone fallback)

This version (final):
  - Concrete URLs and SharePoint path baked in (no placeholders).
  - No screenshot placeholders. Replaced with vector flow diagrams drawn
    with reportlab's graphics primitives.
  - Pure ASCII output (no em-dashes, no fancy quotes).
"""
import os
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
)
from reportlab.lib.enums import TA_CENTER
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon
from reportlab.graphics import renderPDF

# --------- BAKED-IN GOLDMAN VALUES (final) ---------
SERVER_IP = "192.168.88.113"
SERVER_PORT = "3001"
PLUMBING_URL = f"http://{SERVER_IP}:{SERVER_PORT}/mcp/plumbing"
ENERGY_URL   = f"http://{SERVER_IP}:{SERVER_PORT}/mcp/energy"
SIMPRO_BASE  = "https://goldmanplumbingservices.simprosuite.com"
SHAREPOINT_FOLDER = (
    r"C:\Users\<YOU>\GoldmanPlumbing\Goldman Plumbing Services"
    r"\Energy - Documents\IT\SimProMCP"
)

OUTDIR = os.environ.get("PDF_OUT_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(OUTDIR, exist_ok=True)

# ---------- Styles ----------
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="DocTitle", parent=styles["Title"], fontSize=22, leading=26,
    spaceAfter=4, textColor=colors.HexColor("#0f4c75"),
))
styles.add(ParagraphStyle(
    name="DocSubtitle", parent=styles["Normal"], fontSize=11, leading=14,
    spaceAfter=18, textColor=colors.HexColor("#555555"), italic=True,
))
styles.add(ParagraphStyle(
    name="H1", parent=styles["Heading1"], fontSize=16, leading=20,
    spaceBefore=14, spaceAfter=8, textColor=colors.HexColor("#0f4c75"),
))
styles.add(ParagraphStyle(
    name="H2", parent=styles["Heading2"], fontSize=13, leading=17,
    spaceBefore=10, spaceAfter=6, textColor=colors.HexColor("#1b5e9c"),
))
styles.add(ParagraphStyle(
    name="Body", parent=styles["Normal"], fontSize=10.5, leading=15,
    spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="StepNum", parent=styles["Normal"], fontSize=10.5, leading=15,
    leftIndent=18, spaceAfter=4,
))
styles.add(ParagraphStyle(
    name="MyCode", parent=styles["Code"], fontSize=9, leading=12,
    leftIndent=10, rightIndent=10, spaceBefore=4, spaceAfter=8,
    backColor=colors.HexColor("#f4f4f4"), borderColor=colors.HexColor("#dddddd"),
    borderWidth=0.5, borderPadding=6,
))
styles.add(ParagraphStyle(
    name="CalloutBody", parent=styles["Normal"], fontSize=10, leading=14,
    textColor=colors.HexColor("#333333"),
))
styles.add(ParagraphStyle(
    name="DiagCaption", parent=styles["Normal"], fontSize=9, leading=12,
    alignment=TA_CENTER, textColor=colors.HexColor("#666666"), italic=True,
    spaceBefore=4, spaceAfter=10,
))


# ---------- Helpers ----------
def callout(text, kind="info"):
    palette = {
        "warning": ("#fff3f3", "#c0392b", "WARNING"),
        "safe":    ("#f1faf1", "#2c8a3a", "SAFETY"),
        "info":    ("#eef4fb", "#1b5e9c", "NOTE"),
        "tip":     ("#fffbe6", "#a37b00", "TIP"),
    }
    bg, border, label = palette[kind]
    inner = Paragraph(f"<b>{label}.</b> {text}", styles["CalloutBody"])
    t = Table([[inner]], colWidths=[16.0 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(bg)),
        ("BOX",        (0, 0), (-1, -1), 0.7, colors.HexColor(border)),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",    (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def step(number, body):
    return Paragraph(f"<b>{number}.</b> &nbsp;{body}", styles["StepNum"])


def trouble_table(rows):
    data = [["Problem", "Fix"]] + rows
    cell_style = ParagraphStyle(name="tcell", parent=styles["Normal"], fontSize=9.5, leading=13)
    data = [[Paragraph(c, cell_style) for c in r] for r in data]
    t = Table(data, colWidths=[6.5 * cm, 9.5 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f4c75")),
        ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
        ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN",      (0, 0), (-1, 0), "LEFT"),
        ("BOX",        (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
        ("INNERGRID",  (0, 0), (-1, -1), 0.3, colors.HexColor("#e0e0e0")),
        ("VALIGN",     (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 7),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 7),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


# ---------- Flow diagrams ----------
def _box(d, x, y, w, h, title, lines, fill="#eef4fb", stroke="#1b5e9c"):
    """Draw a labelled rectangle with title + small detail lines."""
    d.add(Rect(x, y, w, h, fillColor=colors.HexColor(fill),
               strokeColor=colors.HexColor(stroke), strokeWidth=1.2, rx=4, ry=4))
    d.add(String(x + w / 2, y + h - 18, title,
                 fontName="Helvetica-Bold", fontSize=10,
                 fillColor=colors.HexColor("#0f4c75"), textAnchor="middle"))
    for i, ln in enumerate(lines):
        d.add(String(x + w / 2, y + h - 36 - i * 12, ln,
                     fontName="Helvetica", fontSize=8.5,
                     fillColor=colors.HexColor("#333333"), textAnchor="middle"))


def _arrow(d, x1, y, x2, label_top=None, label_bot=None,
           color="#0f4c75"):
    """Horizontal arrow x1 -> x2 at vertical pos y, with optional labels."""
    d.add(Line(x1, y, x2 - 8, y, strokeColor=colors.HexColor(color), strokeWidth=1.4))
    # Arrow head
    d.add(Polygon([x2, y, x2 - 8, y - 4, x2 - 8, y + 4],
                  fillColor=colors.HexColor(color),
                  strokeColor=colors.HexColor(color)))
    if label_top:
        d.add(String((x1 + x2) / 2, y + 6, label_top,
                     fontName="Helvetica-Bold", fontSize=8.5,
                     fillColor=colors.HexColor(color), textAnchor="middle"))
    if label_bot:
        d.add(String((x1 + x2) / 2, y - 14, label_bot,
                     fontName="Helvetica-Oblique", fontSize=7.5,
                     fillColor=colors.HexColor("#666666"), textAnchor="middle"))


def lan_flow_diagram():
    """Flow for the LAN setup PDF."""
    d = Drawing(450, 170)
    bw, bh = 130, 105
    y = 30
    # Box 1: Coworker PC
    _box(d, 0, y, bw, bh,
         "Your PC",
         ["Claude Desktop",
          "Custom Connector",
          "+ smcp_* token"],
         fill="#eef4fb", stroke="#1b5e9c")
    # Box 2: Office server
    _box(d, 160, y, bw, bh,
         "Office Server",
         ["simpro-mcp-server",
          "tokens.json",
          "audit.log",
          f"{SERVER_IP}:{SERVER_PORT}"],
         fill="#fffbe6", stroke="#a37b00")
    # Box 3: Simpro
    _box(d, 320, y, bw, bh,
         "Simpro Cloud",
         [SIMPRO_BASE.replace("https://", ""),
          "audit log shows",
          "real employee"],
         fill="#f1faf1", stroke="#2c8a3a")
    # Arrows
    _arrow(d, bw, y + bh / 2, 160, "HTTP (LAN)",
           f"port {SERVER_PORT}")
    _arrow(d, bw + 160, y + bh / 2, 320, "HTTPS",
           "uses YOUR Simpro key")
    return d


def individual_flow_diagram():
    """Flow for the individual-setup PDF (Plan B)."""
    d = Drawing(450, 170)
    bw, bh = 200, 105
    y = 30
    # Box 1: Your PC (subprocess + Claude Desktop together)
    _box(d, 0, y, bw, bh,
         "Your PC",
         ["Claude Desktop launches",
          "the Simpro tool locally",
          "via STDIO subprocess",
          "(your Simpro key in config)"],
         fill="#eef4fb", stroke="#1b5e9c")
    # Box 2: Simpro
    _box(d, 250, y, bw, bh,
         "Simpro Cloud",
         [SIMPRO_BASE.replace("https://", ""),
          "audit log shows",
          "your name"],
         fill="#f1faf1", stroke="#2c8a3a")
    _arrow(d, bw, y + bh / 2, 250, "HTTPS",
           "uses YOUR Simpro key")
    return d


# ---------- Page chrome ----------
def header_footer(canvas, doc, doc_title):
    canvas.saveState()
    canvas.setFont("Helvetica-Bold", 9)
    canvas.setFillColor(colors.HexColor("#0f4c75"))
    canvas.drawString(2 * cm, A4[1] - 1.2 * cm, "Goldman Plumbing Services")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#666666"))
    canvas.drawRightString(A4[0] - 2 * cm, A4[1] - 1.2 * cm, doc_title)
    canvas.setStrokeColor(colors.HexColor("#dddddd"))
    canvas.setLineWidth(0.4)
    canvas.line(2 * cm, A4[1] - 1.4 * cm, A4[0] - 2 * cm, A4[1] - 1.4 * cm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#888888"))
    canvas.drawString(2 * cm, 1.2 * cm, "Internal use only. Never share your Simpro API key.")
    canvas.drawRightString(A4[0] - 2 * cm, 1.2 * cm, f"Page {doc.page}")
    canvas.restoreState()


# =============================================================================
# DOC 1: LAN SETUP
# =============================================================================
def build_lan_pdf():
    out = os.path.join(OUTDIR, "Goldman-Simpro-LAN-Setup.pdf")
    doc = SimpleDocTemplate(
        out, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=2 * cm, bottomMargin=2 * cm,
        title="Goldman Simpro LAN Setup", author="Goldman Plumbing IT",
    )
    s = []
    s.append(Paragraph("Connecting to the Office Simpro AI Tool", styles["DocTitle"]))
    s.append(Paragraph("LAN Setup Guide for Coworkers (5 minutes)", styles["DocSubtitle"]))

    # Architecture diagram
    s.append(Paragraph("How it works", styles["H1"]))
    s.append(lan_flow_diagram())
    s.append(Paragraph(
        "Your Claude Desktop talks to the office server, the office server talks to Simpro using YOUR Simpro key. "
        "Simpro's audit log records you as the person who did each action.",
        styles["DiagCaption"]))

    s.append(Paragraph("Before you start", styles["H1"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <b>Claude Desktop</b> installed on your PC.", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <b>Claude Pro / Team / Enterprise plan</b> (Custom Connectors require a paid plan). "
                       "If your plan does not show Custom Connectors, ask IT for the alternative individual setup.", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <b>Office Wi-Fi or VPN</b> connected. The server is only reachable on the Goldman network.", styles["Body"]))

    # ---- Part 1 ----
    s.append(Paragraph("Part 1 - Create your own Simpro API key", styles["H1"]))
    s.append(Paragraph("Each person uses their own key so audit logs in Simpro show who did what.", styles["Body"]))
    s.append(step(1, f"Log into Simpro at <b>{SIMPRO_BASE}</b>"))
    s.append(step(2, "Click the gear icon (top right) -&gt; <b>System</b> -&gt; <b>Setup</b> -&gt; <b>API Keys</b>"))
    s.append(step(3, "Click <b>Add</b>. Name it after yourself, e.g. <i>Jane Smith - Claude Desktop</i>."))
    s.append(step(4, "Set the linked employee to <b>your own employee record</b>."))
    s.append(step(5, "Start with <b>read-only</b> permissions. IT can grant edit later."))
    s.append(step(6, "Click <b>Save</b>. Simpro shows the access token. <b>COPY IT NOW</b> into a private note. "
                     "Simpro shows it only once."))
    s.append(callout(
        "Treat the access token like your password. Never email it, never paste it in group chat, "
        "never include it in screenshots. Send it only to IT (Tayfun / Sinan), and only via direct message.",
        kind="warning"))

    # ---- Part 2 ----
    s.append(PageBreak())
    s.append(Paragraph("Part 2 - Send your Simpro API key to IT", styles["H1"]))
    s.append(Paragraph(
        "In a direct message (not a group chat) to IT, send:",
        styles["Body"]))
    s.append(Paragraph(
        "<i>Hi, here is my Simpro API key for the Claude tool: &lt;paste token here&gt;.<br/>"
        "I work in: Plumbing only / Energy only / both</i>",
        styles["MyCode"]))
    s.append(Paragraph(
        "IT will reply with a personal access token starting with <b>smcp_</b>. The two URLs you need are:",
        styles["Body"]))
    s.append(Paragraph(
        f"<b>Plumbing URL:</b> &nbsp;<font face='Courier'>{PLUMBING_URL}</font><br/>"
        f"<b>Energy URL:</b> &nbsp;&nbsp;&nbsp;&nbsp;<font face='Courier'>{ENERGY_URL}</font>",
        styles["Body"]))
    s.append(callout(
        "Why two tokens? Your <b>Simpro API key</b> stays on the office server (IT registers it for you). "
        "Your <b>personal access token</b> (the smcp_ one) is what your Claude Desktop sends to prove it is "
        "really you. If you change PCs, IT just gives you a new personal token without touching Simpro.",
        kind="info"))

    # ---- Part 3 ----
    s.append(Paragraph("Part 3 - Add the connectors to Claude Desktop", styles["H1"]))
    s.append(step(1, "Open <b>Claude Desktop</b>."))
    s.append(step(2, "Click your profile icon (bottom-left) -&gt; <b>Settings</b>."))
    s.append(step(3, "Click <b>Connectors</b> in the left sidebar -&gt; scroll to <b>Add custom connector</b>."))
    s.append(step(4, "Add the FIRST connector for Plumbing:"))
    s.append(Paragraph(
        f"&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Name:</b> Goldman Plumbing<br/>"
        f"&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Remote MCP server URL:</b> <font face='Courier'>{PLUMBING_URL}</font><br/>"
        f"&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Authentication:</b> Bearer token = the smcp_ token IT sent you<br/>"
        f"&nbsp;&nbsp;&nbsp;&nbsp;&bull; Click <b>Add</b>.",
        styles["StepNum"]))
    s.append(step(5, "Add the SECOND connector for Energy (only if you work in Energy too):"))
    s.append(Paragraph(
        f"&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Name:</b> Goldman Energy<br/>"
        f"&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Remote MCP server URL:</b> <font face='Courier'>{ENERGY_URL}</font><br/>"
        f"&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Authentication:</b> Bearer token = the same smcp_ token<br/>"
        f"&nbsp;&nbsp;&nbsp;&nbsp;&bull; Click <b>Add</b>.",
        styles["StepNum"]))

    # ---- Part 4 ----
    s.append(Paragraph("Part 4 - Test it", styles["H1"]))
    s.append(Paragraph("In Claude Desktop, type:", styles["Body"]))
    s.append(Paragraph("<font face='Courier'>Use Simpro Plumbing to test the connection.</font>", styles["MyCode"]))
    s.append(Paragraph("You should see something like:", styles["Body"]))
    s.append(Paragraph(
        '<i>"Simpro connection OK. Base URL: ' + SIMPRO_BASE + ', Company ID: 4 ..."</i>',
        styles["Body"]))
    s.append(Paragraph("Then try the other one (if you added it):", styles["Body"]))
    s.append(Paragraph("<font face='Courier'>Use Simpro Energy to test the connection.</font>", styles["MyCode"]))
    s.append(Paragraph("Should report <b>Company ID: 37</b>. If both work - you are set.", styles["Body"]))

    s.append(Paragraph("More things to try", styles["H2"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to find customers named Goldman.</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to show the 5 most recent jobs.</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to list line items for purchase order [number].</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Energy to find supplier invoices from Reece in May 2026.</i>", styles["Body"]))

    # ---- Safety ----
    s.append(Paragraph("Safety - what is on and off by default", styles["H1"]))
    s.append(callout(
        "Writes (create / update) are off by default. Claude can read your Simpro data but cannot change anything. "
        "When you are ready, ask IT to enable writes for your token. Even then, every write requires you to say "
        "'confirm true' and Claude will show you exactly what it will do before doing it.",
        kind="safe"))

    # ---- Troubleshooting ----
    s.append(PageBreak())
    s.append(Paragraph("Common problems and fixes", styles["H1"]))
    s.append(trouble_table([
        ("Claude Desktop does not show 'Add custom connector'",
         "Your Claude plan likely does not support Custom Connectors. Ask IT for the individual setup (Plan B)."),
        ("'Connection failed' or 'cannot reach server'",
         f"Check you are on office Wi-Fi or VPN. Try opening <font face='Courier'>http://{SERVER_IP}:{SERVER_PORT}/healthz</font> in your browser - "
         "you should see a small JSON response. If not, the server is down - tell IT."),
        ("'401 Unauthorized'",
         "Your personal access token is wrong, expired, or revoked. Ask IT to regenerate it."),
        ("'403 Forbidden' or 'does not have access to energy'",
         "Your token only allows one company. Ask IT to grant access to both."),
        ("Claude finds zero quotes for a customer that clearly has quotes",
         "Phrase the request as <i>'find quotes <b>for</b> customer X'</i> rather than putting the name as a keyword."),
        ("Anything else",
         "Send IT a screenshot. <b>Never include your access token in the screenshot</b> - blur it first."),
    ]))

    s.append(Paragraph("If anything is unclear", styles["H1"]))
    s.append(Paragraph(
        "Contact IT (currently <b>Tayfun / Sinan</b>). Tell them which step you got stuck on, "
        "the exact error, and your Windows version. <b>Never include your tokens</b> in screenshots - blur or crop first.",
        styles["Body"]))

    doc.build(s, onFirstPage=lambda c, d: header_footer(c, d, "LAN Setup Guide"),
                onLaterPages=lambda c, d: header_footer(c, d, "LAN Setup Guide"))
    return out


# =============================================================================
# DOC 2: INDIVIDUAL PC SETUP (Plan B)
# =============================================================================
def build_individual_pdf():
    out = os.path.join(OUTDIR, "Goldman-Simpro-Individual-Setup.pdf")
    doc = SimpleDocTemplate(
        out, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=2 * cm, bottomMargin=2 * cm,
        title="Goldman Simpro Individual PC Setup", author="Goldman Plumbing IT",
    )
    s = []
    s.append(Paragraph("Goldman Simpro AI Tool", styles["DocTitle"]))
    s.append(Paragraph("Individual PC Setup Guide (Plan B, ~15 minutes)", styles["DocSubtitle"]))

    # Architecture
    s.append(Paragraph("How it works", styles["H1"]))
    s.append(individual_flow_diagram())
    s.append(Paragraph(
        "The Simpro tool runs locally on your PC. Claude Desktop launches it as a small background process. "
        "It uses YOUR Simpro API key directly - no office server in between.",
        styles["DiagCaption"]))

    s.append(Paragraph("When to use this guide", styles["H1"]))
    s.append(Paragraph(
        "Use this only if the office server version is unavailable, or if you do not have Claude Pro/Team/Enterprise. "
        "Otherwise the LAN setup is much simpler - 5 minutes, no installation.",
        styles["Body"]))

    s.append(Paragraph("What you need", styles["H1"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; Windows 10 or 11.", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; Claude Desktop installed (free plan is fine).", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; Permission to install Node.js (you may need to ask IT).", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; About 15 minutes.", styles["Body"]))

    # ---- Part 1 ----
    s.append(Paragraph("Part 1 - Create your own Simpro API key", styles["H1"]))
    s.append(step(1, f"Log into Simpro at <b>{SIMPRO_BASE}</b>"))
    s.append(step(2, "Click the gear icon (top right) -&gt; <b>System</b> -&gt; <b>Setup</b> -&gt; <b>API Keys</b>"))
    s.append(step(3, "Click <b>Add</b>, name the key after yourself, link to your own employee record."))
    s.append(step(4, "Start with read-only permissions for the first week."))
    s.append(step(5, "Click <b>Save</b>. <b>COPY THE ACCESS TOKEN NOW</b> - it is shown only once."))
    s.append(callout(
        "Treat the access token like your password. Never share, email, or screenshot it. "
        "If it leaks, log into Simpro and delete the key.",
        kind="warning"))

    # ---- Part 2 ----
    s.append(Paragraph("Part 2 - Install Node.js (one-time)", styles["H1"]))
    s.append(step(1, "Open <b>https://nodejs.org</b> in your browser."))
    s.append(step(2, "Click the green <b>LTS</b> button on the left to download the .msi installer."))
    s.append(step(3, "Run the installer. Click Next, Next, Install. Defaults are fine."))
    s.append(step(4, "<b>Restart your PC</b> after the install completes."))
    s.append(step(5, "Verify: open the Start menu, type <i>PowerShell</i>, press Enter, then type:"))
    s.append(Paragraph("<font face='Courier'>node --version</font>", styles["MyCode"]))
    s.append(Paragraph("It should print something like <font face='Courier'>v20.11.0</font>. "
                       "If yes, close PowerShell - Part 2 is done.", styles["Body"]))

    # ---- Part 3 ----
    s.append(PageBreak())
    s.append(Paragraph("Part 3 - Open the IT share folder", styles["H1"]))
    s.append(Paragraph(
        "IT keeps the latest version of the tool in a SharePoint folder. "
        "On your PC, navigate to:",
        styles["Body"]))
    s.append(Paragraph(SHAREPOINT_FOLDER, styles["MyCode"]))
    s.append(Paragraph(
        "(replace <font face='Courier'>&lt;YOU&gt;</font> with your own Windows username, e.g. <i>jsmith</i>)",
        styles["Body"]))
    s.append(callout(
        "If the folder does not exist on your PC, you do not have OneDrive synced. "
        "Open Microsoft Teams or your browser, find the <b>Energy &gt; IT &gt; SimProMCP</b> SharePoint folder, "
        "click <b>Sync</b>. Or just ask IT to share a copy directly.",
        kind="info"))

    # ---- Part 4 ----
    s.append(Paragraph("Part 4 - Run the installer", styles["H1"]))
    s.append(step(1, "Open the SharePoint folder from Part 3."))
    s.append(step(2, "<b>Double-click</b> the file named <font face='Courier'><b>install.cmd</b></font>."))
    s.append(callout(
        "Windows may show a blue 'Windows protected your PC' warning. Click <b>More info</b> -&gt; <b>Run anyway</b>. "
        "The script comes from your IT team - it is safe.",
        kind="info"))
    s.append(step(3, "When asked for your <b>Simpro API key</b>, paste the access token from Part 1."))
    s.append(step(4, "When asked which company, type <b>3</b> for both Plumbing and Energy "
                     "(or 1 for Plumbing only, 2 for Energy only)."))
    s.append(step(5, "Wait about 30 seconds. The script copies the tool, configures Claude Desktop, "
                     "and tells you it is done."))

    # ---- Part 5 ----
    s.append(Paragraph("Part 5 - Restart Claude Desktop properly", styles["H1"]))
    s.append(callout(
        "Just closing the Claude Desktop window is NOT enough. You must <b>Quit</b> from the system tray.",
        kind="warning"))
    s.append(step(1, "Look at the bottom-right of your screen, near the clock."))
    s.append(step(2, "Find the <b>Claude icon</b> in the system tray. You may need to click the small up-arrow to expand hidden icons."))
    s.append(step(3, "<b>Right-click</b> the Claude icon -&gt; click <b>Quit</b>."))
    s.append(step(4, "Wait 3 seconds, then open Claude Desktop again from the Start menu."))

    # ---- Part 6 ----
    s.append(PageBreak())
    s.append(Paragraph("Part 6 - Test it works", styles["H1"]))
    s.append(step(1, "In Claude Desktop, click the small <b>tools / hammer icon</b> near the message box. "
                     "You should see two entries: <i>simpro_plumbing</i> and <i>simpro_energy</i>."))
    s.append(step(2, "Type into the chat:"))
    s.append(Paragraph("<font face='Courier'>Use Simpro Plumbing to test the connection.</font>", styles["MyCode"]))
    s.append(step(3, "You should see something like: <i>'Simpro connection OK ... Company ID: 4 ...'</i>"))
    s.append(step(4, "Try the other one to confirm both work:"))
    s.append(Paragraph("<font face='Courier'>Use Simpro Energy to test the connection.</font>", styles["MyCode"]))
    s.append(Paragraph("Should report <b>Company ID: 37</b>. If both work, you are done.", styles["Body"]))

    s.append(Paragraph("More things to try", styles["H2"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to search for customers named Goldman.</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to find recent jobs.</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to list line items for purchase order [number].</i>", styles["Body"]))

    # ---- Part 7 ----
    s.append(Paragraph("Part 7 - Turning on writes (later)", styles["H1"]))
    s.append(Paragraph(
        "After a few days of comfortable read-only use, you can let Claude create or update Simpro records. "
        "Do this in two stages.",
        styles["Body"]))
    s.append(Paragraph("Stage 1 - Dry run (safe preview)", styles["H2"]))
    s.append(Paragraph(
        "Edit the Claude Desktop config and set <font face='Courier'>SIMPRO_ENABLE_WRITE_TOOLS=true</font> "
        "while keeping <font face='Courier'>SIMPRO_DRY_RUN=true</font>. From then on, write requests show "
        "you what would happen but do not actually send. If you are unsure how to edit the config, ask IT.",
        styles["Body"]))
    s.append(Paragraph("Stage 2 - Real writes", styles["H2"]))
    s.append(Paragraph(
        "Once you are confident, set <font face='Courier'>SIMPRO_DRY_RUN=false</font>. Real writes happen now. "
        "Start small - add a note to a test job before doing anything bulk.",
        styles["Body"]))
    s.append(callout(
        "Every write also requires <i>confirm: true</i>. If you forget, Claude returns a confirmation request "
        "instead of doing anything. Two safety layers, on purpose.",
        kind="safe"))

    # ---- Updates ----
    s.append(Paragraph("Updating to a new version", styles["H1"]))
    s.append(Paragraph(
        "When IT releases a new version, they will tell you to:",
        styles["Body"]))
    s.append(step(1, "Open the SharePoint folder again."))
    s.append(step(2, "<b>Double-click</b> <font face='Courier'><b>update.cmd</b></font>. It refreshes your local copy without touching your API key."))
    s.append(step(3, "Quit Claude Desktop from the system tray and reopen."))

    # ---- Troubleshooting ----
    s.append(Paragraph("Common problems and fixes", styles["H1"]))
    s.append(trouble_table([
        ("Claude Desktop does not show the simpro tools",
         "You did not fully Quit Claude Desktop. Right-click tray icon -&gt; Quit. Wait 3 seconds. Reopen."),
        ("'401 Unauthorized'",
         "Your Simpro API key is wrong, expired, or was deleted. Generate a new one in Simpro (Part 1) and re-run install.cmd to update it."),
        ("'403 Forbidden'",
         "The key works but lacks permission. Edit your API key in Simpro and grant the missing permission."),
        ("'404 Not Found' on every request",
         "Wrong company. Goldman Plumbing = ID 4, Goldman Energy = ID 37. Try the other one."),
        ("'Write tools are disabled'",
         "Safety guard. Enable writes (see Part 7)."),
        ("'Confirmation required'",
         "Add <i>confirm: true</i> to your request, or tell Claude <i>'...and confirm true'</i>."),
        ("'Could not reach Simpro'",
         f"Check you can open <font face='Courier'>{SIMPRO_BASE}</font> in your browser. If on VPN, connect to it."),
        ("Anything else",
         "Send IT a screenshot. <b>Never include your API key in the screenshot.</b>"),
    ]))

    # ---- Rotating keys ----
    s.append(Paragraph("Rotating or revoking your API key", styles["H1"]))
    s.append(Paragraph("Do this if your key may have leaked, or if you are leaving Goldman.", styles["Body"]))
    s.append(step(1, "Log into Simpro -&gt; API Keys page (Part 1, Step 2)."))
    s.append(step(2, "Click <b>Add</b> to create a new key, copy the new access token."))
    s.append(step(3, "Re-run <b>install.cmd</b> from the SharePoint folder. When asked for the API key, paste the new one."))
    s.append(step(4, "Quit and reopen Claude Desktop. Test the connection."))
    s.append(step(5, "Once the new key works, go back to Simpro and <b>delete</b> the old key."))

    s.append(Paragraph("If anything is unclear", styles["H1"]))
    s.append(Paragraph(
        "Contact IT (currently <b>Tayfun / Sinan</b>). Tell them: which step number you are on, the exact "
        "error message, and your Windows version. <b>Never include your Simpro API key</b> in screenshots.",
        styles["Body"]))

    doc.build(s, onFirstPage=lambda c, d: header_footer(c, d, "Individual PC Setup"),
                onLaterPages=lambda c, d: header_footer(c, d, "Individual PC Setup"))
    return out


if __name__ == "__main__":
    p1 = build_lan_pdf()
    print(f"Wrote: {p1} ({os.path.getsize(p1):,} bytes)")
    p2 = build_individual_pdf()
    print(f"Wrote: {p2} ({os.path.getsize(p2):,} bytes)")
