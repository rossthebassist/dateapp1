var client = ZAFClient.init();

const VIEW_ID = 6288185996831;
const MAX_PARALLEL = 5;

let analysedTickets = [];
let confirmedTickets = [];
let stopRequested = false;

// -------------------- Helpers for fleet evidence, tentative detection, date and reg extraction --------------------

/**
 * Conservative detection of original fleet booking evidence in a thread.
 * Pass an optional snippet that reliably appears in your Fleet emails (e.g. "no_reply@nhsfleetsolutions.co.uk").
 */
function hasOriginalFleetBookingEvidence(threadText, ourExampleSnippet) {
  if (!threadText) return false;
  const text = threadText.toLowerCase();

  if (ourExampleSnippet && text.includes(ourExampleSnippet.toLowerCase())) return true;

  const fleetPatterns = [
    "return_notify_leaseco",
    "collection request for",
    "collection request",
    "please can the above vehicle be booked in",
    "please can the above vehicle be booked",
    "please can the above vehicle be booked in for collection",
    "nhs fleet solutions",
    "no_reply@nhsfleetsolutions.co.uk",
    "no-reply@nhsfleetsolutions.co.uk",
    "fleet.vehiclereturns@",
    "collection request -",
    "collection request for"
  ];

  const partnerFleetRequestPhrases = [
    "i can confirm i have requested the collection",
    "i can confirm i have requested the collection for",
    "you will receive a confirmation email to",
    "you will receive a confirmation email"
  ];

  const hasFleetPattern = fleetPatterns.some(p => text.includes(p));
  const hasPartnerPattern = partnerFleetRequestPhrases.some(p => text.includes(p));

  return hasFleetPattern || hasPartnerPattern;
}

/**
 * More precise tentative detection: only flags true pending-confirmation language.
 * - threadText: full concatenated thread (string)
 * - messages: optional array of message objects [{ author, from, body }] to allow per-message author-aware matching
 * Returns: { tentative: boolean, snippet: string|null, author: string|null }
 */
function detectTentativeLanguage(threadText, messages = []) {
  if (!threadText) return { tentative: false, snippet: null, author: null };
  const text = threadText.toLowerCase();

  // Strong tentative regexes that indicate awaiting confirmation / conditional status
  const tentativeRegexes = [
    /\bwill\s+confirm\b/i,
    /\bwill\s+advise\b/i,
    /\bonce\s+i\s+have\s+an\s+update\b/i,
    /\bawait(?:ing)?\s+confirmation\b/i,
    /\bto\s+be\s+confirmed\b/i,
    /\bawait\s+confirmation\s+from\b/i,
    /\bpending\s+confirmation\b/i,
    /\babortive\s+fee\s+may\s+apply\b/i,
    /\bmay\s+apply\b/i,
    /\bwill\s+confirm\b.*\b(bca|agent|third-?party)\b/i,
    /\bbca\s+will\s+confirm\b/i
  ];

  // Informational template phrases we should ignore (common non-pending templates)
  const ignoreRegexes = [
    /\bwill\s+contact\s+you\s+by\s+phone\b/i,
    /\bwill\s+contact\s+you\s+by\s+phone\s+or\s+text\b/i,
    /\bthe\s+inspector\s+will\s+call\b/i,
    /\bwill\s+call\s+again\s+when\s+they\s+are\s+outside\b/i,
    /\ball inspectors will carry appropriate identification\b/i,
    /\bcontact numbers for the day of collection\b/i
  ];

  // Helper: checks a body string for tentative matches while ignoring template matches
  function findTentativeInBody(body) {
    const lower = (body || "").toLowerCase();
    for (const re of tentativeRegexes) {
      const m = lower.match(re);
      if (m) {
        const idx = m.index || lower.indexOf(m[0]);
        const start = Math.max(0, idx - 60);
        const snippet = lower.substring(start, start + 200).trim();
        return { matched: true, snippet };
      }
    }
    return { matched: false, snippet: null };
  }

  // If message-level data available, prefer that (so we can capture author)
  if (Array.isArray(messages) && messages.length) {
    for (const m of messages) {
      const body = m.body || m.content || "";
      // Skip purely informational template lines unless a true tentative regex also matches
      const ignored = ignoreRegexes.some(re => re.test(body));
      const tentativeMatch = findTentativeInBody(body);
      if (tentativeMatch.matched) {
        // If the match is only an ignore-like phrase, continue scanning
        const isInformationalOnly = ignored && tentativeRegexes.every(tr => {
          return !tr.test(body);
        });
        if (isInformationalOnly) {
          continue;
        }
        const author = (m.author && (m.author.name || m.author.email)) || m.from || null;
        return { tentative: true, snippet: tentativeMatch.snippet, author };
      }
    }
  }

  // Fallback: check whole thread, but remove known informational templates before checking
  let cleaned = text;
  for (const ign of ignoreRegexes) {
    try { cleaned = cleaned.replace(ign, ' '); } catch (e) { /* ignore */ }
  }
  for (const re of tentativeRegexes) {
    const m = cleaned.match(re);
    if (m) {
      const idx = m.index || cleaned.indexOf(m[0]);
      const start = Math.max(0, idx - 60);
      const snippet = cleaned.substring(start, start + 200).trim();
      return { tentative: true, snippet, author: null };
    }
  }

  return { tentative: false, snippet: null, author: null };
}

