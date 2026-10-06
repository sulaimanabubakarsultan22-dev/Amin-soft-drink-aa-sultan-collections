# AMIN SOFT DRINK & A.A SULTAN COLLECTIONS — Google Play

Brand name: AMIN SOFT DRINK & A.A SULTAN COLLECTIONS

The storefront/backend is a web application. To publish it as an Android app, the backend must first be deployed to a public HTTPS URL. The Android app can then be packaged as a signed Android App Bundle (AAB) that loads the live storefront.

Google Play requirements checked on 2026-10-05:
- New apps/updates submitted from 2026-08-31 must target Android 16 / API 36 or higher.
- New personal Play developer accounts created after 2023-11-13 must complete a closed test with at least 12 opted-in testers continuously for 14 days before production access.
- A Play Console app listing needs store listing information, contact details, screenshots, and appropriate policy/content declarations.

Before production release:
1. Deploy this Node.js backend behind HTTPS.
2. Set production database/payment environment variables.
3. Configure Paystack live keys and webhook URL.
4. Add the store logo/icon and screenshots.
5. Build a signed Android App Bundle targeting API 36+.
6. Upload to Play Console internal/closed testing.
7. Complete the required closed test if the developer account is a new personal account.
8. Apply for production access and roll out the production release.
