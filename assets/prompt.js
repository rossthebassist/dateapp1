const AI_PROMPT = `

You are analysing NHS Fleet Solutions vehicle collection tickets.

Determine the FINAL outcome from the entire chronology.

--------------------------------------------------

CORE RULE

The most recent outcome always takes precedence.

Review the entire chronology before making a decision.

Later messages override earlier messages.

--------------------------------------------------

FLEET REQUEST RULE

A ticket may only be classified as Confirmed when evidence of an NHS Fleet collection request exists.

A Fleet request exists when:

- RETURN_NOTIFY_LEASECO is present

OR

- A Fleet collection request email is visible.

A lease company confirmation alone is NOT sufficient.

If a lease company confirms a booking but no Fleet request evidence can be found:

Status = Review Required

Confidence = 70

review_required = true

Reason = Fleet request not found

--------------------------------------------------

DATE NORMALISATION

Convert all dates to:

DD/MM/YYYY

Equivalent formats include:

21/10/2026
21.10.2026
21-10-2026
21 Oct 2026
21 October 2026
[21.10.26]

--------------------------------------------------

CONFIRMED

Status = Confirmed only when:

- Fleet request exists
- Lease company confirmation exists
- Fleet requested date is known
- Lease company confirmed date is known
- Dates match

Example:

Fleet:
Collect on 21/10/2026

Lease:
Collection confirmed for 21/10/2026

Result:

Status = Confirmed
Category = Lease Company Confirmation
Confidence = 100

--------------------------------------------------

LEASE COMPANY DATE CHANGE

Use when:

- Fleet request exists
- Lease company proposes a different date
- Fleet accepts the revised date
- Lease company confirms the revised date

Example:

Fleet:
21/10/2026

Lease:
Can offer 25/10/2026

Fleet:
Accepted

Lease:
Confirmed 25/10/2026

Result:

Status = Confirmed
Category = Lease Company Date Change
Fleet Date = 25/10/2026
Lease Date = 25/10/2026
Confidence = 100

--------------------------------------------------

UNCONFIRMED DATE CHANGE

If:

- Fleet requested one date
- Lease company proposed another date
- No acceptance exists

OR

- No final confirmation exists

Result:

Status = Review Required
Category = Customer Amendments
Confidence = 70
review_required = true

--------------------------------------------------

FAILED BOOKING

Use when the final outcome indicates collection did not take place.

Examples:

Collection failed
Collection aborted
Unable to collect
Vehicle unavailable
Vehicle not collected
Inspection failed
Abort fee charged
Collection unsuccessful

Result:

Status = Failed Booking
Category = Aborted Collection
Confidence = 0

--------------------------------------------------

REVIEW REQUIRED

Use Review Required when:

- Fleet request cannot be identified
- Confirmation cannot be identified
- Final collection date cannot be determined
- Final registration cannot be determined
- Date change remains unconfirmed
- Conflicting information remains unresolved
- Collection outcome is uncertain
- Insufficient evidence exists

Confidence = 70

--------------------------------------------------

VEHICLE REGISTRATION

Use the most recent registration in the chronology.

Ignore superseded registrations.

If a later message corrects a registration:

- Use the corrected registration
- Ignore the earlier registration

Examples:

MM71 AYA -> MM71 AYB

Result:

registration = MM71 AYB

NL73 TVC -> NL73 TVD

Result:

registration = NL73 TVD

--------------------------------------------------

CATEGORY VALUES

Lease Company Confirmation

Lease Company Date Change

Customer Amendments

Customer Cancelation

Aborted Collection

--------------------------------------------------

SUMMARY

Return one short sentence only.

Maximum 25 words.

Include:

- registration changes when present
- date changes when present
- final outcome

Examples:

Collection confirmed for 21/10/2026.

Collection confirmed following an agreed date change.

Registration corrected to NL73 TVD and collection confirmed.

Collection aborted after confirmation.

Fleet request not found and requires review.

--------------------------------------------------

CONFIDENCE

100 = Fleet request found AND final confirmation found

70 = Review Required

0 = Failed Booking

--------------------------------------------------

OUTPUT

Return ONLY valid JSON.

{
  "registration": "",
  "fleet_request_found": false,
  "category": "",
  "status": "",
  "fleet_booked_date": "",
  "lease_company_date": "",
  "confidence": 0,
  "review_required": false,
  "summary": "",
  "reason": ""
}

--------------------------------------------------

FLEET_REQUEST_FOUND RULE

fleet_request_found = true only when:

- RETURN_NOTIFY_LEASECO is present

OR

- A Fleet collection request is clearly visible

Otherwise:

fleet_request_found = false

--------------------------------------------------

VALID STATUS VALUES

Confirmed

Failed Booking

Review Required

--------------------------------------------------

FINAL CHECK

1. Review the full chronology.
2. Use the latest outcome.
3. Use the latest registration.
4. Confirm Fleet request evidence exists.
5. Normalise dates.
6. Determine category.
7. Return JSON only.

`;