/**
 * Simple strong-positive lease confirmation detector.
 * - messages: array of message objects [{ author, from, body }]
 * Returns: { confirmed: boolean, snippet: string|null, author: string|null, messageBody: string|null }
 */
function detectLeaseConfirmation(messages = []) {
  if (!Array.isArray(messages) || !messages.length) return { confirmed: false, snippet: null, author: null, messageBody: null };

  const confirmationRegexes = [
    /\bwe\s+are\s+pleased\s+to\s+confirm\b/i,
    /\bcollection\s+confirmed\b/i,
    /\bwe\s+confirm\b/i,
    /\bcollection\s+date[:\s]/i,
    /\bcollection\s+details\s+for\b/i,
    /\bwe\s+have\s+booked\s+collection\b/i
  ];

  for (const m of messages) {
    const body = (m.body || m.content || "").toLowerCase();
    for (const re of confirmationRegexes) {
      const match = body.match(re);
      if (match) {
        const idx = match.index || body.indexOf(match[0]);
        const start = Math.max(0, idx - 60);
        const snippet = body.substring(start, start + 200).trim();
        const author = (m.author && (m.author.name || m.author.email)) || m.from || null;
        return { confirmed: true, snippet, author, messageBody: m.body || m.content || null };
      }
    }
  }
  return { confirmed: false, snippet: null, author: null, messageBody: null };
}

/**
 * Optionally detect whether a message appears to be from NHS Fleet (heuristic).
 */
function isFromFleetMessage(m) {
  if (!m) return false;
  const email = (m.author && m.author.email) || m.from || "";
  const body = (m.body || m.content || "").toLowerCase();
  if (!email && !body) return false;
  const e = (email || "").toLowerCase();
  if (e.includes("nhsfleetsolutions") || e.includes("fleet.vehiclereturns") || e.includes("no_reply@nhsfleetsolutions")) return true;
  if (body.includes("collection request for") || body.includes("office use only: return_notify_leaseco") || body.includes("please can the above vehicle be booked in")) return true;
  return false;
}

/**
 * Extract the first plausible date and normalise to DD/MM/YYYY.
 */
