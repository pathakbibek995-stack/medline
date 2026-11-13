# Medicine Sales Manager

Plain HTML, CSS and JavaScript frontend on Vercel, with a Vercel API proxy to a Cloudflare Worker backed by D1. Google sign-in identifies the owner and each staff member. The Worker verifies Google-signed identity tokens, exchanges them for persistent device sessions, and enforces database-backed approval and record-level permissions. Production starts empty; tests use an isolated local database.

## Access

Keep `OWNER_EMAIL` as a deployment secret. The matching verified Google account is the permanent owner (Pathak Bibek). Only that account can open **Manage Access**, approve an email as **Admin** or **Worker**, change roles, or revoke access. No account can assign itself a role, and the owner cannot be demoted or revoked.

New Google sign-ins create a **Pending** request and cannot read or change shop records until the owner approves them. The owner can also approve an email before its first sign-in. Approval, role changes, and revocation are stored in D1 and audited. Roles are read on every API request, so demotion and revocation take effect immediately. Revoking access also deletes all saved sessions for that email; approving it later does not restore those old sessions.

Only the owner can view dashboard reports. Only the permanent owner, Pathak Bibek, can edit or delete stock, change an existing medicine’s MRP, or restore deleted stock. Inventory admins can add new medicines and receive additional stock, view purchase history, record pre-existing patient dues, and view/collect payments only for bills they created. Workers can create bills, view stock availability, and view/collect payments only for bills they created. Patient-name suggestions are scoped to bills created by the signed-in staff member; the owner can search all patient names. The owner and inventory admins can record pre-existing balances with an optional disease note. These opening balances appear in patient suggestions and outstanding dues, can be collected through the normal payment workflow, and are excluded from sales reports. The separate **Outstanding Dues** screen groups each user's unpaid bills by patient name; only the owner sees dues across all staff. Staff cannot access owner reports, another person's bills, inventory writes, purchase costs, or account approvals.

## Saved sign-in

