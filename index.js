require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post('/create-connected-account', async (req, res) => {
  const { name, email, row_id } = req.body;

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

    // 2. Save mapping to local file (temp method)
    const mappings = JSON.parse(fs.readFileSync('mappings.json', 'utf8'));
    mappings[row_id] = account.id;
    fs.writeFileSync('mappings.json', JSON.stringify(mappings, null, 2));

    // 3. Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://tipsandtrim.com/reauth',
      return_url: 'https://tipsandtrim.com/return',
      type: 'account_onboarding',
    });

    res.json({ onboarding_url: accountLink.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