function extractFirstDateNormalized(text) {
  if (!text) return null;
  // bracketed or unbracketed dd.mm.yyyy or dd/mm/yyyy or dd-mm-yyyy
  let m = text.match(/\[?\b([0-3]?\d)[\/\.\-]([0-1]?\d)[\/\.\-](20\d{2})\]?\b/);
  if (m) {
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    const y = m[3];
    return `${d}/${mo}/${y}`;
  }

  // dd/mm/yyyy without brackets
  m = text.match(/\b([0-3]?\d)[\/\.\-]([0-1]?\d)[\/\.\-](20\d{2})\b/);
  if (m) {
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    const y = m[3];
    return `${d}/${mo}/${y}`;
  }

  // D Month YYYY
  m = text.match(/\b([0-3]?\d)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  if (m) {
    const day = m[1].padStart(2, "0");
    const monthName = m[2].toLowerCase();
    const year = m[3];
    const monthMap = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
      january: "01", february: "02", march: "03", april: "04", june: "06",
      july: "07", august: "08", september: "09", october: "10", november: "11", december: "12"
    };
    const mo = monthMap[monthName.slice(0,3)] || "01";
    return `${day}/${mo}/${year}`;
  }

  return null;
}

/**
 * Simple registration extractor (best-effort). Returns first match for common UK formats.
 */
function extractRegistrationFromThread(text) {
  if (!text) return "";
  const t = text.replace(/\s+/g, " ");
  // modern UK format AA11AAA
  let m = t.match(/\b([A-Z]{2}[0-9]{2}\s?[A-Z]{3})\b/i);
  if (m) return m[1].toUpperCase().replace(/\s+/g, " ");
  // older Northern Ireland style or other variants
  m = t.match(/\b([A-Z]{3}[0-9]{4})\b/i);
  if (m) return m[1].toUpperCase();
  // casual space-separated like NA74 TST
  m = t.match(/\b([A-Z]{1,3}[0-9]{1,3}\s?[A-Z]{1,3})\b/i);
  if (m) return m[1].toUpperCase().replace(/\s+/g, " ");
  return "";
}

// -------------------- End helpers --------------------

document.addEventListener("DOMContentLoaded", () => {

    document
        .getElementById("analyseBtn")
        .addEventListener("click", analyseView);

    document
        .getElementById("stopBtn")
        .addEventListener("click", () => {
            stopRequested = true;
        });

    document
        .getElementById("closeSelectedBtn")
        .addEventListener("click", closeSelected);

    document
        .getElementById("closeAllBtn")
        .addEventListener("click", closeAllConfirmed);

    const exportBtn =
        document.getElementById("exportBtn");

    if (exportBtn) {
        exportBtn.addEventListener(
            "click",
            exportCSV
        );
    }

    const showAllBtn =
        document.getElementById(
            "showAllBtn"
        );

    if (showAllBtn) {
        showAllBtn.addEventListener(
            "click",
            showAllTickets
        );
    }

    initialiseFilters();
});

async function analyseView() {

    try {

        stopRequested = false;

        resetDashboard();

        updateProgress(
            0,
            "Loading tickets..."
        );

        let tickets = [];
        let nextUrl =
            `/api/v2/views/${VIEW_ID}/tickets.json`;

        while (nextUrl) {

            const response =
                await client.request({
                    url: nextUrl,
                    type: "GET"
                });

            if (response.tickets) {

                tickets = tickets.concat(
                    response.tickets
                );
            }

if (response.next_page) {

    nextUrl =
        response.next_page.replace(
            "https://fleetsolutions.zendesk.com",
            ""
        );

} else {

    nextUrl = null;
}
        }

        tickets = tickets.filter(
            ticket => ticket.status !== "solved"
        );

        if (!tickets.length) {

            updateProgress(
                100,
                "No active tickets found"
            );

            return;
        }

        updateResultsCount(
            `${tickets.length} tickets found`
        );

        let processed = 0;

        for (
            let i = 0;
            i < tickets.length;
            i += MAX_PARALLEL
        ) {

            if (stopRequested) {

                updateProgress(
                    0,
                    `Stopped after ${processed} tickets`
                );

                break;
            }

            const batch =
                tickets.slice(
                    i,
                    i + MAX_PARALLEL
                );

            await Promise.all(

                batch.map(
                    async ticket => {

                        try {

                            const comments =
                                await client.request({
                                    url: `/api/v2/tickets/${ticket.id}/comments.json`,
                                    type: "GET"
                                });

                            const messages = comments.comments || [];

                            const result =
                                await classifyTicket(
                                    messages
                                );

                            analysedTickets.push({
                                ticket,
                                result
                            });

                            renderTicket(
                                ticket,
                                result
                            );

                        }
                        catch (err) {

                            console.error(
                                "Ticket error",
                                ticket.id,
                                err
                            );
                        }
                        finally {

                            processed++;

                            const percent =
                                Math.round(
                                    (
                                        processed /
                                        tickets.length
                                    ) * 100
                                );

                            updateProgress(
                                percent,
                                `${processed} of ${tickets.length} analysed`
                            );
                        }
                    }
                )
            );
        }

        if (!stopRequested) {

            updateProgress(
                100,
                `Analysis complete (${processed} tickets)`
            );
        }

    }
    catch (err) {

        console.error(err);

        alert(
            "Error analysing tickets. Check browser console."
        );
    }
}