After one Google sign-in, POST `/api/session` exchanges the verified Google identity for a random device session. The browser receives a host-only `__Host-medicine-session` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` and a 30-day `Max-Age`. Reopening the app restores the session automatically. Active use renews its 30-day expiry at most once a day. After 30 days without renewal, or after clearing browser cookies, the user signs in again. Browser JavaScript never saves the Google credential or session token to local storage. D1 stores only a SHA-256 digest of the session token, plus its identity and expiry.

POST `/api/logout` deletes the device session and expires its cookie; it does not sign out other devices. Logout failures leave the app signed in so the user can retry. Both login and logout require same-origin JSON requests. The Vercel proxy forwards only the app session cookie and returns the Worker's `Set-Cookie` headers. Normal record permissions and owner approval still apply to every cookie-authenticated request. Changing accounts clears the previous workspace. No patient records are stored offline.

Apply `0004_saved_sessions.sql` before deploying the session-capable Worker. Existing tabs using Google bearer credentials remain compatible; reload and sign in once to establish a saved session on that device.

## Run and verify

Use Node 20 or newer. `npm ci`, `npm run build`, `npm test`.

`npm run dev` runs a disposable local D1 preview at http://localhost:8787 and **simulates an owner only in the local preview server**. Set `PORT` to use another local port, for example `PORT=8788 npm run dev`. The `/preview-mobile` route frames it at a 390 px phone width. Neither simulated identity nor preview routes are in the production Worker. Stop the preview to discard its records.

`npm run build` embeds `worker/app.html` into `dist/server/index.js` for the Cloudflare Worker. `npm run build:vercel` copies the UI to `public/index.html` and injects the public Google OAuth client ID from `GOOGLE_CLIENT_ID`; Vercel runs the API proxy in `api/proxy.js`. Edit source, not generated output.

Patient / guardian name and contact number are optional for new sales bills. Contact numbers retain international prefixes and leading zeroes, are displayed in bills and outstanding dues, and are offered when choosing an existing patient. Contacts follow the same staff ownership restrictions as patient names. Pre-existing patient dues can also include an optional contact number. Patient / guardian name is optional for new sales bills. Omitted, empty or whitespace-only names are saved as an empty string and displayed as **Unnamed patient** with the bill number. Unnamed bills remain separate in Outstanding Dues; collect each through its individual bill so unrelated patients’ balances are never combined. Empty names are excluded from patient suggestions. Pre-existing balances still require a patient name.

## Mobile and PWA

The layout supports small phones, tablets and desktop screens. On phones, swipe the bottom navigation to reach every permitted screen and scroll tables horizontally for additional columns. Form inputs keep the normal 16 px mobile text size, and installed apps respect display safe areas.

The build includes a web app manifest, 192/512 px app icons, an Apple touch icon and an online-only service worker. Supported browsers show **Install app** when installation is available. On iPhone/iPad, the button explains Safari’s **Share → Add to Home Screen** flow. Installation requires HTTPS (or localhost for development).

There is **no offline mode**. Losing connectivity shows **No connection** and blocks the app until reconnection. Launching without a connection shows the same message. No app pages, patient records or API responses are cached by the service worker; writes are never queued or retried automatically. A draft remains only in the current tab’s memory. After an interrupted save, retry the identical submission to retain the existing idempotency key.

Both build targets include the same PWA assets. Run `npm run build && npm run validate && npm test` for Worker verification, and `npm run build:vercel` with the real `GOOGLE_CLIENT_ID` for the production frontend. Deploy the Vercel frontend to make these mobile and PWA changes live; apply pending D1 migrations, including `0003_bill_discounts.sql`, `0004_saved_sessions.sql` and `0005_patient_contact_stock_management.sql`, before deploying the updated Worker.

## Vercel + Cloudflare deployment

1. Create a Google OAuth **Web application** client and authorize the exact Vercel production origin as a JavaScript origin. Set its public `GOOGLE_CLIENT_ID` in Vercel's production build environment and the same Worker variable. The app uses the Google Identity Services popup; a client secret is not needed in the browser or this application.
2. Preserve the existing D1 database and business records. Apply migrations with `npx wrangler d1 migrations apply medicine-sales-manager-production --remote`; this applies pending migrations such as the staff-access and opening-balance schema. Use `drizzle/0000_shop.sql` only when creating a new empty database. Never reset the live database or load test fixtures into it.
3. Keep `OWNER_EMAIL` as a Worker deployment secret, set `APP_ORIGIN` to the exact production origin, and keep `WORKER_PROXY_ONLY=true`. Access is managed through D1 and the owner screen, not the `STAFF_EMAILS` environment variable.
4. Configure Vercel with `GOOGLE_CLIENT_ID`, `CLOUDFLARE_WORKER_URL`, and `APP_ORIGIN`. The proxy forwards Google identity tokens or the app session cookie; the Worker verifies their signature, issuer, audience, expiration, and verified email before applying roles.
5. The existing production project retains **Vercel Authentication / All Deployments**. Do not disable it as part of routine deployment. Before staff rollout, agree on how workers will reach the Google sign-in page: retain the Vercel gate and approve their Vercel access, or explicitly approve replacing that gate with the tested Google sign-in and owner approval layer. No rollout should expose records anonymously.
6. Validate the owner approval screen, pending-account denial, both approved roles, role changes, immediate revocation, cross-worker bill denial, and anonymous API denial before normal use.

Google sign-in must have a real Web Client ID before production deployment. Local tests use generated signing keys and an isolated D1 database. A well-formed test Client ID used for a local build is not valid for real Google sign-in.

## API

GET `/api/access` (owner only), `/api/me`, `/api/medicines?q=`, `/api/patients?q=` (patient-name suggestions, scoped by staff ownership except for the owner), `/api/purchases?medicine_id=`, `/api/bills?q=&due=true&offset=`, `/api/dues?q=`, `/api/bills/:id`, `/api/dashboard?month=YYYY-MM`.

POST `/api/session` (verified Google Bearer token, returns a persistent cookie), `/api/logout` (expires the device cookie), `/api/access` (owner only; `{email,role,status}`), `/api/receipts`, `/api/bills`, `/api/opening-dues` (owner or inventory admin; `{patient_name,disease,amount_paisa}`), `/api/bills/:id/payments`, `/api/patient-payments` (`{patient_name,amount_paisa}`; applied oldest unpaid bill first); PATCH `/api/medicines/:id` for name, MRP and available quantity; DELETE `/api/medicines/:id` removes active stock while preserving history. Both are restricted to the permanent owner, Pathak Bibek. Inventory admins can add stock but cannot edit or delete it. Money fields are integer paisa, quantities are positive whole numbers. Writes require same-origin JSON and an `Idempotency-Key`. Use a new key for each new intent and retain it when retrying an identical request. Reuse with a different payload or actor returns 409. Patient-level collections atomically create bill-specific payment-history records and reject overpayments, including concurrent ones. Bills list returns up to 51 rows: display 50 and use the extra record as the next-page indicator.

Stock entry shows matching medicine names as you type. Existing names require explicit confirmation (`confirm_existing: true`) before adding another delivery; confirmation replenishes the same medicine. Inventory admins must retain its existing MRP; only the owner may change it. Receipt writes by inventory admins cannot overwrite MRP or restore deleted stock, including when they race with an owner edit or delete. Concurrent first receipts cannot silently add duplicate stock. New bills send the reviewed MRP so a price change produces a conflict instead of silently charging a different price. The database stores a snapshot of each medicine name and MRP on bill items. Medicine selection includes a searchable list on phones and desktops. New bills accept an optional contact number and `due_paisa`. Payment and chosen due have no upper limit based on the medicine MRP. The actual bill total is payment plus chosen due. A total below MRP is recorded as `discount_paisa`; a total above MRP is recorded as `additional_charge_paisa`. The original item MRP remains on the bill. Omitted due defaults to the nonnegative unpaid MRP balance for older clients. The UI provides **Amount to keep due**, **Keep no due**, and **Keep full balance due**, without the old MRP-cap warning. For example, NPR 100 MRP, NPR 500 paid and NPR 200 due creates a NPR 700 bill, NPR 500 cash collection and NPR 200 outstanding due. Nonnegative whole-paisa amounts, safe arithmetic and database storage constraints still apply.

Owner-only stock edits update name, MRP and current quantity without changing posted bills or purchase history. Edits and deletes use reviewed name, MRP and quantity values, validated atomically through `stock_changes`; a stale edit or delete returns 409 instead of overwriting concurrent stock changes. Deletion removes a medicine from the active stock list and prevents new sales against it, while retaining historical references and an audit entry. An explicitly confirmed later stock receipt by the owner can restore the deleted medicine with the newly received quantity. Apply `0005_patient_contact_stock_management.sql` before deploying the updated API.

D1 `batch()` commits operations, bills, items, stock deductions, and the initial payment as one transaction. Schema triggers validate and deduct current stock, calculate bill totals, and guard payment balances within that transaction, including concurrent requests. Failed batches roll back all effects. A unique operations ledger prevents duplicate bills, receipts and payments. Server-side range checks and database constraints bound amounts and quantities.

## Reports and scope

Calendar boundaries use Asia/Kathmandu (UTC +05:45). Sales sum recorded bill totals (including discounts or amounts above MRP) by bill creation date; owner-entered opening balances are excluded. Collections sum payments by payment date, including payments against opening balances and older bills. Dues sum unpaid balances across all bills. Stock costs follow the receipt's Nepal calendar purchase date. These are independent totals, not profit estimates.

One counting unit per medicine; no expiry/batches, unit conversions, supplier accounts, refunds or posted-bill edits. Bill and payment dates are recorded by the server; future purchase dates are rejected.

## Verification

`npm test` exercises actual local D1 transactions using Miniflare: Google token signatures/audience/expiry, pending/approved/revoked access, owner, inventory-admin and worker roles, bill/payment isolation, stock receipt and history, NPR 30 sale / NPR 20 payment / NPR 10 due, MRP history, insufficient stock, concurrent sales, duplicate submissions, Nepal month boundaries, and rollback. Production records stay empty until deployed.
