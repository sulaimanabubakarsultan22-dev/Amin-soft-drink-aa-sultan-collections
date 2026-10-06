# AMIN SOFT DRINK & A.A SULTAN COLLECTIONS — Paystack Setup

## Muhimmi: kada a saka Secret Key a frontend ko GitHub
Paystack `sk_test_...` da `sk_live_...` secret keys na server ne kawai. Ajiye su a environment variable mai suna `PAYSTACK_SECRET_KEY`.

## Mataki na gwaji (Test Mode)
1. Shiga Paystack Dashboard.
2. Je zuwa **Settings → API Keys & Webhooks**.
3. Ka tabbatar kana cikin **Test Mode**.
4. Za a yi amfani da **Test Secret Key** a server, ba a cikin browser/app ba.
5. `PAYSTACK_SECRET_KEY=sk_test_...`
6. `PUBLIC_URL` ya zama cikakken HTTPS address na website, misali `https://example.com` (ba slash a ƙarshe).

## Callback
App ɗin yana aika customer zuwa:
`PUBLIC_URL/?no=ORDER_NUMBER`

## Webhook
App ɗin yana da endpoint:
`PUBLIC_URL/api/webhook/paystack`

A Paystack **Test Mode → API Keys & Webhooks**, saka wannan URL a **Test Webhook URL** bayan website ɗin ya zama public ta HTTPS.

## Live Mode
Kada a saka live secret key kafin an gama testing. Bayan an tabbatar da payment flow:
- canza `PAYSTACK_SECRET_KEY` zuwa `sk_live_...` a server secrets;
- saka live webhook URL a Live Mode;
- yi ƙaramin real-money test kafin a sanar da customers.

## Tsaro
- Kada ka turo Secret Key ta WhatsApp ko ChatGPT.
- Kada ka saka Secret Key a JavaScript na `public/`.
- Kada ka commit `.env` zuwa GitHub.
