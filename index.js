require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');

// Stripe setup
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_1, {
  apiVersion: '2025-09-30.preview',
});

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors());

// Mappings file path on Render disk
const mappingsPath = '/data/mappings.json';

// Manual raw body collector (avoids body-parser JSON errors)
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook' || req.originalUrl === '/create-connected-account') {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

// Ensure mappings file exists
try {
  if (!fs.existsSync(mappingsPath)) {
    fs.writeFileSync(mappingsPath, '{}');
    console.log('✅ Created mappings.json on first run.');
  }
} catch (err) {
  console.error('❌ Error ensuring mappings file exists:', err);
}

// Create connected account and onboarding link
app.post('/create-connected-account', async (req, res) => {
  let data;

  // Try to parse manually
  try {
    // If Glide sends weird "body" structure
    let parsed = req.rawBody ? JSON.parse(req.rawBody) : req.body;
    data = parsed.body || parsed;

    // If "body" is a malformed string, fix it
    if (typeof data === 'string') {
      if (!data.trim().startsWith('{')) data = `{${data}}`;
      data = JSON.parse(data);
    }
  } catch (err) {
    console.error('❌ Failed to parse incoming body:', req.rawBody);
    return res.status(400).json({ error: 'Invalid JSON body format' });
  }

  const { employee_row_id, name, email, employer_email, type, business_type } = data || {};

  if (!email || !employee_row_id) {
    return res.status(400).json({ error: 'Missing required fields: email or employee_row_id' });
  }

  console.log('✅ Parsed incoming data:', data);

  try {
    // 1. Create Stripe connected account
    const account = await stripe.accounts.create({
      type: type || 'express',
      country: 'US',
      email,
      business_type: business_type || 'individual',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        url: 'https://tipsandtrim.com',
      },
    });

    // 2. Store mapping
    let mappings = {};
    try {
      mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    } catch {
      console.warn('⚠️ Could not read mappings.json, starting fresh');
    }

    mappings[employee_row_id] = account.id;
    fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2));

    // 3. Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://tipsandtrim.com/reauth',
      return_url: 'https://tipsandtrim.com/return',
      type: 'account_onboarding',
    });

    console.log(`🚀 Created onboarding link for ${email}`);
    res.json({ onboarding_url: accountLink.url });
  } catch (error) {
    console.error('❌ Stripe account creation error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Webhook for onboarding completion
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;

    if (account.charges_enabled && account.payouts_enabled && account.details_submitted) {
      console.log(`✅ Onboarding completed for account ${account.id}`);

      let mappings = {};
      try {
        mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
      } catch (err) {
        console.error('❌ Failed to read mappings.json');
        return res.sendStatus(500);
      }

      const employee_row_id = Object.keys(mappings).find(key => mappings[key] === account.id);
      if (!employee_row_id) {
        console.warn(`⚠️ No mapping found for account ID: ${account.id}`);
        return res.sendStatus(200);
      }

      try {
        const loginLink = await stripe.accounts.createLoginLink(account.id);

        // Send update back to Glide
        await fetch('https://go.glideapps.com/api/container/plugin/webhook-trigger/BDkkdHH3iqEDpVk1nljo/450f83fd-40a3-4b95-b0c5-9ab87cad56cb-webhook-url.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employee_row_id,
            stripe_dashboard_url: loginLink.url,
            is_onboarded: true,
          }),
        });

        console.log(`🚀 Sent login link to Glide for employee_row_id: ${employee_row_id}`);
      } catch (err) {
        console.error('❌ Failed to send login link to Glide:', err);
      }
    }
  }

  res.sendStatus(200);
});

// Health check route
app.get('/', (req, res) => {
  res.send('Tips & Trim API is live!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
