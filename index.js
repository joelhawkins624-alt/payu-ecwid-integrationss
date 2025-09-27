import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Load environment variables
const {
  PAYU_CLIENT_ID,
  PAYU_CLIENT_SECRET,
  PAYU_POS_ID,
  PAYU_SECOND_KEY,
  PAYU_API_URL,
  ECWID_STORE_ID,
  ECWID_API_TOKEN
} = process.env;

// ✅ Function to get OAuth token from PayU
async function getAccessToken() {
  const response = await fetch(`${PAYU_API_URL}/pl/standard/user/oauth/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: PAYU_CLIENT_ID,
      client_secret: PAYU_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    throw new Error(`PayU Auth Failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.access_token;
}

// ✅ Route for Ecwid → PayU order creation
app.post("/payu", async (req, res) => {
  try {
    const token = await getAccessToken();

    const { order } = req.body;
    if (!order) {
      return res.status(400).json({ error: "No order data received from Ecwid" });
    }

    // Convert total amount to grosz (minor currency unit)
    const totalAmount = Math.round(order.total * 100);

    // Build product list for PayU
    const products = order.items.map(item => ({
      name: item.name,
      unitPrice: Math.round(item.price * 100),
      quantity: item.quantity
    }));

    const orderPayload = {
      notifyUrl: `${req.protocol}://${req.get("host")}/payu/notify`,
      customerIp: req.ip || "127.0.0.1",
      merchantPosId: PAYU_POS_ID,
      description: `Order #${order.id}`,
      extOrderId: order.id.toString(), // Used later to update Ecwid order
      currencyCode: order.currency || "PLN",
      totalAmount: totalAmount.toString(),
      products
    };

    const payuResponse = await fetch(`${PAYU_API_URL}/api/v2_1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(orderPayload)
    });

    const result = await payuResponse.json();

    if (result.status?.statusCode === "SUCCESS") {
      console.log("✅ PayU Order Created:", result);
      return res.json({
        redirectUrl: result.redirectUri // Ecwid will redirect the customer to this URL
      });
    } else {
      console.error("❌ PayU order creation failed:", result);
      return res.status(400).json({ error: result });
    }
  } catch (error) {
    console.error("🔥 Error creating PayU order:", error);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

// ✅ Webhook route for PayU → Ecwid payment confirmation
app.post("/payu/notify", async (req, res) => {
  try {
    console.log("🔔 PayU notification received:", req.body);

    const payuOrder = req.body;
    const orderId = payuOrder?.order?.extOrderId;

    if (!orderId) {
      console.error("❌ No order ID found in PayU notification");
      return res.sendStatus(400);
    }

    const ecwidApiUrl = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/orders/${orderId}/payment_status`;
    const ecwidResponse = await fetch(ecwidApiUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ECWID_API_TOKEN}`
      },
      body: JSON.stringify({
        paymentStatus: "PAID"
      })
    });

    if (!ecwidResponse.ok) {
      const errorText = await ecwidResponse.text();
      console.error("❌ Failed to update Ecwid order:", errorText);
      return res.sendStatus(500);
    }

    console.log(`✅ Order ${orderId} marked as PAID in Ecwid`);
    res.sendStatus(200);
  } catch (error) {
    console.error("🔥 Error processing PayU notification:", error);
    res.sendStatus(500);
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PayU integration server running on port ${PORT}`);
});
