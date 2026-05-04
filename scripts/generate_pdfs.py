"""
Generate two coworker-facing PDF instruction documents:
  1. Goldman-Simpro-LAN-Setup.pdf       (~3 pages, post-server connect)
  2. Goldman-Simpro-Individual-Setup.pdf (~6 pages, standalone fallback)

Avoids emojis / em-dashes / Unicode that reportlab default fonts can't render.
Screenshot placeholders are clearly labeled gray boxes — Tayfun pastes real
screenshots into them later (or I can add real ones once I have access).
"""
import os
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    KeepTogether, ListFlowable, ListItem,
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER

OUTDIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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
    name="ScreenshotLabel", parent=styles["Normal"], fontSize=9, leading=12,
    alignment=TA_CENTER, textColor=colors.HexColor("#666666"), italic=True,
))


# ---------- Helpers ----------
def callout(text, kind="info"):
    """Coloured boxed note. kind: 'warning' (red), 'safe' (green), 'info' (blue)."""
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


def screenshot_placeholder(label, height_cm=4.5):
    """Gray box where a screenshot will be pasted in later."""
    inner = Paragraph(
        f"[ Screenshot placeholder ]<br/><br/><b>{label}</b><br/>"
        f"<font size=8>(Tayfun: paste real screenshot here. "
        f"Right-click box in your PDF editor and replace.)</font>",
        styles["ScreenshotLabel"],
    )
    t = Table([[inner]], colWidths=[16.0 * cm], rowHeights=[height_cm * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f0f0f0")),
        ("BOX",        (0, 0), (-1, -1), 1.2, colors.HexColor("#999999")),
        ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def step(number, body):
    return Paragraph(f"<b>{number}.</b> &nbsp;{body}", styles["StepNum"])


def trouble_table(rows):
    """rows: list of (problem, fix). Header included."""
    data = [["Problem", "Fix"]] + rows
    cell_style = ParagraphStyle(
        name="tcell", parent=styles["Normal"], fontSize=9.5, leading=13,
    )
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


def header_footer(canvas, doc, doc_title):
    canvas.saveState()
    # Header
    canvas.setFont("Helvetica-Bold", 9)
    canvas.setFillColor(colors.HexColor("#0f4c75"))
    canvas.drawString(2 * cm, A4[1] - 1.2 * cm, "Goldman Plumbing Services")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#666666"))
    canvas.drawRightString(A4[0] - 2 * cm, A4[1] - 1.2 * cm, doc_title)
    canvas.setStrokeColor(colors.HexColor("#dddddd"))
    canvas.setLineWidth(0.4)
    canvas.line(2 * cm, A4[1] - 1.4 * cm, A4[0] - 2 * cm, A4[1] - 1.4 * cm)
    # Footer
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
    title = "Connecting to the Office Simpro AI Tool"
    s = []
    s.append(Paragraph(title, styles["DocTitle"]))
    s.append(Paragraph("LAN Setup Guide for Coworkers (5 minutes)", styles["DocSubtitle"]))

    s.append(Paragraph("What this is", styles["H1"]))
    s.append(Paragraph(
        "We have set up an AI tool that lets you read and update Simpro data "
        "by chatting with Claude on your computer. This guide is for connecting "
        "to the version that runs on the office server. You do not need to "
        "install anything technical on your PC.",
        styles["Body"]))

    s.append(Paragraph("Before you start", styles["H1"]))
    s.append(Paragraph("You need three things:", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <b>Claude Desktop</b> installed on your PC. Free or Pro plan, both work.", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <b>Your own Simpro API key</b> (instructions in Part 1).", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <b>The connection details from IT</b> (Part 2): a URL and a personal access token.", styles["Body"]))
    s.append(Spacer(1, 6))
    s.append(callout(
        "Connect to the office Wi-Fi or VPN before testing. The Simpro tool only "
        "works while you are on the Goldman network.",
        kind="info"))

    # ---- Part 1 ----
    s.append(Paragraph("Part 1 - Get your own Simpro API key", styles["H1"]))
    s.append(Paragraph("Each person uses their own key so audit logs in Simpro show who did what.", styles["Body"]))
    s.append(step(1, "Log into Simpro at <b>https://goldmanplumbingservices.simprosuite.com</b>"))
    s.append(step(2, "Click the gear icon (top right) -&gt; <b>System</b> -&gt; <b>Setup</b> -&gt; <b>API Keys</b>"))
    s.append(screenshot_placeholder("Simpro: System menu showing API Keys location", 4.0))
    s.append(step(3, "Click <b>Add</b>. Name it after yourself, e.g. <i>Jane Smith - Claude Desktop</i>"))
    s.append(step(4, "Set the linked employee to <b>your own employee record</b> in Simpro"))
    s.append(step(5, "Start with <b>read-only</b> permissions. You can add edit later."))
    s.append(step(6, "Click <b>Save</b>. Simpro will show the access token. <b>COPY IT IMMEDIATELY</b> "
                     "into a private note - Simpro shows it only once."))
    s.append(screenshot_placeholder("Simpro: API Key created, access token visible", 4.0))
    s.append(callout(
        "Treat the access token like your password. Never email it, paste it in chat, "
        "or share it. If it leaks, log into Simpro and delete it.",
        kind="warning"))

    # ---- Part 2 ----
    s.append(PageBreak())
    s.append(Paragraph("Part 2 - Get connection details from IT", styles["H1"]))
    s.append(Paragraph(
        "Send your Simpro API key (from Part 1) to IT. IT will reply with two things:",
        styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <b>Connector URL</b> - looks like <font face='Courier'>http://goldman-server.local:3001/mcp</font>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <b>Your personal access token</b> - a long random string IT generates for you (different from your Simpro key)", styles["Body"]))
    s.append(callout(
        "Why two tokens? Your Simpro API key stays on the office server (IT registers it for you). "
        "Your personal access token is what your Claude Desktop sends to prove it is really you. "
        "If you change PCs or lose access, IT just regenerates the personal token without touching Simpro.",
        kind="info"))

    # ---- Part 3 ----
    s.append(Paragraph("Part 3 - Add the connector to Claude Desktop", styles["H1"]))
    s.append(step(1, "Open <b>Claude Desktop</b> on your PC."))
    s.append(step(2, "Click your profile icon (bottom left) -&gt; <b>Settings</b>."))
    s.append(step(3, "Click <b>Connectors</b> in the left sidebar."))
    s.append(step(4, "Scroll down and click <b>Add custom connector</b>."))
    s.append(screenshot_placeholder("Claude Desktop: Settings -> Connectors -> Add custom connector button", 4.5))
    s.append(step(5, "Fill in:"))
    s.append(Paragraph("&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Name:</b> Goldman Simpro", styles["StepNum"]))
    s.append(Paragraph("&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Remote MCP server URL:</b> the URL IT sent you", styles["StepNum"]))
    s.append(Paragraph("&nbsp;&nbsp;&nbsp;&nbsp;&bull; <b>Authentication:</b> choose <b>Bearer token</b> and paste the personal access token from IT", styles["StepNum"]))
    s.append(step(6, "Click <b>Add</b>. Claude Desktop should say it connected successfully."))
    s.append(screenshot_placeholder("Claude Desktop: Custom connector form filled out, before clicking Add", 5.0))
    s.append(callout(
        "Custom Connectors require Claude Pro, Team, or Enterprise plan. "
        "If your plan does not show this option, ask IT for the alternative individual setup "
        "(Plan B) instead.",
        kind="info"))

    # ---- Part 4 ----
    s.append(Paragraph("Part 4 - Test it", styles["H1"]))
    s.append(Paragraph("In Claude Desktop, type:", styles["Body"]))
    s.append(Paragraph(
        "<font face='Courier'>Use Simpro Plumbing to test the connection.</font>",
        styles["MyCode"]))
    s.append(Paragraph("You should see something like:", styles["Body"]))
    s.append(Paragraph(
        '"Simpro connection OK. Base URL: https://goldmanplumbingservices.simprosuite.com, '
        "Company ID: 4...\"",
        styles["Body"]))
    s.append(Paragraph("If you see this - <b>everything works</b>. Try other prompts:", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to find customers named Goldman.</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to find recent jobs.</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Energy to test the connection.</i> (if you also need Goldman Energy)", styles["Body"]))

    # ---- Safety ----
    s.append(Paragraph("Safety - what is on and off by default", styles["H1"]))
    s.append(Paragraph(
        "When you connect for the first time, Claude can <b>read</b> Simpro data (search, view) "
        "but cannot <b>change</b> anything. This is on purpose.",
        styles["Body"]))
    s.append(callout(
        "Writes (create, update) are off by default. To enable them later, ask IT - "
        "they will turn it on for your token. Even then, every write requires you to "
        "say 'confirm true' and Claude will show you what it is about to do before sending.",
        kind="safe"))

    # ---- Troubleshooting ----
    s.append(PageBreak())
    s.append(Paragraph("Common problems and fixes", styles["H1"]))
    s.append(trouble_table([
        ("Claude Desktop does not show the Goldman Simpro connector",
         "Restart Claude Desktop completely - right-click the icon in the system tray "
         "(near the clock, bottom right) and click <b>Quit</b>. Wait 3 seconds, reopen."),
        ("Connector says 'connection failed' or 'cannot reach server'",
         "Check you are on the office Wi-Fi or VPN. The server is only reachable inside Goldman's network."),
        ("Connector says 'unauthorized' or '401'",
         "Your personal access token is wrong, expired, or has been revoked. Ask IT to regenerate it."),
        ("'Vendor order not found' or 'Customer not found' errors",
         "You are probably searching the wrong company. The tenant has Plumbing (default) and Energy. "
         "Try saying <i>'Use Simpro Energy to...'</i> for Energy records."),
        ("Claude finds zero quotes for a customer that clearly has quotes",
         "Claude searched the wrong field. Phrase it as: <i>'Use Simpro to find quotes for customer "
         "[name]'</i> rather than putting the name as a keyword."),
        ("Anything else", "Send IT a screenshot of the error. Never include your access token in the screenshot."),
    ]))

    s.append(Paragraph("If anything is unclear", styles["H1"]))
    s.append(Paragraph(
        "Contact IT (currently Tayfun / Sinan). Send a screenshot of what you tried and what "
        "Claude said. <b>Never include your Simpro API key or personal access token</b> in the screenshot - "
        "blur it or crop it out first.",
        styles["Body"]))

    doc.build(s, onFirstPage=lambda c, d: header_footer(c, d, "LAN Setup Guide"),
                onLaterPages=lambda c, d: header_footer(c, d, "LAN Setup Guide"))
    return out


# =============================================================================
# DOC 2: INDIVIDUAL PC SETUP
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
    s.append(Paragraph("Individual PC Setup Guide (15-20 minutes)", styles["DocSubtitle"]))

    s.append(Paragraph("What this is", styles["H1"]))
    s.append(Paragraph(
        "This guide installs the Goldman Simpro AI tool directly on your PC. Use this "
        "guide if the office server version is unavailable, or if you need to work "
        "from outside the office without VPN.",
        styles["Body"]))
    s.append(callout(
        "If you have access to the office LAN setup (your IT person sent you a connector URL "
        "and token), use that instead - it is much simpler. Use this guide only as a fallback "
        "or if you specifically need to work offline.",
        kind="info"))

    s.append(Paragraph("Time and prerequisites", styles["H1"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; About 15-20 minutes the first time.", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; Windows 10 or 11.", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; Claude Desktop installed (free plan is fine).", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; Permission to install Node.js (you may need to ask IT).", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; The shared installer folder from IT.", styles["Body"]))

    # ---- Part 1: API key ----
    s.append(Paragraph("Part 1 - Create your own Simpro API key", styles["H1"]))
    s.append(Paragraph(
        "Each person uses their own key so audit logs in Simpro show who did what. "
        "Never share keys. If you leave Goldman, IT just deletes your key.",
        styles["Body"]))
    s.append(step(1, "Log into Simpro at <b>https://goldmanplumbingservices.simprosuite.com</b>"))
    s.append(step(2, "Click the gear icon (top right) -&gt; <b>System</b> -&gt; <b>Setup</b> -&gt; <b>API Keys</b>"))
    s.append(screenshot_placeholder("Simpro: API Keys page location in System menu", 4.0))
    s.append(step(3, "Click <b>Add</b>, name the key after yourself (e.g. <i>Jane Smith - Claude Desktop</i>)."))
    s.append(step(4, "Set the linked employee to your own employee record."))
    s.append(step(5, "Start with read-only permissions for the first week."))
    s.append(step(6, "Click <b>Save</b>. Simpro shows the access token. <b>COPY IT NOW</b> "
                     "into a private note - it is only shown once."))
    s.append(callout(
        "Treat the access token like your password. Never share it, never email it, "
        "never paste it in chat. If it leaks, delete it in Simpro and create a new one.",
        kind="warning"))

    # ---- Part 2: Node.js ----
    s.append(PageBreak())
    s.append(Paragraph("Part 2 - Install Node.js", styles["H1"]))
    s.append(Paragraph("This is the engine that runs the Simpro tool. One-time install.", styles["Body"]))
    s.append(step(1, "Open <b>https://nodejs.org</b> in your browser."))
    s.append(step(2, "Click the big green <b>LTS</b> button on the left to download the .msi installer."))
    s.append(screenshot_placeholder("nodejs.org homepage with the green LTS button highlighted", 4.5))
    s.append(step(3, "Run the installer. Click <b>Next, Next, Next, Install</b>. Defaults are fine."))
    s.append(step(4, "<b>Restart your PC</b> after the install completes."))
    s.append(step(5, "Verify: open the <b>Start menu</b>, type <i>PowerShell</i>, press Enter, then type:"))
    s.append(Paragraph("<font face='Courier'>node --version</font>", styles["MyCode"]))
    s.append(Paragraph("It should print a version number like <font face='Courier'>v20.11.0</font>. "
                       "If it does, close PowerShell - Part 2 is done.", styles["Body"]))

    # ---- Part 3: get folder ----
    s.append(Paragraph("Part 3 - Get the installer folder from IT", styles["H1"]))
    s.append(Paragraph(
        "IT will share a OneDrive or network folder containing the compiled tool plus "
        "an <b>install.cmd</b> file. Sync or copy that folder to your PC. The exact location "
        "does not matter - the installer handles paths automatically.",
        styles["Body"]))
    s.append(callout(
        "If you do not have access to the share folder, ask IT (currently Tayfun / Sinan). "
        "The folder is too big to email - it will be a OneDrive link or a copy on a USB stick.",
        kind="info"))
    s.append(screenshot_placeholder("File Explorer: contents of the share folder showing install.cmd", 4.0))

    # ---- Part 4: install ----
    s.append(Paragraph("Part 4 - Run the installer", styles["H1"]))
    s.append(step(1, "Open the installer folder you got in Part 3."))
    s.append(step(2, "<b>Double-click</b> the file named <font face='Courier'><b>install.cmd</b></font>."))
    s.append(callout(
        "Windows may show a blue 'Windows protected your PC' warning the first time. "
        "Click <b>More info</b> then <b>Run anyway</b>. The script is from your IT team.",
        kind="info"))
    s.append(step(3, "When the script asks for your <b>Simpro API key</b>, paste the access token from Part 1."))
    s.append(step(4, "When it asks which company, type <b>3</b> for both Plumbing and Energy "
                     "(or 1 for Plumbing only, 2 for Energy only)."))
    s.append(step(5, "Wait about 30 seconds. The script copies the tool, configures Claude Desktop, "
                     "and tells you it is done."))
    s.append(screenshot_placeholder("PowerShell window showing 'All done' message at end of install", 4.5))

    # ---- Part 5: restart Claude ----
    s.append(PageBreak())
    s.append(Paragraph("Part 5 - Restart Claude Desktop properly", styles["H1"]))
    s.append(callout(
        "Just closing the Claude Desktop window is not enough. You must <b>Quit</b> "
        "from the system tray (the small icons near the clock).",
        kind="warning"))
    s.append(step(1, "Look at the bottom-right of your screen, near the clock."))
    s.append(step(2, "Find the <b>Claude icon</b>. You may need to click the small up-arrow "
                     "to expand the hidden tray icons."))
    s.append(step(3, "<b>Right-click</b> the Claude icon."))
    s.append(step(4, "Click <b>Quit</b>."))
    s.append(screenshot_placeholder("Windows system tray with Claude icon right-click menu showing Quit", 4.5))
    s.append(step(5, "Wait 3 seconds, then open Claude Desktop again from the Start menu."))

    # ---- Part 6: test ----
    s.append(Paragraph("Part 6 - Test it works", styles["H1"]))
    s.append(step(1, "In Claude Desktop, click the small <b>tools / hammer icon</b> near the message box. "
                     "You should see two entries: <i>simpro_plumbing</i> and <i>simpro_energy</i>."))
    s.append(screenshot_placeholder("Claude Desktop tools menu showing simpro_plumbing and simpro_energy", 4.0))
    s.append(step(2, "Type into the chat:"))
    s.append(Paragraph("<font face='Courier'>Use Simpro Plumbing to test the connection.</font>", styles["MyCode"]))
    s.append(step(3, "You should see: <i>'Simpro connection OK. Base URL... Company ID: 4...'</i>"))
    s.append(step(4, "Try the other one to confirm both work:"))
    s.append(Paragraph("<font face='Courier'>Use Simpro Energy to test the connection.</font>", styles["MyCode"]))
    s.append(Paragraph("This one should report <b>Company ID: 37</b>. If both work, you are done.", styles["Body"]))

    s.append(Paragraph("More things to try", styles["H2"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to search for customers named Goldman.</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to find recent jobs.</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Plumbing to list line items for purchase order [number].</i>", styles["Body"]))
    s.append(Paragraph("&nbsp;&nbsp;&bull; <i>Use Simpro Energy to find supplier invoices from Reece in May 2026.</i>", styles["Body"]))

    # ---- Part 7: writes ----
    s.append(PageBreak())
    s.append(Paragraph("Part 7 - Turning on writes (later, when you are ready)", styles["H1"]))
    s.append(Paragraph(
        "After a few days of comfortable read-only use, you can let Claude create or update "
        "Simpro records. Do this in two stages.",
        styles["Body"]))

    s.append(Paragraph("Stage 1 - Dry run (safe preview)", styles["H2"]))
    s.append(Paragraph(
        "Ask IT to flip <i>SIMPRO_ENABLE_WRITE_TOOLS</i> to true while keeping <i>SIMPRO_DRY_RUN</i> "
        "true. From then on, when you ask Claude to update something, it will <b>show you what it would do</b> "
        "but not actually send it. Read each preview carefully.",
        styles["Body"]))
    s.append(callout(
        "Every write also requires <i>confirm: true</i>. If you forget, Claude returns a confirmation "
        "request instead of doing anything. Two safety layers, on purpose.",
        kind="safe"))

    s.append(Paragraph("Stage 2 - Real writes", styles["H2"]))
    s.append(Paragraph(
        "Once you are confident, ask IT to flip <i>SIMPRO_DRY_RUN</i> to false. Now writes really happen. "
        "Start small - add a note to a test job before doing anything bulk. If anything feels wrong, "
        "ask IT to flip the switch back, and writes stop immediately.",
        styles["Body"]))

    # ---- Troubleshooting ----
    s.append(Paragraph("Common problems and fixes", styles["H1"]))
    s.append(trouble_table([
        ("Claude Desktop does not show the simpro tools",
         "You did not fully Quit Claude Desktop. Right-click tray icon -&gt; Quit. Wait 3 seconds. Reopen."),
        ("'401 Unauthorized' or 'API key invalid'",
         "Your Simpro API key is wrong, expired, or was deleted. Generate a new one in Simpro (Part 1) "
         "and re-run install.cmd to update it."),
        ("'403 Forbidden'",
         "The key works but lacks permission. In Simpro, edit your API key and grant the missing permission."),
        ("'404 Not Found' on every request",
         "Wrong company. Goldman Plumbing = ID 4, Goldman Energy = ID 37. Try the other one."),
        ("'Write tools are disabled'",
         "Safety guard. Ask IT to enable writes for you (see Part 7)."),
        ("'Confirmation required'",
         "Add <i>confirm: true</i> to your request, or tell Claude <i>'...and confirm true'</i>."),
        ("'Could not reach Simpro'",
         "Check you can open https://goldmanplumbingservices.simprosuite.com in your browser. "
         "If the office is on VPN, connect to it."),
        ("Anything else",
         "Send IT a screenshot of the error. Never include your API key in the screenshot."),
    ]))

    # ---- Rotating keys ----
    s.append(Paragraph("Rotating or revoking your API key", styles["H1"]))
    s.append(Paragraph("Do this if your key may have leaked, or if you are leaving Goldman.", styles["Body"]))
    s.append(step(1, "Log into Simpro -&gt; API Keys page (Part 1, Step 2)."))
    s.append(step(2, "Click <b>Add</b> to create a new key, copy the new access token."))
    s.append(step(3, "Re-run <b>install.cmd</b> on your PC. When asked for the API key, paste the new one."))
    s.append(step(4, "Quit and reopen Claude Desktop, test the connection."))
    s.append(step(5, "Once the new key works, go back to Simpro and <b>delete</b> the old key."))

    s.append(Paragraph("If anything is unclear", styles["H1"]))
    s.append(Paragraph(
        "Contact IT (currently Tayfun / Sinan). Tell them: which step number you are on, the exact "
        "error message you see, and your Windows version (right-click <i>This PC</i> -&gt; Properties). "
        "<b>Never include your Simpro API key</b> in screenshots - blur it out first.",
        styles["Body"]))

    doc.build(s, onFirstPage=lambda c, d: header_footer(c, d, "Individual PC Setup"),
                onLaterPages=lambda c, d: header_footer(c, d, "Individual PC Setup"))
    return out


if __name__ == "__main__":
    p1 = build_lan_pdf()
    print(f"Wrote: {p1} ({os.path.getsize(p1):,} bytes)")
    p2 = build_individual_pdf()
    print(f"Wrote: {p2} ({os.path.getsize(p2):,} bytes)")