function initialiseFilters() {

    document
        .querySelectorAll(".summary .card")
        .forEach(card => {

            card.addEventListener(
                "click",
                () => {

                    const filter =
                        card.dataset.filter;

                    document
                        .querySelectorAll(".summary .card")
                        .forEach(c =>
                            c.classList.remove("active")
                        );

                    card.classList.add("active");

                    document
                        .querySelectorAll(".ticketCard")
                        .forEach(ticket => {

                            if (
                                ticket.dataset.status === filter
                            ) {

                                ticket.style.display = "";

                            } else {

                                ticket.style.display = "none";
                            }
                        });
                }
            );
        });
}

function showAllTickets() {

    document
        .querySelectorAll(".summary .card")
        .forEach(card =>
            card.classList.remove("active")
        );

    document
        .querySelectorAll(".ticketCard")
        .forEach(ticket =>
            ticket.style.display = ""
        );
}

function resetDashboard() {

    analysedTickets = [];
    confirmedTickets = [];

    document.getElementById(
        "ticketContainer"
    ).innerHTML = "";

    document.getElementById(
        "confirmedCount"
    ).innerText = "0";

    document.getElementById(
        "failedCount"
    ).innerText = "0";

    document.getElementById(
        "reviewCount"
    ).innerText = "0";

    updateResultsCount(
        "No tickets analysed"
    );

    updateProgress(
        0,
        "Ready"
    );
}

