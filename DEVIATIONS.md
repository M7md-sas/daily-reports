# Deviations from DAILY_REPORTS_SPEC.md

Deliberate differences from the specification, and why. Read this before “fixing” any of them.

## Security (Section 6)

1. **Consultants write through database functions, not direct table inserts.**
   The spec's table says anon may “insert/upsert” into `consultants`, `reports` and `report_photos`. With a public key that allows anyone to overwrite a consultant's name by mobile and to insert arbitrary rows. Instead anon has **no table privileges at all** (except reading active projects) and calls `register_consultant`, `update_my_details`, `submit_report` and `attach_photos`, which validate everything. The effect the spec asks for — consultants can submit but never read — is unchanged.
2. **Registering an existing mobile never overwrites the stored name.** Name changes go through “Edit my details”, which requires the device token issued at registration.
3. **Photo uploads are restricted to the folder of a fresh report.** Anon can upload only `YYYY/MM/DD/<report_id>/<n>.jpg` for a report created in the last 2 days, with `n` up to the number of photos that report declared; JPEG only, 1 MB max. No read, list, overwrite or delete (as the spec says).
4. **Link protection is built in but off** (Open question 3 was postponed by the owner). `app_settings.access_mode` = `none` (default) | `team_code` | `team_code_device`, switchable in Admin. Supporting additions: table `consultant_devices`, column `consultants.allow_new_device`, “Allow new phone” button on Consultants (only visible in `team_code_device` mode).
5. **Server-side limits**: 20 photos per report, 200,000 characters of report HTML, 20 reports per consultant per day (changeable in Admin).
6. **`archive_log` insert is allowed for the manager**, not only the admin. The spec's security table says “admin: write”, but Section 12 has the manager run the archive and write the log entry. The insert is restricted to the user's own id.
7. **Heartbeat is updated through `heartbeat_ping()`** rather than a raw anon `UPDATE`, so the time always comes from the server (`now()`) and nothing else in the row can be changed.

## Data model (Section 5)

8. Extra columns on `reports`: `photos_expected` and `photo_count`. They let the dashboard show “2/3” when a consultant's photos are still uploading, and they bound the storage policy.
9. Extra tables: `consultant_devices` (hashed device tokens), `app_settings` (single row).
10. `reports.consultant_id` and `project_id` use `on delete restrict`; projects are deactivated, not deleted.

## Consultant app (Section 7)

11. **Project type buttons** show the code in bold and the description beside it (`UGC` · Underground Cables) instead of the literal `UGC — Underground Cables` string, which read as a duplicate on small screens.
12. **Direction**: paragraphs and headings get automatic direction each (Arabic lines right-to-left, English left-to-right). A bulleted/numbered **list** takes one direction from its first item, so every item stays next to its number.
13. **Draft photos** are kept in IndexedDB (they do not fit in localStorage). Once the report row is saved and only photo uploads failed, the text is locked and **Retry** uploads just the remaining photos; the recorded time stays the original submission time.
14. A small “Could not load — Retry” message appears if a library fails to download (weak signal), instead of an endless spinner.

## Dashboard (Section 8)

15. Report detail labels follow the UI language (English/Arabic). The **PDF is always English**, matching the approved sample.
16. The Reports list is newest first (as specified). **PDF and Excel exports are chronological (oldest first)**, which reads naturally for a date range and an archive.
17. The Today screen also shows the number of reports and of active consultants next to the submitted / not-submitted counters.

## Exports (Section 10)

18. **PDF engine**: html2canvas + jsPDF as specified, but with our own paginator instead of html2pdf.js's page-break options. This is what guarantees “a card never splits”, the “<Name> — continued” photo continuation, and exports of a full month without freezing the browser (each card is rendered separately).
    - Consequence: PDF pages are images, so text in the PDF cannot be selected or searched. The Excel file carries the searchable text.
    - html2canvas draws small text with rounded (hinted) letter widths, which made words run together. The exporter draws text at 4× size under a ¼ transform to avoid that.
19. The running header's right side is empty (the spec allows “nothing or the filter summary”); the filter summary is on page 1.
20. Excel “Photo Files” lists the paths inside the archive ZIP (`Photos/<Consultant>/<date>/<file>.jpg`). If two reports by the same consultant, project and minute would produce the same file name, the later one gets a `_2` suffix.

## Storage and archive (Section 12)

21. **Two meters instead of one**: the free plan has separate quotas — 1 GB file storage and 500 MB database — so they are shown separately (both configurable in `js/config.js`). The spec's single “storage + DB estimate vs 1 GB” would be misleading.
22. **Archiving is blocked on phones** (touch screen narrower than 1000 px) with an explanation: a month of photos does not fit in a phone browser's memory.
23. **Large ranges are split** into several ZIPs of up to ~400 MB each (by whole days); each part contains its own PDF and Excel.
24. The archive range must end **before today**, so reports still being submitted are never archived.
25. If deletion is interrupted, the screen offers **Continue deletion**; the log entry is written only after deletion finishes.

## Keep-alive (Section 11)

26. The workflow commits the timestamp file **only when the last commit is 45+ days old**, not every day, so the history is not flooded and GitHub Pages is not rebuilt daily.

## Other

27. Fonts are **self-hosted** in `fonts/` instead of loaded from Google Fonts (no third-party requests; also needed for html2canvas).
28. The spec's Section 4 refers to “Section 9.6” for the Admin section; the correct section is 8.8.
