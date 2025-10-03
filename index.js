require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// Stripe setup
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_1, {
  apiVersion: '2025-09-30.preview',
});

const app = express();
const PORT = process.env.PORT || 3000;

// Mappings file will be stored in the Render Disk
const mappingsPath = '/data/mappings.json';

app.use(bodyParser.json());

// Ensure mappings file exists
try {
  if (!fs.existsSync(mappingsPath)) {
    fs.writeFileSync(mappingsPath, '{}');
    console.log('✅ Created mappings.json on first run.');
  }
} catch (err) {
  console.error('❌ Error ensuring mappings file exists:', err);
}

app.post('/create-connected-account', async (req, res) => {
  const { name, email, row_id } = req.body;

  if (!email || !row_id) {
    return res.status(400).json({ error: 'Missing required fields: email or row_id' });
  }

  try {
    // 1. Create a connected Stripe account
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email,
      business_type: 'individual',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        url: 'https://tipsandtrim.com',
      },
    });

    // 2. Read, update, and save the mapping to /data/mappings.json
    let mappings = {};
    try {
      mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    } catch (err) {
      console.warn('⚠️ Could not read mappings.json, using empty object');
    }

    mappings[row_id] = account.id;
    fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2));

    // 3. Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://tipsandtrim.com/reauth',
      return_url: 'https://tipsandtrim.com/return',
      type: 'account_onboarding',
    });

    res.json({ onboarding_url: accountLink.url });
  } catch (error) {
    console.error('❌ Stripe account creation error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Simple status route
app.get("/", (req, res) => {
  res.send("Tips & Trim API is live!");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