async function classifyTicket(messages) {

    // Build thread text from messages
    const threadText = (Array.isArray(messages) ? messages.map(m => m.body || m.content || "").join("\n\n") : (messages || ""));

    // Detect tentative language that requires review regardless
    const tentative = detectTentativeLanguage(threadText, messages);

    // Detect strong lease confirmation phrases
    const leaseConfirm = detectLeaseConfirmation(messages);

    // Pre-check for fleet/agent evidence. Pass a reliable snippet for quoted matching.
    const fleetEvidenceFound = hasOriginalFleetBookingEvidence(threadText, "no_reply@nhsfleetsolutions.co.uk");

    // Extract lease date for reviewer context
    const leaseDate = extractFirstDateNormalized(threadText);

    // Extract registration for context if possible
    const regCandidate = extractRegistrationFromThread(threadText);

    // If tentative language exists but there is also a clear lease confirmation and fleet evidence, allow further processing; otherwise short-circuit to REVIEW
    if (tentative.tentative) {
      if (!(leaseConfirm.confirmed && fleetEvidenceFound)) {
        return {
          registration: regCandidate || "",
          fleet_request_found: false,
          category: "",
          status: "Review Required",
          fleet_booked_date: "",
          lease_company_date: leaseDate || "",
          confidence: 70,
          review_required: true,
          summary: tentative.snippet ? `${tentative.snippet} — pending confirmation from third-party; review required.` : "Pending third-party confirmation; review required.",
          reason: "Awaiting third-party confirmation"
        };
      }
      // else: we have both tentative phrasing somewhere AND a clear lease confirmation + fleet evidence; allow AI to resolve nuance
    }

    if (!fleetEvidenceFound) {
        // Short-circuit to REVIEW (do not call the AI) but provide useful context
        return {
            registration: regCandidate || "",
            fleet_request_found: false,
            category: "",
            status: "Review Required",
            fleet_booked_date: "",
            lease_company_date: leaseDate || "",
            confidence: 70,
            review_required: true,
            summary: leaseDate ? `Lease confirms collection for ${leaseDate} but fleet request not found; review required.` : "Lease confirms collection but fleet request not found; review required.",
            reason: "Fleet request not found"
        };
    }

    // Fleet evidence exists -> proceed to call AI
    const response =
        await fetch(
            AI_CONFIG.ENDPOINT,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "api-key":
                        AI_CONFIG.KEY
                },
                body: JSON.stringify({
                    messages: [
                        {
                            role: "system",
                            content: AI_PROMPT
                        },
                        {
                            role: "user",
                            content: threadText
                        }
                    ],
                    temperature: 0,
                    max_tokens: 1000
                })
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        console.error(
            "AI Error",
            data
        );

        throw new Error(
            data.error?.message ||
            "AI request failed"
        );
    }

    if (
        !data.choices ||
        !data.choices.length
    ) {

        throw new Error(
            "No AI response returned"
        );
    }

    let content =
        data.choices[0].message.content
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

    let result = {};
    try {
        result = JSON.parse(content);
    } catch (e) {
        console.error('Failed to parse AI JSON output', e, content);
        throw new Error('AI returned invalid JSON');
    }

    // If AI returned Confirmed but tentative language exists and we do NOT have a strong lease confirmation + fleet evidence, override to Review Required
    if (result.status === "Confirmed") {
      const tentativeAfter = detectTentativeLanguage(threadText, messages);
      const leaseConfirmAfter = detectLeaseConfirmation(messages);
      if (tentativeAfter.tentative && !(leaseConfirmAfter.confirmed && fleetEvidenceFound)) {
        result.status = "Review Required";
        result.review_required = true;
        result.confidence = 70;
        result.reason = "Awaiting third-party confirmation";
        result.summary = tentativeAfter.snippet ? `${tentativeAfter.snippet} — pending confirmation from third-party; review required.` : "Pending third-party confirmation; review required.";
      }
    }

    // Safety check: no Fleet request means no automatic confirmation
    if (
        result.status === "Confirmed" &&
        result.fleet_request_found === false
    ) {

        result.status =
            "Review Required";

        result.review_required =
            true;

        result.confidence =
            70;

        result.reason =
            "Fleet request not found";
    }

    // Validate registration locally (existing behaviour)
    const reg =
        (result.registration || "")
            .replace(/\s+/g, "")
            .toUpperCase();

    const validStandard =
        /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(reg);

    const validNI =
        /^[A-Z]{3}[0-9]{4}$/.test(reg);

    result.registration_valid =
        validStandard ||
        validNI;

    if (
        result.registration &&
        !result.registration_valid
    ) {

        result.status =
            "Review Required";

        result.review_required =
            true;

        result.confidence =
            70;

        result.reason =
            "Possible private registration detected";
    }

    return result;
}

