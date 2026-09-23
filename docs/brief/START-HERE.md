# SimplexD — handoff to Claude Code

Give the builder the entire contents of this package. The main specification contains the requirements; the JSON contains importable research; the research notes explain coverage and limitations.

## Files

- `SIMPLEXD-CLAUDE-CODE-BUILD-BRIEF.md` — complete product, UX, backend, integration and acceptance instructions.
- `nigeria-50-markets.seed.json` — 50 geographic market records, sources, contextual observations, material-supply leads and explicit unknowns.
- `DATA-RESEARCH-NOTES.md` — all 50 locations, research methodology, source links, import rules and evidence-completion plan.
- `GEOGRAPHY-LICENSE.txt` — attribution and license notice for the geography subset.

## Paste this instruction into Claude Code

Build the new SimplexD public website, backend, admin portal, customer portal and partner workspaces using the attached SIMPLEXD-CLAUDE-CODE-BUILD-BRIEF.md as the implementation contract. Read DATA-RESEARCH-NOTES.md and nigeria-50-markets.seed.json before implementing the homepage Nigeria map. Preserve evidence provenance and unknown values; do not invent local prices or present assumptions as researched facts.

Inspect the repository first. Create an implementation plan and a requirement-by-requirement IMPLEMENTATION-STATUS.md, then implement the release waves in order. Deliver working end-to-end workflows with persistence, authorization, validation and tests, not mock screens. Continue until the full agreed scope is implemented or a specific external dependency blocks a particular feature. Continue independent work around blocked integrations.

Include the eight current services and the proposed expansion workflows, interactive accessible UI, light/dark/system themes across all surfaces, admin-editable market data and scoring, secure Paystack payments, Termii SMS, configurable SMTP, and Google Calendar/Meet booking integration. Follow the security, accounting, data-quality and acceptance requirements exactly. Research current official integration documentation when implementing provider adapters.

Use labeled development adapters until real sandbox credentials are supplied; never claim a provider is connected merely because settings saved. Keep actual service availability separate from map coverage. The supplied 50-market seed is geographically populated but financially incomplete, so financial ranking must remain gated until sufficient validated local evidence exists.

Finish with source code, migrations, idempotent imports, setup/deployment instructions, tests and results, provider setup guide, operational documentation and an honest list of outstanding credentials or data collection. Do not switch the live simplexd.co website automatically. Start implementation now.

## Owner setup needed before live launch

Provide approved brand assets and content, access to the existing site's content export, hosting/domain accounts, merchant credentials, SMS sender approval, SMTP/DNS setup, Google organizer consent, map provider access and the operational team responsible for services and local data review. These are external launch inputs; the builder can implement and test most of the system before they are complete.
