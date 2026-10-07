const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();
const SK = defineSecret('STRIPE_SECRET_KEY');
const WH = defineSecret('STRIPE_WEBHOOK_SECRET');

// ⚠️ À MODIFIER : adresse exacte de ton site GitHub Pages (avec le / final)
const SITE_URL = 'https://TON-PSEUDO.github.io/TON-REPO/';
const ORIGIN = new URL(SITE_URL).origin;

exports.createCheckout = onRequest({secrets: [SK], cors: [ORIGIN], region: 'europe-west1'}, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({error: 'method'});
  try {
    const {orderId} = req.body || {};
    const ref = db.collection('orders').doc(String(orderId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({error: 'order'});
    const o = snap.data();
    if (o.status !== 'En attente de paiement') return res.status(400).json({error: 'status'});

    // Les prix viennent de Firestore, jamais du navigateur
    const shop = (await db.doc('settings/shop').get()).data() || {};
    const shipping = Number(shop.shipping ?? 3.9), freeFrom = Number(shop.freeFrom ?? 20);
    let count = 0;
    const line_items = [];
    for (const it of o.items) {
      const p = await db.collection('products').doc(String(it.id)).get();
      if (!p.exists || p.data().stock === 0) return res.status(400).json({error: 'product'});
      const qty = Math.max(1, Math.min(1000, parseInt(it.qty) || 1));
      count += qty;
      line_items.push({quantity: qty, price_data: {currency: 'eur', unit_amount: Math.round(Number(p.data().price) * 100), product_data: {name: p.data().name}}});
    }
    if (!line_items.length) return res.status(400).json({error: 'empty'});
    if (count < freeFrom && shipping > 0) {
      line_items.push({quantity: 1, price_data: {currency: 'eur', unit_amount: Math.round(shipping * 100), product_data: {name: 'Livraison'}}});
    }

    const stripe = new Stripe(SK.value());
    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      mode: 'payment',
      line_items,
      customer_email: o.email,
      client_reference_id: ref.id,
      metadata: {orderId: ref.id},
      return_url: `${SITE_URL}?session_id={CHECKOUT_SESSION_ID}`,
    });
    await ref.update({stripeSession: session.id});
    res.json({clientSecret: session.client_secret});
  } catch (e) {
    console.error(e);
    res.status(500).json({error: 'server'});
  }
});

// Webhook : marque la commande "Payée"
exports.stripeWebhook = onRequest({secrets: [SK, WH], region: 'europe-west1'}, async (req, res) => {
  let event;
  try {
    event = new Stripe(SK.value()).webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], WH.value());
  } catch (e) {
    return res.status(400).send('signature');
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    if (s.payment_status === 'paid' && s.metadata?.orderId) {
      await db.collection('orders').doc(s.metadata.orderId).update({status: 'Payée', paidAt: admin.firestore.FieldValue.serverTimestamp()});
    }
  }
  res.json({received: true});
});