function renderTicket(ticket, result) {

    const container =
        document.getElementById(
            "ticketContainer"
        );

    let status =
        result.status ||
        "Review Required";

    if (
        result.confidence < 80 &&
        status !== "Failed Booking"
    ) {
        status = "Review Required";
    }

    if (result.review_required) {
        status = "Review Required";
    }

    let cardClass =
        "reviewCard";

    let badgeClass =
        "statusReview";

    switch (status) {

case "Confirmed":
    cardClass =
        "confirmedCard";
    badgeClass =
        "statusConfirmed";

    confirmedTickets.push(
        ticket.id
    );

    ticket.analysisResult =
        result;

    break;

        case "Failed Booking":
            cardClass =
                "failedCard";
            badgeClass =
                "statusFailed";
            break;
    }

const evidenceHtml =
    result.summary ||
    result.reason ||
    "No summary returned";

    const card =
        document.createElement(
            "div"
        );

    card.className =
        `ticketCard ${cardClass}`;

    card.dataset.status =
        status;

    console.log(
        "Ticket Status:",
        ticket.id,
        status
    );

    card.innerHTML = `
        <div class="ticketHeader">

            <div>

                ${
                    status === "Confirmed"
                    ? `
                    <input
                        type="checkbox"
                        class="ticketCheckbox"
                        value="${ticket.id}">
                    `
                    : ""
                }

                <span
                    class="ticketNumber"
                    data-ticket-id="${ticket.id}">

                    #${ticket.id}

                </span>

            </div>

            <span class="statusBadge ${badgeClass}">
                ${status}
            </span>

        </div>

        <div class="ticketGrid">

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Registration
                </div>
                <div class="ticketFieldValue">
                    ${result.registration || "-"}
                </div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Confidence
                </div>
                <div class="ticketFieldValue">
                    ${result.confidence || 0}%
                </div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Fleet Date
                </div>
                <div class="ticketFieldValue">
                    ${result.fleet_booked_date || "-"}
                </div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Lease Date
                </div>
                <div class="ticketFieldValue">
                    ${result.lease_company_date || "-"}
                </div>
            </div>

        </div>

        <div class="evidenceBox">
<div class="evidenceTitle">
    Summary
</div>
            ${evidenceHtml}
        </div>
    `;

    container.appendChild(card);

    const ticketLink =
        card.querySelector(
            ".ticketNumber"
        );

    ticketLink.style.cursor =
        "pointer";

    ticketLink.addEventListener(
        "click",
        async () => {

            console.log(
                "Opening ticket",
                ticket.id
            );

            try {

                await client.invoke(
                    "routeTo",
                    "ticket",
                    ticket.id
                );

            } catch (err) {

                console.error(
                    "routeTo failed",
                    err
                );

                window.top.location.href =
                    `/agent/tickets/${ticket.id}`;
            }

        }
    );

    updateCounters(status);

    updateResultsCount(
        `${analysedTickets.length} tickets analysed`
    );
}

function updateCounters(status) {

    if (status === "Confirmed") {
        increment("confirmedCount");
        return;
    }

    if (status === "Failed Booking") {
        increment("failedCount");
        return;
    }

    increment("reviewCount");
}

function increment(id) {

    const el =
        document.getElementById(id);

    if (!el) return;

    el.innerText =
        parseInt(
            el.innerText,
            10
        ) + 1;
}

function updateProgress(percent, text) {

    document.getElementById(
        "progressFill"
    ).style.width =
        `${percent}%`;

    document.getElementById(
        "progressText"
    ).innerText =
        text;
}

function updateResultsCount(text) {

    document.getElementById(
        "resultsCount"
    ).innerText =
        text;
}

async function closeSelected() {

    const selected =
        document.querySelectorAll(
            ".ticketCheckbox:checked"
        );

    for (const checkbox of selected) {

        await solveTicket(
            checkbox.value
        );
    }

    alert(
        `${selected.length} ticket(s) closed`
    );
}

async function closeAllConfirmed() {

    const total =
        confirmedTickets.length;

    for (
        const ticketId of [...confirmedTickets]
    ) {

        await solveTicket(
            ticketId
        );
    }

    alert(
        `${total} confirmed ticket(s) closed`
    );
}

function formatUkDate(dateString) {

    if (!dateString) {
        return "";
    }

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateString)) {
        return dateString;
    }

    const date = new Date(dateString);

    if (isNaN(date)) {
        return dateString;
    }

    return date.toLocaleDateString("en-GB");
}

function getCategoryValue(result) {

    if (!result) {
        return "lease_company_confirmation";
    }

    const category =
        result.category ||
        "Lease Company Confirmation";

    switch (category) {

        case "Customer Amendments":
            return "customer_ammendments";

        case "Customer Cancelation":
            return "customer_cancelation";

        case "Aborted Collection":
            return "aborted_collection";

        case "Lease Company Date Change":
            return "lease_company_date_change";

        case "Lease Company Confirmation":
        default:
            return "lease_company_confirmation";
    }
}

async function solveTicket(ticketId) {

    try {

        const analysed =
            analysedTickets.find(
                t =>
                    String(t.ticket.id) ===
                    String(ticketId)
            );

if (!analysed) {

    console.error(
        "Analysis not found",
        ticketId
    );

    return;
}

if (analysed.closed) {

    console.log(
        `Ticket ${ticketId} already closed`
    );

    return;
}

        const result =
            analysed.result;

        const fleetDate =
            formatUkDate(
                result.fleet_booked_date
            );

        const leaseDate =
            formatUkDate(
                result.lease_company_date
            );

        const categoryValue =
            getCategoryValue(result);

        let internalNote =
            "Ticket closed automatically by Collection App.";

if (
    result.category ===
    "Lease Company Date Change"
) {

    internalNote =
        `Ticket closed: Fleet requested ${fleetDate} and the lease company confirmed an amended collection date of ${leaseDate}.`;

}
else if (
    fleetDate &&
    leaseDate
) {

    internalNote =
        `Ticket closed: Fleet requested ${fleetDate} and collection was confirmed for the same date.`;

}
else if (
    result.summary
) {

    internalNote =
        `Ticket closed: ${result.summary}`;
}

const customFields = [

    {
        id: 6288766218399,
        value: categoryValue
    }

];

/*
 * Get existing registration field
 */
const ticketData =
    await client.request({

        url:
            `/api/v2/tickets/${ticketId}.json`,

        type: "GET"

    });

const existingReg =
    ticketData.ticket.custom_fields.find(
        f =>
            Number(f.id) ===
            5980606556063
    )?.value;

/*
 * Only populate registration
 * if field is blank
 */
if (
    !existingReg &&
    result.registration &&
    result.registration !== "-"
){

    customFields.push({

        id: 5980606556063,

        value:
            result.registration
                .replace(/\s+/g, " ")
                .trim()

    });

}

if (leaseDate) {

    customFields.push({

        id: 6288217950111,

        value: leaseDate

    });

}

        await client.request({

            url:
                `/api/v2/tickets/${ticketId}.json`,

            type: "PUT",

            contentType:
                "application/json",

            data: JSON.stringify({

                ticket: {

                    status: "solved",

                    comment: {

                        body: internalNote,

                        public: false
                    },

                    additional_tags: [
                        "collection_app_closed"
                    ],

                    custom_fields:
                        customFields
                }

            })

        });

analysed.closed = true;

confirmedTickets =
    confirmedTickets.filter(
        id =>
            String(id) !==
            String(ticketId)
    );

const confirmedCount =
    document.getElementById(
        "confirmedCount"
    );

if (confirmedCount) {

    confirmedCount.innerText =
        Math.max(
            0,
            parseInt(
                confirmedCount.innerText,
                10
            ) - 1
        );
}

const card =
    document
        .querySelector(
            `.ticketCheckbox[value="${ticketId}"]`
        )
        ?.closest(
            ".ticketCard"
        );

if (card) {
    card.remove();
}

updateResultsCount(
    `${document.querySelectorAll(".ticketCard").length} tickets remaining`
);

console.log(
    `Ticket ${ticketId} closed successfully`
);

    }
    catch (err) {

        console.error(
            "Unable to close ticket",
            ticketId,
            err
        );
    }
}

function exportCSV() {

    const rows = [];

    rows.push([
        "Ticket",
        "Registration",
        "Status",
        "Confidence"
    ]);

    analysedTickets.forEach(
        item => {

            rows.push([
                item.ticket.id,
                item.result.registration || "",
                item.result.status || "",
                item.result.confidence || ""
            ]);
        }
    );

    const csv =
        rows
            .map(
                row => row.join(",")
            )
            .join("\n");

    const blob =
        new Blob(
            [csv],
            {
                type: "text/csv"
            }
        );

    const link =
        document.createElement("a");

    link.href =
        URL.createObjectURL(blob);

    link.download =
        "ticket-analysis.csv";

    link.click();
}
